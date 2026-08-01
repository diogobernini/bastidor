'use strict';
// Testes da geometria pura do modo de seleção de objetos (issue #29, fase 1):
// bbox, posição das 8 alças, fator de redimensionamento (proporcional vs.
// livre/Alt) e hit-test das alças. A parte de DOM (gestos de ponteiro,
// desenho do overlay) não é exercitada aqui — só o que roda sem window/document.

const test = require('node:test');
const assert = require('node:assert');

const {
  computeBBox,
  handlePoint,
  resizeFactors,
  hitHandle,
  HANDLES,
  OPPOSITE,
  rotateHandleScreenPoint,
  hitRotateHandle,
  bboxIntersects,
  stripTrailingEnd,
} = require('../src/renderer/objects');
const C = require('../src/core/commands');

// ------------------------------------------------------------------ computeBBox

test('computeBBox: ignora TRIM/STOP/troca de cor, considera STITCH/JUMP/SEQUIN_EJECT', () => {
  const stitches = [
    [0, 0, C.JUMP],
    [100, 50, C.STITCH],
    [-20, 80, C.STITCH],
    [9999, 9999, C.COLOR_CHANGE], // fora dos limites reais: não deveria contar
    [30, -10, C.SEQUIN_EJECT],
  ];
  assert.deepStrictEqual(computeBBox(stitches, 0, stitches.length), { minX: -20, minY: -10, maxX: 100, maxY: 80 });
});

test('computeBBox: respeita o intervalo [start, end)', () => {
  const stitches = [[0, 0, C.STITCH], [500, 500, C.STITCH], [10, 10, C.STITCH]];
  assert.deepStrictEqual(computeBBox(stitches, 0, 1), { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  assert.deepStrictEqual(computeBBox(stitches, 2, 3), { minX: 10, minY: 10, maxX: 10, maxY: 10 });
});

test('computeBBox: devolve null quando não há pontos com coordenada relevante', () => {
  const stitches = [[0, 0, C.TRIM], [0, 0, C.STOP]];
  assert.equal(computeBBox(stitches, 0, stitches.length), null);
  assert.equal(computeBBox([], 0, 0), null);
});

// ------------------------------------------------------------------- handlePoint

test('handlePoint: cantos e meios-de-borda de um bbox conhecido', () => {
  const bbox = { minX: 0, minY: 0, maxX: 100, maxY: 40 };
  assert.deepStrictEqual(handlePoint(bbox, 'nw'), [0, 0]);
  assert.deepStrictEqual(handlePoint(bbox, 'ne'), [100, 0]);
  assert.deepStrictEqual(handlePoint(bbox, 'se'), [100, 40]);
  assert.deepStrictEqual(handlePoint(bbox, 'sw'), [0, 40]);
  assert.deepStrictEqual(handlePoint(bbox, 'n'), [50, 0]);
  assert.deepStrictEqual(handlePoint(bbox, 's'), [50, 40]);
  assert.deepStrictEqual(handlePoint(bbox, 'e'), [100, 20]);
  assert.deepStrictEqual(handlePoint(bbox, 'w'), [0, 20]);
});

test('HANDLES/OPPOSITE: as 8 alças e cada uma tem a oposta correta', () => {
  assert.equal(HANDLES.length, 8);
  for (const name of HANDLES) {
    assert.equal(OPPOSITE[OPPOSITE[name]], name, `oposta da oposta de ${name} deveria ser ${name}`);
  }
  assert.equal(OPPOSITE.nw, 'se');
  assert.equal(OPPOSITE.n, 's');
  assert.equal(OPPOSITE.e, 'w');
});

// ---------------------------------------------------------------- resizeFactors

test('resizeFactors: alça de canto, proporcional, dobrando a distância ao pivô', () => {
  const pivot = [0, 0];
  const handleStart = [100, 100];
  const cur = [200, 200]; // mesma direção, 2x a distância
  const [sx, sy] = resizeFactors(pivot, handleStart, cur, false);
  assert.ok(Math.abs(sx - 2) < 1e-6);
  assert.equal(sx, sy, 'proporcional: os dois eixos usam o mesmo fator');
});

test('resizeFactors: alça de borda (e), proporcional, reduz à razão do próprio eixo', () => {
  const pivot = [0, 50];
  const handleStart = [100, 50]; // alça "e": vetor pivô->alça é só horizontal
  const cur = [50, 999]; // deslocamento vertical não deveria importar
  const [sx, sy] = resizeFactors(pivot, handleStart, cur, false);
  assert.ok(Math.abs(sx - 0.5) < 1e-6, `sx=${sx} deveria ser ~0,5`);
  assert.equal(sx, sy, 'proporcional: mesmo fator nos dois eixos mesmo vindo de uma alça de borda');
});

test('resizeFactors: livre (Alt) em alça de canto escala os eixos de forma independente', () => {
  const pivot = [0, 0];
  const handleStart = [100, 50];
  const cur = [50, 150]; // sx=0,5 ; sy=3
  const [sx, sy] = resizeFactors(pivot, handleStart, cur, true);
  assert.ok(Math.abs(sx - 0.5) < 1e-6);
  assert.ok(Math.abs(sy - 3) < 1e-6);
});

test('resizeFactors: livre (Alt) em alça de borda (n) mantém o eixo perpendicular em 1', () => {
  const pivot = [50, 0];
  const handleStart = [50, 100]; // alça "n": vetor pivô->alça é só vertical
  const cur = [999, 25]; // deslocamento horizontal não deveria mexer no eixo x
  const [sx, sy] = resizeFactors(pivot, handleStart, cur, true);
  assert.equal(sx, 1, 'eixo sem vetor original fica fixo em 1');
  assert.ok(Math.abs(sy - 0.25) < 1e-6);
});

test('resizeFactors: nunca deixa o fator colapsar a zero ou inverter pelo pivô', () => {
  const pivot = [0, 0];
  const handleStart = [100, 0];
  const [sxCollapse] = resizeFactors(pivot, handleStart, [0, 0], false);
  assert.ok(sxCollapse >= 0.05, `fator ${sxCollapse} deveria ter uma trava mínima positiva`);
  const [sxFlip] = resizeFactors(pivot, handleStart, [-100, 0], false);
  assert.ok(sxFlip <= -0.05, `fator ${sxFlip} deveria ter uma trava mínima negativa (nunca perto de 0)`);
});

// -------------------------------------------------------------------- hitHandle

test('hitHandle: acerta a alça dentro da tolerância e erra fora dela', () => {
  const bbox = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const identityToScreen = (x, y) => [x, y]; // sem pan/zoom: coords do desenho = coords de tela
  assert.equal(hitHandle(bbox, 100, 100, identityToScreen), 'se');
  assert.equal(hitHandle(bbox, 103, 100, identityToScreen), 'se', 'deveria tolerar alguns pixels de erro');
  assert.equal(hitHandle(bbox, 50, 100, identityToScreen), 's');
  assert.equal(hitHandle(bbox, 50, 50, identityToScreen), null, 'centro do bbox não é nenhuma alça');
});

// ============================================================= issue #29 fase 3

// ------------------------------------------------------- rotateHandleScreenPoint/hitRotateHandle

test('rotateHandleScreenPoint: fica acima da alça "n", mesma coordenada x', () => {
  const bbox = { minX: 0, minY: 0, maxX: 100, maxY: 40 };
  const identityToScreen = (x, y) => [x, y];
  const [rx, ry] = rotateHandleScreenPoint(bbox, identityToScreen);
  assert.equal(rx, 50); // meio de x, igual à alça "n"
  assert.ok(ry < 0, `ry=${ry} deveria estar acima de y=0 (a alça "n")`);
});

test('hitRotateHandle: acerta perto do ponto da alça de rotação e erra longe', () => {
  const bbox = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const identityToScreen = (x, y) => [x, y];
  const [rx, ry] = rotateHandleScreenPoint(bbox, identityToScreen);
  assert.equal(hitRotateHandle(bbox, rx, ry, identityToScreen), true);
  assert.equal(hitRotateHandle(bbox, rx + 2, ry, identityToScreen), true, 'tolerância de alguns pixels');
  assert.equal(hitRotateHandle(bbox, rx, ry - 40, identityToScreen), false);
  assert.equal(hitRotateHandle(bbox, 50, 50, identityToScreen), false, 'centro do bbox não é a alça de rotação');
});

// -------------------------------------------------------------------- bboxIntersects

test('bboxIntersects: bboxes que se sobrepõem, que só se tocam na borda, e que não se tocam', () => {
  const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  assert.equal(bboxIntersects(a, { minX: 5, minY: 5, maxX: 15, maxY: 15 }), true, 'sobreposição parcial');
  assert.equal(bboxIntersects(a, { minX: 10, minY: 10, maxX: 20, maxY: 20 }), true, 'só tocam na borda/canto');
  assert.equal(bboxIntersects(a, { minX: 11, minY: 0, maxX: 20, maxY: 10 }), false, 'separados no eixo x');
  assert.equal(bboxIntersects(a, { minX: 0, minY: 11, maxX: 10, maxY: 20 }), false, 'separados no eixo y');
});

// -------------------------------------------------------------------- stripTrailingEnd

test('stripTrailingEnd: remove um C.END no fim do trecho (valor correto: 4, não 5/COLOR_CHANGE)', () => {
  const stitches = [[0, 0, C.STITCH], [10, 10, C.STITCH], [10, 10, C.END]];
  const out = stripTrailingEnd(stitches);
  assert.equal(out.length, 2);
  assert.deepStrictEqual(out, [[0, 0, C.STITCH], [10, 10, C.STITCH]]);
});

test('stripTrailingEnd: não mexe em COLOR_CHANGE no fim (é um comando diferente de END)', () => {
  const stitches = [[0, 0, C.STITCH], [10, 10, C.COLOR_CHANGE]];
  const out = stripTrailingEnd(stitches);
  assert.equal(out.length, 2, 'COLOR_CHANGE no fim não deveria ser removido por stripTrailingEnd');
});

test('stripTrailingEnd: sem END no fim, devolve o array intacto', () => {
  const stitches = [[0, 0, C.STITCH], [10, 10, C.STITCH]];
  assert.equal(stripTrailingEnd(stitches), stitches);
});

test('stripTrailingEnd: array vazio não quebra', () => {
  assert.deepStrictEqual(stripTrailingEnd([]), []);
});
