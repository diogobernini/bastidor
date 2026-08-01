'use strict';
// Reamostragem de polilinhas por distância constante ao longo do traço.
// Extraído de stitcher.js (issue #19) para ser reusado também por satin.js
// (o espaçamento das "travessas" do ponto cheio usa o mesmo algoritmo do
// ponto corrido, só que com um passo bem mais curto).

function dedupePoints(points) {
  const out = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 1e-6) out.push(p);
  }
  return out;
}

function roundDedupe(points) {
  return dedupePoints(points.map(([x, y]) => [Math.round(x), Math.round(y)]));
}

// Reamostra uma polilinha para que os pontos de saída fiquem a ~stepUnits de
// distância entre si (acumulando a sobra de cada segmento para o próximo, o
// que mantém o compasso constante mesmo atravessando vértices). Preserva o
// primeiro e o último ponto originais; o trecho final por isso pode ficar
// mais curto que stepUnits — prática comum em digitalização, para acertar
// exatamente o ponto final do traço.
function resamplePolyline(points, stepUnits) {
  const pts = dedupePoints(points);
  if (pts.length < 2) return [];
  if (!(stepUnits > 0)) return roundDedupe(pts);

  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const segLen = Math.hypot(x1 - x0, y1 - y0);
    if (segLen <= 1e-9) continue;
    let dist = stepUnits - carry;
    while (dist <= segLen) {
      const t = dist / segLen;
      out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
      dist += stepUnits;
    }
    carry = segLen - (dist - stepUnits);
  }
  const last = pts[pts.length - 1];
  const outLast = out[out.length - 1];
  if (Math.hypot(last[0] - outLast[0], last[1] - outLast[1]) > 1e-6) out.push(last);

  const rounded = roundDedupe(out);
  return rounded.length >= 2 ? rounded : roundDedupe([pts[0], pts[pts.length - 1]]);
}

module.exports = { dedupePoints, roundDedupe, resamplePolyline };
