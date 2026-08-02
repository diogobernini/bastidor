'use strict';
// Eixo principal de um anel (issue #70): pra decidir o ângulo de varredura
// automático por região (ver regions.js), precisamos saber pra que lado uma
// forma "aponta" e quão alongada ela é. PCA (componentes principais) sobre
// os pontos do CONTORNO responde as duas perguntas de uma vez: o autovetor
// do maior autovalor da matriz de covariância é a direção de maior dispersão
// dos pontos (o eixo longo da forma); a razão entre os dois autovalores
// (raiz quadrada, já que variância escala com o QUADRADO do comprimento)
// aproxima a proporção comprimento/largura.
//
// Ponderação por comprimento de aresta: um anel real (vindo de rastreamento
// de bitmap ou de um path SVG "flattened") quase nunca tem vértices
// uniformemente espaçados — um trecho pode ter uma curva fina cheia de
// vértices e um lado reto que virou 2 vértices só. Calcular a covariância
// direto sobre os VÉRTICES pesaria demais o trecho "cheio de vértice" e
// poria a PCA a serviço da densidade de amostragem do contorno, não da forma
// geométrica real (ver teste "ponderado" em tests/axis.test.js: a mesma
// barra rotada dá o mesmo eixo com ou sem vértices redundantes numa aresta).
// Em vez disso, reamostra o anel em passos de comprimento de arco ~iguais —
// cada aresta contribui um número de amostras proporcional ao SEU comprimento,
// não ao número de vértices originais — e só então acumula média/covariância;
// cada amostra pesa igual, mas cada ARESTA pesa proporcional ao comprimento.
//
// Implementação própria: PCA 2x2 (autovalores/autovetores em forma fechada
// de uma matriz simétrica 2x2, via fórmula quadrática) é álgebra linear de
// livro-texto, não código portado de nenhuma ferramenta de bordado.

const EPS = 1e-9;

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function ringPerimeter(ring) {
  const n = ring.length;
  let total = 0;
  for (let i = 0; i < n; i++) total += dist(ring[i], ring[(i + 1) % n]);
  return total;
}

// Quantas amostras usar no total, independente do tamanho/nº de vértices do
// anel: barato (é só soma/produto por amostra) e preciso o suficiente pra
// PCA — não precisa escalar com a complexidade do polígono.
const SAMPLE_TARGET = 200;

// Amostras ao longo do anel em passos de comprimento de arco ~iguais
// (perimeter/targetSamples): cada aresta recebe round(comprimento/passo)
// amostras (mínimo 1, se tiver comprimento > 0) igualmente espaçadas dentro
// dela mesma — é isso que faz uma aresta longa pesar mais que uma curta na
// covariância final, independente de quantos vértices originais cada uma
// tinha.
function sampleRingByArcLength(ring, targetSamples) {
  const n = ring.length;
  const perimeter = ringPerimeter(ring);
  if (perimeter <= EPS) return [];
  const step = perimeter / targetSamples;
  const samples = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const segLen = dist(a, b);
    if (segLen <= EPS) continue;
    const count = Math.max(1, Math.round(segLen / step));
    for (let k = 0; k < count; k++) {
      const t = k / count;
      samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return samples;
}

// Eixo principal (PCA) do anel: { angleDeg, aspect } —
//
// angleDeg: ângulo (mesma convenção de fill.js/rotatePoint — ver regions.js)
// do autovetor do MAIOR autovalor, a direção ao longo da qual a forma mais
// se espalha; mod 180 (o eixo de uma reta não tem "lado", só direção).
//
// aspect: sqrt(maiorAutovalor / menorAutovalor), a proporção
// comprimento/largura aproximada (a raiz compensa a variância escalar com o
// quadrado da extensão — ver comentário de topo).
//
// null se o anel for degenerado (perímetro ~0, ou menos de 3 vértices, ou
// menos de 2 amostras válidas) — quem chama decide o fallback (regions.js:
// mantém opts.angleDeg global).
function principalAxisOfRing(ring) {
  if (!ring || ring.length < 3) return null;
  const samples = sampleRingByArcLength(ring, SAMPLE_TARGET);
  if (samples.length < 2) return null;

  let mx = 0;
  let my = 0;
  for (const [x, y] of samples) {
    mx += x;
    my += y;
  }
  mx /= samples.length;
  my /= samples.length;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of samples) {
    const dx = x - mx;
    const dy = y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  sxx /= samples.length;
  syy /= samples.length;
  sxy /= samples.length;

  // Autovalores da matriz simétrica 2x2 [[sxx,sxy],[sxy,syy]]: raízes de
  // λ² - tr·λ + det = 0 (fórmula quadrática) — tr/2 ± o discriminante, que
  // pra matriz simétrica real nunca é negativo (clampa em 0 só pra blindar
  // erro de arredondamento de ponto flutuante).
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const lambda1 = tr / 2 + disc; // maior autovalor (eixo longo)
  const lambda2 = tr / 2 - disc; // menor autovalor (eixo curto)

  // Autovetor de lambda1: (lambda1 - syy, sxy) resolve (M - lambda1·I)v = 0
  // e não degenera quando sxy ~ 0 E é o eixo Y que domina (sxx < syy); só
  // degenera (vetor nulo) no outro caso diagonal — sxy ~ 0 E o eixo X que
  // domina — daí o fallback explícito abaixo (forma já alinhada aos eixos).
  let ex;
  let ey;
  if (Math.abs(sxy) > EPS) {
    ex = lambda1 - syy;
    ey = sxy;
  } else if (sxx >= syy) {
    ex = 1;
    ey = 0;
  } else {
    ex = 0;
    ey = 1;
  }
  const len = Math.hypot(ex, ey);
  if (len <= EPS) return null;
  ex /= len;
  ey /= len;

  const angleDeg = (Math.atan2(ey, ex) * 180) / Math.PI;
  const aspect = lambda2 > EPS ? Math.sqrt(lambda1 / lambda2) : Infinity;
  return { angleDeg, aspect };
}

module.exports = { principalAxisOfRing, ringPerimeter, sampleRingByArcLength };
