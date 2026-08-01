'use strict';
// Ponto cheio (satin) para lettering (issue #19): converte UM traço (uma
// polilinha de um glifo, já em unidades internas de 0,1 mm e no espaço do
// design — ver stitcher.js) numa coluna de zigue-zague de largura constante,
// centrada no traço original.
//
// Ideia: reamostra o traço a cada "densityUnits" (o espaçamento entre
// agulhadas ao longo do comprimento do traço — a "travessa" do ponto cheio),
// calcula em cada travessa a direção local do traço (média das direções dos
// segmentos que chegam e saem — uma mitra simples nos cantos, igual à usada
// em canetas/traçados vetoriais) e desloca o ponto travessa por travessa
// para um lado perpendicular a essa direção, alternando o lado a cada
// travessa. O resultado é uma única polilinha (não um par de trilhos
// separados): cada agulhada avança ao longo do traço E atravessa a largura
// da coluna ao mesmo tempo — exatamente como uma máquina de bordar cose um
// ponto cheio de verdade.
//
// Como a "travessa" já é curta por construção (densityUnits, tipicamente
// ~4 unidades = 0,4 mm) e a largura é limitada pela UI a poucos mm, a
// agulhada diagonal resultante (hipotenusa de travessa x largura/2) fica bem
// abaixo do limite de 12,1 mm que os formatos exigem — o encoder (ver
// src/core/encoder.js) ainda assim divide qualquer agulhada que escape disso,
// mas não deveria precisar entrar em ação aqui.

const { resamplePolyline, dedupePoints } = require('./resample');

const DEFAULT_WIDTH_MM = 2;
const DEFAULT_DENSITY_MM = 0.4;

// Direção unitária do segmento a->b; [0,0] se os pontos coincidem (chamador
// trata como "sem direção definida").
function segmentDir(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return len > 1e-9 ? [dx / len, dy / len] : [0, 0];
}

// Direção local em cada ponto de uma polilinha: média (mitra simples) das
// direções do segmento que chega e do que sai; nas pontas, só o segmento
// disponível. Devolve um array do mesmo tamanho de "points", cada item um
// vetor unitário [dx, dy].
function localDirections(points) {
  const n = points.length;
  const dirs = new Array(n);
  for (let i = 0; i < n; i++) {
    const din = i > 0 ? segmentDir(points[i - 1], points[i]) : null;
    const dout = i < n - 1 ? segmentDir(points[i], points[i + 1]) : null;
    let dx = 0;
    let dy = 0;
    if (din && (din[0] || din[1])) {
      dx += din[0];
      dy += din[1];
    }
    if (dout && (dout[0] || dout[1])) {
      dx += dout[0];
      dy += dout[1];
    }
    const len = Math.hypot(dx, dy);
    if (len > 1e-9) {
      dirs[i] = [dx / len, dy / len];
    } else {
      // Segmentos com direções opostas (cantos de 180°) ou traço degenerado:
      // cai para qualquer direção disponível, ou "para a direita" por padrão.
      dirs[i] = din || dout || [1, 0];
    }
  }
  return dirs;
}

// Rotação de 90° de um vetor unitário (perpendicular "à esquerda" do sentido
// do traço; o lado "direito" é só o negativo deste).
function perpendicular([dx, dy]) {
  return [-dy, dx];
}

// Gera o zigue-zague do ponto cheio para UM traço. Devolve uma polilinha
// (array de [x, y], já nas unidades de entrada) pronta para virar agulhadas
// — o próprio contrato de "as polilinhas de preview são o traçado gravado"
// (ver patternPolylines em stitcher.js) já vale aqui, sem tratamento especial.
function satinizeStroke(points, opts = {}) {
  const widthUnits = opts.widthUnits > 0 ? opts.widthUnits : DEFAULT_WIDTH_MM * 10;
  const densityUnits = opts.densityUnits > 0 ? opts.densityUnits : DEFAULT_DENSITY_MM * 10;
  const half = widthUnits / 2;

  const base = dedupePoints(points);
  if (base.length < 2) return [];

  const rungs = resamplePolyline(base, densityUnits);
  if (rungs.length < 2) return [];

  const dirs = localDirections(rungs);
  const zigzag = new Array(rungs.length);
  for (let i = 0; i < rungs.length; i++) {
    const perp = perpendicular(dirs[i]);
    const side = i % 2 === 0 ? 1 : -1; // alterna o lado a cada travessa
    zigzag[i] = [rungs[i][0] + perp[0] * half * side, rungs[i][1] + perp[1] * half * side];
  }
  return zigzag;
}

module.exports = {
  satinizeStroke,
  localDirections,
  perpendicular,
  segmentDir,
  DEFAULT_WIDTH_MM,
  DEFAULT_DENSITY_MM,
};
