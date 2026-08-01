'use strict';
// Modo de seleção de objetos (issue #29, fase 1): trata os blocos de cor do
// desenho (ver deriveBlocks em renderer.js) como objetos Inkscape-like —
// clicar seleciona (bbox + 8 alças), arrastar move, alças redimensionam
// (proporcional por padrão, livre com Alt), Delete apaga, Esc desseleciona.
// Fases 2/3 (modelo paramétrico, .bastidor, rotação/multi-seleção) ficam de
// fora de propósito.
//
// Carregado por <script> ANTES de renderer.js (depois de densityscale.js,
// spatial.js e minspacing.js): tudo fica dentro desta IIFE — script clássico
// compartilha o escopo global da página, e identificadores como `state`,
// `api` ou `COMMAND_MASK` já existem em renderer.js/preload.js. Só
// "window.ObjectCanvas" escapa. renderer.js só tem os ganchos mínimos
// (pointerdown/pointermove/pointerup/render/keydown) chamando os métodos
// abaixo; toda a lógica de gesto, hit-test e desenho do overlay mora aqui.
//
// A ponte com o estado "vivo" do renderer (state, toScreen/toDesign, canvas,
// snapshotUndo, deriveBlocks, afterPointMutation, setEditMode, simReset, tr,
// updateToolbarEnabled) é injetada explicitamente por ObjectCanvas.init(...)
// dentro de boot() — em vez de depender da ordem de carregamento dos
// scripts, o que funcionaria (const de nível de topo de um script clássico
// entra no ambiente léxico global, visível a qualquer código que rode
// depois) mas seria implícito e frágil a reordenações futuras.

(function () {
  // spatial.js só expõe o identificador léxico "Spatial" (const de topo de
  // um script clássico), não window.Spatial como densityscale.js/
  // minspacing.js — por isso o fallback do navegador aqui lê o identificador
  // global direto (spatial.js já rodou, carrega antes no index.html), e não
  // "window.Spatial". De propósito, nenhuma variável chamada "Spatial" é
  // declarada neste arquivo: sombrear o identificador quebraria essa leitura
  // (o "const" local ainda não estaria inicializado nesse ponto).
  function resolveSpatial() {
    if (typeof module !== 'undefined' && module.exports) return require('../core/spatial.js');
    if (typeof Spatial !== 'undefined') return Spatial;
    return null;
  }
  function resolveMinSpacing() {
    if (typeof window !== 'undefined' && window.MinSpacing) return window.MinSpacing;
    if (typeof module !== 'undefined' && module.exports) return require('../core/minspacing.js');
    return null;
  }
  const SpatialLib = resolveSpatial();
  const MinSpacing = resolveMinSpacing();

  // Duplicados localmente (mesma convenção de spatial.js/densityscale.js):
  // evita depender da ordem de carregamento pras constantes de comando.
  const STITCH_CMD = 0;
  const JUMP_CMD = 1;
  const SEQUIN_EJECT_CMD = 7;
  const COMMAND_MASK = 0xff;

  const OBJECT_PICK_RADIUS_PX = 10; // raio de seleção do bloco no clique (em px de tela)
  const HANDLE_PX = 4; // meia-lateral do quadrado desenhado de cada alça
  const HANDLE_HIT_PX = 8; // meia-lateral da área clicável de cada alça (maior que o desenho)
  const MIN_FACTOR = 0.05; // trava contra encolher até inverter/colapsar o objeto

  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const OPPOSITE = { nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' };
  const CURSORS = {
    nw: 'nwse-resize', se: 'nwse-resize',
    ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize',
    e: 'ew-resize', w: 'ew-resize',
  };

  let host = null; // injetado via init(); ver cabeçalho do arquivo.

  const oc = {
    active: false,
    selected: -1, // índice em host.state.blocks, ou -1
    drag: null, // gesto em andamento (mover/redimensionar), ver startMoveDrag/startResizeDrag
    pendingWarning: null, // mensagem da guarda de espaçamento mínimo (side bar), ou null
  };

  // ------------------------------------------------------------- geometria pura
  // (sem DOM: testável via require() a partir de node:test)

  function isBoundsCmd(cmd) {
    return cmd === STITCH_CMD || cmd === JUMP_CMD || cmd === SEQUIN_EJECT_CMD;
  }

  // Bbox (design coords) de um trecho [start, end) do array de agulhadas.
  // Mesmo critério de deriveStats em renderer.js (ignora TRIM/STOP/troca de
  // cor, que só repetem a última posição). Devolve null se não há pontos.
  function computeBBox(stitches, start, end) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = start; i < end; i++) {
      const st = stitches[i];
      if (!isBoundsCmd(st[2] & COMMAND_MASK)) continue;
      if (st[0] < minX) minX = st[0];
      if (st[0] > maxX) maxX = st[0];
      if (st[1] < minY) minY = st[1];
      if (st[1] > maxY) maxY = st[1];
    }
    if (minX > maxX) return null;
    return { minX, minY, maxX, maxY };
  }

  function handlePoint(bbox, name) {
    const midX = (bbox.minX + bbox.maxX) / 2;
    const midY = (bbox.minY + bbox.maxY) / 2;
    switch (name) {
      case 'nw': return [bbox.minX, bbox.minY];
      case 'n': return [midX, bbox.minY];
      case 'ne': return [bbox.maxX, bbox.minY];
      case 'e': return [bbox.maxX, midY];
      case 'se': return [bbox.maxX, bbox.maxY];
      case 's': return [midX, bbox.maxY];
      case 'sw': return [bbox.minX, bbox.maxY];
      case 'w': return [bbox.minX, midY];
      default: return [midX, midY];
    }
  }

  function clampFactor(f) {
    if (!isFinite(f)) return 1;
    if (f >= 0) return Math.max(f, MIN_FACTOR);
    return Math.min(f, -MIN_FACTOR); // nunca deixa inverter o objeto pelo pivô
  }

  // Fator/eixos de escala a partir do gesto de arrastar uma alça: `pivot` é
  // o canto oposto (fixo); `handleStart` é a posição original da alça
  // arrastada; `cur` é a posição atual do ponteiro (coords do desenho).
  // Proporcional (padrão): projeta o vetor atual sobre o vetor original
  // (pivô -> alça) — reduz exatamente à razão de um único eixo quando a
  // alça é de borda (n/s/e/w, onde esse vetor já é só vertical/horizontal),
  // e a uma razão "na diagonal" quando a alça é de canto. Livre (Alt): cada
  // eixo escala pela sua própria razão (eixos com vetor original ~0, como o
  // eixo perpendicular de uma alça de borda, ficam fixos em 1).
  function resizeFactors(pivot, handleStart, cur, alt) {
    const sv = [handleStart[0] - pivot[0], handleStart[1] - pivot[1]];
    const cv = [cur[0] - pivot[0], cur[1] - pivot[1]];
    if (alt) {
      const sx = Math.abs(sv[0]) > 1e-6 ? clampFactor(cv[0] / sv[0]) : 1;
      const sy = Math.abs(sv[1]) > 1e-6 ? clampFactor(cv[1] / sv[1]) : 1;
      return [sx, sy];
    }
    const denom = sv[0] * sv[0] + sv[1] * sv[1];
    const factor = denom > 1e-9 ? clampFactor((cv[0] * sv[0] + cv[1] * sv[1]) / denom) : 1;
    return [factor, factor];
  }

  function hitHandle(bbox, screenX, screenY, toScreen) {
    for (const name of HANDLES) {
      const [hx, hy] = handlePoint(bbox, name);
      const [sx, sy] = toScreen(hx, hy);
      if (Math.abs(sx - screenX) <= HANDLE_HIT_PX && Math.abs(sy - screenY) <= HANDLE_HIT_PX) return name;
    }
    return null;
  }

  function sliceCopy(stitches, start, end) {
    const out = new Array(end - start);
    for (let i = start; i < end; i++) {
      const s = stitches[i];
      out[i - start] = [s[0], s[1], s[2]];
    }
    return out;
  }

  // ------------------------------------------------------------------- ciclo de vida

  function init(hostApi) {
    host = hostApi;
  }

  function isActive() {
    return oc.active;
  }

  function isDragging() {
    return !!oc.drag;
  }

  function setActive(active) {
    active = !!active && !!host && !!host.state.design;
    if (active === oc.active) return;
    oc.active = active;
    if (active) {
      host.setEditMode(false); // mutuamente exclusivo com a edição de pontos (issue #29)
      host.simReset(); // idem com a simulação
      host.canvas.style.cursor = 'default';
    } else {
      oc.drag = null;
      oc.selected = -1;
      oc.pendingWarning = null;
      host.canvas.style.cursor = '';
    }
    document.getElementById('btn-objects').classList.toggle('on', active);
    host.updateToolbarEnabled();
    host.requestRender();
  }

  function toggle() {
    setActive(!oc.active);
  }

  // Índices de bloco deixam de ser confiáveis depois de um undo ou de abrir
  // outro arquivo (o array de agulhadas foi substituído por completo).
  function reset() {
    oc.selected = -1;
    oc.drag = null;
    oc.pendingWarning = null;
  }

  function sidebarWarning() {
    return oc.pendingWarning;
  }

  // Só leitura: índice do bloco selecionado (-1 se nenhum). Usado pela
  // barra de status/depuração e pelo harness de verificação (issue #29).
  function selectedIndex() {
    return oc.selected;
  }

  // ------------------------------------------------------------------- seleção

  function selectBlock(index) {
    oc.selected = index;
    oc.pendingWarning = null;
    host.requestRender();
  }

  function clearSelection() {
    if (oc.selected === -1 && !oc.drag) return;
    oc.selected = -1;
    oc.drag = null;
    oc.pendingWarning = null;
    host.requestRender();
  }

  function selectedBlock() {
    const state = host.state;
    if (!state.design || oc.selected < 0 || oc.selected >= state.blocks.length) return null;
    return state.blocks[oc.selected];
  }

  // ------------------------------------------------------------------- gestos

  function clientToCanvas(e) {
    const rect = host.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  function onPointerDown(e) {
    if (!oc.active || !host || !host.state.design) return false;
    const state = host.state;
    const [sx, sy] = clientToCanvas(e);

    const block = selectedBlock();
    if (block) {
      const bbox = computeBBox(state.design.stitches, block.start, block.end);
      const handle = bbox && hitHandle(bbox, sx, sy, host.toScreen);
      if (handle) {
        startResizeDrag(handle, block, bbox, sx, sy);
        host.canvas.setPointerCapture(e.pointerId);
        return true;
      }
    }

    const [dx, dy] = host.toDesign(sx, sy);
    const pickRadius = OBJECT_PICK_RADIUS_PX / state.view.scale;
    const idx = SpatialLib.nearestStitch(state.design.stitches, dx, dy, pickRadius);
    if (idx === -1) {
      clearSelection();
      return false; // clique fora de qualquer objeto: cai no pan normal
    }
    const blockIndex = state.blocks.findIndex((b) => idx >= b.start && idx < b.end);
    if (blockIndex === -1) {
      clearSelection();
      return false;
    }
    selectBlock(blockIndex);
    const picked = state.blocks[blockIndex];
    startMoveDrag(picked, sx, sy);
    host.canvas.setPointerCapture(e.pointerId);
    return true;
  }

  function startMoveDrag(block, sx, sy) {
    const [startX, startY] = host.toDesign(sx, sy);
    oc.drag = {
      kind: 'move',
      moved: false,
      blockStart: block.start,
      blockEnd: block.end,
      origSegment: sliceCopy(host.state.design.stitches, block.start, block.end),
      startDesign: [startX, startY],
      liveTransform: null,
    };
    host.canvas.style.cursor = 'move';
  }

  function startResizeDrag(handle, block, bbox, sx, sy) {
    const [startX, startY] = host.toDesign(sx, sy);
    oc.drag = {
      kind: 'resize',
      handle,
      moved: false,
      blockStart: block.start,
      blockEnd: block.end,
      origSegment: sliceCopy(host.state.design.stitches, block.start, block.end),
      startDesign: [startX, startY],
      pivot: handlePoint(bbox, OPPOSITE[handle]),
      handleStart: handlePoint(bbox, handle),
      liveTransform: null,
    };
    host.canvas.style.cursor = CURSORS[handle];
  }

  // Aplica uma transformação barata (sem reconstrução de densidade) direto
  // no array vivo, só para a prévia visual durante o arraste. A regeneração
  // "de verdade" (densidade + guarda de espaçamento) só acontece ao soltar,
  // em finalizeDrag — ver regenerateBlock em src/core/minspacing.js.
  function applyLiveTransform(drag, transform) {
    const stitches = host.state.design.stitches;
    const seg = drag.origSegment;
    const { dx, dy, scaleX, scaleY, pivot } = transform;
    for (let i = 0; i < seg.length; i++) {
      const s = seg[i];
      const dst = stitches[drag.blockStart + i];
      dst[0] = Math.round(pivot[0] + (s[0] - pivot[0]) * scaleX + dx);
      dst[1] = Math.round(pivot[1] + (s[1] - pivot[1]) * scaleY + dy);
    }
  }

  function onPointerMove(e) {
    if (!oc.active) return false;
    if (!oc.drag) {
      updateHoverCursor(e);
      return false;
    }
    const drag = oc.drag;
    const state = host.state;
    const [sx, sy] = clientToCanvas(e);
    const [curX, curY] = host.toDesign(sx, sy);

    if (!drag.moved) {
      const movedDesign = Math.hypot(curX - drag.startDesign[0], curY - drag.startDesign[1]);
      if (movedDesign < 2 / state.view.scale) return true; // gesto já começou, mas ainda não passou do limiar de 2px
      host.snapshotUndo(); // ANTES da primeira mutação do gesto (não por pixel)
      drag.moved = true;
    }

    let transform;
    if (drag.kind === 'move') {
      transform = { dx: curX - drag.startDesign[0], dy: curY - drag.startDesign[1], scaleX: 1, scaleY: 1, pivot: [0, 0] };
    } else {
      const [sxFactor, syFactor] = resizeFactors(drag.pivot, drag.handleStart, [curX, curY], e.altKey);
      transform = { dx: 0, dy: 0, scaleX: sxFactor, scaleY: syFactor, pivot: drag.pivot };
    }
    drag.liveTransform = transform;
    applyLiveTransform(drag, transform);
    host.bumpArt();
    host.requestRender();
    return true;
  }

  function onPointerUp() {
    if (!oc.drag) return false;
    const drag = oc.drag;
    oc.drag = null;
    host.canvas.style.cursor = oc.active ? 'default' : '';
    if (!drag.moved) return true; // só foi um clique de seleção, nada a regenerar

    const state = host.state;
    const minSpacingMm = (state.settings.write && state.settings.write.minSpacingMm) || 0;
    const minSpacingUnits = minSpacingMm * 10; // unidades do design = 0,1 mm
    const transform = drag.liveTransform || { dx: 0, dy: 0, scaleX: 1, scaleY: 1, pivot: [0, 0] };
    const { stitches: regenerated, removed } = MinSpacing.regenerateBlock(drag.origSegment, transform, { minSpacingUnits });

    // slice+concat em vez de splice(...array): evita espalhar um array
    // grande como argumentos individuais para blocos com muitas agulhadas.
    const all = state.design.stitches;
    state.design.stitches = all.slice(0, drag.blockStart).concat(regenerated, all.slice(drag.blockEnd));

    host.deriveBlocks(); // mover/redimensionar não muda a quantidade de blocos, mas os índices são recalculados do zero
    oc.pendingWarning = removed > 0 ? host.tr('objects.warnMinSpacing', { n: removed }) : null;
    host.afterPointMutation();
    return true;
  }

  function updateHoverCursor(e) {
    if (!host.canvas) return;
    const block = selectedBlock();
    if (!block) {
      host.canvas.style.cursor = 'default';
      return;
    }
    const bbox = computeBBox(host.state.design.stitches, block.start, block.end);
    if (!bbox) {
      host.canvas.style.cursor = 'default';
      return;
    }
    const [sx, sy] = clientToCanvas(e);
    const handle = hitHandle(bbox, sx, sy, host.toScreen);
    host.canvas.style.cursor = handle ? CURSORS[handle] : 'default';
  }

  // ------------------------------------------------------------------- teclado

  function deleteSelected() {
    const state = host.state;
    const block = selectedBlock();
    if (!block) return;
    host.snapshotUndo();
    state.design.stitches.splice(block.start, block.end - block.start);
    oc.selected = -1;
    oc.drag = null;
    oc.pendingWarning = null;
    host.deriveBlocks();
    host.afterPointMutation();
  }

  function onKeyDown(e) {
    if (!oc.active) return false;
    const key = e.key.toLowerCase();
    if (key === 'escape') {
      clearSelection();
      return true;
    }
    if (key === 'delete' || key === 'backspace') {
      e.preventDefault();
      deleteSelected();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------- desenho

  function draw(ctx) {
    if (!oc.active) return;
    const block = selectedBlock();
    if (!block) return;
    const state = host.state;
    const bbox = computeBBox(state.design.stitches, block.start, block.end);
    if (!bbox) return;

    const p0 = host.toScreen(bbox.minX, bbox.minY);
    const p1 = host.toScreen(bbox.maxX, bbox.maxY);
    const x0 = Math.min(p0[0], p1[0]);
    const y0 = Math.min(p0[1], p1[1]);
    const w = Math.abs(p1[0] - p0[0]);
    const h = Math.abs(p1[1] - p0[1]);

    ctx.save();
    ctx.strokeStyle = '#e8a13d';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(w), Math.round(h));
    ctx.setLineDash([]);

    ctx.fillStyle = '#16130a';
    for (const name of HANDLES) {
      const [hx, hy] = handlePoint(bbox, name);
      const [sx, sy] = host.toScreen(hx, hy);
      ctx.fillRect(sx - HANDLE_PX, sy - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2);
      ctx.strokeRect(sx - HANDLE_PX, sy - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2);
    }
    ctx.restore();
  }

  const ObjectCanvas = {
    init,
    isActive,
    isDragging,
    setActive,
    toggle,
    reset,
    sidebarWarning,
    selectedIndex,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onKeyDown,
    draw,
  };

  if (typeof window !== 'undefined') {
    window.ObjectCanvas = ObjectCanvas;
  }
  // Exportado também para node:test exercitar a geometria pura sem DOM
  // (computeBBox/handlePoint/resizeFactors/hitHandle nunca tocam window/document).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeBBox, handlePoint, resizeFactors, hitHandle, HANDLES, OPPOSITE };
  }
})();
