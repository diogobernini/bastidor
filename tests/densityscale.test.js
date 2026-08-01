'use strict';
// Testes do recalculo de densidade ao redimensionar (issue #4, v1: só ponto
// cheio/satin). As estatísticas de espaçamento/largura são recalculadas
// aqui de forma independente (não usam funções internas de densityscale.js)
// para não validar a implementação contra si mesma.

const test = require('node:test');
const assert = require('node:assert');

const { detectSatinRuns, rescaleWithDensity } = require('../src/core/densityscale');
const { Pattern } = require('../src/core/pattern');
const C = require('../src/core/commands');
const io = require('../src/core/io');

// ------------------------------------------------------------- fixtures

// Reamostra uma polilinha em passo de comprimento de arco ~= spacing.
// (cópia local só para gerar a fixture — o núcleo tem a sua própria.)
function resample(points, spacing) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  const steps = Math.max(1, Math.round(total / spacing));
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

function tangentAt(points, i) {
  const a = points[Math.max(0, i - 1)];
  const b = points[Math.min(points.length - 1, i + 1)];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return len > 0 ? [dx / len, dy / len] : [1, 0];
}

// Coluna de ponto cheio sintética: zigue-zague de largura `width` ao longo
// de uma senoide (curva com curvatura variável, não um segmento reto),
// com `spacing` de espaçamento ao longo da espinha. Devolve um array de
// agulhadas [x, y, cmd] com um JUMP inicial seguido só de STITCH, como um
// bloco de cor real.
function buildSatinColumn({ length = 800, amplitude = 80, cycles = 1.5, width = 30, spacing = 4.5 } = {}) {
  const fine = [];
  const fineSteps = 4000;
  for (let i = 0; i <= fineSteps; i++) {
    const u = i / fineSteps;
    fine.push([u * length, amplitude * Math.sin(u * cycles * 2 * Math.PI)]);
  }
  const spine = resample(fine, spacing);
  const stitches = [[Math.round(spine[0][0]), Math.round(spine[0][1]), C.JUMP]];
  for (let j = 0; j < spine.length; j++) {
    const [tx, ty] = tangentAt(spine, j);
    const nx = -ty;
    const ny = tx;
    const sign = j % 2 === 0 ? 1 : -1;
    const x = spine[j][0] + nx * (width / 2) * sign;
    const y = spine[j][1] + ny * (width / 2) * sign;
    stitches.push([Math.round(x), Math.round(y), C.STITCH]);
  }
  return stitches;
}

// Ponto corrido puro: avança em curva suave (sem reversão de direção), só
// para frente — não deve ser confundido com ponto cheio.
function buildRunningStitch({ n = 60, step = 25 } = {}) {
  const stitches = [[0, 0, C.JUMP]];
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 0.6;
    x += Math.round(step * Math.cos(angle));
    y += Math.round(step * Math.sin(angle));
    stitches.push([x, y, C.STITCH]);
  }
  return stitches;
}

// Espinha (pontos médios de agulhadas consecutivas) de um trecho só-STITCH;
// devolve espaçamento médio ao longo dela e largura média (decomposição
// avanço/perpendicular). Recalculado de forma independente do núcleo.
function spineStats(stitches) {
  const spine = [];
  for (let i = 0; i < stitches.length - 1; i++) {
    spine.push([(stitches[i][0] + stitches[i + 1][0]) / 2, (stitches[i][1] + stitches[i + 1][1]) / 2]);
  }
  let len = 0;
  for (let i = 1; i < spine.length; i++) {
    len += Math.hypot(spine[i][0] - spine[i - 1][0], spine[i][1] - spine[i - 1][1]);
  }
  const avgSpacing = len / (spine.length - 1);
  let widthSum = 0;
  for (let i = 0; i < stitches.length - 1; i++) {
    const segLen = Math.hypot(stitches[i + 1][0] - stitches[i][0], stitches[i + 1][1] - stitches[i][1]);
    widthSum += Math.sqrt(Math.max(0, segLen * segLen - avgSpacing * avgSpacing));
  }
  const avgWidth = widthSum / (stitches.length - 1);
  return { avgSpacing, avgWidth };
}

function stitchCountOf(stitches) {
  return stitches.filter((s) => (s[2] & 0xff) === C.STITCH).length;
}

function assertBoundsClose(a, b, tolerance) {
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(a[i] - b[i]) <= tolerance, `bounds[${i}]: ${a[i]} vs ${b[i]}`);
  }
}

// ------------------------------------------------------------------ testes

test('detectSatinRuns encontra 1 corrida cobrindo ao menos 90% de uma coluna satin sintética', () => {
  const stitches = buildSatinColumn();
  const total = stitchCountOf(stitches);
  const runs = detectSatinRuns(stitches);

  assert.strictEqual(runs.length, 1, 'esperava exatamente 1 corrida');
  const covered = runs[0].end - runs[0].start;
  assert.ok(covered / total >= 0.9, `cobertura ${covered}/${total} deveria ser >= 90%`);
});

test('rescaleWithDensity ×2 mantém espaçamento e dobra a largura', () => {
  const stitches = buildSatinColumn();
  const before = spineStats(stitches.slice(1)); // sem o JUMP inicial

  const rescaled = rescaleWithDensity(stitches, 2);
  const after = spineStats(rescaled.slice(1));

  const spacingRatio = after.avgSpacing / before.avgSpacing;
  assert.ok(spacingRatio >= 0.9 && spacingRatio <= 1.1, `razão de espaçamento ${spacingRatio} fora de [0.9, 1.1]`);

  const widthRatio = after.avgWidth / before.avgWidth;
  assert.ok(Math.abs(widthRatio - 2) <= 0.2, `razão de largura ${widthRatio} deveria ser ~2`);
});

test('rescaleWithDensity ×0,5 mantém espaçamento e reduz a largura à metade', () => {
  const stitches = buildSatinColumn();
  const before = spineStats(stitches.slice(1));

  const rescaled = rescaleWithDensity(stitches, 0.5);
  const after = spineStats(rescaled.slice(1));

  const spacingRatio = after.avgSpacing / before.avgSpacing;
  assert.ok(spacingRatio >= 0.9 && spacingRatio <= 1.1, `razão de espaçamento ${spacingRatio} fora de [0.9, 1.1]`);

  const widthRatio = after.avgWidth / before.avgWidth;
  assert.ok(Math.abs(widthRatio - 0.5) <= 0.1, `razão de largura ${widthRatio} deveria ser ~0,5`);
});

test('ponto corrido puro (sem zigue-zague) não é detectado como satin', () => {
  const stitches = buildRunningStitch();
  const runs = detectSatinRuns(stitches);
  assert.deepStrictEqual(runs, []);
});

test('roundtrip do resultado de rescaleWithDensity por XXX preserva geometria', () => {
  const original = buildSatinColumn();
  const rescaled = rescaleWithDensity(original, 2);

  const p = new Pattern();
  p.addThread({ color: 0x224488, description: 'Teste' });
  p.stitches = rescaled.map((s) => [s[0], s[1], s[2]]);
  const last = p.stitches[p.stitches.length - 1];
  p._previousX = last[0];
  p._previousY = last[1];
  p.end();

  const buf = io.writeBuffer(p, 'xxx');
  const readBack = io.readBuffer(buf, 'xxx');

  const expectedStitches = stitchCountOf(rescaled);
  const gotStitches = readBack.stitches.filter((s) => (s[2] & 0xff) === C.STITCH).length;
  assert.equal(gotStitches, expectedStitches);
  assertBoundsClose(readBack.bounds(), p.bounds(), 1.5);
});
