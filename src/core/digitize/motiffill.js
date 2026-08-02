'use strict';
// Motif fill (issue #77, fase C): carimba repetidamente um motivo pequeno
// (coração, folha ou onda — biblioteca interna mínima, polylines de 6-12
// pontos definidas abaixo) numa grade escalonada (stagger tipo tijolo,
// linha ímpar deslocada meia célula), só aceitando o carimbo se ele cair
// INTEIRAMENTE dentro da região (todos os vértices do motivo + o centro da
// célula) — decorativo, não é tatami: não tenta cobrir 100% da área, só
// distribui o motivo pelas células que cabem por completo.
//
// Geometria: a grade é montada no espaço de cálculo de fill.js/sections.js
// (rotacionado por -angleDeg, célula "horizontal"), e cada ponto do motivo
// é tratado como um deslocamento LOCAL nesse mesmo espaço rotacionado antes
// de degirar — assim o motivo sai orientado junto com a grade (gira com
// opts.angleDeg) sem precisar de uma segunda rotação separada.
//
// Espaçamento da grade: como o motivo tem um tamanho próprio em mm
// (params.motifSizeMm), usar opts.rowSpacing (tipicamente <1mm, pensado pra
// fileiras de tatami) direto como espaçamento de célula esmagaria os
// carimbos um no outro. Decisão de design: espaçamento efetivo de célula =
// max(rowSpacing, diâmetro do motivo × 1.15) — respeita um rowSpacing GRANDE
// (o chamador pode espalhar mais os carimbos), mas nunca deixa a grade mais
// apertada do que o motivo pede.

const { rotatePoint, unrotatePoint } = require('./fillextras-util');
const { isInsideRegion } = require('./regions');

const MM = 10; // 1 mm = 10 unidades internas.

// Biblioteca interna de motivos: cada um é uma polyline fechada (exceto
// "wave", que é aberta de propósito) definida num quadrado normalizado de
// ~[-1,1] (diâmetro 2) centrado na origem. 6-12 pontos cada, como pedido.
const MOTIFS = {
  // Coração: 11 pontos, fechado (repete o ponto inicial no fim).
  heart: [
    [0, -0.6],
    [0.5, -1],
    [0.9, -0.6],
    [0.9, -0.1],
    [0.4, 0.5],
    [0, 0.9],
    [-0.4, 0.5],
    [-0.9, -0.1],
    [-0.9, -0.6],
    [-0.5, -1],
    [0, -0.6],
  ],
  // Folha: 9 pontos, fechada, forma de amêndoa (ponta acima e abaixo).
  leaf: [
    [0, -1],
    [0.35, -0.6],
    [0.5, -0.1],
    [0.35, 0.5],
    [0, 1],
    [-0.35, 0.5],
    [-0.5, -0.1],
    [-0.35, -0.6],
    [0, -1],
  ],
  // Onda: 6 pontos, ABERTA (zigue-zague suave, não fecha o contorno).
  wave: [
    [-1, 0],
    [-0.6, -0.7],
    [-0.2, 0.7],
    [0.2, -0.7],
    [0.6, 0.7],
    [1, 0],
  ],
};

function motifTemplate(name) {
  return MOTIFS[name] || MOTIFS.heart;
}

// generate(regionRings, opts) -> runs[]. opts.params: { motif, motifSizeMm }.
function generate(regionRings, opts = {}) {
  const rings = regionRings || [];
  if (rings.length === 0 || !rings[0] || rings[0].length < 3) return [];

  const params = opts.params || {};
  const angleDeg = opts.angleDeg || 0;
  const rowSpacing = opts.rowSpacing > 0 ? opts.rowSpacing : 4;
  const motifSizeUnits = ((params.motifSizeMm > 0 ? params.motifSizeMm : 6) * MM);
  const scale = motifSizeUnits / 2; // template normalizado tem diâmetro 2
  const template = motifTemplate(params.motif);

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
  if (!isFinite(minX) || !isFinite(maxX) || maxY - minY < 1e-6) return [];

  const cellSpacing = Math.max(rowSpacing, motifSizeUnits * 1.15);
  const region = { rings };

  // Coluna a coluna, o candidato é aceito só se TODOS os pontos do motivo
  // (já deslocados/rotacionados pro espaço real) e o centro da célula
  // caírem dentro da região. Margem de 1 célula em torno do bbox: como o
  // teste exige "inteiramente dentro", um candidato fora do bbox nunca
  // passaria mesmo — a margem só garante que o stagger (linhas pares vs
  // ímpares) cubra o mesmo padrão nas duas bordas.
  const runs = [];
  let rowIndex = 0;
  for (let gy = minY - cellSpacing; gy <= maxY + cellSpacing; gy += cellSpacing, rowIndex++) {
    const forward = rowIndex % 2 === 0;
    const xOffset = forward ? 0 : cellSpacing / 2;
    const cols = [];
    for (let gx = minX - cellSpacing + xOffset; gx <= maxX + cellSpacing; gx += cellSpacing) cols.push(gx);
    if (!forward) cols.reverse();

    for (const gx of cols) {
      const centerReal = unrotatePoint(gx, gy, cos, sin);
      if (!isInsideRegion(centerReal, region)) continue;

      const stampPts = template.map(([tx, ty]) => unrotatePoint(gx + tx * scale, gy + ty * scale, cos, sin));
      if (!stampPts.every((p) => isInsideRegion(p, region))) continue;

      runs.push(forward ? stampPts : stampPts.slice().reverse());
    }
  }

  return runs;
}

module.exports = { generate, MOTIFS };
