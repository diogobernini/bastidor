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
    newFolderTarget: null, // 'main' | 'move': qual árvore pediu o dialog de nova pasta (issue #28, item 1)
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
    // Varredura incremental com progresso (issue #35): ver LibraryUI.startLibraryIndexing.
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
  // Mesclar blocos de cor adjacentes (issue #50): ver ColorBlocks
  // (src/core/colorblocks.js) para a mutação em si; aqui só repassamos os
  // arrays do design atual. mergeColorBlock é a direção "fazer" (remove);
  // splitColorBlock é a inversa (reinsere) — usada tanto por undo() quanto
  // como operação direta caso ela mesma seja desfeita de novo (redo).
  mergeColorBlock(op) {
    ColorBlocks.mergeBlock(state.design.stitches, state.design.threads, {
      colorChangeIndex: op.colorChangeIndex,
      threadIndex: op.threadIndex,
    });
  },
  splitColorBlock(op) {
    ColorBlocks.splitBlock(
      state.design.stitches,
      state.design.threads,
      { colorChangeIndex: op.colorChangeIndex, threadIndex: op.threadIndex },
      { stitch: op.stitch, thread: op.thread }
    );
  },
  // Reordenar blocos de cor adjacentes (issue #61): a troca é sua própria
  // inversa (ver comentário em src/core/history.js), então undo() e redo()
  // caem exatamente aqui os dois, sempre com o mesmo upperIndex. state.blocks
  // reflete a posição ATUAL dos blocos (recém derivada após a última
  // mutação, seja ela o "fazer" original ou o undo/redo anterior), então
  // recalcular o plano a partir dele a cada chamada é seguro.
  moveColorBlock(op) {
    ColorBlocks.swapAdjacentBlocks(state.design.stitches, state.design.threads, state.blocks, op.upperIndex);
  },
  transform(op) {
    applyTransformToDesign(op.kind, op.params);
  },
  snapshot(op) {
    state.design.stitches = op.after.stitches;
    state.design.threads = op.after.threads;
    state.design.objects = op.after.objects || [];
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

// Copia stitches/threads/objects do design atual (mesmo formato usado antes
// por snapshotUndo): usado para montar a operação 'snapshot' de fallback nas
// mutações sem inversa analítica barata (redimensionar com densidade,
// inserir texto como bloco novo, regenerar um objeto paramétrico — issue
// #29 fase 2). `objects` entra no snapshot pra desfazer/refazer também
// reverter o registro paramétrico (source/stitchParams/blockCount), não só
// as agulhadas.
function cloneDesignData() {
  return {
    stitches: state.design.stitches.map((s) => [s[0], s[1], s[2]]),
    threads: JSON.parse(JSON.stringify(state.design.threads)),
    objects: JSON.parse(JSON.stringify(state.design.objects || [])),
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
    // Prévia ao vivo: 'input' dispara a cada movimento dentro do seletor
    // nativo e só repinta (sem histórico e sem reconstruir a sidebar, que
    // destruiria este próprio input no meio da interação). O 'change' do
    // fechamento registra UMA operação no histórico, da cor original para a
    // final, e aí sim reconstrói a lista.
    let liveFrom = null;
    const applyColor = (to) => {
      const t = state.design.threads[block.threadIndex];
      if (t) t.color = to;
      else state.design.threads[block.threadIndex] = { color: to };
      bumpArt();
      RenderCanvas.requestRender();
    };
    sw.addEventListener('input', () => {
      if (liveFrom === null) liveFrom = threadColor(block.threadIndex);
      applyColor(sw.value);
    });
    sw.addEventListener('change', () => {
      const from = liveFrom !== null ? liveFrom : threadColor(block.threadIndex);
      liveFrom = null;
      const to = sw.value;
      if (from !== to) {
        pushHistory({ type: 'recolorThread', index: block.threadIndex, from, to });
      }
      applyColor(to);
      updateSidebar();
    });
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${bi + 1}. ${threadLabel(block.threadIndex)}`;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = I18n.fmtNum(block.stitchCount);
    li.append(sw, name, count);
    // Reordenar a sequência de bordado (issue #61): ▲ sobe o bloco (troca
    // com o de cima), ▼ desce (troca com o de baixo). ▲ escondido no
    // primeiro bloco (não há pra onde subir), ▼ escondido no último (não
    // há pra onde descer) — mesmo critério de esconder do botão de
    // mesclar logo abaixo.
    if (bi > 0) {
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'move-btn move-up-btn'; // 2ª classe: seletor único p/ automação (tests/ui)
      upBtn.textContent = '▲';
      upBtn.title = I18n.tr('colors.moveUp');
      upBtn.setAttribute('aria-label', upBtn.title); // issue #38: tooltip dobra de rótulo p/ leitor de tela
      upBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        moveColorBlock(bi, 'up');
      });
      li.append(upBtn);
    }
    if (bi < state.blocks.length - 1) {
      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'move-btn move-down-btn'; // 2ª classe: seletor único p/ automação (tests/ui)
      downBtn.textContent = '▼';
      downBtn.title = I18n.tr('colors.moveDown');
      downBtn.setAttribute('aria-label', downBtn.title);
      downBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        moveColorBlock(bi, 'down');
      });
      li.append(downBtn);
    }
    // Ação de mesclar (issue #50): funde o bloco de BAIXO neste, mantendo a
    // linha/config deste bloco. Escondida no último, que não tem bloco
    // abaixo para mesclar.
    if (bi < state.blocks.length - 1) {
      const mergeBtn = document.createElement('button');
      mergeBtn.type = 'button';
      mergeBtn.className = 'merge-btn';
      mergeBtn.textContent = '⇊';
      mergeBtn.title = I18n.tr('colors.merge');
      mergeBtn.setAttribute('aria-label', mergeBtn.title); // issue #38: tooltip dobra de rótulo p/ leitor de tela
      mergeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        mergeColorBlockWithNext(bi);
      });
      li.append(mergeBtn);
    }
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

// Mesclagem de blocos de cor adjacentes (issue #50): funde o bloco
// state.blocks[bi + 1] (o de BAIXO) no bloco state.blocks[bi] (o de CIMA),
// mantendo a linha/config do de cima. A sequência de bordado não muda: só
// o COLOR_CHANGE entre os dois some (uma parada a menos pra trocar de
// linha) e a entrada de thread do bloco de baixo é removida — as contagens
// de ponto somam automaticamente porque os stitches continuam os mesmos,
// só que agora num único bloco. Núcleo puro em src/core/colorblocks.js;
// aqui só montamos a operação de histórico com o que foi removido (mesmo
// padrão de insertAfterSelected: muta primeiro, história descreve o que já
// mudou, porque é a própria mutação que revela o valor exato removido).
function mergeColorBlockWithNext(bi) {
  if (!state.design) return;
  const plan = ColorBlocks.deriveMergePlan(state.blocks, bi + 1);
  if (!plan) return; // blocos não adjacentes de verdade (bloco vazio escondido entre eles) — não faz nada
  const removed = ColorBlocks.mergeBlock(state.design.stitches, state.design.threads, plan);
  pushHistory({
    type: 'mergeColorBlock',
    colorChangeIndex: plan.colorChangeIndex,
    threadIndex: plan.threadIndex,
    stitch: removed.stitch,
    thread: removed.thread,
  });
  bumpArt();
  deriveBlocks();
  deriveStats();
  updateSidebar();
  updateStatusbar();
  RenderCanvas.requestRender();
}

// Reordenar a sequência de bordado (issue #61): move o bloco `bi` (posição
// em state.blocks) uma casa para cima ou para baixo, trocando de lugar com
// o vizinho adjacente — "subir" troca (bi - 1, bi); "descer" troca (bi, bi
// + 1); em ambos os casos upperIndex é a posição do bloco que fica em CIMA
// depois da troca. Núcleo puro em ColorBlocks.swapAdjacentBlocks (troca é
// sua própria inversa: uma entrada de histórico basta, sem precisar
// guardar mais nada além de upperIndex, ver src/core/history.js). Mesmo
// fluxo de pós-mutação de mergeColorBlockWithNext.
function moveColorBlock(bi, direction) {
  if (!state.design) return;
  const upperIndex = direction === 'up' ? bi - 1 : bi;
  const moved = ColorBlocks.swapAdjacentBlocks(state.design.stitches, state.design.threads, state.blocks, upperIndex);
  if (!moved) return; // posição inválida (topo/fundo da lista, ou bloco vazio escondido entre os dois) — não faz nada
  pushHistory({ type: 'moveColorBlock', upperIndex });
  bumpArt();
  deriveBlocks();
  deriveStats();
  updateSidebar();
  updateStatusbar();
  RenderCanvas.requestRender();
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

// scaleDesign/scaleDesignWithDensity moram em Dialogs — ver modules/dialogs.js.

// --------------------------------------------------------------- salvar/exportar

// "Salvar como" (issue #17): por padrão abre a biblioteca (escolher subpasta
// e nome); saveAsExternal (o fluxo antigo, diálogo do sistema) fica atrás do
// botão "Salvar fora..." dentro do modal da biblioteca.
function saveAs() {
  if (!state.design) return;
  LibraryUI.openLibrarySaveDialog();
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

// Projeto nativo .bastidor (issue #29 fase 2): ao contrário de
// saveAsExternal (formatos de máquina, só a projeção achatada), guarda
// design.objects[] inteiro — é o que faz um redimensionamento paramétrico
// continuar funcionando depois de reabrir (ver src/core/project.js).
async function saveProjectFlow() {
  if (!state.design) return;
  const base = (state.design.name || 'projeto').replace(/\.[^.]+$/, '');
  try {
    const result = await window.api.projectSave(
      {
        name: state.design.name,
        metadata: state.design.metadata || {},
        threads: state.design.threads,
        objects: state.design.objects || [],
        stitches: state.design.stitches,
      },
      base + '.bastidor'
    );
    if (!result) return; // diálogo cancelado
    const savedName = result.path.split('/').pop().split('\\').pop();
    toast(I18n.tr('toast.projectSaved', { name: savedName }));
  } catch (err) {
    toast(I18n.tr('toast.projectError') + err.message, 'error', 5000);
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
  await LibraryUI.openLibraryDialog();
}

async function openViaDialogExternal() {
  const design = await window.api.openDialog();
  if (design) {
    setDesign(design);
    LibraryUI.closeLibraryDialog(); // se veio do botão "Abrir do computador..." dentro da biblioteca
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

// Abrir um projeto .bastidor (issue #29 fase 2): design.objects[] chega
// pronto do processo principal (src/core/project.js já valida o JSON);
// setDesign() trata como qualquer outro design — os objetos ficam
// disponíveis pro próximo redimensionamento paramétrico regenerar de verdade
// (ver src/renderer/objects.js), sem precisar rodar nenhum gerador agora.
async function openProjectFlow() {
  try {
    const design = await window.api.projectOpen();
    if (!design) return; // diálogo cancelado
    setDesign(design);
    toast(I18n.tr('toast.projectOpened', { name: design.name || '' }));
  } catch (err) {
    toast(I18n.tr('toast.projectError') + err.message, 'error', 5000);
  }
}

// Configurações (dlg-settings), incluindo nearestSimOption, moram em Dialogs
// — ver modules/dialogs.js.

// Gestor de pendrive (dlg-drives): driveCacheKey, peekDriveDesign,
// drivesSideRoot, updateDriveActionButtons, buildDriveItemRow,
// renderDriveList, refreshLibraryPane, refreshDrivePane,
// refreshDriveSelectList, refreshDriveSide, copySelectedDesigns,
// deleteSelectedFromDrive, ejectSelectedDrive, cleanHiddenOnDrive,
// openDesignFromDriveManager, openDrivesDialog, closeDrivesDialog e
// bindDrivesDialog moram em DrivesUI — ver modules/drives-ui.js.

// Navegador de biblioteca (dlg-library, issue #17): árvore de pastas,
// busca, filtros, grade virtualizada de miniaturas, ações por item (abrir,
// favoritar, copiar p/ pendrive, renomear, mover, apagar), varredura
// incremental de índice (issue #35) e benchmark de rolagem — tudo mora em
// LibraryUI, ver modules/library-ui.js.


// Lettering (dlg-text): FONT_TYPE_LABEL_KEY, populateTextFontSelect,
// currentFontType, readTextFormOpts, syncTextFieldVisibility, addTtfFontFlow,
// sizeTextPreviewCanvas, clearTextPreview, drawTextPreview, scheduleTextPreview,
// refreshTextPreview, redrawTextPreview, openTextDialog e insertTextDesign
// moram em Dialogs — ver modules/dialogs.js.

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
  $('btn-text').addEventListener('click', Dialogs.openTextDialog);
  $('btn-fit').addEventListener('click', RenderCanvas.fitView);
  $('btn-zoom-in').addEventListener('click', () => RenderCanvas.zoomCenter(1.3));
  $('btn-zoom-out').addEventListener('click', () => RenderCanvas.zoomCenter(1 / 1.3));
  $('btn-settings').addEventListener('click', Dialogs.openSettings);

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
  $('t-scale').addEventListener('click', Dialogs.openScaleDialog);
}

function syncToggleButtons() {
  $('btn-grid').classList.toggle('on', state.settings.grid.show);
  $('btn-hoop').classList.toggle('on', state.settings.hoop.show);
  $('btn-jumps').classList.toggle('on', state.settings.view.showJumps);
  $('btn-points').classList.toggle('on', !!state.settings.view.showPoints);
}

// openScaleDialog/syncKeepDensityDefault/updateScalePreview (dlg-scale),
// bindDialogs() e a importação de SVG (dlg-svg-import: handleSvgPicked,
// svgImportOpts, runSvgPreview, queueSvgPreview, applySvgImport,
// bindSvgImportDialog) moram em Dialogs — ver modules/dialogs.js.


// Tabela de atalhos (SHORTCUTS/SHORTCUT_CONTEXT_I18N), renderShortcutsTable e
// openShortcutsDialog (issue #38) moram em Dialogs — ver modules/dialogs.js.
// Os bindings REAIS ficam abaixo, em bindMenuAndKeys (remainder).


function bindMenuAndKeys() {
  window.api.onMenu((action) => {
    const actions = {
      open: openViaDialog,
      'save-as': saveAs,
      'export-png': exportPng,
      'save-project': saveProjectFlow,
      'open-project': openProjectFlow,
      settings: Dialogs.openSettings,
      undo,
      redo,
      center: centerToOrigin,
      scale: Dialogs.openScaleDialog,
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
      shortcuts: Dialogs.openShortcutsDialog,
      'digitize-image': Dialogs.openDigitizeDialog,
      // Auto-update (issue #31): electron-updater in the main process reports
      // through this same 'menu' channel; no design needs to be open to see them.
      'update-checking': () => toast(I18n.tr('update.checking')),
      'update-available': () => toast(I18n.tr('update.available')),
      'update-not-available': () => toast(I18n.tr('update.notAvailable')),
      'update-downloaded': () => toast(I18n.tr('update.downloaded')),
      'update-error': () => toast(I18n.tr('update.error'), 'error', 5000),
    };
    const alwaysAvailable = [
      'open', 'open-project', 'settings', 'formats', 'shortcuts', 'digitize-image',
      'update-checking', 'update-available', 'update-not-available', 'update-downloaded', 'update-error',
    ];
    if (state.design || alwaysAvailable.includes(action)) {
      const fn = actions[action];
      if (fn) fn();
    }
  });

  window.api.onDesignOpened((design) => {
    setDesign(design);
    DrivesUI.closeDrivesDialog(); // abrir uma matriz (Recentes/Finder/gestor de pendrive) tira o modal do caminho
    LibraryUI.closeLibraryDialog(); // idem para o navegador de biblioteca (issue #17)
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
    else if (key === '?' || (e.shiftKey && key === '/')) Dialogs.openShortcutsDialog();
  });
}

// Digitalizar imagem/PNG -> vetor (dlg-digitize): digitize, loadImageEl,
// imageToImageData, paintImageData, digitizeColorsLabel, updateDigitizeSummary,
// digitizeOptsFor, runDigitizeStitchPreview, queueDigitizeStitchPreview,
// runDigitizePreview, queueDigitizePreview, openDigitizeDialog,
// openDigitizeWith, confirmDigitize e bindDigitizeDialog moram em Dialogs —
// ver modules/dialogs.js.

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
  Dialogs.populateTextFontSelect();
  syncToggleButtons();
  $('sim-speed').value = String(Dialogs.nearestSimOption(state.settings.sim.stitchesPerSecond));

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
      decodeDataURLImage: Dialogs.decodeDataURLImage, // issue #29 fase 2: regenerar um objeto raster-trace precisa da imagem de volta
    });
  }

  bindCanvas();
  bindToolbar();
  Dialogs.bindDialogs();
  Dialogs.bindSvgImportDialog();
  bindMenuAndKeys();
  bindDragDrop();
  DrivesUI.bindDrivesDialog();
  Dialogs.bindDigitizeDialog();
  LibraryUI.bindLibraryDialog();
  RenderCanvas.resizeCanvas();
  refreshEmptyRecents();
  RenderCanvas.requestRender();

  if (launch.openPath) {
    await openPath(launch.openPath);
  }
  if (launch.dialog === 'settings') Dialogs.openSettings();
  if (launch.dialog === 'scale' && state.design) Dialogs.openScaleDialog();
  if (launch.dialog === 'formats') $('dlg-formats').showModal();
  if (launch.dialog === 'shortcuts') Dialogs.openShortcutsDialog();
  if (launch.dialog === 'drives') await DrivesUI.openDrivesDialog();
  if (launch.dialog === 'text') Dialogs.openTextDialog();
  if (launch.dialog === 'digitize') $('dlg-digitize').showModal();
  // issue #33: os diálogos de texto e digitalizar já tinham --dialog=text e
  // --dialog=digitize (autoteste); importar SVG só tinha --svg-import=arquivo
  // (precisa de payload). Mesmo padrão do 'formats'/'digitize' acima: abre o
  // modal vazio, sem prévia, só para telas/smokes automatizados. Desvio
  // deliberado desta extração (não existia antes do módulo Dialogs).
  if (launch.dialog === 'svg-import') $('dlg-svg-import').showModal();
  if (launch.digitizeImage) await Dialogs.openDigitizeWith(launch.digitizeImage);
  if (launch.svgImport) Dialogs.handleSvgPicked(launch.svgImport);
  if (launch.dialog === 'library') await LibraryUI.openLibraryDialog();
  if (launch.dialog === 'library-save' && state.design) await LibraryUI.openLibrarySaveDialog();
  if (launch.librarySearch) {
    $('lib-search').value = launch.librarySearch;
    await LibraryUI.runLibrarySearch(launch.librarySearch);
  }
  // --library-wait-index (issue #35, só automação): espera a varredura
  // incremental terminar antes de sinalizar "pronto" — pra --screenshot
  // capturar a biblioteca já totalmente indexada, em vez de no meio do
  // progresso.
  if (launch.libraryWaitIndex) await LibraryUI.waitForLibraryIndexIdle();

  // Sinaliza para o modo screenshot que a primeira pintura aconteceu.
  requestAnimationFrame(() => requestAnimationFrame(() => window.api.notifyRenderReady()));

  // --library-bench-scroll=ms (issue #35, só medição de desempenho): mede o
  // tempo de frame durante uma rolagem programática da grade da biblioteca
  // e encerra o app. Roda depois do notifyRenderReady acima (não deve
  // interferir na captura de tela do modo --screenshot).
  if (launch.libraryBenchScrollMs) {
    await LibraryUI.runLibraryScrollBenchmark(launch.libraryBenchScrollMs, launch.libraryBenchScrollImmediate);
    window.api.quitSoon(300);
  }
}

boot();
