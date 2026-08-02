'use strict';
// Utilitários compartilhados pelos geradores expressivos de preenchimento
// (issue #77, fase C do estudo de técnicas de fill): motiffill, meanderfill,
// crosshatchfill, radialfill, gradientfill e guidedfill. Cada gerador é um
// módulo isolado (contrato `generate(regionRings, opts) -> runs[]`), mas
// todos precisam das mesmas peças pequenas — rotação pro espaço de cálculo
// (mesma convenção de fill.js/sections.js), centróide de uma região com
// furos, reamostragem de polilinha aberta e recorte de polilinha aberta
// contra a região. Ficam aqui pra não duplicar em 6 arquivos.
//
// Este módulo NÃO é um gerador (não exporta `generate`) e não é tocado por
// nenhum dos módulos existentes — é só uma dependência interna nova dos 6
// geradores novos.

const { isInsideRegion } = require('./regions');

const EPS = 1e-6;

// 1 mm = 10 unidades internas (mesma convenção de src/core/digitize/index.js
// e do restante do projeto: distâncias sempre em 0,1 mm).
const MM = 10;

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// Mesma convenção de rotatePoint/unrotatePoint de fill.js e sections.js:
// rotatePoint leva um ponto do espaço real pro espaço de cálculo onde uma
// direção `angleDeg` fica horizontal (rotação por -angleDeg); unrotatePoint
// desfaz. Reimplementado aqui (as versões de fill.js/sections.js não são
// exportadas, e são só duas contas triviais) para não alterar nenhum
// arquivo existente.
function rotatePoint(x, y, cos, sin) {
  return [x * cos + y * sin, -x * sin + y * cos];
}

function unrotatePoint(x, y, cos, sin) {
  return [x * cos - y * sin, x * sin + y * cos];
}

function normalize2(v) {
  const len = Math.hypot(v[0], v[1]);
  return len > EPS ? [v[0] / len, v[1] / len] : [0, 0];
}

// Hash inteiro determinístico -> valor em [0,1) (variante simples de
// mistura de bits tipo splitmix; SEM Math.random, ver regra da issue #77).
// `i` é um índice qualquer (linha, coluna, ponto...); `salt` diferencia
// usos distintos do mesmo índice (ex.: jitter em X vs jitter em Y) sem
// precisar de mais de um gerador de hash.
function hashJitter(i, salt) {
  let h = (i * 374761393 + salt * 668265263) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = (h * 1274126177) | 0;
  h = (h ^ (h >>> 16)) | 0;
  return ((h >>> 0) % 1000000) / 1000000;
}

// Área com sinal (shoelace) e centróide de UM anel (fórmula clássica de
// centróide de polígono, independe do sentido de percurso: o sinal da área
// só é usado internamente pra normalizar cx/cy, e devolvido em valor
// absoluto). Degenera com elegância (área ~0, ex. anel colinear) devolvendo
// o primeiro vértice como "centróide".
function ringAreaAndCentroid(ring) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < EPS) return { area: 0, centroid: ring[0].slice() };
  return { area: a, centroid: [cx / (6 * a), cy / (6 * a)] };
}

// Centróide de uma região INTEIRA (anel externo + furos, mesma convenção de
// regions.groupRingsIntoRegions: rings[0] é sempre o contorno externo, os
// demais são furos): combinação ponderada por área, furos com peso
// negativo, igual à fórmula de centróide de uma figura com buracos. Cai de
// volta pro centróide do anel externo se a área total (externo - furos)
// ficar ~0 (região degenerada).
function regionCentroid(rings) {
  if (!rings || rings.length === 0) return [0, 0];
  let totalArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < rings.length; i++) {
    const { area, centroid } = ringAreaAndCentroid(rings[i]);
    const w = i === 0 ? Math.abs(area) : -Math.abs(area);
    totalArea += w;
    cx += centroid[0] * w;
    cy += centroid[1] * w;
  }
  if (Math.abs(totalArea) < EPS) return ringAreaAndCentroid(rings[0]).centroid;
  return [cx / totalArea, cy / totalArea];
}

// Maior distância de `center` a qualquer vértice de qualquer anel da
// região — um raio "que certamente alcança a borda" pra dimensionar passes
// (ex.: nº de raios do radialfill). Nunca devolve 0 (mínimo 1 unidade) pra
// nenhum chamador dividir por zero.
function outerRadiusFrom(rings, center) {
  let r = 0;
  for (const ring of rings || []) {
    for (const p of ring) {
      const d = dist(p, center);
      if (d > r) r = d;
    }
  }
  return r > EPS ? r : 1;
}

// Reamostra uma polilinha ABERTA (não fecha last->first) em pontos a cada
// `step` de comprimento de arco, sempre preservando o último ponto exato
// mesmo que o resto não caia num múltiplo exato de `step` (mesma garantia
// de "nunca estourar step" que fill.pointsAlongSpan já dá pra um vão só,
// generalizada pra uma polilinha com vários segmentos).
function resamplePolylineAt(points, step) {
  const pts = (points || []).filter((p, i) => i === 0 || dist(p, points[i - 1]) > EPS);
  if (pts.length === 0) return [];
  if (pts.length === 1 || !(step > 0)) return pts.slice();

  const out = [pts[0]];
  let carry = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const segLen = dist(a, b);
    if (segLen <= EPS) continue;
    let t = carry;
    while (t < segLen - EPS) {
      const f = t / segLen;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      t += step;
    }
    carry = t - segLen;
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > EPS) out.push(last);
  return out;
}

// Bisseção entre um ponto DENTRO (`insidePt`) e um ponto FORA (`outsidePt`)
// da região pra achar o ponto de cruzamento com a borda, devolvendo sempre
// um ponto que ainda testa como "dentro" (a última posição válida da
// bisseção) — nunca um ponto que testa como fora, mesmo com o
// arredondamento das últimas iterações.
function bisectBoundary(insidePt, outsidePt, region, iterations) {
  let lo = insidePt;
  let hi = outsidePt;
  for (let i = 0; i < (iterations || 16); i++) {
    const mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
    if (isInsideRegion(mid, region)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// Recorta uma polilinha ABERTA (já reamostrada em passos finos — ver
// resamplePolylineAt) aos trechos que ficam dentro da região, devolvendo
// cada trecho contínuo como uma corrida própria (uma polilinha pode entrar
// e saírda região várias vezes: furo, concavidade, guia que sai e volta).
// Os pontos de entrada/saída são refinados por bisseção (bisectBoundary)
// pra ficar coladinhos na borda real, sempre do lado de dentro.
function clipOpenPolylineToRegion(points, region) {
  const runs = [];
  let current = null;
  let prevPt = null;
  let prevInside = null;

  for (const p of points) {
    const inside = isInsideRegion(p, region);
    if (inside) {
      if (current === null) {
        current = [];
        if (prevPt !== null && prevInside === false) current.push(bisectBoundary(p, prevPt, region));
      }
      current.push(p);
    } else if (current !== null) {
      current.push(bisectBoundary(prevPt, p, region));
      runs.push(current);
      current = null;
    }
    prevPt = p;
    prevInside = inside;
  }
  if (current !== null && current.length) runs.push(current);
  return runs;
}

// Inverte uma lista de corridas por completo: ordem das corridas E ordem
// dos pontos dentro de cada uma — usado pra "virar" um trecho inteiro (uma
// passada, uma cópia deslocada da guia) quando isso encosta mais perto do
// que ele terminou por último, sem mudar nenhum ponto, só o sentido de
// percurso (mesma ideia de closerEnd em sections.js, aplicada a um grupo de
// corridas em vez de uma seção só).
function reverseRuns(runs) {
  return runs
    .slice()
    .reverse()
    .map((run) => run.slice().reverse());
}

module.exports = {
  EPS,
  MM,
  dist,
  rotatePoint,
  unrotatePoint,
  normalize2,
  hashJitter,
  regionCentroid,
  outerRadiusFrom,
  resamplePolylineAt,
  bisectBoundary,
  clipOpenPolylineToRegion,
  reverseRuns,
};
