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

// ======================================================================
// Reordenar blocos de cor adjacentes (issue #61)
// ======================================================================

// Mesma matriz de 3 cores de threeBlockDesign(), mas com um JUMP e um TRIM
// dentro do bloco do meio (para conferir que a sequência interna de um
// bloco sobrevive intacta a uma troca, não só a contagem de pontos).
function threeBlockDesignWithJumpsAndTrims() {
  const stitches = [];
  for (let i = 0; i < 5; i++) stitches.push([i, i, C.STITCH]); // bloco 0 (thread 0): 5 pontos
  stitches.push([5, 5, C.COLOR_CHANGE]);
  stitches.push([6, 6, C.JUMP]); // bloco 1 (thread 1): salto, corte, 3 pontos
  stitches.push([6, 6, C.TRIM]);
  for (let i = 0; i < 3; i++) stitches.push([10 + i, 10 + i, C.STITCH]);
  stitches.push([20, 20, C.COLOR_CHANGE]);
  for (let i = 0; i < 2; i++) stitches.push([i, i, C.STITCH]); // bloco 2 (thread 2, último: sem CC de fechamento): 2 pontos
  const threads = [
    { color: '#c94f4f', description: 'Vermelho', catalog: '111' },
    { color: '#4f7dc9', description: 'Azul', catalog: '222' },
    { color: '#4fc98a', description: 'Verde', catalog: '333' },
  ];
  return { stitches, threads };
}

function totalStitchCount(blocks) {
  return blocks.reduce((sum, b) => sum + b.stitchCount, 0);
}

function totalColorChanges(stitches) {
  return stitches.filter((s) => (s[2] & C.COMMAND_MASK) === C.COLOR_CHANGE).length;
}

// ------------------------------------------------------------- deriveSwapPlan

test('deriveSwapPlan: null para índice fora do array (topo, fundo, array vazio)', () => {
  const { stitches } = threeBlockDesign();
  const blocks = deriveBlocks(stitches);
  assert.equal(ColorBlocks.deriveSwapPlan(blocks, -1), null);
  assert.equal(ColorBlocks.deriveSwapPlan(blocks, blocks.length - 1), null, 'não há bloco seguinte pro último');
  assert.equal(ColorBlocks.deriveSwapPlan(blocks, blocks.length), null);
  assert.equal(ColorBlocks.deriveSwapPlan([], 0), null);
});

test('deriveSwapPlan: aponta pros limites certos dos dois blocos e seus threadIndex', () => {
  const { stitches } = threeBlockDesign();
  const blocks = deriveBlocks(stitches);
  const plan = ColorBlocks.deriveSwapPlan(blocks, 0);
  assert.deepEqual(plan, {
    upperStart: 0,
    upperEnd: 6,
    lowerStart: 6,
    lowerEnd: 10,
    upperThreadIndex: 0,
    lowerThreadIndex: 1,
  });
});

test('deriveSwapPlan: null quando há um bloco vazio (0 pontos) escondido entre os dois', () => {
  const stitches = [
    [0, 0, C.STITCH],
    [1, 1, C.COLOR_CHANGE],
    [2, 2, C.COLOR_CHANGE], // bloco do meio: 0 pontos
    [3, 3, C.STITCH],
  ];
  const blocks = deriveBlocks(stitches); // [{start:0,end:2}, {start:2,end:3}, {start:3,end:4}]
  const fakeVisible = [blocks[0], blocks[2]]; // upper.end=2 !== lower.start=3
  assert.equal(ColorBlocks.deriveSwapPlan(fakeVisible, 0), null);
});

// --------------------------------------------------------- swapAdjacentBlocks

test('swapAdjacentBlocks: troca dois blocos do meio (nenhum é o último), sequência interna e contagens intactas', () => {
  const { stitches, threads } = threeBlockDesignWithJumpsAndTrims();
  const blocksBefore = deriveBlocks(stitches);
  const totalBefore = totalStitchCount(blocksBefore);
  const ccBefore = totalColorChanges(stitches);

  const ok = ColorBlocks.swapAdjacentBlocks(stitches, threads, blocksBefore, 0); // troca bloco 0 com bloco 1
  assert.equal(ok, true);

  const blocksAfter = deriveBlocks(stitches);
  assert.equal(blocksAfter.length, 3, 'nenhum bloco sumiu ou surgiu');
  assert.equal(totalStitchCount(blocksAfter), totalBefore, 'total de pontos conservado');
  assert.equal(totalColorChanges(stitches), ccBefore, 'número de COLOR_CHANGEs conservado');

  // Novo bloco 0 é o antigo bloco 1 (salto, corte, 3 pontos), com sua
  // sequência interna intacta (só a posição mudou).
  assert.equal(blocksAfter[0].stitchCount, 3);
  const b0 = stitches.slice(blocksAfter[0].start, blocksAfter[0].end);
  assert.equal(b0[0][2] & C.COMMAND_MASK, C.JUMP);
  assert.equal(b0[1][2] & C.COMMAND_MASK, C.TRIM);
  assert.equal(b0[2][2] & C.COMMAND_MASK, C.STITCH);
  assert.equal(b0[3][2] & C.COMMAND_MASK, C.STITCH);
  assert.equal(b0[4][2] & C.COMMAND_MASK, C.STITCH);
  assert.equal(b0[5][2] & C.COMMAND_MASK, C.COLOR_CHANGE, 'fecha com um COLOR_CHANGE');

  // Novo bloco 1 é o antigo bloco 0 (5 pontos simples), também fechado com CC.
  assert.equal(blocksAfter[1].stitchCount, 5);
  const b1 = stitches.slice(blocksAfter[1].start, blocksAfter[1].end);
  assert.equal(b1.length, 6);
  for (let i = 0; i < 5; i++) assert.equal(b1[i][2] & C.COMMAND_MASK, C.STITCH);
  assert.equal(b1[5][2] & C.COMMAND_MASK, C.COLOR_CHANGE);

  // Bloco 2 (último, sem CC de fechamento) não foi tocado.
  assert.equal(blocksAfter[2].stitchCount, 2);
  assert.equal(blocksAfter[2].end, stitches.length);
  assert.equal(stitches[stitches.length - 1][2] & C.COMMAND_MASK, C.STITCH);

  // Threads acompanham os blocos: posição 0 agora tem a linha que era da
  // posição 1 (Azul), e vice-versa.
  assert.equal(threads[0].description, 'Azul');
  assert.equal(threads[1].description, 'Vermelho');
  assert.equal(threads[2].description, 'Verde', 'thread do bloco não envolvido na troca fica parada');
});

test('swapAdjacentBlocks: troca o penúltimo bloco com o último (borda do COLOR_CHANGE de fechamento)', () => {
  const { stitches, threads } = threeBlockDesignWithJumpsAndTrims();
  const blocksBefore = deriveBlocks(stitches);
  const totalBefore = totalStitchCount(blocksBefore);
  const ccBefore = totalColorChanges(stitches);
  assert.equal(blocksBefore.length, 3);
  assert.equal(hasClosingCC(stitches, blocksBefore[2]), false, 'pré-condição: último bloco não tem CC de fechamento');

  const ok = ColorBlocks.swapAdjacentBlocks(stitches, threads, blocksBefore, 1); // troca bloco 1 (penúltimo) com bloco 2 (último)
  assert.equal(ok, true);

  const blocksAfter = deriveBlocks(stitches);
  assert.equal(blocksAfter.length, 3);
  assert.equal(totalStitchCount(blocksAfter), totalBefore, 'total de pontos conservado');
  assert.equal(totalColorChanges(stitches), ccBefore, 'número de COLOR_CHANGEs conservado (só troca de posição)');

  // O que passa a ser o último (antigo bloco 1: salto+corte+3 pontos) PERDE
  // o fechamento — vira mesmo o último bloco, sem CC.
  assert.equal(blocksAfter[2].stitchCount, 3);
  assert.equal(blocksAfter[2].end, stitches.length, 'é de fato o último bloco da lista');
  assert.equal(hasClosingCC(stitches, blocksAfter[2]), false);
  const lastBlock = stitches.slice(blocksAfter[2].start, blocksAfter[2].end);
  assert.equal(lastBlock.length, 5, 'salto + corte + 3 pontos, sem CC extra');
  assert.equal(lastBlock[0][2] & C.COMMAND_MASK, C.JUMP);
  assert.equal(lastBlock[1][2] & C.COMMAND_MASK, C.TRIM);

  // O que sai da última posição (antigo bloco 2: 2 pontos) GANHA um
  // COLOR_CHANGE de fechamento (o que era do antigo bloco 1).
  assert.equal(blocksAfter[1].stitchCount, 2);
  assert.equal(hasClosingCC(stitches, blocksAfter[1]), true);

  // Threads acompanham: posição 1 agora é Verde (era do bloco 2), posição 2
  // agora é Azul (era do bloco 1).
  assert.equal(threads[1].description, 'Verde');
  assert.equal(threads[2].description, 'Azul');
  assert.equal(threads[0].description, 'Vermelho', 'bloco não envolvido fica parado');
});

test('swapAdjacentBlocks: desenho com só 2 blocos (o "de cima" é o primeiro e o "de baixo" é o último)', () => {
  const stitches = [
    [0, 0, C.STITCH],
    [1, 1, C.STITCH],
    [2, 2, C.COLOR_CHANGE],
    [3, 3, C.STITCH],
    [4, 4, C.STITCH],
    [5, 5, C.STITCH],
  ];
  const threads = [{ color: '#111' }, { color: '#222' }];
  const blocksBefore = deriveBlocks(stitches);
  assert.equal(blocksBefore.length, 2);

  const ok = ColorBlocks.swapAdjacentBlocks(stitches, threads, blocksBefore, 0);
  assert.equal(ok, true);

  const blocksAfter = deriveBlocks(stitches);
  assert.equal(blocksAfter.length, 2);
  assert.equal(blocksAfter[0].stitchCount, 3, 'o bloco de 3 pontos (antigo último) vem primeiro agora');
  assert.equal(blocksAfter[1].stitchCount, 2, 'o bloco de 2 pontos (antigo primeiro) vira o último');
  assert.equal(hasClosingCC(stitches, blocksAfter[0]), true);
  assert.equal(hasClosingCC(stitches, blocksAfter[1]), false, 'novo último não tem CC de fechamento');
  assert.equal(threads[0].color, '#222');
  assert.equal(threads[1].color, '#111');
});

test('swapAdjacentBlocks: posição inválida (fora dos limites) não muta nada e devolve false', () => {
  const { stitches, threads } = threeBlockDesign();
  const stitchesBefore = stitches.map((s) => s.slice());
  const threadsBefore = JSON.parse(JSON.stringify(threads));
  const blocks = deriveBlocks(stitches);

  assert.equal(ColorBlocks.swapAdjacentBlocks(stitches, threads, blocks, -1), false);
  assert.equal(ColorBlocks.swapAdjacentBlocks(stitches, threads, blocks, blocks.length - 1), false, 'não há bloco seguinte pro último');
  assert.deepEqual(stitches, stitchesBefore);
  assert.deepEqual(threads, threadsBefore);
});

test('swapAdjacentBlocks: repetível — trocar de novo (com blocks recém derivado) desfaz exatamente', () => {
  const { stitches, threads } = threeBlockDesignWithJumpsAndTrims();
  const stitchesOriginal = stitches.map((s) => s.slice());
  const threadsOriginal = JSON.parse(JSON.stringify(threads));

  let blocks = deriveBlocks(stitches);
  ColorBlocks.swapAdjacentBlocks(stitches, threads, blocks, 1); // troca o penúltimo com o último (a borda mais delicada)
  assert.notDeepEqual(stitches, stitchesOriginal, 'a troca realmente mudou os stitches');

  blocks = deriveBlocks(stitches); // re-deriva a partir do resultado, como o renderer faz
  ColorBlocks.swapAdjacentBlocks(stitches, threads, blocks, 1); // mesma posição: troca nos devolve ao início

  assert.deepEqual(stitches, stitchesOriginal, 'a segunda troca restaura os stitches originais');
  assert.deepEqual(threads, threadsOriginal, 'a segunda troca restaura as threads originais');
});

test('swapAdjacentBlocks: primeiro bloco (upperIndex 0) troca corretamente quando não é o último par', () => {
  const { stitches, threads } = threeBlockDesignWithJumpsAndTrims();
  const blocks = deriveBlocks(stitches);
  const ok = ColorBlocks.swapAdjacentBlocks(stitches, threads, blocks, 0);
  assert.equal(ok, true);
  const blocksAfter = deriveBlocks(stitches);
  assert.equal(blocksAfter[0].threadIndex, 0);
  assert.equal(threads[0].description, 'Azul', 'bloco 0 agora sedia o conteúdo (e a cor) do antigo bloco 1');
});

// Todo design de verdade (arquivo aberto ou gerado por texto/SVG) termina
// com um stitch END de verdade (confirmado abrindo samples/rosacea.xxx: o
// último stitch é sempre cmd=END) — as fixtures acima não tinham um só
// pra manter os testes de borda focados no COLOR_CHANGE. Este bloco cobre
// especificamente o END: sem o cuidado extra em hasClosingMarker/swapBlocks,
// trocar o penúltimo bloco com o último relocaria o END pro MEIO do array
// (preso ao antigo último bloco, que deixa de ser o último) e um
// COLOR_CHANGE sobraria como o stitch final do arquivo inteiro — os dois
// corrompendo qualquer leitura/exportação futura.
function threeBlockDesignEndingInEND() {
  const stitches = [];
  for (let i = 0; i < 5; i++) stitches.push([i, i, C.STITCH]); // bloco 0: 5 pontos
  stitches.push([5, 5, C.COLOR_CHANGE]);
  for (let i = 0; i < 3; i++) stitches.push([i, i, C.STITCH]); // bloco 1: 3 pontos
  stitches.push([9, 9, C.COLOR_CHANGE]);
  for (let i = 0; i < 2; i++) stitches.push([i, i, C.STITCH]); // bloco 2 (último): 2 pontos
  stitches.push([1, 1, C.END]); // fim de verdade do desenho
  const threads = [{ color: '#c94f4f' }, { color: '#4f7dc9' }, { color: '#4fc98a' }];
  return { stitches, threads };
}

test('swapAdjacentBlocks: troca o penúltimo com o último quando o último termina em END (não em COLOR_CHANGE)', () => {
  const { stitches, threads } = threeBlockDesignEndingInEND();
  const blocksBefore = deriveBlocks(stitches);
  const totalBefore = totalStitchCount(blocksBefore);

  const ok = ColorBlocks.swapAdjacentBlocks(stitches, threads, blocksBefore, 1); // troca bloco 1 (penúltimo) com bloco 2 (último)
  assert.equal(ok, true);

  // O END não pode sobrar no meio: o ÚLTIMO stitch do array inteiro precisa
  // continuar sendo o END (relocado junto com o bloco 2, que sai da última
  // posição), nunca um COLOR_CHANGE.
  assert.equal(stitches[stitches.length - 1][2] & C.COMMAND_MASK, C.END, 'o END continua sendo o último stitch do arquivo, não fica preso no meio');
  assert.equal(
    stitches.filter((s) => (s[2] & C.COMMAND_MASK) === C.END).length,
    1,
    'exatamente 1 END no array inteiro (não duplicou nem sumiu)'
  );

  const blocksAfter = deriveBlocks(stitches);
  assert.equal(blocksAfter.length, 3, 'nenhum bloco sumiu ou surgiu');
  assert.equal(totalStitchCount(blocksAfter), totalBefore, 'total de pontos conservado (END contado como 1 "ponto" de comando, mas não stitch de fato)');

  // O que passa a ser o último (antigo bloco 1, 3 pontos) herda o END.
  assert.equal(blocksAfter[2].stitchCount, 3);
  assert.equal(blocksAfter[2].end, stitches.length);

  // O que sai da última posição (antigo bloco 2, 2 pontos) ganha um
  // COLOR_CHANGE de fechamento (não o END, que foi embora com ele).
  assert.equal(blocksAfter[1].stitchCount, 2);
  assert.equal(hasClosingCC(stitches, blocksAfter[1]), true);
});

test('swapAdjacentBlocks + END: repetível — trocar de novo restaura o desenho original, END incluído', () => {
  const { stitches, threads } = threeBlockDesignEndingInEND();
  const stitchesOriginal = stitches.map((s) => s.slice());
  const threadsOriginal = JSON.parse(JSON.stringify(threads));

  let blocks = deriveBlocks(stitches);
  ColorBlocks.swapAdjacentBlocks(stitches, threads, blocks, 1);
  assert.notDeepEqual(stitches, stitchesOriginal);

  blocks = deriveBlocks(stitches);
  ColorBlocks.swapAdjacentBlocks(stitches, threads, blocks, 1);

  assert.deepEqual(stitches, stitchesOriginal, 'restaura os stitches originais, com o END de volta no fim');
  assert.deepEqual(threads, threadsOriginal);
});

// Confere especificamente um fechamento por COLOR_CHANGE (não por END) —
// versão restrita de isClosingStitch/hasClosingMarker (privadas em
// ColorBlocks), o suficiente pra verificar as bordas nos testes acima sem
// expor as funções internas.
function hasClosingCC(stitches, block) {
  if (block.end <= block.start) return false;
  return (stitches[block.end - 1][2] & C.COMMAND_MASK) === C.COLOR_CHANGE;
}

// ======================================================================
// Aplicar uma ordem paramétrica (issue #73)
// ======================================================================
//
// applyColorOrder generaliza swapBlocks (uma troca só, 2 blocos) pra uma
// permutação ARBITRÁRIA dos blocos de UM objeto — usada por
// src/renderer/objects.js pra reaplicar object.params.colorOrder na saída
// fresca do gerador a cada regeneração paramétrica (resize).

// Matriz de 2 cores terminando em END de verdade (mesmo cuidado das
// fixtures de swapAdjacentBlocks: o desenho real sempre termina assim).
function twoBlockDesignEndingInEND() {
  const stitches = [
    [0, 0, C.STITCH],
    [1, 1, C.STITCH],
    [2, 2, C.COLOR_CHANGE],
    [3, 3, C.STITCH],
    [4, 4, C.STITCH],
    [5, 5, C.STITCH],
    [5, 5, C.END],
  ];
  const threads = [{ color: '#111' }, { color: '#222' }];
  return { stitches, threads };
}

// ------------------------------------------------------------- identidade

test('applyColorOrder: order ausente (undefined/null) devolve stitches/threads equivalentes, sem mutar nada (no-op)', () => {
  const { stitches, threads } = threeBlockDesign();
  const blocks = deriveBlocks(stitches);

  const r1 = ColorBlocks.applyColorOrder(stitches, threads, blocks, undefined);
  assert.deepEqual(r1.stitches, stitches);
  assert.deepEqual(r1.threads, threads);

  const r2 = ColorBlocks.applyColorOrder(stitches, threads, blocks, null);
  assert.deepEqual(r2.stitches, stitches);
  assert.deepEqual(r2.threads, threads);
});

test('applyColorOrder: order igual à identidade [0,1,2] devolve stitches/threads equivalentes (byte a byte)', () => {
  const { stitches, threads } = threeBlockDesign();
  const stitchesBefore = stitches.map((s) => s.slice());
  const threadsBefore = JSON.parse(JSON.stringify(threads));
  const blocks = deriveBlocks(stitches);

  const result = ColorBlocks.applyColorOrder(stitches, threads, blocks, [0, 1, 2]);
  assert.deepEqual(result.stitches, stitchesBefore);
  assert.deepEqual(result.threads, threadsBefore);

  // Não mutou os originais (helper puro).
  assert.deepEqual(stitches, stitchesBefore);
  assert.deepEqual(threads, threadsBefore);
});

test('applyColorOrder: um bloco só (n=1) é sempre identidade, nunca lança', () => {
  const stitches = [[0, 0, C.STITCH], [1, 1, C.END]];
  const threads = [{ color: '#123' }];
  const blocks = deriveBlocks(stitches);
  const result = ColorBlocks.applyColorOrder(stitches, threads, blocks, [0]);
  assert.deepEqual(result.stitches, stitches);
  assert.deepEqual(result.threads, threads);
});

test('applyColorOrder: nenhum bloco (blocks vazio) devolve cópias vazias, sem lançar', () => {
  const result = ColorBlocks.applyColorOrder([], [], [], [0]);
  assert.deepEqual(result.stitches, []);
  assert.deepEqual(result.threads, []);
});

// -------------------------------------------------------------- não muta

test('applyColorOrder: não muta stitches/threads recebidos, mesmo numa permutação de verdade (helper puro)', () => {
  const { stitches, threads } = threeBlockDesign();
  const stitchesBefore = stitches.map((s) => s.slice());
  const threadsBefore = JSON.parse(JSON.stringify(threads));
  const blocks = deriveBlocks(stitches);

  ColorBlocks.applyColorOrder(stitches, threads, blocks, [2, 0, 1]);

  assert.deepEqual(stitches, stitchesBefore, 'stitches originais intactos');
  assert.deepEqual(threads, threadsBefore, 'threads originais intactos');
});

// --------------------------------------------------------- troca simples

test('applyColorOrder: troca simples [1,0] em 2 blocos bate com swapAdjacentBlocks, END preservado', () => {
  const { stitches: sA, threads: tA } = twoBlockDesignEndingInEND();
  const blocksA = deriveBlocks(sA);
  const resultA = ColorBlocks.applyColorOrder(sA, tA, blocksA, [1, 0]);

  const { stitches: sB, threads: tB } = twoBlockDesignEndingInEND();
  const blocksB = deriveBlocks(sB);
  ColorBlocks.swapAdjacentBlocks(sB, tB, blocksB, 0);

  assert.deepEqual(resultA.stitches, sB, 'aplicar [1,0] de uma vez bate com swapAdjacentBlocks(upperIndex=0)');
  assert.deepEqual(resultA.threads, tB);
  assert.equal(resultA.stitches[resultA.stitches.length - 1][2] & C.COMMAND_MASK, C.END, 'END continua sendo o último stitch');
  assert.equal(
    resultA.stitches.filter((s) => (s[2] & C.COMMAND_MASK) === C.END).length,
    1,
    'exatamente 1 END no array inteiro'
  );
});

// -------------------------------------------------------- permutação de 3

test('applyColorOrder: permutação de 3 blocos [2,1,0] bate com a composição de 3 trocas adjacentes (threads/stitches coerentes)', () => {
  const { stitches: stitchesA, threads: threadsA } = threeBlockDesignWithJumpsAndTrims();
  const blocksA = deriveBlocks(stitchesA);
  const resultA = ColorBlocks.applyColorOrder(stitchesA, threadsA, blocksA, [2, 1, 0]);

  // (0,1,2) -swap(1)-> (0,2,1) -swap(0)-> (2,0,1) -swap(1)-> (2,1,0): a
  // mesma permutação final, por composição da primitiva já testada acima.
  const { stitches: stitchesB, threads: threadsB } = threeBlockDesignWithJumpsAndTrims();
  let blocksB = deriveBlocks(stitchesB);
  ColorBlocks.swapAdjacentBlocks(stitchesB, threadsB, blocksB, 1);
  blocksB = deriveBlocks(stitchesB);
  ColorBlocks.swapAdjacentBlocks(stitchesB, threadsB, blocksB, 0);
  blocksB = deriveBlocks(stitchesB);
  ColorBlocks.swapAdjacentBlocks(stitchesB, threadsB, blocksB, 1);

  assert.deepEqual(resultA.stitches, stitchesB, 'aplicar a permutação de uma vez bate com a composição de trocas adjacentes');
  assert.deepEqual(resultA.threads, threadsB);

  // Prova independente: bloco 0 do resultado é o antigo bloco 2 (Verde, 2
  // pontos simples); bloco 2 do resultado é o antigo bloco 0 (Vermelho,
  // salto+corte+3 pontos).
  const blocksAfter = deriveBlocks(resultA.stitches);
  assert.equal(blocksAfter.length, 3);
  assert.equal(resultA.threads[0].description, 'Verde');
  assert.equal(resultA.threads[1].description, 'Azul', 'bloco do meio não envolvido na permutação (posição 1 -> original 1)');
  assert.equal(resultA.threads[2].description, 'Vermelho');
  const totalAfter = blocksAfter.reduce((sum, b) => sum + b.stitchCount, 0);
  const totalBefore = deriveBlocks(threeBlockDesignWithJumpsAndTrims().stitches).reduce((sum, b) => sum + b.stitchCount, 0);
  assert.equal(totalAfter, totalBefore, 'total de pontos conservado');
});

// ------------------------------------------------------------- END preservado

test('applyColorOrder: permutação de 3 que move o bloco com END pra fora da última posição — END sempre no fim de verdade', () => {
  const { stitches, threads } = threeBlockDesignEndingInEND(); // bloco 2 (último) fecha com END
  const blocks = deriveBlocks(stitches);
  const totalBefore = blocks.reduce((sum, b) => sum + b.stitchCount, 0);

  // order=[2,0,1]: o bloco 2 (o que tinha o END) vira o PRIMEIRO da nova
  // sequência — nada mais no fim, então precisa ganhar um COLOR_CHANGE; o
  // bloco 1 vira o último e herda o END de verdade.
  const result = ColorBlocks.applyColorOrder(stitches, threads, blocks, [2, 0, 1]);

  assert.equal(
    result.stitches[result.stitches.length - 1][2] & C.COMMAND_MASK,
    C.END,
    'o END continua sendo o último stitch do arquivo, não fica preso no meio'
  );
  assert.equal(result.stitches.filter((s) => (s[2] & C.COMMAND_MASK) === C.END).length, 1, 'exatamente 1 END no array inteiro');

  const blocksAfter = deriveBlocks(result.stitches);
  assert.equal(blocksAfter.length, 3, 'nenhum bloco sumiu ou surgiu');
  const totalAfter = blocksAfter.reduce((sum, b) => sum + b.stitchCount, 0);
  assert.equal(totalAfter, totalBefore, 'total de pontos conservado');

  // bloco 0 do resultado = antigo bloco 2 (2 pontos) + CC (perdeu o END, virou não-último).
  assert.equal(blocksAfter[0].stitchCount, 2);
  assert.equal(hasClosingCC(result.stitches, blocksAfter[0]), true);
  // bloco 1 do resultado = antigo bloco 0 (5 pontos) + CC.
  assert.equal(blocksAfter[1].stitchCount, 5);
  assert.equal(hasClosingCC(result.stitches, blocksAfter[1]), true);
  // bloco 2 do resultado (novo último) = antigo bloco 1 (3 pontos) + END.
  assert.equal(blocksAfter[2].stitchCount, 3);
  assert.equal(blocksAfter[2].end, result.stitches.length);

  // threads acompanham a nova ordem (posição i -> threadIndex do bloco original order[i]).
  assert.equal(result.threads[0].color, '#4fc98a'); // era o bloco 2 (Verde)
  assert.equal(result.threads[1].color, '#c94f4f'); // era o bloco 0 (Vermelho)
  assert.equal(result.threads[2].color, '#4f7dc9'); // era o bloco 1 (Azul)
});

// -------------------------------------------------------------- validação

test('applyColorOrder: order malformado (tamanho errado, duplicado, fora do intervalo) lança erro', () => {
  const { stitches, threads } = threeBlockDesign();
  const blocks = deriveBlocks(stitches);
  assert.throws(() => ColorBlocks.applyColorOrder(stitches, threads, blocks, [0, 1]), 'tamanho errado (2 num design de 3)');
  assert.throws(() => ColorBlocks.applyColorOrder(stitches, threads, blocks, [0, 0, 1]), 'índice duplicado');
  assert.throws(() => ColorBlocks.applyColorOrder(stitches, threads, blocks, [0, 1, 3]), 'índice fora do intervalo');
  assert.throws(() => ColorBlocks.applyColorOrder(stitches, threads, blocks, [0, 1, -1]), 'índice negativo');
});
