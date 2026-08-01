'use strict';
// Renderer do Bastidor: canvas, simulação, transformações e preferências.
// O design chega do processo principal como objeto simples:
// { stitches: [[x, y, cmd]...], threads: [{color, description, catalog}...], metadata, path, format, name }
// Unidades do design: 0,1 mm. Y cresce para baixo.

/* eslint-env browser */

// Comandos (mesmos valores de src/core/commands.js).
const STITCH = 0;
const JUMP = 1;
const TRIM = 2;
const STOP = 3;
const END = 4;
const COLOR_CHANGE = 5;
const SEQUIN_EJECT = 7;
const COMMAND_MASK = 0xff;

const FILLER_COLORS = [
  '#c94f4f', '#4f7dc9', '#4fc98a', '#c9b44f', '#9a4fc9', '#c9784f',
  '#4fc4c9', '#c94f9e', '#7dc94f', '#5e5ec9', '#8a6f52', '#4f9ac9',
];

const EDIT_PICK_RADIUS_PX = 8; // raio de seleção de ponto no modo de edição (em px de tela)

const $ = (id) => document.getElementById(id);

const state = {
  design: null,
  blocks: [], // { threadIndex, start, end (exclusivo), stitchCount }
  stats: null,
  settings: null,
  hoopPresets: {},
  lang: 'pt-BR',
  strings: {},
  platform: 'darwin',
  view: { scale: 1, tx: 0, ty: 0 },
  sim: { playing: false, pos: Infinity, lastT: 0 },
  edit: { active: false, selected: -1 }, // modo "Editar pontos" (issue #3)
  dirty: false,
  renderQueued: false,
  interacting: false, // pan/zoom em andamento (mouse/wheel)
  artVersion: 0, // incrementa a cada mudança que afeta o desenho dos pontos
  realisticCache: null, // canvas offscreen com a arte realista já desenhada
  // Gestão de pendrive (biblioteca <-> drive): ver seção dedicada mais abaixo.
  drives: {
    list: [],
    selectedMount: null,
    libraryPath: null,
    libraryItems: [],
    driveItems: [],
    refreshTimer: null,
    selection: { library: new Set(), drive: new Set() },
    cache: new Map(), // "caminho::mtime" -> {ok:true,design} | {ok:false,error} | Promise disso
  },
  svgImport: null, // { path, text, name } aguardando os parâmetros do dialog
  lettering: { fonts: [], lastResult: null }, // ferramenta de texto (issue #7)
  // Gestão de biblioteca (issue #17): navegador por pastas com busca,
  // filtros, favoritos e cache de miniaturas. Ver seção dedicada mais abaixo.
  library: {
    root: null,
    mode: 'open', // 'open' | 'save'
    currentRelDir: '', // pasta selecionada na árvore (raiz = '')
    treeExpanded: new Set(['']),
    treeChildren: new Map(), // relDir -> [{name, relDir}] (subpastas já carregadas)
    moveTreeExpanded: new Set(['']),
    moveTreeChildren: new Map(),
    moveTarget: null,
    moveChosenRelDir: '',
    renameTarget: null,
    searching: false,
    truncated: false,
    baseItems: [], // itens da pasta/busca antes dos filtros de dimensão/pontos
    items: [], // itens já filtrados, exibidos na grade
    filters: { format: '', minW: null, maxW: null, minH: null, maxH: null, minS: null, maxS: null, favoritesOnly: false },
    favorites: new Set(),
    thumbCache: new Map(), // "caminho::mtime" -> Promise<dataURL|null>
    drives: [],
    selectedDriveMount: null,
    driveRefreshTimer: null,
    searchDebounce: null,
    filterDebounce: null,
    loadToken: 0, // evita corrida ao trocar de pasta/busca rapidamente
    // Varredura incremental com progresso (issue #35): ver startLibraryIndexing.
    indexData: new Map(), // "caminho absoluto" -> {ok, wMm, hMm, stitches}, espelha o índice persistido no processo principal
    indexProgress: { active: false, done: 0, total: 0 },
    indexShowTimer: null,
    indexIdleWaiters: [],
  },
};

function bumpArt() {
  state.artVersion++;
}

// --------------------------------------------------------------- utilidades

function toast(msg, kind = '', ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function threadColor(i) {
  const t = state.design.threads[i];
  return t && t.color ? t.color : FILLER_COLORS[i % FILLER_COLORS.length];
}

function threadLabel(i) {
  const t = state.design.threads[i];
  const fallback = I18n.tr('colors.fallback', { n: i + 1 });
  if (!t) return fallback;
  const parts = [];
  if (t.description) parts.push(t.description);
  if (t.catalog) parts.push(I18n.tr('colors.catalog', { n: t.catalog }));
  return parts.length ? parts.join(' · ') : fallback;
}

const CMD_LABEL_KEYS = {
  [STITCH]: 'cmd.stitch',
  [JUMP]: 'cmd.jump',
  [TRIM]: 'cmd.trim',
  [STOP]: 'cmd.stop',
  [END]: 'cmd.end',
  [COLOR_CHANGE]: 'cmd.colorChange',
};

function cmdLabel(cmd) {
  const key = CMD_LABEL_KEYS[cmd & COMMAND_MASK];
  return I18n.tr(key || 'cmd.other');
}

// --------------------------------------------------------------- design

function deriveBlocks() {
  const blocks = [];
  const stitches = state.design.stitches;
  let start = 0;
  let threadIndex = 0;
  for (let i = 0; i < stitches.length; i++) {
    const cmd = stitches[i][2] & COMMAND_MASK;
    if (cmd === COLOR_CHANGE) {
      blocks.push({ threadIndex, start, end: i + 1 });
      threadIndex++;
      start = i + 1;
    }
  }
  if (start < stitches.length) blocks.push({ threadIndex, start, end: stitches.length });
  for (const b of blocks) {
    b.stitchCount = 0;
    for (let i = b.start; i < b.end; i++) {
      if ((stitches[i][2] & COMMAND_MASK) === STITCH) b.stitchCount++;
    }
  }
  state.blocks = blocks.filter((b) => b.stitchCount > 0 || blocks.length === 1);
  // Garante um fio editável para cada bloco.
  while (state.design.threads.length < blocks.length) {
    const i = state.design.threads.length;
    state.design.threads.push({ color: FILLER_COLORS[i % FILLER_COLORS.length], description: null, catalog: null });
  }
}

function deriveStats() {
  const stitches = state.design.stitches;
  const s = {
    stitches: 0,
    jumps: 0,
    trims: 0,
    colorChanges: 0,
    stops: 0,
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxLen: 0,
    sumLen: 0,
    longCount: 0,
  };
  const warnLimit = (state.settings ? state.settings.warnings.longStitchMm : 12.1) * 10;
  let px = 0;
  let py = 0;
  let hasPos = false;
  for (const st of stitches) {
    const cmd = st[2] & COMMAND_MASK;
    if (cmd === STITCH || cmd === JUMP || cmd === SEQUIN_EJECT) {
      if (st[0] < s.minX) s.minX = st[0];
      if (st[0] > s.maxX) s.maxX = st[0];
      if (st[1] < s.minY) s.minY = st[1];
      if (st[1] > s.maxY) s.maxY = st[1];
    }
    if (cmd === STITCH) {
      if (hasPos) {
        const len = Math.hypot(st[0] - px, st[1] - py);
        if (len > s.maxLen) s.maxLen = len;
        if (len > warnLimit) s.longCount++;
        s.sumLen += len;
      }
      s.stitches++;
      px = st[0];
      py = st[1];
      hasPos = true;
    } else if (cmd === JUMP) {
      s.jumps++;
      px = st[0];
      py = st[1];
      hasPos = true;
    } else if (cmd === TRIM) s.trims++;
    else if (cmd === COLOR_CHANGE) s.colorChanges++;
    else if (cmd === STOP) s.stops++;
  }
  s.width = s.maxX - s.minX;
  s.height = s.maxY - s.minY;
  s.avgLen = s.stitches > 1 ? s.sumLen / (s.stitches - 1) : 0;
  const areaCm2 = (s.width / 100) * (s.height / 100);
  s.density = areaCm2 > 0 ? s.stitches / areaCm2 : 0;
  state.stats = s;
}

function setDesign(design, opts = {}) {
  state.design = design;
  state.sim.playing = false;
  state.sim.pos = Infinity;
  bumpArt();
  state.edit.active = false;
  state.edit.selected = -1;
  $('btn-edit').classList.remove('on');
  canvas.classList.remove('edit-mode');
  if (window.ObjectCanvas) ObjectCanvas.reset(); // troca de arquivo: seleção de objeto não é mais válida (issue #29)
  if (!opts.keepUndo) {
    history.clear();
    state.dirty = false;
  }
  deriveBlocks();
  deriveStats();
  updateSidebar();
  updateStatusbar();
  updateToolbarEnabled();
  updateUndoRedoButtons();
  $('empty-state').style.display = 'none';
  $('sidebar').hidden = false;
  if (!opts.keepView) RenderCanvas.fitView();
  RenderCanvas.requestRender();
  document.title = (design.name ? design.name + ' — ' : '') + 'Bastidor';

  if (!opts.silent) {
    const w = [];
    if (state.stats.longCount > 0) {
      w.push(I18n.tr('warn.longShort', { n: I18n.fmtNum(state.stats.longCount), len: I18n.fmtMm(state.settings.warnings.longStitchMm * 10) }));
    }
    if (hoopExceeded()) w.push(I18n.tr('warn.hoopShort'));
    if (w.length) toast(I18n.tr('warn.prefix') + w.join(I18n.tr('warn.and')), 'warn', 4200);
  }
}

function hoopExceeded() {
  if (!state.stats || !state.settings) return false;
  const h = state.settings.hoop;
  return state.stats.width > h.width * 10 || state.stats.height > h.height * 10;
}

// --------------------------------------------------------------- undo/redo (issue #37)
//
// Histórico por operações com inversa barata (src/core/history.js), em vez
// do snapshot completo por mutação de antes. Cada call-site monta a
// operação mínima que descreve o que mudou (ver comentário no topo de
// history.js) e chama pushHistory(op); história.js cuida do cap por
// quantidade/memória e de limpar o redo a cada novo push. `historyApplyFns`
// é o dicionário que sabe aplicar cada tipo de operação de volta no design
// — usado tanto por undo() (com a operação invertida) quanto por redo()
// (com a operação original).

const history = History.create();

const historyApplyFns = {
  movePoint(op) {
    const st = state.design.stitches[op.index];
    st[0] = op.to[0];
    st[1] = op.to[1];
  },
  deletePoint(op) {
    state.design.stitches.splice(op.index, 1);
  },
  insertPoint(op) {
    state.design.stitches.splice(op.index, 0, op.stitch.slice());
  },
  recolorThread(op) {
    const t = state.design.threads[op.index];
    if (t) t.color = op.to;
    else state.design.threads[op.index] = { color: op.to };
  },
  transform(op) {
    applyTransformToDesign(op.kind, op.params);
  },
  snapshot(op) {
    state.design.stitches = op.after.stitches;
    state.design.threads = op.after.threads;
  },
};

// Empilha uma operação (delta ou snapshot) e atualiza os efeitos colaterais
// que antes viviam dentro de snapshotUndo(): marca o design como sujo e
// mantém os botões Desfazer/Refazer e a barra de status em dia.
function pushHistory(op) {
  history.push(op);
  state.dirty = true;
  updateUndoRedoButtons();
  updateStatusbar();
}

function updateUndoRedoButtons() {
  $('t-undo').disabled = !history.canUndo();
  $('t-redo').disabled = !history.canRedo();
}

// Copia stitches/threads do design atual (mesmo formato usado antes por
// snapshotUndo): usado para montar a operação 'snapshot' de fallback nas
// mutações sem inversa analítica barata (redimensionar com densidade,
// inserir texto como bloco novo).
function cloneDesignData() {
  return {
    stitches: state.design.stitches.map((s) => [s[0], s[1], s[2]]),
    threads: JSON.parse(JSON.stringify(state.design.threads)),
  };
}

// Aplica uma transformação global (kind/params) a cada agulhada do design.
// Usada tanto pela ação direta (centerToOrigin/rotate90/flip/scaleDesign)
// quanto pelo undo/redo de uma operação 'transform' — mesma matemática,
// pra nunca divergir entre "fazer" e "desfazer/refazer".
function transformPoint(kind, params, x, y) {
  switch (kind) {
    case 'translate':
      // dx/dy já chegam inteiros (ver centerToOrigin): soma exata, sem
      // perda de precisão em nenhuma direção (undo/redo ida e volta).
      return [x + params.dx, y + params.dy];
    case 'rotate90': {
      const dx = x - params.cx;
      const dy = y - params.cy;
      return params.clockwise ? [params.cx - dy, params.cy + dx] : [params.cx + dy, params.cy - dx];
    }
    case 'flip':
      return params.horizontal ? [2 * params.cx - x, y] : [x, 2 * params.cy - y];
    case 'scale':
      return [params.cx + (x - params.cx) * params.factor, params.cy + (y - params.cy) * params.factor];
    default:
      return [x, y];
  }
}

function applyTransformToDesign(kind, params) {
  for (const st of state.design.stitches) {
    const [x, y] = transformPoint(kind, params, st[0], st[1]);
    st[0] = x;
    st[1] = y;
  }
}

function undo() {
  const applied = history.undo(historyApplyFns);
  if (!applied) return;
  afterHistoryNav();
}

function redo() {
  const applied = history.redo(historyApplyFns);
  if (!applied) return;
  afterHistoryNav();
}

// Efeitos colaterais comuns depois de desfazer ou refazer uma operação
// qualquer (mesma sequência que undo() já fazia antes desta issue).
function afterHistoryNav() {
  bumpArt();
  state.edit.selected = -1; // índice pode não valer mais (insert/delete mudam o tamanho do array)
  if (window.ObjectCanvas) ObjectCanvas.reset(); // idem para a seleção de objeto (issue #29)
  deriveBlocks();
  deriveStats();
  updateSidebar();
  updateUndoRedoButtons();
  updateStatusbar();
  RenderCanvas.requestRender();
}

// --------------------------------------------------------------- sidebar

function updateSidebar() {
  const s = state.stats;
  const info = $('info-list');
  const rows = [
    [I18n.tr('info.dimensions'), `${I18n.fmtMm(s.width)} × ${I18n.fmtMm(s.height)}`],
    [I18n.tr('info.stitches'), I18n.fmtNum(s.stitches)],
    [I18n.tr('info.colorChanges'), I18n.fmtNum(s.colorChanges)],
    [I18n.tr('info.jumps'), I18n.fmtNum(s.jumps)],
    [I18n.tr('info.trims'), I18n.fmtNum(s.trims)],
  ];
  if (s.stops > 0) rows.push([I18n.tr('info.stops'), I18n.fmtNum(s.stops)]);
  rows.push([I18n.tr('info.avgStitch'), I18n.fmtMm(s.avgLen)]);
  rows.push([I18n.tr('info.maxStitch'), I18n.fmtMm(s.maxLen)]);
  if (s.density > 0) rows.push([I18n.tr('info.density'), `${Math.round(s.density)} ${I18n.tr('unit.density')}`]);
  const fmt = state.design.format ? state.design.format.toUpperCase() : null;
  if (fmt) rows.push([I18n.tr('info.format'), fmt]);
  info.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    info.append(dt, dd);
  }

  const list = $('color-list');
  list.innerHTML = '';
  $('color-count').textContent = state.blocks.length ? `(${state.blocks.length})` : '';
  state.blocks.forEach((block, bi) => {
    const li = document.createElement('li');
    const sw = document.createElement('input');
    sw.type = 'color';
    sw.className = 'swatch';
    sw.value = threadColor(block.threadIndex);
    sw.title = I18n.tr('colors.tip');
    sw.addEventListener('change', () => {
      const from = threadColor(block.threadIndex);
      const to = sw.value;
      pushHistory({ type: 'recolorThread', index: block.threadIndex, from, to });
      const t = state.design.threads[block.threadIndex];
      if (t) t.color = to;
      else state.design.threads[block.threadIndex] = { color: to };
      bumpArt();
      updateSidebar();
      RenderCanvas.requestRender();
    });
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${bi + 1}. ${threadLabel(block.threadIndex)}`;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = I18n.fmtNum(block.stitchCount);
    li.append(sw, name, count);
    list.appendChild(li);
  });

  const warnings = [];
  if (state.stats.longCount > 0) {
    warnings.push(I18n.tr('warn.long', { n: I18n.fmtNum(state.stats.longCount), len: I18n.fmtMm(state.settings.warnings.longStitchMm * 10) }));
  }
  if (hoopExceeded()) {
    const h = state.settings.hoop;
    warnings.push(I18n.tr('warn.hoop', { w: h.width, h: h.height }));
  }
  if (window.ObjectCanvas && ObjectCanvas.sidebarWarning()) warnings.push(ObjectCanvas.sidebarWarning()); // issue #29
  $('warnings-section').hidden = warnings.length === 0;
  const wl = $('warning-list');
  wl.innerHTML = '';
  for (const w of warnings) {
    const li = document.createElement('li');
    li.textContent = w;
    wl.appendChild(li);
  }
}

function updateStatusbar() {
  if (!state.design) {
    $('st-file').textContent = I18n.tr('status.noFile');
    $('st-size').textContent = '';
    $('st-stitches').textContent = '';
    $('st-edit').textContent = '';
    return;
  }
  const name = state.design.name || '·';
  $('st-file').textContent = (state.dirty ? '● ' : '') + name + (state.design.path ? ' · ' + state.design.path : '');
  $('st-size').textContent = `${I18n.fmtMm(state.stats.width)} × ${I18n.fmtMm(state.stats.height)}`;
  $('st-stitches').textContent = I18n.tr('status.stitches', { n: I18n.fmtNum(state.stats.stitches) });

  const sel = state.edit.active && state.edit.selected >= 0 && state.edit.selected < state.design.stitches.length
    ? state.edit.selected
    : -1;
  if (sel >= 0) {
    const st = state.design.stitches[sel];
    $('st-edit').textContent = I18n.tr('status.editPoint', {
      n: I18n.fmtNum(sel),
      cmd: cmdLabel(st[2]),
      x: I18n.fmtMm(st[0]),
      y: I18n.fmtMm(st[1]),
    });
  } else {
    $('st-edit').textContent = '';
  }
}

function updateToolbarEnabled() {
  const has = !!state.design;
  for (const id of ['btn-save', 'btn-export', 'btn-edit', 'btn-objects']) $(id).disabled = !has;
  // Simulação, edição de pontos e modo de objetos são mutuamente exclusivos (issue #29).
  const objActive = !!(window.ObjectCanvas && ObjectCanvas.isActive());
  const simEnabled = has && !state.edit.active && !objActive;
  $('btn-sim').disabled = !simEnabled;
  $('sim-progress').disabled = !simEnabled;
}

// --------------------------------------------------------------- canvas

const canvas = $('cv');
const ctx = canvas.getContext('2d');
let dpr = window.devicePixelRatio || 1;

// --------------------------------------------------------------- linha do tempo
//
// Barra embaixo do canvas com um segmento por bloco de cor, proporcional à
// quantidade de pontos: mostra "que horas" entra cada linha. Clique/arrasto
// pula a simulação para aquele ponto. O "seek" (simSeekFraction), o
// play/pause/tick (simSetPlaying/simTick) e o reset (simReset) moram em Sim
// — ver modules/sim.js. O desenho da barra (drawTimeline) e o
// RenderCanvas.render() principal moram em RenderCanvas — ver render-canvas.js.

// --------------------------------------------------------------- edição de pontos (issue #3)
//
// Modo "Editar pontos" (selecionar/mover/inserir/apagar agulhadas) mora em
// Edit — ver modules/edit.js.

// --------------------------------------------------------------- transformações

// Aplica uma transformação global (kind/params, ver transformPoint) ao
// design inteiro, empilhando a operação ANTES de mutar — mesmo padrão que
// os outros deltas (push descreve o que vai mudar, depois muda).
function applyTransform(kind, params) {
  if (!state.design) return;
  pushHistory({ type: 'transform', kind, params });
  applyTransformToDesign(kind, params);
  bumpArt();
  deriveStats();
  updateSidebar();
  updateStatusbar();
  RenderCanvas.requestRender();
}

function designCenter() {
  if (!state.stats) return [0, 0];
  const s = state.stats;
  return [(s.minX + s.maxX) / 2, (s.minY + s.maxY) / 2];
}

function centerToOrigin() {
  const [cx, cy] = designCenter();
  // Arredonda o delta (não cada ponto) para dx/dy inteiros: soma exata em
  // ambas as direções, então undo/redo nunca deriva por arredondamento
  // mesmo quando o centro geométrico cai em .5 (largura/altura ímpar).
  // Math.round(x - cx) === x + Math.round(-cx) para todo x inteiro.
  applyTransform('translate', { dx: Math.round(-cx), dy: Math.round(-cy) });
  RenderCanvas.fitView();
  toast(I18n.tr('toast.centered'));
}

function rotate90(clockwise) {
  const [cx, cy] = designCenter();
  applyTransform('rotate90', { cx, cy, clockwise });
  RenderCanvas.fitView();
}

function flip(horizontal) {
  const [cx, cy] = designCenter();
  applyTransform('flip', { cx, cy, horizontal });
}

function scaleDesign(factor) {
  const [cx, cy] = designCenter();
  applyTransform('scale', { cx, cy, factor });
  RenderCanvas.fitView();
  if (Math.abs(factor - 1) > 0.2) {
    toast(I18n.tr('toast.scaleWarn'), 'warn', 4600);
  }
}

// Como scaleDesign, mas recalcula a densidade das corridas de ponto cheio
// (issue #4, v1) em vez de só escalar as coordenadas. Substitui o array de
// agulhadas por inteiro (o tamanho muda): não tem inversa analítica barata,
// por isso usa o fallback 'snapshot' (cópia completa antes/depois) em vez
// de applyTransform.
function scaleDesignWithDensity(factor) {
  if (!state.design) return;
  const { detectSatinRuns, rescaleWithDensity } = window.DensityScale;
  const [cx, cy] = designCenter();
  const before = cloneDesignData();
  const runs = detectSatinRuns(state.design.stitches);
  state.design.stitches = rescaleWithDensity(state.design.stitches, factor, { center: [cx, cy] });
  pushHistory({ type: 'snapshot', before, after: cloneDesignData() });
  bumpArt(); // invalida o cache do modo realista (integração dos PRs #9 e #10)
  deriveBlocks();
  deriveStats();
  updateSidebar();
  updateStatusbar();
  RenderCanvas.fitView();
  RenderCanvas.requestRender();
  toast(I18n.tr('toast.densityRescaled', { n: I18n.fmtNum(runs.length) }));
}

// --------------------------------------------------------------- salvar/exportar

// "Salvar como" (issue #17): por padrão abre a biblioteca (escolher subpasta
// e nome); saveAsExternal (o fluxo antigo, diálogo do sistema) fica atrás do
// botão "Salvar fora..." dentro do modal da biblioteca.
function saveAs() {
  if (!state.design) return;
  openLibrarySaveDialog();
}

async function saveAsExternal() {
  if (!state.design) return;
  const base = (state.design.name || 'matriz').replace(/\.[^.]+$/, '');
  const filePath = await window.api.saveDialog({ defaultName: base + '.xxx' });
  if (!filePath) return;
  try {
    const result = await window.api.writeDesign(filePath, {
      stitches: state.design.stitches,
      threads: state.design.threads,
      metadata: state.design.metadata || {},
    });
    state.dirty = false;
    state.design.path = result.path;
    state.design.format = result.format;
    state.design.name = result.path.split('/').pop().split('\\').pop();
    updateStatusbar();
    document.title = state.design.name + ' — Bastidor';
    const upper = result.format.toUpperCase();
    let extra = '';
    if (result.format === 'dst' || result.format === 'exp') {
      extra = I18n.tr('toast.noColors', { fmt: upper });
    }
    toast(I18n.tr('toast.saved', { fmt: upper, name: state.design.name }) + extra);
  } catch (err) {
    toast(I18n.tr('toast.saveError') + err.message, 'error', 5000);
  }
}

async function exportPng() {
  if (!state.design) return;
  const base = (state.design.name || 'matriz').replace(/\.[^.]+$/, '');
  const filePath = await window.api.exportPngDialog({ defaultName: base + '.png' });
  if (!filePath) return;
  try {
    const pxPerMm = 8;
    const marginMm = 5;
    const s = state.stats;
    const w = Math.ceil((s.width / 10 + marginMm * 2) * pxPerMm);
    const h = Math.ceil((s.height / 10 + marginMm * 2) * pxPerMm);
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const oc = off.getContext('2d');
    const scale = pxPerMm / 10;
    const tx = -s.minX * scale + marginMm * pxPerMm;
    const ty = -s.minY * scale + marginMm * pxPerMm;
    RenderCanvas.drawStitches(oc, (x, y) => [x * scale + tx, y * scale + ty], scale, Infinity, {
      showJumps: false,
      minLineWidth: 1,
      realistic: !!state.settings.view.realistic,
    });
    await window.api.writePng(filePath, off.toDataURL('image/png'));
    toast(I18n.tr('toast.exported') + filePath.split('/').pop());
  } catch (err) {
    toast(I18n.tr('toast.exportError') + err.message, 'error', 5000);
  }
}

// "Abrir" (issue #17): por padrão abre a biblioteca; openViaDialogExternal (o
// fluxo antigo, diálogo do sistema) fica atrás do botão "Abrir do computador..."
// dentro do modal da biblioteca.
async function openViaDialog() {
  await openLibraryDialog();
}

async function openViaDialogExternal() {
  const design = await window.api.openDialog();
  if (design) {
    setDesign(design);
    closeLibraryDialog(); // se veio do botão "Abrir do computador..." dentro da biblioteca
  }
  refreshEmptyRecents();
}

async function openPath(p) {
  try {
    const design = await window.api.readDesign(p);
    setDesign(design);
  } catch (err) {
    toast(I18n.tr('toast.openError') + err.message, 'error', 5000);
  }
  refreshEmptyRecents();
}

// --------------------------------------------------------------- configurações

function populateHoopPresets() {
  const sel = $('set-hooppreset');
  const current = sel.value;
  sel.innerHTML = '';
  for (const [key, preset] of Object.entries(state.hoopPresets)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = preset.labelKey ? I18n.tr(preset.labelKey) : preset.label;
    sel.appendChild(opt);
  }
  if (current) sel.value = current;
}

function settingsToForm() {
  const s = state.settings;
  $('set-language').value = s.language || 'auto';
  $('set-units').value = s.units;
  $('set-background').value = s.view.background;
  $('set-fabric').checked = !!s.view.fabric;
  $('set-threadwidth').value = s.view.threadWidthMm;
  $('set-showjumps').checked = s.view.showJumps;
  $('set-realistic').checked = s.view.realistic;
  $('set-simspeed').value = s.sim.stitchesPerSecond;
  $('set-machinespeed').value = s.machine.speedSpm;
  $('set-hoopshow').checked = s.hoop.show;
  $('set-hooppreset').value = s.hoop.preset;
  $('set-hoopw').value = s.hoop.width;
  $('set-hooph').value = s.hoop.height;
  $('set-gridshow').checked = s.grid.show;
  $('set-gridspacing').value = s.grid.spacingMm;
  $('set-limitstitch').checked = s.write.limitStitchLength;
  $('set-maxstitch').value = s.write.maxStitchMm;
  $('set-tieon').checked = s.write.tieOn;
  $('set-tieoff').checked = s.write.tieOff;
  $('set-trimat').value = s.write.trimAtJumps;
  $('set-minspacing').value = s.write.minSpacingMm;
  $('set-warnlong').value = s.warnings.longStitchMm;
  $('set-librarypath').value = s.library.path;
  $('set-thumbcachecap').value = s.library.thumbCacheCapMB;
  syncHoopCustomVisibility();
}

function formToSettings() {
  const presetKey = $('set-hooppreset').value;
  const preset = state.hoopPresets[presetKey];
  let width = parseFloat($('set-hoopw').value) || 130;
  let height = parseFloat($('set-hooph').value) || 180;
  if (preset && preset.width) {
    width = preset.width;
    height = preset.height;
  }
  return {
    language: $('set-language').value,
    units: $('set-units').value,
    view: {
      background: $('set-background').value,
      fabric: $('set-fabric').checked,
      showPoints: !!state.settings.view.showPoints,
      threadWidthMm: clampNum($('set-threadwidth').value, 0.1, 1.5, 0.4),
      showJumps: $('set-showjumps').checked,
      realistic: $('set-realistic').checked,
    },
    sim: { stitchesPerSecond: clampNum($('set-simspeed').value, 50, 5000, 600) },
    // Velocidade real da máquina (issue #38): usada na estimativa "confecção
    // ≈" da biblioteca (src/core/sewtime.js), não na simulação acima.
    machine: { speedSpm: Math.round(clampNum($('set-machinespeed').value, 100, 2000, 650)) },
    hoop: { show: $('set-hoopshow').checked, preset: presetKey, width, height },
    grid: { show: $('set-gridshow').checked, spacingMm: clampNum($('set-gridspacing').value, 1, 100, 10) },
    write: {
      limitStitchLength: $('set-limitstitch').checked,
      maxStitchMm: clampNum($('set-maxstitch').value, 1, 12.7, 12.1),
      tieOn: $('set-tieon').checked,
      tieOff: $('set-tieoff').checked,
      trimAtJumps: Math.round(clampNum($('set-trimat').value, 2, 8, 3)),
      minSpacingMm: clampNum($('set-minspacing').value, 0, 2, 0.3),
    },
    warnings: { longStitchMm: clampNum($('set-warnlong').value, 1, 30, 12.1) },
    // library.path fica de fora: é salvo direto em "Escolher pasta…"
    // (settings:set já roda ali), sem esperar o "Salvar" deste formulário.
    library: { thumbCacheCapMB: Math.round(clampNum($('set-thumbcachecap').value, 10, 5000, 200)) },
  };
}

function clampNum(v, min, max, fallback) {
  const n = parseFloat(v);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function syncHoopCustomVisibility() {
  const isCustom = $('set-hooppreset').value === 'custom';
  $('hoop-custom').style.opacity = isCustom ? '1' : '0.45';
  $('set-hoopw').disabled = !isCustom;
  $('set-hooph').disabled = !isCustom;
  if (!isCustom) {
    const preset = state.hoopPresets[$('set-hooppreset').value];
    if (preset && preset.width) {
      $('set-hoopw').value = preset.width;
      $('set-hooph').value = preset.height;
    }
  }
}

function openSettings() {
  settingsToForm();
  $('dlg-settings').showModal();
}

async function applySettingsFromForm() {
  const result = await window.api.setSettings(formToSettings());
  state.settings = result.settings;
  bumpArt(); // espessura do fio, saltos ou modo realista podem ter mudado
  const langChanged = result.lang !== state.lang;
  state.lang = result.lang;
  if (langChanged) I18n.applyI18n();
  $('sim-speed').value = String(nearestSimOption(state.settings.sim.stitchesPerSecond));
  if (state.design) {
    deriveStats();
    updateSidebar();
  }
  updateStatusbar();
  RenderCanvas.requestRender();
}

function nearestSimOption(v) {
  const opts = [150, 300, 600, 1200, 2500];
  return opts.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
}

// --------------------------------------------------------------- gestão de pendrive
//
// Modal de dois painéis (biblioteca <-> pendrive selecionado). Cada arquivo listado
// é só metadado (io principal manda path/nome/tamanho/mtime); a miniatura e a
// contagem de pontos vêm de uma leitura preguiçosa (drives:peek-design), tolerante
// a erro, cacheada por caminho+mtime para não reparsear ao reabrir o modal.

function driveCacheKey(item) {
  return `${item.path}::${item.mtime}`;
}

// Lê e cacheia (por caminho+mtime) o design de um item da lista. Tolerante a
// erro: nunca rejeita, devolve {ok:false, error} para a UI mostrar um rótulo.
function peekDriveDesign(item) {
  const key = driveCacheKey(item);
  const cached = state.drives.cache.get(key);
  if (cached) return cached;
  const pending = window.api
    .peekDesign(item.path)
    .then((res) => {
      const entry = res && res.ok ? { ok: true, design: res.design } : { ok: false, error: res && res.error };
      state.drives.cache.set(key, entry);
      return entry;
    })
    .catch((err) => {
      const entry = { ok: false, error: err.message };
      state.drives.cache.set(key, entry);
      return entry;
    });
  state.drives.cache.set(key, pending);
  return pending;
}

function drivesSideRoot(side) {
  return side === 'library' ? state.drives.libraryPath : state.drives.selectedMount;
}

function updateDriveActionButtons() {
  const hasLib = state.drives.selection.library.size > 0;
  const hasDrive = state.drives.selection.drive.size > 0;
  $('lib-copy-to-drive').disabled = !hasLib || !state.drives.selectedMount;
  $('drive-copy-to-lib').disabled = !hasDrive;
  $('drive-delete').disabled = !hasDrive;
}

function buildDriveItemRow(item, side) {
  const li = document.createElement('li');
  li.className = 'drive-item';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = state.drives.selection[side].has(item.path);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) state.drives.selection[side].add(item.path);
    else state.drives.selection[side].delete(item.path);
    updateDriveActionButtons();
  });

  const thumb = document.createElement('canvas');
  thumb.className = 'drive-thumb';

  const info = document.createElement('div');
  info.className = 'drive-item-info';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = item.name;
  const meta = document.createElement('div');
  meta.className = 'meta muted';
  meta.textContent = I18n.fmtBytesLocal(item.sizeBytes);
  info.append(name, meta);

  li.append(checkbox, thumb, info);
  li.addEventListener('dblclick', () => openDesignFromDriveManager(item.path));

  Promise.resolve(peekDriveDesign(item)).then((entry) => {
    if (entry.ok) {
      RenderCanvas.drawDesignThumbnail(thumb, entry.design);
      meta.textContent = `${I18n.fmtBytesLocal(item.sizeBytes)} · ${I18n.tr('status.stitches', { n: I18n.fmtNum(RenderCanvas.countStitches(entry.design)) })}`;
    } else {
      meta.textContent = `${I18n.fmtBytesLocal(item.sizeBytes)} · ${I18n.tr('drv.parseError')}`;
    }
  });

  return li;
}

function renderDriveList(listEl, items, side) {
  listEl.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'drive-empty';
    li.textContent = I18n.tr(side === 'library' ? 'drv.emptyLibrary' : 'drv.emptyDrive');
    listEl.appendChild(li);
    return;
  }
  for (const item of items) listEl.appendChild(buildDriveItemRow(item, side));
}

async function refreshLibraryPane() {
  const info = await window.api.libraryInfo();
  state.drives.libraryPath = info.path;
  $('library-path-label').textContent = info.path;
  const items = await window.api.scanDesigns(info.path);
  state.drives.libraryItems = items;
  renderDriveList($('library-list'), items, 'library');
  updateDriveActionButtons();
}

async function refreshDrivePane() {
  const mount = state.drives.selectedMount;
  const drive = state.drives.list.find((d) => d.mount === mount);
  $('drive-eject').disabled = !drive;
  $('drive-clean-hidden').disabled = !drive;
  if (!drive) {
    $('drive-space').textContent = '';
    $('drive-fswarn').hidden = true;
    state.drives.driveItems = [];
    state.drives.selection.drive.clear();
    renderDriveList($('drive-list'), [], 'drive');
    updateDriveActionButtons();
    return;
  }
  $('drive-space').textContent =
    drive.capacityBytes != null
      ? I18n.tr('drv.freeOf', { free: I18n.fmtBytesLocal(drive.freeBytes), total: I18n.fmtBytesLocal(drive.capacityBytes) })
      : I18n.tr('drv.unknownSpace');
  $('drive-fswarn').hidden = /fat/i.test(drive.filesystem || '');
  const items = await window.api.scanDesigns(mount);
  state.drives.driveItems = items;
  for (const p of [...state.drives.selection.drive]) {
    if (!items.some((it) => it.path === p)) state.drives.selection.drive.delete(p);
  }
  renderDriveList($('drive-list'), items, 'drive');
  updateDriveActionButtons();
}

async function refreshDriveSelectList() {
  const list = await window.api.listDrives();
  state.drives.list = list;
  const sel = $('drive-select');
  const prevMount = state.drives.selectedMount;
  sel.innerHTML = '';
  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = I18n.tr('drv.noDrive');
    sel.appendChild(opt);
    sel.disabled = true;
    state.drives.selectedMount = null;
  } else {
    sel.disabled = false;
    for (const d of list) {
      const opt = document.createElement('option');
      opt.value = d.mount;
      opt.textContent = d.name || d.mount;
      sel.appendChild(opt);
    }
    const stillThere = prevMount && list.some((d) => d.mount === prevMount);
    state.drives.selectedMount = stillThere ? prevMount : list[0].mount;
    sel.value = state.drives.selectedMount;
  }
  await refreshDrivePane();
}

async function refreshDriveSide(side) {
  if (side === 'library') await refreshLibraryPane();
  else await refreshDrivePane();
}

// Diálogo de confirmação genérico (sobrescrever/apagar), devolve true/false.
function confirmDialog({ title, message, okLabel }) {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-ok').textContent = okLabel;
    const dlg = $('dlg-confirm');
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok');
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

async function copySelectedDesigns(fromSide) {
  const toSide = fromSide === 'library' ? 'drive' : 'library';
  const sources = [...state.drives.selection[fromSide]];
  if (!sources.length) return;
  const destDir = drivesSideRoot(toSide);
  if (!destDir) {
    toast(I18n.tr('drv.noDriveSelected'), 'warn');
    return;
  }
  let results = await window.api.copyDesigns(sources, destDir, false);
  const conflicts = results.filter((r) => r.status === 'conflict');
  if (conflicts.length) {
    const ok = await confirmDialog({
      title: I18n.tr('drv.confirmOverwriteTitle'),
      message: I18n.tr('drv.confirmOverwriteMsg', { n: conflicts.length, names: conflicts.map((c) => c.name).join(', ') }),
      okLabel: I18n.tr('drv.confirmOverwriteOk'),
    });
    if (!ok) {
      const copiedCount = results.filter((r) => r.status === 'copied').length;
      toast(I18n.tr('drv.copyPartial', { n: copiedCount }));
      await refreshDriveSide(toSide);
      return;
    }
    results = await window.api.copyDesigns(sources, destDir, true);
  }
  const copiedCount = results.filter((r) => r.status === 'copied').length;
  toast(I18n.tr('drv.copyDone', { n: copiedCount }));
  await refreshDriveSide(toSide);
}

async function deleteSelectedFromDrive() {
  const sources = [...state.drives.selection.drive];
  if (!sources.length) return;
  const ok = await confirmDialog({
    title: I18n.tr('drv.confirmDeleteTitle'),
    message: I18n.tr('drv.confirmDeleteMsg', { n: sources.length }),
    okLabel: I18n.tr('drv.confirmDeleteOk'),
  });
  if (!ok) return;
  const results = await window.api.deleteFromDrive(sources, state.drives.selectedMount);
  const okCount = results.filter((r) => r.ok).length;
  toast(I18n.tr('drv.deleteDone', { n: okCount }));
  await refreshDrivePane();
}

async function ejectSelectedDrive() {
  const mount = state.drives.selectedMount;
  if (!mount) return;
  try {
    await window.api.ejectDrive(mount);
    toast(I18n.tr('drv.ejected'));
    await refreshDriveSelectList();
  } catch (err) {
    toast(I18n.tr('drv.ejectError') + err.message, 'error', 5000);
  }
}

async function cleanHiddenOnDrive() {
  const mount = state.drives.selectedMount;
  if (!mount) return;
  const count = await window.api.cleanHiddenFiles(mount);
  toast(I18n.tr('drv.cleanDone', { n: count }));
  await refreshDrivePane();
}

// Duplo clique num item (biblioteca ou pendrive): mesmo fluxo de abrir usado
// pelo menu Recentes/Finder (main emite design:opened; ver bindMenuAndKeys).
async function openDesignFromDriveManager(filePath) {
  await window.api.openFromDrive(filePath);
}

async function openDrivesDialog() {
  $('drive-clean-hidden').hidden = state.platform !== 'darwin';
  state.drives.selection.library.clear();
  state.drives.selection.drive.clear();
  $('dlg-drives').showModal();
  await Promise.all([refreshLibraryPane(), refreshDriveSelectList()]);
  if (state.drives.refreshTimer) clearInterval(state.drives.refreshTimer);
  state.drives.refreshTimer = setInterval(refreshDriveSelectList, 3000);
}

function closeDrivesDialog() {
  const dlg = $('dlg-drives');
  if (dlg.open) dlg.close();
}

function bindDrivesDialog() {
  $('btn-drives').addEventListener('click', openDrivesDialog);
  $('drives-close').addEventListener('click', closeDrivesDialog);
  $('dlg-drives').addEventListener('close', () => {
    if (state.drives.refreshTimer) {
      clearInterval(state.drives.refreshTimer);
      state.drives.refreshTimer = null;
    }
  });

  $('drive-select').addEventListener('change', async (e) => {
    state.drives.selectedMount = e.target.value || null;
    state.drives.selection.drive.clear();
    await refreshDrivePane();
  });
  $('drive-refresh').addEventListener('click', () => refreshDriveSelectList());
  $('drive-eject').addEventListener('click', ejectSelectedDrive);
  $('drive-clean-hidden').addEventListener('click', cleanHiddenOnDrive);
  $('drive-delete').addEventListener('click', deleteSelectedFromDrive);
  $('lib-copy-to-drive').addEventListener('click', () => copySelectedDesigns('library'));
  $('drive-copy-to-lib').addEventListener('click', () => copySelectedDesigns('drive'));

  $('set-librarypath-choose').addEventListener('click', async () => {
    const chosen = await window.api.chooseLibraryFolder();
    if (!chosen) return;
    state.settings.library = { path: chosen };
    $('set-librarypath').value = chosen;
  });
}

// --------------------------------------------------------------- gestão de biblioteca (issue #17)
//
// Navegador de biblioteca para catálogos grandes (10-15 mil arquivos):
// - Árvore de pastas à esquerda (carregada sob demanda, uma pasta por vez) +
//   grade com o conteúdo da pasta selecionada (requisito 1).
// - Busca por nome atravessando toda a árvore, com o caminho relativo de
//   cada resultado (requisito 2).
// - "Abrir" (menu/Cmd+O/toolbar) e "Salvar como" passam a abrir este modal
//   por padrão; os fluxos antigos (diálogo do sistema) viram os botões
//   "Abrir do computador..."/"Salvar fora..." (requisitos 3 e 4).
// - Miniaturas: reaproveita peekDriveDesign (cache por caminho+mtime, já
//   usado pelo gestor de pendrive) + drawDesignThumbnail para desenhar, com
//   um cache em disco (userData/thumbs) por trás de uma fila com throttle.
// - Grade virtualizada (só os itens visíveis são criados no DOM).

// ---- fila com throttle para geração de miniaturas (peek + desenho + cache em disco) ----
const LIB_THUMB_CONCURRENCY = 4;
let libThumbActive = 0;
const libThumbQueue = [];

function scheduleThumbJob(job) {
  return new Promise((resolve) => {
    libThumbQueue.push({ job, resolve });
    pumpThumbQueue();
  });
}

function pumpThumbQueue() {
  while (libThumbActive < LIB_THUMB_CONCURRENCY && libThumbQueue.length) {
    const { job, resolve } = libThumbQueue.shift();
    libThumbActive++;
    Promise.resolve()
      .then(job)
      .catch(() => null)
      .then((result) => {
        libThumbActive--;
        pumpThumbQueue();
        resolve(result);
      });
  }
}

function libraryThumbCacheKey(item) {
  return `${item.path}::${item.mtime}`;
}

// Cache em disco primeiro (rápido: só lê um PNG); se não houver, faz o peek
// (reaproveitando o cache de pontos do gestor de pendrive), desenha num
// canvas fora de tela com drawDesignThumbnail e grava o PNG resultante no
// cache do processo principal (invalidado por mtime — ver src/main/library.js).
async function loadOrBuildLibraryThumb(item) {
  const disk = await window.api.libraryThumbGet(item.path, item.mtime);
  if (disk) return disk;
  const peeked = await peekDriveDesign(item);
  if (!peeked.ok) return null;
  const off = document.createElement('canvas');
  RenderCanvas.drawDesignThumbnail(off, peeked.design, 84);
  const dataURL = off.toDataURL('image/png');
  window.api.libraryThumbSave(item.path, item.mtime, dataURL); // best-effort, não bloqueia a UI
  return dataURL;
}

// Cache de Image já decodificada: repintar um card que voltou à janela
// virtualizada é síncrono (sem o pisca de esperar decode/IPC a cada scroll).
const libThumbImages = new Map();
const LIB_THUMB_IMG_CAP = 4000;

function paintThumbFromImg(canvasEl, img) {
  const dpr = window.devicePixelRatio || 1;
  canvasEl.width = 84 * dpr;
  canvasEl.height = 84 * dpr;
  const c = canvasEl.getContext('2d');
  c.clearRect(0, 0, canvasEl.width, canvasEl.height);
  c.drawImage(img, 0, 0, canvasEl.width, canvasEl.height);
}

function paintLibraryThumb(canvasEl, dataURL, key) {
  let img = libThumbImages.get(key);
  if (!img) {
    img = new Image();
    img.src = dataURL;
    libThumbImages.set(key, img);
    if (libThumbImages.size > LIB_THUMB_IMG_CAP) {
      libThumbImages.delete(libThumbImages.keys().next().value); // descarta o mais antigo
    }
  }
  if (img.complete) {
    paintThumbFromImg(canvasEl, img);
  } else {
    img.addEventListener(
      'load',
      () => {
        if (canvasEl.isConnected) paintThumbFromImg(canvasEl, img);
      },
      { once: true }
    );
  }
}

function ensureLibraryThumb(canvasEl, item) {
  const key = libraryThumbCacheKey(item);
  const cachedImg = libThumbImages.get(key);
  if (cachedImg && cachedImg.complete) {
    paintThumbFromImg(canvasEl, cachedImg); // caminho síncrono: sem pisca no scroll
    return;
  }
  let entry = state.library.thumbCache.get(key);
  if (!entry) {
    entry = scheduleThumbJob(() => loadOrBuildLibraryThumb(item));
    state.library.thumbCache.set(key, entry);
  }
  entry.then((dataURL) => {
    if (dataURL) paintLibraryThumb(canvasEl, dataURL, key);
  });
}

// ---- prévia grande no hover (arte + pontos + cores + tempo estimado) ----

const libHover = { timer: null, item: null };
const LIB_HOVER_DELAY = 260;

function hideLibHover() {
  clearTimeout(libHover.timer);
  libHover.item = null;
  const pop = document.getElementById('lib-hover');
  if (pop) pop.hidden = true;
}

function showLibHover(item, cardEl) {
  Promise.resolve(peekDriveDesign(item)).then((entry) => {
    if (libHover.item !== item || !entry.ok || !cardEl.isConnected) return;
    const design = entry.design;
    const pop = $('lib-hover');
    pop.hidden = false;
    RenderCanvas.drawDesignInto($('lib-hover-cv'), design, 310, 280, 12, { autoBg: true });
    $('lib-hover-name').textContent = item.name;
    const b = RenderCanvas.designBounds(design);
    const wMm = isFinite(b.minX) ? (b.maxX - b.minX) / 10 : 0;
    const hMm = isFinite(b.minY) ? (b.maxY - b.minY) / 10 : 0;
    let changes = 0;
    for (const st of design.stitches) {
      if ((st[2] & COMMAND_MASK) === COLOR_CHANGE) changes++;
    }
    const n = RenderCanvas.countStitches(design);
    $('lib-hover-line').textContent =
      `${wMm.toFixed(1)} × ${hMm.toFixed(1)} mm · ` +
      I18n.tr('status.stitches', { n: I18n.fmtNum(n) }) +
      ' · ' +
      I18n.tr('lib.hoverColors', { c: design.threads.length }) +
      ' · ' +
      I18n.tr('lib.hoverTime', { t: SewTime.fmtSewTime(n, changes, state.settings.machine.speedSpm) });
    const colors = $('lib-hover-colors');
    colors.innerHTML = '';
    design.threads.slice(0, 16).forEach((t, i) => {
      const sw = document.createElement('span');
      sw.style.background = RenderCanvas.designThreadColor(design, i);
      colors.appendChild(sw);
    });
    // À direita do card; sem espaço, vai para a esquerda; sempre dentro da
    // janela — clamp em src/core/viewportclamp.js (issue #38: media o
    // tamanho real do card com offsetWidth/offsetHeight em vez de supor
    // 334px fixos, que podiam vazar perto das bordas).
    const r = cardEl.getBoundingClientRect();
    const { left, top } = ViewportClamp.clampToViewport(
      r,
      { width: pop.offsetWidth || 334, height: pop.offsetHeight || 380 },
      { width: window.innerWidth, height: window.innerHeight }
    );
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  });
}

// ---- árvore de pastas (carregamento preguiçoso, reaproveitada pelo picker de mover) ----

// relPath vem do processo principal com separador nativo do SO (path.join);
// para achar a pasta-mãe (mostrada como caminho relativo nos resultados de
// busca) não dá pra usar o módulo 'path' (preload sandboxed não expõe Node
// ao renderer), daí este pequeno helper.
function libRelDirParent(relPath) {
  const idx = Math.max(relPath.lastIndexOf('/'), relPath.lastIndexOf('\\'));
  return idx === -1 ? '' : relPath.slice(0, idx);
}

// opts: { expanded: Set, childrenCache: Map, selectedRelDir, onSelect(relDir), rerender() }
async function renderLibraryTree(containerEl, opts) {
  containerEl.innerHTML = '';
  containerEl.appendChild(buildLibTreeRow('', I18n.tr('lib.root'), 0, opts));
  if (opts.expanded.has('')) {
    const wrap = document.createElement('div');
    wrap.className = 'lib-tree-children';
    containerEl.appendChild(wrap);
    await renderLibTreeChildrenInto(wrap, '', 1, opts);
  }
}

async function renderLibTreeChildrenInto(containerEl, relDir, depth, opts) {
  let subs = opts.childrenCache.get(relDir);
  if (subs === undefined) {
    containerEl.innerHTML = `<div class="lib-tree-empty">${I18n.tr('lib.loadingFolders')}</div>`;
    subs = await window.api.libraryListSubfolders(relDir);
    opts.childrenCache.set(relDir, subs);
  }
  containerEl.innerHTML = '';
  if (!subs.length) return; // pasta-folha: nada a listar (o caret nem aparece)
  for (const sub of subs) {
    containerEl.appendChild(buildLibTreeRow(sub.relDir, sub.name, depth, opts, sub.hasChildren !== false));
    if (opts.expanded.has(sub.relDir)) {
      const wrap = document.createElement('div');
      wrap.className = 'lib-tree-children';
      containerEl.appendChild(wrap);
      await renderLibTreeChildrenInto(wrap, sub.relDir, depth + 1, opts);
    }
  }
}

function buildLibTreeRow(relDir, label, depth, opts, hasChildren = true) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lib-tree-node' + (relDir === opts.selectedRelDir ? ' selected' : '');
  btn.style.paddingLeft = 8 + depth * 14 + 'px';
  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  if (!hasChildren) {
    twisty.classList.add('leaf'); // mantém o alinhamento, sem caret nem clique
    twisty.textContent = '';
  } else {
    twisty.textContent = opts.expanded.has(relDir) ? '▾' : '▸';
    twisty.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (opts.expanded.has(relDir)) opts.expanded.delete(relDir);
      else opts.expanded.add(relDir);
      await opts.rerender();
    });
  }
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = label;
  btn.append(twisty, name);
  btn.addEventListener('click', () => opts.onSelect(relDir));
  return btn;
}

function invalidateLibraryTreeCache() {
  state.library.treeChildren.clear();
  state.library.moveTreeChildren.clear();
}

const mainLibTreeOpts = {
  expanded: state.library.treeExpanded,
  childrenCache: state.library.treeChildren,
  get selectedRelDir() {
    return state.library.currentRelDir;
  },
  onSelect: async (relDir) => {
    state.library.treeExpanded.add(relDir);
    state.library.currentRelDir = relDir;
    $('lib-search').value = '';
    state.library.searching = false;
    await renderLibraryTree($('lib-tree'), mainLibTreeOpts);
    await loadLibraryFolder();
    if (state.library.mode === 'save') updateLibrarySaveTarget();
  },
  rerender: () => renderLibraryTree($('lib-tree'), mainLibTreeOpts),
};

const moveLibTreeOpts = {
  expanded: state.library.moveTreeExpanded,
  childrenCache: state.library.moveTreeChildren,
  get selectedRelDir() {
    return state.library.moveChosenRelDir;
  },
  onSelect: async (relDir) => {
    state.library.moveTreeExpanded.add(relDir);
    state.library.moveChosenRelDir = relDir;
    await renderLibraryTree($('lib-move-tree'), moveLibTreeOpts);
  },
  rerender: () => renderLibraryTree($('lib-move-tree'), moveLibTreeOpts),
};

// ---- carregar pasta / busca ----

async function loadLibraryFolder() {
  const token = ++state.library.loadToken;
  const relDir = state.library.currentRelDir;
  const t0 = performance.now();
  const { files } = await window.api.libraryListFolder(relDir);
  if (token !== state.library.loadToken) return;
  console.log(`[perf] library folder listed: ${files.length} items in ${(performance.now() - t0).toFixed(0)}ms`);
  state.library.searching = false;
  state.library.truncated = false;
  await setLibraryBaseItems(files);
}

async function runLibrarySearch(query) {
  const token = ++state.library.loadToken;
  state.library.searching = true;
  const t0 = performance.now();
  const { items, truncated } = await window.api.librarySearch(query);
  if (token !== state.library.loadToken) return;
  console.log(`[perf] library search: ${items.length} items in ${(performance.now() - t0).toFixed(0)}ms (truncated=${truncated})`);
  state.library.truncated = truncated;
  await setLibraryBaseItems(items);
}

async function setLibraryBaseItems(rawItems) {
  state.library.baseItems = rawItems;
  await applyLibraryFilters();
  startLibraryIndexing(rawItems);
}

// ---- varredura incremental com progresso (issue #35) ----
//
// Metadados de dimensão/pontos (usados pelos filtros abaixo) vêm de um
// índice persistido no processo principal (src/main/library.js), preenchido
// em lotes de LIB_INDEX_BATCH_SIZE sem travar o modal: cada lote é um IPC
// (o loop entre lotes cede o laço de eventos naturalmente, por ser
// assíncrono) que atualiza um contador "indexando N de M" na UI enquanto
// roda. Pastas/buscas já vistas antes — mesmo em sessões anteriores, pelo
// índice persistido em disco — resolvem quase de imediato: cada lote só
// consulta o índice, sem reabrir nenhum arquivo.
const LIB_INDEX_BATCH_SIZE = 200;
const LIB_INDEX_SHOW_DELAY = 300; // só mostra a barra se não terminar rápido (evita pisca em pastas pequenas)

function libraryIndexKey(item) {
  return item.path; // consultado por caminho absoluto, igual ao índice do processo principal
}

function libraryHasNumericFilter() {
  const f = state.library.filters;
  return f.minW != null || f.maxW != null || f.minH != null || f.maxH != null || f.minS != null || f.maxS != null;
}

function updateIndexingUI() {
  const p = state.library.indexProgress;
  const el = $('lib-indexing');
  if (!p.active) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  $('lib-indexing-fill').style.width = (p.total ? Math.round((p.done / p.total) * 100) : 100) + '%';
  $('lib-indexing-label').textContent = I18n.tr('lib.indexing', { n: I18n.fmtNum(p.done), m: I18n.fmtNum(p.total) });
}

// Quem espera a varredura ficar ociosa (usado só pelo benchmark de rolagem,
// --library-bench-scroll: espera a indexação terminar antes de medir, pra
// não misturar o custo de indexar com o custo de rolar).
function resolveLibraryIndexIdle() {
  const waiters = state.library.indexIdleWaiters;
  state.library.indexIdleWaiters = [];
  for (const resolve of waiters) resolve();
}

function waitForLibraryIndexIdle() {
  if (!state.library.indexProgress.active) return Promise.resolve();
  return new Promise((resolve) => state.library.indexIdleWaiters.push(resolve));
}

// Dispara a varredura em segundo plano para o conjunto de itens atual
// (pasta ou busca). Cancelável: se a pasta/busca trocar no meio (loadToken
// muda), os lotes ainda em voo são descartados ao voltar do IPC, sem
// reaproveitar nem persistir progresso da corrida anterior.
function startLibraryIndexing(items) {
  const token = state.library.loadToken;
  const startedAt = performance.now();
  clearTimeout(state.library.indexShowTimer);

  if (!items.length) {
    state.library.indexProgress = { active: false, done: 0, total: 0 };
    updateIndexingUI();
    resolveLibraryIndexIdle();
    return;
  }

  state.library.indexProgress = { active: true, done: 0, total: items.length };
  state.library.indexShowTimer = setTimeout(updateIndexingUI, LIB_INDEX_SHOW_DELAY);

  (async () => {
    for (let i = 0; i < items.length; i += LIB_INDEX_BATCH_SIZE) {
      if (token !== state.library.loadToken) return; // pasta/busca trocou: para aqui, sem tocar no progresso novo
      const slice = items.slice(i, i + LIB_INDEX_BATCH_SIZE);
      const results = await window.api.libraryIndexBatch(slice.map((it) => ({ path: it.path, mtime: it.mtime })));
      if (token !== state.library.loadToken) return;
      for (const r of results) state.library.indexData.set(r.path, r);
      state.library.indexProgress.done = Math.min(items.length, i + slice.length);
      updateIndexingUI();
      // Só reaplica os filtros lote a lote se um filtro numérico estiver
      // ativo (é o único caso em que o resultado exibido depende do índice
      // ainda incompleto) — evita trabalho à toa numa busca/pasta sem filtro.
      if (libraryHasNumericFilter()) applyLibraryFilters();
    }
    if (token === state.library.loadToken) {
      clearTimeout(state.library.indexShowTimer);
      state.library.indexProgress.active = false;
      updateIndexingUI();
      console.log(`[perf] library index complete: ${items.length} items in ${(performance.now() - startedAt).toFixed(0)}ms`);
      resolveLibraryIndexIdle();
    }
  })();
}

function scheduleLibrarySearch() {
  clearTimeout(state.library.searchDebounce);
  state.library.searchDebounce = setTimeout(async () => {
    const q = $('lib-search').value.trim();
    if (q) await runLibrarySearch(q);
    else await loadLibraryFolder();
  }, 180);
}

async function reloadLibraryView() {
  invalidateLibraryTreeCache();
  await renderLibraryTree($('lib-tree'), mainLibTreeOpts);
  const q = $('lib-search').value.trim();
  if (q) await runLibrarySearch(q);
  else await loadLibraryFolder();
}

// ---- filtros (formato instantâneo; dimensões/pontos exigem peek do conjunto atual) ----

function readLibraryFiltersFromForm() {
  const num = (id) => {
    const v = $(id).value;
    return v === '' ? null : Number(v);
  };
  state.library.filters = {
    format: $('lib-filter-format').value,
    minW: num('lib-filter-minw'),
    maxW: num('lib-filter-maxw'),
    minH: num('lib-filter-minh'),
    maxH: num('lib-filter-maxh'),
    minS: num('lib-filter-mins'),
    maxS: num('lib-filter-maxs'),
    favoritesOnly: $('lib-filter-favorites').checked,
  };
}

function scheduleLibraryFilterChange() {
  readLibraryFiltersFromForm();
  clearTimeout(state.library.filterDebounce);
  state.library.filterDebounce = setTimeout(applyLibraryFilters, 250);
}

function clearLibraryFilters() {
  $('lib-filter-format').value = '';
  $('lib-filter-minw').value = '';
  $('lib-filter-maxw').value = '';
  $('lib-filter-minh').value = '';
  $('lib-filter-maxh').value = '';
  $('lib-filter-mins').value = '';
  $('lib-filter-maxs').value = '';
  $('lib-filter-favorites').checked = false;
  scheduleLibraryFilterChange();
}

// Filtros de dimensão/pontos usam o índice persistido (state.library.indexData,
// preenchido por startLibraryIndexing) em vez de espiar cada item do
// conjunto visível: com 10-15 mil arquivos numa pasta só, espiar (parsear) um
// por um a cada tecla no filtro travaria o modal por segundos (issue #35).
// Item ainda sem entrada fresca no índice (varredura em andamento, ou
// arquivo corrompido) fica de fora por ora — reaparece sozinho quando o
// lote correspondente da varredura chegar (startLibraryIndexing reaplica os
// filtros a cada lote enquanto algum filtro numérico estiver ativo).
function applyLibraryFilters() {
  const f = state.library.filters;
  let items = state.library.baseItems;
  if (f.format) items = items.filter((it) => it.ext === f.format);
  if (f.favoritesOnly) items = items.filter((it) => state.library.favorites.has(it.path));

  if (libraryHasNumericFilter()) {
    items = items.filter((it) => {
      const entry = state.library.indexData.get(libraryIndexKey(it));
      if (!entry || !entry.ok) return false;
      if (f.minW != null && entry.wMm < f.minW) return false;
      if (f.maxW != null && entry.wMm > f.maxW) return false;
      if (f.minH != null && entry.hMm < f.minH) return false;
      if (f.maxH != null && entry.hMm > f.maxH) return false;
      if (f.minS != null && entry.stitches < f.minS) return false;
      if (f.maxS != null && entry.stitches > f.maxS) return false;
      return true;
    });
  }

  state.library.items = items;
  updateLibraryEmptyState();
  requestLibraryGridRender();
}

function updateLibraryEmptyState() {
  const empty = state.library.items.length === 0;
  $('lib-empty').hidden = !empty;
  $('lib-empty').textContent = state.library.searching ? I18n.tr('lib.emptySearch') : I18n.tr('lib.empty');
  $('lib-truncated').hidden = !state.library.truncated;
}

// ---- grade virtualizada ----

const LIB_ITEM_WIDTH = 108;
const LIB_ITEM_HEIGHT = 172;
const LIB_GRID_GAP = 10;
const LIB_BUFFER_ROWS = 2;

function libraryGridCols() {
  const viewport = $('lib-grid-viewport');
  return LibraryView.computeCols(viewport.clientWidth, LIB_ITEM_WIDTH, LIB_GRID_GAP, 20);
}

// Grade virtualizada: só as células visíveis (+ LIB_BUFFER_ROWS de margem)
// ganham nó no DOM — o resto vive só na altura do "spacer", que mantém a
// barra de rolagem do tamanho certo. O cálculo em si (linha/índice visível a
// partir do scrollTop) é puro e mora em src/core/library-view.js, testado
// isoladamente com até 15 mil itens (issue #35).
function renderLibraryGrid() {
  const viewport = $('lib-grid-viewport');
  const items = state.library.items;
  const cols = libraryGridCols();
  const rowHeight = LIB_ITEM_HEIGHT + LIB_GRID_GAP;
  const range = LibraryView.computeVisibleRange({
    scrollTop: viewport.scrollTop,
    viewHeight: viewport.clientHeight,
    rowHeight,
    cols,
    itemCount: items.length,
    bufferRows: LIB_BUFFER_ROWS,
  });
  $('lib-grid-spacer').style.height = Math.max(range.rows * rowHeight, 1) + 'px';

  const inner = $('lib-grid-inner');
  inner.style.gridTemplateColumns = `repeat(${cols}, ${LIB_ITEM_WIDTH}px)`;
  inner.style.gap = LIB_GRID_GAP + 'px';

  inner.style.transform = `translateY(${range.firstRow * rowHeight}px)`;
  inner.innerHTML = '';
  for (let r = range.firstRow; r <= range.lastRow; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (idx >= items.length) continue;
      inner.appendChild(buildLibraryGridItem(items[idx]));
    }
  }
}

let libGridRenderQueued = false;
function requestLibraryGridRender() {
  if (libGridRenderQueued) return;
  libGridRenderQueued = true;
  requestAnimationFrame(() => {
    libGridRenderQueued = false;
    renderLibraryGrid();
  });
}

// ---- benchmark de rolagem (issue #35, só medição de desempenho) ----
//
// Só roda com --library-bench-scroll=ms (ver boot()): varre a grade da
// biblioteca de ponta a ponta por "durationMs", medindo o tempo entre
// quadros (rAF a rAF) — a mesma métrica usada na meta de aceite da issue
// (nenhuma interação deve travar por mais de 100ms). Por padrão espera a
// varredura incremental ficar ociosa antes de começar (mede o estado
// estável, pós-indexação — o cenário da meta de aceite); com
// --library-bench-scroll-immediate=1 pula essa espera e mede rolando com a
// indexação em segundo plano ainda a todo vapor (o caso de alguém que já
// começa a rolar antes da primeira varredura terminar). Resultado sai por
// console.log (repassado ao stdout do smoke test pelo forward de
// console-message em main.js).
async function runLibraryScrollBenchmark(durationMs, immediate) {
  if (!immediate) await waitForLibraryIndexIdle();
  const viewport = $('lib-grid-viewport');
  const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const frames = [];
  const start = performance.now();
  let last = start;
  let pos = 0;

  await new Promise((resolve) => {
    function step() {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (now - start >= durationMs) {
        resolve();
        return;
      }
      pos = (pos + 22) % (maxScroll || 1); // varre a lista de ponta a ponta e recomeça
      viewport.scrollTop = pos;
      requestAnimationFrame(step);
    }
    requestAnimationFrame(() => {
      last = performance.now();
      requestAnimationFrame(step);
    });
  });

  frames.shift(); // 1º delta é o tempo até o primeiro rAF, não um frame de rolagem
  const n = frames.length || 1;
  const avg = frames.reduce((a, b) => a + b, 0) / n;
  const max = Math.max(...frames, 0);
  const over100 = frames.filter((f) => f > 100).length;
  const sorted = [...frames].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
  console.log(
    `[perf-scroll] frames=${frames.length} avgMs=${avg.toFixed(2)} p95Ms=${p95.toFixed(2)} maxMs=${max.toFixed(2)} over100ms=${over100} maxScroll=${maxScroll}`
  );
}

function buildLibAct(glyph, title, onClick, danger) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lib-act' + (danger ? ' danger' : '');
  btn.textContent = glyph;
  btn.title = title;
  btn.setAttribute('aria-label', title); // issue #38: botão só-ícone (glifo), sem texto visível
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function buildLibraryGridItem(item) {
  const el = document.createElement('div');
  el.className = 'lib-item';

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'lib-item-thumb-wrap';
  const thumb = document.createElement('canvas');
  thumb.className = 'lib-item-thumb';
  const isFav = state.library.favorites.has(item.path);
  const favBtn = document.createElement('button');
  favBtn.type = 'button';
  favBtn.className = 'lib-fav-btn' + (isFav ? ' active' : '');
  favBtn.textContent = isFav ? '★' : '☆';
  favBtn.title = I18n.tr('lib.actionFavorite');
  favBtn.setAttribute('aria-label', favBtn.title); // issue #38: botão só-ícone (★/☆), sem texto visível
  favBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLibraryFavorite(item);
  });
  thumbWrap.append(thumb, favBtn);

  const name = document.createElement('div');
  name.className = 'lib-item-name';
  name.textContent = item.name;
  name.title = item.name;

  const meta = document.createElement('div');
  meta.className = 'lib-item-meta';
  meta.textContent = state.library.searching ? libRelDirParent(item.relPath) || I18n.tr('lib.root') : I18n.fmtBytesLocal(item.sizeBytes);
  meta.title = meta.textContent;

  el.append(thumbWrap, name, meta);

  el.addEventListener('mouseenter', () => {
    clearTimeout(libHover.timer);
    libHover.item = item;
    libHover.timer = setTimeout(() => showLibHover(item, el), LIB_HOVER_DELAY);
  });
  el.addEventListener('mouseleave', hideLibHover);

  if (!state.library.searching) {
    Promise.resolve(peekDriveDesign(item)).then((entry) => {
      if (!el.isConnected) return;
      meta.textContent = entry.ok
        ? `${I18n.fmtBytesLocal(item.sizeBytes)} · ${I18n.tr('status.stitches', { n: I18n.fmtNum(RenderCanvas.countStitches(entry.design)) })}`
        : `${I18n.fmtBytesLocal(item.sizeBytes)} · ${I18n.tr('drv.parseError')}`;
      meta.title = meta.textContent;
    });
  }

  if (state.library.mode === 'open') {
    const actions = document.createElement('div');
    actions.className = 'lib-item-actions';
    actions.append(
      buildLibAct('▶', I18n.tr('lib.actionOpen'), () => openLibraryItem(item)),
      buildLibAct('⌂', I18n.tr('lib.actionReveal'), () => window.api.showItemInFolder(item.path)),
      buildLibAct('→', I18n.tr('lib.actionDrive'), () => copyLibraryItemToDrive(item)),
      buildLibAct('✎', I18n.tr('lib.actionRename'), () => openLibraryRename(item)),
      buildLibAct('⇒', I18n.tr('lib.actionMove'), () => openLibraryMove(item)),
      buildLibAct('✕', I18n.tr('lib.actionDelete'), () => deleteLibraryItem(item), true)
    );
    el.appendChild(actions);
    el.addEventListener('dblclick', () => openLibraryItem(item));
  } else {
    el.addEventListener('click', () => {
      const base = item.name.replace(/\.[^.]+$/, '');
      $('lib-save-name').value = base;
      const options = [...$('lib-save-format').options];
      if (options.some((o) => o.value === item.ext)) $('lib-save-format').value = item.ext;
    });
  }

  ensureLibraryThumb(thumb, item);
  return el;
}

// ---- ações por item ----

async function openLibraryItem(item) {
  await window.api.openFromDrive(item.path); // emite design:opened (mesmo canal do resto do app)
}

async function toggleLibraryFavorite(item) {
  const list = await window.api.libraryFavoriteToggle(item.path);
  state.library.favorites = new Set(list);
  // Reaplica os filtros (não só repinta a grade): com "Favoritos" marcado,
  // desmarcar a estrela de um item precisa tirá-lo da lista exibida.
  await applyLibraryFilters();
}

async function copyLibraryItemToDrive(item) {
  const mount = state.library.selectedDriveMount;
  if (!mount) {
    toast(I18n.tr('lib.toastNoDrive'), 'warn');
    return;
  }
  let results = await window.api.copyDesigns([item.path], mount, false);
  if (results[0].status === 'conflict') {
    const ok = await confirmDialog({
      title: I18n.tr('drv.confirmOverwriteTitle'),
      message: I18n.tr('drv.confirmOverwriteMsg', { n: 1, names: item.name }),
      okLabel: I18n.tr('drv.confirmOverwriteOk'),
    });
    if (!ok) return;
    results = await window.api.copyDesigns([item.path], mount, true);
  }
  if (results[0].status === 'copied') toast(I18n.tr('lib.toastCopiedToDrive', { name: item.name }));
  else if (results[0].status === 'error') toast(I18n.tr('lib.toastCopyError') + results[0].error, 'error', 5000);
}

async function deleteLibraryItem(item) {
  const ok = await confirmDialog({
    title: I18n.tr('lib.confirmDeleteTitle'),
    message: I18n.tr('lib.confirmDeleteMsg', { name: item.name }),
    okLabel: I18n.tr('lib.confirmDeleteOk'),
  });
  if (!ok) return;
  try {
    await window.api.libraryTrash(item.path);
    toast(I18n.tr('lib.toastDeleted', { name: item.name }));
    await reloadLibraryView();
  } catch (err) {
    toast(I18n.tr('lib.toastDeleteError') + err.message, 'error', 5000);
  }
}

function openLibraryRename(item) {
  state.library.renameTarget = item;
  $('lib-rename-current').textContent = item.relPath || item.name;
  $('lib-rename-input').value = item.name;
  $('dlg-lib-rename').showModal();
  $('lib-rename-input').focus();
  $('lib-rename-input').select();
}

async function confirmLibraryRename() {
  const item = state.library.renameTarget;
  if (!item) return;
  const newName = $('lib-rename-input').value.trim();
  if (!newName || newName === item.name) return;
  try {
    await window.api.libraryRename(item.path, newName);
    toast(I18n.tr('lib.toastRenamed', { name: newName }));
    await reloadLibraryView();
  } catch (err) {
    toast(I18n.tr('lib.toastRenameError') + err.message, 'error', 5000);
  }
}

async function openLibraryMove(item) {
  state.library.moveTarget = item;
  state.library.moveChosenRelDir = libRelDirParent(item.relPath);
  $('lib-move-current').textContent = item.relPath || item.name;
  $('dlg-lib-move').showModal();
  await renderLibraryTree($('lib-move-tree'), moveLibTreeOpts);
}

async function confirmLibraryMove() {
  const item = state.library.moveTarget;
  if (!item) return;
  try {
    await window.api.libraryMove(item.path, state.library.moveChosenRelDir);
    toast(I18n.tr('lib.toastMoved', { name: item.name }));
    $('dlg-lib-move').close();
    await reloadLibraryView();
  } catch (err) {
    toast(I18n.tr('lib.toastMoveError') + err.message, 'error', 5000);
  }
}

// ---- pendrive (dropdown local, independente do modal de gestão de pendrive) ----

async function refreshLibraryDriveSelect() {
  const list = await window.api.listDrives();
  state.library.drives = list;
  const sel = $('lib-drive-select');
  const prevMount = state.library.selectedDriveMount;
  sel.innerHTML = '';
  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = I18n.tr('lib.noDriveOption');
    sel.appendChild(opt);
    sel.disabled = true;
    state.library.selectedDriveMount = null;
    return;
  }
  sel.disabled = false;
  for (const d of list) {
    const opt = document.createElement('option');
    opt.value = d.mount;
    opt.textContent = d.name || d.mount;
    sel.appendChild(opt);
  }
  const stillThere = prevMount && list.some((d) => d.mount === prevMount);
  state.library.selectedDriveMount = stillThere ? prevMount : list[0].mount;
  sel.value = state.library.selectedDriveMount;
}

// ---- abrir modal (modo "abrir" ou "salvar") ----

function populateLibraryFormatFilterSelect() {
  const sel = $('lib-filter-format');
  sel.innerHTML = '';
  const first = document.createElement('option');
  first.value = '';
  first.textContent = I18n.tr('lib.filterFormatAll');
  sel.appendChild(first);
  // Formatos suportados para leitura (core/io não é acessível no renderer
  // sandboxed; mesma lista usada pelos filtros do diálogo "Abrir" no main).
  for (const ext of ['xxx', 'dst', 'pes', 'pec', 'jef', 'exp']) {
    const opt = document.createElement('option');
    opt.value = ext;
    opt.textContent = ext.toUpperCase();
    sel.appendChild(opt);
  }
}

function populateLibrarySaveFormatSelect() {
  const sel = $('lib-save-format');
  if (sel.options.length) return; // lista estática (extensões graváveis): só precisa popular uma vez
  for (const ext of ['xxx', 'dst', 'pes', 'pec', 'jef', 'exp', 'svg']) {
    const opt = document.createElement('option');
    opt.value = ext;
    opt.textContent = ext.toUpperCase();
    sel.appendChild(opt);
  }
}

function updateLibrarySaveTarget() {
  const relDir = state.library.currentRelDir;
  $('lib-save-target').textContent = relDir ? relDir : I18n.tr('lib.root');
}

function closeLibraryDialog() {
  const dlg = $('dlg-library');
  if (dlg.open) dlg.close();
}

async function openLibraryCommon() {
  const rootInfo = await window.api.libraryRoot();
  state.library.root = rootInfo.path;
  state.library.currentRelDir = '';
  const favs = await window.api.libraryFavoritesList();
  state.library.favorites = new Set(favs);
  $('lib-search').value = '';
  state.library.searching = false;
  invalidateLibraryTreeCache();
  await renderLibraryTree($('lib-tree'), mainLibTreeOpts);
  await loadLibraryFolder();
  await refreshLibraryDriveSelect();
  if (state.library.driveRefreshTimer) clearInterval(state.library.driveRefreshTimer);
  state.library.driveRefreshTimer = setInterval(refreshLibraryDriveSelect, 4000);
  $('dlg-library').showModal();
}

async function openLibraryDialog() {
  state.library.mode = 'open';
  $('dlg-library').classList.remove('mode-save');
  $('library-title').textContent = I18n.tr('lib.titleOpen');
  $('lib-footer-open').hidden = false;
  $('lib-footer-save').hidden = true;
  populateLibraryFormatFilterSelect();
  await openLibraryCommon();
}

async function openLibrarySaveDialog() {
  state.library.mode = 'save';
  $('dlg-library').classList.add('mode-save');
  $('library-title').textContent = I18n.tr('lib.titleSave');
  $('lib-footer-open').hidden = true;
  $('lib-footer-save').hidden = false;
  populateLibraryFormatFilterSelect();
  populateLibrarySaveFormatSelect();
  const base = (state.design && state.design.name ? state.design.name : 'matriz').replace(/\.[^.]+$/, '');
  $('lib-save-name').value = base;
  const currentExt = state.design && state.design.format ? state.design.format : 'xxx';
  if ([...$('lib-save-format').options].some((o) => o.value === currentExt)) $('lib-save-format').value = currentExt;
  await openLibraryCommon();
  updateLibrarySaveTarget();
}

async function confirmLibrarySave() {
  if (!state.design) return;
  const nameRaw = $('lib-save-name').value.trim();
  if (!nameRaw) {
    toast(I18n.tr('lib.toastNameRequired'), 'warn');
    return;
  }
  const ext = $('lib-save-format').value;
  const fileName = nameRaw.toLowerCase().endsWith('.' + ext) ? nameRaw : `${nameRaw}.${ext}`;
  try {
    const result = await window.api.libraryWriteDesign(state.library.currentRelDir, fileName, {
      stitches: state.design.stitches,
      threads: state.design.threads,
      metadata: state.design.metadata || {},
    });
    state.dirty = false;
    state.design.path = result.path;
    state.design.format = result.format;
    state.design.name = fileName;
    updateStatusbar();
    document.title = state.design.name + ' — Bastidor';
    toast(I18n.tr('lib.toastSaved', { name: fileName }));
    closeLibraryDialog();
  } catch (err) {
    toast(I18n.tr('lib.toastSaveError') + err.message, 'error', 5000);
  }
}

function bindLibraryDialog() {
  $('library-close').addEventListener('click', closeLibraryDialog);
  $('dlg-library').addEventListener('close', () => {
    hideLibHover();
    if (state.library.driveRefreshTimer) {
      clearInterval(state.library.driveRefreshTimer);
      state.library.driveRefreshTimer = null;
    }
    // Fechar o modal invalida o loadToken: a varredura em segundo plano
    // (startLibraryIndexing) para no próximo lote, em vez de continuar
    // batendo IPC por uma pasta que ninguém está mais olhando.
    state.library.loadToken++;
    clearTimeout(state.library.indexShowTimer);
    state.library.indexProgress = { active: false, done: 0, total: 0 };
    resolveLibraryIndexIdle();
  });

  $('lib-search').addEventListener('input', scheduleLibrarySearch);
  $('lib-filter-format').addEventListener('change', scheduleLibraryFilterChange);
  for (const id of ['lib-filter-minw', 'lib-filter-maxw', 'lib-filter-minh', 'lib-filter-maxh', 'lib-filter-mins', 'lib-filter-maxs']) {
    $(id).addEventListener('input', scheduleLibraryFilterChange);
  }
  $('lib-filter-favorites').addEventListener('change', scheduleLibraryFilterChange);
  $('lib-filter-clear').addEventListener('click', clearLibraryFilters);
  $('lib-drive-select').addEventListener('change', (e) => {
    state.library.selectedDriveMount = e.target.value || null;
  });

  $('lib-grid-viewport').addEventListener('scroll', requestLibraryGridRender);
  $('lib-grid-viewport').addEventListener('scroll', hideLibHover);
  new ResizeObserver(requestLibraryGridRender).observe($('lib-grid-viewport'));

  $('lib-open-external').addEventListener('click', openViaDialogExternal);
  $('lib-save-external').addEventListener('click', async () => {
    closeLibraryDialog();
    await saveAsExternal();
  });
  $('lib-save-confirm').addEventListener('click', confirmLibrarySave);

  $('lib-rename-form').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'ok') confirmLibraryRename();
  });

  $('lib-move-cancel').addEventListener('click', () => $('dlg-lib-move').close());
  $('lib-move-confirm').addEventListener('click', confirmLibraryMove);
}

// --------------------------------------------------------------- lettering (texto)
// Ferramenta "Texto" (issue #7, fase 1): a fonte, o layout e a geração de
// pontos rodam no núcleo, no processo principal (src/core/lettering); aqui
// só populamos o formulário, pedimos a pré-visualização (debounced) e, ao
// inserir, emendamos o Pattern resultante no design atual (ou criamos um
// design novo, se não houver nenhum aberto).

// Rótulo do tipo de fonte no seletor (issue #20): "Nome · tipo", sem
// travessão, separador "·" (convenção do app).
const FONT_TYPE_LABEL_KEY = { stroke: 'text.typeStroke', inkstitch: 'text.typeInkstitch', ttf: 'text.typeTtf' };

function populateTextFontSelect() {
  const sel = $('text-font');
  const previous = sel.value;
  sel.innerHTML = '';
  for (const f of state.lettering.fonts) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.label + ' · ' + I18n.tr(FONT_TYPE_LABEL_KEY[f.type] || 'text.typeStroke');
    sel.appendChild(opt);
  }
  if (previous && state.lettering.fonts.some((f) => f.id === previous)) {
    sel.value = previous; // preserva a seleção ao repopular (ex.: depois de "adicionar fonte…")
  } else {
    const hershey = state.lettering.fonts.find((f) => f.id.includes('Hershey'));
    if (hershey) sel.value = hershey.id;
  }
}

function currentFontType() {
  const id = $('text-font').value;
  const font = state.lettering.fonts.find((f) => f.id === id);
  return font ? font.type : 'stroke';
}

function readTextFormOpts() {
  return {
    fontId: $('text-font').value,
    text: $('text-input').value,
    heightMm: clampNum($('text-height').value, 2, 200, 10),
    letterSpacing: clampNum($('text-letterspacing').value, -20, 300, 0),
    lineSpacing: clampNum($('text-linespacing').value, -20, 300, 0),
    stitchLengthMm: clampNum($('text-stitchlen').value, 0.5, 6, 2),
    finish: $('text-finish').value,
    satinWidthMm: clampNum($('text-satinwidth').value, 0.8, 5, 2),
    satinDensityMm: clampNum($('text-satindensity').value, 0.2, 1.5, 0.4),
    underlay: $('text-underlay').checked,
    fillSpacingMm: clampNum($('text-fillspacing').value, 0.2, 2, 0.4),
    fillAngleDeg: clampNum($('text-fillangle').value, -90, 90, 0),
    fillStitchMm: clampNum($('text-fillstitch').value, 1, 6, 3),
    outline: $('text-outline').checked,
    outlineStitchMm: clampNum($('text-outlinestitch').value, 0.5, 6, 2.5),
  };
}

// Os parâmetros mostrados se adaptam ao TIPO de fonte selecionada (issue
// #20: traço único/Ink/Stitch mostram ponto corrido/bean/satin; TTF mostra
// preenchimento) e, dentro do primeiro grupo, ao acabamento escolhido (os
// campos de largura/densidade/underlay só valem para satin).
function syncTextFieldVisibility() {
  const isFill = currentFontType() === 'ttf';
  $('text-stroke-fields').hidden = isFill;
  $('text-fill-fields').hidden = !isFill;
  if (isFill) {
    $('text-outline-fields').hidden = !$('text-outline').checked;
  } else {
    const isSatin = $('text-finish').value === 'satin';
    $('text-satin-fields').hidden = !isSatin;
    $('text-underlay-row').hidden = !isSatin;
  }
}

// "Adicionar fonte…" (issue #20): o processo principal escolhe o .ttf/.otf
// e copia pra fonts/ttf/ (preload sandboxed não tem 'fs' — I/O só via IPC).
async function addTtfFontFlow() {
  const result = await window.api.letteringAddTtfFont();
  if (!result) return; // usuário cancelou o diálogo de arquivo
  if (!result.ok) {
    toast(I18n.tr('toast.fontAddError') + result.error, 'error', 4200);
    return;
  }
  state.lettering.fonts = result.fonts;
  populateTextFontSelect();
  $('text-font').value = result.fontId;
  syncTextFieldVisibility();
  scheduleTextPreview();
  const added = state.lettering.fonts.find((f) => f.id === result.fontId);
  toast(I18n.tr('toast.fontAdded', { name: added ? added.label : result.fontId }));
}

function sizeTextPreviewCanvas() {
  const cv = $('text-preview');
  const rect = cv.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const d = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(rect.width * d));
  cv.height = Math.max(1, Math.round(rect.height * d));
}

function clearTextPreview(message) {
  const cv = $('text-preview');
  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  if (!message) return;
  const d = window.devicePixelRatio || 1;
  c.fillStyle = '#5b5b66';
  c.font = `${Math.round(12 * d)}px -apple-system, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(message, cv.width / 2, cv.height / 2);
}

// Desenha as polilinhas devolvidas por lettering:build — o mesmo traçado que
// vai ser gravado (ver patternPolylines em src/core/lettering/stitcher.js).
function drawTextPreview(result) {
  const cv = $('text-preview');
  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  if (!result.polylines.length) {
    clearTextPreview(I18n.tr('text.previewEmpty'));
    return;
  }
  const d = window.devicePixelRatio || 1;
  const [minX, minY, maxX, maxY] = result.bounds;
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const pad = 14 * d;
  const scale = Math.min((cv.width - pad * 2) / w, (cv.height - pad * 2) / h);
  const tx = cv.width / 2 - ((minX + maxX) / 2) * scale;
  const ty = cv.height / 2 - ((minY + maxY) / 2) * scale;
  c.strokeStyle = '#e8a13d';
  c.lineWidth = Math.max(1, 1.3 * d);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const line of result.polylines) {
    c.beginPath();
    line.forEach(([x, y], i) => {
      const sx = x * scale + tx;
      const sy = y * scale + ty;
      if (i === 0) c.moveTo(sx, sy);
      else c.lineTo(sx, sy);
    });
    c.stroke();
  }
}

let textPreviewTimer = null;
function scheduleTextPreview() {
  clearTimeout(textPreviewTimer);
  textPreviewTimer = setTimeout(refreshTextPreview, 150);
}

async function refreshTextPreview() {
  const hasText = $('text-input').value.trim().length > 0;
  if (!hasText) {
    state.lettering.lastResult = null;
    clearTextPreview(I18n.tr('text.previewEmpty'));
    $('text-stats').textContent = '';
    $('text-missing').hidden = true;
    return;
  }
  const result = await window.api.letteringBuild(readTextFormOpts());
  if (!result.ok) {
    state.lettering.lastResult = null;
    clearTextPreview(I18n.tr('text.previewEmpty'));
    $('text-stats').textContent = '';
    $('text-missing').hidden = true;
    toast(I18n.tr('toast.textError') + result.error, 'error', 4200);
    return;
  }
  state.lettering.lastResult = result;
  drawTextPreview(result);
  const opt = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  const w = ((result.bounds[2] - result.bounds[0]) / 10).toLocaleString(I18n.locale(), opt);
  const h = ((result.bounds[3] - result.bounds[1]) / 10).toLocaleString(I18n.locale(), opt);
  $('text-stats').textContent = I18n.tr('text.stats', { n: I18n.fmtNum(result.stats.stitches), w, h });
  if (result.missingChars.length) {
    $('text-missing').hidden = false;
    $('text-missing').textContent = I18n.tr('text.missingChars', { chars: result.missingChars.join(' ') });
  } else {
    $('text-missing').hidden = true;
  }
}

// Redesenha o resultado mais recente, ou a mensagem de "vazio" — usado tanto
// ao abrir o diálogo quanto pelo ResizeObserver (redimensionar o <canvas>
// via .width/.height sempre limpa o conteúdo, mesmo quando o tamanho não mudou).
function redrawTextPreview() {
  if (state.lettering.lastResult) drawTextPreview(state.lettering.lastResult);
  else clearTextPreview(I18n.tr('text.previewEmpty'));
}

function openTextDialog() {
  $('dlg-text').showModal();
  syncTextFieldVisibility();
  sizeTextPreviewCanvas();
  redrawTextPreview();
  $('text-input').focus();
  if ($('text-input').value.trim()) scheduleTextPreview();
}

// Insere o texto: se já há um design aberto, emenda como um novo bloco de
// cor ao final (COLOR_CHANGE antes, se já houver pontos); senão, o texto
// vira o design. Em ambos os casos o bloco de texto já chega centrado na
// origem (textToPattern centra por padrão).
async function insertTextDesign() {
  if (!$('text-input').value.trim()) {
    toast(I18n.tr('toast.textEmpty'), 'warn');
    return;
  }
  const result = await window.api.letteringBuild(readTextFormOpts());
  if (!result.ok) {
    toast(I18n.tr('toast.textError') + result.error, 'error', 4200);
    return;
  }
  const textDesign = result.design;
  if (!textDesign.stitches.length) {
    toast(I18n.tr('toast.textEmpty'), 'warn');
    return;
  }

  if (!state.design) {
    setDesign(textDesign);
    toast(I18n.tr('toast.textCreated'));
  } else {
    // Operação composta (agulhadas + threads mudam juntas, tamanho do
    // array cresce): sem inversa analítica barata, usa o fallback 'snapshot'.
    const before = cloneDesignData();
    let stitches = state.design.stitches;
    if (stitches.length && (stitches[stitches.length - 1][2] & COMMAND_MASK) === END) {
      stitches = stitches.slice(0, -1); // um único END sobrevive, no fim de tudo
    }
    if (stitches.length) {
      const last = stitches[stitches.length - 1];
      stitches.push([last[0], last[1], COLOR_CHANGE]);
    }
    for (const st of textDesign.stitches) stitches.push([st[0], st[1], st[2]]);
    state.design.stitches = stitches;
    state.design.threads.push(...textDesign.threads);
    pushHistory({ type: 'snapshot', before, after: cloneDesignData() });
    bumpArt();
    deriveBlocks();
    deriveStats();
    updateSidebar();
    updateStatusbar();
    RenderCanvas.requestRender();
    toast(I18n.tr('toast.textInserted'));
  }
  $('dlg-text').close();
}

// --------------------------------------------------------------- interação

function bindCanvas() {
  const wrap = $('canvas-wrap');
  new ResizeObserver(RenderCanvas.resizeCanvas).observe(wrap);

  let wheelIdleTimer = null;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.008 : 0.0016));
    // Marca interação para o cache do modo realista (ver ensureRealisticCache):
    // evita redesenhar a arte a cada evento de wheel, só quando ele parar.
    state.interacting = true;
    RenderCanvas.zoomAt(cx, cy, factor);
    clearTimeout(wheelIdleTimer);
    wheelIdleTimer = setTimeout(() => {
      state.interacting = false;
      RenderCanvas.requestRender();
    }, 180);
  }, { passive: false });

  let panning = false;
  let lastX = 0;
  let lastY = 0;
  let dragIndex = -1; // ponto sendo arrastado no modo de edição (-1 = nenhum)
  let dragMoved = false;
  let dragFrom = null; // posição do ponto ao iniciar o arraste, p/ montar o op movePoint completo no fim
  canvas.addEventListener('pointerdown', (e) => {
    if (window.ObjectCanvas && ObjectCanvas.isActive() && ObjectCanvas.onPointerDown(e)) return; // issue #29
    if (state.edit.active) {
      const rect = canvas.getBoundingClientRect();
      const [dx, dy] = RenderCanvas.toDesign(e.clientX - rect.left, e.clientY - rect.top);
      const maxDist = EDIT_PICK_RADIUS_PX / state.view.scale;
      const idx = Spatial.nearestStitch(state.design.stitches, dx, dy, maxDist);
      Edit.setSelectedStitch(idx);
      if (idx !== -1) {
        dragIndex = idx;
        dragMoved = false;
        canvas.setPointerCapture(e.pointerId);
        return; // arrastando um ponto: não inicia o pan
      }
      // clique longe de qualquer ponto: desseleciona e cai no pan normal.
    }
    panning = true;
    state.interacting = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.classList.add('panning');
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const [dx, dy] = RenderCanvas.toDesign(e.clientX - rect.left, e.clientY - rect.top);
    const opts = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
    $('st-pos').textContent =
      `x ${(dx / 10).toLocaleString(I18n.locale(), opts)}  y ${(dy / 10).toLocaleString(I18n.locale(), opts)} mm`;
    if (window.ObjectCanvas && ObjectCanvas.isActive() && ObjectCanvas.onPointerMove(e)) return; // issue #29
    if (dragIndex !== -1) {
      const st = state.design.stitches[dragIndex];
      if (!dragMoved) {
        dragFrom = [st[0], st[1]]; // captura ANTES de mutar: vira o "from" do movePoint no fim do arraste
        dragMoved = true;
      }
      st[0] = Math.round(dx);
      st[1] = Math.round(dy);
      Edit.afterPointMutation();
      return;
    }
    if (!panning) return;
    state.view.tx += e.clientX - lastX;
    state.view.ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    RenderCanvas.requestRender();
  });
  const stopPan = (e) => {
    if (window.ObjectCanvas) ObjectCanvas.onPointerUp(e); // issue #29
    panning = false;
    // Um único movePoint pro arraste inteiro (não por pixel), igual ao
    // snapshotUndo() único de antes — só que agora o "to" só existe no
    // fim do gesto, então o push acontece aqui em vez de no 1º pointermove.
    if (dragIndex !== -1 && dragMoved) {
      const st = state.design.stitches[dragIndex];
      pushHistory({ type: 'movePoint', index: dragIndex, from: dragFrom, to: [st[0], st[1]] });
    }
    dragIndex = -1;
    dragMoved = false;
    dragFrom = null;
    canvas.classList.remove('panning');
    if (state.interacting) {
      state.interacting = false;
      RenderCanvas.requestRender(); // reconstrói o cache realista já parado, com nitidez
    }
  };
  canvas.addEventListener('pointerup', stopPan);
  canvas.addEventListener('pointercancel', stopPan);
  canvas.addEventListener('dblclick', () => {
    if (state.edit.active) Edit.insertAfterSelected();
    else RenderCanvas.fitView();
  });
  canvas.addEventListener('pointerleave', () => {
    $('st-pos').textContent = '';
  });
}

function bindDragDrop() {
  const wrap = $('canvas-wrap');
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    $('empty-state').classList.add('drop-hover');
  });
  window.addEventListener('dragleave', () => $('empty-state').classList.remove('drop-hover'));
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    $('empty-state').classList.remove('drop-hover');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const p = window.api.pathForFile(file);
    if (p) openPath(p);
  });
}

async function refreshEmptyRecents() {
  if (!window.api) return;
  const recents = await window.api.listRecent();
  const box = $('empty-recents');
  box.innerHTML = '';
  for (const p of recents.slice(0, 5)) {
    const btn = document.createElement('button');
    btn.textContent = p.split('/').pop().split('\\').pop() + '  ·  ' + p;
    btn.title = p;
    btn.addEventListener('click', () => openPath(p));
    box.appendChild(btn);
  }
}

function bindToolbar() {
  $('btn-open').addEventListener('click', openViaDialog);
  $('btn-open-empty').addEventListener('click', openViaDialog);
  $('btn-save').addEventListener('click', saveAs);
  $('btn-export').addEventListener('click', exportPng);
  $('btn-text').addEventListener('click', openTextDialog);
  $('btn-fit').addEventListener('click', RenderCanvas.fitView);
  $('btn-zoom-in').addEventListener('click', () => RenderCanvas.zoomCenter(1.3));
  $('btn-zoom-out').addEventListener('click', () => RenderCanvas.zoomCenter(1 / 1.3));
  $('btn-settings').addEventListener('click', openSettings);

  const toggles = [
    ['btn-grid', () => state.settings.grid.show, (v) => (state.settings.grid.show = v)],
    ['btn-hoop', () => state.settings.hoop.show, (v) => (state.settings.hoop.show = v)],
    ['btn-jumps', () => state.settings.view.showJumps, (v) => (state.settings.view.showJumps = v)],
    ['btn-points', () => state.settings.view.showPoints, (v) => (state.settings.view.showPoints = v)],
  ];
  for (const [id, get, set] of toggles) {
    $(id).addEventListener('click', async () => {
      set(!get());
      bumpArt(); // saltos afetam o desenho; grade/bastidor são inofensivos aqui
      syncToggleButtons();
      RenderCanvas.requestRender();
      await window.api.setSettings(state.settings);
    });
  }

  $('btn-edit').addEventListener('click', Edit.toggleEditMode);
  $('btn-objects').addEventListener('click', () => window.ObjectCanvas && ObjectCanvas.toggle()); // issue #29

  $('btn-sim').addEventListener('click', () => Sim.simSetPlaying(!state.sim.playing));
  $('sim-progress').addEventListener('input', () => {
    if (!state.design) return;
    state.sim.playing = false;
    $('btn-sim').textContent = '▶';
    const v = Number($('sim-progress').value);
    state.sim.pos = v >= 1000 ? Infinity : (v / 1000) * state.design.stitches.length;
    RenderCanvas.requestRender();
  });
  const tlSeek = (e) => {
    const r = $('timeline-canvas').getBoundingClientRect();
    Sim.simSeekFraction((e.clientX - r.left) / r.width);
  };
  $('timeline-canvas').addEventListener('pointerdown', (e) => {
    $('timeline-canvas').setPointerCapture(e.pointerId);
    tlSeek(e);
  });
  $('timeline-canvas').addEventListener('pointermove', (e) => {
    if (e.buttons & 1) tlSeek(e);
  });

  $('sim-speed').addEventListener('change', async () => {
    state.settings.sim.stitchesPerSecond = Number($('sim-speed').value);
    await window.api.setSettings({ sim: { stitchesPerSecond: state.settings.sim.stitchesPerSecond } });
  });

  $('t-center').addEventListener('click', centerToOrigin);
  $('t-rot-cw').addEventListener('click', () => rotate90(true));
  $('t-rot-ccw').addEventListener('click', () => rotate90(false));
  $('t-flip-h').addEventListener('click', () => flip(true));
  $('t-flip-v').addEventListener('click', () => flip(false));
  $('t-undo').addEventListener('click', undo);
  $('t-redo').addEventListener('click', redo);
  $('t-scale').addEventListener('click', openScaleDialog);
}

function syncToggleButtons() {
  $('btn-grid').classList.toggle('on', state.settings.grid.show);
  $('btn-hoop').classList.toggle('on', state.settings.hoop.show);
  $('btn-jumps').classList.toggle('on', state.settings.view.showJumps);
  $('btn-points').classList.toggle('on', !!state.settings.view.showPoints);
}

// true depois que o usuário toca no checkbox "Manter densidade" à mão;
// enquanto for false, o valor padrão reage ao % digitado.
let keepDensityTouched = false;

function openScaleDialog() {
  if (!state.design) return;
  $('scale-percent').value = 100;
  keepDensityTouched = false;
  updateScalePreview();
  $('dlg-scale').showModal();
}

// Padrão: marcado quando a escala passa de ±10% (abaixo disso o ganho de
// manter a densidade do ponto cheio é pequeno). Só se aplica até o
// usuário tocar no checkbox manualmente (ver keepDensityTouched).
function syncKeepDensityDefault(pct) {
  if (keepDensityTouched) return;
  $('scale-keepdensity').checked = Math.abs(pct / 100 - 1) > 0.1;
}

function updateScalePreview() {
  const pct = clampNum($('scale-percent').value, 10, 400, 100);
  const s = state.stats;
  $('scale-preview').textContent =
    `${I18n.fmtMm(s.width)} × ${I18n.fmtMm(s.height)}  →  ${I18n.fmtMm((s.width * pct) / 100)} × ${I18n.fmtMm((s.height * pct) / 100)}`;
  syncKeepDensityDefault(pct);
}

function bindDialogs() {
  $('scale-percent').addEventListener('input', updateScalePreview);
  $('scale-keepdensity').addEventListener('change', () => {
    keepDensityTouched = true;
  });
  $('scale-form').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'apply') {
      const pct = clampNum($('scale-percent').value, 10, 400, 100);
      if (pct !== 100) {
        if ($('scale-keepdensity').checked) scaleDesignWithDensity(pct / 100);
        else scaleDesign(pct / 100);
      }
    }
  });

  $('settings-form').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'save') applySettingsFromForm();
  });

  $('text-form').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'insert') {
      e.preventDefault(); // async e pode falhar (texto vazio, erro de IPC) — fecha só se der certo
      insertTextDesign();
    }
  });
  for (const id of [
    'text-input', 'text-height', 'text-letterspacing', 'text-linespacing', 'text-stitchlen',
    'text-satinwidth', 'text-satindensity', 'text-fillspacing', 'text-fillangle', 'text-fillstitch', 'text-outlinestitch',
  ]) {
    $(id).addEventListener('input', scheduleTextPreview);
  }
  $('text-font').addEventListener('change', () => {
    syncTextFieldVisibility();
    scheduleTextPreview();
  });
  $('text-finish').addEventListener('change', () => {
    syncTextFieldVisibility();
    scheduleTextPreview();
  });
  $('text-underlay').addEventListener('change', scheduleTextPreview);
  $('text-outline').addEventListener('change', () => {
    syncTextFieldVisibility();
    scheduleTextPreview();
  });
  $('text-addfont-btn').addEventListener('click', addTtfFontFlow);
  new ResizeObserver(() => {
    sizeTextPreviewCanvas();
    redrawTextPreview();
  }).observe($('text-preview'));

  document.querySelectorAll('.tabs input[name="tab"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      document.querySelectorAll('.tab-pane').forEach((pane) => {
        pane.hidden = pane.dataset.tab !== radio.value;
      });
    });
  });

  $('set-hooppreset').addEventListener('change', syncHoopCustomVisibility);
}

// --------------------------------------------------------------- importar SVG

const svgPrev = { timer: null, token: 0, aspect: null };

function handleSvgPicked(payload) {
  if (state.design && !confirm(I18n.tr('svgimport.confirmReplace'))) return;
  state.svgImport = payload;
  svgPrev.aspect = null; // preenchido pela primeira prévia (tamanho natural)
  $('svgimport-filename').textContent = payload.name;
  $('svgimport-width').value = '';
  $('svgimport-height').value = '';
  $('svgimport-stats').textContent = '';
  $('dlg-svg-import').showModal();
  runSvgPreview();
}

function svgImportOpts() {
  const opts = {
    fillSpacingMm: clampNum($('svgimport-spacing').value, 0.1, 2, 0.4),
    fillAngleDeg: clampNum($('svgimport-angle').value, -180, 180, 0),
    fillStitchMm: clampNum($('svgimport-fillstitch').value, 1, 8, 3),
    outlineStitchMm: clampNum($('svgimport-outlinestitch').value, 0.5, 8, 2.5),
    outline: $('svgimport-outline').checked,
    fill: $('svgimport-fill').checked,
  };
  const w = Number($('svgimport-width').value);
  if (w > 0) opts.targetWidthMm = Math.max(5, Math.min(600, w));
  return opts;
}

// Prévia do SVG: gera de verdade no núcleo (modo preview, sem design:opened)
// e desenha; a primeira resposta define o tamanho natural nos campos.
function runSvgPreview() {
  const picked = state.svgImport;
  if (!picked) return;
  const token = ++svgPrev.token;
  window.api
    .importSvg({ text: picked.text, opts: svgImportOpts(), name: picked.name, path: picked.path, preview: true })
    .then((res) => {
      if (token !== svgPrev.token || !res || !res.ok || !state.svgImport) return;
      if (svgPrev.aspect === null && res.widthMm > 0) {
        svgPrev.aspect = res.heightMm / res.widthMm;
        $('svgimport-width').value = Math.round(res.widthMm);
        $('svgimport-height').value = Math.round(res.heightMm);
      }
      const cv = $('svgimport-cv');
      const rect = cv.getBoundingClientRect();
      if (rect.width > 0) RenderCanvas.drawDesignInto(cv, res.design, rect.width, rect.height, 10, { autoBg: true });
      let n = 0;
      for (const st of res.design.stitches) {
        if ((st[2] & COMMAND_MASK) === STITCH) n++;
      }
      $('svgimport-stats').textContent =
        res.widthMm.toFixed(0) + ' × ' + res.heightMm.toFixed(0) + ' mm · ' +
        I18n.tr('dig.previewStats', { n: I18n.fmtNum(n), c: res.design.threads.length });
    })
    .catch(() => {});
}

function queueSvgPreview() {
  clearTimeout(svgPrev.timer);
  svgPrev.timer = setTimeout(runSvgPreview, 280);
}

async function applySvgImport() {
  const picked = state.svgImport;
  if (!picked) return;
  try {
    await window.api.importSvg({ text: picked.text, opts: svgImportOpts(), name: picked.name, path: picked.path });
    toast(I18n.tr('toast.svgImported', { name: picked.name }));
  } catch (err) {
    toast(I18n.tr('toast.svgImportError') + err.message, 'error', 5000);
  }
}

function bindSvgImportDialog() {
  window.api.onSvgPicked(handleSvgPicked);
  $('svgimport-form').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'apply') applySvgImport();
  });
  $('svgimport-width').addEventListener('input', () => {
    const w = Number($('svgimport-width').value);
    if (svgPrev.aspect !== null && w > 0) $('svgimport-height').value = Math.round(w * svgPrev.aspect);
    queueSvgPreview();
  });
  $('svgimport-height').addEventListener('input', () => {
    const h = Number($('svgimport-height').value);
    if (svgPrev.aspect !== null && svgPrev.aspect > 0 && h > 0) {
      $('svgimport-width').value = Math.round(h / svgPrev.aspect);
    }
    queueSvgPreview();
  });
  for (const id of ['svgimport-spacing', 'svgimport-angle', 'svgimport-fillstitch', 'svgimport-outlinestitch']) {
    $(id).addEventListener('input', queueSvgPreview);
  }
  $('svgimport-outline').addEventListener('change', queueSvgPreview);
  $('svgimport-fill').addEventListener('change', queueSvgPreview);
}

// --------------------------------------------------------------- atalhos de teclado (issue #38)

// Fonte única do diálogo "?" (dlg-shortcuts, abaixo): os bindings REAIS
// ficam em bindMenuAndKeys — o keydown global mais adiante nesta função
// (Espaço/E/G/B/J/0/+/-/?, e dentro do modo de edição Esc/Delete/I/setas) —
// e nos accelerators do menu Electron (src/main/main.js, buildMenuTemplate,
// os Cmd/Ctrl+...). Esta tabela só DOCUMENTA esses dois lugares para
// renderizar o diálogo; não os registra. Mudou um atalho? Atualize os dois:
// o handler de verdade e esta lista.
const SHORTCUTS = [
  { keys: 'Space', i18n: 'shortcuts.desc.sim', context: 'global' },
  { keys: 'E', i18n: 'shortcuts.desc.edit', context: 'global' },
  { keys: 'G', i18n: 'shortcuts.desc.grid', context: 'global' },
  { keys: 'B', i18n: 'shortcuts.desc.hoop', context: 'global' },
  { keys: 'J', i18n: 'shortcuts.desc.jumps', context: 'global' },
  { keys: '0', i18n: 'shortcuts.desc.fit', context: 'global' },
  { keys: '+', i18n: 'shortcuts.desc.zoomIn', context: 'global' },
  { keys: '-', i18n: 'shortcuts.desc.zoomOut', context: 'global' },
  { keys: '?', i18n: 'shortcuts.desc.help', context: 'global' },
  { keys: 'I', i18n: 'shortcuts.desc.insertPoint', context: 'edit' },
  { keys: '↑ ↓ ← →', i18n: 'shortcuts.desc.nudgePoint', context: 'edit' },
  { keys: 'Shift+↑↓←→', i18n: 'shortcuts.desc.nudgePoint10', context: 'edit' },
  { keys: 'Delete', i18n: 'shortcuts.desc.deletePoint', context: 'edit' },
  { keys: 'Esc', i18n: 'shortcuts.desc.deselectPoint', context: 'edit' },
  { keys: 'Esc', i18n: 'shortcuts.desc.closeDialog', context: 'dialog' },
  { keys: 'Cmd/Ctrl+O', i18n: 'shortcuts.desc.open', context: 'global' },
  { keys: 'Cmd/Ctrl+Shift+S', i18n: 'shortcuts.desc.saveAs', context: 'global' },
  { keys: 'Cmd/Ctrl+E', i18n: 'shortcuts.desc.exportPng', context: 'global' },
  { keys: 'Cmd/Ctrl+R', i18n: 'shortcuts.desc.resize', context: 'global' },
  { keys: 'Cmd/Ctrl+Z', i18n: 'shortcuts.desc.undo', context: 'global' },
  { keys: 'Cmd/Ctrl+Shift+Z', i18n: 'shortcuts.desc.redo', context: 'global' },
  { keys: 'Cmd/Ctrl+,', i18n: 'shortcuts.desc.settings', context: 'global' },
];

const SHORTCUT_CONTEXT_I18N = { global: 'shortcuts.ctxGlobal', edit: 'shortcuts.ctxEdit', dialog: 'shortcuts.ctxDialog' };

function renderShortcutsTable() {
  const tbody = $('shortcuts-body');
  tbody.innerHTML = '';
  for (const row of SHORTCUTS) {
    const rowEl = document.createElement('tr'); // "tr" já é a função de tradução; evita sombrear
    const tdKeys = document.createElement('td');
    tdKeys.className = 'mono';
    tdKeys.textContent = row.keys;
    const tdDesc = document.createElement('td');
    tdDesc.textContent = I18n.tr(row.i18n);
    const tdCtx = document.createElement('td');
    tdCtx.className = 'muted';
    tdCtx.textContent = I18n.tr(SHORTCUT_CONTEXT_I18N[row.context]);
    rowEl.append(tdKeys, tdDesc, tdCtx);
    tbody.appendChild(rowEl);
  }
}

// Renderiza de novo a cada abertura (idioma pode ter mudado desde a última vez).
function openShortcutsDialog() {
  renderShortcutsTable();
  $('dlg-shortcuts').showModal();
}

function bindMenuAndKeys() {
  window.api.onMenu((action) => {
    const actions = {
      open: openViaDialog,
      'save-as': saveAs,
      'export-png': exportPng,
      settings: openSettings,
      undo,
      redo,
      center: centerToOrigin,
      scale: openScaleDialog,
      'rotate-cw': () => rotate90(true),
      'rotate-ccw': () => rotate90(false),
      'flip-h': () => flip(true),
      'flip-v': () => flip(false),
      fit: RenderCanvas.fitView,
      'zoom-in': () => RenderCanvas.zoomCenter(1.3),
      'zoom-out': () => RenderCanvas.zoomCenter(1 / 1.3),
      'toggle-grid': () => $('btn-grid').click(),
      'toggle-hoop': () => $('btn-hoop').click(),
      'toggle-jumps': () => $('btn-jumps').click(),
      'sim-toggle': () => Sim.simSetPlaying(!state.sim.playing),
      'sim-reset': Sim.simReset,
      formats: () => $('dlg-formats').showModal(),
      shortcuts: openShortcutsDialog,
      'digitize-image': openDigitizeDialog,
      // Auto-update (issue #31): electron-updater in the main process reports
      // through this same 'menu' channel; no design needs to be open to see them.
      'update-checking': () => toast(I18n.tr('update.checking')),
      'update-available': () => toast(I18n.tr('update.available')),
      'update-not-available': () => toast(I18n.tr('update.notAvailable')),
      'update-downloaded': () => toast(I18n.tr('update.downloaded')),
      'update-error': () => toast(I18n.tr('update.error'), 'error', 5000),
    };
    const alwaysAvailable = [
      'open', 'settings', 'formats', 'shortcuts', 'digitize-image',
      'update-checking', 'update-available', 'update-not-available', 'update-downloaded', 'update-error',
    ];
    if (state.design || alwaysAvailable.includes(action)) {
      const fn = actions[action];
      if (fn) fn();
    }
  });

  window.api.onDesignOpened((design) => {
    setDesign(design);
    closeDrivesDialog(); // abrir uma matriz (Recentes/Finder/gestor de pendrive) tira o modal do caminho
    closeLibraryDialog(); // idem para o navegador de biblioteca (issue #17)
  });

  window.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
    if (document.querySelector('dialog[open]')) return;
    const key = e.key.toLowerCase();

    // Atalhos exclusivos do modo de objetos (issue #29): Esc desseleciona, Delete apaga o bloco.
    if (window.ObjectCanvas && ObjectCanvas.isActive() && ObjectCanvas.onKeyDown(e)) return;

    // Atalhos exclusivos do modo de edição de pontos (issue #3).
    if (state.edit.active) {
      if (key === 'escape') {
        Edit.setSelectedStitch(-1);
        return;
      }
      if (key === 'delete' || key === 'backspace') {
        e.preventDefault();
        Edit.deleteSelectedStitch();
        return;
      }
      if (key === 'i') {
        Edit.insertAfterSelected();
        return;
      }
      if (key.startsWith('arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const deltas = { arrowup: [0, -step], arrowdown: [0, step], arrowleft: [-step, 0], arrowright: [step, 0] };
        Edit.nudgeSelectedStitch(deltas[key][0], deltas[key][1]);
        return;
      }
    }

    if (key === ' ') {
      e.preventDefault();
      Sim.simSetPlaying(!state.sim.playing);
    } else if (key === 'e' && !e.metaKey && !e.ctrlKey) Edit.toggleEditMode(); // Cmd/Ctrl+E é o acelerador de exportar PNG
    else if (key === 'g') $('btn-grid').click();
    else if (key === 'b') $('btn-hoop').click();
    else if (key === 'j') $('btn-jumps').click();
    else if (key === '0') RenderCanvas.fitView();
    else if (key === '+' || key === '=') RenderCanvas.zoomCenter(1.3);
    else if (key === '-') RenderCanvas.zoomCenter(1 / 1.3);
    // "?" (issue #38): normalmente já chega como key === '?' com Shift+/,
    // mas alguns layouts de teclado não normalizam — checa os dois.
    else if (key === '?' || (e.shiftKey && key === '/')) openShortcutsDialog();
  });
}

// --------------------------------------------------------------- digitalizar imagem (PNG -> vetor)
// Fluxo: Arquivo > Digitalizar imagem… -> escolhe PNG/JPG/WEBP -> preview
// lado a lado (original · posterizada) com reposterização ao vivo numa
// versão reduzida (~256 px) -> confirma -> gera o Pattern (só o contorno em
// ponto corrido; preenchimento tatami fica para a issue #1) e abre como o
// design atual, do mesmo jeito que abrir um arquivo (setDesign).

const digitize = {
  full: null, // { width, height, data } na resolução original (usado só ao confirmar)
  work: null, // { width, height, data } reduzido a ~256 px (preview ao vivo)
  name: '',
  previewTimer: null,
  previewToken: 0,
  stitchTimer: null,
  stitchToken: 0,
};

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    img.src = src;
  });
}

// Desenha a imagem num canvas fora de tela e devolve os pixels crus.
function imageToImageData(img, maxSide) {
  const scale = maxSide ? Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight)) : 1;
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const octx = off.getContext('2d');
  octx.drawImage(img, 0, 0, w, h);
  const d = octx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: d.data };
}

function paintImageData(canvasEl, imgData) {
  canvasEl.width = imgData.width;
  canvasEl.height = imgData.height;
  canvasEl.getContext('2d').putImageData(new ImageData(imgData.data, imgData.width, imgData.height), 0, 0);
}

function digitizeColorsLabel() {
  $('dig-colors-value').textContent = $('dig-colors').value;
}

function updateDigitizeSummary(previewDesign) {
  if (!digitize.full) return;
  const widthMm = clampNum($('dig-width').value, 5, 600, 80);
  const heightMm = widthMm * (digitize.full.height / digitize.full.width);
  let txt = `${widthMm.toFixed(0)} × ${heightMm.toFixed(0)} mm`;
  if (previewDesign) {
    let n = 0;
    for (const st of previewDesign.stitches) {
      if ((st[2] & COMMAND_MASK) === STITCH) n++;
    }
    txt += ' · ' + I18n.tr('dig.previewStats', { n: I18n.fmtNum(n), c: previewDesign.threads.length });
  }
  $('dig-summary').textContent = txt;
}

// Parâmetros do formulário para uma imagem (work no preview, full ao aplicar):
// escala px->0,1mm e tolerância dependem da resolução da imagem usada.
function digitizeOptsFor(image) {
  const widthMm = clampNum($('dig-width').value, 5, 600, 80);
  const toleranceMm = clampNum($('dig-tolerance').value, 0, 5, 0.3);
  return {
    colors: Number($('dig-colors').value),
    ignoreBackground: $('dig-ignorebg').checked,
    scale: (widthMm * 10) / image.width,
    simplifyTol: (toleranceMm * image.width) / widthMm,
    stitchLenMm: clampNum($('dig-stitchlen').value, 0.5, 6, 2.5),
    outline: $('dig-outline').checked,
    fill: $('dig-fill').checked,
    fillSpacingMm: clampNum($('dig-fillspacing').value, 0.1, 2, 0.4),
    fillAngleDeg: clampNum($('dig-fillangle').value, -180, 180, 0),
    fillStitchMm: clampNum($('dig-fillstitch').value, 1, 8, 3),
    name: digitize.name,
  };
}

// Prévia dos pontos: gera de verdade (na imagem de trabalho, menor) e desenha
// as polilinhas coloridas; debounced porque cada mudança de parâmetro regenera.
function runDigitizeStitchPreview() {
  if (!digitize.work) return;
  const token = ++digitize.stitchToken;
  window.api
    .digitizeGenerate(digitize.work, digitizeOptsFor(digitize.work))
    .then((design) => {
      if (token !== digitize.stitchToken) return;
      const cv = $('dig-cv-stitches');
      const rect = cv.getBoundingClientRect();
      if (rect.width > 0) RenderCanvas.drawDesignInto(cv, design, rect.width, rect.height, 10, { autoBg: true });
      updateDigitizeSummary(design);
    })
    .catch(() => {});
}

function queueDigitizeStitchPreview() {
  clearTimeout(digitize.stitchTimer);
  digitize.stitchTimer = setTimeout(runDigitizeStitchPreview, 280);
}

// digitize:posterize roda por IPC no processo principal (o preload é
// sandboxed e não tem 'fs'/núcleo direto), então a resposta é assíncrona;
// o token evita pintar uma resposta antiga se o slider já mudou de novo.
function runDigitizePreview() {
  if (!digitize.work) return;
  const colors = Number($('dig-colors').value);
  const token = ++digitize.previewToken;
  window.api.digitizePosterize(digitize.work, colors).then((posterized) => {
    if (token !== digitize.previewToken) return;
    paintImageData($('dig-cv-posterized'), posterized);
  });
}

function queueDigitizePreview() {
  clearTimeout(digitize.previewTimer);
  digitize.previewTimer = setTimeout(runDigitizePreview, 60);
}

async function openDigitizeDialog() {
  let picked;
  try {
    picked = await window.api.openImageDialog();
  } catch (err) {
    toast(I18n.tr('dig.openError') + err.message, 'error', 5000);
    return;
  }
  if (!picked) return;
  await openDigitizeWith(picked);
}

async function openDigitizeWith(picked) {
  try {
    const img = await loadImageEl(picked.dataURL);
    digitize.full = imageToImageData(img, null);
    digitize.work = imageToImageData(img, 256);
    digitize.name = picked.name;
    paintImageData($('dig-cv-original'), digitize.work);
    $('dig-colors').value = 4;
    digitizeColorsLabel();
    $('dig-width').value = 80;
    $('dig-height').value = (80 * (digitize.full.height / digitize.full.width)).toFixed(0);
    $('dig-tolerance').value = 0.3;
    $('dig-stitchlen').value = 2.5;
    $('dig-fill').checked = true;
    $('dig-ignorebg').checked = true;
    $('dig-outline').checked = true;
    $('dig-fillspacing').value = 0.4;
    $('dig-fillangle').value = 0;
    $('dig-fillstitch').value = 3;
    updateDigitizeSummary();
    runDigitizePreview();
    $('dlg-digitize').showModal();
    queueDigitizeStitchPreview(); // depois do showModal: o canvas precisa de layout
  } catch (err) {
    toast(I18n.tr('dig.openError') + err.message, 'error', 5000);
  }
}

// Devolve true se gerou e aplicou o design (para o chamador decidir se fecha
// o modal); false se o usuário desistiu na confirmação de substituição ou se
// a geração falhou — nesses casos o modal continua aberto com os ajustes.
async function confirmDigitize() {
  if (!digitize.full) return false;
  if (state.design && !window.confirm(I18n.tr('dig.confirmReplace'))) return false;
  try {
    const design = await window.api.digitizeGenerate(digitize.full, digitizeOptsFor(digitize.full));
    setDesign(design);
    toast(I18n.tr('toast.digitized', { n: I18n.fmtNum(state.stats.stitches), c: I18n.fmtNum(state.blocks.length) }));
    return true;
  } catch (err) {
    toast(I18n.tr('dig.openError') + err.message, 'error', 5000);
    return false;
  }
}

function bindDigitizeDialog() {
  $('dig-colors').addEventListener('input', () => {
    digitizeColorsLabel();
    queueDigitizePreview();
    queueDigitizeStitchPreview();
  });
  $('dig-width').addEventListener('input', () => {
    if (digitize.full) {
      const w = clampNum($('dig-width').value, 5, 600, 80);
      $('dig-height').value = (w * (digitize.full.height / digitize.full.width)).toFixed(0);
    }
    updateDigitizeSummary();
    queueDigitizeStitchPreview();
  });
  $('dig-height').addEventListener('input', () => {
    if (digitize.full) {
      const h = clampNum($('dig-height').value, 5, 600, 80);
      $('dig-width').value = (h * (digitize.full.width / digitize.full.height)).toFixed(0);
    }
    updateDigitizeSummary();
    queueDigitizeStitchPreview();
  });
  for (const id of ['dig-tolerance', 'dig-stitchlen', 'dig-fillspacing', 'dig-fillangle', 'dig-fillstitch']) {
    $(id).addEventListener('input', queueDigitizeStitchPreview);
  }
  for (const id of ['dig-fill', 'dig-outline', 'dig-ignorebg']) {
    $(id).addEventListener('change', queueDigitizeStitchPreview);
  }
  // Não deixa o <form method="dialog"> fechar o modal por conta própria: se o
  // usuário desistir da confirmação de substituição, os ajustes continuam ali.
  $('digitize-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.submitter && e.submitter.value === 'confirm') {
      if (await confirmDigitize()) $('dlg-digitize').close();
    } else {
      $('dlg-digitize').close();
    }
  });
}

// --------------------------------------------------------------- boot

// Qualquer exceção não tratada vira um toast: um erro silencioso no meio de
// um handler mata os listeners e a UI "para de responder" sem explicação.
window.addEventListener('error', (e) => {
  try {
    toast(I18n.tr('toast.internalError') + e.message, 'error', 7000);
  } catch {
    /* toast indisponível durante o boot */
  }
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  try {
    toast(I18n.tr('toast.internalError') + msg, 'error', 7000);
  } catch {
    /* idem */
  }
});

async function boot() {
  if (!window.api) {
    // Aberto fora do Electron (ex.: prévia de estilo no navegador).
    document.querySelector('#empty-state p').textContent =
      'Run with npm start · Execute com npm start';
    return;
  }
  state.settings = await window.api.getSettings();
  const launch = await window.api.launchOptions();
  state.hoopPresets = launch.hoopPresets;
  state.lang = launch.lang;
  state.strings = launch.strings;
  state.platform = launch.platform;
  state.lettering.fonts = await window.api.letteringListFonts();

  I18n.applyI18n();
  populateTextFontSelect();
  syncToggleButtons();
  $('sim-speed').value = String(nearestSimOption(state.settings.sim.stitchesPerSecond));

  // Injeta a ponte com o estado do renderer no modo de objetos (issue #29);
  // ver cabeçalho de src/renderer/objects.js.
  if (window.ObjectCanvas) {
    // Integração #29 + #37: o gesto de objeto captura o "antes" quando começa
    // a mutar (snapshotUndo do host) e empilha uma operação 'snapshot' no
    // History junto do afterPointMutation que fecha o gesto.
    let objBefore = null;
    ObjectCanvas.init({
      state,
      toScreen: RenderCanvas.toScreen,
      toDesign: RenderCanvas.toDesign,
      canvas,
      snapshotUndo: () => {
        objBefore = cloneDesignData();
      },
      bumpArt,
      deriveBlocks,
      afterPointMutation: () => {
        if (objBefore) {
          pushHistory({ type: 'snapshot', before: objBefore, after: cloneDesignData() });
          objBefore = null;
        }
        Edit.afterPointMutation();
      },
      setEditMode: Edit.setEditMode,
      simReset: Sim.simReset,
      tr: I18n.tr,
      updateToolbarEnabled,
      requestRender: RenderCanvas.requestRender,
    });
  }

  bindCanvas();
  bindToolbar();
  bindDialogs();
  bindSvgImportDialog();
  bindMenuAndKeys();
  bindDragDrop();
  bindDrivesDialog();
  bindDigitizeDialog();
  bindLibraryDialog();
  RenderCanvas.resizeCanvas();
  refreshEmptyRecents();
  RenderCanvas.requestRender();

  if (launch.openPath) {
    await openPath(launch.openPath);
  }
  if (launch.dialog === 'settings') openSettings();
  if (launch.dialog === 'scale' && state.design) openScaleDialog();
  if (launch.dialog === 'formats') $('dlg-formats').showModal();
  if (launch.dialog === 'shortcuts') openShortcutsDialog();
  if (launch.dialog === 'drives') await openDrivesDialog();
  if (launch.dialog === 'text') openTextDialog();
  if (launch.dialog === 'digitize') $('dlg-digitize').showModal();
  if (launch.digitizeImage) await openDigitizeWith(launch.digitizeImage);
  if (launch.svgImport) handleSvgPicked(launch.svgImport);
  if (launch.dialog === 'library') await openLibraryDialog();
  if (launch.dialog === 'library-save' && state.design) await openLibrarySaveDialog();
  if (launch.librarySearch) {
    $('lib-search').value = launch.librarySearch;
    await runLibrarySearch(launch.librarySearch);
  }
  // --library-wait-index (issue #35, só automação): espera a varredura
  // incremental terminar antes de sinalizar "pronto" — pra --screenshot
  // capturar a biblioteca já totalmente indexada, em vez de no meio do
  // progresso.
  if (launch.libraryWaitIndex) await waitForLibraryIndexIdle();

  // Sinaliza para o modo screenshot que a primeira pintura aconteceu.
  requestAnimationFrame(() => requestAnimationFrame(() => window.api.notifyRenderReady()));

  // --library-bench-scroll=ms (issue #35, só medição de desempenho): mede o
  // tempo de frame durante uma rolagem programática da grade da biblioteca
  // e encerra o app. Roda depois do notifyRenderReady acima (não deve
  // interferir na captura de tela do modo --screenshot).
  if (launch.libraryBenchScrollMs) {
    await runLibraryScrollBenchmark(launch.libraryBenchScrollMs, launch.libraryBenchScrollImmediate);
    window.api.quitSoon(300);
  }
}

boot();
