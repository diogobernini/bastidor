'use strict';
// tests/ui/harness-main.js
//
// Processo principal de TESTE (Electron). Não é o app de produção: é um
// entry point paralelo que carrega o app REAL (src/main/main.js, que por
// sua vez abre src/renderer/index.html com o preload real) e instrumenta a
// janela pra rodar um cenário e reportar o resultado em JSON.
//
// Reaproveita main.js por completo (require direto) em vez de duplicar
// handlers de IPC: main.js já sabe interpretar --user-data=, --open=,
// --dialog=, --lang=, --fake-drive=, --library=, --library-search= (eram
// flags de "autoteste" que já existiam para telas/capturas manuais). Este
// arquivo só acrescenta: captura de TODAS as mensagens de console, stubs
// opcionais para os diálogos nativos (que travariam esperando um clique
// humano) e o catálogo de cenários. Ver tests/ui/run.js para a documentação
// de como adicionar um cenário novo e para o orquestrador que invoca este
// arquivo via `electron tests/ui/harness-main.js --scenario=X ...`.
//
// Uso direto (fora do run.js), útil pra depurar um cenário isolado:
//   npx electron tests/ui/harness-main.js --scenario=boot --user-data=/tmp/x --out=/tmp/x/out.json

const path = require('path');
const fs = require('fs');
const { app, ipcMain } = require('electron');

const REPO_ROOT = path.join(__dirname, '..', '..');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const ARGS = parseArgs(process.argv);
const SCENARIO = ARGS.scenario || null;
const OUT_FILE = ARGS.out || null;
const STUB_SAVE_PATHS = ARGS['stub-save-paths'] ? ARGS['stub-save-paths'].split(',').filter(Boolean) : [];
const STUB_OPEN_PATH = ARGS['stub-open-path'] || null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIntLoose(s) {
  // Números formatados em pt-BR usam "." como separador de milhar
  // (ex.: "2.253"); tira tudo que não é dígito/sinal antes do parseInt.
  if (s == null) return NaN;
  const digits = String(s).replace(/[^\d-]/g, '');
  return digits ? parseInt(digits, 10) : NaN;
}

// ------------------------------------------------------------- console real

// A asserção central da suíte: captura TODA mensagem de console de TODA
// janela, de qualquer fonte (JS da página, CSP, exceptions não tratadas).
// Registrado antes de existir qualquer janela (main.js só cria a dele dentro
// de app.whenReady, que ainda não aconteceu neste ponto do arquivo).
const consoleMessages = [];
let firstWindow = null;
app.on('browser-window-created', (_event, win) => {
  if (!firstWindow) firstWindow = win;
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    consoleMessages.push({ level, message, line, sourceId });
  });
});

function badConsoleMessages() {
  // É esta regex que pega a classe de bug de colisão de script clássico
  // (issue #34): um "const api" ou "const COMMAND_MASK" duplicado em outro
  // <script> aborta o script inteiro com SyntaxError, silenciosamente do
  // ponto de vista do usuário — só aparece no console.
  return consoleMessages.filter((m) => /Uncaught|Refused|SyntaxError/.test(m.message));
}

// --------------------------------------------------------- sinal de "pronto"

// O renderer chama window.api.notifyRenderReady() no fim de boot() (ver
// src/renderer/renderer.js), depois de abrir --open=/--dialog= se houver.
// Se o script do renderer falhar por completo (é exatamente o que a "prova
// de detecção" do relatório reproduz), esse sinal nunca chega — por isso o
// timeout abaixo nunca trava o cenário, só reporta que o boot não sinalizou.
let renderReadyFired = false;
let renderReadyResolve = null;
const renderReadyPromise = new Promise((resolve) => {
  renderReadyResolve = resolve;
});
ipcMain.on('render:ready', () => {
  renderReadyFired = true;
  renderReadyResolve();
});

function waitForRenderReady(timeoutMs) {
  if (renderReadyFired) return Promise.resolve(true);
  return Promise.race([
    renderReadyPromise.then(() => true),
    sleep(timeoutMs).then(() => renderReadyFired),
  ]);
}

function waitForWindow(timeoutMs) {
  if (firstWindow) return Promise.resolve(firstWindow);
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (firstWindow) {
        clearInterval(iv);
        resolve(firstWindow);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error('timeout esperando a BrowserWindow ser criada'));
      }
    }, 20);
  });
}

// ------------------------------------------------------- toolkit de página
//
// Injetado uma vez por janela via executeJavaScript. Roda no mundo principal
// (mesmo escopo de window.api e das funções globais do renderer.js, que por
// serem "function" no topo de um script clássico ficam em window). Dispara
// eventos DOM reais (Pointer/Mouse/Keyboard) em vez de chamar funções do
// renderer diretamente — é o que exercita de fato os addEventListener do
// app, e não só a lógica por trás deles.
const PAGE_TOOLKIT = `
(function () {
  if (window.__ui) return;

  function fire(el, type, opts) {
    var Ctor = MouseEvent;
    if (type.indexOf('pointer') === 0) Ctor = PointerEvent;
    else if (type.indexOf('key') === 0) Ctor = KeyboardEvent;
    var base = { bubbles: true, cancelable: true, view: window };
    var ev = new Ctor(type, Object.assign(base, opts || {}));
    el.dispatchEvent(ev);
    return ev;
  }

  function need(sel) {
    var el = document.querySelector(sel);
    if (!el) throw new Error('elemento não encontrado: ' + sel);
    return el;
  }

  window.__ui = {
    exists: function (sel) { return !!document.querySelector(sel); },
    text: function (sel) { var el = document.querySelector(sel); return el ? el.textContent : null; },
    value: function (sel) { var el = document.querySelector(sel); return el ? el.value : null; },
    checked: function (sel) { var el = document.querySelector(sel); return el ? !!el.checked : null; },
    count: function (sel) { return document.querySelectorAll(sel).length; },
    hasClass: function (sel, cls) { var el = document.querySelector(sel); return el ? el.classList.contains(cls) : null; },
    isDisabled: function (sel) { var el = document.querySelector(sel); return el ? !!el.disabled : null; },
    isHidden: function (sel) { var el = document.querySelector(sel); return el ? !!el.hidden : null; },
    isOpen: function (sel) { var el = document.querySelector(sel); return el ? !!el.open : null; },
    displayNone: function (sel) { var el = document.querySelector(sel); return el ? getComputedStyle(el).display === 'none' : null; },

    // Clique real: sequência pointerdown/mousedown/pointerup/mouseup/click no
    // centro do elemento, igual a um clique físico de mouse.
    click: function (sel) {
      var el = need(sel);
      var r = el.getBoundingClientRect();
      var x = r.left + r.width / 2;
      var y = r.top + r.height / 2;
      var common = { clientX: x, clientY: y, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0 };
      fire(el, 'pointerdown', common);
      fire(el, 'mousedown', common);
      fire(el, 'pointerup', common);
      fire(el, 'mouseup', common);
      fire(el, 'click', common);
    },

    // Digitação num <input>: foca, escreve o valor final e dispara input+change
    // (os listeners do app usam 'input'/'change', não tecla a tecla).
    setValue: function (sel, val) {
      var el = need(sel);
      el.focus();
      el.value = val;
      fire(el, 'input', {});
      fire(el, 'change', {});
    },

    setChecked: function (sel, wanted) {
      var el = need(sel);
      if (!!el.checked !== !!wanted) window.__ui.click(sel);
    },

    // keydown num seletor (ou na window, se sel for falsy — é onde
    // bindMenuAndKeys escuta os atalhos de edição: Delete, setas, Escape...).
    keydown: function (sel, key, opts) {
      var el = sel ? need(sel) : window;
      fire(el, 'keydown', Object.assign({ key: key }, opts || {}));
    },

    // pointerdown no primeiro ponto, pointermove nos demais, pointerup no
    // último (repetido) — select puro é pointerDrag(sel, [p]); arrastar é
    // pointerDrag(sel, [pDown, pUp]). Coordenadas em px de página (client).
    pointerDrag: function (sel, points) {
      var el = need(sel);
      var common = { pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0 };
      fire(el, 'pointerdown', Object.assign({ clientX: points[0].x, clientY: points[0].y }, common));
      for (var i = 1; i < points.length; i++) {
        fire(el, 'pointermove', Object.assign({ clientX: points[i].x, clientY: points[i].y }, common));
      }
      var last = points[points.length - 1];
      fire(el, 'pointerup', Object.assign({ clientX: last.x, clientY: last.y }, common));
    },

    // Converte um ponto em coordenadas de DESENHO (0,1mm, mesmo espaço de
    // state.design.stitches) pra coordenadas de PÁGINA, usando a mesma
    // window.toScreen que o próprio renderer.js expõe (script clássico:
    // "function" no topo do arquivo vira propriedade de window).
    designPointToClient: function (sel, dx, dy) {
      var el = need(sel);
      var r = el.getBoundingClientRect();
      var s = window.toScreen(dx, dy);
      return { x: r.left + s[0], y: r.top + s[1] };
    },
  };
})();
`;

// -------------------------------------------------------------- cenários
//
// Cada cenário recebe um "ctx" (ver buildCtx) e roda até o fim ou até uma
// ctx.assert() falhar (a exceção sobe e é registrada como falha do
// cenário). O console só é conferido DEPOIS, em main(), então mesmo um
// cenário "sem asserções relevantes" ainda falha se o boot sujar o console.

async function saveCurrentDesignExternally(ctx) {
  // "Salvar como" > diálogo da biblioteca (modo salvar) > "Salvar fora..." >
  // diálogo nativo (dialog:save, stubado via --stub-save-paths) > grava de
  // verdade (design:write, sem stub). Confirma pelo toast, não pelo fecho do
  // diálogo (a biblioteca fecha ANTES do await da gravação terminar).
  const toastsBefore = await ctx.page("__ui.count('#toasts .toast')");
  await ctx.page("__ui.click('#btn-save')");
  ctx.assert('diálogo de biblioteca (salvar como) abriu', await ctx.waitFor("__ui.isOpen('#dlg-library')", 5000));
  await ctx.page("__ui.click('#lib-save-external')");
  const saved = await ctx.waitFor(`__ui.count('#toasts .toast') > ${toastsBefore}`, 5000);
  ctx.assert('toast confirmando gravação apareceu', saved);
}

const SCENARIOS = {
  // Boot vazio: nenhum arquivo aberto. A asserção de console (em main) é a
  // que importa de verdade aqui; o resto confirma que a tela inicial é a
  // esperada (sem exigir nada da lógica de abrir/editar matriz).
  async boot(ctx) {
    ctx.assert('boot sinalizou pronto (render:ready)', ctx.bootReady);
    ctx.assert('estado vazio visível', (await ctx.page("__ui.displayNone('#empty-state')")) === false);
    ctx.assert('painel lateral escondido (sem matriz)', (await ctx.page("__ui.isHidden('#sidebar')")) === true);
    ctx.assert(
      'barra de status mostra "Nenhum arquivo aberto"',
      (await ctx.page("__ui.text('#st-file')")) === 'Nenhum arquivo aberto'
    );
  },

  // Abre samples/rosacea.xxx (via --open=, mesma flag de autoteste que
  // main.js já suportava) e confere a leitura completa: 3 cores, 2253
  // pontos (contagem real do arquivo, ver relatório da tarefa).
  async 'open-sample'(ctx) {
    ctx.assert('boot sinalizou pronto', ctx.bootReady);
    ctx.assert('painel lateral visível (matriz carregada)', (await ctx.page("__ui.isHidden('#sidebar')")) === false);
    ctx.assert('3 cores na lista', (await ctx.page("__ui.count('#color-list li')")) === 3);
    ctx.assert('contador de cores mostra "(3)"', (await ctx.page("__ui.text('#color-count')")) === '(3)');
    const stitches = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(2)')"));
    ctx.assert('2253 pontos na sidebar', stitches === 2253, stitches);
    ctx.assert('botão Editar habilitado', (await ctx.page("__ui.isDisabled('#btn-edit')")) === false);
  },

  // Modo de edição: seleciona o ponto (0,0) — garantidamente uma agulhada
  // real do miolo em espiral da amostra —, arrasta, apaga com Delete e
  // desfaz. Tudo via eventos reais de pointer/teclado no canvas/window.
  async 'edit-mode'(ctx) {
    ctx.assert('boot sinalizou pronto', ctx.bootReady);
    const stitchesInitial = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(2)')"));
    ctx.assert('2253 pontos antes de editar', stitchesInitial === 2253, stitchesInitial);

    await ctx.page("__ui.click('#btn-edit')");
    ctx.assert('modo de edição ativado', await ctx.page("__ui.hasClass('#btn-edit', 'on')"));

    const p = await ctx.page("__ui.designPointToClient('#cv', 0, 0)");
    await ctx.page(`__ui.pointerDrag('#cv', [{x: ${p.x}, y: ${p.y}}])`);
    const statusAfterSelect = await ctx.page("__ui.text('#st-edit')");
    ctx.assert('ponto selecionado (barra de status preenchida)', !!statusAfterSelect, statusAfterSelect);

    await ctx.page(`__ui.pointerDrag('#cv', [{x: ${p.x}, y: ${p.y}}, {x: ${p.x + 40}, y: ${p.y + 30}}])`);
    const statusAfterDrag = await ctx.page("__ui.text('#st-edit')");
    ctx.assert(
      'posição do ponto mudou após arrastar',
      statusAfterDrag !== statusAfterSelect,
      `${statusAfterSelect} -> ${statusAfterDrag}`
    );
    ctx.assert('Desfazer habilitado após arrastar', (await ctx.page("__ui.isDisabled('#t-undo')")) === false);

    await ctx.page("__ui.keydown(null, 'Delete')");
    const stitchesAfterDelete = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(2)')"));
    ctx.assert('2252 pontos após apagar (Delete)', stitchesAfterDelete === stitchesInitial - 1, stitchesAfterDelete);
    ctx.assert('seleção limpa após apagar', (await ctx.page("__ui.text('#st-edit')")) === '');

    await ctx.page("__ui.click('#t-undo')");
    const stitchesAfterUndo = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(2)')"));
    ctx.assert('2253 pontos após Desfazer', stitchesAfterUndo === stitchesInitial, stitchesAfterUndo);
  },

  // Redimensiona com "manter densidade" e confirma, por fora (no run.js,
  // reabrindo os dois arquivos salvos aqui com o núcleo real), que o
  // espaçamento do anel de ponto cheio não escalou junto com o tamanho.
  // Este cenário só GRAVA os dois arquivos (--stub-save-paths=antes,depois);
  // a comparação de densidade mora em run.js (Node puro, sem Electron).
  async 'resize-keep-density'(ctx) {
    ctx.assert('boot sinalizou pronto', ctx.bootReady);
    ctx.assert('3 cores na lista', (await ctx.page("__ui.count('#color-list li')")) === 3);

    await saveCurrentDesignExternally(ctx); // grava o estado ORIGINAL

    await ctx.page("__ui.click('#t-scale')");
    ctx.assert('diálogo de redimensionar abriu', await ctx.waitFor("__ui.isOpen('#dlg-scale')", 3000));
    await ctx.page("__ui.setValue('#scale-percent', '200')");
    await ctx.page("__ui.setChecked('#scale-keepdensity', true)");
    ctx.assert('checkbox "manter densidade" marcado', await ctx.page("__ui.checked('#scale-keepdensity')"));
    await ctx.page('__ui.click(\'#dlg-scale button[value="apply"]\')');
    ctx.assert('diálogo de redimensionar fechou', await ctx.waitFor("!__ui.isOpen('#dlg-scale')", 3000));

    await saveCurrentDesignExternally(ctx); // grava o estado REDIMENSIONADO
  },

  // Salvar como .xxx numa pasta temporária e reabrir (roundtrip). O
  // "reabrir" passa pela MESMA UI de abrir (biblioteca > "Abrir do
  // computador...") — só o diálogo nativo é stubado (--stub-open-path),
  // igual ao de salvar; a leitura em si (design:read) é a real.
  async 'save-roundtrip'(ctx) {
    ctx.assert('boot sinalizou pronto', ctx.bootReady);
    ctx.assert('3 cores na lista (original)', (await ctx.page("__ui.count('#color-list li')")) === 3);

    await saveCurrentDesignExternally(ctx);

    await ctx.page("__ui.click('#btn-open')");
    ctx.assert('diálogo de biblioteca (abrir) abriu', await ctx.waitFor("__ui.isOpen('#dlg-library')", 5000));
    await ctx.page("__ui.click('#lib-open-external')");
    ctx.assert('diálogo de biblioteca fechou após reabrir', await ctx.waitFor("!__ui.isOpen('#dlg-library')", 5000));
    ctx.assert('reabriu com 3 cores', await ctx.waitFor("__ui.count('#color-list li') === 3", 5000));
    const stitches = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(2)')"));
    ctx.assert('reabriu com 2253 pontos (roundtrip intacto)', stitches === 2253, stitches);
  },

  // Mesclagem de blocos de cor adjacentes (issue #50): mescla o 1º bloco
  // com o 2º (mantém a linha do 1º), confere que as contagens somam, que o
  // total de pontos não muda (só o COLOR_CHANGE some) e que dá pra desfazer
  // (undo) voltando aos 3 blocos originais.
  async 'merge-color-blocks'(ctx) {
    ctx.assert('boot sinalizou pronto', ctx.bootReady);
    ctx.assert('3 cores na lista (original)', (await ctx.page("__ui.count('#color-list li')")) === 3);
    ctx.assert(
      '2 botões de mesclar (um por bloco, exceto o último)',
      (await ctx.page("__ui.count('#color-list li button.merge-btn')")) === 2
    );
    ctx.assert(
      'último bloco não tem botão de mesclar',
      (await ctx.page("__ui.exists('#color-list li:nth-child(3) button.merge-btn')")) === false
    );

    const stitchesBefore = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(2)')"));
    const colorChangesBefore = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(3)')"));
    const count1Before = parseIntLoose(await ctx.page("__ui.text('#color-list li:nth-child(1) .count')"));
    const count2Before = parseIntLoose(await ctx.page("__ui.text('#color-list li:nth-child(2) .count')"));
    const name1Before = await ctx.page("__ui.text('#color-list li:nth-child(1) .name')");

    await ctx.page("__ui.click('#color-list li:nth-child(1) button.merge-btn')");

    ctx.assert('2 cores na lista após mesclar', await ctx.waitFor("__ui.count('#color-list li') === 2", 3000));
    ctx.assert('contador de cores mostra "(2)"', (await ctx.page("__ui.text('#color-count')")) === '(2)');

    const count1After = parseIntLoose(await ctx.page("__ui.text('#color-list li:nth-child(1) .count')"));
    ctx.assert(
      'contagem do 1º bloco soma a dos dois mesclados',
      count1After === count1Before + count2Before,
      `${count1Before} + ${count2Before} = ${count1After}`
    );
    const name1After = await ctx.page("__ui.text('#color-list li:nth-child(1) .name')");
    ctx.assert('mantém a linha (thread) do bloco de CIMA', name1After === name1Before, `${name1Before} -> ${name1After}`);

    const stitchesAfter = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(2)')"));
    ctx.assert('total de pontos não muda (só o COLOR_CHANGE some)', stitchesAfter === stitchesBefore, stitchesAfter);
    const colorChangesAfter = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(3)')"));
    ctx.assert(
      'uma troca de cor a menos',
      colorChangesAfter === colorChangesBefore - 1,
      `${colorChangesBefore} -> ${colorChangesAfter}`
    );
    ctx.assert('Desfazer habilitado após mesclar', (await ctx.page("__ui.isDisabled('#t-undo')")) === false);

    await ctx.page("__ui.click('#t-undo')");
    ctx.assert('3 cores de volta após Desfazer', await ctx.waitFor("__ui.count('#color-list li') === 3", 3000));
    const count1Undone = parseIntLoose(await ctx.page("__ui.text('#color-list li:nth-child(1) .count')"));
    const count2Undone = parseIntLoose(await ctx.page("__ui.text('#color-list li:nth-child(2) .count')"));
    ctx.assert('contagens originais restauradas', count1Undone === count1Before && count2Undone === count2Before);
    const stitchesUndone = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(2)')"));
    ctx.assert('total de pontos igual ao original após Desfazer', stitchesUndone === stitchesBefore, stitchesUndone);
  },

  // Diálogo da biblioteca apontando pra uma pasta fixture (--library=, a
  // mesma flag de autoteste que já existia) com 2 matrizes geradas no setup
  // do run.js (tests/ui/run.js: makeFixtureLibrary).
  async 'library-dialog'(ctx) {
    ctx.assert('boot vazio sinalizou pronto', ctx.bootReady);
    await ctx.page("__ui.click('#btn-open')");
    ctx.assert('diálogo de biblioteca abriu', await ctx.waitFor("__ui.isOpen('#dlg-library')", 5000));
    ctx.assert(
      'grade mostra as 2 matrizes da pasta fixture',
      await ctx.waitFor("__ui.count('#lib-grid-inner .lib-item') === 2", 5000)
    );
  },

  // Diálogo de pendrive com --fake-drive (flag de autoteste já existente em
  // main.js): a pasta fixture do run.js entra como um pendrive "FAKE" com 1
  // matriz dentro.
  async 'drives-dialog'(ctx) {
    ctx.assert('boot vazio sinalizou pronto', ctx.bootReady);
    await ctx.page("__ui.click('#btn-drives')");
    ctx.assert('diálogo de pendrive abriu', await ctx.waitFor("__ui.isOpen('#dlg-drives')", 5000));
    ctx.assert(
      'pendrive falso "FAKE" listado no seletor',
      await ctx.waitFor("(__ui.text('#drive-select') || '').indexOf('FAKE') !== -1", 5000)
    );
    ctx.assert(
      '1 item listado no pendrive falso',
      await ctx.waitFor("__ui.count('#drive-list .drive-item') === 1", 5000)
    );
  },
};

// ------------------------------------------------------------------ driver

function buildCtx(win, bootReady) {
  const assertions = [];
  return {
    args: ARGS,
    bootReady,
    assertions,
    result: {},
    async page(expr) {
      return win.webContents.executeJavaScript(expr);
    },
    async waitFor(boolExpr, timeoutMs = 5000, intervalMs = 50) {
      const start = Date.now();
      for (;;) {
        const ok = await win.webContents.executeJavaScript(`Boolean(${boolExpr})`);
        if (ok) return true;
        if (Date.now() - start > timeoutMs) return false;
        await sleep(intervalMs);
      }
    },
    assert(desc, cond, detail) {
      const pass = !!cond;
      assertions.push({ desc, pass, detail: detail === undefined ? null : String(detail) });
      if (!pass) throw new Error(desc + (detail !== undefined ? ` (obtido: ${detail})` : ''));
    },
  };
}

async function main() {
  if (!SCENARIO) {
    console.error('[harness] faltou --scenario=<nome>');
    app.exit(1);
    return;
  }
  if (!SCENARIOS[SCENARIO]) {
    console.error(`[harness] cenário desconhecido: ${SCENARIO} (ver SCENARIOS em tests/ui/harness-main.js)`);
    app.exit(1);
    return;
  }

  // Carrega o app REAL só agora (require de main.js aciona seu próprio
  // app.whenReady().then(...), que cria a janela com o preload real e
  // registra todo o IPC de produção). Feito dentro de main() pra podermos
  // validar --scenario= antes de abrir qualquer janela.
  require(path.join(REPO_ROOT, 'src', 'main', 'main.js'));

  await app.whenReady();

  // Stubs de diálogo nativo: só instalados se o cenário pedir. Substituem
  // exclusivamente a ESCOLHA do caminho (dialog:save/dialog:open); a
  // gravação/leitura real (design:write/design:read, já registrados por
  // main.js acima) continua intacta.
  if (STUB_SAVE_PATHS.length) {
    const queue = STUB_SAVE_PATHS.slice();
    ipcMain.removeHandler('dialog:save');
    ipcMain.handle('dialog:save', () => queue.shift() || null);
  }
  if (STUB_OPEN_PATH) {
    ipcMain.removeHandler('dialog:open');
    ipcMain.handle('dialog:open', () => {
      const io = require(path.join(REPO_ROOT, 'src', 'core', 'io'));
      const { patternToDesign } = require(path.join(REPO_ROOT, 'src', 'core', 'design'));
      const filePath = STUB_OPEN_PATH;
      const ext = io.extOf(filePath);
      const buf = fs.readFileSync(filePath);
      const pattern = io.readBuffer(buf, ext, {});
      return patternToDesign(pattern, { path: filePath, format: ext, name: path.basename(filePath) });
    });
  }

  const win = await waitForWindow(10000);
  await win.webContents.executeJavaScript(PAGE_TOOLKIT);
  const bootReady = await waitForRenderReady(15000);

  const ctx = buildCtx(win, bootReady);
  let scenarioError = null;
  try {
    await SCENARIOS[SCENARIO](ctx);
  } catch (err) {
    scenarioError = err && err.message ? err.message : String(err);
  }

  // A checagem de console roda SEMPRE, mesmo se o cenário já tiver falhado
  // por outro motivo (ou justamente por causa dela — ver "prova de
  // detecção" no relatório da tarefa).
  const bad = badConsoleMessages();
  const ok = !scenarioError && bad.length === 0;

  const result = {
    scenario: SCENARIO,
    ok,
    bootReady,
    error: scenarioError,
    assertions: ctx.assertions,
    extra: ctx.result,
    badConsole: bad,
    consoleMessageCount: consoleMessages.length,
  };

  if (OUT_FILE) {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
  }
  console.log(`[harness] cenário "${SCENARIO}": ${ok ? 'PASS' : 'FAIL'}`);
  app.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[harness] erro fatal:', err);
  app.exit(1);
});
