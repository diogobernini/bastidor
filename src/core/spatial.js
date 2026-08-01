'use strict';
// Utilidades espaciais para a edição individual de pontos (issue #3).
// Módulo puro (sem DOM, sem Node): stitches é o array [x, y, cmd] do design,
// nas mesmas unidades (0,1 mm). Além de exportar via module.exports (para os
// testes em node:test), este arquivo também é carregado direto por
// <script src="../core/spatial.js"> em src/renderer/index.html, antes de
// renderer.js — por isso fica tudo dentro de uma IIFE: scripts clássicos
// compartilham o mesmo escopo de topo da página, e nomes como STITCH já
// existem em renderer.js. Só o "const Spatial" final escapa da IIFE.

const Spatial = (function () {
  const STITCH = 0; // igual a src/core/commands.js; duplicado para não criar dependência.

  // Agrupa os índices dos pontos por célula de uma grade de lado `cellSize`,
  // para que a busca do vizinho mais próximo varra só as 9 células ao redor
  // do alvo em vez dos N pontos inteiros.
  function buildGrid(stitches, cellSize) {
    const grid = new Map();
    for (let i = 0; i < stitches.length; i++) {
      const key = cellKey(stitches[i][0], stitches[i][1], cellSize);
      const bucket = grid.get(key);
      if (bucket) bucket.push(i);
      else grid.set(key, [i]);
    }
    return grid;
  }

  function cellKey(x, y, cellSize) {
    return Math.floor(x / cellSize) + ',' + Math.floor(y / cellSize);
  }

  // Retorna o índice do ponto mais próximo de (x, y) dentro do raio maxDist,
  // ou -1 se a lista estiver vazia ou nenhum ponto estiver perto o bastante.
  function nearestStitch(stitches, x, y, maxDist) {
    if (!stitches || stitches.length === 0) return -1;
    const radius = maxDist > 0 ? maxDist : 1e-6;
    const grid = buildGrid(stitches, radius);
    const maxDistSq = radius * radius;
    const cx = Math.floor(x / radius);
    const cy = Math.floor(y / radius);

    let best = -1;
    let bestDistSq = Infinity;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.get(gx + ',' + gy);
        if (!bucket) continue;
        for (const i of bucket) {
          const dx = stitches[i][0] - x;
          const dy = stitches[i][1] - y;
          const distSq = dx * dx + dy * dy;
          if (distSq <= maxDistSq && distSq < bestDistSq) {
            bestDistSq = distSq;
            best = i;
          }
        }
      }
    }
    return best;
  }

  // Insere um ponto STITCH no meio do segmento entre os índices `index` e
  // `index + 1`, mutando `stitches` no lugar (igual a Pattern#insertStitchRel).
  // Retorna o índice do novo ponto, ou -1 se não houver um próximo ponto.
  function insertMidpoint(stitches, index) {
    if (!stitches || index < 0 || index >= stitches.length - 1) return -1;
    const a = stitches[index];
    const b = stitches[index + 1];
    const mx = Math.round((a[0] + b[0]) / 2);
    const my = Math.round((a[1] + b[1]) / 2);
    stitches.splice(index + 1, 0, [mx, my, STITCH]);
    return index + 1;
  }

  return { nearestStitch, insertMidpoint };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Spatial;
}
