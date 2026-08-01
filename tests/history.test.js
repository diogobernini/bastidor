'use strict';
// Testes do módulo puro de histórico undo/redo por operações (issue #37).

const test = require('node:test');
const assert = require('node:assert');

const History = require('../src/core/history');

// applyFns "de referência" usado na maioria dos testes: muta um design
// falso ({ stitches, threads }) exatamente como o renderer faria.
function makeApply(design) {
  return {
    movePoint(op) {
      const st = design.stitches[op.index];
      st[0] = op.to[0];
      st[1] = op.to[1];
    },
    deletePoint(op) {
      design.stitches.splice(op.index, 1);
    },
    insertPoint(op) {
      design.stitches.splice(op.index, 0, op.stitch.slice());
    },
    recolorThread(op) {
      const t = design.threads[op.index];
      if (t) t.color = op.to;
      else design.threads[op.index] = { color: op.to };
    },
    transform(op) {
      const { kind, params } = op;
      for (const st of design.stitches) {
        let x = st[0];
        let y = st[1];
        if (kind === 'translate') {
          x += params.dx;
          y += params.dy;
        } else if (kind === 'rotate90') {
          const dx = x - params.cx;
          const dy = y - params.cy;
          [x, y] = params.clockwise ? [params.cx - dy, params.cy + dx] : [params.cx + dy, params.cy - dx];
        } else if (kind === 'flip') {
          if (params.horizontal) x = 2 * params.cx - x;
          else y = 2 * params.cy - y;
        } else if (kind === 'scale') {
          x = params.cx + (x - params.cx) * params.factor;
          y = params.cy + (y - params.cy) * params.factor;
        }
        st[0] = x;
        st[1] = y;
      }
    },
    snapshot(op) {
      design.stitches = op.after.stitches;
      design.threads = op.after.threads;
    },
  };
}

// --------------------------------------------------------- mover-mover-undo-redo

test('sequência mover-mover-undo-redo confere a posição nos 3 estados', () => {
  const design = { stitches: [[0, 0, 0], [10, 10, 0]], threads: [] };
  const h = History.create();
  const apply = makeApply(design);

  h.push({ type: 'movePoint', index: 0, from: [0, 0], to: [5, 0] });
  apply.movePoint({ index: 0, to: [5, 0] });
  h.push({ type: 'movePoint', index: 0, from: [5, 0], to: [5, 7] });
  apply.movePoint({ index: 0, to: [5, 7] });

  assert.deepEqual(design.stitches[0], [5, 7, 0], 'estado 1: depois dos dois movimentos');

  h.undo(apply);
  assert.deepEqual(design.stitches[0], [5, 0, 0], 'estado 2: 1 undo volta ao ponto intermediário');

  h.undo(apply);
  assert.deepEqual(design.stitches[0], [0, 0, 0], 'estado 3: 2º undo volta à posição original');
  assert.equal(h.canUndo(), false);

  h.redo(apply);
  assert.deepEqual(design.stitches[0], [5, 0, 0], 'redo reaplica o 1º movimento');

  h.redo(apply);
  assert.deepEqual(design.stitches[0], [5, 7, 0], 'redo reaplica o 2º movimento');
  assert.equal(h.canRedo(), false);
});

test('undo/redo não afetam outros índices', () => {
  const design = { stitches: [[1, 1, 0], [2, 2, 0], [3, 3, 0]], threads: [] };
  const h = History.create();
  const apply = makeApply(design);
  h.push({ type: 'movePoint', index: 1, from: [2, 2], to: [20, 20] });
  apply.movePoint({ index: 1, to: [20, 20] });
  h.undo(apply);
  assert.deepEqual(design.stitches, [[1, 1, 0], [2, 2, 0], [3, 3, 0]]);
});

// --------------------------------------------------------- push limpa redo

test('push depois de um undo descarta o redo pendente', () => {
  const design = { stitches: [[0, 0, 0]], threads: [] };
  const h = History.create();
  const apply = makeApply(design);

  h.push({ type: 'movePoint', index: 0, from: [0, 0], to: [1, 0] });
  apply.movePoint({ index: 0, to: [1, 0] });
  h.undo(apply);
  assert.equal(h.canRedo(), true, 'undo deixa uma entrada pronta pra redo');

  h.push({ type: 'movePoint', index: 0, from: [0, 0], to: [9, 9] });
  assert.equal(h.canRedo(), false, 'nova mutação deve limpar o redo pendente');
  assert.equal(h.redo(makeApply(design)), null, 'redo() não tem mais nada pra aplicar');
});

// --------------------------------------------------------- cap por quantidade

test('cap por quantidade mantém só as N entradas mais recentes', () => {
  const design = { stitches: [[0, 0, 0]], threads: [] };
  const h = History.create({ cap: 5 });
  const apply = makeApply(design);

  for (let i = 0; i < 8; i++) {
    h.push({ type: 'movePoint', index: 0, from: [i, 0], to: [i + 1, 0] });
  }
  assert.equal(h.undoLength, 5, 'só 5 entradas sobrevivem ao cap de 8 pushes');

  // Desfaz tudo que restou: a mais nova primeiro. Como só sobram as
  // operações de i=3..7, o "from" mais antigo alcançável é 3 (as de i=0,1,2
  // foram descartadas pelo cap).
  const seen = [];
  while (h.canUndo()) {
    h.undo(apply);
    seen.push(design.stitches[0][0]);
  }
  assert.deepEqual(seen, [7, 6, 5, 4, 3]);
});

test('cap por quantidade configurável aceita valores diferentes do padrão', () => {
  const h = History.create({ cap: 2 });
  h.push({ type: 'recolorThread', index: 0, from: '#000', to: '#111' });
  h.push({ type: 'recolorThread', index: 0, from: '#111', to: '#222' });
  h.push({ type: 'recolorThread', index: 0, from: '#222', to: '#333' });
  assert.equal(h.undoLength, 2);
});

// --------------------------------------------------------- cap por memória

test('cap por memória descarta snapshots mais antigos ao passar do orçamento', () => {
  const BYTES_PER_SNAPSHOT = 20 * 1024 * 1024; // 20 MB "fake" por entrada
  const design = { stitches: [], threads: [], marker: 0 };
  const h = History.create({
    cap: 100, // bem acima do que este teste dispara: quem limita aqui é a memória
    snapshotByteBudget: 50 * 1024 * 1024,
    estimateBytes: () => BYTES_PER_SNAPSHOT,
  });
  const apply = {
    snapshot(op) {
      design.marker = op.after.marker;
    },
  };
  const mk = (n) => ({
    type: 'snapshot',
    before: { stitches: [], threads: [], marker: n - 1 },
    after: { stitches: [], threads: [], marker: n },
  });

  h.push(mk(1)); // 20 MB (total 20 MB)
  h.push(mk(2)); // 40 MB (total 40 MB)
  h.push(mk(3)); // 60 MB > orçamento de 50 MB -> descarta a mais antiga (marker 1)

  assert.equal(h.undoLength, 2, 'só 2 snapshots cabem no orçamento de 50 MB a 20 MB cada');
  assert.ok(h.snapshotBytes() <= 50 * 1024 * 1024, `${h.snapshotBytes()} deveria caber no orçamento`);

  h.undo(apply);
  assert.equal(design.marker, 2, 'desfaz a entrada 3 (mais recente) primeiro, volta ao estado "before" dela (=2)');
  h.undo(apply);
  assert.equal(design.marker, 1, 'desfaz a entrada 2, volta ao estado "before" dela (=1)');
  assert.equal(h.canUndo(), false, 'a entrada 1 foi descartada pelo cap de memória: não há mais o que desfazer');
});

test('deltas não contam no orçamento de memória, só entradas snapshot', () => {
  const h = History.create({ snapshotByteBudget: 1024, estimateBytes: () => 2000 });
  for (let i = 0; i < 50; i++) {
    h.push({ type: 'movePoint', index: 0, from: [i, 0], to: [i + 1, 0] });
  }
  assert.equal(h.undoLength, 50, 'deltas pesam 0 bytes: cap de memória de 1 KB não deveria descartar nenhum');
  assert.equal(h.snapshotBytes(), 0);
});

// --------------------------------------------------------- snapshot fallback

test('operação snapshot restaura o estado exato (before/after) via undo/redo', () => {
  const design = {
    stitches: [[0, 0, 0], [1, 1, 0]],
    threads: [{ color: '#111111' }],
  };
  const before = {
    stitches: design.stitches.map((s) => s.slice()),
    threads: JSON.parse(JSON.stringify(design.threads)),
  };

  // Simula uma operação composta (ex.: redimensionar com densidade): o
  // array de agulhadas muda de tamanho, threads ganham uma entrada nova.
  design.stitches = [[0, 0, 0], [1, 1, 0], [2, 2, 0], [3, 3, 5]];
  design.threads = [{ color: '#ffffff' }, { color: '#222222' }];
  const after = {
    stitches: design.stitches.map((s) => s.slice()),
    threads: JSON.parse(JSON.stringify(design.threads)),
  };

  const h = History.create();
  const apply = makeApply(design);
  h.push({ type: 'snapshot', before, after });

  h.undo(apply);
  assert.deepEqual(design.stitches, before.stitches);
  assert.deepEqual(design.threads, before.threads);

  h.redo(apply);
  assert.deepEqual(design.stitches, after.stitches);
  assert.deepEqual(design.threads, after.threads);
});

// --------------------------------------------------------- deletePoint / insertPoint

test('deletePoint e insertPoint são inversas exatas uma da outra', () => {
  const design = { stitches: [[0, 0, 0], [1, 1, 0], [2, 2, 0]], threads: [] };
  const h = History.create();
  const apply = makeApply(design);

  const removed = design.stitches[1].slice();
  h.push({ type: 'deletePoint', index: 1, stitch: removed });
  apply.deletePoint({ index: 1 });
  assert.deepEqual(design.stitches, [[0, 0, 0], [2, 2, 0]]);

  h.undo(apply);
  assert.deepEqual(design.stitches, [[0, 0, 0], [1, 1, 0], [2, 2, 0]], 'undo de deletePoint reinsere o ponto');

  h.redo(apply);
  assert.deepEqual(design.stitches, [[0, 0, 0], [2, 2, 0]], 'redo de deletePoint remove o ponto de novo');
});

test('insertPoint via undo remove exatamente o ponto inserido', () => {
  const design = { stitches: [[0, 0, 0], [10, 10, 0]], threads: [] };
  const h = History.create();
  const apply = makeApply(design);

  const newStitch = [5, 5, 0];
  h.push({ type: 'insertPoint', index: 1, stitch: newStitch });
  apply.insertPoint({ index: 1, stitch: newStitch });
  assert.deepEqual(design.stitches, [[0, 0, 0], [5, 5, 0], [10, 10, 0]]);

  h.undo(apply);
  assert.deepEqual(design.stitches, [[0, 0, 0], [10, 10, 0]]);

  h.redo(apply);
  assert.deepEqual(design.stitches, [[0, 0, 0], [5, 5, 0], [10, 10, 0]]);
});

// --------------------------------------------------------- recolorThread

test('recolorThread desfaz e refaz a troca de cor', () => {
  const design = { stitches: [], threads: [{ color: '#ff0000' }] };
  const h = History.create();
  const apply = makeApply(design);

  h.push({ type: 'recolorThread', index: 0, from: '#ff0000', to: '#00ff00' });
  apply.recolorThread({ index: 0, to: '#00ff00' });
  assert.equal(design.threads[0].color, '#00ff00');

  h.undo(apply);
  assert.equal(design.threads[0].color, '#ff0000');

  h.redo(apply);
  assert.equal(design.threads[0].color, '#00ff00');
});

test('recolorThread cria a entrada de thread quando ela ainda não existe', () => {
  const design = { stitches: [], threads: [] };
  const h = History.create();
  const apply = makeApply(design);

  h.push({ type: 'recolorThread', index: 0, from: undefined, to: '#123456' });
  apply.recolorThread({ index: 0, to: '#123456' });
  assert.deepEqual(design.threads[0], { color: '#123456' });
});

// --------------------------------------------------------- transform

test('transform translate: undo/redo são exatos com deltas inteiros', () => {
  const design = { stitches: [[3, 4, 0], [-2, 5, 0]], threads: [] };
  const h = History.create();
  const apply = makeApply(design);

  const op = { type: 'transform', kind: 'translate', params: { dx: -3, dy: 10 } };
  h.push(op);
  apply.transform(op);
  assert.deepEqual(design.stitches, [[0, 14, 0], [-5, 15, 0]]);

  h.undo(apply);
  assert.deepEqual(design.stitches, [[3, 4, 0], [-2, 5, 0]]);

  h.redo(apply);
  assert.deepEqual(design.stitches, [[0, 14, 0], [-5, 15, 0]]);
});

test('transform rotate90: undo (girar de volta) restaura os pontos exatamente', () => {
  const design = { stitches: [[10, 0, 0], [0, 10, 0]], threads: [] };
  const h = History.create();
  const apply = makeApply(design);

  const op = { type: 'transform', kind: 'rotate90', params: { cx: 0, cy: 0, clockwise: true } };
  h.push(op);
  apply.transform(op);
  assert.deepEqual(design.stitches, [[0, 10, 0], [-10, 0, 0]]);

  h.undo(apply);
  assert.deepEqual(design.stitches, [[10, 0, 0], [0, 10, 0]]);
});

test('transform flip: é sua própria inversa', () => {
  const design = { stitches: [[4, 4, 0]], threads: [] };
  const h = History.create();
  const apply = makeApply(design);

  const op = { type: 'transform', kind: 'flip', params: { cx: 0, cy: 0, horizontal: true } };
  h.push(op);
  apply.transform(op);
  assert.deepEqual(design.stitches, [[-4, 4, 0]]);

  h.undo(apply);
  assert.deepEqual(design.stitches, [[4, 4, 0]]);
});

test('transform scale: fator invertido (1/factor) restaura os pontos', () => {
  const design = { stitches: [[10, 20, 0]], threads: [] };
  const h = History.create();
  const apply = makeApply(design);

  const op = { type: 'transform', kind: 'scale', params: { cx: 0, cy: 0, factor: 2 } };
  h.push(op);
  apply.transform(op);
  assert.deepEqual(design.stitches, [[20, 40, 0]]);

  h.undo(apply);
  assert.ok(Math.abs(design.stitches[0][0] - 10) < 1e-9);
  assert.ok(Math.abs(design.stitches[0][1] - 20) < 1e-9);

  h.redo(apply);
  assert.deepEqual(design.stitches, [[20, 40, 0]]);
});

// --------------------------------------------------------- invert() isolado

test('invert() é pura e não muta a operação original', () => {
  const op = { type: 'movePoint', index: 3, from: [1, 2], to: [3, 4] };
  const inv = History.invert(op);
  assert.deepEqual(op, { type: 'movePoint', index: 3, from: [1, 2], to: [3, 4] }, 'original intacto');
  assert.deepEqual(inv, { type: 'movePoint', index: 3, from: [3, 4], to: [1, 2] });
});

test('invert() de tipo desconhecido lança erro', () => {
  assert.throws(() => History.invert({ type: 'bogus' }));
});

// --------------------------------------------------------- casos vazios

test('undo()/redo() em pilhas vazias não lançam e devolvem null', () => {
  const h = History.create();
  assert.equal(h.undo({}), null);
  assert.equal(h.redo({}), null);
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
});

test('push() exige um campo "type" válido', () => {
  const h = History.create();
  assert.throws(() => h.push({ index: 0 }));
  assert.throws(() => h.push(null));
});
