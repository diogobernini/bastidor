'use strict';
// Testes do clamp de posição da prévia da biblioteca (issue #38): dado um
// retângulo de referência (o card sob o mouse), o tamanho do card flutuante
// e a viewport, clampToViewport devolve left/top que cabem na tela.

const test = require('node:test');
const assert = require('node:assert');

const { clampToViewport } = require('../src/core/viewportclamp');

const VIEWPORT = { width: 1200, height: 800 };
const POP = { width: 334, height: 380 };

test('abre à direita do card quando há espaço', () => {
  const anchor = { left: 100, top: 100, right: 200, bottom: 160 };
  const { left, top } = clampToViewport(anchor, POP, VIEWPORT);
  assert.equal(left, anchor.right + 10);
  assert.equal(top, anchor.top - 20);
});

test('sem espaço à direita, abre à esquerda do card', () => {
  // card perto da borda direita: à direita não cabe (right+10+334 > 1200-8)
  const anchor = { left: 950, top: 100, right: 1050, bottom: 160 };
  const { left } = clampToViewport(anchor, POP, VIEWPORT);
  assert.equal(left, anchor.left - POP.width - 10);
});

test('depois de trocar de lado, ainda reclampa contra a borda direita (não só a esquerda)', () => {
  // Card perto da borda direita, com gap=0: o cálculo ingênuo (só clampar
  // o lado esquerdo com Math.max) trocaria de lado e pararia em left=61,
  // vazando 3px pela direita (61 + 334 = 395 > 400 - 8 = 392). O teto
  // (Math.min contra maxLeft) evita esse vazamento residual pós-troca.
  const vw = { width: 400, height: 800 };
  const anchor = { left: 395, top: 100, right: 398, bottom: 160 };
  const { left } = clampToViewport(anchor, POP, vw, { gap: 0 });
  assert.equal(left, 58); // maxLeft = max(8, 400 - 334 - 8) = 58
  assert.ok(left + POP.width <= vw.width - 8, `left=${left} + pw=${POP.width} deveria caber em ${vw.width - 8}`);
});

test('card perto do topo: não deixa o popup subir além da margem', () => {
  const anchor = { left: 100, top: 2, right: 200, bottom: 40 };
  const { top } = clampToViewport(anchor, POP, VIEWPORT);
  assert.equal(top, 8);
});

test('card perto do fundo: não deixa o popup vazar embaixo', () => {
  const anchor = { left: 100, top: 780, right: 200, bottom: 800 };
  const { top } = clampToViewport(anchor, POP, VIEWPORT);
  assert.ok(top + POP.height <= VIEWPORT.height - 8, `top=${top} + ph=${POP.height} deveria caber em ${VIEWPORT.height - 8}`);
});

test('card perto do canto inferior direito: cabe nos dois eixos', () => {
  const anchor = { left: 1100, top: 770, right: 1180, bottom: 800 };
  const { left, top } = clampToViewport(anchor, POP, VIEWPORT);
  assert.ok(left >= 8 && left + POP.width <= VIEWPORT.width - 8 + 1e-9);
  assert.ok(top >= 8 && top + POP.height <= VIEWPORT.height - 8);
});

test('respeita opts customizados (gap, margin, verticalOffset)', () => {
  const anchor = { left: 100, top: 100, right: 200, bottom: 160 };
  const { left, top } = clampToViewport(anchor, POP, VIEWPORT, { gap: 20, margin: 4, verticalOffset: 5 });
  assert.equal(left, anchor.right + 20);
  assert.equal(top, anchor.top - 5);
});

test('popup maior que a viewport: melhor esforço, ainda ancorado na margem', () => {
  const tinyViewport = { width: 200, height: 200 };
  const anchor = { left: 50, top: 50, right: 100, bottom: 100 };
  const { left, top } = clampToViewport(anchor, POP, tinyViewport);
  assert.equal(left, 8); // não há posição sem vazamento; cai para a margem
  assert.equal(top, 8);
});
