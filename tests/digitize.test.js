'use strict';
// Testes do núcleo de digitalização (src/core/digitize): preenchimento
// tatami por scanline, ponto corrido reamostrado e importação de SVG.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { fillPolygonsTatami } = require('../src/core/digitize/fill');
const { resampleRunStitch } = require('../src/core/digitize/runstitch');
const { importSvg, parseSvgToShapeGroups } = require('../src/core/digitize');
const io = require('../src/core/io');

const MM = 10; // 1 mm = 10 unidades internas (0,1 mm)

function stitchToStitchLengths(pattern) {
  const C = require('../src/core/commands');
  const lens = [];
  let px = null;
  let py = null;
  for (const st of pattern.stitches) {
    const cmd = st[2] & C.COMMAND_MASK;
    if (cmd === C.STITCH) {
      if (px !== null) lens.push(Math.hypot(st[0] - px, st[1] - py));
      px = st[0];
      py = st[1];
    } else if (cmd === C.JUMP) {
      px = st[0];
      py = st[1];
    } else {
      px = null;
      py = null;
    }
  }
  return lens;
}

test('fill: quadrado 20x20mm com espaçamento 0,4mm gera ~50 fileiras dentro do bbox', () => {
  const sizeMm = 20;
  const spacingMm = 0.4;
  const stitchMm = 3;
  const size = sizeMm * MM;
  const square = [{ points: [[0, 0], [size, 0], [size, size], [0, size]] }];

  const runs = fillPolygonsTatami(square, {
    angleDeg: 0,
    rowSpacing: spacingMm * MM,
    stitchLength: stitchMm * MM,
  });

  assert.ok(runs.length >= 1, 'esperava ao menos uma corrida');

  const rowYs = new Set();
  let maxSeg = 0;
  let totalPoints = 0;
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) {
      const [x, y] = run[i];
      totalPoints++;
      assert.ok(x >= -1e-6 && x <= size + 1e-6, `x fora do bbox: ${x}`);
      assert.ok(y >= -1e-6 && y <= size + 1e-6, `y fora do bbox: ${y}`);
      rowYs.add(Math.round(y * 1000));
      if (i > 0) {
        const d = Math.hypot(x - run[i - 1][0], y - run[i - 1][1]);
        maxSeg = Math.max(maxSeg, d);
      }
    }
  }
  const expectedRows = sizeMm / spacingMm; // 50
  assert.ok(
    Math.abs(rowYs.size - expectedRows) <= 1,
    `fileiras=${rowYs.size}, esperado ${expectedRows} ±1`
  );
  const tolerance = stitchMm * MM * 1.2;
  assert.ok(maxSeg <= tolerance, `segmento maior que a tolerância: ${maxSeg} > ${tolerance}`);
  assert.ok(totalPoints > 0);
});

test('fill: quadrado com furo (even-odd) gera saltos entre vãos desconexos', () => {
  const outer = [[0, 0], [400, 0], [400, 400], [0, 400]];
  const hole = [[150, 150], [250, 150], [250, 250], [150, 250]];
  const runs = fillPolygonsTatami([{ points: outer }, { points: hole }], {
    angleDeg: 0,
    rowSpacing: 4,
    stitchLength: 30,
  });
  assert.ok(runs.length > 1, 'o furo deveria quebrar ao menos uma fileira em corridas separadas');
  for (const run of runs) {
    for (const [x, y] of run) {
      const insideHole = x > 150 && x < 250 && y > 150 && y < 250;
      assert.ok(!insideHole, `ponto (${x},${y}) cai dentro do furo (even-odd)`);
    }
  }
});

test('fill: círculo preenchido mantém pontos dentro do raio + margem', () => {
  const N = 128;
  const R = 100; // 10 mm
  const cx = 100;
  const cy = 100;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  const runs = fillPolygonsTatami([{ points: pts }], { angleDeg: 0, rowSpacing: 4, stitchLength: 30 });
  assert.ok(runs.length >= 1);
  const margin = 5; // 0,5 mm de folga (aproximação do círculo por polígono)
  for (const run of runs) {
    for (const [x, y] of run) {
      const r = Math.hypot(x - cx, y - cy);
      assert.ok(r <= R + margin, `ponto fora do raio+margem: r=${r}`);
    }
  }
});

test('fill: ângulo de fileira rotaciona a varredura mas mantém a geometria no bbox', () => {
  const size = 200; // 20 mm
  const square = [{ points: [[0, 0], [size, 0], [size, size], [0, size]] }];
  const runs = fillPolygonsTatami(square, { angleDeg: 45, rowSpacing: 4, stitchLength: 30 });
  assert.ok(runs.length >= 1);
  for (const run of runs) {
    for (const [x, y] of run) {
      assert.ok(x >= -1e-6 && x <= size + 1e-6);
      assert.ok(y >= -1e-6 && y <= size + 1e-6);
    }
  }
});

test('runstitch: ponto corrido fica entre 0,5x e 1,2x do comprimento configurado (aberto)', () => {
  const stitchLength = 25; // 2,5 mm
  const pts = resampleRunStitch([[0, 0], [37, 0], [37, 62], [90, 62]], stitchLength, false);
  assert.ok(pts.length >= 2);
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    assert.ok(d >= stitchLength * 0.5 && d <= stitchLength * 1.2, `segmento ${d} fora da faixa`);
  }
});

test('runstitch: ponto corrido fechado (contorno) mantém espaçamento uniforme', () => {
  const stitchLength = 25;
  const N = 64;
  const R = 100;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    pts.push([R * Math.cos(a), R * Math.sin(a)]);
  }
  const resampled = resampleRunStitch(pts, stitchLength, true);
  assert.ok(resampled.length >= 3);
  for (let i = 0; i < resampled.length; i++) {
    const a = resampled[i];
    const b = resampled[(i + 1) % resampled.length];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    assert.ok(d >= stitchLength * 0.5 && d <= stitchLength * 1.2, `segmento ${d} fora da faixa`);
  }
});

test('runstitch: traçado menor que o comprimento configurado não quebra', () => {
  const pts = resampleRunStitch([[0, 0], [5, 0]], 25, false);
  assert.ok(pts.length >= 2);
});

test('importSvg: samples/folha.svg gera 2 blocos de cor (fill + contorno)', () => {
  const svgText = fs.readFileSync(path.join(__dirname, '..', 'samples', 'folha.svg'), 'utf8');
  const groups = parseSvgToShapeGroups(svgText);
  assert.equal(groups.fills.length, 1, 'esperava 1 cor de preenchimento');
  assert.equal(groups.strokes.length, 1, 'esperava 1 cor de contorno');

  const pattern = importSvg(svgText, {});
  const blocks = pattern.getAsColorblocks();
  assert.equal(blocks.length, 2, 'esperava 2 blocos de cor no Pattern');
  assert.equal(pattern.countColorChanges(), 1);
  assert.equal(pattern.threadlist.length, 2);
  assert.ok(pattern.countStitches() > 100);

  const b = pattern.bounds();
  assert.ok(isFinite(b[0]) && isFinite(b[3]), 'bounds devem ser finitos');
  // folha cabe dentro do viewBox 50x60mm (com alguma margem de tolerância).
  assert.ok(b[0] >= -5 && b[2] <= 505, `bounds x fora do esperado: ${JSON.stringify(b)}`);
  assert.ok(b[1] >= -5 && b[3] <= 605, `bounds y fora do esperado: ${JSON.stringify(b)}`);
});

test('importSvg: nenhum ponto corrido do preenchimento excede a tolerância de agulhada', () => {
  const svgText = fs.readFileSync(path.join(__dirname, '..', 'samples', 'folha.svg'), 'utf8');
  const fillStitchMm = 3;
  const pattern = importSvg(svgText, { fillStitchMm });
  const lens = stitchToStitchLengths(pattern);
  const tolerance = fillStitchMm * MM * 1.2;
  const worst = Math.max(...lens);
  assert.ok(worst <= tolerance, `pior segmento ${worst} > tolerância ${tolerance}`);
});

test('importSvg: roundtrip via XXX preserva contagens de pontos e cores', () => {
  const svgText = fs.readFileSync(path.join(__dirname, '..', 'samples', 'folha.svg'), 'utf8');
  const pattern = importSvg(svgText, {});

  const normalized = pattern.getNormalizedPattern({ max_jump: 124, max_stitch: 124, round: true });
  const buf = io.writeBuffer(pattern, 'xxx');
  const readBack = io.readBuffer(buf, 'xxx');

  assert.equal(readBack.threadlist.length, pattern.threadlist.length);
  assert.deepEqual(readBack.threadlist.map((t) => t.hex()), normalized.threadlist.map((t) => t.hex()));

  const C = require('../src/core/commands');
  const countCmd = (p, cmd) => p.stitches.filter((s) => (s[2] & C.COMMAND_MASK) === cmd).length;
  assert.equal(countCmd(readBack, C.STITCH), countCmd(normalized, C.STITCH));
  assert.equal(countCmd(readBack, C.COLOR_CHANGE), countCmd(normalized, C.COLOR_CHANGE));

  const b1 = readBack.bounds();
  const b2 = normalized.bounds();
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(b1[i] - b2[i]) <= 1.5, `bounds[${i}] divergem`);
});

test('importSvg: outline:false ignora contornos e mantém só os preenchimentos', () => {
  const svgText = fs.readFileSync(path.join(__dirname, '..', 'samples', 'folha.svg'), 'utf8');
  const pattern = importSvg(svgText, { outline: false });
  assert.equal(pattern.threadlist.length, 1);
  assert.equal(pattern.countColorChanges(), 0);
});

test('importSvg: SVG vazio ou sem forma visível devolve Pattern sem pontos', () => {
  const pattern = importSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"></svg>', {});
  assert.equal(pattern.countStitches(), 0);
  assert.equal(pattern.threadlist.length, 0);
});
