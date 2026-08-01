'use strict';
// Modo de seleção de objetos (issue #29).
//
// Fase 1 (na main): trata os blocos de cor do desenho (ver deriveBlocks em
// renderer.js) como objetos Inkscape-like — clicar seleciona (bbox + 8
// alças), arrastar move, alças redimensionam (proporcional por padrão, livre
// com Alt), Delete apaga, Esc desseleciona. Redimensionar escala as
// coordenadas do bloco (mantendo densidade via src/core/densityscale.js).
//
// Fase 2 (este arquivo): as ferramentas paramétricas (texto, importação de
// SVG, digitalização de imagem) passam a registrar um OBJETO em
// design.objects[] — o `source` (payload paramétrico) e os `stitchParams`
// usados na inserção, ver src/core/objectmodel.js. Um objeto pode ocupar
// vários blocos de cor consecutivos (ex.: SVG com preenchimento + contorno).
// Redimensionar PROPORCIONALMENTE um objeto com `source` roda o MESMO
// gerador de novo (window.api.letteringBuild/importSvg/digitizeGenerate) com
// o tamanho-alvo ajustado pelo fator do gesto — densidade/espaçamento/
// comprimento de ponto continuam exatamente como configurados, em vez de
// escalar coordenadas. Redimensionar LIVRE (Alt) e mover continuam no
// caminho antigo (fase 1: escala de coordenadas + guarda de espaçamento),
// porque nenhum dos três geradores aceita controle independente por eixo.
// Blocos sem objeto associado (arquivo de máquina aberto) também continuam
// no caminho antigo — "stitch-block" da issue é isso: opaco, sem source.
//
// Carregado por <script> ANTES de renderer.js (depois de densityscale.js,
// spatial.js, minspacing.js e objectmodel.js): tudo fica dentro desta IIFE —
// script clássico compartilha o escopo global da página, e identificadores
// como `state`, `api` ou `COMMAND_MASK` já existem em renderer.js/preload.js.
// Só "window.ObjectCanvas" escapa. renderer.js só tem os ganchos mínimos
// (pointerdown/pointermove/pointerup/render/keydown) chamando os métodos
// abaixo, mais os pontos de registro de objeto nas próprias ferramentas
// (insertTextDesign/applySvgImport/confirmDigitize) — ver relatório da
// tarefa para a lista exata. Toda a lógica de gesto, hit-test, regeneração e
// desenho do overlay mora aqui.
//
// A ponte com o estado "vivo" do renderer (state, toScreen/toDesign, canvas,
// snapshotUndo, deriveBlocks, afterPointMutation, setEditMode, simReset, tr,
// updateToolbarEnabled, decodeDataURLImage) é injetada explicitamente por
// ObjectCanvas.init(...) dentro de boot() — em vez de depender da ordem de
// carregamento dos scripts, o que funcionaria (const de nível de topo de um
// script clássico entra no ambiente léxico global, visível a qualquer código
// que rode depois) mas seria implícito e frágil a reordenações futuras (ver
// issue #33, reestruturação de renderer.js em paralelo).

(function () {
  // spatial.js só expõe o identificador léxico "Spatial" (const de topo de
  // um script clássico), não window.Spatial como densityscale.js/
  // minspacing.js/objectmodel.js — por isso o fallback do navegador aqui lê
  // o identificador global direto (spatial.js já rodou, carrega antes no
  // index.html), e não "window.Spatial". De propósito, nenhuma variável
  // chamada "Spatial" é declarada neste arquivo: sombrear o identificador
  // quebraria essa leitura (o "const" local ainda não estaria inicializado
  // nesse ponto).
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
  function resolveObjectModel() {
    if (typeof window !== 'undefined' && window.ObjectModel) return window.ObjectModel;
    if (typeof module !== 'undefined' && module.exports) return require('../core/objectmodel.js');
    return null;
  }
  const SpatialLib = resolveSpatial();
  const MinSpacing = resolveMinSpacing();
  const ObjectModel = resolveObjectModel();

  // Duplicados localmente (mesma convenção de spatial.js/densityscale.js):
  // evita depender da ordem de carregamento pras constantes de comando.
  const STITCH_CMD = 0;
  const JUMP_CMD = 1;
  const END_CMD = 5;
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
    selected: -1, // índice em host.state.blocks (bloco "âncora", ver currentUnit), ou -1
    drag: null, // gesto em andamento (mover/redimensionar), ver startMoveDrag/startResizeDrag
    pendingWarning: null, // mensagem da guarda de espaçamento mínimo (side bar), ou null
    regenerating: false, // true enquanto uma regeneração paramétrica está em voo (issue #29 fase 2)
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

  // Só leitura: índice do bloco "âncora" selecionado (-1 se nenhum) — o
  // bloco onde o usuário clicou, não necessariamente o primeiro bloco do
  // objeto (ver currentUnit para a faixa inteira). Usado pela barra de
  // status/depuração e pelo harness de verificação (issue #29).
  function selectedIndex() {
    return oc.selected;
  }

  // Só leitura: bbox (coords de desenho) da unidade selecionada no momento,
  // ou null se não há seleção — a faixa inteira do objeto quando há um
  // (várias cores possivelmente), não só o bloco "âncora". Usado pelo
  // harness de UI (issue #29 fase 2) pra calcular a posição exata das alças
  // sem duplicar a lógica de hit-test aqui.
  function selectedBBox() {
    const unit = currentUnit();
    if (!unit || !host.state.design) return null;
    return computeBBox(host.state.design.stitches, unit.start, unit.end);
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

  // Unidade de manipulação do bloco selecionado no momento: a faixa inteira
  // de um objeto paramétrico (issue #29 fase 2, possivelmente vários blocos
  // de cor) quando o bloco pertence a um, ou o bloco sozinho (fase 1,
  // "stitch-block" — arquivo de máquina aberto ou objeto dessincronizado).
  // Devolve null se não há seleção válida. Ver ObjectModel.findUnit.
  function currentUnit() {
    const state = host.state;
    if (!state.design || oc.selected < 0 || oc.selected >= state.blocks.length) return null;
    return ObjectModel.findUnit(state.design.objects || [], state.blocks, oc.selected);
  }

  // ------------------------------------------------------------------- gestos

  function clientToCanvas(e) {
    const rect = host.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  function onPointerDown(e) {
    if (!oc.active || !host || !host.state.design || oc.regenerating) return false;
    const state = host.state;
    const [sx, sy] = clientToCanvas(e);

    const unit = currentUnit();
    if (unit) {
      const bbox = computeBBox(state.design.stitches, unit.start, unit.end);
      const handle = bbox && hitHandle(bbox, sx, sy, host.toScreen);
      if (handle) {
        startResizeDrag(handle, unit, bbox, sx, sy);
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
    const pickedUnit = currentUnit();
    startMoveDrag(pickedUnit, sx, sy);
    host.canvas.setPointerCapture(e.pointerId);
    return true;
  }

  function startMoveDrag(unit, sx, sy) {
    const [startX, startY] = host.toDesign(sx, sy);
    oc.drag = {
      kind: 'move',
      moved: false,
      start: unit.start,
      end: unit.end,
      object: unit.object,
      unitBlockStart: unit.blockStart,
      unitBlockEnd: unit.blockEnd,
      origSegment: sliceCopy(host.state.design.stitches, unit.start, unit.end),
      origBBox: computeBBox(host.state.design.stitches, unit.start, unit.end),
      startDesign: [startX, startY],
      liveTransform: null,
    };
    host.canvas.style.cursor = 'move';
  }

  function startResizeDrag(handle, unit, bbox, sx, sy) {
    const [startX, startY] = host.toDesign(sx, sy);
    oc.drag = {
      kind: 'resize',
      handle,
      moved: false,
      start: unit.start,
      end: unit.end,
      object: unit.object,
      unitBlockStart: unit.blockStart,
      unitBlockEnd: unit.blockEnd,
      origSegment: sliceCopy(host.state.design.stitches, unit.start, unit.end),
      origBBox: bbox,
      startDesign: [startX, startY],
      pivot: handlePoint(bbox, OPPOSITE[handle]),
      handleStart: handlePoint(bbox, handle),
      liveTransform: null,
    };
    host.canvas.style.cursor = CURSORS[handle];
  }

  // Aplica uma transformação barata (sem reconstrução de densidade) direto
  // no array vivo, só para a prévia visual durante o arraste. A regeneração
  // "de verdade" (paramétrica ou densidade + guarda de espaçamento) só
  // acontece ao soltar, em finalizeDrag/onPointerUp.
  function applyLiveTransform(drag, transform) {
    const stitches = host.state.design.stitches;
    const seg = drag.origSegment;
    const { dx, dy, scaleX, scaleY, pivot } = transform;
    for (let i = 0; i < seg.length; i++) {
      const s = seg[i];
      const dst = stitches[drag.start + i];
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

  // Confirma o gesto pelo caminho ANTIGO (fase 1): escala de coordenadas do
  // trecho + guarda de espaçamento mínimo. Usado para mover (nunca muda
  // densidade, só translada), redimensionar livre/Alt (nenhum gerador aceita
  // eixos independentes) e qualquer bloco sem objeto paramétrico associado.
  // Também serve de FALLBACK se a regeneração paramétrica falhar ou sair
  // com uma contagem de cores diferente da esperada (ver regenerateParametric).
  function commitLegacyTransform(drag, transform) {
    const state = host.state;
    const minSpacingMm = (state.settings.write && state.settings.write.minSpacingMm) || 0;
    const minSpacingUnits = minSpacingMm * 10; // unidades do design = 0,1 mm
    const { stitches: regenerated, removed } = MinSpacing.regenerateBlock(drag.origSegment, transform, { minSpacingUnits });

    // slice+concat em vez de splice(...array): evita espalhar um array
    // grande como argumentos individuais para objetos com muitas agulhadas.
    const all = state.design.stitches;
    state.design.stitches = all.slice(0, drag.start).concat(regenerated, all.slice(drag.end));

    host.deriveBlocks(); // mover/redimensionar não muda a quantidade de blocos, mas os índices são recalculados do zero
    oc.pendingWarning = removed > 0 ? host.tr('objects.warnMinSpacing', { n: removed }) : null;
    host.afterPointMutation();
  }

  // Remove um eventual C.END (5) do FIM do trecho: o gerador paramétrico
  // sempre produz um Pattern autocontido (pattern.end() grava um END), mas
  // um END só pode existir na última posição do design INTEIRO — o mesmo
  // ajuste que insertTextDesign já faz em renderer.js ao emendar texto.
  function stripTrailingEnd(stitches) {
    if (stitches.length && (stitches[stitches.length - 1][2] & COMMAND_MASK) === END_CMD) {
      return stitches.slice(0, -1);
    }
    return stitches;
  }

  // Roda o gerador de verdade (issue #29 fase 2) para um objeto paramétrico
  // redimensionado PROPORCIONALMENTE: recalcula os parâmetros com o novo
  // tamanho-alvo (ObjectModel.resizedXParams — densidade/espaçamento
  // continuam os mesmos), chama a MESMA API que a inserção original usou,
  // realinha o resultado (centralizado na convenção do gerador) ao
  // retângulo-alvo que o usuário desenhou arrastando a alça, roda a guarda
  // de espaçamento mínimo e substitui o trecho antigo. Se qualquer coisa
  // falhar ou sair inconsistente (nº de cores mudou), cai no caminho antigo
  // (commitLegacyTransform) — o gesto nunca fica "pendurado" sem efeito.
  async function regenerateParametric(drag, transform) {
    const object = drag.object;
    const factor = transform.scaleX; // proporcional garantido por ObjectModel.canRegenerate
    const designRef = host.state.design; // ver comentário abaixo sobre corrida
    oc.regenerating = true;
    host.updateToolbarEnabled();

    try {
      let newDesign = null;
      let newStitchParams = null;

      if (object.type === ObjectModel.TYPES.TEXT) {
        newStitchParams = ObjectModel.resizedTextParams(object.stitchParams, factor);
        const res = await window.api.letteringBuild(Object.assign({}, object.source, newStitchParams));
        if (res && res.ok && res.design.stitches.length) newDesign = res.design;
      } else if (object.type === ObjectModel.TYPES.SVG_SHAPE) {
        newStitchParams = ObjectModel.resizedSvgParams(object.stitchParams, factor);
        const res = await window.api.importSvg({
          text: object.source.svgText,
          opts: newStitchParams,
          name: object.source.name,
          path: object.source.path,
          preview: true,
        });
        if (res && res.ok && res.design.stitches.length) newDesign = res.design;
      } else if (object.type === ObjectModel.TYPES.RASTER_TRACE) {
        const imageData = await host.decodeDataURLImage(object.source.imageDataURL);
        newStitchParams = ObjectModel.resizedRasterParams(object.stitchParams, factor);
        const opts = ObjectModel.rasterOptsFromParams(newStitchParams, imageData.width);
        const design = await window.api.digitizeGenerate(imageData, opts);
        if (design && design.stitches.length) newDesign = design;
      }

      // Corrida: se o design foi trocado (outro arquivo aberto, undo/redo)
      // enquanto a chamada IPC estava em voo, descarta o resultado — não há
      // mais um "trecho antigo" válido para substituir.
      if (host.state.design !== designRef) return;

      const expectedColors = drag.unitBlockEnd - drag.unitBlockStart;
      if (!newDesign || newDesign.threads.length !== expectedColors) {
        commitLegacyTransform(drag, transform);
        return;
      }

      let seg = stripTrailingEnd(newDesign.stitches.map((s) => [s[0], s[1], s[2]]));
      const newBBox = computeBBox(seg, 0, seg.length);
      const targetBBox = ObjectModel.transformBBox(drag.origBBox, transform);
      if (newBBox) {
        const [ox, oy] = ObjectModel.centerAlignOffset(newBBox, targetBBox);
        for (const s of seg) {
          s[0] = Math.round(s[0] + ox);
          s[1] = Math.round(s[1] + oy);
        }
      }

      const state = host.state;
      const minSpacingMm = (state.settings.write && state.settings.write.minSpacingMm) || 0;
      const minSpacingUnits = minSpacingMm * 10;
      const { stitches: finalSeg, removed } = MinSpacing.enforceMinSpacing(seg, minSpacingUnits);

      const all = state.design.stitches;
      const wasLast = drag.end === all.length;
      const hadTrailingEnd = wasLast && all.length > 0 && (all[all.length - 1][2] & COMMAND_MASK) === END_CMD;
      let combined = all.slice(0, drag.start).concat(finalSeg, all.slice(drag.end));
      if (hadTrailingEnd && combined.length) {
        const last = combined[combined.length - 1];
        combined.push([last[0], last[1], END_CMD]);
      }
      state.design.stitches = combined;
      state.design.threads = state.design.threads
        .slice(0, drag.unitBlockStart)
        .concat(newDesign.threads.map((t) => (t ? Object.assign({}, t) : null)), state.design.threads.slice(drag.unitBlockEnd));

      object.stitchParams = newStitchParams; // persiste o novo tamanho (próximo redimensionamento parte daqui)

      host.deriveBlocks();
      oc.pendingWarning = removed > 0 ? host.tr('objects.warnMinSpacing', { n: removed }) : null;
      host.afterPointMutation();
    } catch (err) {
      if (host.state.design === designRef) commitLegacyTransform(drag, transform);
    } finally {
      oc.regenerating = false;
      host.updateToolbarEnabled();
    }
  }

  function onPointerUp() {
    if (!oc.drag) return false;
    const drag = oc.drag;
    oc.drag = null;
    host.canvas.style.cursor = oc.active ? 'default' : '';
    if (!drag.moved) return true; // só foi um clique de seleção, nada a regenerar

    const transform = drag.liveTransform || { dx: 0, dy: 0, scaleX: 1, scaleY: 1, pivot: [0, 0] };
    const canRegen = drag.kind === 'resize' && drag.object && drag.object.source && ObjectModel.canRegenerate(transform);
    if (canRegen) {
      regenerateParametric(drag, transform); // assíncrono (IPC): ver função acima
    } else {
      commitLegacyTransform(drag, transform);
    }
    return true;
  }

  function updateHoverCursor(e) {
    if (!host.canvas) return;
    const unit = currentUnit();
    if (!unit) {
      host.canvas.style.cursor = 'default';
      return;
    }
    const bbox = computeBBox(host.state.design.stitches, unit.start, unit.end);
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
    const unit = currentUnit();
    if (!unit) return;
    host.snapshotUndo();
    state.design.stitches.splice(unit.start, unit.end - unit.start);
    if (unit.object && state.design.objects) {
      const i = state.design.objects.indexOf(unit.object);
      if (i !== -1) state.design.objects.splice(i, 1);
    }
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
    const unit = currentUnit();
    if (!unit) return;
    const state = host.state;
    const bbox = computeBBox(state.design.stitches, unit.start, unit.end);
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

  // ---------------------------------------------------------- registro de objetos

  // Chamado pelas ferramentas paramétricas (insertTextDesign/applySvgImport/
  // confirmDigitize em renderer.js) logo depois de inserir o resultado no
  // design: registra o objeto paramétrico (issue #29 fase 2) para que um
  // redimensionamento futuro rode o gerador de novo em vez de escalar
  // coordenadas. `blockCount` é quantos blocos de cor consecutivos, a partir
  // de onde os objetos anteriores pararam, este objeto acabou de inserir.
  function registerObject(type, source, stitchParams, blockCount) {
    const state = host.state;
    if (!state.design) return;
    if (!state.design.objects) state.design.objects = [];
    state.design.objects.push(ObjectModel.makeObject(type, source, stitchParams, blockCount));
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
    selectedBBox,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onKeyDown,
    draw,
    registerObject,
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
