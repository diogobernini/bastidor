'use strict';
// Modo de seleção de objetos (issue #29).
//
// Fase 1 (na main): trata os blocos de cor do desenho (ver deriveBlocks em
// renderer.js) como objetos Inkscape-like — clicar seleciona (bbox + 8
// alças), arrastar move, alças redimensionam (proporcional por padrão, livre
// com Alt), Delete apaga, Esc desseleciona. Redimensionar escala as
// coordenadas do bloco (mantendo densidade via src/core/densityscale.js).
//
// Fase 2: as ferramentas paramétricas (texto, importação de SVG,
// digitalização de imagem) passam a registrar um OBJETO em design.objects[]
// — o `source` (payload paramétrico) e os `stitchParams` usados na
// inserção, ver src/core/objectmodel.js. Um objeto pode ocupar vários
// blocos de cor consecutivos (ex.: SVG com preenchimento + contorno).
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
// Fase 3 (este arquivo, issue #29): rotação, seleção múltipla, alinhar/
// distribuir e duplicar (geometria pura em src/core/objectmodel.js; o gesto
// de rotação e a seleção múltipla moram aqui). Decisões de escopo, sempre
// documentadas nos comentários dos trechos correspondentes:
//   - a alça de rotação e o redimensionamento por alça só aparecem com
//     EXATAMENTE 1 unidade selecionada (redimensionar/girar em grupo ao
//     redor de um pivô comum ficou fora — a issue não pede explicitamente
//     e a combinação com regeneração paramétrica por objeto ficaria bem
//     mais arriscada). Mover e apagar funcionam com qualquer nº de unidades.
//   - redimensionar um objeto paramétrico já girado usa o bbox AXIS-ALIGNED
//     atual (mundo/tela) como sempre (mesma convenção de fase 1/2); a
//     rotação guardada é reaplicada DEPOIS da regeneração (ver
//     regenerateParametric) alinhada ao centro do bbox-alvo — combinações
//     de rotação forte + redimensionamento não ficam pixel-perfeitas, mas
//     cada uma das duas operações isoladamente fica exata.
//   - o painel de ordem de costura reordena QUALQUER par de unidades
//     adjacentes (mesmo cruzando "bloco solto" x "objeto paramétrico"):
//     ver ObjectModel.normalizeObjects/swapUnits — a lacuna de blocos soltos
//     sem entrada em objects[] é preenchida com STITCH_BLOCK opacos antes
//     de trocar, então não há restrição de fronteira.
//   - duplicar sempre ANEXA a cópia ao FIM da sequência de bordado (não
//     logo depois do original) — evita mexer em "objects[] no meio do
//     array" (ver normalizeObjects), que já é o bastante para reordenar mas
//     complicaria demais a inserção no meio também para esta fase.
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
// desenho do overlay mora aqui. O painel da sidebar (duplicar/alinhar/
// distribuir/ordem de costura, fase 3) também é construído e ligado por
// este arquivo (mesmo padrão já usado pelo botão "btn-objects" em
// setActive): renderer.js só ganha UMA linha nova (updateSidebar chamando
// ObjectCanvas.refreshPanel(), para o painel ficar em dia depois de
// undo/redo e de abrir outro arquivo — ver boot()/updateSidebar em
// renderer.js).
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
  // Precisam bater com src/core/commands.js: STITCH=0, JUMP=1, END=4,
  // COLOR_CHANGE=5, SEQUIN_EJECT=7.
  const STITCH_CMD = 0;
  const JUMP_CMD = 1;
  const END_CMD = 4;
  const COLOR_CHANGE_CMD = 5;
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

  // ------------------------------------------------------------- issue #29 fase 3
  const ROTATE_HANDLE_OFFSET_PX = 26; // distância (px de tela) entre a alça "n" e a alça de rotação, acima dela
  const ROTATE_HANDLE_HIT_PX = 9; // raio clicável da alça de rotação
  const ROTATE_SNAP_DEG = 15; // passo do snap opcional (Shift durante o arraste)
  const DUPLICATE_OFFSET_UNITS = 30; // deslocamento da cópia (3 mm, unidades de 0,1 mm)
  const MARQUEE_MOVE_THRESHOLD_PX = 2; // abaixo disso, um "arraste" de marquee vira só um clique

  let host = null; // injetado via init(); ver cabeçalho do arquivo.

  const oc = {
    active: false,
    selection: [], // índices em host.state.blocks (âncoras da seleção; ver currentUnits/unitsFromAnchors)
    drag: null, // gesto em andamento (mover/redimensionar/girar/marquee), ver start*Drag
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

  // Ponto de tela da alça de rotação: um pouco acima da alça "n" (issue #29
  // fase 3). Fica em coordenadas de TELA (não gira com o objeto) — mesma
  // convenção axis-aligned do resto do overlay (ver nota de escopo no
  // cabeçalho do arquivo).
  function rotateHandleScreenPoint(bbox, toScreen) {
    const [nx, ny] = handlePoint(bbox, 'n');
    const [sx, sy] = toScreen(nx, ny);
    return [sx, sy - ROTATE_HANDLE_OFFSET_PX];
  }

  function hitRotateHandle(bbox, screenX, screenY, toScreen) {
    const [hx, hy] = rotateHandleScreenPoint(bbox, toScreen);
    return Math.hypot(hx - screenX, hy - screenY) <= ROTATE_HANDLE_HIT_PX;
  }

  // Dois bboxes (design coords) se sobrepõem? Usado pela seleção por
  // marquee (issue #29 fase 3): qualquer unidade cujo bbox toque o
  // retângulo arrastado entra na seleção.
  function bboxIntersects(a, b) {
    return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
  }

  function sliceCopy(stitches, start, end) {
    const out = new Array(end - start);
    for (let i = start; i < end; i++) {
      const s = stitches[i];
      out[i - start] = [s[0], s[1], s[2]];
    }
    return out;
  }

  // Remove um eventual C.END (4) do FIM do trecho: o gerador paramétrico
  // sempre produz um Pattern autocontido (pattern.end() grava um END), mas
  // um END só pode existir na última posição do design INTEIRO — o mesmo
  // ajuste que insertTextDesign já faz em renderer.js ao emendar texto.
  function stripTrailingEnd(stitches) {
    if (stitches.length && (stitches[stitches.length - 1][2] & COMMAND_MASK) === END_CMD) {
      return stitches.slice(0, -1);
    }
    return stitches;
  }

  // ------------------------------------------------------------------- ciclo de vida

  function init(hostApi) {
    host = hostApi;
    initPanelDom();
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
      oc.selection = [];
      oc.pendingWarning = null;
      host.canvas.style.cursor = '';
    }
    document.getElementById('btn-objects').classList.toggle('on', active);
    host.updateToolbarEnabled();
    refreshPanel();
    host.requestRender();
  }

  function toggle() {
    setActive(!oc.active);
  }

  // Índices de bloco deixam de ser confiáveis depois de um undo ou de abrir
  // outro arquivo (o array de agulhadas foi substituído por completo).
  function reset() {
    oc.selection = [];
    oc.drag = null;
    oc.pendingWarning = null;
    refreshPanel();
  }

  function sidebarWarning() {
    return oc.pendingWarning;
  }

  // ------------------------------------------------------------------- seleção
  //
  // Seleção múltipla (issue #29 fase 3): oc.selection guarda as âncoras
  // (índices de state.blocks onde o usuário clicou/shift-clicou), não as
  // unidades em si — uma unidade paramétrica de vários blocos pode ter mais
  // de uma âncora (shift-clique em cores diferentes do MESMO objeto), então
  // toda leitura passa por unitsFromAnchors, que deduplica por faixa de
  // agulhadas (start:end).

  function unitsFromAnchors(anchors) {
    const state = host.state;
    if (!state || !state.design) return [];
    const seen = new Map(); // "start:end" -> unit
    for (const idx of anchors) {
      if (idx < 0 || idx >= state.blocks.length) continue;
      const unit = ObjectModel.findUnit(state.design.objects || [], state.blocks, idx);
      if (!unit) continue;
      const key = unit.start + ':' + unit.end;
      if (!seen.has(key)) seen.set(key, unit);
    }
    return Array.from(seen.values()).sort((a, b) => a.start - b.start);
  }

  // Todas as unidades atualmente selecionadas (0, 1 ou várias), na ordem de
  // bordado. Usada por apagar/duplicar/alinhar/distribuir/bbox conjunta.
  function currentUnits() {
    return unitsFromAnchors(oc.selection);
  }

  // Unidade "âncora" (primeira da seleção) — só faz sentido para os gestos
  // que exigem seleção única (redimensionar, girar; ver nota de escopo no
  // cabeçalho do arquivo). null se não há seleção.
  function currentUnit() {
    const units = currentUnits();
    return units.length ? units[0] : null;
  }

  function selectionRangeKeys() {
    return new Set(currentUnits().map((u) => u.start + ':' + u.end));
  }

  function isBlockIndexSelected(blockIndex) {
    const state = host.state;
    if (!state.design || blockIndex < 0 || blockIndex >= state.blocks.length) return false;
    const unit = ObjectModel.findUnit(state.design.objects || [], state.blocks, blockIndex);
    if (!unit) return false;
    return selectionRangeKeys().has(unit.start + ':' + unit.end);
  }

  function replaceSelection(blockIndex) {
    oc.selection = [blockIndex];
    oc.pendingWarning = null;
    refreshPanel();
    host.requestRender();
  }

  // Shift+clique (issue #29 fase 3): alterna a unidade que contém
  // `blockIndex` dentro/fora da seleção. Se a unidade já está selecionada
  // por QUALQUER âncora (ela pode ter mais de uma), remove todas; senão
  // acrescenta blockIndex como uma nova âncora.
  function toggleSelection(blockIndex) {
    const state = host.state;
    const unit = ObjectModel.findUnit(state.design.objects || [], state.blocks, blockIndex);
    if (!unit) return;
    const key = unit.start + ':' + unit.end;
    if (selectionRangeKeys().has(key)) {
      oc.selection = oc.selection.filter((idx) => {
        if (idx < 0 || idx >= state.blocks.length) return false;
        const u = ObjectModel.findUnit(state.design.objects || [], state.blocks, idx);
        return !u || u.start + ':' + u.end !== key;
      });
    } else {
      oc.selection.push(blockIndex);
    }
    oc.pendingWarning = null;
    refreshPanel();
    host.requestRender();
  }

  function clearSelection() {
    if (oc.selection.length === 0 && !oc.drag) return;
    oc.selection = [];
    oc.drag = null;
    oc.pendingWarning = null;
    refreshPanel();
    host.requestRender();
  }

  // Só leitura: índice do bloco "âncora primária" (-1 se nenhuma seleção) —
  // usado pela barra de status/depuração e pelo harness de UI (issue #29).
  function selectedIndex() {
    return oc.selection.length ? oc.selection[0] : -1;
  }

  // Só leitura: quantas unidades distintas estão selecionadas agora (issue
  // #29 fase 3) — usado pelo harness de UI para confirmar seleção múltipla.
  function selectionCount() {
    return currentUnits().length;
  }

  // Só leitura: ponto de TELA (coords do canvas) da alça de rotação da
  // seleção atual, ou null se não há seleção única (ver nota de escopo no
  // cabeçalho). Usado só pelo harness de UI (issue #29 fase 3), para
  // arrastar a alça sem duplicar a constante de offset (ROTATE_HANDLE_
  // OFFSET_PX) no teste.
  function rotateHandlePoint() {
    if (oc.selection.length !== 1) return null;
    const unit = currentUnit();
    const state = host.state;
    const bbox = unit && state.design && computeBBox(state.design.stitches, unit.start, unit.end);
    if (!bbox) return null;
    const [x, y] = rotateHandleScreenPoint(bbox, host.toScreen);
    return { x, y };
  }

  // Só leitura: ângulo acumulado (graus) do objeto paramétrico da unidade
  // selecionada (ver object.transform.rotation), ou null se a seleção não
  // é única ou a unidade não tem objeto associado (bloco solto). Usado só
  // pelo harness de UI para confirmar que uma rotação foi aplicada de
  // verdade, sem expor o objeto inteiro.
  function selectedObjectRotation() {
    const unit = currentUnit();
    if (!unit || !unit.object) return null;
    return (unit.object.transform && unit.object.transform.rotation) || 0;
  }

  // Só leitura: bbox (coords de desenho) CONJUNTA da seleção atual — a
  // união das faixas inteiras de cada unidade selecionada (uma unidade só,
  // como nas fases 1/2, ou várias). null se não há seleção válida. Usado
  // pelo harness de UI para calcular a posição das alças/handles sem
  // duplicar a lógica de hit-test aqui.
  function selectedBBox() {
    const state = host.state;
    if (!state.design) return null;
    const units = currentUnits();
    if (!units.length) return null;
    const boxes = units.map((u) => computeBBox(state.design.stitches, u.start, u.end));
    return ObjectModel.unionBBoxes(boxes);
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

    // Alças (rotação e redimensionamento) só existem com 1 unidade
    // selecionada (ver nota de escopo no cabeçalho).
    if (oc.selection.length === 1) {
      const unit = currentUnit();
      const bbox = unit && computeBBox(state.design.stitches, unit.start, unit.end);
      if (bbox) {
        if (hitRotateHandle(bbox, sx, sy, host.toScreen)) {
          startRotateDrag(unit, bbox, sx, sy);
          host.canvas.setPointerCapture(e.pointerId);
          return true;
        }
        const handle = hitHandle(bbox, sx, sy, host.toScreen);
        if (handle) {
          startResizeDrag(handle, unit, bbox, sx, sy);
          host.canvas.setPointerCapture(e.pointerId);
          return true;
        }
      }
    }

    const [dx, dy] = host.toDesign(sx, sy);
    const pickRadius = OBJECT_PICK_RADIUS_PX / state.view.scale;
    const idx = SpatialLib.nearestStitch(state.design.stitches, dx, dy, pickRadius);
    const blockIndex = idx === -1 ? -1 : state.blocks.findIndex((b) => idx >= b.start && idx < b.end);

    if (blockIndex === -1) {
      // Clique fora de qualquer objeto: marquee (issue #29 fase 3), não pan
      // — o modo de objetos troca o pan por arrastar-para-selecionar,
      // igual à ferramenta de seleção do Inkscape.
      startMarqueeDrag(sx, sy, e.shiftKey);
      host.canvas.setPointerCapture(e.pointerId);
      return true;
    }

    if (e.shiftKey) {
      toggleSelection(blockIndex); // shift+clique só ajusta a seleção, não arrasta
      return true;
    }

    // Clique sem shift: se o alvo já faz parte de um grupo selecionado
    // (mais de 1 unidade), mantém o grupo inteiro e arrasta todos juntos;
    // senão troca a seleção para só esta unidade.
    if (oc.selection.length <= 1 || !isBlockIndexSelected(blockIndex)) {
      replaceSelection(blockIndex);
    }
    startMoveDrag(sx, sy);
    host.canvas.setPointerCapture(e.pointerId);
    return true;
  }

  function startMoveDrag(sx, sy) {
    const state = host.state;
    const units = currentUnits();
    const [startX, startY] = host.toDesign(sx, sy);
    oc.drag = {
      kind: 'move',
      moved: false,
      units: units.map((u) => ({ start: u.start, end: u.end, origSegment: sliceCopy(state.design.stitches, u.start, u.end) })),
      startDesign: [startX, startY],
      liveDelta: null,
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

  // Alça de rotação (issue #29 fase 3): guarda o centro do bbox (pivô fixo
  // do giro) e o ângulo inicial do ponteiro relativo a ele; onPointerMove
  // só precisa do delta entre o ângulo atual e este.
  function startRotateDrag(unit, bbox, sx, sy) {
    const center = [(bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2];
    const [startX, startY] = host.toDesign(sx, sy);
    const startAngle = Math.atan2(startY - center[1], startX - center[0]);
    oc.drag = {
      kind: 'rotate',
      moved: false,
      start: unit.start,
      end: unit.end,
      object: unit.object,
      origSegment: sliceCopy(host.state.design.stitches, unit.start, unit.end),
      center,
      startAngle,
      startDesign: [startX, startY],
      liveDeltaRad: 0,
    };
    host.canvas.style.cursor = 'grabbing';
  }

  // Marquee (issue #29 fase 3): retângulo de seleção em coords de TELA
  // (convertido para desenho só na hora de finalizar, ver finalizeMarquee) —
  // não precisa acompanhar pan/zoom durante o próprio gesto porque a
  // referência (host.toDesign) é aplicada de novo no final.
  function startMarqueeDrag(sx, sy, additive) {
    oc.drag = {
      kind: 'marquee',
      moved: false,
      additive: !!additive,
      startScreen: [sx, sy],
      curScreen: [sx, sy],
    };
    host.canvas.style.cursor = 'crosshair';
  }

  // Aplica uma transformação barata (sem reconstrução de densidade) direto
  // no array vivo, só para a prévia visual durante o arraste. A regeneração
  // "de verdade" (paramétrica ou densidade + guarda de espaçamento) só
  // acontece ao soltar, em finalizeDrag/onPointerUp. Usada só por 'resize'
  // (seleção única); 'move' tem sua própria versão multi-unidade, ver
  // applyLiveMove.
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

  // Prévia de mover (issue #29 fase 3, generaliza a fase 1 para várias
  // unidades ao mesmo tempo): translação pura, mesma dx/dy para todas.
  function applyLiveMove(drag, dx, dy) {
    const stitches = host.state.design.stitches;
    for (const u of drag.units) {
      for (let i = 0; i < u.origSegment.length; i++) {
        const s = u.origSegment[i];
        const dst = stitches[u.start + i];
        dst[0] = Math.round(s[0] + dx);
        dst[1] = Math.round(s[1] + dy);
      }
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

    if (drag.kind === 'marquee') {
      drag.curScreen = [sx, sy];
      if (!drag.moved && Math.hypot(sx - drag.startScreen[0], sy - drag.startScreen[1]) >= MARQUEE_MOVE_THRESHOLD_PX) {
        drag.moved = true;
      }
      host.requestRender();
      return true;
    }

    const [curX, curY] = host.toDesign(sx, sy);

    if (!drag.moved) {
      const movedDesign = Math.hypot(curX - drag.startDesign[0], curY - drag.startDesign[1]);
      if (movedDesign < 2 / state.view.scale) return true; // gesto já começou, mas ainda não passou do limiar de 2px
      host.snapshotUndo(); // ANTES da primeira mutação do gesto (não por pixel)
      drag.moved = true;
    }

    if (drag.kind === 'move') {
      const dx = curX - drag.startDesign[0];
      const dy = curY - drag.startDesign[1];
      drag.liveDelta = [dx, dy];
      applyLiveMove(drag, dx, dy);
    } else if (drag.kind === 'rotate') {
      const angle = Math.atan2(curY - drag.center[1], curX - drag.center[0]);
      let deltaRad = angle - drag.startAngle;
      if (e.shiftKey) {
        const deltaDeg = ObjectModel.snapAngleDeg((deltaRad * 180) / Math.PI, ROTATE_SNAP_DEG);
        deltaRad = (deltaDeg * Math.PI) / 180;
      }
      drag.liveDeltaRad = deltaRad;
      const rotated = ObjectModel.rotateSegment(drag.origSegment, drag.center[0], drag.center[1], deltaRad);
      for (let i = 0; i < rotated.length; i++) {
        const dst = state.design.stitches[drag.start + i];
        dst[0] = rotated[i][0];
        dst[1] = rotated[i][1];
      }
    } else {
      const [sxFactor, syFactor] = resizeFactors(drag.pivot, drag.handleStart, [curX, curY], e.altKey);
      const transform = { dx: 0, dy: 0, scaleX: sxFactor, scaleY: syFactor, pivot: drag.pivot };
      drag.liveTransform = transform;
      applyLiveTransform(drag, transform);
    }
    host.bumpArt();
    host.requestRender();
    return true;
  }

  // Confirma um "mover" (issue #29 fase 3: 1 ou várias unidades) pelo
  // caminho antigo (translação pura de cada trecho + guarda de espaçamento
  // mínimo, nunca regenera densidade — uma translação não aproxima pontos
  // entre si, mas outra unidade pode ter ficado perto de uma agulhada
  // vizinha). Translação nunca muda o TAMANHO de um trecho, então processar
  // as unidades em qualquer ordem é seguro (os índices start/end de uma não
  // são afetados por mexer em outra).
  function commitMove(drag) {
    const [dx, dy] = drag.liveDelta || [0, 0];
    const state = host.state;
    const minSpacingMm = (state.settings.write && state.settings.write.minSpacingMm) || 0;
    const minSpacingUnits = minSpacingMm * 10;
    let totalRemoved = 0;
    for (const u of drag.units) {
      const transform = { dx, dy, scaleX: 1, scaleY: 1, pivot: [0, 0] };
      const { stitches: regenerated, removed } = MinSpacing.regenerateBlock(u.origSegment, transform, { minSpacingUnits });
      totalRemoved += removed;
      const all = state.design.stitches;
      state.design.stitches = all.slice(0, u.start).concat(regenerated, all.slice(u.end));
    }
    host.deriveBlocks();
    oc.pendingWarning = totalRemoved > 0 ? host.tr('objects.warnMinSpacing', { n: totalRemoved }) : null;
    host.afterPointMutation();
  }

  // Confirma o gesto pelo caminho ANTIGO (fase 1): escala de coordenadas do
  // trecho + guarda de espaçamento mínimo. Usado para redimensionar
  // livre/Alt (nenhum gerador aceita eixos independentes) e qualquer bloco
  // sem objeto paramétrico associado. Também serve de FALLBACK se a
  // regeneração paramétrica falhar ou sair com uma contagem de cores
  // diferente da esperada (ver regenerateParametric).
  function commitLegacyTransform(drag, transform) {
    const state = host.state;
    const minSpacingMm = (state.settings.write && state.settings.write.minSpacingMm) || 0;
    const minSpacingUnits = minSpacingMm * 10; // unidades do design = 0,1 mm
    const { stitches: regenerated, removed } = MinSpacing.regenerateBlock(drag.origSegment, transform, { minSpacingUnits });

    // slice+concat em vez de splice(...array): evita espalhar um array
    // grande como argumentos individuais para objetos com muitas agulhadas.
    const all = state.design.stitches;
    state.design.stitches = all.slice(0, drag.start).concat(regenerated, all.slice(drag.end));

    host.deriveBlocks(); // redimensionar não muda a quantidade de blocos, mas os índices são recalculados do zero
    oc.pendingWarning = removed > 0 ? host.tr('objects.warnMinSpacing', { n: removed }) : null;
    host.afterPointMutation();
  }

  // Confirma a rotação (issue #29 fase 3): recalcula do origSegment (mesmo
  // padrão de commitLegacyTransform, não confia no array já mutado ao vivo)
  // e roda a guarda de espaçamento mínimo por segurança — rotação é uma
  // transformação RÍGIDA (preserva toda distância entre pontos), então na
  // prática nunca remove nada, exceto por um raríssimo empate de
  // arredondamento. Objetos paramétricos guardam o ângulo acumulado em
  // object.transform.rotation, reaplicado a cada regeneração futura (ver
  // regenerateParametric); blocos soltos só têm as coordenadas rodadas.
  function commitRotate(drag) {
    const deltaRad = drag.liveDeltaRad || 0;
    const rotated = ObjectModel.rotateSegment(drag.origSegment, drag.center[0], drag.center[1], deltaRad);
    const state = host.state;
    const minSpacingMm = (state.settings.write && state.settings.write.minSpacingMm) || 0;
    const minSpacingUnits = minSpacingMm * 10;
    const { stitches: finalSeg, removed } = MinSpacing.enforceMinSpacing(rotated, minSpacingUnits);

    const all = state.design.stitches;
    state.design.stitches = all.slice(0, drag.start).concat(finalSeg, all.slice(drag.end));

    if (drag.object) {
      const deltaDeg = (deltaRad * 180) / Math.PI;
      drag.object.transform = drag.object.transform || { rotation: 0 };
      drag.object.transform.rotation = ObjectModel.normalizeAngleDeg((drag.object.transform.rotation || 0) + deltaDeg);
    }

    host.deriveBlocks();
    oc.pendingWarning = removed > 0 ? host.tr('objects.warnMinSpacing', { n: removed }) : null;
    host.afterPointMutation();
  }

  // Roda o gerador de verdade (issue #29 fase 2) para um objeto paramétrico
  // redimensionado PROPORCIONALMENTE: recalcula os parâmetros com o novo
  // tamanho-alvo (ObjectModel.resizedXParams — densidade/espaçamento
  // continuam os mesmos), chama a MESMA API que a inserção original usou,
  // realinha o resultado (centralizado na convenção do gerador) ao
  // retângulo-alvo que o usuário desenhou arrastando a alça, reaplica a
  // rotação acumulada do objeto (issue #29 fase 3 — os geradores nunca
  // recebem ângulo, sempre produzem a forma alinhada aos eixos), roda a
  // guarda de espaçamento mínimo e substitui o trecho antigo. Se qualquer
  // coisa falhar ou sair inconsistente (nº de cores mudou), cai no caminho
  // antigo (commitLegacyTransform) — o gesto nunca fica "pendurado" sem
  // efeito.
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

      // issue #29 fase 3: reaplica a rotação acumulada do objeto (o gerador
      // sempre devolve a forma alinhada aos eixos) ao redor do mesmo centro
      // que acabamos de alinhar — um objeto girado mantém a orientação
      // depois de um redimensionamento proporcional.
      const rotationDeg = (object.transform && object.transform.rotation) || 0;
      if (rotationDeg) {
        const rcx = (targetBBox.minX + targetBBox.maxX) / 2;
        const rcy = (targetBBox.minY + targetBBox.maxY) / 2;
        seg = ObjectModel.rotateSegment(seg, rcx, rcy, (rotationDeg * Math.PI) / 180);
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

  // Finaliza o marquee (issue #29 fase 3): sem arraste de verdade, um
  // clique vazio desseleciona (igual à fase 1/2); com arraste, seleciona
  // toda unidade cujo bbox toque o retângulo (substituindo a seleção
  // anterior, ou somando a ela se começou com Shift).
  function finalizeMarquee(drag) {
    if (!drag.moved) {
      if (!drag.additive) clearSelection();
      return;
    }
    const state = host.state;
    const [x0, y0] = host.toDesign(drag.startScreen[0], drag.startScreen[1]);
    const [x1, y1] = host.toDesign(drag.curScreen[0], drag.curScreen[1]);
    const rect = { minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minY: Math.min(y0, y1), maxY: Math.max(y0, y1) };
    const allUnits = ObjectModel.listUnits(state.design.objects || [], state.blocks);
    const hit = allUnits.filter((u) => {
      const bbox = computeBBox(state.design.stitches, u.start, u.end);
      return bbox && bboxIntersects(bbox, rect);
    });

    if (drag.additive) {
      const existingKeys = selectionRangeKeys();
      for (const u of hit) {
        if (!existingKeys.has(u.start + ':' + u.end)) oc.selection.push(u.blockStart);
      }
    } else {
      oc.selection = hit.map((u) => u.blockStart);
    }
    oc.pendingWarning = null;
    refreshPanel();
    host.requestRender();
  }

  function onPointerUp() {
    if (!oc.drag) return false;
    const drag = oc.drag;
    oc.drag = null;
    host.canvas.style.cursor = oc.active ? 'default' : '';

    if (drag.kind === 'marquee') {
      finalizeMarquee(drag);
      return true;
    }
    if (!drag.moved) return true; // só foi um clique de seleção, nada a regenerar

    if (drag.kind === 'move') {
      commitMove(drag);
    } else if (drag.kind === 'rotate') {
      commitRotate(drag);
    } else {
      const transform = drag.liveTransform || { dx: 0, dy: 0, scaleX: 1, scaleY: 1, pivot: [0, 0] };
      const canRegen = drag.object && drag.object.source && ObjectModel.canRegenerate(transform);
      if (canRegen) {
        regenerateParametric(drag, transform); // assíncrono (IPC): ver função acima
      } else {
        commitLegacyTransform(drag, transform);
      }
    }
    return true;
  }

  function updateHoverCursor(e) {
    if (!host.canvas) return;
    if (oc.selection.length === 1) {
      const unit = currentUnit();
      const bbox = unit && computeBBox(host.state.design.stitches, unit.start, unit.end);
      if (bbox) {
        const [sx, sy] = clientToCanvas(e);
        if (hitRotateHandle(bbox, sx, sy, host.toScreen)) {
          host.canvas.style.cursor = 'grab';
          return;
        }
        const handle = hitHandle(bbox, sx, sy, host.toScreen);
        if (handle) {
          host.canvas.style.cursor = CURSORS[handle];
          return;
        }
      }
    }
    host.canvas.style.cursor = 'default';
  }

  // ------------------------------------------------------------------- teclado

  // Apaga TODAS as unidades selecionadas (issue #29 fase 3: 1 ou várias) —
  // ordem DESCENDENTE por start para que apagar um trecho de trás pra
  // frente nunca invalide os índices start/end dos trechos ainda não
  // processados (agulhadas removidas só encurtam o array, nunca deslocam
  // nada ANTES de onde foram removidas).
  function deleteSelected() {
    const state = host.state;
    const units = currentUnits();
    if (!units.length) return;
    host.snapshotUndo();
    const sorted = units.slice().sort((a, b) => b.start - a.start);
    for (const unit of sorted) {
      state.design.stitches.splice(unit.start, unit.end - unit.start);
      if (unit.object && state.design.objects) {
        const i = state.design.objects.indexOf(unit.object);
        if (i !== -1) state.design.objects.splice(i, 1);
      }
    }
    oc.selection = [];
    oc.drag = null;
    oc.pendingWarning = null;
    host.deriveBlocks();
    host.afterPointMutation();
  }

  // Duplica todas as unidades selecionadas (issue #29 fase 3): clona
  // stitches + thread(s) + a entrada de objects[] correspondente (se for
  // paramétrica), com um pequeno deslocamento fixo, e SEMPRE anexa a cópia
  // ao FIM da sequência de bordado — evita ter que inserir uma entrada nova
  // no MEIO de objects[] (ver nota de escopo no cabeçalho do arquivo).
  // Normaliza objects[] primeiro (ObjectModel.normalizeObjects) para que
  // até um bloco solto tenha uma entrada clonável. A seleção passa a ser as
  // cópias recém-criadas (para poder arrastá-las na hora, como em qualquer
  // editor vetorial). Uma única operação de undo (snapshot).
  function duplicateSelected() {
    const state = host.state;
    if (!state.design) return;
    const preUnits = currentUnits();
    if (!preUnits.length) return;

    host.snapshotUndo();

    state.design.objects = ObjectModel.normalizeObjects(state.design.objects || [], state.blocks);
    const units = currentUnits(); // recomputa: agora toda unit.object é não-nulo

    const sourceStitches = state.design.stitches;
    const sourceThreads = state.design.threads;
    let stitches = stripTrailingEnd(sourceStitches);
    const newThreads = [];
    const clonedObjects = [];

    for (const unit of units) {
      if (stitches.length) {
        const last = stitches[stitches.length - 1];
        if ((last[2] & COMMAND_MASK) !== COLOR_CHANGE_CMD) stitches = stitches.concat([[last[0], last[1], COLOR_CHANGE_CMD]]);
      }
      let end = unit.end;
      if (end > unit.start && (sourceStitches[end - 1][2] & COMMAND_MASK) === END_CMD) end -= 1;
      const seg = sourceStitches.slice(unit.start, end).map((s) => [s[0] + DUPLICATE_OFFSET_UNITS, s[1] + DUPLICATE_OFFSET_UNITS, s[2]]);
      stitches = stitches.concat(seg);
      for (let i = unit.blockStart; i < unit.blockEnd; i++) {
        newThreads.push(sourceThreads[i] ? JSON.parse(JSON.stringify(sourceThreads[i])) : null);
      }
      clonedObjects.push(ObjectModel.cloneObject(unit.object));
    }

    if (stitches.length) {
      const last = stitches[stitches.length - 1];
      stitches = stitches.concat([[last[0], last[1], END_CMD]]);
    }

    const blocksBefore = state.blocks.length;
    state.design.stitches = stitches;
    state.design.threads = sourceThreads.concat(newThreads);
    state.design.objects = state.design.objects.concat(clonedObjects);

    host.deriveBlocks();

    // Seleciona as cópias recém-criadas, na mesma ordem em que foram
    // anexadas (cursor anda pelos NOVOS blocos, na ponta do design).
    let cursor = blocksBefore;
    const newAnchors = [];
    for (const unit of units) {
      newAnchors.push(cursor);
      cursor += unit.blockEnd - unit.blockStart;
    }
    oc.selection = newAnchors;
    oc.pendingWarning = null;
    host.afterPointMutation();
  }

  // Translada uma unidade diretamente no array vivo (issue #29 fase 3:
  // alinhar/distribuir) — translação pura, nunca precisa de MinSpacing
  // (nunca aproxima agulhadas de uma mesma unidade entre si).
  function translateUnit(unit, dx, dy) {
    if (!dx && !dy) return;
    const stitches = host.state.design.stitches;
    for (let i = unit.start; i < unit.end; i++) {
      stitches[i][0] = Math.round(stitches[i][0] + dx);
      stitches[i][1] = Math.round(stitches[i][1] + dy);
    }
  }

  // Alinha as unidades selecionadas (>= 2) relativas à bbox CONJUNTA da
  // seleção inteira — comportamento padrão de editor vetorial: cada
  // unidade alinha sua própria borda/centro à borda/centro do grupo.
  // `axis` é 'x' (left/center/right) ou 'y' (top/middle/bottom); `mode` é
  // um dos valores aceitos por ObjectModel.alignOffsetX/Y.
  function alignSelection(axis, mode) {
    const units = currentUnits();
    if (units.length < 2) return;
    const state = host.state;
    const boxes = units.map((u) => computeBBox(state.design.stitches, u.start, u.end));
    const joint = ObjectModel.unionBBoxes(boxes);
    if (!joint) return;
    host.snapshotUndo();
    units.forEach((u, i) => {
      const bbox = boxes[i];
      if (!bbox) return;
      const dx = axis === 'x' ? ObjectModel.alignOffsetX(bbox, joint, mode) : 0;
      const dy = axis === 'y' ? ObjectModel.alignOffsetY(bbox, joint, mode) : 0;
      translateUnit(u, dx, dy);
    });
    host.deriveBlocks();
    host.afterPointMutation();
  }

  // Distribui as unidades selecionadas (>= 3) uniformemente ao longo do
  // eixo pedido (ver ObjectModel.distributeOffsets).
  function distributeSelection(axis) {
    const units = currentUnits();
    if (units.length < 3) return;
    const state = host.state;
    const boxes = units.map((u) => computeBBox(state.design.stitches, u.start, u.end));
    const offsets = ObjectModel.distributeOffsets(boxes, axis);
    host.snapshotUndo();
    units.forEach((u, i) => translateUnit(u, offsets[i].dx, offsets[i].dy));
    host.deriveBlocks();
    host.afterPointMutation();
  }

  // Sobe (direction < 0) ou desce (direction > 0) a unidade na posição
  // `index` da ordem de costura atual (painel de ordem de costura, issue
  // #29 fase 3): ver ObjectModel.swapUnits. Depois de reordenar, a seleção
  // é limpa (não tenta adivinhar para onde as âncoras deveriam apontar —
  // mais simples e nunca mostra uma seleção "errada").
  function reorderUnit(index, direction) {
    const state = host.state;
    if (!state.design) return;
    const i = direction < 0 ? index - 1 : index;
    if (i < 0) return;
    const objects = state.design.objects || [];
    const result = ObjectModel.swapUnits(objects, state.blocks, state.design.stitches, state.design.threads, i);
    if (!result) return;

    host.snapshotUndo();
    state.design.stitches = result.stitches;
    state.design.threads = result.threads;
    state.design.objects = result.objects;
    oc.selection = [];
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
    if (key === 'd' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      duplicateSelected();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------- desenho

  function drawSelectionBox(ctx, bbox, showHandles) {
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

    if (showHandles) {
      ctx.fillStyle = '#16130a';
      for (const name of HANDLES) {
        const [hx, hy] = handlePoint(bbox, name);
        const [sx, sy] = host.toScreen(hx, hy);
        ctx.fillRect(sx - HANDLE_PX, sy - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2);
        ctx.strokeRect(sx - HANDLE_PX, sy - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2);
      }
      // Alça de rotação (issue #29 fase 3): um círculo acima da alça "n",
      // ligado a ela por uma linha fina.
      const [nx, ny] = handlePoint(bbox, 'n');
      const [nsx, nsy] = host.toScreen(nx, ny);
      const [rx, ry] = rotateHandleScreenPoint(bbox, host.toScreen);
      ctx.beginPath();
      ctx.moveTo(nsx, nsy);
      ctx.lineTo(rx, ry);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(rx, ry, HANDLE_PX + 1, 0, Math.PI * 2);
      ctx.fillStyle = '#16130a';
      ctx.fill();
      ctx.strokeStyle = '#e8a13d';
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawMarquee(ctx, drag) {
    if (!drag.moved) return;
    const x0 = Math.min(drag.startScreen[0], drag.curScreen[0]);
    const y0 = Math.min(drag.startScreen[1], drag.curScreen[1]);
    const w = Math.abs(drag.curScreen[0] - drag.startScreen[0]);
    const h = Math.abs(drag.curScreen[1] - drag.startScreen[1]);
    ctx.save();
    ctx.fillStyle = 'rgba(232,161,61,0.12)';
    ctx.fillRect(x0, y0, w, h);
    ctx.strokeStyle = '#e8a13d';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(w), Math.round(h));
    ctx.restore();
  }

  function draw(ctx) {
    if (!oc.active) return;
    const state = host.state;
    if (oc.drag && oc.drag.kind === 'marquee') {
      drawMarquee(ctx, oc.drag);
      return;
    }
    const units = currentUnits();
    if (!units.length) return;
    if (units.length === 1) {
      const bbox = computeBBox(state.design.stitches, units[0].start, units[0].end);
      if (bbox) drawSelectionBox(ctx, bbox, true);
      return;
    }
    // Seleção múltipla (issue #29 fase 3): só a bbox conjunta, sem alças
    // (redimensionar/girar em grupo ficou fora do escopo — ver cabeçalho).
    const boxes = units.map((u) => computeBBox(state.design.stitches, u.start, u.end));
    const joint = ObjectModel.unionBBoxes(boxes);
    if (joint) drawSelectionBox(ctx, joint, false);
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

  // ------------------------------------------------- painel da sidebar (issue #29 fase 3)
  //
  // Duplicar/alinhar/distribuir + ordem de costura. Só objects.js toca
  // neste DOM (mesmo padrão do botão "btn-objects" em setActive, acima);
  // renderer.js só ganha a chamada ObjectCanvas.refreshPanel() dentro de
  // updateSidebar() (ver boot()), para o painel ficar em dia depois de
  // undo/redo e de trocar de arquivo — toda mutação feita por ESTE arquivo
  // já passa por host.afterPointMutation(), que chama updateSidebar() por
  // baixo dos panos (Edit.afterPointMutation), então já cobre delete/
  // duplicar/alinhar/distribuir/reordenar/mover/redimensionar/girar sem
  // precisar de nenhuma chamada extra aqui.

  const UNIT_LABEL_KEY = {
    'svg-shape': 'objects.unitSvg',
    'raster-trace': 'objects.unitRaster',
  };

  function unitLabel(unit, index) {
    const type = unit.object && unit.object.type;
    if (type === ObjectModel.TYPES.TEXT) {
      const text = unit.object.source && unit.object.source.text;
      const preview = text ? String(text).replace(/\s+/g, ' ').trim().slice(0, 18) : '';
      return host.tr('objects.unitText', { text: preview || '·' });
    }
    if (UNIT_LABEL_KEY[type]) return host.tr(UNIT_LABEL_KEY[type]);
    return host.tr('objects.unitBlock', { n: index + 1 });
  }

  function setDisabled(id, disabled) {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  }

  function renderStitchOrderPanel() {
    const section = document.getElementById('obj-panel');
    if (!section) return; // ambiente sem o painel (ex.: algum teste isolado) — no-op seguro
    const show = oc.active && !!(host && host.state.design);
    section.hidden = !show;
    if (!show) return;

    const state = host.state;
    const list = document.getElementById('stitch-order-list');
    const units = ObjectModel.listUnits(state.design.objects || [], state.blocks);
    list.innerHTML = '';
    units.forEach((unit, i) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = unitLabel(unit, i);
      let stitchCount = 0;
      for (let k = unit.start; k < unit.end; k++) {
        if ((state.design.stitches[k][2] & COMMAND_MASK) === STITCH_CMD) stitchCount++;
      }
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(stitchCount);
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'order-btn';
      up.textContent = '↑';
      up.title = host.tr('objects.moveUp');
      up.setAttribute('aria-label', up.title);
      up.disabled = i === 0;
      up.addEventListener('click', () => reorderUnit(i, -1));
      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'order-btn';
      down.textContent = '↓';
      down.title = host.tr('objects.moveDown');
      down.setAttribute('aria-label', down.title);
      down.disabled = i === units.length - 1;
      down.addEventListener('click', () => reorderUnit(i, 1));
      li.append(name, count, up, down);
      list.appendChild(li);
    });

    const count = selectionCount();
    for (const id of ['obj-align-left', 'obj-align-centerh', 'obj-align-right', 'obj-align-top', 'obj-align-middlev', 'obj-align-bottom']) {
      setDisabled(id, count < 2);
    }
    setDisabled('obj-distribute-h', count < 3);
    setDisabled('obj-distribute-v', count < 3);
    setDisabled('obj-duplicate', count < 1);
  }

  function refreshPanel() {
    renderStitchOrderPanel();
  }

  // Liga os botões do painel UMA vez (chamado de init(), quando o DOM
  // estático de index.html já existe). O estado disabled/hidden é
  // recalculado a cada refreshPanel(), não aqui.
  function initPanelDom() {
    const bind = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };
    bind('obj-duplicate', duplicateSelected);
    bind('obj-align-left', () => alignSelection('x', 'left'));
    bind('obj-align-centerh', () => alignSelection('x', 'center'));
    bind('obj-align-right', () => alignSelection('x', 'right'));
    bind('obj-align-top', () => alignSelection('y', 'top'));
    bind('obj-align-middlev', () => alignSelection('y', 'middle'));
    bind('obj-align-bottom', () => alignSelection('y', 'bottom'));
    bind('obj-distribute-h', () => distributeSelection('x'));
    bind('obj-distribute-v', () => distributeSelection('y'));
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
    selectionCount,
    rotateHandlePoint,
    selectedObjectRotation,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onKeyDown,
    draw,
    registerObject,
    duplicateSelected,
    alignSelection,
    distributeSelection,
    reorderUnit,
    refreshPanel,
  };

  if (typeof window !== 'undefined') {
    window.ObjectCanvas = ObjectCanvas;
  }
  // Exportado também para node:test exercitar a geometria pura sem DOM
  // (nunca toca window/document).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      computeBBox,
      handlePoint,
      resizeFactors,
      hitHandle,
      HANDLES,
      OPPOSITE,
      rotateHandleScreenPoint,
      hitRotateHandle,
      bboxIntersects,
      stripTrailingEnd,
    };
  }
})();
