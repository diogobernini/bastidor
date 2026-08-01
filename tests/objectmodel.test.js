'use strict';
// Testes do modelo de objetos paramétricos (issue #29, fase 2): sincronia de
// faixas de bloco/objeto, alinhamento de bbox e cálculo dos parâmetros de
// regeneração por tipo. Tudo puro (sem DOM) — ver src/core/objectmodel.js.

const test = require('node:test');
const assert = require('node:assert');

const ObjectModel = require('../src/core/objectmodel');

function block(start, end) {
  return { start, end, stitchCount: end - start };
}

// -------------------------------------------------------- assignObjectRanges / findUnit

test('assignObjectRanges: um objeto de 1 bloco depois de outro de 2 blocos', () => {
  const blocks = [block(0, 5), block(5, 9), block(9, 14)];
  const objects = [
    ObjectModel.makeObject('svg-shape', {}, {}, 2), // ocupa blocks[0] e blocks[1]
    ObjectModel.makeObject('text', {}, {}, 1), // ocupa blocks[2]
  ];
  const assigned = ObjectModel.assignObjectRanges(objects, blocks);
  assert.equal(assigned.length, 2);
  assert.deepStrictEqual(
    { blockStart: assigned[0].blockStart, blockEnd: assigned[0].blockEnd, start: assigned[0].start, end: assigned[0].end },
    { blockStart: 0, blockEnd: 2, start: 0, end: 9 }
  );
  assert.deepStrictEqual(
    { blockStart: assigned[1].blockStart, blockEnd: assigned[1].blockEnd, start: assigned[1].start, end: assigned[1].end },
    { blockStart: 2, blockEnd: 3, start: 9, end: 14 }
  );
});

test('assignObjectRanges: pára de sincronizar quando um objeto não cabe mais (contagem de blocos mudou por fora)', () => {
  const blocks = [block(0, 5)]; // só sobrou 1 bloco
  const objects = [
    ObjectModel.makeObject('svg-shape', {}, {}, 2), // pedia 2, não cabe mais
    ObjectModel.makeObject('text', {}, {}, 1),
  ];
  const assigned = ObjectModel.assignObjectRanges(objects, blocks);
  assert.equal(assigned.length, 0, 'nenhum objeto sincroniza depois do primeiro que não coube');
});

test('findUnit: bloco pertencente a um objeto multi-bloco devolve a faixa inteira do objeto', () => {
  const blocks = [block(0, 5), block(5, 9), block(9, 14)];
  const objects = [ObjectModel.makeObject('raster-trace', {}, {}, 2), ObjectModel.makeObject('text', {}, {}, 1)];
  const unit = ObjectModel.findUnit(objects, blocks, 1); // segundo bloco do primeiro objeto
  assert.equal(unit.object, objects[0]);
  assert.equal(unit.start, 0);
  assert.equal(unit.end, 9);
});

test('findUnit: bloco sem objeto associado devolve unidade "solta" (comportamento de fase 1)', () => {
  const blocks = [block(0, 5), block(5, 9)];
  const unit = ObjectModel.findUnit([], blocks, 1);
  assert.equal(unit.object, null);
  assert.deepStrictEqual({ start: unit.start, end: unit.end }, { start: 5, end: 9 });
});

test('findUnit: índice de bloco inexistente devolve null', () => {
  assert.equal(ObjectModel.findUnit([], [block(0, 5)], 3), null);
});

// -------------------------------------------------------------------- transformBBox

test('transformBBox: escala proporcional 2x a partir do pivô (0,0)', () => {
  const bbox = { minX: 0, minY: 0, maxX: 10, maxY: 20 };
  const out = ObjectModel.transformBBox(bbox, { scaleX: 2, scaleY: 2, pivot: [0, 0], dx: 0, dy: 0 });
  assert.deepStrictEqual(out, { minX: 0, minY: 0, maxX: 20, maxY: 40 });
});

test('transformBBox: encolher a partir de um pivô fora da origem, mais deslocamento', () => {
  const bbox = { minX: 100, minY: 100, maxX: 200, maxY: 140 };
  const out = ObjectModel.transformBBox(bbox, { scaleX: 0.5, scaleY: 0.5, pivot: [100, 100], dx: 5, dy: -5 });
  assert.deepStrictEqual(out, { minX: 105, minY: 95, maxX: 155, maxY: 115 });
});

// ---------------------------------------------------------------- centerAlignOffset

test('centerAlignOffset: alinha o centro de um bbox de origem ao centro do bbox-alvo', () => {
  const source = { minX: -5, minY: -5, maxX: 5, maxY: 5 }; // centro (0,0)
  const target = { minX: 90, minY: 190, maxX: 110, maxY: 210 }; // centro (100,200)
  assert.deepStrictEqual(ObjectModel.centerAlignOffset(source, target), [100, 200]);
});

// --------------------------------------------------------------------- canRegenerate

test('canRegenerate: verdadeiro só em redimensionamento proporcional e com mudança real de tamanho', () => {
  assert.equal(ObjectModel.canRegenerate({ scaleX: 1.5, scaleY: 1.5 }), true);
  assert.equal(ObjectModel.canRegenerate({ scaleX: 1, scaleY: 1 }), false, 'fator 1 = sem mudança, nada a regenerar');
  assert.equal(ObjectModel.canRegenerate({ scaleX: 1.5, scaleY: 0.8 }), false, 'livre (Alt): eixos diferentes');
  assert.equal(ObjectModel.canRegenerate(null), false);
});

// ------------------------------------------------------------- parâmetros por tipo

test('resizedTextParams: só heightMm muda pelo fator, resto do stitchParams intacto', () => {
  const params = { heightMm: 10, stitchLengthMm: 2, satinWidthMm: 2, finish: 'satin' };
  const out = ObjectModel.resizedTextParams(params, 1.5);
  assert.equal(out.heightMm, 15);
  assert.equal(out.stitchLengthMm, 2, 'comprimento de ponto fica igual (mesma densidade)');
  assert.equal(out.satinWidthMm, 2);
  assert.equal(out.finish, 'satin');
});

test('resizedSvgParams: só targetWidthMm muda, fillSpacingMm intacto', () => {
  const params = { targetWidthMm: 80, fillSpacingMm: 0.4, fillStitchMm: 3 };
  const out = ObjectModel.resizedSvgParams(params, 0.5);
  assert.equal(out.targetWidthMm, 40);
  assert.equal(out.fillSpacingMm, 0.4);
});

test('resizedRasterParams: só widthMm muda, tolerância/cores intactas', () => {
  const params = { widthMm: 80, toleranceMm: 0.3, colors: 4 };
  const out = ObjectModel.resizedRasterParams(params, 2);
  assert.equal(out.widthMm, 160);
  assert.equal(out.toleranceMm, 0.3);
  assert.equal(out.colors, 4);
});

test('rasterOptsFromParams: recalcula scale/simplifyTol a partir da largura em px da imagem', () => {
  const params = { widthMm: 80, toleranceMm: 0.3, colors: 4, stitchLenMm: 2.5, outline: true, fill: true, fillSpacingMm: 0.4, fillAngleDeg: 0, fillStitchMm: 3 };
  const opts = ObjectModel.rasterOptsFromParams(params, 256);
  assert.ok(Math.abs(opts.scale - (80 * 10) / 256) < 1e-9);
  assert.ok(Math.abs(opts.simplifyTol - (0.3 * 256) / 80) < 1e-9);
  assert.equal(opts.colors, 4);
});

test('makeObject: blockCount nunca fica abaixo de 1, mesmo se pedido 0 ou negativo', () => {
  assert.equal(ObjectModel.makeObject('text', null, null, 0).blockCount, 1);
  assert.equal(ObjectModel.makeObject('text', null, null, -3).blockCount, 1);
  assert.equal(ObjectModel.makeObject('text', null, null, 2).blockCount, 2);
});
