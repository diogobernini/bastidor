#!/usr/bin/env node
'use strict';
// tests/ui/run.js
//
// Orquestrador da suíte de UI (npm run test:ui). Não usa nenhuma
// dependência nova: só Node puro (child_process, fs, os, path) + o próprio
// Electron que já é devDependency do projeto.
//
// -------------------------------------------------------------- arquitetura
//
// run.js (este arquivo, processo Node comum)
//   para cada cenário:
//     1. cria uma pasta temporária de userData isolada (fs.mkdtempSync) e
//        grava nela um settings.json mínimo (evita que qualquer cenário
//        caia na biblioteca padrão real do usuário, ~/Bordados — ver
//        seedSettings).
//     2. roda `electron tests/ui/harness-main.js --scenario=<nome>
//        --user-data=<pasta> --out=<arquivo.json> [flags extra]` via
//        spawnSync, com ELECTRON_ENABLE_LOGGING=1 (pedido da issue #34).
//     3. lê o JSON de resultado e imprime um relatório legível.
//   no final, imprime o resumo e termina com exit code 0 (tudo passou) ou 1.
//
// harness-main.js (processo Electron separado, um por cenário) carrega o
// app REAL (require direto de src/main/main.js — mesmo preload, mesmo
// index.html, mesmos handlers de IPC de produção), captura TODA mensagem de
// console da janela e roda o cenário pedido, dirigindo a UI com eventos
// reais de pointer/teclado via executeJavaScript. Ver o cabeçalho daquele
// arquivo para os detalhes de captura de console e stubs de diálogo nativo.
//
// A asserção que importa mais: harness-main.js reprova QUALQUER cenário se
// o console da janela tiver "Uncaught", "Refused" ou "SyntaxError" — é o
// que pega colisões de identificador entre scripts clássicos (ex.: um
// `const api` batendo com o `window.api` do preload, ou um `const
// COMMAND_MASK` duplicado): o script inteiro aborta no meio, sem lançar
// nada que um teste de lógica pura enxergue, mas sempre aparece no console.
//
// ------------------------------------------------------- como adicionar um cenário
//
//   1. Em tests/ui/harness-main.js, acrescente uma função async ao objeto
//      SCENARIOS com o nome do cenário. Ela recebe um `ctx` com:
//        ctx.page(jsExpr)              -> roda jsExpr na página (await),
//                                          devolve o valor (Electron faz o
//                                          marshalling de JSON automático).
//        ctx.waitFor(jsBoolExpr, ms)   -> repete ctx.page(`Boolean(...)`)
//                                          até dar true ou o timeout passar.
//        ctx.assert(desc, cond, det?)  -> registra e, se cond for falso,
//                                          lança (para o cenário ali).
//        ctx.args                     -> todos os --flag=valor recebidos
//                                          pela linha de comando do harness.
//        ctx.bootReady                -> boolean: window.api.notifyRenderReady()
//                                          disparou dentro do timeout.
//        ctx.result                   -> objeto livre; o que for colocado
//                                          aqui aparece em extra no JSON de
//                                          saída (útil para o run.js
//                                          conferir algo fora do browser,
//                                          como os caminhos de um "salvar
//                                          como" — ver resize-keep-density).
//      O toolkit disponível na página (window.__ui, injetado por
//      PAGE_TOOLKIT) tem click/setValue/setChecked/keydown/pointerDrag/
//      designPointToClient e leitores (text/value/checked/count/hasClass/
//      isDisabled/isHidden/isOpen/displayNone) — todos por seletor CSS.
//   2. Neste arquivo, acrescente uma entrada em buildScenarioDefs() com o
//      nome (idêntico ao usado em SCENARIOS) e os argumentos extra de linha
//      de comando que o cenário precisa. main.js (o app real) já entende
//      --open=, --dialog=, --lang=, --fake-drive=, --library=,
//      --library-search= (eram flags de autoteste que já existiam antes
//      desta suíte, usadas em telas/capturas manuais). Para fluxos que
//      abrem um diálogo NATIVO (dialog:save/dialog:open, que travariam
//      esperando um clique humano), use --stub-save-paths=a,b,c (uma fila:
//      cada chamada de "salvar como" consome o próximo caminho) e/ou
//      --stub-open-path=caminho (ver saveCurrentDesignExternally e o
//      cenário save-roundtrip em harness-main.js).
//   3. Se o cenário precisar de uma pasta/arquivo preparado antes (uma
//      fixture), gere-o em buildFixtures() abaixo, reaproveitando o núcleo
//      real (src/core/pattern, src/core/io) — não crie arquivos de matriz
//      "na mão"/hardcoded.
//   4. `npm run test:ui` roda todos; `node tests/ui/run.js <nome>` roda só
//      um cenário (útil enquanto se escreve um novo).
//
// -------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const HARNESS_MAIN = path.join(__dirname, 'harness-main.js');
const ELECTRON_BIN = require('electron'); // fora do Electron, require('electron') resolve pro caminho do executável
const SAMPLE_XXX = path.join(REPO_ROOT, 'samples', 'rosacea.xxx');

const ONLY = process.argv[2] || null; // node tests/ui/run.js <cenario> roda só esse

// ------------------------------------------------------------------ setup

function seedSettings(userDataDir, libraryDefaultPath) {
  // Sem isto, qualquer cenário que abra o diálogo de pendrive cairia na
  // biblioteca padrão REAL do usuário (~/Bordados — ver src/main/settings.js
  // DEFAULTS.library.path), porque drives:library-info lê settings.get()
  // direto, ignorando --library=. Cada userData isolada recebe seu próprio
  // settings.json apontando pra uma pasta temporária seguríssima.
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(libraryDefaultPath, { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({ library: { path: libraryDefaultPath } }, null, 2)
  );
}

function tinyPattern(Pattern, name, colorHex) {
  const p = new Pattern();
  p.metadata('name', name);
  p.addThread({ color: colorHex, description: name });
  p.moveAbs(-200, -200);
  for (const [x, y] of [
    [-200, -200],
    [200, -200],
    [200, 200],
    [-200, 200],
    [-200, -200],
  ]) {
    p.stitchAbs(x, y);
  }
  p.end();
  return p;
}

// Gera as 2 matrizes da fixture de biblioteca com o núcleo real (mesma
// técnica de tools/make-samples.js), em vez de arquivos binários prontos.
function makeLibraryFixture(dir) {
  const { Pattern } = require(path.join(REPO_ROOT, 'src', 'core', 'pattern'));
  const io = require(path.join(REPO_ROOT, 'src', 'core', 'io'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fixture-a.xxx'), io.writeBuffer(tinyPattern(Pattern, 'FIXTURE-A', 0xc0392b), 'xxx'));
  fs.writeFileSync(path.join(dir, 'fixture-b.dst'), io.writeBuffer(tinyPattern(Pattern, 'FIXTURE-B', 0x2980b9), 'dst'));
}

function makeFakeDrive(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SAMPLE_XXX, path.join(dir, 'rosacea.xxx'));
}

function buildFixtures(tmpRoot) {
  const libraryDir = path.join(tmpRoot, 'library-fixture');
  const fakeDriveDir = path.join(tmpRoot, 'fake-drive');
  // Raiz própria e vazia pro cenário library-newfolder (issue #28, item 1):
  // não reaproveita libraryDir pra não depender da ordem de execução com
  // library-dialog (que conta exatamente 2 itens na raiz).
  const newFolderLibraryDir = path.join(tmpRoot, 'library-newfolder-fixture');
  makeLibraryFixture(libraryDir);
  makeFakeDrive(fakeDriveDir);
  fs.mkdirSync(newFolderLibraryDir, { recursive: true });
  return {
    libraryDir,
    fakeDriveDir,
    newFolderLibraryDir,
    resizeBefore: path.join(tmpRoot, 'resize', 'before.xxx'),
    resizeAfter: path.join(tmpRoot, 'resize', 'after.xxx'),
    roundtripPath: path.join(tmpRoot, 'roundtrip', 'saved.xxx'),
    projectPath: path.join(tmpRoot, 'project', 'projeto.bastidor'),
  };
}

function buildScenarioDefs(fx) {
  return [
    { name: 'boot', args: ['--lang=pt-BR'] },
    { name: 'open-sample', args: [`--open=${SAMPLE_XXX}`, '--lang=pt-BR'] },
    { name: 'edit-mode', args: [`--open=${SAMPLE_XXX}`, '--lang=pt-BR'] },
    { name: 'merge-color-blocks', args: [`--open=${SAMPLE_XXX}`, '--lang=pt-BR'] },
    {
      name: 'resize-keep-density',
      args: [`--open=${SAMPLE_XXX}`, '--lang=pt-BR', `--stub-save-paths=${fx.resizeBefore},${fx.resizeAfter}`],
    },
    {
      name: 'save-roundtrip',
      args: [
        `--open=${SAMPLE_XXX}`,
        '--lang=pt-BR',
        `--stub-save-paths=${fx.roundtripPath}`,
        `--stub-open-path=${fx.roundtripPath}`,
      ],
    },
    { name: 'text-object-resize', args: ['--dialog=text', '--lang=pt-BR'] },
    {
      name: 'project-roundtrip',
      args: ['--dialog=text', '--lang=pt-BR', `--stub-project-path=${fx.projectPath}`],
    },
    { name: 'library-dialog', args: ['--lang=pt-BR', `--library=${fx.libraryDir}`] },
    { name: 'library-newfolder', args: ['--lang=pt-BR', `--library=${fx.newFolderLibraryDir}`] },
    { name: 'drives-dialog', args: ['--lang=pt-BR', `--fake-drive=${fx.fakeDriveDir}`] },
    { name: 'object-rotate', args: ['--dialog=text', '--lang=pt-BR'] },
    { name: 'stitch-order-panel', args: [`--open=${SAMPLE_XXX}`, '--lang=pt-BR'] },
  ];
}

// -------------------------------------------------------------- execução

function runScenario(def, tmpRoot) {
  const userDataDir = path.join(tmpRoot, `userdata-${def.name}`);
  const libraryDefaultPath = path.join(tmpRoot, `lib-default-${def.name}`);
  seedSettings(userDataDir, libraryDefaultPath);
  const outFile = path.join(tmpRoot, `out-${def.name}.json`);

  const args = [HARNESS_MAIN, `--scenario=${def.name}`, `--user-data=${userDataDir}`, `--out=${outFile}`, ...def.args];

  const spawned = spawnSync(ELECTRON_BIN, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    timeout: 45000,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  let result = null;
  try {
    result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch {
    result = null;
  }
  return { def, spawned, result };
}

// -------------------------------------------------- verificação extra (densidade)
//
// Não dá pra ler state.design.stitches de dentro do browser (é um `const`,
// não sobra em window). Em vez de criar um gancho de teste em renderer.js,
// o cenário resize-keep-density só GRAVA o antes/depois em disco (pelo
// fluxo real de "salvar como"); a comparação em si roda aqui, em Node puro,
// reabrindo os dois arquivos com o núcleo real (src/core/io) e reaplicando
// a MESMA fórmula de espaçamento que src/core/densityscale.js usa
// internamente (rebuildSatinRun: espinha = pontos médios de agulhadas
// consecutivas; espaçamento = comprimento da espinha / (pontos - 1)).
function averageSpineSpacing(stitches, run) {
  const pts = stitches.slice(run.start, run.end);
  const spine = [];
  for (let i = 0; i < pts.length - 1; i++) {
    spine.push([(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]);
  }
  let len = 0;
  for (let i = 1; i < spine.length; i++) {
    len += Math.hypot(spine[i][0] - spine[i - 1][0], spine[i][1] - spine[i - 1][1]);
  }
  return spine.length > 1 ? len / (spine.length - 1) : null;
}

function checkDensityPreserved(beforePath, afterPath) {
  const io = require(path.join(REPO_ROOT, 'src', 'core', 'io'));
  const densityscale = require(path.join(REPO_ROOT, 'src', 'core', 'densityscale'));

  function loadRingSpacing(filePath) {
    const buf = fs.readFileSync(filePath);
    const ext = io.extOf(filePath);
    const pattern = io.readBuffer(buf, ext, {});
    const runs = densityscale.detectSatinRuns(pattern.stitches);
    if (!runs.length) return { spacing: null, runs: 0 };
    const largest = runs.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    return { spacing: averageSpineSpacing(pattern.stitches, largest), runs: runs.length };
  }

  const before = loadRingSpacing(beforePath);
  const after = loadRingSpacing(afterPath);
  const bothDetected = before.spacing != null && after.spacing != null;
  const relDiff = bothDetected ? Math.abs(after.spacing - before.spacing) / before.spacing : null;
  return { before, after, relDiff, preserved: bothDetected && relDiff < 0.15 };
}

// ------------------------------------------------------------------ report

function printAssertions(assertions) {
  for (const a of assertions || []) {
    const mark = a.pass ? 'ok ' : 'FALHOU ';
    console.log(`    ${mark}- ${a.desc}${a.detail != null ? ` (${a.detail})` : ''}`);
  }
}

function printScenarioReport({ def, spawned, result }) {
  console.log(`\n=== ${def.name} ===`);
  if (spawned.error) {
    console.log(`  FALHA ao iniciar o processo Electron: ${spawned.error.message}`);
    return false;
  }
  if (spawned.signal) {
    console.log(`  FALHA: processo encerrado pelo sinal ${spawned.signal} (provável timeout de 45s)`);
    if (spawned.stdout) console.log('  stdout:', spawned.stdout.slice(-2000));
    if (spawned.stderr) console.log('  stderr:', spawned.stderr.slice(-2000));
    return false;
  }
  if (!result) {
    console.log(`  FALHA: sem JSON de resultado (out file ausente/inválido). exit code: ${spawned.status}`);
    if (spawned.stdout) console.log('  stdout:', spawned.stdout.slice(-2000));
    if (spawned.stderr) console.log('  stderr:', spawned.stderr.slice(-2000));
    return false;
  }

  printAssertions(result.assertions);
  if (result.error) console.log(`  erro no cenário: ${result.error}`);
  if (result.badConsole && result.badConsole.length) {
    console.log(`  console sujo (${result.badConsole.length} mensagem(ns) com Uncaught/Refused/SyntaxError):`);
    for (const m of result.badConsole) console.log(`    [console] ${m.message} (${m.sourceId}:${m.line})`);
  }
  console.log(`  console: ${result.consoleMessageCount} mensagem(ns) capturada(s) no total`);
  console.log(`  resultado: ${result.ok ? 'PASS' : 'FAIL'}`);
  return result.ok;
}

// -------------------------------------------------------------------- main

function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bastidor-uitest-'));
  console.log(`[run] pasta temporária: ${tmpRoot}`);

  const fx = buildFixtures(tmpRoot);
  let defs = buildScenarioDefs(fx);
  if (ONLY) {
    defs = defs.filter((d) => d.name === ONLY);
    if (!defs.length) {
      console.error(`[run] cenário desconhecido: "${ONLY}"`);
      process.exit(1);
    }
  }

  let allOk = true;
  const runs = {};
  for (const def of defs) {
    const run = runScenario(def, tmpRoot);
    runs[def.name] = run;
    const ok = printScenarioReport(run);
    allOk = allOk && ok;
  }

  // Verificação extra do resize-keep-density: só faz sentido se o próprio
  // cenário passou (senão os arquivos podem não existir/estar incompletos).
  if (runs['resize-keep-density'] && runs['resize-keep-density'].result && runs['resize-keep-density'].result.ok) {
    console.log('\n=== resize-keep-density: verificação de densidade (Node, fora do browser) ===');
    try {
      const density = checkDensityPreserved(fx.resizeBefore, fx.resizeAfter);
      console.log(
        `  espaçamento do anel: antes=${density.before.spacing != null ? density.before.spacing.toFixed(3) : 'não detectado'} depois=${density.after.spacing != null ? density.after.spacing.toFixed(3) : 'não detectado'}` +
          (density.relDiff != null ? ` (diferença relativa ${(density.relDiff * 100).toFixed(1)}%)` : '')
      );
      console.log(`  resultado: ${density.preserved ? 'PASS' : 'FAIL'} (densidade preservada dentro de 15%)`);
      allOk = allOk && density.preserved;
    } catch (err) {
      console.log(`  FALHA ao comparar densidade: ${err.message}`);
      allOk = false;
    }
  }

  const total = defs.length;
  const passed = defs.filter((d) => runs[d.name].result && runs[d.name].result.ok).length;
  console.log(`\n[run] ${passed}/${total} cenário(s) passaram.`);
  console.log(`[run] resultado final: ${allOk ? 'PASS' : 'FAIL'}`);
  process.exitCode = allOk ? 0 : 1;
}

main();
