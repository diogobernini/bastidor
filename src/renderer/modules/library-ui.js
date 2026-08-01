'use strict';
// library-ui: navegador de biblioteca (dlg-library, issue #17) para catálogos
// grandes (10-15 mil arquivos) - árvore de pastas com carregamento
// preguiçoso, busca, filtros de formato/dimensão/pontos/favoritos, grade
// virtualizada de miniaturas e as ações por item (abrir, favoritar, copiar
// para pendrive, renomear, mover, apagar). Inclui a varredura incremental de
// índice (issue #35) e o benchmark de rolagem (--library-bench-scroll, só
// medição de desempenho).
//
// Consome (globais de renderer.js): state, $, toast, updateStatusbar,
// setDesign, openViaDialogExternal, saveAsExternal, refreshEmptyRecents;
// I18n.tr/I18n.fmtNum/I18n.fmtBytesLocal; RenderCanvas.drawDesignThumbnail/
// RenderCanvas.drawDesignInto/RenderCanvas.designBounds/RenderCanvas.countStitches/
// RenderCanvas.designThreadColor; DrivesUI.peekDriveDesign (cache por
// caminho+mtime, também usado pelo gestor de pendrive); Dialogs.confirmDialog;
// SewTime.fmtSewTime, ViewportClamp.clampToViewport, LibraryView.computeCols/
// computeVisibleRange, LruCap.setWithCap (teto dos caches de miniatura —
// issue #28) (consts lexicais globais de src/core/, referenciados direto).
// window.api.libraryCreateFolder (issue #28, item 1: botão "+ Nova pasta"
// nos pickers). closeLibraryDialog/openLibraryDialog/openLibrarySaveDialog são
// chamados bare a partir do remainder de renderer.js (saveAs/openViaDialog/
// openViaDialogExternal/bindMenuAndKeys/boot) — ver os pontos
// LibraryUI.<nome> lá.
window.LibraryUI = (function () {

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
// - Miniaturas: reaproveita DrivesUI.peekDriveDesign (cache por caminho+mtime,
//   já usado pelo gestor de pendrive) + RenderCanvas.drawDesignThumbnail para
//   desenhar, com um cache em disco (userData/thumbs) por trás de uma fila com throttle.
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
  const peeked = await DrivesUI.peekDriveDesign(item);
  if (!peeked.ok) return null;
  const off = document.createElement('canvas');
  RenderCanvas.drawDesignThumbnail(off, peeked.design, 84);
  const dataURL = off.toDataURL('image/png');
  window.api.libraryThumbSave(item.path, item.mtime, dataURL); // best-effort, não bloqueia a UI
  return dataURL;
}

// Cache de Image já decodificada: repintar um card que voltou à janela
// virtualizada é síncrono (sem o pisca de esperar decode/IPC a cada scroll).
// Teto reduzido na issue #57: cada Image de 84 px decodificada em tela retina
// custa ~113 KB (168² × 4 B), então 4000 eram ~440 MB no pior caso; 1000
// (~110 MB, uns 25 ecrãs de grade) cobre o scroll de volta com folga.
const libThumbImages = new Map();
const LIB_THUMB_IMG_CAP = 1000;
// Teto do cache de promessas de miniatura (state.library.thumbCache) —
// issue #28, item 3. libThumbImages (acima) já usava o mesmo mecanismo de
// teto manualmente; ambos agora passam por LruCap.setWithCap (src/core/lru.js).
const LIB_THUMB_CACHE_CAP = 6000;

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
    LruCap.setWithCap(libThumbImages, key, img, LIB_THUMB_IMG_CAP);
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
    LruCap.setWithCap(state.library.thumbCache, key, entry, LIB_THUMB_CACHE_CAP);
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
  Promise.resolve(DrivesUI.peekDriveDesign(item)).then((entry) => {
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

// expanded/childrenCache viram getters (não propriedades eager): este objeto
// é construído no momento em que o <script> deste módulo carrega, ANTES de
// renderer.js declarar `state` (a ordem dos <script> não importa para o
// resto do módulo, só para este objeto de nível superior) — ler
// state.library.* eagerly aqui daria "state is not defined" e deixaria
// window.LibraryUI indefinido. Getters adiam a leitura para o primeiro uso
// de verdade, depois que boot() já rodou.
const mainLibTreeOpts = {
  get expanded() {
    return state.library.treeExpanded;
  },
  get childrenCache() {
    return state.library.treeChildren;
  },
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
  get expanded() {
    return state.library.moveTreeExpanded;
  },
  get childrenCache() {
    return state.library.moveTreeChildren;
  },
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
    Promise.resolve(DrivesUI.peekDriveDesign(item)).then((entry) => {
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
    const ok = await Dialogs.confirmDialog({
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
  const ok = await Dialogs.confirmDialog({
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

// ---- criar pasta nos pickers de "salvar em" e "mover para" (issue #28, item 1) ----
// Antes só era possível arquivar em pastas já existentes; os handlers de fs
// (write-design, move) já toleravam destino inexistente (mkdir recursivo),
// mas não havia como criar uma pasta vazia, sem salvar/mover nada nela ainda.
// target diz qual árvore abriu o dialog: a pasta-pai é a que já está
// selecionada nela (state.library.currentRelDir p/ "main", moveChosenRelDir
// p/ "move"); ao confirmar, a nova pasta vira a seleção da mesma árvore,
// reaproveitando o onSelect de cada opts (mainLibTreeOpts/moveLibTreeOpts)
// pra não duplicar a lógica de expandir/recarregar.
function openLibraryNewFolder(target) {
  state.library.newFolderTarget = target;
  const parentRelDir = target === 'move' ? state.library.moveChosenRelDir : state.library.currentRelDir;
  $('lib-newfolder-parent').textContent = parentRelDir || I18n.tr('lib.root');
  $('lib-newfolder-input').value = '';
  $('dlg-lib-newfolder').showModal();
  $('lib-newfolder-input').focus();
}

async function confirmLibraryNewFolder() {
  const target = state.library.newFolderTarget;
  const parentRelDir = target === 'move' ? state.library.moveChosenRelDir : state.library.currentRelDir;
  const name = $('lib-newfolder-input').value.trim();
  if (!name) return;
  try {
    const created = await window.api.libraryCreateFolder(parentRelDir, name);
    invalidateLibraryTreeCache();
    if (target === 'move') {
      await moveLibTreeOpts.onSelect(created.relDir);
    } else {
      await mainLibTreeOpts.onSelect(created.relDir);
    }
    toast(I18n.tr('lib.toastFolderCreated', { name: created.name }));
  } catch (err) {
    toast(I18n.tr('lib.toastFolderCreateError') + err.message, 'error', 5000);
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

  // Criar pasta (issue #28, item 1): mesmo dialog/form atende os dois pickers.
  $('lib-tree-newfolder').addEventListener('click', () => openLibraryNewFolder('main'));
  $('lib-move-newfolder').addEventListener('click', () => openLibraryNewFolder('move'));
  $('lib-newfolder-form').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'ok') confirmLibraryNewFolder();
  });
}

  return {
    scheduleThumbJob,
    pumpThumbQueue,
    libraryThumbCacheKey,
    loadOrBuildLibraryThumb,
    paintThumbFromImg,
    paintLibraryThumb,
    ensureLibraryThumb,
    hideLibHover,
    showLibHover,
    libRelDirParent,
    renderLibraryTree,
    renderLibTreeChildrenInto,
    buildLibTreeRow,
    invalidateLibraryTreeCache,
    loadLibraryFolder,
    runLibrarySearch,
    setLibraryBaseItems,
    libraryIndexKey,
    libraryHasNumericFilter,
    updateIndexingUI,
    resolveLibraryIndexIdle,
    waitForLibraryIndexIdle,
    startLibraryIndexing,
    scheduleLibrarySearch,
    reloadLibraryView,
    readLibraryFiltersFromForm,
    scheduleLibraryFilterChange,
    clearLibraryFilters,
    applyLibraryFilters,
    updateLibraryEmptyState,
    libraryGridCols,
    renderLibraryGrid,
    requestLibraryGridRender,
    runLibraryScrollBenchmark,
    buildLibAct,
    buildLibraryGridItem,
    openLibraryItem,
    toggleLibraryFavorite,
    copyLibraryItemToDrive,
    deleteLibraryItem,
    openLibraryRename,
    confirmLibraryRename,
    openLibraryMove,
    confirmLibraryMove,
    refreshLibraryDriveSelect,
    populateLibraryFormatFilterSelect,
    populateLibrarySaveFormatSelect,
    updateLibrarySaveTarget,
    closeLibraryDialog,
    openLibraryCommon,
    openLibraryDialog,
    openLibrarySaveDialog,
    confirmLibrarySave,
    bindLibraryDialog,
  };
})();
