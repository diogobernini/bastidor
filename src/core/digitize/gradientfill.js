'use strict';
// Density gradient fill (issue #77, fase C): tatami comum (mesma mecânica de
// varredura de fill.js: gira por -opts.angleDeg, fileiras horizontais nesse
// espaço, fill.spansAtY/pointsAlongSpan pra cada uma), só que o espaçamento
// entre fileiras NÃO é fixo: interpola de params.spacingFromMm a
// params.spacingToMm (defaults 0,35mm -> 1,2mm) conforme a posição da
// fileira ao longo do eixo params.gradientAngleDeg — mais densa de um lado,
// mais aberta do outro, efeito de sombreado gradual.
//
// Design: a ORIENTAÇÃO das fileiras continua sendo opts.angleDeg (mesmo
// significado que em todo o resto do contrato — não é sobrescrito aqui);
// params.gradientAngleDeg é um eixo INDEPENDENTE, só usado pra medir "o
// quanto avançamos" ao longo do gradiente. Cada fileira usa o ponto médio do
// seu primeiro vão como amostra representativa, projeta esse ponto no eixo
// do gradiente e mapeia a posição relativa (0=início, 1=fim, ao longo de
// TODO o bbox da região nesse eixo) pro espaçamento LOCAL da fileira
// seguinte — "passo variável por fileira" pedido no contrato, generalizado
// pra qualquer ângulo de gradiente (não só o mesmo eixo do empilhamento de
// fileiras). Com um único vão por fileira (caso comum) e gradientAngleDeg
// igual a angleDeg+90 (gradiente alinhado ao empilhamento), isso se reduz
// exatamente ao caso simples "espaçamento cresce/diminui de cima pra baixo".
//
// Nota de design / follow-up (pedido explicitamente pela issue #77): a v1
// aqui usa um gradiente LINEAR (uma reta com direção e sentido fixos) como
// mapa de densidade. Um follow-up natural é trocar esse mapa linear por um
// mapa de densidade derivado do TOM da imagem de origem (bordado em
// "meio-tom": áreas claras da imagem viram fileiras mais espaçadas, áreas
// escuras viram fileiras mais próximas) — reaproveitando o MESMO laço de
// varredura com passo variável por fileira daqui, só troca a função que
// calcula `localSpacing(pontoRepresentativo)` de "projeção num eixo" para
// "amostra de luminância do raster na posição da fileira". Não implementado
// nesta issue (fase C é só o framework paramétrico do gradiente linear).

const fill = require('./fill');
const { rotatePoint, unrotatePoint } = require('./fillextras-util');

const MM = 10;
const EPS = 1e-6;
const MIN_SPACING = 0.5; // piso de segurança (nunca deixa o passo colapsar a ~0)

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function generate(regionRings, opts = {}) {
  const rings = regionRings || [];
  if (rings.length === 0 || !rings[0] || rings[0].length < 3) return [];

  const params = opts.params || {};
  const angleDeg = opts.angleDeg || 0;
  const stitchLength = opts.stitchLength > 0 ? opts.stitchLength : 30;
  const spacingFrom = Math.max((params.spacingFromMm > 0 ? params.spacingFromMm : 0.35) * MM, MIN_SPACING);
  const spacingTo = Math.max((params.spacingToMm > 0 ? params.spacingToMm : 1.2) * MM, MIN_SPACING);
  const gradientAngleDeg = params.gradientAngleDeg || 0;

  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotatedRings = rings.map((ring) => ring.map(([x, y]) => rotatePoint(x, y, cos, sin)));

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rotatedRings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minY) || maxY - minY < EPS) return [];

  // Eixo do gradiente: projeção escalar (produto escalar com o vetor
  // unitário do ângulo) de cada vértice REAL da região, pra achar a faixa
  // [projMin, projMax] que representa "0% a 100%" do gradiente.
  const gradRad = (gradientAngleDeg * Math.PI) / 180;
  const gcos = Math.cos(gradRad);
  const gsin = Math.sin(gradRad);
  let projMin = Infinity;
  let projMax = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      const p = x * gcos + y * gsin;
      if (p < projMin) projMin = p;
      if (p > projMax) projMax = p;
    }
  }
  const projSpan = projMax - projMin;

  const runs = [];
  let y = minY + spacingFrom / 2;
  let rowIndex = 0;
  while (y < maxY) {
    const spans = fill.spansAtY(rotatedRings, y);
    let localSpacing = spacingFrom;

    if (spans.length) {
      const [a0, b0] = spans[0];
      const midReal = unrotatePoint((a0 + b0) / 2, y, cos, sin);
      const proj = midReal[0] * gcos + midReal[1] * gsin;
      const f = projSpan > EPS ? clamp01((proj - projMin) / projSpan) : 0;
      localSpacing = spacingFrom + (spacingTo - spacingFrom) * f;

      const phase = ((rowIndex % 3) * stitchLength) / 3;
      const gridOrigin = minX + phase;
      const forward = rowIndex % 2 === 0;
      const orderedSpans = forward ? spans : spans.slice().reverse();
      for (const [a, b] of orderedSpans) {
        let xs = fill.pointsAlongSpan(a, b, gridOrigin, stitchLength);
        if (!forward) xs = xs.slice().reverse();
        runs.push(xs.map((x) => unrotatePoint(x, y, cos, sin)));
      }
    }

    y += localSpacing;
    rowIndex++;
  }

  return runs;
}

module.exports = { generate };
