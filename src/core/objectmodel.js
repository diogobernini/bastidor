'use strict';
// Modelo de objetos paramétricos (issue #29, fase 2): núcleo puro (sem DOM,
// sem Electron) usado por src/renderer/objects.js para saber que faixa de
// BLOCOS de cor (state.blocks) e de AGULHADAS (design.stitches) cada objeto
// inserido pelas ferramentas (texto, importação de SVG, digitalização de
// imagem) ocupa, e como recalcular os parâmetros de geração quando o usuário
// redimensiona o objeto pela alça.
//
// Por que isto existe (ver issue #29): hoje cada ferramenta achata o
// resultado no array de agulhadas na hora de inserir, perdendo a geometria de
// origem. A partir da fase 2, cada inserção registra um "objeto" em
// design.objects[] com o `source` (payload paramétrico: texto+fonte, SVG
// bruto, imagem digitalizada) e os `stitchParams` (densidade/espaçamento/
// comprimento de ponto) usados. Redimensionar não escala mais as
// coordenadas: roda o MESMO gerador de novo, só com o tamanho-alvo ajustado
// pelo fator do gesto — densidade e espaçamento ficam exatamente como
// configurados, do jeito que um digitalizador profissional trabalha.
//
// Um objeto pode ocupar VÁRIOS blocos de cor (ex.: um SVG com preenchimento
// + contorno de cores diferentes, ou uma digitalização com várias cores)
// desde que sejam contíguos na ordem de inserção — por isso cada objeto só
// guarda `blockCount` (quantos blocos consecutivos ele ocupa a partir de
// onde os anteriores terminaram), nunca índices absolutos: os índices são
// recalculados do zero a cada mutação (deriveBlocks já faz isso hoje para os
// blocos; assignObjectRanges faz o mesmo para os objetos, andando na MESMA
// ordem em que foram inseridos — objetos nunca são reordenados nesta fase;
// reordenar é fase 3).
//
// Carregado por <script> no renderer (mesma técnica de spatial.js/
// minspacing.js/densityscale.js) E via require() nos testes/no main
// process — por isso o duplo caminho de exportação no rodapé. Tudo dentro de
// uma IIFE (mesmo padrão de minspacing.js): um script clássico compartilha o
// escopo léxico de topo da página com todos os outros carregados em
// index.html (renderer.js, objects.js, os módulos em modules/*.js e os
// outros núcleos em core/*.js) — uma function/const solta aqui viraria uma
// propriedade de window e poderia colidir com qualquer nome ali. Só
// "window.ObjectModel" escapa.
(function () {

// Mesmas constantes (valores) de src/core/colorblocks.js — cada IIFE tem seu
// próprio escopo de função, então não há colisão com o `const COLOR_CHANGE`
// solto no topo de renderer.js (script clássico, escopo compartilhado):
// usadas só por swapUnits/hasClosingMarker, para achar a fronteira certa
// entre 2 unidades (COLOR_CHANGE no meio, END no fim de verdade).
const COMMAND_MASK = 0xff;
const COLOR_CHANGE = 5;
const END = 4;

const TYPES = {
  TEXT: 'text',
  SVG_SHAPE: 'svg-shape',
  RASTER_TRACE: 'raster-trace',
  STITCH_BLOCK: 'stitch-block', // blocos de cor de um arquivo de máquina aberto: opaco, sem source (fase 1)
};

// Fábrica de um objeto novo. `blockCount` é quantos blocos de cor
// consecutivos (a partir de onde o objeto anterior parou) este objeto ocupa
// no momento da inserção — ver cabeçalho do arquivo.
function makeObject(type, source, stitchParams, blockCount) {
  return {
    type,
    source: source || null,
    stitchParams: stitchParams || null,
    transform: { rotation: 0 }, // rotação fica pra fase 3; presente só pro formato já ser estável
    blockCount: Math.max(1, Math.round(blockCount) || 1),
  };
}

// Caminha pela lista de objetos NA ORDEM DE INSERÇÃO, consumindo
// `blockCount` blocos de `blocks` (o array de state.blocks, já recalculado)
// por objeto, e devolve a faixa de blocos/agulhadas de cada um. Pára de
// sincronizar (não devolve mais nada depois do primeiro problema) se um
// objeto não couber mais nos blocos restantes — acontece se algo fora do
// modo de objetos alterou a contagem de blocos (ex.: editor de pontos
// apagando o único ponto de uma cor). Os blocos que sobrarem depois disso
// voltam a ser tratados como blocos soltos (comportamento de fase 1).
function assignObjectRanges(objects, blocks) {
  const out = [];
  let cursor = 0;
  for (const object of objects || []) {
    const count = object.blockCount || 1;
    if (cursor + count > blocks.length) break;
    const first = blocks[cursor];
    const last = blocks[cursor + count - 1];
    out.push({
      object,
      blockStart: cursor,
      blockEnd: cursor + count,
      start: first.start,
      end: last.end,
    });
    cursor += count;
  }
  return out;
}

// Acha a "unidade" de manipulação que contém o bloco `blockIndex`: a faixa
// inteira de um objeto paramétrico (várias cores possivelmente), ou o bloco
// sozinho quando não há objeto associado (arquivo de máquina aberto, ou
// objeto cujo blockCount não sincronizou mais — ver assignObjectRanges).
// Devolve null só se blockIndex não existir em `blocks`.
function findUnit(objects, blocks, blockIndex) {
  const assigned = assignObjectRanges(objects || [], blocks);
  for (const a of assigned) {
    if (blockIndex >= a.blockStart && blockIndex < a.blockEnd) return a;
  }
  const b = blocks[blockIndex];
  if (!b) return null;
  return { object: null, blockStart: blockIndex, blockEnd: blockIndex + 1, start: b.start, end: b.end };
}

// ---------------------------------------------------------- geometria de alinhamento

// Bbox de origem escalada/deslocada pelo MESMO transform do gesto (ver
// resizeFactors/applyLiveTransform em objects.js) — é o retângulo-alvo que o
// usuário desenhou arrastando a alça.
function transformBBox(bbox, transform) {
  const pivot = transform.pivot || [0, 0];
  const dx = transform.dx || 0;
  const dy = transform.dy || 0;
  const sx = transform.scaleX;
  const sy = transform.scaleY;
  const x0 = pivot[0] + (bbox.minX - pivot[0]) * sx + dx;
  const x1 = pivot[0] + (bbox.maxX - pivot[0]) * sx + dx;
  const y0 = pivot[1] + (bbox.minY - pivot[1]) * sy + dy;
  const y1 = pivot[1] + (bbox.maxY - pivot[1]) * sy + dy;
  return { minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minY: Math.min(y0, y1), maxY: Math.max(y0, y1) };
}

// Deslocamento que alinha o CENTRO de `sourceBBox` (a saída fresca do
// gerador, na convenção de centralização dele) ao centro de `targetBBox` (o
// retângulo que o usuário desenhou). Funciona qualquer que seja a convenção
// de centralização de cada gerador (texto centraliza na origem; SVG mantém o
// viewBox original) porque só olha para os bboxes, nunca para a origem (0,0).
function centerAlignOffset(sourceBBox, targetBBox) {
  const scx = (sourceBBox.minX + sourceBBox.maxX) / 2;
  const scy = (sourceBBox.minY + sourceBBox.maxY) / 2;
  const tcx = (targetBBox.minX + targetBBox.maxX) / 2;
  const tcy = (targetBBox.minY + targetBBox.maxY) / 2;
  return [tcx - scx, tcy - scy];
}

// Só faz sentido rodar o gerador de novo (em vez de escalar coordenadas) num
// redimensionamento PROPORCIONAL de verdade (mesmo fator nos dois eixos, e
// diferente de 1): os três geradores (texto/tatami do SVG/rastro) só têm UM
// parâmetro de tamanho-alvo (heightMm / targetWidthMm / widthMm), sem
// controle independente por eixo. Redimensionamento livre (Alt) continua no
// caminho antigo (escala de coordenadas + guarda de espaçamento, fase 1) —
// documentado como limitação conhecida desta fase.
function canRegenerate(transform) {
  if (!transform) return false;
  const sx = transform.scaleX;
  const sy = transform.scaleY;
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return false;
  return Math.abs(sx - sy) < 1e-9 && Math.abs(sx - 1) > 1e-9;
}

// ------------------------------------------------- parâmetros de regeneração por tipo
//
// Em todos os três casos, só o tamanho-alvo muda pelo fator do gesto; todo
// parâmetro que afeta densidade/espaçamento/comprimento de ponto continua
// EXATAMENTE como o usuário configurou (é o comportamento pedido pela issue:
// "tatami at the same spacing, text at the same stitch length, satin at the
// same density").

function resizedTextParams(stitchParams, factor) {
  const heightMm = (stitchParams.heightMm > 0 ? stitchParams.heightMm : 10) * factor;
  return Object.assign({}, stitchParams, { heightMm: Math.max(0.5, heightMm) });
}

function resizedSvgParams(stitchParams, factor) {
  const base = stitchParams.targetWidthMm > 0 ? stitchParams.targetWidthMm : 0;
  return Object.assign({}, stitchParams, { targetWidthMm: Math.max(1, base * factor) });
}

function resizedRasterParams(stitchParams, factor) {
  const base = stitchParams.widthMm > 0 ? stitchParams.widthMm : 1;
  return Object.assign({}, stitchParams, { widthMm: Math.max(1, base * factor) });
}

// ------------------------------------------------------ rotação (issue #29 fase 3)
//
// Alça de rotação na seleção: para objetos paramétricos o ângulo acumulado
// mora em object.transform.rotation (graus) e é reaplicado APÓS cada
// regeneração (ver regenerateParametric em src/renderer/objects.js, os
// geradores não recebem ângulo); para blocos soltos gira-se só as
// coordenadas, sem persistir nada (não há onde persistir sem um objeto).
// Rotação é uma transformação RÍGIDA (preserva toda distância entre
// pontos), então nunca precisa de MinSpacing nem de recalcular densidade.

// Gira o ponto (x,y) por `angleRad` radianos ao redor do pivô (cx,cy).
function rotatePoint(cx, cy, x, y, angleRad) {
  const dx = x - cx;
  const dy = y - cy;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

// Gira TODAS as agulhadas de `stitches` (array de [x,y,cmd]) ao redor de
// (cx,cy) por `angleRad`, arredondando para o inteiro mais próximo (mesma
// unidade de 0,1 mm dos outros pontos do design). Devolve um array NOVO;
// nunca muta `stitches`.
function rotateSegment(stitches, cx, cy, angleRad) {
  return stitches.map((s) => {
    if (!angleRad) return s.slice();
    const [x, y] = rotatePoint(cx, cy, s[0], s[1], angleRad);
    return [Math.round(x), Math.round(y), s[2]];
  });
}

// Arredonda um ângulo (graus) para o múltiplo de `stepDeg` mais próximo —
// usado pelo snap opcional a 15° (Shift durante o arraste da alça de
// rotação). stepDeg <= 0 devolve o ângulo intacto (guarda contra divisão
// por zero / desliga o snap).
function snapAngleDeg(deg, stepDeg) {
  if (!(stepDeg > 0)) return deg;
  return Math.round(deg / stepDeg) * stepDeg;
}

// Normaliza um ângulo (graus) para o intervalo [0, 360) — usado para
// acumular a rotação de um objeto paramétrico ao longo de vários gestos sem
// o número crescer sem limite.
function normalizeAngleDeg(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

// ------------------------------------------------ seleção múltipla / bboxes
//
// União de vários bboxes (design coords) na bbox conjunta da seleção
// (issue #29 fase 3) — usada pela seleção múltipla (bbox do grupo) e por
// alinhar/distribuir (referência "targetBBox"). Ignora entradas nulas
// (unidade sem pontos reais, ex.: bloco vazio). Devolve null se a lista
// toda for vazia/nula.
function unionBBoxes(bboxes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const b of bboxes || []) {
    if (!b) continue;
    any = true;
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

// -------------------------------------------------------- alinhar / distribuir
//
// Painel de alinhar/distribuir (issue #29 fase 3): opera nas bboxes das
// unidades selecionadas, sempre relativas à bbox CONJUNTA da seleção
// inteira (targetBBox = unionBBoxes de todo mundo selecionado) — cada
// unidade alinha sua própria borda/centro à borda/centro do conjunto, o
// comportamento padrão de editores vetoriais ("alinhar relativo à seleção").
// Devolvem só o deslocamento num eixo (dx ou dy); quem chama translada a
// unidade (translação pura, nunca precisa de MinSpacing).

function alignOffsetX(bbox, targetBBox, mode) {
  switch (mode) {
    case 'left':
      return targetBBox.minX - bbox.minX;
    case 'right':
      return targetBBox.maxX - bbox.maxX;
    case 'center':
      return (targetBBox.minX + targetBBox.maxX) / 2 - (bbox.minX + bbox.maxX) / 2;
    default:
      return 0;
  }
}

function alignOffsetY(bbox, targetBBox, mode) {
  switch (mode) {
    case 'top':
      return targetBBox.minY - bbox.minY;
    case 'bottom':
      return targetBBox.maxY - bbox.maxY;
    case 'middle':
      return (targetBBox.minY + targetBBox.maxY) / 2 - (bbox.minY + bbox.maxY) / 2;
    default:
      return 0;
  }
}

// Deslocamentos {dx,dy} (na mesma ordem de `bboxes` de entrada) que
// distribuem os CENTROS das unidades uniformemente ao longo do eixo pedido
// ('x' ou 'y'), entre a unidade mais à esquerda/topo e a mais à
// direita/base (essas duas âncoras não se movem). Com menos de 3 unidades
// não há o que distribuir (devolve deslocamento zero para todas).
function distributeOffsets(bboxes, axis) {
  const n = bboxes.length;
  const out = bboxes.map(() => ({ dx: 0, dy: 0 }));
  if (n < 3) return out;
  const centerOf = (b) => (axis === 'x' ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2);
  const order = bboxes.map((b, i) => ({ i, c: centerOf(b) })).sort((a, b) => a.c - b.c);
  const first = order[0].c;
  const last = order[n - 1].c;
  const step = (last - first) / (n - 1);
  order.forEach((entry, k) => {
    const target = first + step * k;
    const delta = target - entry.c;
    out[entry.i] = axis === 'x' ? { dx: delta, dy: 0 } : { dx: 0, dy: delta };
  });
  return out;
}

// ------------------------------------------------- ordem de costura (issue #29 fase 3)
//
// O painel de ordem de costura precisa reordenar UNIDADES livremente
// (subir/descer qualquer uma, mesmo um bloco solto pra antes de um
// objeto) — mas assignObjectRanges consome `objects` em ordem a partir do
// cursor 0, então blocos soltos (sem entrada em objects[]) são sempre "o
// resto depois de todos os objetos": não dá pra expressar um bloco solto
// ANTES de um objeto sem uma entrada correspondente. normalizeObjects
// resolve isso preenchendo essa lacuna com STITCH_BLOCK "opacos" (sem
// source, ver TYPES) para cada bloco solto — depois disso toda unidade tem
// exatamente 1 entrada em objects[], e reordenar vira um swap posicional
// simples nos três arrays em paralelo (agulhadas, threads, objects).
// Idempotente e não muta `objects` (devolve um array novo).
function normalizeObjects(objects, blocks) {
  const assigned = assignObjectRanges(objects || [], blocks);
  const consumed = assigned.length ? assigned[assigned.length - 1].blockEnd : 0;
  const out = (objects || []).slice();
  for (let i = consumed; i < blocks.length; i++) {
    out.push(makeObject(TYPES.STITCH_BLOCK, null, null, 1));
  }
  return out;
}

// Lista TODAS as unidades de manipulação na ordem de bordado atual, cobrindo
// `blocks` por inteiro: as cobertas por `objects` (na ordem em que aparecem
// lá), seguidas dos blocos soltos restantes (mesmo fallback de findUnit,
// só que para TODOS os blocos restantes, não um só). Usada pelo painel de
// ordem de costura para exibir a lista e por swapUnits para localizar o par
// adjacente a trocar.
function listUnits(objects, blocks) {
  const assigned = assignObjectRanges(objects || [], blocks);
  const consumed = assigned.length ? assigned[assigned.length - 1].blockEnd : 0;
  const out = assigned.slice();
  for (let i = consumed; i < blocks.length; i++) {
    const b = blocks[i];
    out.push({ object: null, blockStart: i, blockEnd: i + 1, start: b.start, end: b.end });
  }
  return out;
}

// Confere se o último stitch do intervalo [start, end) é um "fechamento":
// um COLOR_CHANGE (fecha uma unidade do meio) OU um END (fecha o desenho
// inteiro — todo design carregado/gerado termina com um END de verdade,
// ver src/core/io e stripTrailingEnd em src/renderer/objects.js). Mesmo
// cuidado de ColorBlocks.hasClosingMarker (src/core/colorblocks.js, issue
// #61): só a unidade que fecha o desenho (a última de todas) pode ter END
// em vez de COLOR_CHANGE; uma unidade sem nenhum dos dois (raro, só em
// dados sintéticos de teste) não tem fechamento algum.
function hasClosingMarker(stitches, start, end) {
  if (end <= start) return false;
  const last = stitches[end - 1];
  if (!last) return false;
  const cmd = last[2] & COMMAND_MASK;
  return cmd === COLOR_CHANGE || cmd === END;
}

// Troca as unidades ADJACENTES `i` e `i+1` na ordem de bordado (botões
// subir/descer do painel, ou o painel de Cores quando um dos blocos
// pertence a um objeto — ver moveColorBlock em renderer.js, issue #61):
// reordena os TRECHOS de agulhadas, as threads correspondentes e as
// entradas de `objects`, mantendo cada bloco íntegro (mesmos pontos/
// threads/stitchParams — só a posição na sequência muda). Normaliza
// `objects` primeiro (ver normalizeObjects), o que torna a troca um swap
// posicional direto nos três arrays em paralelo, sem restrição de "cruzar
// a fronteira" entre bloco solto e objeto. Devolve {stitches, threads,
// objects} NOVOS (não muta nenhum argumento), ou null se `i` não tiver um
// vizinho válido para trocar.
//
// CUIDADO nas bordas (mesma primitiva de ColorBlocks.swapBlocks, e mesmo
// motivo): a unidade `a` NUNCA é a última de todas (sempre existe `b` logo
// depois), então seu último stitch É sempre um COLOR_CHANGE — mas `b` pode
// muito bem SER a última unidade do desenho inteiro, e nesse caso ela não
// tem COLOR_CHANGE de fechamento (termina em END/TRIM/etc). Uma troca
// "ingênua" (só concatenar os dois trechos brutos invertidos) deixaria
// esse COLOR_CHANGE de `a` sobrando no meio da nova sequência e o
// terminador de verdade (END) preso ANTES dele, corrompendo o desenho
// (dois "fins" no meio do arquivo, nenhum COLOR_CHANGE de fechamento onde
// devia estar o novo último bloco). Por isso: separa o "conteúdo puro" de
// cada unidade do seu COLOR_CHANGE de fechamento (quando existe), e reusa
// o de `a` como a nova fronteira entre as duas — só sobra um COLOR_CHANGE
// no fim se `b` já tinha um (ou seja, se ela não era a última unidade).
function swapUnits(objects, blocks, stitches, threads, i) {
  const normalized = normalizeObjects(objects, blocks);
  const units = listUnits(normalized, blocks);
  if (i < 0 || i + 1 >= units.length) return null;
  const a = units[i];
  const b = units[i + 1];
  if (a.blockEnd !== b.blockStart || a.end !== b.start) return null; // unidades deveriam ser sempre contíguas

  const ccAIdx = a.end - 1;
  const ccA = stitches[ccAIdx];
  if (!ccA || (ccA[2] & COMMAND_MASK) !== COLOR_CHANGE) {
    throw new Error('ObjectModel.swapUnits: unidade de cima sem COLOR_CHANGE de fechamento');
  }
  const bHasClosing = hasClosingMarker(stitches, b.start, b.end);
  const pureA = stitches.slice(a.start, ccAIdx).map((s) => s.slice());
  const bContentEnd = bHasClosing ? b.end - 1 : b.end;
  const pureB = stitches.slice(b.start, bContentEnd).map((s) => s.slice());
  const closingB = bHasClosing ? stitches[b.end - 1].slice() : null;

  const newSegment = pureB.concat([ccA.slice()], pureA);
  if (closingB) newSegment.push(closingB);
  const newStitches = stitches.slice(0, a.start).concat(newSegment, stitches.slice(b.end));

  const threadsA = threads.slice(a.blockStart, a.blockEnd);
  const threadsB = threads.slice(b.blockStart, b.blockEnd);
  const newThreads = threads.slice(0, a.blockStart).concat(threadsB, threadsA, threads.slice(b.blockEnd));

  const newObjects = normalized.slice();
  const tmp = newObjects[i];
  newObjects[i] = newObjects[i + 1];
  newObjects[i + 1] = tmp;

  return { stitches: newStitches, threads: newThreads, objects: newObjects };
}

// Clone profundo de um objeto paramétrico (duplicar unidade, issue #29 fase
// 3): source/stitchParams/transform são todos JSON-seguros (mesma premissa
// de cloneDesignData em renderer.js), então JSON.parse(JSON.stringify(...))
// basta. blockCount não muda (a cópia ocupa o mesmo nº de blocos que o
// original; as threads correspondentes são clonadas à parte por quem
// chama, igual às agulhadas).
function cloneObject(object) {
  return {
    type: object.type,
    source: object.source ? JSON.parse(JSON.stringify(object.source)) : null,
    stitchParams: object.stitchParams ? JSON.parse(JSON.stringify(object.stitchParams)) : null,
    transform: object.transform ? JSON.parse(JSON.stringify(object.transform)) : { rotation: 0 },
    blockCount: object.blockCount,
  };
}

// Monta os opts de src/core/digitize (raster.rasterToPaths/pathsToPattern,
// via IPC digitize:generate) a partir dos parâmetros "crus" guardados no
// objeto (largura/tolerância em mm) e da largura em pixels da imagem fonte —
// espelha digitizeOptsFor em renderer.js, mas puro (sem ler o DOM).
function rasterOptsFromParams(params, imageWidthPx) {
  const widthMm = params.widthMm > 0 ? params.widthMm : 1;
  return {
    colors: params.colors,
    ignoreBackground: !!params.ignoreBackground,
    scale: (widthMm * 10) / imageWidthPx,
    simplifyTol: ((params.toleranceMm || 0) * imageWidthPx) / widthMm,
    stitchLenMm: params.stitchLenMm,
    outline: !!params.outline,
    fill: !!params.fill,
    fillSpacingMm: params.fillSpacingMm,
    fillAngleDeg: params.fillAngleDeg,
    fillStitchMm: params.fillStitchMm,
    name: params.name,
  };
}

const exported = {
  TYPES,
  makeObject,
  assignObjectRanges,
  findUnit,
  transformBBox,
  centerAlignOffset,
  canRegenerate,
  resizedTextParams,
  resizedSvgParams,
  resizedRasterParams,
  rasterOptsFromParams,
  // issue #29 fase 3
  rotatePoint,
  rotateSegment,
  snapAngleDeg,
  normalizeAngleDeg,
  unionBBoxes,
  alignOffsetX,
  alignOffsetY,
  distributeOffsets,
  normalizeObjects,
  listUnits,
  swapUnits,
  cloneObject,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = exported;
}
if (typeof window !== 'undefined') {
  window.ObjectModel = exported;
}
})();
