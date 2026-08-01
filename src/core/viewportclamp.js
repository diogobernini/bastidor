'use strict';
// Clamp de posição para cards flutuantes (issue #38): a prévia grande da
// biblioteca ao passar o mouse (lib-hover) é posicionada perto do card sob o
// cursor, mas perto das bordas da janela pode vazar da viewport. Módulo puro
// (sem DOM): recebe os retângulos já medidos e devolve left/top que cabem na
// tela. Mesmo espírito de src/core/spatial.js — dois exports, um para os
// testes em node:test (module.exports) e outro para o <script> clássico em
// src/renderer/index.html, antes de renderer.js (window.ViewportClamp), já
// que scripts clássicos compartilham o escopo global e não têm require/import.

const ViewportClamp = (function () {
  // anchor: {left, top, right, bottom} do elemento de referência (o card sob
  // o mouse). Aceita tanto um objeto simples quanto o DOMRect de
  // getBoundingClientRect() (mesmos nomes de propriedade).
  // size: {width, height} do card flutuante já renderizado (medir com
  // offsetWidth/offsetHeight, não supor um valor fixo — é o que vazava antes).
  // viewport: {width, height} da janela (window.innerWidth/innerHeight).
  // opts: gap (distância do anchor ao abrir à direita/esquerda), margin
  // (respiro mínimo até a borda da janela), verticalOffset (deslocamento
  // vertical preferido em relação ao topo do anchor).
  function clampToViewport(anchor, size, viewport, opts) {
    const gap = (opts && opts.gap) ?? 10;
    const margin = (opts && opts.margin) ?? 8;
    const verticalOffset = (opts && opts.verticalOffset) ?? 20;
    const pw = size.width;
    const ph = size.height;
    const vw = viewport.width;
    const vh = viewport.height;

    // Preferência: abre à direita do card; sem espaço, tenta à esquerda.
    let left = anchor.right + gap;
    if (left + pw > vw - margin) left = anchor.left - pw - gap;
    // Sempre dentro da janela nos dois eixos — mesmo se nem a direita nem a
    // esquerda coubessem por completo (melhor esforço quando o card flutuante
    // é mais largo que a própria janela).
    const maxLeft = Math.max(margin, vw - pw - margin);
    left = Math.min(Math.max(left, margin), maxLeft);

    let top = anchor.top - verticalOffset;
    const maxTop = Math.max(margin, vh - ph - margin);
    top = Math.min(Math.max(top, margin), maxTop);

    return { left, top };
  }

  return { clampToViewport };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ViewportClamp;
}
if (typeof window !== 'undefined') {
  window.ViewportClamp = ViewportClamp;
}
