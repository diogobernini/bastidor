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
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = exported;
}
if (typeof window !== 'undefined') {
  window.ObjectModel = exported;
}
})();
