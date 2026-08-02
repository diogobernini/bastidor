'use strict';
// Testes dos geradores expressivos de preenchimento (issue #77, fase C):
// motiffill, meanderfill, crosshatchfill, radialfill, gradientfill e
// guidedfill — módulos PUROS com o contrato `generate(regionRings, opts) ->
// runs[]` (regionRings = anéis de UMA região: rings[0] é sempre o contorno
// externo, os demais são furos, mesma convenção de
// regions.groupRingsIntoRegions; opts = {rowSpacing, stitchLength, angleDeg,
// params}, distâncias em 0,1mm). Sem integração de UI/registry aqui (fica
// pra depois do merge da #76) — só os módulos e estes testes.
//
// Por gerador: runs não vazias, todos os pontos dentro da região (fixture
// com furo), um teste de espaçamento específico do estilo de cada gerador,
// determinismo (duas chamadas idênticas => mesmo resultado) e um smoke test
// com uma região côncava em L. Também alguns testes diretos do util
// compartilhado (fillextras-util) — não é um gerador, mas é dependência
// nova de todos os 6 e vale testar isoladamente.

const test = require('node:test');
const assert = require('node:assert');

const fillextrasUtil = require('../src/core/digitize/fillextras-util');
const motiffill = require('../src/core/digitize/motiffill');
const meanderfill = require('../src/core/digitize/meanderfill');
const crosshatchfill = require('../src/core/digitize/crosshatchfill');
const radialfill = require('../src/core/digitize/radialfill');
const gradientfill = require('../src/core/digitize/gradientfill');
const guidedfill = require('../src/core/digitize/guidedfill');
const { fillPolygonsTatami } = require('../src/core/digitize/fill');
const { isInsideRegion } = require('../src/core/digitize/regions');

const MM = 10; // 1 mm = 10 unidades internas (0,1 mm) — mesma convenção do resto do projeto.

// ---------------------------------------------------------------- fixtures

// Quadrado de 40mm com um furo quadrado de 10mm centrado — mesmos números de
// tests/digitize.test.js e tests/regions.test.js pra "região com furo".
// regionRings[0] = contorno externo, regionRings[1] = furo.
const SQUARE_SIZE = 400; // 40mm
const HOLE = { minX: 150, maxX: 250, minY: 150, maxY: 250 }; // furo de 10mm, centrado
function squareWithHoleRings() {
  const outer = [[0, 0], [SQUARE_SIZE, 0], [SQUARE_SIZE, SQUARE_SIZE], [0, SQUARE_SIZE]];
  const hole = [[HOLE.minX, HOLE.minY], [HOLE.maxX, HOLE.minY], [HOLE.maxX, HOLE.maxY], [HOLE.minX, HOLE.maxY]];
  return [outer, hole];
}

// O quadrado sem o furo — usado nos testes de espaçamento onde o furo
// introduziria ambiguidade geométrica que não é o que aquele teste específico
// quer isolar (ex.: nº de segmentos por raio no radialfill, ou "quantas
// fileiras distintas saíram" no meander/guided). A verificação "todos os
// pontos dentro da região" de cada gerador usa squareWithHoleRings, como
// pedido; os testes de espaçamento usam a fixture mais simples que ainda
// exercita a mesma mecânica.
function plainSquareRings() {
  return [[[0, 0], [SQUARE_SIZE, 0], [SQUARE_SIZE, SQUARE_SIZE], [0, SQUARE_SIZE]]];
}

// Região em L (côncava, vértice reflexo em (100,100)): barra vertical
// [0,100]x[0,300] unida a uma barra horizontal [0,300]x[0,100]. Sem furo. O
// centróide de área desta forma cai em (110,110) — DENTRO do vão do L, fora
// da própria região (ver teste de fillextras-util.regionCentroid abaixo) —
// exercita de propósito o caso "centróide fora da região" que radialfill.js
// documenta tratar sem nenhum caso especial.
function lShapeRings() {
  return [[[0, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300]]];
}

// Tolerância geométrica dos testes (0,005mm): bem maior que qualquer erro de
// ponto flutuante ou de convergência de bisseção esperado (bisectBoundary
// converge a bem menos que isso em poucas iterações — ver comentário de
// clipOpenPolylineToRegion em fillextras-util.js), bem menor que qualquer
// defeito geométrico real (um ponto realmente errado erra por unidades
// inteiras, não centésimos).
const GEOM_EPS = 0.05;

function pointOkSquareWithHole([x, y]) {
  const inOuter = x >= -GEOM_EPS && x <= SQUARE_SIZE + GEOM_EPS && y >= -GEOM_EPS && y <= SQUARE_SIZE + GEOM_EPS;
  const inHole = x > HOLE.minX + GEOM_EPS && x < HOLE.maxX - GEOM_EPS && y > HOLE.minY + GEOM_EPS && y < HOLE.maxY - GEOM_EPS;
  return inOuter && !inHole;
}

function pointOkLShape([x, y]) {
  const inVerticalBar = x >= -GEOM_EPS && x <= 100 + GEOM_EPS && y >= -GEOM_EPS && y <= 300 + GEOM_EPS;
  const inHorizontalBar = x >= -GEOM_EPS && x <= 300 + GEOM_EPS && y >= -GEOM_EPS && y <= 100 + GEOM_EPS;
  return inVerticalBar || inHorizontalBar;
}

function allPointsOk(runs, predicate) {
  for (const run of runs) {
    for (const p of run) {
      if (!predicate(p)) return false;
    }
  }
  return true;
}

function totalPoints(runs) {
  return runs.reduce((sum, r) => sum + r.length, 0);
}

// Cópia profunda simples (só arrays/números/objetos planos, o suficiente pra
// regionRings/opts) — usada nos testes de determinismo pra garantir que as
// duas chamadas de generate() recebem estruturas INDEPENDENTES, então um
// eventual mutation-in-place (que o contrato "puro" da issue #77 proíbe, mas
// um teste não devia simplesmente confiar de olhos fechados) não mascararia
// uma diferença real entre as duas chamadas.
function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

// Agrupa valores (ex.: Y de cada fileira) em clusters por proximidade (dois
// valores ficam no mesmo cluster se a diferença for <= tol) e devolve a
// MÉDIA de cada cluster, ordenada crescente — reconstrói "quais fileiras
// distintas saíram no resultado" a partir de pontos com eventual ruído de
// ponto flutuante entre pontos da mesma fileira/cópia.
function clusterValues(values, tol) {
  const sorted = values.slice().sort((a, b) => a - b);
  const clusters = [];
  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && v - last[last.length - 1] <= tol) last.push(v);
    else clusters.push([v]);
  }
  return clusters.map((c) => c.reduce((s, x) => s + x, 0) / c.length);
}

function diffs(sortedValues) {
  const out = [];
  for (let i = 1; i < sortedValues.length; i++) out.push(sortedValues[i] - sortedValues[i - 1]);
  return out;
}

// ------------------------------------------------------------ fillextras-util
//
// fillextras-util NÃO é um gerador (não exporta `generate`), mas é
// dependência nova compartilhada pelos 6 — um teste direto e enxuto das
// peças menos triviais (hash determinístico, centróide com furos, recorte de
// polilinha aberta) reduz o risco de um bug aí se espalhar silenciosamente
// pelos 6 geradores.

test('fillextras-util.hashJitter: determinístico e sempre em [0,1)', () => {
  for (let i = 0; i < 50; i++) {
    const a = fillextrasUtil.hashJitter(i, 7);
    const b = fillextrasUtil.hashJitter(i, 7);
    assert.equal(a, b, 'mesma chamada com os mesmos argumentos devia dar o mesmo valor');
    assert.ok(a >= 0 && a < 1, `hashJitter fora de [0,1): ${a}`);
  }
  const distinct = new Set();
  for (let s = 0; s < 5; s++) distinct.add(fillextrasUtil.hashJitter(3, s));
  assert.ok(distinct.size > 1, 'salts diferentes deveriam gerar valores diferentes pelo menos às vezes');
});

test('fillextras-util.regionCentroid: quadrado simples dá o centro geométrico', () => {
  const rings = plainSquareRings();
  const [cx, cy] = fillextrasUtil.regionCentroid(rings);
  assert.ok(Math.abs(cx - SQUARE_SIZE / 2) < 1e-6);
  assert.ok(Math.abs(cy - SQUARE_SIZE / 2) < 1e-6);
});

test('fillextras-util.regionCentroid: região em L dá (110,110), fora da própria região', () => {
  const rings = lShapeRings();
  const [cx, cy] = fillextrasUtil.regionCentroid(rings);
  assert.ok(Math.abs(cx - 110) < 1e-6 && Math.abs(cy - 110) < 1e-6, `esperava (110,110), veio (${cx},${cy})`);
  assert.ok(!isInsideRegion([cx, cy], { rings }), 'o centróide do L deveria cair no vão (fora da região)');
});

test('fillextras-util.outerRadiusFrom: alcança o vértice mais distante e nunca devolve 0', () => {
  const rings = plainSquareRings();
  const center = [SQUARE_SIZE / 2, SQUARE_SIZE / 2];
  const r = fillextrasUtil.outerRadiusFrom(rings, center);
  const expected = Math.hypot(SQUARE_SIZE / 2, SQUARE_SIZE / 2);
  assert.ok(Math.abs(r - expected) < 1e-6);
  assert.equal(fillextrasUtil.outerRadiusFrom([], [0, 0]), 1, 'sem anéis, devolve o piso de 1');
});

test('fillextras-util.resamplePolylineAt: nenhum segmento passa do passo, último ponto é exato', () => {
  const pts = [[0, 0], [37, 0], [37, 62], [90, 62]];
  const step = 10;
  const out = fillextrasUtil.resamplePolylineAt(pts, step);
  assert.ok(out.length >= 2);
  for (let i = 1; i < out.length; i++) {
    const d = fillextrasUtil.dist(out[i], out[i - 1]);
    assert.ok(d <= step + 1e-6, `segmento ${d} maior que o passo ${step}`);
  }
  assert.deepEqual(out[out.length - 1], pts[pts.length - 1]);
});

test('fillextras-util.clipOpenPolylineToRegion: linha que cruza um furo vira 2 corridas, tudo dentro', () => {
  const rings = squareWithHoleRings();
  const region = { rings };
  const line = [];
  for (let x = 0; x <= 400; x += 5) line.push([x, 200]); // atravessa o furo (y=200 cai em [150,250])
  const runs = fillextrasUtil.clipOpenPolylineToRegion(line, region);
  assert.equal(runs.length, 2, 'devia cortar em 2 trechos (antes e depois do furo)');
  for (const run of runs) {
    assert.ok(run.length >= 2);
    for (const p of run) assert.ok(pointOkSquareWithHole(p), `ponto (${p}) fora da região/dentro do furo`);
  }
});

test('fillextras-util.reverseRuns: inverte ordem das corridas E dos pontos de cada uma, sem mutar o original', () => {
  const runs = [[[0, 0], [1, 0], [2, 0]], [[10, 10], [11, 10]]];
  const rev = fillextrasUtil.reverseRuns(runs);
  assert.deepEqual(rev, [[[11, 10], [10, 10]], [[2, 0], [1, 0], [0, 0]]]);
  assert.deepEqual(runs, [[[0, 0], [1, 0], [2, 0]], [[10, 10], [11, 10]]]);
});

// ------------------------------------------------------------------- motiffill

test('motiffill: runs não vazias e todo carimbo fica dentro da região (fixture com furo)', () => {
  const rings = squareWithHoleRings();
  const runs = motiffill.generate(rings, {
    rowSpacing: 4,
    stitchLength: 30,
    angleDeg: 0,
    params: { motif: 'heart', motifSizeMm: 3 },
  });
  assert.ok(runs.length > 0, 'esperava ao menos um carimbo');
  assert.ok(totalPoints(runs) > 0);
  assert.ok(allPointsOk(runs, pointOkSquareWithHole), 'algum ponto de motif caiu fora da região ou dentro do furo');
});

test('motiffill: espaçamento respeitado — nenhum par de carimbos mais perto que a célula efetiva', () => {
  const rings = plainSquareRings();
  const rowSpacing = 6 * MM; // 6mm, bem maior que o motivo — domina o max(rowSpacing, diâmetro*1.15)
  const motifSizeMm = 3;
  const runs = motiffill.generate(rings, {
    rowSpacing,
    stitchLength: 30,
    angleDeg: 0,
    params: { motif: 'leaf', motifSizeMm },
  });
  assert.ok(runs.length >= 4, 'esperava vários carimbos numa região de 40mm com célula de 6mm');

  // Cada carimbo é o mesmo template deslocado/rotacionado por uma
  // transformação LINEAR (sem termo de translação: unrotatePoint é só
  // rotação) do centro de grade + o mesmo deslocamento constante em todos os
  // carimbos — então a distância entre CENTROIDES de dois carimbos é
  // exatamente a distância entre os centros de grade deles, independente da
  // assimetria do motivo. O mínimo entre centros de grade da malha
  // escalonada (stagger 1/2 célula) é a própria célula (vizinhos na mesma
  // fileira); vizinhos na fileira ao lado, por causa do stagger, ficam mais
  // longe (~1.118x a célula) — então cellSpacing é mesmo o piso esperado.
  const cellSpacing = Math.max(rowSpacing, motifSizeMm * MM * 1.15);
  const centroids = runs.map((run) => {
    const sx = run.reduce((s, p) => s + p[0], 0) / run.length;
    const sy = run.reduce((s, p) => s + p[1], 0) / run.length;
    return [sx, sy];
  });
  let minDist = Infinity;
  for (let i = 0; i < centroids.length; i++) {
    for (let j = i + 1; j < centroids.length; j++) {
      const d = Math.hypot(centroids[i][0] - centroids[j][0], centroids[i][1] - centroids[j][1]);
      if (d < minDist) minDist = d;
    }
  }
  assert.ok(minDist >= cellSpacing - 1e-6, `dois carimbos mais próximos que a célula: ${minDist} < ${cellSpacing}`);
});

test('motiffill: determinismo — duas chamadas idênticas dão o mesmo resultado', () => {
  const opts = { rowSpacing: 5, stitchLength: 25, angleDeg: 20, params: { motif: 'wave', motifSizeMm: 4 } };
  const rings = squareWithHoleRings();
  const runs1 = motiffill.generate(deepClone(rings), deepClone(opts));
  const runs2 = motiffill.generate(deepClone(rings), deepClone(opts));
  assert.deepEqual(runs1, runs2);
});

test('motiffill: smoke com região côncava em L — ainda carimba dentro da região', () => {
  const rings = lShapeRings();
  const runs = motiffill.generate(rings, {
    rowSpacing: 3,
    stitchLength: 25,
    angleDeg: 0,
    params: { motif: 'heart', motifSizeMm: 2 },
  });
  assert.ok(runs.length > 0, 'esperava ao menos um carimbo cabendo numa das barras do L');
  assert.ok(allPointsOk(runs, pointOkLShape));
});

// ----------------------------------------------------------------- meanderfill

test('meanderfill: runs não vazias e toda a ondulação fica dentro da região (fixture com furo)', () => {
  const rings = squareWithHoleRings();
  const runs = meanderfill.generate(rings, {
    rowSpacing: 25, // 2,5mm — dentro da faixa decorativa pedida (2-4mm)
    stitchLength: 20,
    angleDeg: 0,
    params: { waveAmpMm: 1 },
  });
  assert.ok(runs.length > 0);
  assert.ok(allPointsOk(runs, pointOkSquareWithHole), 'algum ponto da onda caiu fora da região ou dentro do furo');
});

test('meanderfill: espaçamento entre fileiras respeita rowSpacing (pontas de cada vão têm amplitude zero)', () => {
  const rings = plainSquareRings();
  const rowSpacing = 25;
  const runs = meanderfill.generate(rings, {
    rowSpacing,
    stitchLength: 20,
    angleDeg: 0,
    params: { waveAmpMm: 1 },
  });
  assert.ok(runs.length > 1);
  // O primeiro ponto de cada corrida está numa das pontas do vão, onde o
  // envelope da onda é zero por construção (ver wavePoint em meanderfill.js)
  // — o Y desse ponto é exatamente o Y da fileira (linha de base), sem
  // ruído da onda.
  const rowYs = clusterValues(runs.map((run) => run[0][1]), 1e-3);
  assert.ok(rowYs.length >= 2, 'esperava ao menos 2 fileiras distintas');
  for (const d of diffs(rowYs)) {
    assert.ok(Math.abs(d - rowSpacing) < 1e-3, `espaçamento entre fileiras ${d} != ${rowSpacing}`);
  }
});

test('meanderfill: rowSpacing pedido abaixo do piso decorativo (2mm) é elevado ao piso', () => {
  const rings = plainSquareRings();
  const runs = meanderfill.generate(rings, { rowSpacing: 1, stitchLength: 20, angleDeg: 0, params: {} });
  const rowYs = clusterValues(runs.map((run) => run[0][1]), 1e-3);
  assert.ok(rowYs.length > 1);
  for (const d of diffs(rowYs)) assert.ok(Math.abs(d - 2 * MM) < 1e-3, `esperava piso de 20 (2mm), veio ${d}`);
});

test('meanderfill: determinismo — duas chamadas idênticas dão o mesmo resultado', () => {
  const opts = { rowSpacing: 30, stitchLength: 22, angleDeg: 15, params: { waveAmpMm: 1.5 } };
  const rings = squareWithHoleRings();
  const runs1 = meanderfill.generate(deepClone(rings), deepClone(opts));
  const runs2 = meanderfill.generate(deepClone(rings), deepClone(opts));
  assert.deepEqual(runs1, runs2);
});

test('meanderfill: smoke com região côncava em L', () => {
  const rings = lShapeRings();
  const runs = meanderfill.generate(rings, { rowSpacing: 25, stitchLength: 20, angleDeg: 0, params: { waveAmpMm: 1 } });
  assert.ok(runs.length > 0);
  assert.ok(allPointsOk(runs, pointOkLShape));
});

// --------------------------------------------------------------- crosshatchfill

test('crosshatchfill: runs não vazias e todo ponto fica dentro da região (fixture com furo)', () => {
  const rings = squareWithHoleRings();
  const runs = crosshatchfill.generate(rings, { rowSpacing: 4, stitchLength: 30, angleDeg: 0, params: {} });
  assert.ok(runs.length > 0);
  assert.ok(allPointsOk(runs, pointOkSquareWithHole));
});

test('crosshatchfill: as duas passadas saem a ±45° (padrão) com o DOBRO do rowSpacing pedido', () => {
  const rings = squareWithHoleRings();
  const rowSpacing = 4;
  const stitchLength = 30;
  const runs = crosshatchfill.generate(rings, { rowSpacing, stitchLength, angleDeg: 0, params: {} });

  // Recomputa as duas passadas diretamente com fillPolygonsTatami (a mesma
  // função que o módulo usa por dentro) nos ângulos/espaçamento que a issue
  // #77 pede pro crosshatch. Uma eventual reversão de uma das passadas
  // (closerEnd, pra continuidade) só reordena pontos, nunca muda o CONJUNTO
  // de pontos — comparar como conjunto é robusto a qual das duas ordens saiu
  // sem precisar reimplementar a lógica de closerEnd aqui.
  const pass1 = fillPolygonsTatami(rings, { angleDeg: -45, rowSpacing: rowSpacing * 2, stitchLength });
  const pass2 = fillPolygonsTatami(rings, { angleDeg: 45, rowSpacing: rowSpacing * 2, stitchLength });
  const keyOf = (p) => p[0].toFixed(6) + ',' + p[1].toFixed(6);
  const expectedKeys = new Set();
  for (const run of pass1.concat(pass2)) for (const p of run) expectedKeys.add(keyOf(p));

  const actualKeys = new Set();
  for (const run of runs) for (const p of run) actualKeys.add(keyOf(p));

  assert.equal(actualKeys.size, expectedKeys.size, 'nº de pontos distintos difere do esperado (±45°, 2x espaçamento)');
  for (const k of expectedKeys) assert.ok(actualKeys.has(k), `ponto esperado ${k} não saiu no resultado`);
});

test('crosshatchfill: params.crossAngleDeg troca o meio-ângulo entre as passadas', () => {
  const rings = plainSquareRings();
  const rowSpacing = 4;
  const stitchLength = 30;
  const runs = crosshatchfill.generate(rings, {
    rowSpacing,
    stitchLength,
    angleDeg: 10,
    params: { crossAngleDeg: 30 },
  });
  const pass1 = fillPolygonsTatami(rings, { angleDeg: 10 - 30, rowSpacing: rowSpacing * 2, stitchLength });
  const pass2 = fillPolygonsTatami(rings, { angleDeg: 10 + 30, rowSpacing: rowSpacing * 2, stitchLength });
  const keyOf = (p) => p[0].toFixed(6) + ',' + p[1].toFixed(6);
  const expectedKeys = new Set();
  for (const run of pass1.concat(pass2)) for (const p of run) expectedKeys.add(keyOf(p));
  const actualKeys = new Set();
  for (const run of runs) for (const p of run) actualKeys.add(keyOf(p));
  assert.equal(actualKeys.size, expectedKeys.size);
  for (const k of expectedKeys) assert.ok(actualKeys.has(k));
});

test('crosshatchfill: determinismo — duas chamadas idênticas dão o mesmo resultado', () => {
  const opts = { rowSpacing: 5, stitchLength: 28, angleDeg: 12, params: { crossAngleDeg: 30 } };
  const rings = squareWithHoleRings();
  const runs1 = crosshatchfill.generate(deepClone(rings), deepClone(opts));
  const runs2 = crosshatchfill.generate(deepClone(rings), deepClone(opts));
  assert.deepEqual(runs1, runs2);
});

test('crosshatchfill: smoke com região côncava em L', () => {
  const rings = lShapeRings();
  const runs = crosshatchfill.generate(rings, { rowSpacing: 3, stitchLength: 25, angleDeg: 0, params: {} });
  assert.ok(runs.length > 0);
  assert.ok(allPointsOk(runs, pointOkLShape));
});

// ------------------------------------------------------------------ radialfill

test('radialfill: runs não vazias e todo ponto fica dentro da região (fixture com furo; centróide cai no furo)', () => {
  const rings = squareWithHoleRings(); // furo centrado => centróide da região cai bem no meio do furo
  const runs = radialfill.generate(rings, { rowSpacing: 4, stitchLength: 30, angleDeg: 0 });
  assert.ok(runs.length > 0);
  assert.ok(allPointsOk(runs, pointOkSquareWithHole));
});

test('radialfill: raios ficam espaçados angularmente pelo passo derivado de rowSpacing/raio externo', () => {
  const rings = plainSquareRings(); // sem furo: cada raio que toca a região gera exatamente 1 segmento
  const rowSpacing = 4;
  const runs = radialfill.generate(rings, { rowSpacing, stitchLength: 30, angleDeg: 0 });

  const center = fillextrasUtil.regionCentroid(rings);
  const outerRadius = fillextrasUtil.outerRadiusFrom(rings, center);
  const targetArc = rowSpacing * 2;
  let numSpokes = Math.round((2 * Math.PI) / (targetArc / outerRadius));
  numSpokes = Math.max(8, Math.min(720, numSpokes));
  const angleStep = (2 * Math.PI) / numSpokes;

  assert.ok(Math.abs(runs.length - numSpokes) <= 2, `esperava ~${numSpokes} raios, vieram ${runs.length}`);

  const angles = runs.map((run) => {
    // Qualquer ponto de uma corrida serve (todos caem na mesma reta que
    // passa pelo centro — ver comentário de radialfill.js); usa o mais
    // distante do centro só por robustez (evita instabilidade de ângulo num
    // ponto bem colado no próprio centro).
    let best = run[0];
    let bestD = 0;
    for (const p of run) {
      const d = Math.hypot(p[0] - center[0], p[1] - center[1]);
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
    return Math.atan2(best[1] - center[1], best[0] - center[0]);
  });
  const sorted = angles.map((a) => (a < 0 ? a + 2 * Math.PI : a)).sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 2 * Math.PI;
    const gap = next - sorted[i];
    const steps = Math.round(gap / angleStep);
    assert.ok(steps >= 1, `gap angular ${gap} menor que um passo (${angleStep})`);
    assert.ok(
      Math.abs(gap - steps * angleStep) < angleStep * 0.2,
      `gap angular ${gap} não é um múltiplo próximo do passo ${angleStep}`
    );
  }
});

test('radialfill: determinismo — duas chamadas idênticas dão o mesmo resultado', () => {
  const opts = { rowSpacing: 5, stitchLength: 25, angleDeg: 30 };
  const rings = squareWithHoleRings();
  const runs1 = radialfill.generate(deepClone(rings), deepClone(opts));
  const runs2 = radialfill.generate(deepClone(rings), deepClone(opts));
  assert.deepEqual(runs1, runs2);
});

test('radialfill: smoke com região côncava em L (centróide de área cai FORA da região, no vão)', () => {
  const rings = lShapeRings();
  const runs = radialfill.generate(rings, { rowSpacing: 3, stitchLength: 25, angleDeg: 0 });
  assert.ok(runs.length > 0, 'mesmo com o centróide fora da região, algum raio deve alcançar as barras do L');
  assert.ok(allPointsOk(runs, pointOkLShape));
});

// ----------------------------------------------------------------- gradientfill

test('gradientfill: runs não vazias e todo ponto fica dentro da região (fixture com furo)', () => {
  const rings = squareWithHoleRings();
  const runs = gradientfill.generate(rings, {
    rowSpacing: 4,
    stitchLength: 30,
    angleDeg: 0,
    params: { spacingFromMm: 0.5, spacingToMm: 2, gradientAngleDeg: 90 },
  });
  assert.ok(runs.length > 0);
  assert.ok(allPointsOk(runs, pointOkSquareWithHole));
});

test('gradientfill: espaçamento entre fileiras cresce de spacingFromMm a spacingToMm ao longo do gradiente', () => {
  const rings = squareWithHoleRings();
  const spacingFromMm = 0.5;
  const spacingToMm = 2;
  const runs = gradientfill.generate(rings, {
    rowSpacing: 4, // não lido por este gerador (só usa params.spacingFrom/ToMm) — mantido só pra preencher o contrato de opts
    stitchLength: 20,
    angleDeg: 0,
    params: { spacingFromMm, spacingToMm, gradientAngleDeg: 90 },
  });
  const rowYs = clusterValues(runs.map((run) => run[0][1]), 1e-3);
  assert.ok(rowYs.length >= 5, 'esperava várias fileiras distintas numa região de 40mm');
  const gaps = diffs(rowYs);
  const spacingFrom = spacingFromMm * MM;
  const spacingTo = spacingToMm * MM;
  // Monotônico não decrescente: gradientAngleDeg=90 alinha o eixo do
  // gradiente ao próprio empilhamento das fileiras (Y), então o espaçamento
  // só deveria crescer conforme Y cresce.
  for (let i = 1; i < gaps.length; i++) {
    assert.ok(gaps[i] >= gaps[i - 1] - 1e-6, `espaçamento deveria crescer (ou empatar): ${gaps[i - 1]} -> ${gaps[i]}`);
  }
  assert.ok(
    Math.abs(gaps[0] - spacingFrom) < 0.5,
    `primeira fileira devia ficar perto de spacingFromMm: ${gaps[0]} vs ${spacingFrom}`
  );
  assert.ok(
    gaps[gaps.length - 1] > spacingFrom + (spacingTo - spacingFrom) * 0.3,
    'gradiente deveria ter avançado bem além do espaçamento inicial'
  );
  assert.ok(
    gaps[gaps.length - 1] <= spacingTo + 0.5,
    `última fileira não devia passar de spacingToMm: ${gaps[gaps.length - 1]} vs ${spacingTo}`
  );
});

test('gradientfill: determinismo — duas chamadas idênticas dão o mesmo resultado', () => {
  const opts = {
    rowSpacing: 4,
    stitchLength: 25,
    angleDeg: 10,
    params: { spacingFromMm: 0.4, spacingToMm: 1, gradientAngleDeg: 100 },
  };
  const rings = squareWithHoleRings();
  const runs1 = gradientfill.generate(deepClone(rings), deepClone(opts));
  const runs2 = gradientfill.generate(deepClone(rings), deepClone(opts));
  assert.deepEqual(runs1, runs2);
});

test('gradientfill: smoke com região côncava em L', () => {
  const rings = lShapeRings();
  const runs = gradientfill.generate(rings, {
    rowSpacing: 3,
    stitchLength: 25,
    angleDeg: 0,
    params: { spacingFromMm: 0.4, spacingToMm: 1.2, gradientAngleDeg: 90 },
  });
  assert.ok(runs.length > 0);
  assert.ok(allPointsOk(runs, pointOkLShape));
});

// ------------------------------------------------------------------- guidedfill

test('guidedfill: runs não vazias, todo ponto dentro da região, e a guia é cortada pelo furo (fixture com furo)', () => {
  const rings = squareWithHoleRings();
  const runs = guidedfill.generate(rings, {
    rowSpacing: 20,
    stitchLength: 20,
    angleDeg: 0,
    params: { guidePath: [[0, 200], [400, 200]] }, // horizontal, atravessa o furo (y=200 cai em [150,250])
  });
  assert.ok(runs.length > 0);
  assert.ok(allPointsOk(runs, pointOkSquareWithHole));

  // A cópia k=0 (a guia original, sem deslocamento) passa exatamente em
  // y=200 — reta, então todo ponto dela (inclusive os de bisseção no corte)
  // fica com y=200 exato. Ela deveria ter saído partida em (pelo menos) um
  // trecho de cada lado do furo.
  const row200Runs = runs.filter((run) => Math.abs(run[0][1] - 200) < 1e-3);
  assert.ok(row200Runs.length >= 2, 'a cópia na altura do furo (y=200) deveria sair partida em pelo menos 2 corridas');
  const hasLeftSide = row200Runs.some((run) => run.every((p) => p[0] <= HOLE.minX + GEOM_EPS));
  const hasRightSide = row200Runs.some((run) => run.every((p) => p[0] >= HOLE.maxX - GEOM_EPS));
  assert.ok(hasLeftSide && hasRightSide, 'esperava um trecho de cada lado do furo na altura y=200');
});

test('guidedfill: cópias deslocadas por rowSpacing ao longo da normal (guia reta => fileiras retas espaçadas por rowSpacing)', () => {
  const rings = plainSquareRings();
  const rowSpacing = 20;
  const runs = guidedfill.generate(rings, {
    rowSpacing,
    stitchLength: 15,
    angleDeg: 0,
    params: { guidePath: [[0, 200], [400, 200]] }, // guia reta horizontal
  });
  assert.ok(runs.length > 1);
  for (const run of runs) {
    const ys = run.map((p) => p[1]);
    const spread = Math.max(...ys) - Math.min(...ys);
    assert.ok(spread < 1e-3, `corrida devia ser perfeitamente horizontal (guia reta, normal vertical): variação de Y ${spread}`);
  }
  const rowYs = clusterValues(runs.map((run) => run[0][1]), 1e-3);
  assert.ok(rowYs.length >= 3, 'esperava várias cópias da guia dentro do quadrado');
  for (const d of diffs(rowYs)) {
    assert.ok(Math.abs(d - rowSpacing) < 1e-3, `espaçamento entre cópias ${d} != ${rowSpacing}`);
  }
});

test('guidedfill: sem guidePath válido cai pro fallback (reta horizontal pelo centróide) sem lançar exceção', () => {
  const rings = plainSquareRings();
  const runs = guidedfill.generate(rings, { rowSpacing: 20, stitchLength: 20, angleDeg: 0, params: {} });
  assert.ok(runs.length > 0);
  assert.ok(
    allPointsOk(runs, ([x, y]) => x >= -GEOM_EPS && x <= SQUARE_SIZE + GEOM_EPS && y >= -GEOM_EPS && y <= SQUARE_SIZE + GEOM_EPS)
  );
});

test('guidedfill: determinismo — duas chamadas idênticas dão o mesmo resultado', () => {
  const opts = {
    rowSpacing: 15,
    stitchLength: 18,
    angleDeg: 0,
    params: { guidePath: [[20, 20], [200, 80], [380, 30]] },
  };
  const rings = squareWithHoleRings();
  const runs1 = guidedfill.generate(deepClone(rings), deepClone(opts));
  const runs2 = guidedfill.generate(deepClone(rings), deepClone(opts));
  assert.deepEqual(runs1, runs2);
});

test('guidedfill: smoke com região côncava em L (guia default cai no vão, mas ainda cobre parte da região)', () => {
  const rings = lShapeRings();
  const runs = guidedfill.generate(rings, { rowSpacing: 15, stitchLength: 15, angleDeg: 0, params: {} });
  assert.ok(runs.length > 0);
  assert.ok(allPointsOk(runs, pointOkLShape));
});
