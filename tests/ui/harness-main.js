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
const STUB_PROJECT_PATH = ARGS['stub-project-path'] || null; // issue #29 fase 2: caminho fixo pro roundtrip de .bastidor

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
    // state.design.stitches) pra coordenadas de PÁGINA, usando
    // window.RenderCanvas.toScreen (módulo IIFE extraído do renderer.js —
    // ver src/renderer/modules/render-canvas.js).
    designPointToClient: function (sel, dx, dy) {
      var el = need(sel);
      var r = el.getBoundingClientRect();
      var s = window.RenderCanvas.toScreen(dx, dy);
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

// Ativa o modo de objetos (se ainda não estiver) e seleciona o único objeto
// do design por varredura de cliques numa grade fina — o raio de seleção é
// um tamanho FIXO em tela, 10px, então precisa de uma grade mais fina do
// que isso pra não pular por cima da tinta de um glifo específico. Usado
// por qualquer cenário que precise de UM objeto selecionado antes de agir
// nele (redimensionar, girar — issue #29 fases 2 e 3).
async function activateObjectsAndSelectSole(ctx) {
  const alreadyOn = await ctx.page("__ui.hasClass('#btn-objects', 'on')");
  if (!alreadyOn) await ctx.page("__ui.click('#btn-objects')");
  ctx.assert('modo de objetos ativado', await ctx.page("__ui.hasClass('#btn-objects', 'on')"));

  const selected = await ctx.page(`
    (function () {
      var cv = document.querySelector('#cv');
      var r = cv.getBoundingClientRect();
      var common = { pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, bubbles: true, cancelable: true };
      for (var fx = 0.15; fx <= 0.85; fx += 0.02) {
        for (var fy = 0.15; fy <= 0.85; fy += 0.02) {
          var x = r.left + r.width * fx, y = r.top + r.height * fy;
          var opts = Object.assign({ clientX: x, clientY: y }, common);
          cv.dispatchEvent(new PointerEvent('pointerdown', opts));
          cv.dispatchEvent(new PointerEvent('pointerup', opts));
          if (window.ObjectCanvas.selectedIndex() >= 0) return true;
        }
      }
      return false;
    })()
  `);
  ctx.assert('objeto selecionado (grade de cliques achou a tinta)', selected);
  return selected;
}

// Redimensiona o objeto já selecionado (ver activateObjectsAndSelectSole)
// arrastando a alça "se" proporcionalmente por `factor` a partir do pivô
// "nw". Devolve a contagem de agulhadas antes/depois (uma regeneração DE
// VERDADE muda a contagem; uma escala de coordenadas manteria o mesmo nº de
// pontos) — usado tanto por text-object-resize quanto por
// project-roundtrip (issue #29 fase 2).
async function selectAndResizeOnlyObject(ctx, factor) {
  const stitchesBefore = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(2)')"));
  const avgBefore = await ctx.page("__ui.text('#info-list dd:nth-of-type(6)')");

  await activateObjectsAndSelectSole(ctx);

  const bbox = await ctx.page('window.ObjectCanvas.selectedBBox()');
  ctx.assert('bbox do objeto selecionado disponível', !!bbox, JSON.stringify(bbox));

  // resizeFactors projeta sobre o vetor original e SEMPRE devolve o MESMO
  // fator nos dois eixos fora do modo Alt (ver src/renderer/objects.js), não
  // precisa ser exato: só precisa estar na mesma direção geral, sem Alt.
  const seClient = await ctx.page(`__ui.designPointToClient('#cv', ${bbox.maxX}, ${bbox.maxY})`);
  const nwClient = await ctx.page(`__ui.designPointToClient('#cv', ${bbox.minX}, ${bbox.minY})`);
  const targetX = nwClient.x + (seClient.x - nwClient.x) * factor;
  const targetY = nwClient.y + (seClient.y - nwClient.y) * factor;
  await ctx.page(`__ui.pointerDrag('#cv', [{x: ${seClient.x}, y: ${seClient.y}}, {x: ${targetX}, y: ${targetY}}])`);

  // A regeneração roda por IPC depois do pointerup: espera a contagem de
  // agulhadas mudar em vez de um timeout fixo.
  const regenerated = await ctx.waitFor(
    `Number((__ui.text('#info-list dd:nth-of-type(2)') || '').replace(/\\D/g, '')) !== ${stitchesBefore} && Number((__ui.text('#info-list dd:nth-of-type(2)') || '').replace(/\\D/g, '')) > 0`,
    5000
  );
  ctx.assert('contagem de agulhadas mudou (regeneração de verdade, não escala de coordenadas)', regenerated);

  const stitchesAfter = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(2)')"));
  const avgAfter = await ctx.page("__ui.text('#info-list dd:nth-of-type(6)')");
  return { stitchesBefore, stitchesAfter, avgBefore, avgAfter };
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

  // Insere texto, entra no modo de objetos (issue #29 fase 2), seleciona o
  // objeto de texto recém-criado e redimensiona a alça SE proporcionalmente
  // (2x). Confirma que foi uma regeneração DE VERDADE (window.api.
  // letteringBuild rodado de novo com heightMm maior), não uma escala de
  // coordenadas: a contagem de agulhadas MUDA (um texto maior tem mais
  // pontos no mesmo comprimento de ponto) mas o comprimento médio do ponto
  // (info.avgStitch) fica igual dentro de 15%, e o nº de cores não muda.
  // A posição exata das alças vem de ObjectCanvas.selectedBBox() + toScreen
  // (ambos já globais no escopo do script clássico do renderer) — não exige
  // nenhum hook novo além do que a fase 1 já expõe pro harness.
  async 'text-object-resize'(ctx) {
    ctx.assert('boot sinalizou pronto', ctx.bootReady);
    ctx.assert('diálogo de texto abriu (--dialog=text)', await ctx.waitFor("__ui.isOpen('#dlg-text')", 5000));

    await ctx.page("__ui.setValue('#text-input', 'M')");
    await ctx.page("__ui.setValue('#text-height', '30')");
    await ctx.page("__ui.setValue('#text-stitchlen', '0.5')"); // pontos bem próximos: mais fácil de acertar no clique de seleção
    await ctx.page("__ui.click('#text-insert-btn')");
    ctx.assert('diálogo de texto fechou após inserir', await ctx.waitFor("!__ui.isOpen('#dlg-text')", 5000));
    ctx.assert('painel lateral visível (design de texto criado)', await ctx.waitFor("!__ui.isHidden('#sidebar')", 5000));
    ctx.assert('1 cor na lista (texto de uma cor só)', (await ctx.page("__ui.text('#color-count')")) === '(1)');

    const { stitchesBefore, stitchesAfter, avgBefore, avgAfter } = await selectAndResizeOnlyObject(ctx, 2);
    ctx.assert(
      'agulhadas mudaram de verdade (regeneração, não escala de coordenadas)',
      stitchesAfter !== stitchesBefore,
      `${stitchesBefore} -> ${stitchesAfter}`
    );
    ctx.assert('ainda 1 cor depois de redimensionar (contagem de cores preservada)', (await ctx.page("__ui.text('#color-count')")) === '(1)');
    ctx.assert(
      'seleção continua válida depois da regeneração',
      (await ctx.page('window.ObjectCanvas.selectedIndex()')) >= 0
    );

    const parseMm = (s) => parseFloat(String(s).replace(',', '.'));
    const relDiff = Math.abs(parseMm(avgAfter) - parseMm(avgBefore)) / parseMm(avgBefore);
    ctx.assert(
      'comprimento médio do ponto preservado dentro de 15% (densidade igual, tamanho maior)',
      relDiff < 0.15,
      `${avgBefore} -> ${avgAfter} (${(relDiff * 100).toFixed(1)}%)`
    );
  },

  // Projeto nativo .bastidor (issue #29 fase 2): insere texto, salva como
  // projeto (window.saveProjectFlow — mesma função que o item de menu
  // "Salvar Projeto como..." chama; menus nativos não são clicáveis via DOM,
  // então chamamos o global direto, igual a designPointToClient/toScreen já
  // fazem para outras pontes internas do renderer), reabre (window.
  // openProjectFlow) e confirma que design.objects[] sobreviveu de verdade:
  // um redimensionamento DEPOIS de reabrir ainda roda o gerador (não vira
  // escala de coordenadas), a prova de que source/stitchParams vieram
  // completos do arquivo salvo, não só a projeção achatada.
  async 'project-roundtrip'(ctx) {
    ctx.assert('boot sinalizou pronto', ctx.bootReady);
    ctx.assert('diálogo de texto abriu (--dialog=text)', await ctx.waitFor("__ui.isOpen('#dlg-text')", 5000));
    await ctx.page("__ui.setValue('#text-input', 'M')");
    await ctx.page("__ui.setValue('#text-height', '30')");
    await ctx.page("__ui.setValue('#text-stitchlen', '0.5')");
    await ctx.page("__ui.click('#text-insert-btn')");
    ctx.assert('design de texto criado', await ctx.waitFor("!__ui.isHidden('#sidebar')", 5000));
    const stitchesOriginal = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(2)')"));

    const toastsBeforeSave = await ctx.page("__ui.count('#toasts .toast')");
    await ctx.page('window.saveProjectFlow()');
    ctx.assert('toast de projeto salvo apareceu', await ctx.waitFor(`__ui.count('#toasts .toast') > ${toastsBeforeSave}`, 5000));

    // Reabre por cima do mesmo design (openProjectFlow não pede confirmação,
    // igual ao "Abrir" comum — ver comentário em renderer.js).
    await ctx.page('window.openProjectFlow()');
    ctx.assert(
      'reabriu com a mesma contagem de agulhadas (roundtrip do array achatado intacto)',
      await ctx.waitFor(`Number((__ui.text('#info-list dd:nth-of-type(2)') || '').replace(/\\D/g, '')) === ${stitchesOriginal}`, 5000)
    );
    ctx.assert('ainda 1 cor depois de reabrir', (await ctx.page("__ui.text('#color-count')")) === '(1)');

    // A prova de verdade: redimensionar DEPOIS de reabrir ainda regenera
    // (não teria como, se design.objects[] não tivesse sobrevivido ao JSON).
    const { stitchesBefore, stitchesAfter } = await selectAndResizeOnlyObject(ctx, 1.5);
    ctx.assert(
      'objeto paramétrico sobreviveu ao save/reopen: redimensionar depois de reabrir ainda regenera',
      stitchesAfter !== stitchesBefore,
      `${stitchesBefore} -> ${stitchesAfter}`
    );
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

  // Criar pasta no picker da biblioteca (issue #28, item 1): raiz fixture
  // própria e vazia (não a de 'library-dialog', pra não depender de ordem
  // entre cenários); clica "+ Nova pasta" (#lib-tree-newfolder), preenche o
  // nome no dialog e confirma — a árvore deve navegar pra dentro da pasta
  // recém-criada (selecionada, grade vazia).
  async 'library-newfolder'(ctx) {
    ctx.assert('boot vazio sinalizou pronto', ctx.bootReady);
    await ctx.page("__ui.click('#btn-open')");
    ctx.assert('diálogo de biblioteca abriu', await ctx.waitFor("__ui.isOpen('#dlg-library')", 5000));
    ctx.assert('raiz fixture está vazia antes de criar a pasta', await ctx.waitFor("__ui.count('#lib-grid-inner .lib-item') === 0", 5000));

    await ctx.page("__ui.click('#lib-tree-newfolder')");
    ctx.assert('diálogo de nova pasta abriu', await ctx.waitFor("__ui.isOpen('#dlg-lib-newfolder')", 5000));

    await ctx.page("__ui.setValue('#lib-newfolder-input', 'Coleção Nova')");
    await ctx.page("__ui.click('#lib-newfolder-confirm')");
    ctx.assert('diálogo de nova pasta fechou', await ctx.waitFor("!__ui.isOpen('#dlg-lib-newfolder')", 5000));

    ctx.assert(
      'árvore navegou pra dentro da pasta recém-criada (selecionada)',
      await ctx.waitFor(
        "__ui.count('.lib-tree-node.selected') === 1 && (__ui.text('.lib-tree-node.selected .name') || '').indexOf('Coleção Nova') !== -1",
        5000
      )
    );
    ctx.assert('grade da pasta nova está vazia (nenhuma matriz dentro dela ainda)', await ctx.waitFor("__ui.count('#lib-grid-inner .lib-item') === 0", 5000));
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

  // Rotação (issue #29 fase 3): insere um texto, seleciona o objeto,
  // arrasta a alça de rotação (acima da alça "n") por +90° ao redor do
  // centro do bbox e confirma pelo ângulo ACUMULADO do objeto
  // (object.transform.rotation, exposto só para o harness via
  // ObjectCanvas.selectedObjectRotation) — mais robusto que inferir pela
  // forma do bbox, que não necessariamente "vira" de um jeito óbvio para
  // um glifo qualquer. O alvo de +90° é calculado em cima da posição REAL
  // da alça (via RenderCanvas.toDesign/toScreen), não de uma constante de
  // offset duplicada aqui. Confirma também que o total de agulhadas não
  // muda (rotação é uma transformação rígida) e que Desfazer restaura as
  // dimensões originais do design.
  async 'object-rotate'(ctx) {
    ctx.assert('boot sinalizou pronto', ctx.bootReady);
    ctx.assert('diálogo de texto abriu (--dialog=text)', await ctx.waitFor("__ui.isOpen('#dlg-text')", 5000));
    await ctx.page("__ui.setValue('#text-input', 'M')");
    await ctx.page("__ui.setValue('#text-height', '30')");
    await ctx.page("__ui.setValue('#text-stitchlen', '0.5')");
    await ctx.page("__ui.click('#text-insert-btn')");
    ctx.assert('design de texto criado', await ctx.waitFor("!__ui.isHidden('#sidebar')", 5000));

    const dimsBefore = await ctx.page("__ui.text('#info-list dd:nth-of-type(1)')");
    const stitchesBefore = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(2)')"));

    await activateObjectsAndSelectSole(ctx);

    const rotationBefore = await ctx.page('window.ObjectCanvas.selectedObjectRotation()');
    ctx.assert('ângulo inicial é 0', rotationBefore === 0, rotationBefore);

    const drag = await ctx.page(`
      (function () {
        var cv = document.querySelector('#cv');
        var r = cv.getBoundingClientRect();
        var bbox = window.ObjectCanvas.selectedBBox();
        var cx = (bbox.minX + bbox.maxX) / 2, cy = (bbox.minY + bbox.maxY) / 2;
        var handle = window.ObjectCanvas.rotateHandlePoint();
        var d = window.RenderCanvas.toDesign(handle.x, handle.y);
        var startAngle = Math.atan2(d[1] - cy, d[0] - cx);
        var radius = Math.hypot(d[0] - cx, d[1] - cy);
        var targetAngle = startAngle + Math.PI / 2;
        var tx = cx + radius * Math.cos(targetAngle), ty = cy + radius * Math.sin(targetAngle);
        var targetScreen = window.RenderCanvas.toScreen(tx, ty);
        return {
          start: { x: r.left + handle.x, y: r.top + handle.y },
          target: { x: r.left + targetScreen[0], y: r.top + targetScreen[1] },
        };
      })()
    `);
    ctx.assert('alça de rotação encontrada', !!drag, JSON.stringify(drag));

    await ctx.page(`__ui.pointerDrag('#cv', [{x: ${drag.start.x}, y: ${drag.start.y}}, {x: ${drag.target.x}, y: ${drag.target.y}}])`);
    await ctx.waitFor('window.ObjectCanvas.selectedObjectRotation() !== 0', 3000);

    const rotationAfter = await ctx.page('window.ObjectCanvas.selectedObjectRotation()');
    ctx.assert('ângulo acumulado ficou perto de 90°', rotationAfter !== null && Math.abs(rotationAfter - 90) < 2, rotationAfter);

    // Rotação é uma transformação RÍGIDA (preserva toda distância entre
    // pontos), então a contagem não deveria mudar quase nada — só a guarda
    // de espaçamento mínimo (issue #29 fase 1) pode fundir 1-2 agulhadas
    // que, por causa do arredondamento pro inteiro mais próximo, ficaram
    // por um triz mais perto do que a distância mínima configurada.
    const stitchesAfter = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(2)')"));
    ctx.assert(
      'total de agulhadas praticamente não muda (rotação é uma transformação rígida)',
      Math.abs(stitchesAfter - stitchesBefore) <= 5,
      `${stitchesBefore} -> ${stitchesAfter}`
    );
    ctx.assert('seleção continua válida depois de girar', (await ctx.page('window.ObjectCanvas.selectedIndex()')) >= 0);

    await ctx.page("__ui.click('#t-undo')");
    ctx.assert(
      'Desfazer restaura as dimensões originais',
      await ctx.waitFor(`__ui.text('#info-list dd:nth-of-type(1)') === ${JSON.stringify(dimsBefore)}`, 3000)
    );
  },

  // Painel de ordem de costura (issue #29 fase 3): abre a amostra (3 blocos
  // soltos, nenhum objeto paramétrico — prova que o painel também funciona
  // sem nenhum design.objects[]), ativa o modo de objetos, confirma 3
  // linhas no painel (uma por bloco solto) e desce o 1º bloco (troca com o
  // 2º). A prova de que os TRECHOS de agulhadas de verdade trocaram de
  // posição (não só o rótulo do painel) é o próprio #color-list, já
  // existente desde a fase 1 — mas o NOME de cada linha (".name") é apenas
  // "N. Cor {posição}" quando a amostra não tem descrição/catálogo (ver
  // threadLabel em renderer.js: usa o índice do fio, não a identidade), a
  // mesma razão pela qual merge-color-blocks confere pela COR
  // (swatch.value), não pelo nome — aqui é igual: a cor de cada bloco (só
  // ela é distinta por fio) prova que os trechos trocaram de posição de
  // verdade. Confirma também que o total de agulhadas não muda e que
  // Desfazer restaura a ordem original.
  async 'stitch-order-panel'(ctx) {
    ctx.assert('boot sinalizou pronto', ctx.bootReady);
    ctx.assert('3 cores na lista', (await ctx.page("__ui.count('#color-list li')")) === 3);

    await ctx.page("__ui.click('#btn-objects')");
    ctx.assert('modo de objetos ativado', await ctx.page("__ui.hasClass('#btn-objects', 'on')"));
    ctx.assert('painel de objetos visível', await ctx.waitFor("!__ui.isHidden('#obj-panel')", 3000));
    ctx.assert('3 linhas na ordem de costura (3 blocos soltos)', await ctx.waitFor("__ui.count('#stitch-order-list li') === 3", 3000));

    const stitchesBefore = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(2)')"));
    const color1Before = await ctx.page("__ui.value('#color-list li:nth-child(1) .swatch')");
    const color2Before = await ctx.page("__ui.value('#color-list li:nth-child(2) .swatch')");
    const count1Before = parseIntLoose(await ctx.page("__ui.text('#color-list li:nth-child(1) .count')"));
    const count2Before = parseIntLoose(await ctx.page("__ui.text('#color-list li:nth-child(2) .count')"));
    ctx.assert('as duas primeiras cores da amostra são diferentes', color1Before !== color2Before, `${color1Before} / ${color2Before}`);

    ctx.assert(
      'botão subir da 1ª linha está desabilitado (já é a primeira)',
      await ctx.page("__ui.isDisabled('#stitch-order-list li:nth-child(1) button.order-btn:nth-of-type(1)')")
    );
    ctx.assert(
      'botão descer da última linha está desabilitado',
      await ctx.page("__ui.isDisabled('#stitch-order-list li:nth-child(3) button.order-btn:nth-of-type(2)')")
    );

    await ctx.page("__ui.click('#stitch-order-list li:nth-child(1) button.order-btn:nth-of-type(2)')"); // desce o 1º bloco

    ctx.assert(
      '1º e 2º blocos trocaram de posição na lista de cores (cor)',
      await ctx.waitFor(`__ui.value('#color-list li:nth-child(2) .swatch') === ${JSON.stringify(color1Before)}`, 3000)
    );
    const color1After = await ctx.page("__ui.value('#color-list li:nth-child(1) .swatch')");
    ctx.assert('1ª posição agora tem a cor que era da 2ª', color1After === color2Before, `${color2Before} -> ${color1After}`);

    const count1After = parseIntLoose(await ctx.page("__ui.text('#color-list li:nth-child(1) .count')"));
    const count2After = parseIntLoose(await ctx.page("__ui.text('#color-list li:nth-child(2) .count')"));
    ctx.assert(
      'contagens de ponto acompanham a troca',
      count1After === count2Before && count2After === count1Before,
      `${count1Before},${count2Before} -> ${count1After},${count2After}`
    );

    const stitchesAfter = parseIntLoose(await ctx.page("__ui.text('#info-list dd:nth-of-type(2)')"));
    ctx.assert('total de agulhadas não muda ao reordenar', stitchesAfter === stitchesBefore, `${stitchesBefore} -> ${stitchesAfter}`);

    ctx.assert('Desfazer habilitado após reordenar', (await ctx.page("__ui.isDisabled('#t-undo')")) === false);
    await ctx.page("__ui.click('#t-undo')");
    ctx.assert(
      'ordem original restaurada após Desfazer',
      await ctx.waitFor(`__ui.value('#color-list li:nth-child(1) .swatch') === ${JSON.stringify(color1Before)}`, 3000)
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
  // Roundtrip de projeto .bastidor (issue #29 fase 2): pula só o diálogo
  // nativo (showSaveDialog/showOpenDialog travariam esperando um clique
  // humano) — serialização/escrita/leitura passam pelo MESMO
  // src/core/project.js que o handler de produção usa.
  if (STUB_PROJECT_PATH) {
    const projectCore = require(path.join(REPO_ROOT, 'src', 'core', 'project'));
    ipcMain.removeHandler('project:save');
    ipcMain.handle('project:save', (e, { design }) => {
      const json = projectCore.serializeProject(design);
      fs.mkdirSync(path.dirname(STUB_PROJECT_PATH), { recursive: true });
      fs.writeFileSync(STUB_PROJECT_PATH, json);
      return { path: STUB_PROJECT_PATH, bytes: Buffer.byteLength(json) };
    });
    ipcMain.removeHandler('project:open');
    ipcMain.handle('project:open', () => {
      const json = fs.readFileSync(STUB_PROJECT_PATH, 'utf8');
      const parsed = projectCore.parseProject(json);
      return Object.assign(parsed, {
        path: STUB_PROJECT_PATH,
        format: 'bastidor',
        name: parsed.name || path.basename(STUB_PROJECT_PATH, path.extname(STUB_PROJECT_PATH)),
      });
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
