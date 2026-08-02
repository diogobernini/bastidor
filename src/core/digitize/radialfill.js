'use strict';
// Radial fill (issue #77, fase C): tatami polar — raios do centróide da
// região até a borda, em vez de fileiras paralelas. Cada raio é tratado como
// a fileira de UM scanline só (fill.spansAtY reaproveitado sem alteração),
// rotacionando a região por -θ pra cada ângulo de raio θ em vez de rotacionar
// uma vez só por opts.angleDeg — é a mesma mecânica, só que repetida uma vez
// por raio.
//
// Nº de raios: o ângulo entre raios é escolhido pra que o arco na borda
// (raio_externo × ângulo, em radianos) fique perto de rowSpacing×2 — mais
// raios numa peça grande, menos numa pequena, mantendo o espaçamento entre
// pontas de raios vizinhos proporcional ao rowSpacing pedido. `raio_externo`
// é só uma estimativa (maior distância do centróide a qualquer vértice da
// região, ver fillextras-util.outerRadiusFrom) — não precisa ser exata, só
// dar uma ordem de grandeza certa pro espaçamento angular.
//
// Robustez com região côncava (ex. "L"): o centróide de área de uma região
// bem côncava pode cair FORA da própria região (é o caso do fixture em L dos
// testes — o centróide fica exatamente no vão do L). O algoritmo não assume
// que o centróide está dentro: pra cada ângulo, calcula os vãos da RETA
// completa que passa pelo centróide nessa direção (spansAtY, even-odd com
// todos os anéis — furos incluídos) e recorta pro lado positivo (a partir do
// centróide, só a metade "pra fora" que interessa a ESSE raio; a metade
// oposta é justamente o raio de ângulo θ+180°, coberto por outra iteração).
// Se o centróide está fora, alguns raios simplesmente não tocam a região
// (0 vãos ou vãos inteiramente do lado errado) — comportamento degradado
// com elegância, sem caso especial nenhum.
//
// Alternância dentro<->fora: raios de índice par percorrem do centro pra
// borda (cada vão do mais interno pro mais externo, pontos nessa ordem);
// índice ímpar faz o inverso — minimiza o deslocamento entre a ponta de um
// raio e o início do próximo, igual à alternância de fileiras do tatami.

const fill = require('./fill');
const { rotatePoint, unrotatePoint, regionCentroid, outerRadiusFrom } = require('./fillextras-util');

const MIN_SPOKES = 8;
const MAX_SPOKES = 720;
const EPS = 1e-6;

function generate(regionRings, opts = {}) {
  const rings = regionRings || [];
  if (rings.length === 0 || !rings[0] || rings[0].length < 3) return [];

  const angleDeg = opts.angleDeg || 0;
  const stitchLength = opts.stitchLength > 0 ? opts.stitchLength : 30;
  const rowSpacing = opts.rowSpacing > 0 ? opts.rowSpacing : 4;

  const center = regionCentroid(rings);
  const outerRadius = outerRadiusFrom(rings, center);

  const targetArc = rowSpacing * 2;
  const angleStepRaw = targetArc / outerRadius;
  let numSpokes = Math.round((2 * Math.PI) / angleStepRaw);
  numSpokes = Math.max(MIN_SPOKES, Math.min(MAX_SPOKES, numSpokes));
  const angleStep = (2 * Math.PI) / numSpokes;
  const phase = (angleDeg * Math.PI) / 180;

  const runs = [];
  for (let k = 0; k < numSpokes; k++) {
    const theta = phase + k * angleStep;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const rotatedRings = rings.map((ring) => ring.map(([x, y]) => rotatePoint(x, y, cos, sin)));
    const [cxR, cyR] = rotatePoint(center[0], center[1], cos, sin);

    const spans = fill.spansAtY(rotatedRings, cyR);
    if (spans.length === 0) continue;

    const outward = k % 2 === 0;
    const segments = [];
    for (const [a, b] of spans) {
      const lo = Math.max(a, cxR);
      const hi = b;
      if (hi - lo <= EPS) continue;
      const xs = fill.pointsAlongSpan(lo, hi, lo, stitchLength);
      const pts = xs.map((x) => unrotatePoint(x, cyR, cos, sin));
      segments.push(pts);
    }
    if (segments.length === 0) continue;

    // Vãos já saem ordenados por x crescente (fill.spansAtY ordena as
    // interseções antes de parear) => do mais interno pro mais externo.
    const ordered = outward ? segments : segments.slice().reverse().map((pts) => pts.slice().reverse());
    for (const seg of ordered) runs.push(seg);
  }

  return runs;
}

module.exports = { generate };
