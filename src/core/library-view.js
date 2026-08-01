'use strict';
// Matemática pura da grade virtualizada da biblioteca (issue #35): dado o
// scroll atual e as dimensões da grade, quais linhas/índices precisam de nó
// no DOM. Sem DOM, sem Node — só aritmética — para poder testar com 10-15
// mil itens sem precisar montar a janela real. Mesmo espírito de
// src/core/spatial.js: carregado tanto por <script src="../core/library-view.js">
// (antes de renderer.js) quanto por node:test via module.exports.

const LibraryView = (function () {
  // Quantas colunas cabem numa largura de viewport dada a largura do item, o
  // espaçamento entre itens e o padding total (esquerda+direita) do viewport.
  // Mesma fórmula usada antes inline em libraryGridCols().
  function computeCols(viewportWidth, itemWidth, gap, paddingTotal) {
    const width = Math.max(0, (viewportWidth || 0) - (paddingTotal || 0));
    return Math.max(1, Math.floor((width + gap) / (itemWidth + gap)));
  }

  // Dado scrollTop/altura visível/altura de linha/colunas/total de itens,
  // devolve só o intervalo de linhas (e o índice de item correspondente) que
  // precisa existir no DOM agora — o resto fica só na altura do "spacer",
  // que mantém a barra de rolagem do tamanho certo sem os nós.
  function computeVisibleRange(opts) {
    const itemCount = Math.max(0, opts.itemCount || 0);
    const cols = Math.max(1, Math.floor(opts.cols) || 1);
    const rowHeight = opts.rowHeight;
    const bufferRows = Math.max(0, opts.bufferRows || 0);
    const rows = Math.ceil(itemCount / cols);

    if (rows <= 0) {
      return { rows: 0, cols, firstRow: 0, lastRow: -1, firstIndex: 0, lastIndex: -1 };
    }

    const scrollTop = Math.max(0, opts.scrollTop || 0);
    const viewHeight = Math.max(0, opts.viewHeight || 0);
    const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - bufferRows);
    const lastRow = Math.min(rows - 1, Math.ceil((scrollTop + viewHeight) / rowHeight) + bufferRows);

    return {
      rows,
      cols,
      firstRow,
      lastRow,
      firstIndex: firstRow * cols,
      lastIndex: Math.min(itemCount - 1, lastRow * cols + cols - 1),
    };
  }

  return { computeCols, computeVisibleRange };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LibraryView;
}
