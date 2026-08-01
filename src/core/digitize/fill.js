'use strict';
// Preenchimento tatami por linhas de varredura (scanline).
//
// Ideia geral: gira o(s) polígono(s) para que as fileiras fiquem
// horizontais no espaço de cálculo, varre em Y com espaçamento fixo entre
// fileiras, em cada fileira intersecta todas as arestas de todos os anéis
// (regra even-odd, pareando os cruzamentos ordenados por X), e dentro de
// cada vão (span) distribui agulhadas num grid global escalonado (stagger
// 1/3) para criar o efeito cesto/tijolo entre fileiras. Vãos desconexos na
// mesma fileira viram corridas separadas ligadas por salto; a ordem
// esquerda<->direita alterna a cada fileira (serpentina) para minimizar o
// deslocamento entre fileiras contíguas.

const EPS = 1e-6;

function rotatePoint(x, y, cos, sin) {
  // Gira para o espaço de cálculo (linhas -> horizontais).
  return [x * cos + y * sin, -x * sin + y * cos];
}

function unrotatePoint(x, y, cos, sin) {
  return [x * cos - y * sin, x * sin + y * cos];
}

// polygons: [{points: [[x,y], ...]}] — cada anel é tratado como fechado
// (liga o último ponto ao primeiro), regra even-odd combinando todos os
// anéis (permite furos e formas com múltiplos contornos/blobs da mesma cor).
// opts: { angleDeg, rowSpacing, stitchLength } já em unidades internas
// (mesma unidade dos pontos de entrada).
// Devolve: array de "corridas" (cada corrida = array de [x,y]); o chamador
// liga a primeira corrida com um salto e cada corrida seguinte também com
// salto (fill.js já decide internamente quando duas fileiras podem virar
// uma única corrida contínua em ponto corrido, sem salto).
function fillPolygonsTatami(polygons, opts = {}) {
  const angleDeg = opts.angleDeg || 0;
  const rowSpacing = opts.rowSpacing > 0 ? opts.rowSpacing : 4;
  const stitchLength = opts.stitchLength > 0 ? opts.stitchLength : 30;

  const rings = (polygons || []).map((p) => p.points || p).filter((pts) => pts && pts.length >= 3);
  if (rings.length === 0) return [];

  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // Anéis já rotacionados para o espaço de cálculo (fileiras horizontais).
  const rotatedRings = rings.map((pts) => pts.map(([x, y]) => rotatePoint(x, y, cos, sin)));

  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  for (const ring of rotatedRings) {
    for (const [x, y] of ring) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x < minX) minX = x;
    }
  }
  if (!isFinite(minY) || !isFinite(maxY) || maxY - minY < EPS) return [];

  const rows = [];
  let rowIndex = 0;
  for (let y = minY + rowSpacing / 2; y < maxY; y += rowSpacing, rowIndex++) {
    const spans = spansAtY(rotatedRings, y);
    if (spans.length === 0) continue;
    const phase = ((rowIndex % 3) * stitchLength) / 3;
    const gridOrigin = minX + phase;
    const forward = rowIndex % 2 === 0;
    const orderedSpans = forward ? spans : spans.slice().reverse();
    const rowRuns = [];
    for (const span of orderedSpans) {
      // spansAtY já devolve [xMenor, xMaior]; para fileiras "de volta" da
      // serpentina, percorre o mesmo grid global em ordem decrescente.
      let pts = pointsAlongSpan(span[0], span[1], gridOrigin, stitchLength);
      if (!forward) pts = pts.slice().reverse();
      if (pts.length >= 1) rowRuns.push(pts.map((x) => [x, y]));
    }
    if (rowRuns.length) rows.push(rowRuns);
  }

  // Junta fileiras/vãos em corridas: mesma fileira -> sempre nova corrida
  // (salto entre vãos desconexos); fileira seguinte -> continua a mesma
  // corrida (ponto corrido) se a distância cabe numa agulhada normal, senão
  // nova corrida (salto) — nunca estica um "ponto" além do comprimento
  // configurado só para economizar um salto.
  const connectThreshold = stitchLength;
  const runs = [];
  let current = null;

  for (const rowRuns of rows) {
    for (let i = 0; i < rowRuns.length; i++) {
      const runRot = rowRuns[i];
      const real = runRot.map(([x, y]) => unrotatePoint(x, y, cos, sin));
      if (current === null) {
        current = real.slice();
        runs.push(current);
        continue;
      }
      const last = current[current.length - 1];
      const dist = Math.hypot(real[0][0] - last[0], real[0][1] - last[1]);
      const sameRow = i > 0; // vão seguinte na MESMA fileira: sempre novo (salto)
      if (!sameRow && dist <= connectThreshold) {
        current.push(...real);
      } else {
        current = real.slice();
        runs.push(current);
      }
    }
  }

  return runs;
}

// Cruzamentos com a fileira y=Y em todos os anéis, pareados even-odd.
function spansAtY(rotatedRings, Y) {
  const xs = [];
  for (const ring of rotatedRings) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % n];
      if (y0 === y1) continue;
      const crosses = (y0 <= Y && Y < y1) || (y1 <= Y && Y < y0);
      if (!crosses) continue;
      const t = (Y - y0) / (y1 - y0);
      xs.push(x0 + t * (x1 - x0));
    }
  }
  xs.sort((a, b) => a - b);
  const spans = [];
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > EPS) spans.push([xs[i], xs[i + 1]]);
  }
  return spans;
}

// Pontos entre "a" e "b" (a<=b) alinhados a um grid global (gridOrigin +
// k*stitchLength), sempre incluindo as duas bordas do vão. Nenhum segmento
// resultante passa de "stitchLength".
function pointsAlongSpan(a, b, gridOrigin, stitchLength) {
  const points = [a];
  let k = Math.ceil((a - gridOrigin) / stitchLength);
  let x = gridOrigin + k * stitchLength;
  if (x <= a + EPS) x += stitchLength;
  while (x < b - EPS) {
    points.push(x);
    x += stitchLength;
  }
  if (b - points[points.length - 1] > EPS) points.push(b);
  else points[points.length - 1] = b;
  return points;
}

module.exports = { fillPolygonsTatami, spansAtY, pointsAlongSpan };
