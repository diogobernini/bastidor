'use strict';
// Guided fill v1 paramétrico (issue #77, fase C): fileiras que seguem uma
// polyline-guia (params.guidePath, 2-6 pontos nas coordenadas da própria
// região) em vez de retas paralelas. Desloca a guia sucessivamente por
// rowSpacing pros dois lados (cópias em k = ..., -2, -1, 0, +1, +2, ...; k=0
// é a guia original), recorta cada cópia à região e serpenteia entre cópias
// vizinhas. Desenhar a guia numa UI é follow-up (outra issue) — aqui
// `params.guidePath` já chega pronto.
//
// Deslocamento: normal MÉDIA por vértice (média das normais dos dois
// segmentos vizinhos de cada vértice interno, ou a normal do único segmento
// nos dois extremos) — a mesma técnica clássica de "offset curve" de uma
// polyline aberta. Com uma guia de poucos pontos (2-6, como o contrato
// pede) e cantos suaves isso produz cópias bem paralelas; cantos muito
// fechados podem produzir pequenos gaps/sobreposições entre segmentos
// adjacentes da MESMA cópia nas voltas mais fechadas — aceitável pra v1
// (ver limitações no relatório), não afeta o recorte à região (que sempre
// mantém os pontos gerados dentro, ver clipOpenPolylineToRegion).
//
// Recorte: reamostra cada cópia deslocada num passo fino (metade do menor
// entre stitchLength e rowSpacing) e corta nos trechos que ficam dentro da
// região (fillextras-util.clipOpenPolylineToRegion, que já refina os pontos
// de entrada/saída por bisseção) — uma cópia pode virar 0, 1 ou várias
// corridas (a guia pode sair e voltar pra dentro da região várias vezes:
// furo, concavidade).
//
// Sem guidePath válido (< 2 pontos): cai pra uma guia reta horizontal
// passando pelo centróide da região, cobrindo a largura do bbox — nunca
// lança exceção nem devolve lixo por falta de parâmetro.

const {
  dist,
  normalize2,
  regionCentroid,
  resamplePolylineAt,
  clipOpenPolylineToRegion,
  reverseRuns,
} = require('./fillextras-util');

const EPS = 1e-6;
const MAX_COPIES_PER_SIDE = 200; // teto de segurança (rowSpacing minúsculo numa região gigante)

function resolveGuidePath(params, rings) {
  const guide = params && params.guidePath;
  if (Array.isArray(guide) && guide.length >= 2) return guide;

  const centroid = regionCentroid(rings);
  let minX = Infinity;
  let maxX = -Infinity;
  for (const ring of rings) {
    for (const [x] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  if (!isFinite(minX) || maxX - minX < EPS) return [[0, centroid[1]], [1, centroid[1]]];
  return [
    [minX, centroid[1]],
    [maxX, centroid[1]],
  ];
}

// Normal média por vértice de uma polyline ABERTA: soma as perpendiculares
// (rotação 90° CCW) das direções dos segmentos vizinhos e normaliza —
// vértices internos combinam os dois segmentos, extremos usam só o único
// vizinho que têm.
function computeVertexNormals(path) {
  const n = path.length;
  const normals = [];
  for (let i = 0; i < n; i++) {
    let nx = 0;
    let ny = 0;
    if (i > 0) {
      const [dx, dy] = normalize2([path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]]);
      nx += -dy;
      ny += dx;
    }
    if (i < n - 1) {
      const [dx, dy] = normalize2([path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]]);
      nx += -dy;
      ny += dx;
    }
    const [ux, uy] = normalize2([nx, ny]);
    normals.push([ux, uy]);
  }
  return normals;
}

function offsetPath(path, normals, distanceAlongNormal) {
  return path.map((p, i) => [p[0] + normals[i][0] * distanceAlongNormal, p[1] + normals[i][1] * distanceAlongNormal]);
}

function regionBoundingDiagonal(rings) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minX)) return 0;
  return Math.hypot(maxX - minX, maxY - minY);
}

function generate(regionRings, opts = {}) {
  const rings = regionRings || [];
  if (rings.length === 0 || !rings[0] || rings[0].length < 3) return [];

  const params = opts.params || {};
  const stitchLength = opts.stitchLength > 0 ? opts.stitchLength : 30;
  const rowSpacing = opts.rowSpacing > 0 ? opts.rowSpacing : 4;
  const region = { rings };

  const guidePath = resolveGuidePath(params, rings).filter((p, i, arr) => i === 0 || dist(p, arr[i - 1]) > EPS);
  if (guidePath.length < 2) return [];
  const normals = computeVertexNormals(guidePath);

  const diagonal = regionBoundingDiagonal(rings);
  const maxSteps = Math.max(1, Math.min(MAX_COPIES_PER_SIDE, Math.ceil(diagonal / rowSpacing) + 2));
  const clipStep = Math.max(1, Math.min(stitchLength, rowSpacing) / 2);

  const runs = [];
  let sequenceIndex = 0;
  for (let k = -maxSteps; k <= maxSteps; k++) {
    const shifted = offsetPath(guidePath, normals, k * rowSpacing);
    const fine = resamplePolylineAt(shifted, clipStep);
    const clipped = clipOpenPolylineToRegion(fine, region);
    if (clipped.length === 0) continue;

    // Serpenteia entre cópias adjacentes: cada cópia alternada (por ordem
    // de aparição real, não pelo valor de k — copies vizinhas que não geram
    // corrida nenhuma não devem "pular" a alternância) é percorrida ao
    // contrário, igual à alternância de fileiras do tatami.
    const oriented = sequenceIndex % 2 === 0 ? clipped : reverseRuns(clipped);
    for (const run of oriented) runs.push(run);
    sequenceIndex++;
  }

  return runs;
}

module.exports = { generate };
