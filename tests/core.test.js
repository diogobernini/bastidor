'use strict';
// Testes de ida-e-volta dos formatos: gravar com nossos writers e reler com
// nossos readers precisa preservar geometria, cores e comandos.

const test = require('node:test');
const assert = require('node:assert');

const C = require('../src/core/commands');
const io = require('../src/core/io');
const { buildRosacea, buildLongStitchTest } = require('../tools/make-samples');

function stats(pattern) {
  const s = { stitches: 0, jumps: 0, trims: 0, colorChanges: 0, stops: 0 };
  for (const st of pattern.stitches) {
    const cmd = st[2] & C.COMMAND_MASK;
    if (cmd === C.STITCH) s.stitches++;
    else if (cmd === C.JUMP) s.jumps++;
    else if (cmd === C.TRIM) s.trims++;
    else if (cmd === C.COLOR_CHANGE) s.colorChanges++;
    else if (cmd === C.STOP) s.stops++;
  }
  return s;
}

function assertBoundsClose(a, b, tolerance = 1.5) {
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(a[i] - b[i]) <= tolerance, `bounds[${i}]: ${a[i]} vs ${b[i]}`);
  }
}

function maxDelta(pattern) {
  let max = 0;
  let px = 0;
  let py = 0;
  for (const st of pattern.stitches) {
    const cmd = st[2] & C.COMMAND_MASK;
    if (cmd === C.STITCH || cmd === C.JUMP) {
      max = Math.max(max, Math.abs(st[0] - px), Math.abs(st[1] - py));
      px = st[0];
      py = st[1];
    }
  }
  return max;
}

test('roundtrip XXX preserva geometria e cores', () => {
  const original = buildRosacea();
  const normalized = original.getNormalizedPattern({ max_jump: 124, max_stitch: 124, round: true });
  const buf = io.writeBuffer(original, 'xxx');
  const readBack = io.readBuffer(buf, 'xxx');

  assert.equal(readBack.threadlist.length, 3);
  assert.equal(readBack.threadlist[0].hex(), '#8c1d2f');
  assert.equal(readBack.threadlist[1].hex(), '#e8a13d');
  assert.equal(readBack.threadlist[2].hex(), '#2f6f6a');

  const a = stats(normalized);
  const b = stats(readBack);
  assert.equal(b.stitches, a.stitches);
  assert.equal(b.colorChanges, a.colorChanges);
  assertBoundsClose(readBack.bounds(), normalized.bounds());
});

test('cabeçalho XXX tem contagens e marcador de fim corretos', () => {
  const original = buildRosacea();
  const buf = io.writeBuffer(original, 'xxx');
  assert.equal(buf.readUInt16LE(0x27), 3, 'número de cores em 0x27');
  const endOfStitches = buf.readUInt32LE(0xfc);
  assert.equal(buf[endOfStitches], 0x7f);
  assert.equal(buf[endOfStitches + 1], 0x7f);
  assert.equal(buf[endOfStitches + 2], 0x02);
  assert.equal(buf[endOfStitches + 3], 0x14);
  const declaredCommands = buf.readUInt32LE(0x17);
  const normalized = original.getNormalizedPattern({ max_jump: 124, max_stitch: 124, round: true });
  assert.equal(declaredCommands, normalized.stitches.length - 1);
});

test('roundtrip DST preserva geometria e respeita limite de 121', () => {
  const original = buildRosacea();
  const normalized = original.getNormalizedPattern({
    max_jump: 121,
    max_stitch: 121,
    round: true,
    sequin_contingency: C.CONTINGENCY_SEQUIN_UTILIZE,
  });
  const buf = io.writeBuffer(original, 'dst');
  const readBack = io.readBuffer(buf, 'dst');

  assert.equal(readBack.getMetadata('name'), 'ROSACEA');
  const a = stats(normalized);
  const b = stats(readBack);
  assert.equal(b.stitches, a.stitches);
  assert.equal(b.colorChanges, a.colorChanges);
  assert.ok(maxDelta(readBack) <= 121);
  assertBoundsClose(readBack.bounds(), normalized.bounds());
});

test('roundtrip EXP preserva geometria', () => {
  const original = buildRosacea();
  const normalized = original.getNormalizedPattern({
    max_jump: 127,
    max_stitch: 127,
    round: true,
    full_jump: true,
    sequin_contingency: C.CONTINGENCY_SEQUIN_JUMP,
  });
  const buf = io.writeBuffer(original, 'exp');
  const readBack = io.readBuffer(buf, 'exp');
  const a = stats(normalized);
  const b = stats(readBack);
  assert.equal(b.stitches, a.stitches);
  assert.equal(b.colorChanges, a.colorChanges);
  assertBoundsClose(readBack.bounds(), normalized.bounds());
});

test('pontos longos são divididos em saltos dentro do limite', () => {
  const original = buildLongStitchTest();
  for (const ext of ['xxx', 'dst', 'exp']) {
    const buf = io.writeBuffer(original, ext);
    const readBack = io.readBuffer(buf, ext);
    const limit = { xxx: 124, dst: 121, exp: 127 }[ext];
    assert.ok(maxDelta(readBack) <= limit, `${ext}: delta máximo ${maxDelta(readBack)}`);
    assertBoundsClose(readBack.bounds(), original.bounds(), 2);
  }
});

test('TRIM sobrevive à ida-e-volta em DST (wiggle de saltos + clipping)', () => {
  const { Pattern } = require('../src/core/pattern');
  const p = new Pattern();
  p.addThread({ color: 0x112233 });
  p.moveAbs(0, 0);
  p.stitchAbs(0, 0);
  p.stitchAbs(50, 0);
  p.trim();
  p.moveAbs(300, 300);
  p.stitchAbs(300, 300);
  p.stitchAbs(350, 300);
  p.end();
  const buf = io.writeBuffer(p, 'dst');
  const readBack = io.readBuffer(buf, 'dst');
  const s = stats(readBack);
  assert.ok(s.trims >= 1, 'esperava ao menos um TRIM reconstituído');
  assert.equal(s.stitches, 4);
});

test('SVG exporta polylines com as cores dos fios', () => {
  const original = buildRosacea();
  const svgText = io.writeBuffer(original, 'svg').toString('utf8');
  assert.match(svgText, /<svg /);
  assert.match(svgText, /#8c1d2f/);
  assert.match(svgText, /#e8a13d/);
  assert.match(svgText, /#2f6f6a/);
});

test('normalização insere COLOR_CHANGE e reconstroi a lista de fios', () => {
  const original = buildRosacea();
  const normalized = original.getNormalizedPattern({ round: true });
  assert.equal(normalized.threadlist.length, 3);
  assert.equal(stats(normalized).colorChanges, 2);
  const last = normalized.stitches[normalized.stitches.length - 1];
  assert.equal(last[2] & C.COMMAND_MASK, C.END);
});

// Fixtures geradas pelo pystitch de referência a partir de samples/rosacea.xxx.
// Os números abaixo foram conferidos contra a leitura do próprio pystitch.
const fs = require('node:fs');
const path = require('node:path');

test('lê PES de referência (Brother) com os mesmos números do pystitch', () => {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'rosacea.pes'));
  const p = io.readBuffer(buf, 'pes');
  const s = stats(p);
  assert.equal(s.stitches, 2253);
  assert.equal(s.jumps, 16);
  assert.equal(s.trims, 15);
  assert.equal(s.colorChanges, 2);
  assert.deepEqual(p.threadlist.map((t) => t.hex()), ['#c70156', '#fe9e32', '#4f5556']);
  assertBoundsClose(p.bounds(), [-495, -495, 495, 495], 0.5);
});

test('lê JEF de referência (Janome) com os mesmos números do pystitch', () => {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'rosacea.jef'));
  const p = io.readBuffer(buf, 'jef');
  const s = stats(p);
  assert.equal(s.stitches, 2253);
  assert.equal(s.jumps, 16);
  assert.equal(s.colorChanges, 2);
  assert.deepEqual(p.threadlist.map((t) => t.hex()), ['#970533', '#fcb257', '#386a91']);
  assertBoundsClose(p.bounds(), [-495, -495, 495, 495], 0.5);
});
