'use strict';
// Núcleo puro do painel de Cores da sidebar (um bloco por trecho entre
// COLOR_CHANGEs). Três famílias de operação:
//  - Mesclagem de blocos adjacentes (issue #50): funde o bloco de BAIXO no
//    bloco de CIMA, mantendo a linha/config do de cima. A sequência de
//    bordado não muda: só o COLOR_CHANGE entre os dois some (uma parada a
//    menos pra trocar de linha), e a entrada de thread do bloco de baixo é
//    removida.
//  - Reordenar blocos adjacentes (issue #61): troca a ordem de bordado
//    entre dois blocos vizinhos (subir/descer no painel), realocando o
//    COLOR_CHANGE de fechamento correto nas bordas — ver swapBlocks.
//  - Aplicar uma ordem paramétrica (issue #73): generaliza swapBlocks para
//    uma permutação ARBITRÁRIA dos blocos de UM objeto (não só um par
//    adjacente) — ver applyColorOrder. Usada pra reaplicar a ordem de
//    bordado escolhida pelo usuário (setas ▲/▼ internas a um objeto
//    multi-bloco) na saída fresca do gerador, a cada regeneração
//    paramétrica (redimensionar arrastando a alça).
// Mesmo espírito de src/core/library-view.js: módulo puro (sem DOM, sem
// Node), carregado tanto por <script src="../core/colorblocks.js"> quanto
// por node:test via module.exports. Pensado para ser compartilhado também
// pelo painel de sew-order de objetos da fase 3 da issue #29 (reordena
// unidades em vez de blocos, mas a primitiva de troca adjacente é a mesma).

const ColorBlocks = (function () {
  const COMMAND_MASK = 0xff;
  const COLOR_CHANGE = 5;
  const END = 4;

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

  // Confere se o último stitch do intervalo [start, end) é um "fechamento":
  // um COLOR_CHANGE (fecha um bloco do meio) OU um END (fecha o desenho
  // inteiro — todo design carregado/gerado termina com um END de verdade,
  // ver src/core/io e src/renderer/objects.js:stripTrailingEnd). O ÚLTIMO
  // bloco da lista é o único que pode ter END em vez de COLOR_CHANGE (ver
  // deriveBlocks() no renderer); um bloco sem NENHUM dos dois (raro, só em
  // dados sintéticos de teste) não tem fechamento algum.
  function isClosingStitch(stitch) {
    if (!stitch) return false;
    const cmd = stitch[2] & COMMAND_MASK;
    return cmd === COLOR_CHANGE || cmd === END;
  }

  function hasClosingMarker(stitches, start, end) {
    if (end <= start) return false;
    return isClosingStitch(stitches[end - 1]);
  }

  // Aplica a troca descrita por `plan` (de deriveSwapPlan), MUTANDO stitches
  // e threads (mesmo padrão de mergeBlock: quem chama decide se clona
  // antes). `blocks` sempre garante que o de CIMA tem um COLOR_CHANGE de
  // fechamento (só o ÚLTIMO bloco da lista não tem, e o de cima nunca é o
  // último aqui). O de BAIXO pode ou não ter um fechamento (COLOR_CHANGE se
  // não for o último bloco do desenho; END se for — todo design carregado
  // termina com um END de verdade).
  //
  // Ideia: cada bloco tem um "conteúdo puro" (agulhadas sem o fechamento,
  // quando ele existe). A troca reaproveita o COLOR_CHANGE do bloco de CIMA
  // como a nova fronteira entre os dois (agora o conteúdo de baixo vem
  // primeiro), e só sobra um fechamento no final se o bloco de BAIXO
  // original já tinha um. Isso resolve as duas bordas do enunciado: ao
  // trocar o penúltimo bloco com o último (a) se o de baixo fechava com
  // COLOR_CHANGE, o que passa a ser o último perde o fechamento e o que sai
  // da última posição ganha o COLOR_CHANGE que era do antigo de cima; (b)
  // se o de baixo era o fim de VERDADE do desenho (fechava com END), esse
  // MESMO stitch de END é realocado para o novo fim do array — nunca fica
  // "enterrado" no meio, o que deixaria um END solto a meio caminho e um
  // COLOR_CHANGE sobrando como último stitch do arquivo (corrompendo
  // qualquer exportação/leitura futura). A troca é sua própria inversa:
  // aplicá-la de novo com `blocks` recém derivado do resultado devolve
  // exatamente o estado original, END incluído.
  function swapBlocks(stitches, threads, plan) {
    const ccUpperIdx = plan.upperEnd - 1;
    const ccUpper = stitches[ccUpperIdx];
    if (!ccUpper || (ccUpper[2] & COMMAND_MASK) !== COLOR_CHANGE) {
      throw new Error('ColorBlocks.swapBlocks: bloco de cima sem COLOR_CHANGE de fechamento');
    }
    const lowerHasClosing = hasClosingMarker(stitches, plan.lowerStart, plan.lowerEnd);
    const pureUpper = stitches.slice(plan.upperStart, ccUpperIdx);
    const lowerContentEnd = lowerHasClosing ? plan.lowerEnd - 1 : plan.lowerEnd;
    const pureLower = stitches.slice(plan.lowerStart, lowerContentEnd);
    const closingLower = lowerHasClosing ? stitches[plan.lowerEnd - 1] : null;

    const newSegment = pureLower.map((s) => s.slice());
    newSegment.push(ccUpper.slice());
    for (const s of pureUpper) newSegment.push(s.slice());
    if (closingLower) newSegment.push(closingLower.slice());

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

  // -------------------------------------------------- ordem paramétrica (issue #73)
  //
  // Generaliza swapBlocks (uma troca só, sempre entre 2 blocos ADJACENTES)
  // para uma permutação ARBITRÁRIA dos `blocks.length` blocos de UM objeto
  // paramétrico só. Usada por src/renderer/objects.js (regenerateParametric)
  // pra reaplicar object.params.colorOrder — a ordem de bordado que o
  // usuário escolheu pelas setas ▲/▼ INTERNAS do painel de Cores (ver
  // moveColorBlockInUnit em renderer.js) — na saída FRESCA do gerador: o
  // gerador não sabe de colorOrder, sempre devolve os blocos na ordem
  // 0..n-1 de geração.
  //
  // `order[i]` é o índice de bloco ORIGINAL (posição em `blocks`, a lista já
  // derivada da PRÓPRIA `stitches` recebida, mesmo formato dos outros
  // helpers deste módulo) que deve ocupar a posição `i` do resultado — ex.:
  // order=[1,0] em 2 blocos põe o bloco 1 primeiro (exatamente o que uma
  // troca adjacente única produz). `order` ausente/null, ou igual à
  // identidade [0,1,...,n-1], é NO-OP: devolve stitches/threads
  // equivalentes (cópias, nunca muta os argumentos), sem reescrever nada —
  // comportamento atual byte a byte (issue #73, item 2).
  //
  // Mesmo cuidado de fechamento de swapBlocks: em `blocks`, só o ÚLTIMO pode
  // não fechar com COLOR_CHANGE (fecha com END — todo objeto gerado termina
  // com um END de verdade antes de stripTrailingEnd tirar — ou não fecha
  // nada, só em dados sintéticos de teste); TODOS os outros (blockCount - 1
  // deles) SEMPRE fecham com COLOR_CHANGE, garantia que deriveSwapPlan já
  // assume. Isso dá exatamente blockCount - 1 tokens de COLOR_CHANGE
  // "soltos" (um por bloco não-último) para as blockCount - 1 posições
  // NÃO-finais do resultado, qualquer que seja a nova ordem — sempre sobra
  // exatamente 1 posição final, que herda o fechamento especial (END ou
  // nenhum) do bloco que ERA o último, não importa pra onde ele foi. Os
  // tokens de COLOR_CHANGE são intercambiáveis (mesmo espírito de
  // swapBlocks, que já reusa o token do bloco de cima como fronteira nova
  // sem recalcular coordenada): são distribuídos na ordem original dos
  // blocos não-últimos, o suficiente para reduzir exatamente ao resultado
  // de swapAdjacentBlocks quando `order` é uma troca adjacente só (ver
  // testes em tests/colorblocks.test.js).
  function isIdentityColorOrder(order, length) {
    if (order == null) return true; // ausente: comportamento atual (sem-op)
    if (!Array.isArray(order) || order.length !== length) return false; // não é identidade — deixa a validação de permutação decidir se é erro
    for (let i = 0; i < order.length; i++) {
      if (order[i] !== i) return false;
    }
    return true;
  }

  function applyColorOrder(stitches, threads, blocks, order) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return { stitches: stitches.map((s) => s.slice()), threads: threads.slice() };
    }
    const n = blocks.length;
    if (isIdentityColorOrder(order, n)) {
      return { stitches: stitches.map((s) => s.slice()), threads: threads.slice() };
    }
    const seen = new Set(order);
    const valid = Array.isArray(order) && order.length === n && seen.size === n && order.every((v) => Number.isInteger(v) && v >= 0 && v < n);
    if (!valid) {
      throw new Error('ColorBlocks.applyColorOrder: order precisa ser ausente ou uma permutação de 0..' + (n - 1));
    }

    const lastIdx = n - 1;
    const lastHasClosing = hasClosingMarker(stitches, blocks[lastIdx].start, blocks[lastIdx].end);
    const specialToken = lastHasClosing ? stitches[blocks[lastIdx].end - 1] : null;

    // Conteúdo puro de cada bloco original (sem o próprio fechamento, quando existe).
    const pureContents = blocks.map((b, i) => {
      const contentEnd = i === lastIdx && !lastHasClosing ? b.end : b.end - 1;
      return stitches.slice(b.start, contentEnd).map((s) => s.slice());
    });

    // Pool de tokens de COLOR_CHANGE "soltos": 1 por bloco não-último,
    // sempre garantido (ver comentário acima) — exatamente n-1 tokens para
    // as n-1 posições não-finais do resultado.
    const pool = [];
    for (let i = 0; i < lastIdx; i++) pool.push(stitches[blocks[i].end - 1]);

    const newStitches = [];
    let poolCursor = 0;
    for (let pos = 0; pos < n; pos++) {
      const originalIdx = order[pos];
      for (const s of pureContents[originalIdx]) newStitches.push(s.slice());
      if (pos < lastIdx) {
        newStitches.push(pool[poolCursor].slice());
        poolCursor++;
      } else if (specialToken) {
        newStitches.push(specialToken.slice());
      }
    }

    const newThreads = order.map((originalIdx) => {
      const ti = blocks[originalIdx].threadIndex;
      return threads[ti] !== undefined ? threads[ti] : null;
    });

    return { stitches: newStitches, threads: newThreads };
  }

  return { deriveMergePlan, mergeBlock, splitBlock, deriveSwapPlan, swapAdjacentBlocks, applyColorOrder };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ColorBlocks;
}
