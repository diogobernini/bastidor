'use strict';
// Ponto corrido: reamostra uma polilinha (contorno/traço já achatado) em
// pontos igualmente espaçados ao longo do comprimento do traçado, mantendo
// início e fim exatos. Usado para os elementos com "stroke" (contornos).

const EPS = 1e-9;

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// points: [[x,y], ...]. closed: liga o último ponto ao primeiro antes de
// reamostrar (contorno fechado). stitchLength: comprimento alvo (mesma
// unidade dos pontos). Devolve pontos reamostrados (sem duplicar o fechamento
// — quem chama decide se repete o primeiro ponto no final).
function resampleRunStitch(points, stitchLength, closed = false) {
  const pts = (points || []).filter((p, i) => i === 0 || dist(p, points[i - 1]) > EPS);
  const n = pts.length;
  if (n === 0) return [];
  if (n === 1) return [pts[0]];
  if (!(stitchLength > 0)) return pts.slice();

  const edges = [];
  for (let i = 1; i < n; i++) edges.push([pts[i - 1], pts[i]]);
  if (closed && dist(pts[n - 1], pts[0]) > EPS) edges.push([pts[n - 1], pts[0]]);

  const cum = [0];
  for (const [a, b] of edges) cum.push(cum[cum.length - 1] + dist(a, b));
  const total = cum[cum.length - 1];
  if (total < EPS) return [pts[0]];

  const segCount = Math.max(closed ? 3 : 1, Math.round(total / stitchLength));
  const step = total / segCount;
  const numPoints = closed ? segCount : segCount + 1;

  let edgeIdx = 0;
  function pointAtArc(d) {
    if (d <= 0) return edges[0][0];
    if (d >= total) return closed ? edges[0][0] : edges[edges.length - 1][1];
    while (edgeIdx < edges.length - 1 && cum[edgeIdx + 1] < d) edgeIdx++;
    const [a, b] = edges[edgeIdx];
    const segLen = cum[edgeIdx + 1] - cum[edgeIdx];
    const t = segLen > EPS ? (d - cum[edgeIdx]) / segLen : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  const out = [];
  for (let k = 0; k < numPoints; k++) out.push(pointAtArc(k * step));
  return out;
}

module.exports = { resampleRunStitch };
