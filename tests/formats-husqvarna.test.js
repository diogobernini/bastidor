'use strict';
// Testes dos formatos portados na issue #18: VP3 (Husqvarna/Pfaff, leitura e
// gravação), HUS (Husqvarna, leitura), SEW (Janome, leitura) e PCS (Pfaff,
// leitura e gravação).
//
// As fixtures em tests/fixtures/{rosacea,multicolor}.{vp3,hus,sew,pcs} vêm de
// tools/pystitch-fixtures/ (ver esse diretório para como foram geradas: VP3 e
// SEW com os writers reais do pystitch; HUS com um codificador Huffman/LZ
// equivalente ao EmbCompress do pystitch, já que o pystitch só tem leitor
// para HUS; PCS com o NOSSO writer JS, já que o pystitch também não tem
// writer para PCS). Os valores abaixo (cores, contagens, bounds) foram
// conferidos rodando o pystitch de verdade sobre essas MESMAS fixtures —
// script de validação cruzada em tools/pystitch-fixtures/compare.js — então
// este arquivo não precisa de Python/pystitch para rodar (`npm test` puro).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const C = require('../src/core/commands');
const io = require('../src/core/io');
const { buildRosacea, buildMultiColorSample } = require('../tools/make-samples');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function readFixture(name) {
  const nodeFs = require('node:fs');
  return io.readBuffer(nodeFs.readFileSync(path.join(FIXTURES_DIR, name)), path.extname(name).slice(1));
}

function stats(pattern) {
  const s = { stitches: 0, jumps: 0, trims: 0, colorChanges: 0, total: pattern.stitches.length };
  for (const st of pattern.stitches) {
    const cmd = st[2] & C.COMMAND_MASK;
    if (cmd === C.STITCH) s.stitches++;
    else if (cmd === C.JUMP) s.jumps++;
    else if (cmd === C.TRIM) s.trims++;
    else if (cmd === C.COLOR_CHANGE) s.colorChanges++;
  }
  return s;
}

function assertBoundsClose(a, b, tolerance = 1.01) {
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(a[i] - b[i]) <= tolerance, `bounds[${i}]: ${a[i]} vs ${b[i]}`);
  }
}

// ------------------------------------------------------------- leitura

const EXPECTED = {
  'rosacea.vp3': {
    threads: ['#8c1d2f', '#e8a13d', '#2f6f6a'],
    bounds: [-495, -495, 495, 495],
    counts: { stitches: 2253, jumps: 2, trims: 1, colorChanges: 2, total: 2259 },
  },
  'rosacea.hus': {
    threads: ['#7b0000', '#ff9c5a', '#525252'],
    bounds: [-495, -495, 495, 495],
    counts: { stitches: 2253, jumps: 16, trims: 0, colorChanges: 2, total: 2272 },
  },
  'rosacea.sew': {
    threads: ['#a52a2a', '#ecb02c', '#386a91'],
    bounds: [-495, -495, 495, 495],
    counts: { stitches: 2253, jumps: 16, trims: 0, colorChanges: 2, total: 2272 },
  },
  'rosacea.pcs': {
    threads: ['#8c1d2f', '#e8a13d', '#2f6f6a'],
    bounds: [-495, -495, 495, 495],
    counts: { stitches: 2253, jumps: 16, trims: 0, colorChanges: 2, total: 2272 },
  },
  'multicolor.vp3': {
    threads: ['#d11f2c', '#1f9d55', '#1f5fd1', '#e8c200'],
    bounds: [-400, -400, 500, 560],
    counts: { stitches: 142, jumps: 3, trims: 4, colorChanges: 3, total: 153 },
  },
  'multicolor.hus': {
    threads: ['#ff0000', '#525252', '#0000e7', '#ffde00'],
    bounds: [-400, -400, 500, 560],
    counts: { stitches: 142, jumps: 27, trims: 3, colorChanges: 3, total: 176 },
  },
  'multicolor.sew': {
    threads: ['#e3311f', '#218a21', '#386cae', '#e1cb00'],
    bounds: [-400, -400, 500, 560],
    counts: { stitches: 142, jumps: 30, trims: 0, colorChanges: 3, total: 176 },
  },
  'multicolor.pcs': {
    threads: ['#d11f2c', '#1f9d55', '#1f5fd1', '#e8c200'],
    bounds: [-400, -400, 500, 560],
    counts: { stitches: 142, jumps: 12, trims: 0, colorChanges: 3, total: 158 },
  },
};

for (const [filename, expected] of Object.entries(EXPECTED)) {
  test(`leitura ${filename} bate com o pystitch de referência`, () => {
    const pattern = readFixture(filename);
    assert.deepEqual(
      pattern.threadlist.map((t) => (t ? t.hex() : null)),
      expected.threads,
    );
    assertBoundsClose(pattern.bounds(), expected.bounds);
    const s = stats(pattern);
    assert.equal(s.total, expected.counts.total);
    assert.equal(s.stitches, expected.counts.stitches);
    assert.equal(s.jumps, expected.counts.jumps);
    assert.equal(s.trims, expected.counts.trims);
    assert.equal(s.colorChanges, expected.counts.colorChanges);
  });
}

// ------------------------------------------------------------- VP3 roundtrip

test('roundtrip VP3 preserva geometria e cores exatas (rosácea)', () => {
  const original = buildRosacea();
  const normalized = original.getNormalizedPattern({
    max_jump: 3200,
    max_stitch: 255,
    round: true,
    full_jump: false,
    sequin_contingency: C.CONTINGENCY_SEQUIN_JUMP,
  });
  const buf = io.writeBuffer(original, 'vp3');
  const readBack = io.readBuffer(buf, 'vp3');

  // VP3 grava a cor em 24 bits cheios (sem paleta de fábrica): preserva exato.
  assert.deepEqual(readBack.threadlist.map((t) => t.hex()), ['#8c1d2f', '#e8a13d', '#2f6f6a']);
  const a = stats(normalized);
  const b = stats(readBack);
  assert.equal(b.total, a.total);
  assert.equal(b.colorChanges, a.colorChanges);
  assertBoundsClose(readBack.bounds(), normalized.bounds());
});

test('roundtrip VP3 preserva geometria (matriz multicolor, com saltos e cortes)', () => {
  const original = buildMultiColorSample();
  const buf = io.writeBuffer(original, 'vp3');
  const readBack = io.readBuffer(buf, 'vp3');
  assert.deepEqual(readBack.threadlist.map((t) => t.hex()), ['#d11f2c', '#1f9d55', '#1f5fd1', '#e8c200']);
  assertBoundsClose(readBack.bounds(), original.bounds());
  assert.equal(stats(readBack).colorChanges, 3);
});

// ------------------------------------------------------------- PCS roundtrip

test('roundtrip PCS preserva geometria e cores exatas (rosácea)', () => {
  const original = buildRosacea();
  const buf = io.writeBuffer(original, 'pcs');
  const readBack = io.readBuffer(buf, 'pcs');

  assert.deepEqual(readBack.threadlist.map((t) => t.hex()), ['#8c1d2f', '#e8a13d', '#2f6f6a']);
  assertBoundsClose(readBack.bounds(), original.bounds());
  assert.equal(stats(readBack).colorChanges, 2);
});

test('roundtrip PCS preserva geometria (matriz multicolor, com saltos e cortes)', () => {
  const original = buildMultiColorSample();
  const buf = io.writeBuffer(original, 'pcs');
  const readBack = io.readBuffer(buf, 'pcs');
  assert.deepEqual(readBack.threadlist.map((t) => t.hex()), ['#d11f2c', '#1f9d55', '#1f5fd1', '#e8c200']);
  assertBoundsClose(readBack.bounds(), original.bounds());
  assert.equal(stats(readBack).colorChanges, 3);
});

// ------------------------------------------------------------- registro

test('vp3, hus, sew e pcs aparecem no registro de formatos', () => {
  assert.ok(io.supportedReadExtensions().includes('vp3'));
  assert.ok(io.supportedReadExtensions().includes('hus'));
  assert.ok(io.supportedReadExtensions().includes('sew'));
  assert.ok(io.supportedReadExtensions().includes('pcs'));
  assert.ok(io.supportedWriteExtensions().includes('vp3'));
  assert.ok(io.supportedWriteExtensions().includes('pcs'));
  assert.ok(!io.supportedWriteExtensions().includes('hus'));
  assert.ok(!io.supportedWriteExtensions().includes('sew'));
});
