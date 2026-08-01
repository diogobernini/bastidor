'use strict';
// Testes do núcleo puro de mesclagem de blocos de cor adjacentes
// (src/core/colorblocks.js, issue #50): dado o painel de Cores da sidebar,
// funde o bloco de BAIXO no bloco de CIMA, mantendo a linha/config do de
// cima. A sequência de bordado não muda: só o COLOR_CHANGE entre os dois
// some e a entrada de thread do bloco de baixo é removida.

const test = require('node:test');
const assert = require('node:assert');

const ColorBlocks = require('../src/core/colorblocks');
const C = require('../src/core/commands');

// Mesma lógica de deriveBlocks() em src/renderer/renderer.js (não exportada
// dali por ser código de browser), reproduzida aqui só o suficiente pra
// verificar, depois de uma mesclagem, que o painel recalculado bate com o
// esperado (blocos = trechos entre COLOR_CHANGEs, thread por posição).
function deriveBlocks(stitches) {
  const blocks = [];
  let start = 0;
  let threadIndex = 0;
  for (let i = 0; i < stitches.length; i++) {
    if ((stitches[i][2] & C.COMMAND_MASK) === C.COLOR_CHANGE) {
      blocks.push({ threadIndex, start, end: i + 1 });
      threadIndex++;
      start = i + 1;
    }
  }
  if (start < stitches.length) blocks.push({ threadIndex, start, end: stitches.length });
  for (const b of blocks) {
    b.stitchCount = 0;
    for (let i = b.start; i < b.end; i++) {
      if ((stitches[i][2] & C.COMMAND_MASK) === C.STITCH) b.stitchCount++;
    }
  }
  return blocks;
}

// Matriz de 3 cores: 5 pontos, COLOR_CHANGE, 3 pontos, COLOR_CHANGE, 2 pontos.
function threeBlockDesign() {
  const stitches = [];
  for (let i = 0; i < 5; i++) stitches.push([i, i, C.STITCH]);
  stitches.push([5, 5, C.COLOR_CHANGE]);
  for (let i = 0; i < 3; i++) stitches.push([i, i, C.STITCH]);
  stitches.push([9, 9, C.COLOR_CHANGE]);
  for (let i = 0; i < 2; i++) stitches.push([i, i, C.STITCH]);
  const threads = [
    { color: '#c94f4f', description: 'Vermelho', catalog: '111' },
    { color: '#4f7dc9', description: 'Azul', catalog: '222' },
    { color: '#4fc98a', description: 'Verde', catalog: '333' },
  ];
  return { stitches, threads };
}

// ------------------------------------------------------------- deriveMergePlan

test('deriveMergePlan: devolve null para o primeiro bloco (sem bloco de cima)', () => {
  const { stitches } = threeBlockDesign();
  const blocks = deriveBlocks(stitches);
  assert.equal(ColorBlocks.deriveMergePlan(blocks, 0), null);
});

test('deriveMergePlan: devolve null para índice fora do array', () => {
  const { stitches } = threeBlockDesign();
  const blocks = deriveBlocks(stitches);
  assert.equal(ColorBlocks.deriveMergePlan(blocks, -1), null);
  assert.equal(ColorBlocks.deriveMergePlan(blocks, blocks.length), null);
  assert.equal(ColorBlocks.deriveMergePlan([], 0), null);
});

test('deriveMergePlan: aponta pro COLOR_CHANGE certo e pro threadIndex do bloco de baixo', () => {
  const { stitches } = threeBlockDesign();
  const blocks = deriveBlocks(stitches);
  const plan = ColorBlocks.deriveMergePlan(blocks, 1); // mescla bloco 1 (índice 1) no bloco 0
  assert.deepEqual(plan, { colorChangeIndex: 5, threadIndex: 1 });
  assert.equal(stitches[plan.colorChangeIndex][2] & C.COMMAND_MASK, C.COLOR_CHANGE);
});

test('deriveMergePlan: devolve null quando há um bloco vazio (0 pontos) escondido entre os dois', () => {
  // Duas COLOR_CHANGE seguidas: bloco do meio tem 0 pontos (deriveBlocks
  // real filtraria da lista visível, mas aqui simulamos que o chamador
  // pediu merge entre dois blocos que não são adjacentes na sequência).
  const stitches = [
    [0, 0, C.STITCH],
    [1, 1, C.COLOR_CHANGE],
    [2, 2, C.COLOR_CHANGE], // bloco do meio: 0 pontos
    [3, 3, C.STITCH],
  ];
  const blocks = deriveBlocks(stitches); // [{start:0,end:2}, {start:2,end:3}, {start:3,end:4}]
  // Bloco "visível" 0 (threadIndex 0) e bloco "visível" 2 (threadIndex 2) não
  // são adjacentes de verdade (upper.end=2 !== lower.start=3).
  const fakeVisible = [blocks[0], blocks[2]];
  assert.equal(ColorBlocks.deriveMergePlan(fakeVisible, 1), null);
});

// ------------------------------------------------------------------ mergeBlock

test('mergeBlock: remove o COLOR_CHANGE e a thread, contagem de pontos soma', () => {
  const { stitches, threads } = threeBlockDesign();
  const blocksBefore = deriveBlocks(stitches);
  const totalBefore = blocksBefore.reduce((sum, b) => sum + b.stitchCount, 0);

  const plan = ColorBlocks.deriveMergePlan(blocksBefore, 1);
  const removed = ColorBlocks.mergeBlock(stitches, threads, plan);

  assert.equal(removed.stitch[2] & C.COMMAND_MASK, C.COLOR_CHANGE, 'devolve o COLOR_CHANGE removido');
  assert.deepEqual(removed.thread, { color: '#4f7dc9', description: 'Azul', catalog: '222' });

  const blocksAfter = deriveBlocks(stitches);
  assert.equal(blocksAfter.length, 2, 'sobram 2 blocos (3 - 1 mesclado)');
  assert.equal(blocksAfter[0].stitchCount, 8, '5 + 3 pontos do bloco de cima e do mesclado');
  const totalAfter = blocksAfter.reduce((sum, b) => sum + b.stitchCount, 0);
  assert.equal(totalAfter, totalBefore, 'a soma total de pontos não muda');

  assert.equal(threads.length, 2, 'a thread do bloco de baixo foi removida');
  assert.equal(threads[0].description, 'Vermelho', 'mantém a thread do bloco de CIMA (não a de baixo)');
});

test('mergeBlock: encadeável (merge chains) — mescla os 3 blocos num só', () => {
  const { stitches, threads } = threeBlockDesign();

  let blocks = deriveBlocks(stitches);
  let plan = ColorBlocks.deriveMergePlan(blocks, 1);
  ColorBlocks.mergeBlock(stitches, threads, plan);

  blocks = deriveBlocks(stitches);
  plan = ColorBlocks.deriveMergePlan(blocks, 1);
  ColorBlocks.mergeBlock(stitches, threads, plan);

  blocks = deriveBlocks(stitches);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].stitchCount, 10, '5 + 3 + 2 pontos, tudo num bloco só');
  assert.equal(threads.length, 1);
  assert.equal(threads[0].description, 'Vermelho', 'o único fio restante é o do primeiro bloco original');
});

test('mergeBlock: lança erro se colorChangeIndex não aponta pra um COLOR_CHANGE', () => {
  const { stitches, threads } = threeBlockDesign();
  assert.throws(() => ColorBlocks.mergeBlock(stitches, threads, { colorChangeIndex: 0, threadIndex: 1 }));
});

test('mergeBlock: thread ausente (null) é preservado como null no valor removido', () => {
  const { stitches } = threeBlockDesign();
  const threads = [{ color: '#c94f4f' }, null, { color: '#4fc98a' }];
  const blocks = deriveBlocks(stitches);
  const plan = ColorBlocks.deriveMergePlan(blocks, 1);
  const removed = ColorBlocks.mergeBlock(stitches, threads, plan);
  assert.equal(removed.thread, null);
  assert.deepEqual(threads, [{ color: '#c94f4f' }, { color: '#4fc98a' }]);
});

// ------------------------------------------------------------------ splitBlock (undo)

test('splitBlock desfaz mergeBlock exatamente (round-trip)', () => {
  const { stitches, threads } = threeBlockDesign();
  const stitchesBefore = stitches.map((s) => s.slice());
  const threadsBefore = JSON.parse(JSON.stringify(threads));

  const blocks = deriveBlocks(stitches);
  const plan = ColorBlocks.deriveMergePlan(blocks, 1);
  const removed = ColorBlocks.mergeBlock(stitches, threads, plan);

  assert.notDeepEqual(stitches, stitchesBefore, 'a mesclagem realmente mudou os stitches');

  ColorBlocks.splitBlock(stitches, threads, plan, removed);
  assert.deepEqual(stitches, stitchesBefore, 'splitBlock restaura os stitches originais');
  assert.deepEqual(threads, threadsBefore, 'splitBlock restaura as threads originais');
});

test('merge -> split -> merge de novo dá o mesmo resultado (repetível)', () => {
  const { stitches, threads } = threeBlockDesign();
  const blocks = deriveBlocks(stitches);
  const plan = ColorBlocks.deriveMergePlan(blocks, 1);

  const removed1 = ColorBlocks.mergeBlock(stitches, threads, plan);
  const afterFirstMerge = { stitches: stitches.map((s) => s.slice()), threads: JSON.parse(JSON.stringify(threads)) };

  ColorBlocks.splitBlock(stitches, threads, plan, removed1);
  const removed2 = ColorBlocks.mergeBlock(stitches, threads, plan);

  assert.deepEqual(stitches, afterFirstMerge.stitches);
  assert.deepEqual(threads, afterFirstMerge.threads);
  assert.deepEqual(removed1, removed2);
});
