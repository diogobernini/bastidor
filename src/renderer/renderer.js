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
  undoStack: [],
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
  },
};

function bumpArt() {
  state.artVersion++;
}

// --------------------------------------------------------------- i18n

function tr(key, vars) {
  const table = state.strings[state.lang] || {};
  const en = state.strings.en || {};
  let s = table[key] !== undefined ? table[key] : en[key] !== undefined ? en[key] : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll('{' + k + '}', String(v));
  }
  return s;
}

function locale() {
  return state.lang === 'pt-BR' ? 'pt-BR' : 'en-US';
}

// Aplica as strings estáticas marcadas com data-i18n / data-i18n-title / data-i18n-placeholder.
function applyI18n() {
  document.documentElement.lang = state.lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = tr(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = tr(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = tr(el.dataset.i18nPlaceholder);
  });
  const speedSel = $('sim-speed');
  const current = speedSel.value;
  speedSel.innerHTML = '';
  for (const v of [150, 300, 600, 1200, 2500]) {
    const opt = document.createElement('option');
    opt.value = String(v);
    opt.textContent = `${v} ${tr('unit.sps')}`;
    speedSel.appendChild(opt);
  }
  if (current) speedSel.value = current;
  populateHoopPresets();
}

// --------------------------------------------------------------- utilidades

function fmtMm(units01mm, decimals = 1) {
  const mm = units01mm / 10;
  if (state.settings && state.settings.units === 'in') {
    const v = (mm / 25.4).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${v} ${tr('unit.in')}`;
  }
  const v = mm.toLocaleString(locale(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${v} ${tr('unit.mm')}`;
}

function fmtNum(n) {
  return n.toLocaleString(locale());
}

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
  const fallback = tr('colors.fallback', { n: i + 1 });
  if (!t) return fallback;
  const parts = [];
  if (t.description) parts.push(t.description);
  if (t.catalog) parts.push(tr('colors.catalog', { n: t.catalog }));
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
  return tr(key || 'cmd.other');
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
  if (!opts.keepUndo) {
    state.undoStack = [];
    state.dirty = false;
  }
  deriveBlocks();
  deriveStats();
  updateSidebar();
  updateStatusbar();
  updateToolbarEnabled();
  $('empty-state').style.display = 'none';
  $('sidebar').hidden = false;
  if (!opts.keepView) fitView();
  requestRender();
  document.title = (design.name ? design.name + ' — ' : '') + 'Bastidor';

  if (!opts.silent) {
    const w = [];
    if (state.stats.longCount > 0) {
      w.push(tr('warn.longShort', { n: fmtNum(state.stats.longCount), len: fmtMm(state.settings.warnings.longStitchMm * 10) }));
    }
    if (hoopExceeded()) w.push(tr('warn.hoopShort'));
    if (w.length) toast(tr('warn.prefix') + w.join(tr('warn.and')), 'warn', 4200);
  }
}

function hoopExceeded() {
  if (!state.stats || !state.settings) return false;
  const h = state.settings.hoop;
  return state.stats.width > h.width * 10 || state.stats.height > h.height * 10;
}

function snapshotUndo() {
  state.undoStack.push({
    stitches: state.design.stitches.map((s) => [s[0], s[1], s[2]]),
    threads: JSON.parse(JSON.stringify(state.design.threads)),
  });
  if (state.undoStack.length > 20) state.undoStack.shift();
  state.dirty = true;
  $('t-undo').disabled = false;
  updateStatusbar();
}

function undo() {
  const snap = state.undoStack.pop();
  if (!snap) return;
  state.design.stitches = snap.stitches;
  state.design.threads = snap.threads;
  bumpArt();
  state.edit.selected = -1; // o array foi substituído: o índice selecionado não é confiável
  if (state.undoStack.length === 0) $('t-undo').disabled = true;
  deriveBlocks();
  deriveStats();
  updateSidebar();
  updateStatusbar();
  requestRender();
}

// --------------------------------------------------------------- sidebar

function updateSidebar() {
  const s = state.stats;
  const info = $('info-list');
  const rows = [
    [tr('info.dimensions'), `${fmtMm(s.width)} × ${fmtMm(s.height)}`],
    [tr('info.stitches'), fmtNum(s.stitches)],
    [tr('info.colorChanges'), fmtNum(s.colorChanges)],
    [tr('info.jumps'), fmtNum(s.jumps)],
    [tr('info.trims'), fmtNum(s.trims)],
  ];
  if (s.stops > 0) rows.push([tr('info.stops'), fmtNum(s.stops)]);
  rows.push([tr('info.avgStitch'), fmtMm(s.avgLen)]);
  rows.push([tr('info.maxStitch'), fmtMm(s.maxLen)]);
  if (s.density > 0) rows.push([tr('info.density'), `${Math.round(s.density)} ${tr('unit.density')}`]);
  const fmt = state.design.format ? state.design.format.toUpperCase() : null;
  if (fmt) rows.push([tr('info.format'), fmt]);
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
    sw.title = tr('colors.tip');
    sw.addEventListener('change', () => {
      snapshotUndo();
      const t = state.design.threads[block.threadIndex];
      if (t) t.color = sw.value;
      else state.design.threads[block.threadIndex] = { color: sw.value };
      bumpArt();
      updateSidebar();
      requestRender();
    });
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${bi + 1}. ${threadLabel(block.threadIndex)}`;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = fmtNum(block.stitchCount);
    li.append(sw, name, count);
    list.appendChild(li);
  });

  const warnings = [];
  if (state.stats.longCount > 0) {
    warnings.push(tr('warn.long', { n: fmtNum(state.stats.longCount), len: fmtMm(state.settings.warnings.longStitchMm * 10) }));
  }
  if (hoopExceeded()) {
    const h = state.settings.hoop;
    warnings.push(tr('warn.hoop', { w: h.width, h: h.height }));
  }
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
    $('st-file').textContent = tr('status.noFile');
    $('st-size').textContent = '';
    $('st-stitches').textContent = '';
    $('st-edit').textContent = '';
    return;
  }
  const name = state.design.name || '·';
  $('st-file').textContent = (state.dirty ? '● ' : '') + name + (state.design.path ? ' · ' + state.design.path : '');
  $('st-size').textContent = `${fmtMm(state.stats.width)} × ${fmtMm(state.stats.height)}`;
  $('st-stitches').textContent = tr('status.stitches', { n: fmtNum(state.stats.stitches) });

  const sel = state.edit.active && state.edit.selected >= 0 && state.edit.selected < state.design.stitches.length
    ? state.edit.selected
    : -1;
  if (sel >= 0) {
    const st = state.design.stitches[sel];
    $('st-edit').textContent = tr('status.editPoint', {
      n: fmtNum(sel),
      cmd: cmdLabel(st[2]),
      x: fmtMm(st[0]),
      y: fmtMm(st[1]),
    });
  } else {
    $('st-edit').textContent = '';
  }
}

function updateToolbarEnabled() {
  const has = !!state.design;
  for (const id of ['btn-save', 'btn-export', 'btn-edit']) $(id).disabled = !has;
  // Simulação e edição de pontos são mutuamente exclusivas.
  const simEnabled = has && !state.edit.active;
  $('btn-sim').disabled = !simEnabled;
  $('sim-progress').disabled = !simEnabled;
}

// --------------------------------------------------------------- canvas

const canvas = $('cv');
const ctx = canvas.getContext('2d');
let dpr = window.devicePixelRatio || 1;

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  requestRender();
}

function requestRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    render();
  });
}

function toScreen(x, y) {
  return [x * state.view.scale + state.view.tx, y * state.view.scale + state.view.ty];
}

function toDesign(sx, sy) {
  return [(sx - state.view.tx) / state.view.scale, (sy - state.view.ty) / state.view.scale];
}

function fitView() {
  const rect = canvas.getBoundingClientRect();
  let minX;
  let minY;
  let maxX;
  let maxY;
  if (state.design && isFinite(state.stats.minX)) {
    minX = state.stats.minX;
    minY = state.stats.minY;
    maxX = state.stats.maxX;
    maxY = state.stats.maxY;
  } else {
    const h = state.settings.hoop;
    minX = (-h.width * 10) / 2;
    maxX = (h.width * 10) / 2;
    minY = (-h.height * 10) / 2;
    maxY = (h.height * 10) / 2;
  }
  const w = Math.max(maxX - minX, 10);
  const h = Math.max(maxY - minY, 10);
  const scale = Math.min((rect.width * 0.86) / w, (rect.height * 0.86) / h);
  state.view.scale = scale;
  state.view.tx = rect.width / 2 - ((minX + maxX) / 2) * scale;
  state.view.ty = rect.height / 2 - ((minY + maxY) / 2) * scale;
  updateZoomLabel();
  requestRender();
}

function updateZoomLabel() {
  // 100% = 10 px por mm (escala 1 no espaço de 0,1 mm).
  $('zoom-label').textContent = Math.round(state.view.scale * 100) + '%';
}

function zoomAt(cx, cy, factor) {
  const before = toDesign(cx, cy);
  state.view.scale = Math.min(80, Math.max(0.02, state.view.scale * factor));
  const after = toScreen(before[0], before[1]);
  state.view.tx += cx - after[0];
  state.view.ty += cy - after[1];
  updateZoomLabel();
  requestRender();
}

function drawGrid(rect) {
  const g = state.settings.grid;
  if (!g.show) return;
  const spacing = g.spacingMm * 10 * state.view.scale;
  if (spacing < 7) return; // grade densa demais nesse zoom
  const [dx0, dy0] = toDesign(0, 0);
  const [dx1, dy1] = toDesign(rect.width, rect.height);
  const step = g.spacingMm * 10;
  ctx.lineWidth = 1;
  const startX = Math.floor(dx0 / step) * step;
  const startY = Math.floor(dy0 / step) * step;
  for (let x = startX; x <= dx1; x += step) {
    const major = Math.round(x / step) % 5 === 0;
    ctx.strokeStyle = major ? 'rgba(232,230,225,0.10)' : 'rgba(232,230,225,0.045)';
    ctx.beginPath();
    const sx = Math.round(toScreen(x, 0)[0]) + 0.5;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, rect.height);
    ctx.stroke();
  }
  for (let y = startY; y <= dy1; y += step) {
    const major = Math.round(y / step) % 5 === 0;
    ctx.strokeStyle = major ? 'rgba(232,230,225,0.10)' : 'rgba(232,230,225,0.045)';
    ctx.beginPath();
    const sy = Math.round(toScreen(0, y)[1]) + 0.5;
    ctx.moveTo(0, sy);
    ctx.lineTo(rect.width, sy);
    ctx.stroke();
  }
  // Eixos na origem.
  ctx.strokeStyle = 'rgba(232,161,61,0.22)';
  const [ox, oy] = toScreen(0, 0);
  ctx.beginPath();
  ctx.moveTo(Math.round(ox) + 0.5, 0);
  ctx.lineTo(Math.round(ox) + 0.5, rect.height);
  ctx.moveTo(0, Math.round(oy) + 0.5);
  ctx.lineTo(rect.width, Math.round(oy) + 0.5);
  ctx.stroke();
}

function drawHoop() {
  const h = state.settings.hoop;
  if (!h.show) return;
  const w = h.width * 10;
  const ht = h.height * 10;
  const [x0, y0] = toScreen(-w / 2, -ht / 2);
  const [x1, y1] = toScreen(w / 2, ht / 2);
  const r = Math.min(60 * state.view.scale, (x1 - x0) / 6);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(155,152,143,0.55)';
  roundRect(ctx, x0, y0, x1 - x0, y1 - y0, r);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(155,152,143,0.28)';
  roundRect(ctx, x0 - 7, y0 - 7, x1 - x0 + 14, y1 - y0 + 14, r + 5);
  ctx.stroke();
  // Marcas centrais nas bordas.
  ctx.strokeStyle = 'rgba(155,152,143,0.5)';
  const [cx, cy] = toScreen(0, 0);
  const tick = 7;
  ctx.beginPath();
  ctx.moveTo(cx, y0);
  ctx.lineTo(cx, y0 + tick);
  ctx.moveTo(cx, y1);
  ctx.lineTo(cx, y1 - tick);
  ctx.moveTo(x0, cy);
  ctx.lineTo(x0 + tick, cy);
  ctx.moveTo(x1, cy);
  ctx.lineTo(x1 - tick, cy);
  ctx.stroke();
}

function roundRect(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// ------------------------------------------------------- realismo do fio

// Ajustes da técnica de 3 passadas (base escura, corpo, brilho deslocado).
const REALISTIC_DARK_AMOUNT = 0.35; // escurecimento da base larga
const REALISTIC_LIGHT_AMOUNT = 0.45; // clareamento do brilho
const REALISTIC_BASE_WIDTH_MUL = 1.15; // largura da base em relação ao fio
const REALISTIC_GLOW_WIDTH_MUL = 0.25; // largura do brilho em relação ao fio
const REALISTIC_GLOW_OFFSET_MUL = 0.3; // deslocamento perpendicular do brilho
const REALISTIC_GLOW_ALPHA = 0.8;

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [200, 200, 200];
  const num = parseInt(m[1], 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// Escurece/clareia uma cor hex no espaço RGB simples (sem HSL).
function darkenColor(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${clamp255(r * (1 - amount))}, ${clamp255(g * (1 - amount))}, ${clamp255(b * (1 - amount))})`;
}

function lightenColor(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${clamp255(r + (255 - r) * amount)}, ${clamp255(g + (255 - g) * amount)}, ${clamp255(b + (255 - b) * amount)})`;
}

// Desenha os pontos até "limit" usando a função de projeção dada.
// Compartilhado entre a tela e a exportação PNG.
function drawStitches(c, project, scale, limit, opts) {
  if (!state.design) return null;
  const stitches = state.design.stitches;
  const showJumps = opts.showJumps;
  const lineWidth = Math.max(state.settings.view.threadWidthMm * 10 * scale, opts.minLineWidth);
  c.lineCap = 'round';
  c.lineJoin = 'round';

  let color = state.blocks.length ? threadColor(state.blocks[0].threadIndex) : '#cccccc';
  let colorCount = 0;
  let penDown = false;
  let px = null;
  let py = null;
  let lastPos = null;
  const max = Math.min(limit, stitches.length);

  // ---- modo normal: um traço só por bloco de cor (rápido) ----
  if (!opts.realistic) {
    c.strokeStyle = color;
    c.lineWidth = lineWidth;
    c.beginPath();

    for (let i = 0; i < max; i++) {
      const st = stitches[i];
      const cmd = st[2] & COMMAND_MASK;
      if (cmd === STITCH || cmd === SEQUIN_EJECT) {
        const [sx, sy] = project(st[0], st[1]);
        if (!penDown || px === null) {
          c.moveTo(px === null ? sx : px, py === null ? sy : py);
          penDown = true;
        }
        c.lineTo(sx, sy);
        px = sx;
        py = sy;
        lastPos = [sx, sy];
      } else if (cmd === JUMP) {
        const [sx, sy] = project(st[0], st[1]);
        if (showJumps && px !== null) {
          c.stroke();
          c.save();
          c.strokeStyle = 'rgba(155,152,143,0.5)';
          c.lineWidth = Math.max(1, lineWidth * 0.4);
          c.setLineDash([5, 4]);
          c.beginPath();
          c.moveTo(px, py);
          c.lineTo(sx, sy);
          c.stroke();
          c.restore();
          c.strokeStyle = color;
          c.lineWidth = lineWidth;
          c.beginPath();
        }
        penDown = false;
        px = sx;
        py = sy;
        lastPos = [sx, sy];
      } else if (cmd === TRIM || cmd === STOP) {
        penDown = false;
      } else if (cmd === COLOR_CHANGE) {
        c.stroke();
        colorCount++;
        color = threadColor(colorCount);
        c.strokeStyle = color;
        c.lineWidth = lineWidth;
        c.beginPath();
        penDown = false;
      }
    }
    c.stroke();
    return lastPos;
  }

  // ---- modo realista: base escura + corpo + brilho deslocado (3 passadas) ----
  const glowOffset = lineWidth * REALISTIC_GLOW_OFFSET_MUL;
  const glowWidth = Math.max(lineWidth * REALISTIC_GLOW_WIDTH_MUL, 0.6);
  let mainPath = new Path2D();
  let glowPath = new Path2D();

  const flush = () => {
    c.strokeStyle = darkenColor(color, REALISTIC_DARK_AMOUNT);
    c.lineWidth = lineWidth * REALISTIC_BASE_WIDTH_MUL;
    c.stroke(mainPath);
    c.strokeStyle = color;
    c.lineWidth = lineWidth;
    c.stroke(mainPath);
    c.save();
    c.globalAlpha = REALISTIC_GLOW_ALPHA;
    c.strokeStyle = lightenColor(color, REALISTIC_LIGHT_AMOUNT);
    c.lineWidth = glowWidth;
    c.stroke(glowPath);
    c.restore();
    mainPath = new Path2D();
    glowPath = new Path2D();
  };

  for (let i = 0; i < max; i++) {
    const st = stitches[i];
    const cmd = st[2] & COMMAND_MASK;
    if (cmd === STITCH || cmd === SEQUIN_EJECT) {
      const [sx, sy] = project(st[0], st[1]);
      if (!penDown || px === null) {
        // Igual ao modo normal: o ponto parte da posição anterior (pós-salto).
        mainPath.moveTo(px === null ? sx : px, py === null ? sy : py);
      }
      mainPath.lineTo(sx, sy);
      if (px !== null) {
        const dx = sx - px;
        const dy = sy - py;
        const len = Math.hypot(dx, dy);
        if (len > 1e-6) {
          const nx = (-dy / len) * glowOffset;
          const ny = (dx / len) * glowOffset;
          glowPath.moveTo(px + nx, py + ny);
          glowPath.lineTo(sx + nx, sy + ny);
        }
      }
      penDown = true;
      px = sx;
      py = sy;
      lastPos = [sx, sy];
    } else if (cmd === JUMP) {
      const [sx, sy] = project(st[0], st[1]);
      if (showJumps && px !== null) {
        flush();
        c.save();
        c.strokeStyle = 'rgba(155,152,143,0.5)';
        c.lineWidth = Math.max(1, lineWidth * 0.4);
        c.setLineDash([5, 4]);
        c.beginPath();
        c.moveTo(px, py);
        c.lineTo(sx, sy);
        c.stroke();
        c.restore();
      }
      penDown = false;
      px = sx;
      py = sy;
      lastPos = [sx, sy];
    } else if (cmd === TRIM || cmd === STOP) {
      penDown = false;
    } else if (cmd === COLOR_CHANGE) {
      flush();
      colorCount++;
      color = threadColor(colorCount);
      penDown = false;
    }
  }
  flush();
  return lastPos;
}

// Garante um canvas offscreen com a arte realista pronta para a view atual;
// só refaz o desenho quando o design/view mudou e não há interação em curso.
function ensureRealisticCache() {
  if (!state.design) return null;
  let cache = state.realisticCache;
  const needFresh = !cache || cache.pxWidth !== canvas.width || cache.pxHeight !== canvas.height || cache.dpr !== dpr;
  if (needFresh) {
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    cache = state.realisticCache = {
      canvas: off,
      pxWidth: canvas.width,
      pxHeight: canvas.height,
      dpr,
      view: { scale: NaN, tx: NaN, ty: NaN },
      artVersion: NaN,
    };
  }
  const viewChanged =
    cache.view.scale !== state.view.scale || cache.view.tx !== state.view.tx || cache.view.ty !== state.view.ty;
  const contentChanged = cache.artVersion !== state.artVersion;
  if (!state.interacting && (needFresh || viewChanged || contentChanged)) {
    const octx = cache.canvas.getContext('2d');
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, cache.canvas.width, cache.canvas.height);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStitches(octx, toScreen, state.view.scale, state.design.stitches.length, {
      showJumps: state.settings.view.showJumps,
      minLineWidth: 1.1,
      realistic: true,
    });
    cache.view = { scale: state.view.scale, tx: state.view.tx, ty: state.view.ty };
    cache.artVersion = state.artVersion;
  }
  return cache;
}

// Compõe a arte realista cacheada na tela. Enquanto o usuário arrasta/dá
// zoom, reaproveita o bitmap antigo com um transform barato (sem redesenhar
// os pontos) para manter a interação fluida mesmo em designs grandes.
function renderRealisticCached() {
  const cache = ensureRealisticCache();
  if (!cache) return;
  const matches =
    cache.view.scale === state.view.scale && cache.view.tx === state.view.tx && cache.view.ty === state.view.ty;
  ctx.save();
  if (matches) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    const k = state.view.scale / cache.view.scale;
    const offsetX = dpr * (state.view.tx - k * cache.view.tx);
    const offsetY = dpr * (state.view.ty - k * cache.view.ty);
    ctx.setTransform(k, 0, 0, k, offsetX, offsetY);
  }
  ctx.drawImage(cache.canvas, 0, 0);
  ctx.restore();
}

// ------------------------------------------------------------- fundo de tecido
//
// Trama simples (tela) desenhada num tile procedural e repetida como pattern
// com a transformação da vista, para o desenho ficar "pousado" no tecido ao
// dar pan/zoom. As cores derivam da cor de fundo dos ajustes: escolher a cor
// do tecido é escolher a cor de fundo.
const fabric = { pattern: null, color: null };
const FABRIC_CELL_PX = 24; // px de um fio no tile
const FABRIC_UNITS_PER_CELL = 5; // um fio da trama a cada 0,5 mm (unidades de 0,1 mm)

function fabricShade(hex, delta) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, v + delta));
  return `rgb(${ch(n >> 16)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
}

function ensureFabricPattern(color) {
  if (fabric.pattern && fabric.color === color) return;
  const cell = FABRIC_CELL_PX;
  const cells = 4; // 4x4 fios por tile: o jitter não repete de forma óbvia
  const tile = document.createElement('canvas');
  tile.width = cell * cells;
  tile.height = cell * cells;
  const c = tile.getContext('2d');
  c.fillStyle = fabricShade(color, -14); // vão entre os fios
  c.fillRect(0, 0, tile.width, tile.height);
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const x = i * cell;
      const y = j * cell;
      const jitter = (((i * 7 + j * 13) % 5) - 2) * 3; // variação determinística
      const horizontal = (i + j) % 2 === 0;
      const g = horizontal
        ? c.createLinearGradient(0, y, 0, y + cell)
        : c.createLinearGradient(x, 0, x + cell, 0);
      g.addColorStop(0, fabricShade(color, -10 + jitter));
      g.addColorStop(0.45, fabricShade(color, 22 + jitter));
      g.addColorStop(1, fabricShade(color, -12 + jitter));
      c.fillStyle = g;
      const inset = Math.round(cell * 0.06);
      if (horizontal) c.fillRect(x, y + inset, cell, cell - inset * 2);
      else c.fillRect(x + inset, y, cell - inset * 2, cell);
    }
  }
  fabric.pattern = ctx.createPattern(tile, 'repeat');
  fabric.color = color;
}

function drawFabric(rect) {
  const color = state.settings.view.background;
  const k = (state.view.scale * FABRIC_UNITS_PER_CELL) / FABRIC_CELL_PX;
  // Muito afastado a trama viraria moiré: some gradualmente.
  const alpha = Math.max(0, Math.min(1, (FABRIC_CELL_PX * k - 1.2) / 2.4));
  if (alpha <= 0 || !isFinite(k) || k <= 0) return;
  ensureFabricPattern(color);
  fabric.pattern.setTransform(new DOMMatrix([k, 0, 0, k, state.view.tx, state.view.ty]));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = fabric.pattern;
  ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.restore();
}

// Agulhadas como pontinhos (toggle "Pontos" na toolbar): facilita mirar um
// ponto específico, principalmente no modo de edição.
function drawPoints(limit) {
  const r = Math.max(1.2, Math.min(3, state.view.scale * 0.55));
  // Contraste com o fundo: tecido claro pede ponto escuro.
  const n = parseInt(state.settings.view.background.slice(1), 16);
  const lum = 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  ctx.save();
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = lum > 140 ? '#1c1c22' : '#f2f2f5';
  const sts = state.design.stitches;
  for (let i = 0; i < limit; i++) {
    const cmd = sts[i][2] & COMMAND_MASK;
    if (cmd !== STITCH && cmd !== SEQUIN_EJECT) continue;
    const [px, py] = toScreen(sts[i][0], sts[i][1]);
    ctx.fillRect(px - r, py - r, r * 2, r * 2);
  }
  ctx.restore();
}

// --------------------------------------------------------------- linha do tempo
//
// Barra embaixo do canvas com um segmento por bloco de cor, proporcional à
// quantidade de pontos: mostra "que horas" entra cada linha. Clique/arrasto
// pula a simulação para aquele ponto.
function simSeekFraction(f) {
  if (!state.design) return;
  state.sim.playing = false;
  $('btn-sim').textContent = '▶';
  const clamped = Math.max(0, Math.min(1, f));
  state.sim.pos = clamped >= 1 ? Infinity : clamped * state.design.stitches.length;
  $('sim-progress').value = Math.round(clamped * 1000);
  requestRender();
}

function drawTimeline() {
  const bar = $('timeline');
  const shouldShow = !!state.design && state.blocks.length > 0;
  bar.hidden = !shouldShow;
  if (!shouldShow) return;
  const cv = $('timeline-canvas');
  const rect = cv.getBoundingClientRect();
  if (rect.width < 1) return;
  if (cv.width !== Math.round(rect.width * dpr) || cv.height !== Math.round(rect.height * dpr)) {
    cv.width = Math.round(rect.width * dpr);
    cv.height = Math.round(rect.height * dpr);
  }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, rect.width, rect.height);
  const total = state.design.stitches.length;
  for (const block of state.blocks) {
    const x = (block.start / total) * rect.width;
    const w = Math.max(((block.end - block.start) / total) * rect.width, 0.5);
    c.fillStyle = threadColor(block.threadIndex);
    c.fillRect(x, 0, w, rect.height);
  }
  c.fillStyle = 'rgba(0,0,0,0.35)';
  for (const block of state.blocks.slice(1)) {
    c.fillRect((block.start / total) * rect.width - 0.5, 0, 1, rect.height);
  }
  const simming = state.sim.pos !== Infinity;
  if (simming) {
    const x = (state.sim.pos / total) * rect.width;
    c.fillStyle = 'rgba(16,16,20,0.45)'; // esmaece o que ainda não foi costurado
    c.fillRect(x, 0, rect.width - x, rect.height);
    c.fillStyle = '#e8a13d';
    c.fillRect(x - 1, 0, 2.5, rect.height);
  }
  const pos = simming ? Math.floor(state.sim.pos) : total;
  $('timeline-count').textContent = `${fmtNum(pos)} / ${fmtNum(total)}`;
}

function render() {
  const rect = canvas.getBoundingClientRect();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = state.settings ? state.settings.view.background : '#101014';
  ctx.fillRect(0, 0, rect.width, rect.height);
  if (!state.settings) return;
  if (state.settings.view.fabric) drawFabric(rect);

  drawGrid(rect);
  drawHoop();

  if (state.design) {
    const simming = state.sim.pos !== Infinity;
    const limit = simming ? Math.floor(state.sim.pos) : state.design.stitches.length;
    const realistic = !!state.settings.view.realistic;
    let needle = null;
    if (realistic && !simming && !state.edit.active) {
      // Fora da simulação e da edição dá pra cachear a arte. No modo de
      // edição desenha ao vivo: arrastar um ponto muda a arte a cada frame
      // e o blit do cache mostraria o fio parado com o marcador andando.
      renderRealisticCached();
    } else {
      needle = drawStitches(ctx, toScreen, state.view.scale, limit, {
        showJumps: state.settings.view.showJumps,
        minLineWidth: 1.1,
        realistic,
      });
    }
    if (state.settings.view.showPoints) drawPoints(limit);
    // Agulha na simulação.
    if (simming && needle) {
      ctx.strokeStyle = '#e8a13d';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(needle[0] - 9, needle[1]);
      ctx.lineTo(needle[0] + 9, needle[1]);
      ctx.moveTo(needle[0], needle[1] - 9);
      ctx.lineTo(needle[0], needle[1] + 9);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(needle[0], needle[1], 4.2, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Marcador do ponto selecionado no modo de edição.
    if (state.edit.active && state.edit.selected >= 0 && state.edit.selected < state.design.stitches.length) {
      const st = state.design.stitches[state.edit.selected];
      const [px, py] = toScreen(st[0], st[1]);
      ctx.fillStyle = 'rgba(232,161,61,0.3)';
      ctx.strokeStyle = '#e8a13d';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  drawTimeline();
}

// --------------------------------------------------------------- simulação

function simSetPlaying(playing) {
  if (!state.design) return;
  if (playing && state.edit.active) setEditMode(false); // mutuamente exclusivo com a edição
  state.sim.playing = playing;
  $('btn-sim').textContent = playing ? '⏸' : '▶';
  if (playing) {
    if (state.sim.pos === Infinity || state.sim.pos >= state.design.stitches.length) {
      state.sim.pos = 0;
    }
    state.sim.lastT = performance.now();
    requestAnimationFrame(simTick);
  }
}

function simTick(t) {
  if (!state.sim.playing || !state.design) return;
  const dt = (t - state.sim.lastT) / 1000;
  state.sim.lastT = t;
  const sps = state.settings.sim.stitchesPerSecond;
  state.sim.pos += sps * dt;
  const total = state.design.stitches.length;
  if (state.sim.pos >= total) {
    state.sim.pos = Infinity;
    state.sim.playing = false;
    $('btn-sim').textContent = '▶';
    $('sim-progress').value = 1000;
    requestRender();
    return;
  }
  $('sim-progress').value = Math.round((state.sim.pos / total) * 1000);
  requestRender();
  requestAnimationFrame(simTick);
}

function simReset() {
  state.sim.pos = Infinity;
  state.sim.playing = false;
  $('btn-sim').textContent = '▶';
  $('sim-progress').value = 1000;
  requestRender();
}

// --------------------------------------------------------------- edição de pontos (issue #3)

// Liga/desliga o modo "Editar pontos". Mutuamente exclusivo com a simulação:
// entrar em edição pausa e reseta a simulação em andamento.
function setEditMode(active) {
  active = !!active && !!state.design;
  state.edit.active = active;
  $('btn-edit').classList.toggle('on', active);
  canvas.classList.toggle('edit-mode', active);
  if (active) simReset();
  updateToolbarEnabled();
  setSelectedStitch(-1);
}

function toggleEditMode() {
  if (!state.design) return;
  setEditMode(!state.edit.active);
}

function setSelectedStitch(index) {
  const valid = state.design && index >= 0 && index < state.design.stitches.length;
  state.edit.selected = valid ? index : -1;
  updateStatusbar();
  requestRender();
}

function selectedStitch() {
  if (!state.design || state.edit.selected < 0) return null;
  return state.design.stitches[state.edit.selected] || null;
}

// Chamado depois de qualquer mutação de ponto (mover, apagar, inserir).
function afterPointMutation() {
  bumpArt(); // invalida o cache do modo realista
  deriveStats();
  updateSidebar();
  updateStatusbar();
  requestRender();
}

function deleteSelectedStitch() {
  const i = state.edit.selected;
  if (!state.design || i < 0 || i >= state.design.stitches.length) return;
  snapshotUndo();
  state.design.stitches.splice(i, 1);
  state.edit.selected = -1;
  afterPointMutation();
}

// Insere um ponto STITCH no meio do segmento entre o ponto selecionado e o
// próximo (tecla I ou duplo clique). O novo ponto passa a ser o selecionado,
// permitindo subdividir o mesmo trecho repetidamente.
function insertAfterSelected() {
  const i = state.edit.selected;
  if (!state.design || i < 0 || i >= state.design.stitches.length - 1) return;
  snapshotUndo();
  const newIndex = Spatial.insertMidpoint(state.design.stitches, i);
  state.edit.selected = newIndex;
  afterPointMutation();
}

function nudgeSelectedStitch(dx, dy) {
  const st = selectedStitch();
  if (!st) return;
  snapshotUndo();
  st[0] += dx;
  st[1] += dy;
  afterPointMutation();
}

// --------------------------------------------------------------- transformações

function applyToStitches(fn) {
  if (!state.design) return;
  snapshotUndo();
  for (const st of state.design.stitches) {
    const [x, y] = fn(st[0], st[1]);
    st[0] = x;
    st[1] = y;
  }
  bumpArt();
  deriveStats();
  updateSidebar();
  updateStatusbar();
  requestRender();
}

function designCenter() {
  if (!state.stats) return [0, 0];
  const s = state.stats;
  return [(s.minX + s.maxX) / 2, (s.minY + s.maxY) / 2];
}

function centerToOrigin() {
  const [cx, cy] = designCenter();
  applyToStitches((x, y) => [Math.round(x - cx), Math.round(y - cy)]);
  fitView();
  toast(tr('toast.centered'));
}

function rotate90(clockwise) {
  const [cx, cy] = designCenter();
  applyToStitches((x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    return clockwise ? [cx - dy, cy + dx] : [cx + dy, cy - dx];
  });
  fitView();
}

function flip(horizontal) {
  const [cx, cy] = designCenter();
  applyToStitches((x, y) => (horizontal ? [2 * cx - x, y] : [x, 2 * cy - y]));
}

function scaleDesign(factor) {
  const [cx, cy] = designCenter();
  applyToStitches((x, y) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
  fitView();
  if (Math.abs(factor - 1) > 0.2) {
    toast(tr('toast.scaleWarn'), 'warn', 4600);
  }
}

// Como scaleDesign, mas recalcula a densidade das corridas de ponto cheio
// (issue #4, v1) em vez de só escalar as coordenadas. Substitui o array de
// agulhadas por inteiro (o tamanho muda), por isso não usa applyToStitches.
function scaleDesignWithDensity(factor) {
  if (!state.design) return;
  const { detectSatinRuns, rescaleWithDensity } = window.DensityScale;
  const [cx, cy] = designCenter();
  snapshotUndo();
  const runs = detectSatinRuns(state.design.stitches);
  state.design.stitches = rescaleWithDensity(state.design.stitches, factor, { center: [cx, cy] });
  bumpArt(); // invalida o cache do modo realista (integração dos PRs #9 e #10)
  deriveBlocks();
  deriveStats();
  updateSidebar();
  updateStatusbar();
  fitView();
  requestRender();
  toast(tr('toast.densityRescaled', { n: fmtNum(runs.length) }));
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
      extra = tr('toast.noColors', { fmt: upper });
    }
    toast(tr('toast.saved', { fmt: upper, name: state.design.name }) + extra);
  } catch (err) {
    toast(tr('toast.saveError') + err.message, 'error', 5000);
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
    drawStitches(oc, (x, y) => [x * scale + tx, y * scale + ty], scale, Infinity, {
      showJumps: false,
      minLineWidth: 1,
      realistic: !!state.settings.view.realistic,
    });
    await window.api.writePng(filePath, off.toDataURL('image/png'));
    toast(tr('toast.exported') + filePath.split('/').pop());
  } catch (err) {
    toast(tr('toast.exportError') + err.message, 'error', 5000);
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
    toast(tr('toast.openError') + err.message, 'error', 5000);
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
    opt.textContent = preset.labelKey ? tr(preset.labelKey) : preset.label;
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
  $('set-warnlong').value = s.warnings.longStitchMm;
  $('set-librarypath').value = s.library.path;
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
    hoop: { show: $('set-hoopshow').checked, preset: presetKey, width, height },
    grid: { show: $('set-gridshow').checked, spacingMm: clampNum($('set-gridspacing').value, 1, 100, 10) },
    write: {
      limitStitchLength: $('set-limitstitch').checked,
      maxStitchMm: clampNum($('set-maxstitch').value, 1, 12.7, 12.1),
      tieOn: $('set-tieon').checked,
      tieOff: $('set-tieoff').checked,
      trimAtJumps: Math.round(clampNum($('set-trimat').value, 2, 8, 3)),
    },
    warnings: { longStitchMm: clampNum($('set-warnlong').value, 1, 30, 12.1) },
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
  if (langChanged) applyI18n();
  $('sim-speed').value = String(nearestSimOption(state.settings.sim.stitchesPerSecond));
  if (state.design) {
    deriveStats();
    updateSidebar();
  }
  updateStatusbar();
  requestRender();
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

function fmtBytesLocal(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const decimals = value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[i]}`;
}

function designThreadColor(design, i) {
  const t = design.threads && design.threads[i];
  return t && t.color ? t.color : FILLER_COLORS[i % FILLER_COLORS.length];
}

function designBounds(design) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const st of design.stitches) {
    const cmd = st[2] & COMMAND_MASK;
    if (cmd === STITCH || cmd === JUMP || cmd === SEQUIN_EJECT) {
      if (st[0] < minX) minX = st[0];
      if (st[0] > maxX) maxX = st[0];
      if (st[1] < minY) minY = st[1];
      if (st[1] > maxY) maxY = st[1];
    }
  }
  return { minX, minY, maxX, maxY };
}

function countStitches(design) {
  let n = 0;
  for (const st of design.stitches) {
    if ((st[2] & COMMAND_MASK) === STITCH) n++;
  }
  return n;
}

// Miniatura num canvas pequeno, com a mesma lógica de polilinha do desenho
// principal (drawStitches: moveTo só no primeiro ponto após a pena levantada
// por salto/corte/parada/troca de cor, o resto encadeia com lineTo) — só que
// operando sobre um "design" qualquer, não o state.design global.
function drawDesignThumbnail(canvas, design, size = 72) {
  drawDesignInto(canvas, design, size, size, 6);
}

// Desenha um "design" qualquer num canvas de tamanho arbitrário (miniaturas
// do pendrive e da biblioteca, prévia da digitalização), com a mesma lógica
// de polilinha do desenho principal.
function drawDesignInto(canvas, design, cssW, cssH, margin) {
  const localDpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(cssW * localDpr));
  canvas.height = Math.max(1, Math.round(cssH * localDpr));
  const c = canvas.getContext('2d');
  c.setTransform(localDpr, 0, 0, localDpr, 0, 0);
  c.clearRect(0, 0, cssW, cssH);

  const stitches = design.stitches;
  const b = designBounds(design);
  if (!stitches.length || !isFinite(b.minX)) return;
  const w = Math.max(b.maxX - b.minX, 1);
  const h = Math.max(b.maxY - b.minY, 1);
  const scale = Math.min((cssW - margin * 2) / w, (cssH - margin * 2) / h);
  const tx = cssW / 2 - ((b.minX + b.maxX) / 2) * scale;
  const ty = cssH / 2 - ((b.minY + b.maxY) / 2) * scale;
  const project = (x, y) => [x * scale + tx, y * scale + ty];

  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.lineWidth = Math.max(0.9, scale * 0.4);

  let colorIndex = 0;
  c.strokeStyle = designThreadColor(design, colorIndex);
  c.beginPath();
  let penDown = false;
  let px = null;
  let py = null;
  for (const st of stitches) {
    const cmd = st[2] & COMMAND_MASK;
    if (cmd === STITCH || cmd === SEQUIN_EJECT) {
      const [sx, sy] = project(st[0], st[1]);
      if (!penDown || px === null) c.moveTo(px === null ? sx : px, py === null ? sy : py);
      c.lineTo(sx, sy);
      px = sx;
      py = sy;
      penDown = true;
    } else if (cmd === JUMP) {
      const [sx, sy] = project(st[0], st[1]);
      penDown = false;
      px = sx;
      py = sy;
    } else if (cmd === TRIM || cmd === STOP) {
      penDown = false;
    } else if (cmd === COLOR_CHANGE) {
      c.stroke();
      colorIndex++;
      c.strokeStyle = designThreadColor(design, colorIndex);
      c.beginPath();
      penDown = false;
    }
  }
  c.stroke();
}

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
  meta.textContent = fmtBytesLocal(item.sizeBytes);
  info.append(name, meta);

  li.append(checkbox, thumb, info);
  li.addEventListener('dblclick', () => openDesignFromDriveManager(item.path));

  Promise.resolve(peekDriveDesign(item)).then((entry) => {
    if (entry.ok) {
      drawDesignThumbnail(thumb, entry.design);
      meta.textContent = `${fmtBytesLocal(item.sizeBytes)} · ${tr('status.stitches', { n: fmtNum(countStitches(entry.design)) })}`;
    } else {
      meta.textContent = `${fmtBytesLocal(item.sizeBytes)} · ${tr('drv.parseError')}`;
    }
  });

  return li;
}

function renderDriveList(listEl, items, side) {
  listEl.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'drive-empty';
    li.textContent = tr(side === 'library' ? 'drv.emptyLibrary' : 'drv.emptyDrive');
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
      ? tr('drv.freeOf', { free: fmtBytesLocal(drive.freeBytes), total: fmtBytesLocal(drive.capacityBytes) })
      : tr('drv.unknownSpace');
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
    opt.textContent = tr('drv.noDrive');
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
    toast(tr('drv.noDriveSelected'), 'warn');
    return;
  }
  let results = await window.api.copyDesigns(sources, destDir, false);
  const conflicts = results.filter((r) => r.status === 'conflict');
  if (conflicts.length) {
    const ok = await confirmDialog({
      title: tr('drv.confirmOverwriteTitle'),
      message: tr('drv.confirmOverwriteMsg', { n: conflicts.length, names: conflicts.map((c) => c.name).join(', ') }),
      okLabel: tr('drv.confirmOverwriteOk'),
    });
    if (!ok) {
      const copiedCount = results.filter((r) => r.status === 'copied').length;
      toast(tr('drv.copyPartial', { n: copiedCount }));
      await refreshDriveSide(toSide);
      return;
    }
    results = await window.api.copyDesigns(sources, destDir, true);
  }
  const copiedCount = results.filter((r) => r.status === 'copied').length;
  toast(tr('drv.copyDone', { n: copiedCount }));
  await refreshDriveSide(toSide);
}

async function deleteSelectedFromDrive() {
  const sources = [...state.drives.selection.drive];
  if (!sources.length) return;
  const ok = await confirmDialog({
    title: tr('drv.confirmDeleteTitle'),
    message: tr('drv.confirmDeleteMsg', { n: sources.length }),
    okLabel: tr('drv.confirmDeleteOk'),
  });
  if (!ok) return;
  const results = await window.api.deleteFromDrive(sources, state.drives.selectedMount);
  const okCount = results.filter((r) => r.ok).length;
  toast(tr('drv.deleteDone', { n: okCount }));
  await refreshDrivePane();
}

async function ejectSelectedDrive() {
  const mount = state.drives.selectedMount;
  if (!mount) return;
  try {
    await window.api.ejectDrive(mount);
    toast(tr('drv.ejected'));
    await refreshDriveSelectList();
  } catch (err) {
    toast(tr('drv.ejectError') + err.message, 'error', 5000);
  }
}

async function cleanHiddenOnDrive() {
  const mount = state.drives.selectedMount;
  if (!mount) return;
  const count = await window.api.cleanHiddenFiles(mount);
  toast(tr('drv.cleanDone', { n: count }));
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
  drawDesignThumbnail(off, peeked.design, 84);
  const dataURL = off.toDataURL('image/png');
  window.api.libraryThumbSave(item.path, item.mtime, dataURL); // best-effort, não bloqueia a UI
  return dataURL;
}

function paintLibraryThumb(canvasEl, dataURL) {
  const img = new Image();
  img.onload = () => {
    if (!canvasEl.isConnected) return; // item já saiu da janela virtualizada
    const dpr = window.devicePixelRatio || 1;
    canvasEl.width = 84 * dpr;
    canvasEl.height = 84 * dpr;
    const c = canvasEl.getContext('2d');
    c.clearRect(0, 0, canvasEl.width, canvasEl.height);
    c.drawImage(img, 0, 0, canvasEl.width, canvasEl.height);
  };
  img.src = dataURL;
}

function ensureLibraryThumb(canvasEl, item) {
  const key = libraryThumbCacheKey(item);
  let entry = state.library.thumbCache.get(key);
  if (!entry) {
    entry = scheduleThumbJob(() => loadOrBuildLibraryThumb(item));
    state.library.thumbCache.set(key, entry);
  }
  entry.then((dataURL) => {
    if (dataURL) paintLibraryThumb(canvasEl, dataURL);
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
  containerEl.appendChild(buildLibTreeRow('', tr('lib.root'), 0, opts));
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
    containerEl.innerHTML = `<div class="lib-tree-empty">${tr('lib.loadingFolders')}</div>`;
    subs = await window.api.libraryListSubfolders(relDir);
    opts.childrenCache.set(relDir, subs);
  }
  containerEl.innerHTML = '';
  if (!subs.length) {
    const empty = document.createElement('div');
    empty.className = 'lib-tree-empty';
    empty.textContent = tr('lib.emptyFolder');
    containerEl.appendChild(empty);
    return;
  }
  for (const sub of subs) {
    containerEl.appendChild(buildLibTreeRow(sub.relDir, sub.name, depth, opts));
    if (opts.expanded.has(sub.relDir)) {
      const wrap = document.createElement('div');
      wrap.className = 'lib-tree-children';
      containerEl.appendChild(wrap);
      await renderLibTreeChildrenInto(wrap, sub.relDir, depth + 1, opts);
    }
  }
}

function buildLibTreeRow(relDir, label, depth, opts) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lib-tree-node' + (relDir === opts.selectedRelDir ? ' selected' : '');
  btn.style.paddingLeft = 8 + depth * 14 + 'px';
  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.textContent = opts.expanded.has(relDir) ? '▾' : '▸';
  twisty.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (opts.expanded.has(relDir)) opts.expanded.delete(relDir);
    else opts.expanded.add(relDir);
    await opts.rerender();
  });
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
  const { files } = await window.api.libraryListFolder(relDir);
  if (token !== state.library.loadToken) return;
  state.library.searching = false;
  state.library.truncated = false;
  await setLibraryBaseItems(files);
}

async function runLibrarySearch(query) {
  const token = ++state.library.loadToken;
  state.library.searching = true;
  const { items, truncated } = await window.api.librarySearch(query);
  if (token !== state.library.loadToken) return;
  state.library.truncated = truncated;
  await setLibraryBaseItems(items);
}

async function setLibraryBaseItems(rawItems) {
  state.library.baseItems = rawItems;
  await applyLibraryFilters();
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

// Filtros de dimensão/pontos exigem metadado de cabeçalho (peekDesign), que
// não existe em massa sem parsear cada arquivo — viável aqui porque o
// conjunto já está limitado a uma pasta ou a um resultado de busca com teto
// (nunca ao catálogo inteiro de 10-15 mil arquivos).
async function applyLibraryFilters() {
  const f = state.library.filters;
  let items = state.library.baseItems;
  if (f.format) items = items.filter((it) => it.ext === f.format);
  if (f.favoritesOnly) items = items.filter((it) => state.library.favorites.has(it.path));

  const needsPeek = f.minW != null || f.maxW != null || f.minH != null || f.maxH != null || f.minS != null || f.maxS != null;
  if (needsPeek) {
    const token = state.library.loadToken;
    const peeked = await Promise.all(items.map((it) => Promise.resolve(peekDriveDesign(it)).then((r) => ({ it, r }))));
    if (token !== state.library.loadToken) return;
    items = peeked
      .filter(({ r }) => r.ok)
      .filter(({ r }) => {
        const b = designBounds(r.design);
        const wMm = (b.maxX - b.minX) / 10;
        const hMm = (b.maxY - b.minY) / 10;
        const stitches = countStitches(r.design);
        if (f.minW != null && wMm < f.minW) return false;
        if (f.maxW != null && wMm > f.maxW) return false;
        if (f.minH != null && hMm < f.minH) return false;
        if (f.maxH != null && hMm > f.maxH) return false;
        if (f.minS != null && stitches < f.minS) return false;
        if (f.maxS != null && stitches > f.maxS) return false;
        return true;
      })
      .map(({ it }) => it);
  }

  state.library.items = items;
  updateLibraryEmptyState();
  requestLibraryGridRender();
}

function updateLibraryEmptyState() {
  const empty = state.library.items.length === 0;
  $('lib-empty').hidden = !empty;
  $('lib-empty').textContent = state.library.searching ? tr('lib.emptySearch') : tr('lib.empty');
  $('lib-truncated').hidden = !state.library.truncated;
}

// ---- grade virtualizada ----

const LIB_ITEM_WIDTH = 108;
const LIB_ITEM_HEIGHT = 172;
const LIB_GRID_GAP = 10;
const LIB_BUFFER_ROWS = 2;

function libraryGridCols() {
  const viewport = $('lib-grid-viewport');
  const width = Math.max(0, viewport.clientWidth - 20);
  return Math.max(1, Math.floor((width + LIB_GRID_GAP) / (LIB_ITEM_WIDTH + LIB_GRID_GAP)));
}

function renderLibraryGrid() {
  const viewport = $('lib-grid-viewport');
  const items = state.library.items;
  const cols = libraryGridCols();
  const rowHeight = LIB_ITEM_HEIGHT + LIB_GRID_GAP;
  const rows = Math.ceil(items.length / cols);
  $('lib-grid-spacer').style.height = Math.max(rows * rowHeight, 1) + 'px';

  const inner = $('lib-grid-inner');
  inner.style.gridTemplateColumns = `repeat(${cols}, ${LIB_ITEM_WIDTH}px)`;
  inner.style.gap = LIB_GRID_GAP + 'px';

  const scrollTop = viewport.scrollTop;
  const viewHeight = viewport.clientHeight;
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - LIB_BUFFER_ROWS);
  const lastRow = Math.min(rows - 1, Math.ceil((scrollTop + viewHeight) / rowHeight) + LIB_BUFFER_ROWS);

  inner.style.transform = `translateY(${firstRow * rowHeight}px)`;
  inner.innerHTML = '';
  for (let r = firstRow; r <= lastRow; r++) {
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

function buildLibAct(glyph, title, onClick, danger) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lib-act' + (danger ? ' danger' : '');
  btn.textContent = glyph;
  btn.title = title;
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
  favBtn.title = tr('lib.actionFavorite');
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
  meta.textContent = state.library.searching ? libRelDirParent(item.relPath) || tr('lib.root') : fmtBytesLocal(item.sizeBytes);
  meta.title = meta.textContent;

  el.append(thumbWrap, name, meta);

  if (!state.library.searching) {
    Promise.resolve(peekDriveDesign(item)).then((entry) => {
      if (!el.isConnected) return;
      meta.textContent = entry.ok
        ? `${fmtBytesLocal(item.sizeBytes)} · ${tr('status.stitches', { n: fmtNum(countStitches(entry.design)) })}`
        : `${fmtBytesLocal(item.sizeBytes)} · ${tr('drv.parseError')}`;
      meta.title = meta.textContent;
    });
  }

  if (state.library.mode === 'open') {
    const actions = document.createElement('div');
    actions.className = 'lib-item-actions';
    actions.append(
      buildLibAct('▶', tr('lib.actionOpen'), () => openLibraryItem(item)),
      buildLibAct('⌂', tr('lib.actionReveal'), () => window.api.showItemInFolder(item.path)),
      buildLibAct('→', tr('lib.actionDrive'), () => copyLibraryItemToDrive(item)),
      buildLibAct('✎', tr('lib.actionRename'), () => openLibraryRename(item)),
      buildLibAct('⇒', tr('lib.actionMove'), () => openLibraryMove(item)),
      buildLibAct('✕', tr('lib.actionDelete'), () => deleteLibraryItem(item), true)
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
    toast(tr('lib.toastNoDrive'), 'warn');
    return;
  }
  let results = await window.api.copyDesigns([item.path], mount, false);
  if (results[0].status === 'conflict') {
    const ok = await confirmDialog({
      title: tr('drv.confirmOverwriteTitle'),
      message: tr('drv.confirmOverwriteMsg', { n: 1, names: item.name }),
      okLabel: tr('drv.confirmOverwriteOk'),
    });
    if (!ok) return;
    results = await window.api.copyDesigns([item.path], mount, true);
  }
  if (results[0].status === 'copied') toast(tr('lib.toastCopiedToDrive', { name: item.name }));
  else if (results[0].status === 'error') toast(tr('lib.toastCopyError') + results[0].error, 'error', 5000);
}

async function deleteLibraryItem(item) {
  const ok = await confirmDialog({
    title: tr('lib.confirmDeleteTitle'),
    message: tr('lib.confirmDeleteMsg', { name: item.name }),
    okLabel: tr('lib.confirmDeleteOk'),
  });
  if (!ok) return;
  try {
    await window.api.libraryTrash(item.path);
    toast(tr('lib.toastDeleted', { name: item.name }));
    await reloadLibraryView();
  } catch (err) {
    toast(tr('lib.toastDeleteError') + err.message, 'error', 5000);
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
    toast(tr('lib.toastRenamed', { name: newName }));
    await reloadLibraryView();
  } catch (err) {
    toast(tr('lib.toastRenameError') + err.message, 'error', 5000);
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
    toast(tr('lib.toastMoved', { name: item.name }));
    $('dlg-lib-move').close();
    await reloadLibraryView();
  } catch (err) {
    toast(tr('lib.toastMoveError') + err.message, 'error', 5000);
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
    opt.textContent = tr('lib.noDriveOption');
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
  first.textContent = tr('lib.filterFormatAll');
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
  $('lib-save-target').textContent = relDir ? relDir : tr('lib.root');
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
  $('library-title').textContent = tr('lib.titleOpen');
  $('lib-footer-open').hidden = false;
  $('lib-footer-save').hidden = true;
  populateLibraryFormatFilterSelect();
  await openLibraryCommon();
}

async function openLibrarySaveDialog() {
  state.library.mode = 'save';
  $('dlg-library').classList.add('mode-save');
  $('library-title').textContent = tr('lib.titleSave');
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
    toast(tr('lib.toastNameRequired'), 'warn');
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
    toast(tr('lib.toastSaved', { name: fileName }));
    closeLibraryDialog();
  } catch (err) {
    toast(tr('lib.toastSaveError') + err.message, 'error', 5000);
  }
}

function bindLibraryDialog() {
  $('library-close').addEventListener('click', closeLibraryDialog);
  $('dlg-library').addEventListener('close', () => {
    if (state.library.driveRefreshTimer) {
      clearInterval(state.library.driveRefreshTimer);
      state.library.driveRefreshTimer = null;
    }
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

function populateTextFontSelect() {
  const sel = $('text-font');
  sel.innerHTML = '';
  for (const f of state.lettering.fonts) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.label;
    sel.appendChild(opt);
  }
  const hershey = state.lettering.fonts.find((f) => f.id.includes('Hershey'));
  if (hershey) sel.value = hershey.id;
}

function readTextFormOpts() {
  return {
    fontId: $('text-font').value,
    text: $('text-input').value,
    heightMm: clampNum($('text-height').value, 2, 200, 10),
    letterSpacing: clampNum($('text-letterspacing').value, -20, 300, 0),
    lineSpacing: clampNum($('text-linespacing').value, -20, 300, 0),
    stitchLengthMm: clampNum($('text-stitchlen').value, 0.5, 6, 2),
    bean: $('text-bean').checked,
  };
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
    clearTextPreview(tr('text.previewEmpty'));
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
    clearTextPreview(tr('text.previewEmpty'));
    $('text-stats').textContent = '';
    $('text-missing').hidden = true;
    return;
  }
  const result = await window.api.letteringBuild(readTextFormOpts());
  if (!result.ok) {
    state.lettering.lastResult = null;
    clearTextPreview(tr('text.previewEmpty'));
    $('text-stats').textContent = '';
    $('text-missing').hidden = true;
    toast(tr('toast.textError') + result.error, 'error', 4200);
    return;
  }
  state.lettering.lastResult = result;
  drawTextPreview(result);
  const opt = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  const w = ((result.bounds[2] - result.bounds[0]) / 10).toLocaleString(locale(), opt);
  const h = ((result.bounds[3] - result.bounds[1]) / 10).toLocaleString(locale(), opt);
  $('text-stats').textContent = tr('text.stats', { n: fmtNum(result.stats.stitches), w, h });
  if (result.missingChars.length) {
    $('text-missing').hidden = false;
    $('text-missing').textContent = tr('text.missingChars', { chars: result.missingChars.join(' ') });
  } else {
    $('text-missing').hidden = true;
  }
}

// Redesenha o resultado mais recente, ou a mensagem de "vazio" — usado tanto
// ao abrir o diálogo quanto pelo ResizeObserver (redimensionar o <canvas>
// via .width/.height sempre limpa o conteúdo, mesmo quando o tamanho não mudou).
function redrawTextPreview() {
  if (state.lettering.lastResult) drawTextPreview(state.lettering.lastResult);
  else clearTextPreview(tr('text.previewEmpty'));
}

function openTextDialog() {
  $('dlg-text').showModal();
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
    toast(tr('toast.textEmpty'), 'warn');
    return;
  }
  const result = await window.api.letteringBuild(readTextFormOpts());
  if (!result.ok) {
    toast(tr('toast.textError') + result.error, 'error', 4200);
    return;
  }
  const textDesign = result.design;
  if (!textDesign.stitches.length) {
    toast(tr('toast.textEmpty'), 'warn');
    return;
  }

  if (!state.design) {
    setDesign(textDesign);
    toast(tr('toast.textCreated'));
  } else {
    snapshotUndo();
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
    bumpArt();
    deriveBlocks();
    deriveStats();
    updateSidebar();
    updateStatusbar();
    requestRender();
    toast(tr('toast.textInserted'));
  }
  $('dlg-text').close();
}

// --------------------------------------------------------------- interação

function bindCanvas() {
  const wrap = $('canvas-wrap');
  new ResizeObserver(resizeCanvas).observe(wrap);

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
    zoomAt(cx, cy, factor);
    clearTimeout(wheelIdleTimer);
    wheelIdleTimer = setTimeout(() => {
      state.interacting = false;
      requestRender();
    }, 180);
  }, { passive: false });

  let panning = false;
  let lastX = 0;
  let lastY = 0;
  let dragIndex = -1; // ponto sendo arrastado no modo de edição (-1 = nenhum)
  let dragMoved = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (state.edit.active) {
      const rect = canvas.getBoundingClientRect();
      const [dx, dy] = toDesign(e.clientX - rect.left, e.clientY - rect.top);
      const maxDist = EDIT_PICK_RADIUS_PX / state.view.scale;
      const idx = Spatial.nearestStitch(state.design.stitches, dx, dy, maxDist);
      setSelectedStitch(idx);
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
    const [dx, dy] = toDesign(e.clientX - rect.left, e.clientY - rect.top);
    const opts = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
    $('st-pos').textContent =
      `x ${(dx / 10).toLocaleString(locale(), opts)}  y ${(dy / 10).toLocaleString(locale(), opts)} mm`;
    if (dragIndex !== -1) {
      if (!dragMoved) {
        snapshotUndo(); // só antes do primeiro movimento do arraste, não a cada pixel
        dragMoved = true;
      }
      const st = state.design.stitches[dragIndex];
      st[0] = Math.round(dx);
      st[1] = Math.round(dy);
      afterPointMutation();
      return;
    }
    if (!panning) return;
    state.view.tx += e.clientX - lastX;
    state.view.ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    requestRender();
  });
  const stopPan = (e) => {
    panning = false;
    dragIndex = -1;
    dragMoved = false;
    canvas.classList.remove('panning');
    if (state.interacting) {
      state.interacting = false;
      requestRender(); // reconstrói o cache realista já parado, com nitidez
    }
  };
  canvas.addEventListener('pointerup', stopPan);
  canvas.addEventListener('pointercancel', stopPan);
  canvas.addEventListener('dblclick', () => {
    if (state.edit.active) insertAfterSelected();
    else fitView();
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
  $('btn-fit').addEventListener('click', fitView);
  $('btn-zoom-in').addEventListener('click', () => zoomCenter(1.3));
  $('btn-zoom-out').addEventListener('click', () => zoomCenter(1 / 1.3));
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
      requestRender();
      await window.api.setSettings(state.settings);
    });
  }

  $('btn-edit').addEventListener('click', toggleEditMode);

  $('btn-sim').addEventListener('click', () => simSetPlaying(!state.sim.playing));
  $('sim-progress').addEventListener('input', () => {
    if (!state.design) return;
    state.sim.playing = false;
    $('btn-sim').textContent = '▶';
    const v = Number($('sim-progress').value);
    state.sim.pos = v >= 1000 ? Infinity : (v / 1000) * state.design.stitches.length;
    requestRender();
  });
  const tlSeek = (e) => {
    const r = $('timeline-canvas').getBoundingClientRect();
    simSeekFraction((e.clientX - r.left) / r.width);
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
  $('t-scale').addEventListener('click', openScaleDialog);
}

function zoomCenter(factor) {
  const rect = canvas.getBoundingClientRect();
  zoomAt(rect.width / 2, rect.height / 2, factor);
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
    `${fmtMm(s.width)} × ${fmtMm(s.height)}  →  ${fmtMm((s.width * pct) / 100)} × ${fmtMm((s.height * pct) / 100)}`;
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
  for (const id of ['text-input', 'text-height', 'text-letterspacing', 'text-linespacing', 'text-stitchlen']) {
    $(id).addEventListener('input', scheduleTextPreview);
  }
  $('text-font').addEventListener('change', scheduleTextPreview);
  $('text-bean').addEventListener('change', scheduleTextPreview);
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
  if (state.design && !confirm(tr('svgimport.confirmReplace'))) return;
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
      if (rect.width > 0) drawDesignInto(cv, res.design, rect.width, rect.height, 10);
      let n = 0;
      for (const st of res.design.stitches) {
        if ((st[2] & COMMAND_MASK) === STITCH) n++;
      }
      $('svgimport-stats').textContent =
        res.widthMm.toFixed(0) + ' × ' + res.heightMm.toFixed(0) + ' mm · ' +
        tr('dig.previewStats', { n: fmtNum(n), c: res.design.threads.length });
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
    toast(tr('toast.svgImported', { name: picked.name }));
  } catch (err) {
    toast(tr('toast.svgImportError') + err.message, 'error', 5000);
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
}

function bindMenuAndKeys() {
  window.api.onMenu((action) => {
    const actions = {
      open: openViaDialog,
      'save-as': saveAs,
      'export-png': exportPng,
      settings: openSettings,
      undo,
      center: centerToOrigin,
      scale: openScaleDialog,
      'rotate-cw': () => rotate90(true),
      'rotate-ccw': () => rotate90(false),
      'flip-h': () => flip(true),
      'flip-v': () => flip(false),
      fit: fitView,
      'zoom-in': () => zoomCenter(1.3),
      'zoom-out': () => zoomCenter(1 / 1.3),
      'toggle-grid': () => $('btn-grid').click(),
      'toggle-hoop': () => $('btn-hoop').click(),
      'toggle-jumps': () => $('btn-jumps').click(),
      'sim-toggle': () => simSetPlaying(!state.sim.playing),
      'sim-reset': simReset,
      formats: () => $('dlg-formats').showModal(),
      'digitize-image': openDigitizeDialog,
    };
    if (state.design || ['open', 'settings', 'formats', 'digitize-image'].includes(action)) {
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

    // Atalhos exclusivos do modo de edição de pontos (issue #3).
    if (state.edit.active) {
      if (key === 'escape') {
        setSelectedStitch(-1);
        return;
      }
      if (key === 'delete' || key === 'backspace') {
        e.preventDefault();
        deleteSelectedStitch();
        return;
      }
      if (key === 'i') {
        insertAfterSelected();
        return;
      }
      if (key.startsWith('arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const deltas = { arrowup: [0, -step], arrowdown: [0, step], arrowleft: [-step, 0], arrowright: [step, 0] };
        nudgeSelectedStitch(deltas[key][0], deltas[key][1]);
        return;
      }
    }

    if (key === ' ') {
      e.preventDefault();
      simSetPlaying(!state.sim.playing);
    } else if (key === 'e' && !e.metaKey && !e.ctrlKey) toggleEditMode(); // Cmd/Ctrl+E é o acelerador de exportar PNG
    else if (key === 'g') $('btn-grid').click();
    else if (key === 'b') $('btn-hoop').click();
    else if (key === 'j') $('btn-jumps').click();
    else if (key === '0') fitView();
    else if (key === '+' || key === '=') zoomCenter(1.3);
    else if (key === '-') zoomCenter(1 / 1.3);
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
    txt += ' · ' + tr('dig.previewStats', { n: fmtNum(n), c: previewDesign.threads.length });
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
      if (rect.width > 0) drawDesignInto(cv, design, rect.width, rect.height, 10);
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
    toast(tr('dig.openError') + err.message, 'error', 5000);
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
    toast(tr('dig.openError') + err.message, 'error', 5000);
  }
}

// Devolve true se gerou e aplicou o design (para o chamador decidir se fecha
// o modal); false se o usuário desistiu na confirmação de substituição ou se
// a geração falhou — nesses casos o modal continua aberto com os ajustes.
async function confirmDigitize() {
  if (!digitize.full) return false;
  if (state.design && !window.confirm(tr('dig.confirmReplace'))) return false;
  try {
    const design = await window.api.digitizeGenerate(digitize.full, digitizeOptsFor(digitize.full));
    setDesign(design);
    toast(tr('toast.digitized', { n: fmtNum(state.stats.stitches), c: fmtNum(state.blocks.length) }));
    return true;
  } catch (err) {
    toast(tr('dig.openError') + err.message, 'error', 5000);
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

  applyI18n();
  populateTextFontSelect();
  syncToggleButtons();
  $('sim-speed').value = String(nearestSimOption(state.settings.sim.stitchesPerSecond));

  bindCanvas();
  bindToolbar();
  bindDialogs();
  bindSvgImportDialog();
  bindMenuAndKeys();
  bindDragDrop();
  bindDrivesDialog();
  bindDigitizeDialog();
  bindLibraryDialog();
  resizeCanvas();
  refreshEmptyRecents();
  requestRender();

  if (launch.openPath) {
    await openPath(launch.openPath);
  }
  if (launch.dialog === 'settings') openSettings();
  if (launch.dialog === 'scale' && state.design) openScaleDialog();
  if (launch.dialog === 'formats') $('dlg-formats').showModal();
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

  // Sinaliza para o modo screenshot que a primeira pintura aconteceu.
  requestAnimationFrame(() => requestAnimationFrame(() => window.api.notifyRenderReady()));
}

boot();
