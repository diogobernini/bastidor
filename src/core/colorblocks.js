'use strict';
// Núcleo puro do painel de Cores da sidebar (um bloco por trecho entre
// COLOR_CHANGEs). Duas famílias de operação:
//  - Mesclagem de blocos adjacentes (issue #50): funde o bloco de BAIXO no
//    bloco de CIMA, mantendo a linha/config do de cima. A sequência de
//    bordado não muda: só o COLOR_CHANGE entre os dois some (uma parada a
//    menos pra trocar de linha), e a entrada de thread do bloco de baixo é
//    removida.
//  - Reordenar blocos adjacentes (issue #61): troca a ordem de bordado
//    entre dois blocos vizinhos (subir/descer no painel), realocando o
//    COLOR_CHANGE de fechamento correto nas bordas — ver swapBlocks.
// Mesmo espírito de src/core/library-view.js: módulo puro (sem DOM, sem
// Node), carregado tanto por <script src="../core/colorblocks.js"> quanto
// por node:test via module.exports. Pensado para ser compartilhado também
// pelo painel de sew-order de objetos da fase 3 da issue #29 (reordena
// unidades em vez de blocos, mas a primitiva de troca adjacente é a mesma).

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

  // ------------------------------------------------- reordenar (issue #61)
  //
  // Troca a ordem de bordado entre dois blocos ADJACENTES na lista de
  // blocos: o de CIMA (upperIndex) e o de BAIXO (upperIndex + 1). A
  // sequência de agulhadas DENTRO de cada bloco não muda — só a posição dos
  // dois trechos (e das threads correspondentes) é invertida. Subir/descer
  // um bloco no painel de Cores vira uma troca adjacente: "subir" o bloco
  // `bi` é swap(bi - 1); "descer" é swap(bi).
  //
  // Dado o array de blocos (mesmo formato de deriveMergePlan) e a posição
  // do bloco de CIMA, devolve o plano de troca com os limites (em índice de
  // stitches) dos dois blocos e seus threadIndex. null quando a posição é
  // inválida (não sobra um par de blocos ali) ou quando os dois blocos não
  // são realmente adjacentes na sequência de agulhadas (bloco escondido de
  // 0 pontos entre eles — mesmo cuidado de deriveMergePlan).
  function deriveSwapPlan(blocks, upperIndex) {
    if (!Array.isArray(blocks) || upperIndex < 0 || upperIndex >= blocks.length - 1) return null;
    const upper = blocks[upperIndex];
    const lower = blocks[upperIndex + 1];
    if (!upper || !lower || upper.end !== lower.start) return null;
    return {
      upperStart: upper.start,
      upperEnd: upper.end,
      lowerStart: lower.start,
      lowerEnd: lower.end,
      upperThreadIndex: upper.threadIndex,
      lowerThreadIndex: lower.threadIndex,
    };
  }

  // Confere se o último stitch do intervalo [start, end) é um COLOR_CHANGE
  // (fecha o bloco). O ÚLTIMO bloco da lista normalmente NÃO tem esse
  // fechamento (ver comentário de deriveBlocks() no renderer): é a "sobra"
  // depois do último COLOR_CHANGE de verdade do arquivo, terminando em
  // END/TRIM/etc. em vez de COLOR_CHANGE.
  function hasClosingColorChange(stitches, start, end) {
    if (end <= start) return false;
    const last = stitches[end - 1];
    return !!last && (last[2] & COMMAND_MASK) === COLOR_CHANGE;
  }

  // Aplica a troca descrita por `plan` (de deriveSwapPlan), MUTANDO stitches
  // e threads (mesmo padrão de mergeBlock: quem chama decide se clona
  // antes). `blocks` sempre garante que o de CIMA tem um COLOR_CHANGE de
  // fechamento (só o ÚLTIMO bloco da lista não tem, e o de cima nunca é o
  // último aqui). O de BAIXO pode ou não ter (tem, a menos que seja o
  // último bloco do desenho).
  //
  // Ideia: cada bloco tem um "conteúdo puro" (agulhadas sem o COLOR_CHANGE
  // de fechamento, quando ele existe). A troca reaproveita o COLOR_CHANGE
  // do bloco de CIMA como a nova fronteira entre os dois (agora o conteúdo
  // de baixo vem primeiro), e só sobra um COLOR_CHANGE de fechamento no
  // final se o bloco de BAIXO original já tinha um (ou seja, se ele não era
  // o último bloco do desenho). Isso resolve a borda do enunciado: ao
  // trocar o penúltimo bloco com o último, o que passa a ser o último
  // (antigo de cima) perde o fechamento, e o que sai da última posição
  // (antigo de baixo) ganha o fechamento que era do antigo de cima. A
  // troca é sua própria inversa: aplicá-la de novo com `blocks` recém
  // derivado do resultado devolve exatamente o estado original.
  function swapBlocks(stitches, threads, plan) {
    const ccUpperIdx = plan.upperEnd - 1;
    const ccUpper = stitches[ccUpperIdx];
    if (!ccUpper || (ccUpper[2] & COMMAND_MASK) !== COLOR_CHANGE) {
      throw new Error('ColorBlocks.swapBlocks: bloco de cima sem COLOR_CHANGE de fechamento');
    }
    const lowerHasCC = hasClosingColorChange(stitches, plan.lowerStart, plan.lowerEnd);
    const pureUpper = stitches.slice(plan.upperStart, ccUpperIdx);
    const lowerContentEnd = lowerHasCC ? plan.lowerEnd - 1 : plan.lowerEnd;
    const pureLower = stitches.slice(plan.lowerStart, lowerContentEnd);
    const ccLower = lowerHasCC ? stitches[plan.lowerEnd - 1] : null;

    const newSegment = pureLower.map((s) => s.slice());
    newSegment.push(ccUpper.slice());
    for (const s of pureUpper) newSegment.push(s.slice());
    if (ccLower) newSegment.push(ccLower.slice());

    stitches.splice(plan.upperStart, plan.lowerEnd - plan.upperStart, ...newSegment);

    // As linhas acompanham a posição (threadIndex de um bloco == sua
    // posição na lista, ver deriveBlocks): trocar o conteúdo exige trocar
    // as threads também, senão a cor visual fica presa na posição errada.
    const tmp = threads[plan.upperThreadIndex];
    threads[plan.upperThreadIndex] = threads[plan.lowerThreadIndex];
    threads[plan.lowerThreadIndex] = tmp;

    return true;
  }

  // Conveniência: deriva o plano a partir de blocks/upperIndex e já aplica
  // a troca. Devolve true se trocou, false quando a posição era inválida
  // (sem efeito nos arrays).
  function swapAdjacentBlocks(stitches, threads, blocks, upperIndex) {
    const plan = deriveSwapPlan(blocks, upperIndex);
    if (!plan) return false;
    return swapBlocks(stitches, threads, plan);
  }

  return { deriveMergePlan, mergeBlock, splitBlock, deriveSwapPlan, swapAdjacentBlocks };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ColorBlocks;
}
