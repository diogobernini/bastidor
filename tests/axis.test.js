'use strict';
// Testes do eixo principal por PCA (issue #70, src/core/digitize/axis.js):
// autovetor do maior autovalor = direção do eixo longo; proporção entre
// autovalores (raiz quadrada) = aspecto comprimento/largura; ponderação por
// comprimento de aresta (reamostragem por comprimento de arco, não pelos
// vértices originais) evita que um trecho denso de vértices puxe o eixo
// pra si. regions.test.js cobre o USO desse eixo (limiar, ângulo por
// região); aqui só a geometria da PCA em si.

const test = require('node:test');
const assert = require('node:assert');

const { principalAxisOfRing, ringPerimeter, sampleRingByArcLength } = require('../src/core/digitize/axis');

function rotateDeg(pts, deg) {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return pts.map(([x, y]) => [x * c - y * s, x * s + y * c]);
}

// Normaliza um ângulo (mod 180, a direção de um eixo não tem "lado") pra
// [0, 180) antes de comparar — evita falso negativo por -90 vs 90, ou
// 179.9 vs 0.1, que são o MESMO eixo.
function normalizeAxisAngle(deg) {
  let a = deg % 180;
  if (a < 0) a += 180;
  return a;
}

function angleDiff(a, b) {
  const d = Math.abs(normalizeAxisAngle(a) - normalizeAxisAngle(b));
  return Math.min(d, 180 - d);
}

// Barra 100 (comprimento) x 10 (largura) centrada na origem, pronta pra
// rotacionar por rotateDeg.
const BAR_100X10 = [[-50, -5], [50, -5], [50, 5], [-50, 5]];

function circleRing(r, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

// ------------------------------------------------------------- PCA ponderada

test('principalAxisOfRing: barra rotada 37° dá eixo ~37° (mod 180)', () => {
  const rotated = rotateDeg(BAR_100X10, 37);
  const result = principalAxisOfRing(rotated);
  assert.ok(result, 'esperava um eixo válido pra um retângulo simples');
  assert.ok(angleDiff(result.angleDeg, 37) < 0.5, `eixo esperado ~37°, veio ${result.angleDeg}`);
  // O aspecto é sobre o CONTORNO (perímetro), não a área: as 2 arestas
  // curtas (comprimento 10, em x=±50) contribuem cada uma um ponto inteiro
  // "no extremo" de X (variância a², não a²/3 como daria uma distribuição
  // uniforme preenchendo a área) — por isso o aspecto sai MENOR que o 10:1
  // geométrico da barra. Valor teórico pra 100x10 (dedução: Var(X) =
  // f_h·a²/3 + f_v·a²; Var(Y) = f_h·b² + f_v·b²/3, com f_h/f_v a fração do
  // perímetro em arestas longas/curtas) ≈ 6,476 — o que já importa aqui é
  // que fica bem acima do limiar de 3:1 usado por regions.js.
  assert.ok(Math.abs(result.aspect - 6.476) < 0.1, `aspecto esperado ~6,48 (contorno, não área), veio ${result.aspect}`);
});

test('principalAxisOfRing: eixo não depende do sentido em que a barra foi rotacionada (± mesmo ângulo)', () => {
  const plus = principalAxisOfRing(rotateDeg(BAR_100X10, 37));
  const minus = principalAxisOfRing(rotateDeg(BAR_100X10, 37 + 180));
  assert.ok(angleDiff(plus.angleDeg, minus.angleDeg) < 0.5, 'o eixo de uma reta não tem lado — 37° e 217° são o mesmo eixo');
});

// Requisito central da issue #70: "amostrar os segmentos, não só os
// vértices, para polígonos com densidade de vértice irregular" — insere 79
// vértices REDUNDANTES (colineares, não mudam a forma) numa única aresta
// longa da barra e confirma que o eixo calculado não se move: se a PCA
// pesasse por VÉRTICE em vez de por comprimento de arco, essa aresta densa
// dominaria a covariância e puxaria o eixo pra perto de si.
test('principalAxisOfRing: ponderado por comprimento de aresta — vértices redundantes numa aresta não deslocam o eixo', () => {
  const base = rotateDeg(BAR_100X10, 37);
  const baseline = principalAxisOfRing(base);

  const [a, b] = [base[0], base[1]]; // uma das arestas longas (comprimento 100)
  const extra = [];
  for (let k = 1; k < 80; k++) {
    const t = k / 80;
    extra.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  const densified = [base[0], ...extra, ...base.slice(1)];

  const withExtraVertices = principalAxisOfRing(densified);
  assert.ok(
    angleDiff(withExtraVertices.angleDeg, baseline.angleDeg) < 1,
    `eixo mudou com vértices redundantes: base=${baseline.angleDeg} vs denso=${withExtraVertices.angleDeg}`
  );
  assert.ok(
    Math.abs(withExtraVertices.aspect - baseline.aspect) < 0.5,
    `aspecto mudou com vértices redundantes: base=${baseline.aspect} vs denso=${withExtraVertices.aspect}`
  );
});

test('sampleRingByArcLength: aresta longa recebe proporcionalmente mais amostras que uma curta', () => {
  // retângulo 100 x 10: aresta longa tem 10x o comprimento da curta, então
  // (dentro do arredondamento de amostras por aresta) deveria receber ~10x
  // mais amostras.
  const samples = sampleRingByArcLength(BAR_100X10, 220); // perímetro 220 -> passo 1
  // as arestas longas são as horizontais (y constante em -5 ou 5); conta
  // quantas amostras caem em cada uma das 2 arestas longas vs as 2 curtas.
  let onLong = 0;
  let onShort = 0;
  for (const [x, y] of samples) {
    if (Math.abs(y) > 4.99) onLong++;
    else onShort++;
  }
  assert.ok(onLong > onShort * 5, `esperava a soma das arestas longas dominar: longas=${onLong} curtas=${onShort}`);
});

// ------------------------------------------------------------------- aspecto

test('principalAxisOfRing: círculo tem aspecto ~1 (abaixo do limiar de 3:1 usado por regions.js)', () => {
  const result = principalAxisOfRing(circleRing(50, 48));
  assert.ok(result, 'esperava um eixo válido pra um círculo (é só um polígono regular)');
  assert.ok(Math.abs(result.aspect - 1) < 0.05, `esperava aspecto ~1, veio ${result.aspect}`);
});

test('principalAxisOfRing: quadrado tem aspecto ~1', () => {
  const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const result = principalAxisOfRing(square);
  assert.ok(Math.abs(result.aspect - 1) < 1e-6, `esperava aspecto exatamente 1 (simetria perfeita), veio ${result.aspect}`);
});

// --------------------------------------------------------------- degenerado

test('principalAxisOfRing: anel com menos de 3 pontos devolve null', () => {
  assert.equal(principalAxisOfRing([[0, 0], [1, 1]]), null);
  assert.equal(principalAxisOfRing([]), null);
  assert.equal(principalAxisOfRing(null), null);
});

test('principalAxisOfRing: anel com perímetro ~0 (todos os pontos coincidentes) devolve null', () => {
  const collapsed = [[5, 5], [5, 5], [5, 5]];
  assert.equal(principalAxisOfRing(collapsed), null);
});

test('ringPerimeter: soma o comprimento das arestas, fechando do último pro primeiro ponto', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(ringPerimeter(square), 40);
});
