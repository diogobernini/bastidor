'use strict';
// Recalculo de densidade ao redimensionar (issue #4 do roadmap).
// Núcleo puro: sem require de Node/Electron, para poder ser carregado tanto
// via require() (testes, processo principal) quanto via <script> comum no
// renderer (mesma técnica de src/renderer/renderer.js, que redefine os
// comandos localmente em vez de exigir src/core/commands.js).
//
// Escopo v1 (reduzido): cobre só ponto cheio (satin), detectado por
// zigue-zague entre duas bordas. Preenchimentos (tatami) NÃO são
// regenerados aqui: permanecem com escala pura de coordenadas até existir
// detecção de preenchimento, que depende do motor de digitalização da
// issue #1 (fill algorithms para formas fechadas). Ponto corrido (running
// stitch) também usa escala pura: só ponto cheio tem reconstrução.

(function () {
const STITCH_CMD = 0; // valor de STITCH em src/core/commands.js
const COMMAND_MASK = 0xff;

// Limiares da heurística de detecção de ponto cheio (ver relatório da
// issue #4 para a taxa de acerto medida na amostra rosacea.xxx).
const DEFAULTS = {
  minSegLen: 5, // 0,5 mm, agulhada mais curta considerada satin
  maxSegLen: 120, // 12 mm, agulhada mais longa considerada satin
  minTurnAngleDeg: 140, // reversão mínima de direção entre agulhadas consecutivas
  minStitches: 8, // tamanho mínimo de uma corrida para valer a pena regenerar
};

function isStitch(st) {
  return (st[2] & COMMAND_MASK) === STITCH_CMD;
}

function dist(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

// --------------------------------------------------------- detecção (satin)

// Encontra corridas de ponto cheio: sequências de agulhadas STITCH
// consecutivas em zigue-zague (ângulo entre segmentos > minTurnAngleDeg,
// alternando de lado a cada passo), com comprimento de agulhada em
// [minSegLen, maxSegLen] e ao menos minStitches agulhadas.
// Retorna [{start, end}]: índices no array `stitches`, `end` exclusivo
// (mesma convenção de Array.prototype.slice usada no resto do core).
function detectSatinRuns(stitches, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const cosThresh = Math.cos((opts.minTurnAngleDeg * Math.PI) / 180);
  const runs = [];

  let blockStart = -1;
  for (let i = 0; i <= stitches.length; i++) {
    const stitchHere = i < stitches.length && isStitch(stitches[i]);
    if (stitchHere && blockStart === -1) {
      blockStart = i;
    } else if (!stitchHere && blockStart !== -1) {
      scanBlock(stitches, blockStart, i, opts, cosThresh, runs);
      blockStart = -1;
    }
  }
  return runs;
}

// Varre um bloco contíguo de agulhadas STITCH [lo, hi) procurando trechos
// de zigue-zague válido; empurra as corridas encontradas em `runs`.
function scanBlock(stitches, lo, hi, opts, cosThresh, runs) {
  const n = hi - lo; // agulhadas no bloco
  if (n < opts.minStitches) return;

  // Vetores de segmento (agulhada i -> i+1): [dx, dy, comprimento].
  const segs = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const a = stitches[lo + i];
    const b = stitches[lo + i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    segs[i] = [dx, dy, Math.hypot(dx, dy)];
  }

  const emit = (segFrom, segToInclusive) => {
    const stitchCount = segToInclusive - segFrom + 2; // pontos = segmentos + 1
    if (stitchCount >= opts.minStitches) {
      runs.push({ start: lo + segFrom, end: lo + segToInclusive + 2 });
    }
  };

  let runStart = 0; // segmento onde a corrida candidata começa
  let haveFirst = false; // já validamos ao menos 1 segmento (comprimento ok)
  let prevSign = 0; // lado do último desvio (para exigir alternância)

  for (let k = 0; k < segs.length; k++) {
    const lenOk = segs[k][2] >= opts.minSegLen && segs[k][2] <= opts.maxSegLen;
    if (!lenOk) {
      if (haveFirst) emit(runStart, k - 1);
      runStart = k + 1;
      haveFirst = false;
      prevSign = 0;
      continue;
    }
    if (!haveFirst) {
      haveFirst = true;
      continue;
    }
    const a = segs[k - 1];
    const b = segs[k];
    const dot = a[0] * b[0] + a[1] * b[1];
    const mag = a[2] * b[2];
    const cosAngle = mag > 0 ? dot / mag : 1;
    const sign = Math.sign(a[0] * b[1] - a[1] * b[0]);
    const turnsSharply = cosAngle <= cosThresh && sign !== 0;
    const alternates = prevSign === 0 || sign === -prevSign;
    if (turnsSharply && alternates) {
      prevSign = sign;
      continue;
    }
    // Corrida interrompida entre os segmentos k-1 e k; o segmento k pode
    // iniciar uma nova corrida candidata.
    emit(runStart, k - 1);
    runStart = k;
    haveFirst = true;
    prevSign = 0;
  }
  if (haveFirst) emit(runStart, segs.length - 1);
}

// --------------------------------------------------------- reescala + densidade

function boundsOf(stitches) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const st of stitches) {
    if (st[0] < minX) minX = st[0];
    if (st[0] > maxX) maxX = st[0];
    if (st[1] < minY) minY = st[1];
    if (st[1] > maxY) maxY = st[1];
  }
  if (minX > maxX) return [0, 0, 0, 0];
  return [minX, minY, maxX, maxY];
}

// Reamostra uma polilinha em passos de comprimento de arco ~= spacing.
// O passo real é ajustado para caber um número inteiro de vezes no
// comprimento total (fica igual ao alvo, sem sobra na ponta). Sempre
// retorna ao menos 2 pontos.
function resamplePolyline(points, spacing) {
  if (points.length === 1) return [points[0], points[0]];
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + dist(points[i - 1], points[i]));
  }
  const total = cum[cum.length - 1];
  if (total <= 1e-9) return [points[0], points[0]];
  const steps = Math.max(1, Math.round(total / Math.max(spacing, 1e-6)));
  const step = total / steps;
  const out = [];
  let seg = 0;
  for (let s = 0; s <= steps; s++) {
    const target = s * step;
    while (seg < cum.length - 2 && cum[seg + 1] < target) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    const t = segLen > 1e-9 ? (target - cum[seg]) / segLen : 0;
    const a = points[seg];
    const b = points[seg + 1];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

// Tangente unitária da polilinha em i (diferença central; direta nas pontas).
function tangentAt(points, i) {
  const a = points[Math.max(0, i - 1)];
  const b = points[Math.min(points.length - 1, i + 1)];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return len > 0 ? [dx / len, dy / len] : [1, 0];
}

// Reconstrói uma corrida de ponto cheio sobre a espinha escalada, mantendo
// o espaçamento absoluto original (densidade) e aplicando `factor` só na
// largura da coluna. `runStitches` são as agulhadas originais (não
// escaladas) da corrida; `center` é o centro global usado na escala.
function rebuildSatinRun(runStitches, factor, center) {
  const n = runStitches.length;

  // Espinha original = pontos médios de cada par de agulhadas consecutivas
  // (os desvios para cada lado se cancelam na média, já que agulhadas
  // consecutivas ficam em bordas opostas do zigue-zague).
  const spine = [];
  for (let i = 0; i < n - 1; i++) {
    spine.push([(runStitches[i][0] + runStitches[i + 1][0]) / 2, (runStitches[i][1] + runStitches[i + 1][1]) / 2]);
  }
  let spineLen = 0;
  for (let i = 1; i < spine.length; i++) spineLen += dist(spine[i - 1], spine[i]);
  const avgSpacing = spine.length > 1 ? spineLen / (spine.length - 1) : dist(runStitches[0], runStitches[1]);

  // Largura original: cada agulhada decompõe em avanço ao longo da espinha
  // (~avgSpacing) e desvio perpendicular (a largura da coluna).
  let widthSum = 0;
  for (let i = 0; i < n - 1; i++) {
    const segLen = dist(runStitches[i], runStitches[i + 1]);
    widthSum += Math.sqrt(Math.max(0, segLen * segLen - avgSpacing * avgSpacing));
  }
  const origWidth = widthSum / (n - 1);
  const newWidth = origWidth * factor;

  // Espinha escalada a partir do centro global do desenho (mesmo centro
  // usado nos trechos não-satin), espaçamento alvo = avgSpacing original
  // (não escalado: é isso que mantém a densidade).
  const scaledSpine = spine.map((p) => [center[0] + (p[0] - center[0]) * factor, center[1] + (p[1] - center[1]) * factor]);
  const newSpine = resamplePolyline(scaledSpine, avgSpacing);

  // Lado inicial: preserva de que lado da espinha a primeira agulhada
  // original ficava, para não inverter a orientação do zigue-zague.
  const firstTangent = tangentAt(newSpine, 0);
  const firstNormal = [-firstTangent[1], firstTangent[0]];
  const firstScaled = [center[0] + (runStitches[0][0] - center[0]) * factor, center[1] + (runStitches[0][1] - center[1]) * factor];
  const refVec = [firstScaled[0] - newSpine[0][0], firstScaled[1] - newSpine[0][1]];
  const startSign = Math.sign(refVec[0] * firstNormal[0] + refVec[1] * firstNormal[1]) || 1;

  const out = [];
  for (let j = 0; j < newSpine.length; j++) {
    const [tx, ty] = tangentAt(newSpine, j);
    const nx = -ty;
    const ny = tx;
    const sign = j % 2 === 0 ? startSign : -startSign;
    out.push([newSpine[j][0] + nx * (newWidth / 2) * sign, newSpine[j][1] + ny * (newWidth / 2) * sign]);
  }
  return out;
}

// Escala `stitches` por `factor` a partir do centro do bbox. Corridas de
// ponto cheio detectadas (ver detectSatinRuns) são reconstruídas em vez de
// escaladas ponto a ponto, para manter a densidade; o resto (ponto corrido,
// preenchimento, saltos, cortes etc.) usa escala pura. Retorna um novo
// array de agulhadas, preservando os comandos não-STITCH nas posições
// relativas corretas.
function rescaleWithDensity(stitches, factor, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const [minX, minY, maxX, maxY] = boundsOf(stitches);
  const center = opts.center || [(minX + maxX) / 2, (minY + maxY) / 2];
  const runs = detectSatinRuns(stitches, opts);

  const scalePoint = (st) => [center[0] + (st[0] - center[0]) * factor, center[1] + (st[1] - center[1]) * factor, st[2]];

  const out = [];
  let cursor = 0;
  let runIndex = 0;
  while (cursor < stitches.length) {
    const run = runs[runIndex];
    if (run && cursor === run.start) {
      const runStitches = stitches.slice(run.start, run.end);
      const rebuilt = rebuildSatinRun(runStitches, factor, center);
      for (const [x, y] of rebuilt) out.push([x, y, STITCH_CMD]);
      cursor = run.end;
      runIndex++;
      continue;
    }
    out.push(scalePoint(stitches[cursor]));
    cursor++;
  }
  return out;
}

const exported = { detectSatinRuns, rescaleWithDensity, DEFAULTS };

// CommonJS (testes, processo principal), guardado para não quebrar em
// contexto de navegador puro (nodeIntegration desligado).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = exported;
}
// <script> comum no renderer (sem require/import disponível). O IIFE isola
// os identificadores do escopo global: scripts clássicos compartilham o
// escopo léxico da página, e "api" (preload) e "COMMAND_MASK" (renderer.js)
// já existem lá.
if (typeof window !== 'undefined') {
  window.DensityScale = exported;
}
})();
