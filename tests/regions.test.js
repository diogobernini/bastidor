'use strict';
// Testes do roteamento de preenchimento por região (issue #67, consolida o
// forensics da issue #64): agrupamento de anéis em regiões conexas por
// contenção, travel dentro da região sem sair dela, ordenação por vizinho
// mais próximo, nunca deixar salto de distância zero, e a integração
// completa comparando o número de saltos do fill antigo (scanline global)
// com o novo (por região) em fixtures de regiões desconexas.

const test = require('node:test');
const assert = require('node:assert');

const {
  groupRingsIntoRegions,
  orderRegionsByProximity,
  findTravelPath,
  fillRegionsTatami,
  coalesceZeroGapRuns,
  isInsideRegion,
} = require('../src/core/digitize/regions');
const { fillPolygonsTatami } = require('../src/core/digitize/fill');
const C = require('../src/core/commands');
const { Pattern } = require('../src/core/pattern');

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// Constrói um Pattern exatamente como os chamadores reais (index.js/
// raster.js/stitcher.js: emitRuns/emitFillGlyph) fazem: salto até o início
// de cada corrida, ponto até o fim de cada uma.
function buildPattern(runs) {
  const pattern = new Pattern();
  pattern.addThread('#000000');
  for (const run of runs) {
    if (!run.length) continue;
    pattern.moveAbs(run[0][0], run[0][1]);
    for (let i = 1; i < run.length; i++) pattern.stitchAbs(run[i][0], run[i][1]);
  }
  pattern.end();
  return pattern;
}

// Conta transições SALTO -> PONTO (início de cada corrida de fato gravada no
// Pattern) e detecta saltos de deslocamento (0,0) — a assinatura exata do
// arquivo da issue #64 que quebrou agulhas na máquina física.
function analyzePattern(pattern) {
  let jumpToStitch = 0;
  let zeroLengthJumps = 0;
  let prevWasJump = false;
  let px = null;
  let py = null;
  for (const st of pattern.stitches) {
    const cmd = st[2] & C.COMMAND_MASK;
    if (cmd === C.JUMP) {
      if (px !== null && Math.hypot(st[0] - px, st[1] - py) <= 1e-6) zeroLengthJumps++;
      prevWasJump = true;
    } else if (cmd === C.STITCH) {
      if (prevWasJump) jumpToStitch++;
      prevWasJump = false;
    } else {
      prevWasJump = false;
    }
    px = st[0];
    py = st[1];
  }
  return { jumpToStitch, zeroLengthJumps };
}

// ---------------------------------------------------- 1) agrupar em regiões

test('groupRingsIntoRegions: contorno externo + 1 furo vira 1 região com 2 anéis', () => {
  const outer = [[0, 0], [400, 0], [400, 400], [0, 400]];
  const hole = [[150, 150], [250, 150], [250, 250], [150, 250]];
  const rs = groupRingsIntoRegions([{ points: outer }, { points: hole }]);
  assert.equal(rs.length, 1, 'externo+furo deveria ser 1 região só');
  assert.equal(rs[0].rings.length, 2);
  assert.deepEqual(rs[0].rings[0], outer, 'o contorno externo deveria vir primeiro');
  assert.deepEqual(rs[0].rings[1], hole, 'o furo deveria estar junto na mesma região');
});

test('groupRingsIntoRegions: 3 ilhas desconexas viram 3 regiões, cada uma com 1 anel (sem furo)', () => {
  const r1 = [[0, 0], [100, 0], [100, 400], [0, 400]];
  const r2 = [[200, 0], [300, 0], [300, 400], [200, 400]];
  const r3 = [[400, 0], [500, 0], [500, 400], [400, 400]];
  const rs = groupRingsIntoRegions([{ points: r1 }, { points: r2 }, { points: r3 }]);
  assert.equal(rs.length, 3);
  for (const r of rs) assert.equal(r.rings.length, 1, 'ilha simples não devia ganhar furo nenhum');
});

test('groupRingsIntoRegions: ilha preenchida DENTRO de um furo é sua própria região (aninhamento de 3 níveis)', () => {
  const outer = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]];
  const hole = [[200, 200], [800, 200], [800, 800], [200, 800]];
  const island = [[400, 400], [600, 400], [600, 600], [400, 600]];
  const rs = groupRingsIntoRegions([{ points: outer }, { points: hole }, { points: island }]);
  assert.equal(rs.length, 2, 'outer+hole é uma região; a ilha dentro do furo é outra região');
  const byRingCount = rs.slice().sort((a, b) => a.rings.length - b.rings.length);
  assert.equal(byRingCount[0].rings.length, 1, 'a região da ilha tem só o anel dela (não é furo de ninguém)');
  assert.equal(byRingCount[1].rings.length, 2, 'a região externa tem o contorno + o furo');
});

test('groupRingsIntoRegions: contorno externo côncavo (forma em ponte) ainda agrupa o furo corretamente', () => {
  // Quadrado com uma mordida rectangular no meio do topo (vértice reflexo de
  // propósito) — exercita o ponto de amostra interno em anel não convexo.
  const outerBridge = [
    [0, 0], [300, 0], [300, 300], [200, 300], [200, 100], [100, 100], [100, 300], [0, 300],
  ];
  const hole = [[20, 20], [80, 20], [80, 80], [20, 80]]; // dentro da perna esquerda, fora da mordida
  const rs = groupRingsIntoRegions([{ points: outerBridge }, { points: hole }]);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].rings.length, 2);
});

test('groupRingsIntoRegions: entrada vazia ou sem anéis válidos devolve []', () => {
  assert.deepEqual(groupRingsIntoRegions([]), []);
  assert.deepEqual(groupRingsIntoRegions([{ points: [[0, 0], [1, 1]] }]), []); // <3 pontos
});

// ---------------------------------------------------- 2) travel dentro da região

test('findTravelPath: linha reta é rejeitada se cruzar um furo; o desvio pela borda não sai da região', () => {
  const outer = [[0, 0], [400, 0], [400, 400], [0, 400]];
  const hole = [[150, 150], [250, 150], [250, 250], [150, 250]];
  const region = { rings: [outer, hole] };
  const stitchLength = 30;

  // Pontas exatamente sobre a borda do furo, como saem de spansAtY numa
  // fileira que cruza o furo (fim do vão esquerdo, início do vão direito).
  const from = [150, 180];
  const to = [250, 180];

  const midpoint = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  assert.ok(!isInsideRegion(midpoint, region), 'sanity: o meio do caminho reto cai dentro do furo (fora da região)');

  const travel = findTravelPath(from, to, region, stitchLength);
  assert.ok(travel, 'deveria achar um caminho pela borda do furo (from/to no mesmo anel)');

  const full = [from, ...travel, to];
  for (const p of full) {
    const insideHole = p[0] > 150 + 1e-6 && p[0] < 250 - 1e-6 && p[1] > 150 + 1e-6 && p[1] < 250 - 1e-6;
    assert.ok(!insideHole, `ponto de travel (${p}) caiu dentro do furo`);
    assert.ok(
      p[0] >= -1e-6 && p[0] <= 400 + 1e-6 && p[1] >= -1e-6 && p[1] <= 400 + 1e-6,
      `ponto de travel (${p}) saiu do contorno externo`
    );
  }
  for (let i = 1; i < full.length; i++) {
    assert.ok(dist(full[i - 1], full[i]) <= stitchLength + 1e-6, `segmento do travel maior que ${stitchLength}`);
  }
});

test('findTravelPath: liga direto por linha reta quando o caminho não cruza nenhum furo', () => {
  const outer = [[0, 0], [400, 0], [400, 400], [0, 400]];
  const hole = [[150, 150], [250, 150], [250, 250], [150, 250]];
  const region = { rings: [outer, hole] };
  const travel = findTravelPath([10, 0], [390, 0], region, 30);
  assert.ok(travel, 'trecho ao longo da borda superior, longe do furo, devia caber em linha reta');
});

test('findTravelPath: sem linha reta e em anéis diferentes (externo x furo) devolve null — quem chama mantém o salto', () => {
  const outer = [[0, 0], [400, 0], [400, 400], [0, 400]];
  const hole = [[150, 150], [250, 150], [250, 250], [150, 250]];
  const region = { rings: [outer, hole] };
  // "from" apoiado na borda do furo; "to" apoiado na borda do contorno
  // externo, na mesma altura Y do furo — a reta entre eles atravessa o furo
  // (sem caminho válido) e não há caminho de borda ligando dois anéis
  // diferentes (não são a mesma curva fechada).
  const travel = findTravelPath([150, 160], [400, 160], region, 30);
  assert.equal(travel, null);
});

// ---------------------------------------------------- 3) ordenar por proximidade

test('orderRegionsByProximity: vizinho mais próximo, greedy, a partir do ponto inicial', () => {
  const near = { rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]] };
  const mid = { rings: [[[50, 0], [60, 0], [60, 10], [50, 10]]] };
  const far = { rings: [[[100, 0], [110, 0], [110, 10], [100, 10]]] };

  const order = orderRegionsByProximity([far, near, mid], [0, 0]);
  assert.deepEqual(order, [near, mid, far], 'a partir de [0,0]: perto, meio, longe, nessa ordem');
});

test('orderRegionsByProximity: ponto inicial é opcional (default [0,0])', () => {
  const a = { rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]] };
  const b = { rings: [[[100, 0], [110, 0], [110, 10], [100, 10]]] };
  const order = orderRegionsByProximity([b, a]);
  assert.deepEqual(order, [a, b]);
});

test('orderRegionsByProximity: lista vazia devolve []', () => {
  assert.deepEqual(orderRegionsByProximity([], [0, 0]), []);
});

// ---------------------------------------------------- nunca salto de distância zero

test('coalesceZeroGapRuns: funde corridas cujo fim/início coincidem, nunca deixando salto de distância zero', () => {
  const runs = [
    [[0, 0], [10, 0]],
    [[10, 0], [20, 0]], // começa exatamente onde a anterior termina
    [[30, 0], [40, 0]], // gap real de 10, permanece separado
  ];
  const out = coalesceZeroGapRuns(runs);
  assert.equal(out.length, 2, 'as duas primeiras corridas deveriam colar numa só');
  assert.deepEqual(out[0], [[0, 0], [10, 0], [20, 0]]);
  for (let i = 1; i < out.length; i++) {
    const gap = dist(out[i - 1][out[i - 1].length - 1], out[i][0]);
    assert.ok(gap > 1e-6, 'nenhuma transição entre corridas devia ter distância zero');
  }
});

// ---------------------------------------------------- integração

test('integração: 3 retângulos desconexos da mesma cor — saltos despencam de ~2/fileira pra ~1/região', () => {
  const MM = 10;
  const wMm = 10;
  const hMm = 40;
  const gapMm = 10;
  const w = wMm * MM;
  const h = hMm * MM;
  const gap = gapMm * MM;
  const rects = [0, 1, 2].map((i) => {
    const x0 = i * (w + gap);
    return [[x0, 0], [x0 + w, 0], [x0 + w, h], [x0, h]];
  });
  const polygons = rects.map((r) => ({ points: r }));
  const opts = { angleDeg: 0, rowSpacing: 0.4 * MM, stitchLength: 3 * MM };

  const oldRuns = fillPolygonsTatami(polygons, opts);
  const regionList = groupRingsIntoRegions(polygons);
  const newRuns = fillRegionsTatami(polygons, opts);

  assert.equal(regionList.length, 3, 'os 3 retângulos deveriam formar 3 regiões (sem furos, sem contenção)');

  // Fill antigo: cada fileira cruza as 3 ilhas, ~2 saltos novos por fileira
  // (40mm / 0,4mm = 100 fileiras) -> ordem de ~200 corridas/saltos.
  assert.ok(oldRuns.length > 150, `esperava o fill antigo bem acima de 150 saltos, veio ${oldRuns.length}`);

  // Fill novo: uma região por vez; cada retângulo simples fecha numa corrida
  // só -> exatamente 1 salto por região (nenhuma transição extra dentro).
  assert.equal(
    newRuns.length,
    regionList.length,
    `esperava 1 corrida por região (${regionList.length}), veio ${newRuns.length}`
  );

  // Queda dramática, bem além da meta ~10x citada na issue.
  assert.ok(
    oldRuns.length >= newRuns.length * 20,
    `esperava o novo ser pelo menos 20x menor: antigo=${oldRuns.length} novo=${newRuns.length}`
  );

  // Nenhum ponto de nenhuma corrida escapa para fora de algum dos 3 retângulos.
  for (const run of newRuns) {
    for (const [x, y] of run) {
      const insideAny = rects.some((r) => x >= r[0][0] - 1e-6 && x <= r[1][0] + 1e-6 && y >= -1e-6 && y <= h + 1e-6);
      assert.ok(insideAny, `ponto (${x},${y}) caiu fora dos 3 retângulos`);
    }
  }

  // --- critérios da issue #64 (forensics do arquivo que quebrou agulhas) ---
  const pattern = buildPattern(newRuns);
  const { jumpToStitch, zeroLengthJumps } = analyzePattern(pattern);
  assert.equal(zeroLengthJumps, 0, 'nenhum salto pode ter deslocamento (0,0)');
  // "Salto só ao entrar em cada região": no máximo 1 transição salto->ponto
  // por região (nenhuma alternância salto-ponto-salto-ponto dentro de uma
  // região só, a assinatura do defeito na máquina física).
  assert.ok(
    jumpToStitch <= regionList.length,
    `esperava no máx. 1 transição salto->ponto por região (${regionList.length}), veio ${jumpToStitch}`
  );
});

test('integração: região com furo também cai de várias corridas pra uma só, sem vazar pro furo nem soltar salto zero', () => {
  const outer = [[0, 0], [400, 0], [400, 400], [0, 400]];
  const hole = [[150, 150], [250, 150], [250, 250], [150, 250]];
  const polygons = [{ points: outer }, { points: hole }];
  const opts = { angleDeg: 0, rowSpacing: 4, stitchLength: 30 };

  const oldRuns = fillPolygonsTatami(polygons, opts);
  const newRuns = fillRegionsTatami(polygons, opts);

  assert.ok(oldRuns.length > 10, `esperava o fill antigo com bastante corridas (o furo força saltos), veio ${oldRuns.length}`);
  assert.ok(newRuns.length < oldRuns.length, 'o travel dentro da região deveria reduzir as corridas');

  for (const run of newRuns) {
    for (const [x, y] of run) {
      const insideHole = x > 150 + 1e-6 && x < 250 - 1e-6 && y > 150 + 1e-6 && y < 250 - 1e-6;
      assert.ok(!insideHole, `ponto (${x},${y}) do travel caiu dentro do furo`);
    }
  }

  const pattern = buildPattern(newRuns);
  const { zeroLengthJumps } = analyzePattern(pattern);
  assert.equal(zeroLengthJumps, 0);
});

test('fillRegionsTatami: sem anéis válidos devolve []', () => {
  assert.deepEqual(fillRegionsTatami([], { stitchLength: 30 }), []);
});

test('fillRegionsTatami: respeita startPoint pra decidir qual região vem primeiro', () => {
  const rectA = [[0, 0], [40, 0], [40, 40], [0, 40]]; // perto de [0,0]
  const rectB = [[500, 0], [540, 0], [540, 40], [500, 40]]; // longe
  const opts = { angleDeg: 0, rowSpacing: 4, stitchLength: 30 };

  const fromNearA = fillRegionsTatami([{ points: rectA }, { points: rectB }], { ...opts, startPoint: [0, 0] });
  const fromNearB = fillRegionsTatami([{ points: rectA }, { points: rectB }], { ...opts, startPoint: [540, 40] });

  assert.ok(fromNearA[0][0][0] <= 40 + 1e-6, 'partindo perto de A, a 1a corrida devia começar em A');
  assert.ok(fromNearB[0][0][0] >= 500 - 1e-6, 'partindo perto de B, a 1a corrida devia começar em B');
});

// ---------------------------------------------------------------- hotfixes

test('anéis não laminares (se cruzam) não derrubam o agrupamento nem o fill', () => {
  // Reprodução do "TypeError: ... (reading 'rings')" do digitize:generate:
  // Y cruza X (amostra de Y cai dentro de X → profundidade ímpar) e Z está
  // dentro APENAS de Y — o "contêiner imediato" de Z tinha profundidade
  // ímpar, não era raiz de região nenhuma e o acesso caía em undefined.
  const X = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const Y = [[60, 20], [160, 20], [160, 80], [60, 80]];
  const Z = [[120, 40], [140, 40], [140, 60], [120, 60]];
  const regs = groupRingsIntoRegions([X, Y, Z]);
  assert.ok(regs.length >= 2, 'agrupou sem derrubar');
  const runs = fillRegionsTatami([X, Y, Z], { rowSpacing: 4, stitchLength: 30 });
  assert.ok(runs.length > 0, 'preencheu sem exceção');
});

test('corridas gigantes não estouram a pilha (sem spread em push)', () => {
  // Reprodução do "RangeError: Maximum call stack size exceeded" do
  // svg:import: corridas com dezenas de milhares de pontos coladas com
  // push(...run) estouram o limite de argumentos do V8.
  const big = (offset) => Array.from({ length: 150000 }, (_, i) => [offset + i * 0.01, 0]);
  const a = big(0);
  const b = big(a[a.length - 1][0]); // começa onde a termina (gap 0)
  b[0] = a[a.length - 1].slice();
  const out = coalesceZeroGapRuns([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 299999);
});

test('retângulo grande e denso digitaliza inteiro sem exceção', () => {
  const rect = [[0, 0], [3000, 0], [3000, 3000], [0, 3000]];
  const runs = fillRegionsTatami([rect], { rowSpacing: 4, stitchLength: 30 });
  const total = runs.reduce((s, r) => s + r.length, 0);
  assert.ok(total > 60000, `esperava corrida gigante, veio ${total}`);
});
