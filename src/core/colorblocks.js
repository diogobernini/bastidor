'use strict';
// Mesclagem de blocos de cor adjacentes (issue #50): dado o painel de Cores
// da sidebar (um bloco por trecho entre COLOR_CHANGEs), funde o bloco de
// BAIXO no bloco de CIMA, mantendo a linha/config do de cima. A sequência de
// bordado não muda: só o COLOR_CHANGE entre os dois somem (uma parada a
// menos pra trocar de linha), e a entrada de thread do bloco de baixo é
// removida. Mesmo espírito de src/core/library-view.js: módulo puro (sem
// DOM, sem Node), carregado tanto por <script src="../core/colorblocks.js">
// quanto por node:test via module.exports.

const ColorBlocks = (function () {
  const COMMAND_MASK = 0xff;
  const COLOR_CHANGE = 5;

  // Dado o array de blocos já derivado (deriveBlocks() no renderer: cada
  // item { threadIndex, start, end, stitchCount }, `end` exclusivo e
  // incluindo o próprio COLOR_CHANGE que fecha o bloco) e a posição do
  // bloco de BAIXO na lista, devolve o plano de mesclagem: o índice do
  // stitch COLOR_CHANGE a remover (sempre o último stitch do bloco de
  // cima) e o índice, em design.threads, do fio do bloco de baixo (o que
  // será removido). Devolve null quando não há bloco de cima (blockIndex
  // <= 0), a posição é inválida, ou os dois blocos não são realmente
  // adjacentes na sequência de agulhadas (haveria um bloco escondido de 0
  // pontos entre eles — deriveBlocks filtra blocos vazios da lista visível,
  // então merge por posição na lista visível pressupõe start/end contíguos).
  function deriveMergePlan(blocks, blockIndex) {
    if (!Array.isArray(blocks) || blockIndex <= 0 || blockIndex >= blocks.length) return null;
    const upper = blocks[blockIndex - 1];
    const lower = blocks[blockIndex];
    if (!upper || !lower || upper.end !== lower.start) return null;
    return { colorChangeIndex: upper.end - 1, threadIndex: lower.threadIndex };
  }

  // Aplica a mesclagem descrita por `plan`: remove o stitch COLOR_CHANGE e a
  // entrada de thread do bloco de baixo, MUTANDO os arrays recebidos (mesmo
  // padrão dos outros núcleos — quem chama decide se clona antes). Devolve o
  // que foi removido (clones independentes), para montar a operação de undo
  // barato (reinserir os dois na mesma posição).
  function mergeBlock(stitches, threads, plan) {
    const removedStitch = stitches[plan.colorChangeIndex];
    if (!removedStitch || (removedStitch[2] & COMMAND_MASK) !== COLOR_CHANGE) {
      throw new Error('ColorBlocks.mergeBlock: colorChangeIndex não aponta para um COLOR_CHANGE');
    }
    stitches.splice(plan.colorChangeIndex, 1);
    const removedThread = threads[plan.threadIndex] !== undefined ? threads[plan.threadIndex] : null;
    threads.splice(plan.threadIndex, 1);
    return {
      stitch: removedStitch.slice(),
      thread: removedThread ? JSON.parse(JSON.stringify(removedThread)) : null,
    };
  }

  // Inversa de mergeBlock: reinsere o stitch e a thread removidos nas
  // mesmas posições (undo). `removed` é o objeto devolvido por mergeBlock
  // (ou os campos equivalentes vindos do histórico).
  function splitBlock(stitches, threads, plan, removed) {
    stitches.splice(plan.colorChangeIndex, 0, removed.stitch.slice());
    threads.splice(plan.threadIndex, 0, removed.thread ? JSON.parse(JSON.stringify(removed.thread)) : null);
  }

  return { deriveMergePlan, mergeBlock, splitBlock };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ColorBlocks;
}
