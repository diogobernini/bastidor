'use strict';
// Histórico de undo/redo por OPERAÇÕES (issue #37), em vez do modelo antigo
// de snapshot completo por mutação (state.undoStack em renderer.js, sem
// redo, cap 20). Módulo puro (sem DOM, sem Node): não conhece `state` nem o
// design do renderer — quem chama (renderer.js) descreve cada mutação como
// uma operação pequena com inversa barata, e fornece as funções que sabem
// aplicar cada tipo de operação (`applyFns`, ver abaixo). Além de exportar
// via module.exports (para os testes em node:test), este arquivo também é
// carregado direto por <script src="../core/history.js"> em
// src/renderer/index.html, antes de renderer.js — por isso fica tudo dentro
// de uma IIFE: scripts clássicos compartilham o mesmo escopo de topo da
// página, e nomes como api/COMMAND_MASK/STITCH já existem lá. Só o "const
// History" final escapa da IIFE.
//
// Operações suportadas (union por `type`):
//   { type: 'movePoint',     index, from: [x, y], to: [x, y] }
//   { type: 'deletePoint',   index, stitch: [x, y, cmd] }        // stitch = o que foi removido
//   { type: 'insertPoint',   index, stitch: [x, y, cmd] }        // stitch = o que foi inserido
//   { type: 'recolorThread', index, from: cor, to: cor }
//   { type: 'mergeColorBlock', colorChangeIndex, threadIndex, stitch, thread }
//     // mesclar blocos de cor adjacentes (issue #50): remove o stitch
//     // COLOR_CHANGE em `colorChangeIndex` e a thread em `threadIndex`.
//     // `stitch`/`thread` guardam o que foi removido, para a inversa
//     // (splitColorBlock) reinserir nas mesmas posições.
//   { type: 'splitColorBlock', colorChangeIndex, threadIndex, stitch, thread }
//     // inversa de mergeColorBlock: reinsere o stitch e a thread removidos.
//   { type: 'transform',     kind, params }                      // ver invertTransform() abaixo
//     - kind 'translate': params { dx, dy }
//     - kind 'rotate90':  params { cx, cy, clockwise }
//     - kind 'flip':      params { cx, cy, horizontal }
//     - kind 'scale':     params { cx, cy, factor }
//   { type: 'snapshot', before: { stitches, threads }, after: { stitches, threads } }
//     // fallback pesado (cópia profunda completa): usado só quando não há
//     // inversa analítica barata — redimensionar com densidade (recalcula
//     // a corrida de ponto cheio, muda o tamanho do array), guarda de
//     // espaçamento e outras operações compostas.
//
// `applyFns` (fornecido por quem chama undo()/redo()) é um dicionário
// type -> function(op), uma função por tipo de operação, que MUTA o design
// para o estado descrito por `op` (sempre o lado "de chegada": op.to para
// movePoint, insere/remove para insertPoint/deletePoint, op.to para
// recolorThread, aplica op.kind/op.params para transform, op.after para
// snapshot). undo() e redo() só diferem em qual objeto passam pra
// `applyFns`: undo() inverte a operação antes (ver invert()); redo()
// aplica a operação original de novo. Isso mantém `applyFns` simples e
// simétrico — nenhuma das funções precisa saber se está desfazendo ou
// refazendo.

const History = (function () {
  const DEFAULT_CAP = 100; // profundidade padrão para entradas delta (issue #37 pede 100, acima do limite antigo de 20)
  const DEFAULT_SNAPSHOT_BYTE_BUDGET = 50 * 1024 * 1024; // ~50 MB: orçamento de memória só para entradas 'snapshot'

  // ------------------------------------------------------------- inversão

  function invertTransform(kind, params) {
    switch (kind) {
      case 'translate':
        return { dx: -params.dx, dy: -params.dy };
      case 'rotate90':
        return { cx: params.cx, cy: params.cy, clockwise: !params.clockwise };
      case 'flip':
        // Espelhar duas vezes no mesmo eixo devolve o ponto original: a
        // inversa de um flip é o mesmo flip (mesmos params).
        return { cx: params.cx, cy: params.cy, horizontal: params.horizontal };
      case 'scale':
        return { cx: params.cx, cy: params.cy, factor: 1 / params.factor };
      default:
        throw new Error('History: transform de tipo desconhecido "' + kind + '"');
    }
  }

  // Devolve a operação que desfaz `op`. Pura: não muta `op` nem toca em DOM/design.
  function invert(op) {
    switch (op.type) {
      case 'movePoint':
        return { type: 'movePoint', index: op.index, from: op.to, to: op.from };
      case 'deletePoint':
        return { type: 'insertPoint', index: op.index, stitch: op.stitch };
      case 'insertPoint':
        return { type: 'deletePoint', index: op.index, stitch: op.stitch };
      case 'recolorThread':
        return { type: 'recolorThread', index: op.index, from: op.to, to: op.from };
      case 'mergeColorBlock':
        return { type: 'splitColorBlock', colorChangeIndex: op.colorChangeIndex, threadIndex: op.threadIndex, stitch: op.stitch, thread: op.thread };
      case 'splitColorBlock':
        return { type: 'mergeColorBlock', colorChangeIndex: op.colorChangeIndex, threadIndex: op.threadIndex, stitch: op.stitch, thread: op.thread };
      case 'transform':
        return { type: 'transform', kind: op.kind, params: invertTransform(op.kind, op.params) };
      case 'snapshot':
        return { type: 'snapshot', before: op.after, after: op.before };
      default:
        throw new Error('History: operação de tipo desconhecido "' + op.type + '"');
    }
  }

  // -------------------------------------------------------- custo em bytes

  // Estimativa grosseira do peso de um snapshot completo: cada agulhada tem
  // 3 números (x, y, cmd) — em torno de 8 bytes cada num array JS de
  // doubles — e threads normalmente é pequeno, mas serializamos para pegar
  // o tamanho real. Não precisa ser exata: só orienta quando descartar
  // entradas 'snapshot' antigas para respeitar o orçamento de memória.
  function estimateSnapshotBytes(op) {
    const before = op.before || {};
    const after = op.after || {};
    const stitchCount = (before.stitches ? before.stitches.length : 0) + (after.stitches ? after.stitches.length : 0);
    const stitchBytes = stitchCount * 3 * 8;
    const threadBytes = jsonByteLength(before.threads) + jsonByteLength(after.threads);
    return stitchBytes + threadBytes;
  }

  function jsonByteLength(value) {
    if (!value) return 0;
    try {
      return JSON.stringify(value).length * 2; // *2: aproxima UTF-16
    } catch (e) {
      return 0;
    }
  }

  // ------------------------------------------------------------- instância

  // Cria uma pilha de undo/redo independente. opts:
  //   cap:                nº máximo de entradas na pilha de undo (padrão 100)
  //   snapshotByteBudget:  orçamento de memória (bytes) só para entradas
  //                        'snapshot' somadas (padrão ~50 MB)
  //   estimateBytes:       função(op) -> bytes, sobrescrevível nos testes
  function create(opts) {
    opts = opts || {};
    const cap = opts.cap > 0 ? opts.cap : DEFAULT_CAP;
    const snapshotByteBudget = opts.snapshotByteBudget > 0 ? opts.snapshotByteBudget : DEFAULT_SNAPSHOT_BYTE_BUDGET;
    const estimateBytes = typeof opts.estimateBytes === 'function' ? opts.estimateBytes : estimateSnapshotBytes;

    let undoStack = []; // entradas { op, bytes } — bytes é 0 para deltas, estimado para 'snapshot'
    let redoStack = [];

    function weightOf(op) {
      return op.type === 'snapshot' ? estimateBytes(op) : 0;
    }

    function snapshotBytesTotal() {
      let total = 0;
      for (const entry of undoStack) total += entry.bytes;
      return total;
    }

    // Cap por quantidade: sempre as N entradas mais recentes (descarta do
    // início, igual ao `shift()` do state.undoStack antigo, só que N=100
    // por padrão em vez de 20).
    function enforceCountCap() {
      while (undoStack.length > cap) undoStack.shift();
    }

    // Cap por memória: só entradas 'snapshot' pesam aqui (deltas custam ~0).
    // Quando o total estimado passa do orçamento, descarta a entrada
    // 'snapshot' mais antiga (onde quer que ela esteja na pilha — pode não
    // ser o item 0 se houver deltas mais antigos ainda vivos) até caber.
    // Cada operação é autocontida (carrega seu próprio from/to/stitch), então
    // remover uma entrada do meio não invalida as vizinhas — só torna aquele
    // passo específico "impossível de desfazer", igual ao comportamento já
    // aceito pelo cap por quantidade.
    function enforceMemoryBudget() {
      let total = snapshotBytesTotal();
      while (total > snapshotByteBudget) {
        const idx = undoStack.findIndex((entry) => entry.op.type === 'snapshot');
        if (idx === -1) break; // nada pesado sobrando: não há mais o que descartar
        total -= undoStack[idx].bytes;
        undoStack.splice(idx, 1);
      }
    }

    function push(op) {
      if (!op || typeof op.type !== 'string') {
        throw new Error('History.push: operação precisa de um campo "type"');
      }
      redoStack = []; // clearRedo automático em toda nova mutação
      undoStack.push({ op, bytes: weightOf(op) });
      enforceCountCap();
      enforceMemoryBudget();
    }

    // Desfaz a operação mais recente: inverte e aplica via applyFns, move a
    // entrada original para a pilha de redo. Devolve a operação desfeita
    // (para quem chamou decidir o que atualizar), ou null se não há nada.
    function undo(applyFns) {
      if (undoStack.length === 0) return null;
      const entry = undoStack.pop();
      const inv = invert(entry.op);
      applyFns[inv.type](inv);
      redoStack.push(entry);
      return entry.op;
    }

    // Refaz a operação mais recentemente desfeita: aplica a operação
    // original de novo (sem inverter) e devolve pra pilha de undo.
    function redo(applyFns) {
      if (redoStack.length === 0) return null;
      const entry = redoStack.pop();
      applyFns[entry.op.type](entry.op);
      undoStack.push(entry);
      return entry.op;
    }

    function clear() {
      undoStack = [];
      redoStack = [];
    }

    return {
      push,
      undo,
      redo,
      clear,
      canUndo: () => undoStack.length > 0,
      canRedo: () => redoStack.length > 0,
      get undoLength() {
        return undoStack.length;
      },
      get redoLength() {
        return redoStack.length;
      },
      snapshotBytes: snapshotBytesTotal,
    };
  }

  return {
    create,
    invert,
    estimateSnapshotBytes,
    DEFAULT_CAP,
    DEFAULT_SNAPSHOT_BYTE_BUDGET,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = History;
}
