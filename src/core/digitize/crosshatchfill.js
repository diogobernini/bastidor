'use strict';
// Crosshatch fill (issue #77, fase C): duas passadas de tatami esparso a
// ±45° (por padrão; opts.params.crossAngleDeg troca o meio-ângulo) em volta
// de opts.angleDeg, cada uma com o dobro do espaçamento normal entre
// fileiras — efeito de sombreado rendado (lacy shading), como um hatching de
// desenho técnico.
//
// Não reimplementa nenhuma mecânica de varredura: cada passada É uma
// chamada direta a fill.fillPolygonsTatami (a mesma função que o tatami
// "normal" usa), só variando angleDeg/rowSpacing — reuso total, zero
// geometria nova além de decidir os dois ângulos, dobrar o espaçamento e
// orientar a segunda passada.
//
// "a segunda passada começa perto de onde a primeira termina": como não há
// controle direto sobre por onde fillPolygonsTatami começa cada passada
// (ela sempre parte do canto de Y mínimo no SEU próprio espaço rotacionado),
// a orientação é decidida IGUAL a uma seção em sections.js/regions.js
// (closerEnd): comparamos a distância do fim da passada 1 até o INÍCIO e até
// o FIM da passada 2 e, se o fim da passada 2 estiver mais perto, invertemos
// a passada 2 por completo (ordem das corridas e pontos de cada corrida) —
// mesmos pontos, só o sentido de percurso muda.

const { fillPolygonsTatami } = require('./fill');
const { dist, reverseRuns } = require('./fillextras-util');

const DEFAULT_CROSS_ANGLE = 45;

function generate(regionRings, opts = {}) {
  const rings = regionRings || [];
  if (rings.length === 0 || !rings[0] || rings[0].length < 3) return [];

  const params = opts.params || {};
  const baseAngle = opts.angleDeg || 0;
  const stitchLength = opts.stitchLength > 0 ? opts.stitchLength : 30;
  const baseSpacing = opts.rowSpacing > 0 ? opts.rowSpacing : 4;
  const rowSpacing = baseSpacing * 2;
  const halfAngle = params.crossAngleDeg > 0 ? params.crossAngleDeg : DEFAULT_CROSS_ANGLE;

  const pass1 = fillPolygonsTatami(rings, {
    angleDeg: baseAngle - halfAngle,
    rowSpacing,
    stitchLength,
  });
  let pass2 = fillPolygonsTatami(rings, {
    angleDeg: baseAngle + halfAngle,
    rowSpacing,
    stitchLength,
  });

  if (pass1.length && pass2.length) {
    const end1 = pass1[pass1.length - 1][pass1[pass1.length - 1].length - 1];
    const start2 = pass2[0][0];
    const lastRun2 = pass2[pass2.length - 1];
    const end2 = lastRun2[lastRun2.length - 1];
    if (dist(end1, end2) < dist(end1, start2)) pass2 = reverseRuns(pass2);
  }

  return pass1.concat(pass2);
}

module.exports = { generate };
