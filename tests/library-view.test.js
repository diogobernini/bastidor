'use strict';
// Testes da matemática pura da grade virtualizada (src/core/library-view.js,
// issue #35): dado scrollTop/altura/colunas/total de itens, quais linhas
// (e índices) precisam de nó no DOM. Sem DOM: só aritmética, testável direto.

const test = require('node:test');
const assert = require('node:assert');

const LibraryView = require('../src/core/library-view');

// ------------------------------------------------------------------ computeCols

test('computeCols: cabe o número inteiro de colunas na largura disponível', () => {
  // item 108px + gap 10px = 116px por coluna; largura útil 1000-20=980 -> 8 colunas (928px), 9ª não cabe (1044px)
  assert.equal(LibraryView.computeCols(1000, 108, 10, 20), 8);
});

test('computeCols: nunca devolve menos que 1, mesmo com viewport minúsculo ou zero', () => {
  assert.equal(LibraryView.computeCols(0, 108, 10, 20), 1);
  assert.equal(LibraryView.computeCols(50, 108, 10, 20), 1);
  assert.equal(LibraryView.computeCols(-100, 108, 10, 20), 1);
});

test('computeCols: exatamente a largura de N colunas cabe as N (sem sobra parcial)', () => {
  // 3 colunas exatas: 3*108 + 2*10 = 344, + padding 20 = 364
  assert.equal(LibraryView.computeCols(364, 108, 10, 20), 3);
  // 1px a menos: só 2 colunas
  assert.equal(LibraryView.computeCols(363, 108, 10, 20), 2);
});

// ------------------------------------------------------------------ computeVisibleRange

test('computeVisibleRange: topo da lista (scrollTop=0) mostra a primeira janela + buffer abaixo', () => {
  const r = LibraryView.computeVisibleRange({
    scrollTop: 0,
    viewHeight: 500,
    rowHeight: 182, // LIB_ITEM_HEIGHT+gap na config real
    cols: 8,
    itemCount: 15000,
    bufferRows: 2,
  });
  assert.equal(r.firstRow, 0); // não existe linha negativa
  // ceil(500/182)=3 linhas visíveis + 2 de buffer = linha 5
  assert.equal(r.lastRow, 5);
  assert.equal(r.firstIndex, 0);
  assert.equal(r.lastIndex, 6 * 8 - 1); // linhas 0..5 = 6 linhas inteiras de 8
});

test('computeVisibleRange: meio da lista usa o scrollTop para achar a janela, com buffer nas duas pontas', () => {
  const r = LibraryView.computeVisibleRange({
    scrollTop: 1820, // exatamente 10 linhas de 182px
    viewHeight: 364, // 2 linhas de altura
    rowHeight: 182,
    cols: 8,
    itemCount: 15000,
    bufferRows: 2,
  });
  assert.equal(r.firstRow, 8); // linha 10 - 2 de buffer
  assert.equal(r.lastRow, 14); // ceil(2184/182)=12 linhas visíveis + 2 de buffer
});

test('computeVisibleRange: fim da lista trava em rows-1, não escapa além do total', () => {
  const itemCount = 15000;
  const cols = 8;
  const rows = Math.ceil(itemCount / cols); // 1875
  const rowHeight = 182;
  const r = LibraryView.computeVisibleRange({
    scrollTop: rows * rowHeight, // rolado muito além do fim
    viewHeight: 500,
    rowHeight,
    cols,
    itemCount,
    bufferRows: 2,
  });
  assert.equal(r.lastRow, rows - 1);
  assert.equal(r.lastIndex, itemCount - 1);
});

test('computeVisibleRange: lista vazia não produz linhas (lastRow menor que firstRow)', () => {
  const r = LibraryView.computeVisibleRange({ scrollTop: 0, viewHeight: 500, rowHeight: 182, cols: 8, itemCount: 0, bufferRows: 2 });
  assert.equal(r.rows, 0);
  assert.ok(r.lastRow < r.firstRow);
});

test('computeVisibleRange: a janela visível (sem contar o buffer) cresce com 15 mil itens sem depender do total', () => {
  // A quantidade de linhas RENDERIZADAS depende só da altura do viewport, não
  // do tamanho da biblioteca — é isso que torna o custo por frame de scroll
  // independente de ter 2 mil ou 15 mil designs.
  const args = { scrollTop: 2000, viewHeight: 600, rowHeight: 182, cols: 8, bufferRows: 2 };
  const small = LibraryView.computeVisibleRange({ ...args, itemCount: 2000 });
  const big = LibraryView.computeVisibleRange({ ...args, itemCount: 15000 });
  assert.equal(big.lastRow - big.firstRow, small.lastRow - small.firstRow);
});

test('computeVisibleRange: cols fracionário/zero é normalizado para um inteiro >= 1', () => {
  const r = LibraryView.computeVisibleRange({ scrollTop: 0, viewHeight: 300, rowHeight: 182, cols: 0, itemCount: 10, bufferRows: 0 });
  assert.equal(r.cols, 1);
});
