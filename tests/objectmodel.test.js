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

// ============================================================= issue #29 fase 3

// --------------------------------------------------------------- rotatePoint/rotateSegment

test('rotatePoint: 90° ao redor da origem leva (10,0) a (0,10)', () => {
  const [x, y] = ObjectModel.rotatePoint(0, 0, 10, 0, Math.PI / 2);
  assert.ok(Math.abs(x - 0) < 1e-9, `x=${x}`);
  assert.ok(Math.abs(y - 10) < 1e-9, `y=${y}`);
});

test('rotatePoint: 180° ao redor de um pivô fora da origem inverte o ponto', () => {
  const [x, y] = ObjectModel.rotatePoint(50, 50, 60, 50, Math.PI);
  assert.ok(Math.abs(x - 40) < 1e-9, `x=${x}`);
  assert.ok(Math.abs(y - 50) < 1e-9, `y=${y}`);
});

test('rotatePoint: ângulo 0 devolve o mesmo ponto', () => {
  const [x, y] = ObjectModel.rotatePoint(3, 4, 17, -8, 0);
  assert.equal(x, 17);
  assert.equal(y, -8);
});

test('rotateSegment: gira todas as agulhadas ao redor do pivô e arredonda para inteiro, preserva o cmd', () => {
  const C = require('../src/core/commands');
  const stitches = [
    [10, 0, C.STITCH],
    [0, 0, C.JUMP],
  ];
  const out = ObjectModel.rotateSegment(stitches, 0, 0, Math.PI / 2);
  assert.deepStrictEqual(out[0], [0, 10, C.STITCH]);
  assert.deepStrictEqual(out[1], [0, 0, C.JUMP]);
  assert.notEqual(out, stitches, 'devolve um array novo');
});

test('rotateSegment: ângulo 0 devolve cópia (não a mesma referência), mesmos valores', () => {
  const stitches = [[5, 5, 0]];
  const out = ObjectModel.rotateSegment(stitches, 0, 0, 0);
  assert.deepStrictEqual(out, stitches);
  assert.notEqual(out[0], stitches[0]);
});

// --------------------------------------------------------------------- snapAngleDeg/normalizeAngleDeg

test('snapAngleDeg: arredonda para o múltiplo de 15° mais próximo', () => {
  assert.equal(ObjectModel.snapAngleDeg(7, 15), 0);
  assert.equal(ObjectModel.snapAngleDeg(8, 15), 15);
  assert.equal(ObjectModel.snapAngleDeg(-8, 15), -15);
  assert.equal(ObjectModel.snapAngleDeg(22, 15), 15);
  assert.equal(ObjectModel.snapAngleDeg(23, 15), 30);
});

test('snapAngleDeg: passo <= 0 devolve o ângulo intacto (guarda desligada)', () => {
  assert.equal(ObjectModel.snapAngleDeg(37.4, 0), 37.4);
  assert.equal(ObjectModel.snapAngleDeg(37.4, -5), 37.4);
});

test('normalizeAngleDeg: sempre devolve algo em [0, 360)', () => {
  assert.equal(ObjectModel.normalizeAngleDeg(370), 10);
  assert.equal(ObjectModel.normalizeAngleDeg(-10), 350);
  assert.equal(ObjectModel.normalizeAngleDeg(0), 0);
  assert.equal(ObjectModel.normalizeAngleDeg(360), 0);
});

// -------------------------------------------------------------------- unionBBoxes

test('unionBBoxes: bbox conjunta de várias unidades', () => {
  const out = ObjectModel.unionBBoxes([
    { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    { minX: -5, minY: 20, maxX: 3, maxY: 25 },
  ]);
  assert.deepStrictEqual(out, { minX: -5, minY: 0, maxX: 10, maxY: 25 });
});

test('unionBBoxes: ignora entradas nulas, devolve null se tudo nulo/vazio', () => {
  assert.deepStrictEqual(
    ObjectModel.unionBBoxes([null, { minX: 1, minY: 1, maxX: 2, maxY: 2 }, null]),
    { minX: 1, minY: 1, maxX: 2, maxY: 2 }
  );
  assert.equal(ObjectModel.unionBBoxes([null, null]), null);
  assert.equal(ObjectModel.unionBBoxes([]), null);
});

// --------------------------------------------------------------- alignOffsetX/Y

test('alignOffsetX: left/center/right relativo à bbox conjunta', () => {
  const target = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const bbox = { minX: 20, minY: 0, maxX: 40, maxY: 10 }; // largura 20
  assert.equal(ObjectModel.alignOffsetX(bbox, target, 'left'), -20);
  assert.equal(ObjectModel.alignOffsetX(bbox, target, 'right'), 60);
  assert.equal(ObjectModel.alignOffsetX(bbox, target, 'center'), 20); // centro bbox=30 -> centro alvo=50
  assert.equal(ObjectModel.alignOffsetX(bbox, target, 'bogus'), 0);
});

test('alignOffsetY: top/middle/bottom relativo à bbox conjunta', () => {
  const target = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const bbox = { minX: 0, minY: 20, maxX: 10, maxY: 40 };
  assert.equal(ObjectModel.alignOffsetY(bbox, target, 'top'), -20);
  assert.equal(ObjectModel.alignOffsetY(bbox, target, 'bottom'), 60);
  assert.equal(ObjectModel.alignOffsetY(bbox, target, 'middle'), 20);
});

// -------------------------------------------------------------------- distributeOffsets

test('distributeOffsets: com menos de 3 unidades devolve deslocamento zero', () => {
  const bboxes = [{ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { minX: 50, minY: 0, maxX: 60, maxY: 10 }];
  assert.deepStrictEqual(ObjectModel.distributeOffsets(bboxes, 'x'), [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
});

test('distributeOffsets: 3 unidades no eixo x, a do meio (fora de ordem na entrada) vai para o centro exato', () => {
  // centros na ordem de ENTRADA: 5, 95, 40; ordenados por posição: 5, 40, 95.
  // Alvo do centro para a unidade do meio: exatamente entre as âncoras
  // (5 e 95) = 50 -> delta = 50 - 40 = 10.
  const bboxes = [
    { minX: 0, minY: 0, maxX: 10, maxY: 10 }, // centro 5
    { minX: 90, minY: 0, maxX: 100, maxY: 10 }, // centro 95
    { minX: 35, minY: 0, maxX: 45, maxY: 10 }, // centro 40
  ];
  const out = ObjectModel.distributeOffsets(bboxes, 'x');
  assert.equal(out[0].dx, 0, 'âncora esquerda não se move');
  assert.equal(out[1].dx, 0, 'âncora direita não se move');
  assert.ok(Math.abs(out[2].dx - 10) < 1e-9, `dx=${out[2].dx}`);
  assert.equal(out[0].dy, 0);
  assert.equal(out[2].dy, 0);
});

test('distributeOffsets: eixo y distribui verticalmente', () => {
  const bboxes = [
    { minX: 0, minY: 0, maxX: 10, maxY: 10 }, // centro y 5
    { minX: 0, minY: 90, maxX: 10, maxY: 100 }, // centro y 95
    { minX: 0, minY: 20, maxX: 10, maxY: 30 }, // centro y 25
  ];
  const out = ObjectModel.distributeOffsets(bboxes, 'y');
  assert.ok(Math.abs(out[2].dy - 25) < 1e-9, `dy=${out[2].dy}`); // vai para 50: 50-25=25
  assert.equal(out[2].dx, 0);
});

// ------------------------------------------------------- normalizeObjects/listUnits/swapUnits

test('normalizeObjects: design totalmente solto (sem objects) ganha 1 STITCH_BLOCK por bloco', () => {
  const blocks = [block(0, 5), block(5, 9)];
  const out = ObjectModel.normalizeObjects([], blocks);
  assert.equal(out.length, 2);
  for (const o of out) {
    assert.equal(o.type, ObjectModel.TYPES.STITCH_BLOCK);
    assert.equal(o.source, null);
    assert.equal(o.blockCount, 1);
  }
});

test('normalizeObjects: idempotente quando objects já cobre tudo', () => {
  const blocks = [block(0, 5), block(5, 9)];
  const objects = [ObjectModel.makeObject('text', {}, {}, 2)];
  const out = ObjectModel.normalizeObjects(objects, blocks);
  assert.equal(out.length, 1);
  assert.equal(out[0], objects[0]);
});

test('normalizeObjects: preenche só a lacuna depois do que já está coberto', () => {
  const blocks = [block(0, 5), block(5, 9), block(9, 14)];
  const objects = [ObjectModel.makeObject('text', {}, {}, 1)]; // cobre só blocks[0]
  const out = ObjectModel.normalizeObjects(objects, blocks);
  assert.equal(out.length, 3);
  assert.equal(out[0], objects[0]);
  assert.equal(out[1].type, ObjectModel.TYPES.STITCH_BLOCK);
  assert.equal(out[2].type, ObjectModel.TYPES.STITCH_BLOCK);
});

test('listUnits: cobre blocks por inteiro (objetos + soltos), na ordem de bordado', () => {
  const blocks = [block(0, 5), block(5, 9), block(9, 14)];
  const objects = [ObjectModel.makeObject('svg-shape', {}, {}, 2)];
  const units = ObjectModel.listUnits(objects, blocks);
  assert.equal(units.length, 2);
  assert.equal(units[0].object, objects[0]);
  assert.equal(units[1].object, null);
  assert.deepStrictEqual({ start: units[1].start, end: units[1].end }, { start: 9, end: 14 });
});

function makeStitchesFor(blocks, colorAt) {
  // Constrói um array de agulhadas mínimo consistente com `blocks`: um
  // STITCH marcador por bloco (posição = índice do bloco, só para
  // identificar de qual bloco veio depois de trocar) seguido de
  // COLOR_CHANGE (exceto no último bloco).
  const C = require('../src/core/commands');
  const out = [];
  blocks.forEach((b, i) => {
    out.push([i, i, C.STITCH]);
    if (i < blocks.length - 1) out.push([i, i, C.COLOR_CHANGE]);
  });
  return out;
}

test('swapUnits: troca dois blocos soltos adjacentes (agulhadas + threads), objects fica normalizado', () => {
  const blocks = [block(0, 2), block(2, 4), block(4, 5)];
  const stitches = makeStitchesFor(blocks);
  const threads = [{ color: '#111111' }, { color: '#222222' }, { color: '#333333' }];
  const result = ObjectModel.swapUnits([], blocks, stitches, threads, 0);
  assert.ok(result);
  assert.equal(result.objects.length, 3);
  // bloco 0 (marcador x=0) e bloco 1 (marcador x=1) trocaram de posição
  assert.equal(result.stitches[0][0], 1, 'primeiro trecho agora é o que era o bloco 1');
  assert.equal(result.threads[0].color, '#222222');
  assert.equal(result.threads[1].color, '#111111');
  // total de agulhadas não muda
  assert.equal(result.stitches.length, stitches.length);
});

test('swapUnits: troca um bloco solto com um objeto paramétrico adjacente (cruza a fronteira)', () => {
  // 2 blocos: o primeiro (não-último) contribui 2 agulhadas (STITCH +
  // COLOR_CHANGE) e o segundo (último) só 1 (STITCH), espelhando
  // makeStitchesFor — ver ali.
  const blocks = [block(0, 2), block(2, 3)];
  const stitches = makeStitchesFor(blocks);
  const threads = [{ color: '#aaaaaa' }, { color: '#bbbbbb' }];
  const objects = [ObjectModel.makeObject('text', { text: 'A' }, { heightMm: 10 }, 1)]; // cobre só blocks[0]
  const result = ObjectModel.swapUnits(objects, blocks, stitches, threads, 0);
  assert.ok(result);
  assert.equal(result.objects.length, 2);
  // depois da troca, o objeto de texto (antes na posição 0) deve estar na posição 1
  assert.equal(result.objects[1].type, 'text');
  assert.equal(result.objects[0].type, ObjectModel.TYPES.STITCH_BLOCK);
  assert.equal(result.stitches[0][0], 1, 'o bloco solto (marcador x=1) foi para o início');
});

test('swapUnits: índice fora do intervalo devolve null', () => {
  const blocks = [block(0, 2)];
  const stitches = makeStitchesFor(blocks);
  assert.equal(ObjectModel.swapUnits([], blocks, stitches, [{}], 0), null); // só 1 unidade, sem vizinho
  assert.equal(ObjectModel.swapUnits([], blocks, stitches, [{}], -1), null);
});

// -------------------------------------------------------------------------- cloneObject

test('cloneObject: clone profundo independente do original', () => {
  const original = ObjectModel.makeObject('text', { text: 'ABC', fontId: 'f1' }, { heightMm: 12 }, 1);
  original.transform.rotation = 33;
  const clone = ObjectModel.cloneObject(original);
  assert.deepStrictEqual(clone.source, original.source);
  assert.deepStrictEqual(clone.stitchParams, original.stitchParams);
  assert.equal(clone.transform.rotation, 33);
  assert.equal(clone.blockCount, 1);
  clone.source.text = 'ZZZ';
  clone.transform.rotation = 99;
  assert.equal(original.source.text, 'ABC', 'mutar o clone não deveria afetar o original');
  assert.equal(original.transform.rotation, 33);
});

test('cloneObject: source/stitchParams nulos (ex.: STITCH_BLOCK) permanecem nulos', () => {
  const original = ObjectModel.makeObject(ObjectModel.TYPES.STITCH_BLOCK, null, null, 1);
  const clone = ObjectModel.cloneObject(original);
  assert.equal(clone.source, null);
  assert.equal(clone.stitchParams, null);
});
