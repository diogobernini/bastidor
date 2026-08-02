'use strict';
// Meander/stipple fill (issue #77, fase C): serpentina boustrophedon igual à
// de fill.js, só que cada fileira não é reta: segue uma ondulação senoidal
// (efeito "quilting"/matelassê) em vez de uma linha. Espaçamento bem mais
// largo que o tatami normal (2-4 mm) — é um preenchimento decorativo/de
// textura, não de cobertura densa.
//
// Reaproveita fill.spansAtY (mesmo espaço rotacionado de fill.js/sections.js:
// gira por -angleDeg, fileiras horizontais nesse espaço) pra achar os vãos
// de cada fileira, exatamente como o tatami; a diferença é só COMO os pontos
// dentro de um vão são gerados (onda em vez de reta).
//
// Sem auto-cruzamento: a amplitude é sempre limitada a < metade do
// espaçamento efetivo entre fileiras (ver clampAmplitude) — assim o pico de
// uma fileira nunca alcança o vale da vizinha. Perto das duas pontas de cada
// vão a amplitude é atenuada por um envelope (seno de 0 a π ao longo do vão)
// até chegar a zero exatamente na borda: os pontos de entrada/saída de cada
// vão ficam exatamente onde spansAtY diz que a região termina (garantia de
// "sempre dentro" nas pontas, onde uma concavidade ou furo pode estar bem
// perto). Como salvaguarda extra (formas bem irregulares no meio do vão),
// qualquer ponto ondulado que teste como FORA da região cai de volta pro
// ponto da linha de base (sem onda) — dentro por construção, já que a linha
// de base é o próprio vão calculado por spansAtY.
//
// A fase da onda varia por fileira via hash determinístico do índice da
// fileira (fillextras-util.hashJitter) — não é obrigatório (a regra só pede
// "sem Math.random"), mas evita que fileiras vizinhas fiquem em fase e
// pareçam uma só onda contínua "por acidente"; puramente decorativo, não
// afeta a garantia de não-cruzamento (que depende só da amplitude).

const fill = require('./fill');
const { isInsideRegion } = require('./regions');
const { rotatePoint, unrotatePoint, hashJitter } = require('./fillextras-util');

const MM = 10;
const EPS = 1e-6;
const MIN_ROW_SPACING = 20; // 2 mm — piso do espaçamento efetivo (2-4 mm pedido).

function generate(regionRings, opts = {}) {
  const rings = regionRings || [];
  if (rings.length === 0 || !rings[0] || rings[0].length < 3) return [];

  const params = opts.params || {};
  const angleDeg = opts.angleDeg || 0;
  const stitchLength = opts.stitchLength > 0 ? opts.stitchLength : 30;
  const rowSpacing = Math.max(opts.rowSpacing > 0 ? opts.rowSpacing : 4, MIN_ROW_SPACING);

  const requestedAmp = (params.waveAmpMm > 0 ? params.waveAmpMm : 1.2) * MM;
  // Nunca deixa a amplitude alcançar a metade do espaçamento (com folga de
  // 10%) — é essa margem que impede o auto-cruzamento entre fileiras.
  const amp = Math.min(requestedAmp, rowSpacing * 0.45);
  const period = Math.max(4 * amp, EPS * 100); // "período ~4x amplitude"

  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotatedRings = rings.map((ring) => ring.map(([x, y]) => rotatePoint(x, y, cos, sin)));

  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rotatedRings) {
    for (const [, y] of ring) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minY) || maxY - minY < EPS) return [];

  const region = { rings };
  const runs = [];
  let rowIndex = 0;
  for (let y = minY + rowSpacing / 2; y < maxY; y += rowSpacing, rowIndex++) {
    const spans = fill.spansAtY(rotatedRings, y);
    if (spans.length === 0) continue;
    const forward = rowIndex % 2 === 0;
    const orderedSpans = forward ? spans : spans.slice().reverse();
    // Fase determinística por fileira (ver comentário do módulo).
    const phase = hashJitter(rowIndex, 11) * period;

    for (const [a, b] of orderedSpans) {
      const span = b - a;
      if (span <= EPS) continue;
      const sampleStep = Math.min(stitchLength, Math.max(span / 3, EPS * 10));
      const pts = [];
      for (let x = a; x < b - EPS; x += sampleStep) pts.push(wavePoint(x, a, b, y, amp, period, phase, cos, sin, region));
      pts.push(wavePoint(b, a, b, y, amp, period, phase, cos, sin, region));

      const ordered = forward ? pts : pts.reverse();
      if (ordered.length >= 1) runs.push(ordered);
    }
  }

  return runs;
}

// Um ponto do vão [a,b] na fileira rotacionada y=Y, deslocado pela onda
// senoidal com envelope (atenua a amplitude a zero nas duas pontas do vão)
// e degirado pro espaço real; cai pra linha de base se o ponto ondulado
// testar como fora da região.
function wavePoint(x, a, b, Y, amp, period, phase, cos, sin, region) {
  const span = b - a;
  const envelope = span > EPS ? Math.sin((Math.PI * (x - a)) / span) : 0;
  const offset = amp * envelope * Math.sin((2 * Math.PI * (x - a)) / period + phase);
  const wobbled = unrotatePoint(x, Y + offset, cos, sin);
  if (isInsideRegion(wobbled, region)) return wobbled;
  return unrotatePoint(x, Y, cos, sin);
}

module.exports = { generate };
