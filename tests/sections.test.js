'use strict';
// Testes da decomposição em seções monotônicas (issue #69, refina o
// preenchimento "por objeto" da issue #67/#68): dentro de UMA região, o
// preenchimento agora quebra em seções por galho (split/merge por
// sobreposição em X entre fileiras vizinhas), costura cada seção como uma
// serpentina completa sem travel/salto interno, ordena as seções em DFS a
// partir da agulha, liga seções vizinhas com travel sujeito a um teto
// (senão salto), e refina a ordem das REGIÕES com um passe 2-opt por cima
// do greedy de vizinho mais próximo.
//
// Fixtures: um retângulo simples (1 seção); uma letra H (2 furcas: duas
// pernas de cima mergeiam no travessão, que faz split pras duas pernas de
// baixo — 5 seções, 4 arestas, verificado por spansAtY antes de vir pro
// teste); um "boneco de palito" (cabeça+ombros, 2 braços, tronco, 2 pernas)
// construído como um único anel retilíneo (união de retângulos), verificado
// geometricamente (spansAtY em cada faixa, polígono simples sem
// autointersecção) antes de entrar aqui.

const test = require('node:test');
const assert = require('node:assert');

const {
  decomposeSections,
  buildSectionRun,
  orderSectionsByGraph,
  mergeStubRows,
} = require('../src/core/digitize/sections');
const {
  fillRegionsTatami,
  findTravelPath,
  exceedsTravelCeiling,
  orderRegionsByProximity,
  orderRegionsWithTwoOpt,
  connectRuns,
} = require('../src/core/digitize/regions');
const { fillPolygonsTatami } = require('../src/core/digitize/fill');

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function sq(cx, cy, half) {
  return {
    rings: [[[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]]],
  };
}

// Letra H em blocos: duas "pernas" verticais (x[0,20] e x[80,100]) ligadas
// por um travessão central (y[40,60], largura total 0-100). Verificado
// fora deste teste (script ad-hoc): spansAtY dá 2 vãos em y=20 e y=80, 1 vão
// em y=50, é polígono simples (sem autointersecção), 1 região só.
const H_SHAPE = [
  [0, 0], [20, 0], [20, 40], [80, 40], [80, 0], [100, 0], [100, 100],
  [80, 100], [80, 60], [20, 60], [20, 100], [0, 100],
];

// Boneco de palito: cabeça+ombros (x[100,600], y[0,300]) faz split em braço
// esquerdo (x[100,350]) e tronco-A (x[400,900]); tronco-A faz split em
// tronco-B (x[400,650]) e braço direito (x[700,1100]); tronco-B faz split
// em perna esquerda (x[400,500]) e perna direita (x[550,650]). 2 splits
// binários sequenciais no lugar de 1 split ternário — mais fácil de
// verificar à mão (ver script ad-hoc que confirmou spansAtY, área e
// simplicidade do anel antes deste teste).
const STICK_FIGURE = [
  [600, 0], [600, 300], [900, 300], [900, 700], [1100, 700], [1100, 1000], [700, 1000], [700, 700],
  [650, 700], [650, 1000], [650, 1600], [550, 1600], [550, 1000], [500, 1000], [500, 1600], [400, 1600],
  [400, 1000], [400, 700], [400, 300], [350, 300], [350, 700], [100, 700], [100, 300], [100, 0],
];

// ---------------------------------------------------- 1) decompor em seções

test('decomposeSections: retângulo simples vira 1 seção só, sem arestas', () => {
  const region = { rings: [[[0, 0], [400, 0], [400, 400], [0, 400]]] };
  const { sections, edges } = decomposeSections(region, { angleDeg: 0, rowSpacing: 4, stitchLength: 30 });
  assert.equal(sections.length, 1, 'sem split/merge nenhum, é tudo uma seção só');
  assert.equal(edges.length, 0);
  // ~400/4 = 100 fileiras, cada uma com 1 vão -> todas na mesma seção.
  assert.equal(sections[0].rows.length, 100);
});

test('decomposeSections: letra H vira 5 seções (2 pernas de cima + travessão + 2 pernas de baixo) e 4 arestas', () => {
  const region = { rings: [H_SHAPE] };
  const { sections, edges } = decomposeSections(region, { angleDeg: 0, rowSpacing: 4, stitchLength: 8 });
  assert.equal(sections.length, 5, 'perna-cima-esq, perna-cima-dir, travessão, perna-baixo-esq, perna-baixo-dir');
  assert.equal(edges.length, 4, '2 merges das pernas de cima pro travessão + 2 splits do travessão pras pernas de baixo');

  // é uma árvore: com 5 seções e 4 arestas, todo mundo alcançável a partir
  // de qualquer seção (nº de arestas == nº de seções - 1).
  assert.equal(edges.length, sections.length - 1);

  // o travessão (a seção do meio) tem 2 pais (merge) e 2 filhos (split) —
  // é a única seção com grau total 4 nesse grafo pequeno.
  const degree = new Array(sections.length).fill(0);
  for (const e of edges) {
    degree[e.from]++;
    degree[e.to]++;
  }
  assert.equal(degree.filter((d) => d === 4).length, 1, 'exatamente 1 seção (o travessão) tocada pelas 4 arestas');
  assert.equal(degree.filter((d) => d === 1).length, 4, 'as outras 4 seções (as pernas) só tocam 1 aresta cada');
});

test('decomposeSections: boneco de palito (cabeça+ombros, 2 braços, tronco, 2 pernas) gera seções ≈ galhos', () => {
  const region = { rings: [STICK_FIGURE] };
  const { sections, edges } = decomposeSections(region, { angleDeg: 0, rowSpacing: 4, stitchLength: 30 });
  // 6 galhos anatômicos (cabeça, tronco, braço esq, braço dir, perna esq,
  // perna dir); o desenho usa 2 splits binários sequenciais nos ombros em
  // vez de 1 split ternário, então o tronco sai partido em 2 seções — 7 no
  // total, ainda "≈" a contagem de galhos.
  assert.ok(sections.length >= 6, `esperava >=6 seções (≈ galhos), veio ${sections.length}`);
  assert.equal(edges.length, sections.length - 1, 'é uma árvore: todo split/merge alcança todas as seções');

  // nenhuma seção deveria ter mais de ~1/4 do total de fileiras da região
  // (400 unidades / rowSpacing 4 = 400 fileiras) — se a decomposição não
  // estivesse cortando em galhos, o "tronco" sozinho teria centenas de
  // fileiras (é exatamente o defeito que a issue #69 descreve).
  const maxRows = Math.max(...sections.map((s) => s.rows.length));
  assert.ok(maxRows <= 200, `esperava nenhuma seção dominando o desenho inteiro, maior seção tem ${maxRows} fileiras`);
});

test('decomposeSections: sem fileiras válidas (região degenerada) devolve listas vazias', () => {
  const region = { rings: [[[0, 0], [10, 0]]] }; // <3 pontos úteis, sem área
  const { sections, edges } = decomposeSections(region, { rowSpacing: 4, stitchLength: 30 });
  assert.deepEqual(sections, []);
  assert.deepEqual(edges, []);
});

// -------------------------------------------------------- 2) costurar 1 seção

test('buildSectionRun: uma seção sem fileira-toco vira 1 corrida com todos os pontos, sem duplicar', () => {
  const region = { rings: [[[0, 0], [400, 0], [400, 400], [0, 400]]] };
  const { sections } = decomposeSections(region, { angleDeg: 0, rowSpacing: 4, stitchLength: 30 });
  const run = buildSectionRun(sections[0]);
  const totalPoints = sections[0].rows.reduce((n, r) => n + r.points.length, 0);
  assert.equal(run.length, totalPoints, 'nenhum ponto perdido nem duplicado ao concatenar as fileiras');
});

test('mergeStubRows: fileira-toco (<=2 pontos) na ponta funde com a vizinha da mesma seção, não sobra corrida separada', () => {
  // 3 fileiras sintéticas: a primeira é um toco de 1 ponto só; a segunda e
  // a terceira são fileiras normais (>2 pontos).
  const rows = [
    { points: [[10, 0]] },
    { points: [[0, 4], [10, 4], [20, 4]] },
    { points: [[0, 8], [10, 8], [20, 8]] },
  ];
  mergeStubRows(rows);
  assert.equal(rows.length, 2, 'a fileira-toco deixou de existir como entrada própria');
  assert.equal(rows[0].points.length, 4, 'os pontos do toco foram anexados à fileira vizinha (1 + 3)');
  // o ponto do toco entra do lado que encosta na vizinha (mais longe
  // primeiro, mais perto por último, logo antes da vizinha continuar).
  assert.deepEqual(rows[0].points[0], [10, 0]);
});

test('mergeStubRows: toco nas DUAS pontas funde dos dois lados', () => {
  const rows = [
    { points: [[10, 0]] },
    { points: [[0, 4], [10, 4], [20, 4]] },
    { points: [[0, 8], [10, 8], [20, 8]] },
    { points: [[15, 12]] },
  ];
  mergeStubRows(rows);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].points.length, 4);
  assert.equal(rows[1].points.length, 4);
});

test('mergeStubRows: seção com só 1 fileira não tem vizinha — não tenta fundir (e não estoura)', () => {
  const rows = [{ points: [[10, 0]] }];
  assert.doesNotThrow(() => mergeStubRows(rows));
  assert.equal(rows.length, 1);
});

test('mergeStubRows: nenhuma fileira-toco, nada muda', () => {
  const rows = [
    { points: [[0, 0], [10, 0], [20, 0]] },
    { points: [[0, 4], [10, 4], [20, 4]] },
  ];
  const before = JSON.stringify(rows);
  mergeStubRows(rows);
  assert.equal(JSON.stringify(rows), before);
});

// -------------------------------------------------------- 3) ordenar (DFS)

test('orderSectionsByGraph: percorre o grafo em DFS a partir da seção mais próxima da agulha, com orientação', () => {
  const region = { rings: [H_SHAPE] };
  const opts = { angleDeg: 0, rowSpacing: 4, stitchLength: 8 };
  const { sections, edges } = decomposeSections(region, opts);
  const runs = sections.map((s) => buildSectionRun(s));

  const order = orderSectionsByGraph(runs, edges, [0, 0]);
  assert.equal(order.length, sections.length, 'visita toda seção exatamente uma vez');
  const seen = new Set(order.map((o) => o.index));
  assert.equal(seen.size, sections.length, 'sem repetição');

  // a primeira seção visitada é a mais próxima da agulha (perna de cima
  // esquerda, que começa em x=0, perto de [0,0]) — igual ao critério de
  // orderRegionsByProximity, um nível abaixo (dentro da região).
  const firstRun = runs[order[0].index];
  const firstPoint = order[0].reversed ? firstRun[firstRun.length - 1] : firstRun[0];
  assert.ok(dist([0, 0], firstPoint) < 10, 'a primeira seção deveria encostar perto da origem');
});

test('orderSectionsByGraph: cada seção pode ser percorrida ao contrário sem perder nenhum ponto', () => {
  const region = { rings: [H_SHAPE] };
  const opts = { angleDeg: 0, rowSpacing: 4, stitchLength: 8 };
  const { sections, edges } = decomposeSections(region, opts);
  const runs = sections.map((s) => buildSectionRun(s));
  const order = orderSectionsByGraph(runs, edges, [0, 0]);
  for (const { index, reversed } of order) {
    const oriented = reversed ? runs[index].slice().reverse() : runs[index];
    assert.equal(oriented.length, runs[index].length);
  }
});

test('orderSectionsByGraph: lista vazia devolve []', () => {
  assert.deepEqual(orderSectionsByGraph([], [], [0, 0]), []);
});

// --------------------------------------------- 4) travel só nas junções + teto

test('findTravelPath + exceedsTravelCeiling: junção real da letra H aceita travel curto, rejeita o longo (vira salto)', () => {
  // Mesmas duas transições que fillRegion de fato produz pra essa fixture
  // (verificado com o pipeline completo): uma junção curta o bastante pra
  // caber num travel dentro do teto, e uma transição bem mais longa (que
  // exigiria contornar a borda) que o teto corretamente rejeita.
  const region = { rings: [H_SHAPE] };
  const stitchLength = 8;

  const shortGap = { from: [100, 98], to: [80, 38] }; // ~63 unidades, cabe dentro da região em linha reta
  const travelShort = findTravelPath(shortGap.from, shortGap.to, region, stitchLength);
  assert.ok(travelShort, 'devia achar um travel dentro da região pra esse par');
  assert.ok(!exceedsTravelCeiling(shortGap.from, shortGap.to, travelShort), 'travel curto não deveria estourar o teto');

  const longGap = { from: [80, 2], to: [20, 62] }; // ~85 unidades direto, mas só dá pra ligar contornando a borda
  const travelLong = findTravelPath(longGap.from, longGap.to, region, stitchLength);
  assert.ok(travelLong, 'ainda existe UM caminho pela borda (região é conexa)');
  assert.ok(
    exceedsTravelCeiling(longGap.from, longGap.to, travelLong),
    'mas o contorno é longo demais (>150 unidades ou >3x a distância direta) — quem chama deve saltar'
  );
});

test('exceedsTravelCeiling: rejeita só por estourar o teto absoluto (150 unidades), mesmo com direta grande', () => {
  const from = [0, 0];
  const to = [200, 0]; // direta = 200; 3x direta = 600 (não seria o motivo da rejeição)
  const path = [[100, 0]]; // caminho quase reto, comprimento ~200 (> teto absoluto de 150)
  assert.ok(exceedsTravelCeiling(from, to, path), 'ultrapassa o teto absoluto de 150 mesmo sem violar a razão 3x');
});

test('exceedsTravelCeiling: rejeita só por estourar a razão 3x a distância direta, mesmo abaixo do teto absoluto', () => {
  const from = [0, 0];
  const to = [10, 0]; // direta = 10; 3x direta = 30 (bem abaixo do teto absoluto de 150)
  const path = [[0, 20], [20, 20]]; // desvio comprido: comprimento total ~60, > 30 mas < 150
  const len = dist(from, [0, 20]) + dist([0, 20], [20, 20]) + dist([20, 20], to);
  assert.ok(len < 150 && len > 30, 'sanity: comprimento do caminho fica entre os dois tetos');
  assert.ok(exceedsTravelCeiling(from, to, path), 'estoura só a razão 3x, deveria rejeitar mesmo assim');
});

test('exceedsTravelCeiling: aceita travel curto e quase direto (dentro dos dois tetos)', () => {
  const from = [0, 0];
  const to = [10, 0];
  const path = [[5, 1]]; // desvio pequeno, comprimento ~10.2
  assert.ok(!exceedsTravelCeiling(from, to, path));
});

test('travels só nas junções, nunca por fileira: corridas finais ficam na ordem de seções, não de fileiras', () => {
  const opts = { angleDeg: 0, rowSpacing: 4, stitchLength: 8 };
  const oldRuns = fillPolygonsTatami([H_SHAPE], opts);
  const newRuns = fillRegionsTatami([{ points: H_SHAPE }], opts);

  const region = { rings: [H_SHAPE] };
  const { sections } = decomposeSections(region, opts);

  // fill antigo (scanline global): cada fileira com 2 vãos força um salto
  // extra (mesma assinatura da issue #67/#69) -> corridas na faixa das
  // ~20 fileiras da forma, não das 5 seções.
  assert.ok(oldRuns.length > 15, `esperava o fill antigo bem fragmentado (por fileira), veio ${oldRuns.length}`);

  // fill novo (por seção): no máximo 1 corrida nova por TRANSIÇÃO entre
  // seções (nunca por fileira) — bem menos que o nº de fileiras da forma.
  assert.ok(
    newRuns.length <= sections.length,
    `esperava no máx. 1 corrida por seção (${sections.length}), veio ${newRuns.length}`
  );
  assert.ok(newRuns.length < oldRuns.length / 5, 'queda de pelo menos 5x nas corridas finais');
});

// -------------------------------------------------------------- 5) 2-opt

test('orderRegionsWithTwoOpt: com <=2 regiões não faz nada (devolve o greedy como está)', () => {
  const a = sq(0, 0, 2);
  const b = sq(100, 0, 2);
  const greedy1 = orderRegionsByProximity([a], [0, 0]);
  const twoOpt1 = orderRegionsWithTwoOpt([a], [0, 0]);
  assert.deepEqual(twoOpt1, greedy1);

  const greedy2 = orderRegionsByProximity([b, a], [0, 0]);
  const twoOpt2 = orderRegionsWithTwoOpt([b, a], [0, 0]);
  assert.deepEqual(twoOpt2, greedy2, 'com exatamente 2 regiões, 2-opt não tem nada pra trocar');
});

test('orderRegionsWithTwoOpt: com >2 regiões, corrige uma ordem greedy pior que a alternativa (sem salto cruzado)', () => {
  // 5 regiões cuja ordem gulosa (vizinho mais próximo) fica bem pior que a
  // ordem real, encontrada por busca exaustiva (confirmado num script
  // ad-hoc antes deste teste: greedy=189.3, 2-opt=135.3=ótimo de força
  // bruta entre as 120 permutações possíveis).
  const coords = [[2, 22], [-13, -17], [-5, 16], [34, 79], [22, 18]];
  const regions = coords.map(([x, y]) => sq(x, y, 2));
  const start = [0, 0];

  function realCost(order) {
    let cur = start;
    let total = 0;
    for (const r of order) {
      let best = Infinity;
      let bestPoint = cur;
      for (const ring of r.rings) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const lenSq = dx * dx + dy * dy;
          let t = lenSq > 1e-9 ? ((cur[0] - a[0]) * dx + (cur[1] - a[1]) * dy) / lenSq : 0;
          t = Math.max(0, Math.min(1, t));
          const p = [a[0] + dx * t, a[1] + dy * t];
          const d = dist(cur, p);
          if (d < best) {
            best = d;
            bestPoint = p;
          }
        }
      }
      total += best;
      cur = bestPoint;
    }
    return total;
  }

  const greedy = orderRegionsByProximity(regions, start);
  const twoOpt = orderRegionsWithTwoOpt(regions, start);

  const greedyCost = realCost(greedy);
  const twoOptCost = realCost(twoOpt);

  assert.ok(twoOptCost < greedyCost - 1e-6, `esperava 2-opt melhorar o custo: greedy=${greedyCost} 2opt=${twoOptCost}`);
  assert.notDeepEqual(twoOpt, greedy, '2-opt deveria ter mudado a ordem, não só repetido o greedy');

  // mesmo conjunto de regiões, só reordenadas (2-opt nunca inventa nem
  // descarta região).
  assert.equal(twoOpt.length, regions.length);
  for (const r of regions) assert.ok(twoOpt.includes(r));
});

test('orderRegionsWithTwoOpt: lista vazia devolve []', () => {
  assert.deepEqual(orderRegionsWithTwoOpt([], [0, 0]), []);
});

// ------------------------------------------------------- 6) integração final

test('fillRegionsTatami: boneco de palito — corridas finais ficam na ordem de dezenas, não de centenas', () => {
  const opts = { angleDeg: 0, rowSpacing: 4, stitchLength: 30 };
  const oldRuns = fillPolygonsTatami([STICK_FIGURE], opts);
  const newRuns = fillRegionsTatami([{ points: STICK_FIGURE }], opts);

  assert.ok(oldRuns.length > 200, `esperava o fill antigo (scanline global) bem fragmentado, veio ${oldRuns.length}`);
  assert.ok(newRuns.length < 20, `esperava o fill novo (por seção) na faixa de dezenas ou menos, veio ${newRuns.length}`);
  assert.ok(oldRuns.length >= newRuns.length * 20, 'queda de pelo menos 20x nas corridas finais');

  // nenhum ponto de nenhuma corrida escapa do retângulo que envolve o
  // boneco (sanity básica de que a costura ainda cobre a forma certa).
  for (const run of newRuns) {
    for (const [x, y] of run) {
      assert.ok(x >= 100 - 1e-6 && x <= 1100 + 1e-6 && y >= 0 - 1e-6 && y <= 1600 + 1e-6, `ponto (${x},${y}) fora do boneco`);
    }
  }
});

test('fillRegionsTatami: continua sendo o único ponto de entrada — regiões com furo ainda funcionam (sem seções extras espúrias)', () => {
  const outer = [[0, 0], [400, 0], [400, 400], [0, 400]];
  const hole = [[150, 150], [250, 150], [250, 250], [150, 250]];
  const opts = { angleDeg: 0, rowSpacing: 4, stitchLength: 30 };
  const runs = fillRegionsTatami([{ points: outer }, { points: hole }], opts);
  assert.ok(runs.length >= 1);
  for (const run of runs) {
    for (const [x, y] of run) {
      const insideHole = x > 150 + 1e-6 && x < 250 - 1e-6 && y > 150 + 1e-6 && y < 250 - 1e-6;
      assert.ok(!insideHole, `ponto (${x},${y}) caiu dentro do furo`);
    }
  }
});

test('connectRuns: aplica o mesmo teto de travel usado nas seções (função compartilhada, exportada pra teste)', () => {
  const region = { rings: [H_SHAPE] };
  const stitchLength = 8;
  const runA = [[100, 98]];
  const runB = [[80, 38]]; // junção curta (ver teste de findTravelPath acima)
  const runC = [[20, 62]]; // se ligado direto de B, estouraria o teto
  const merged = connectRuns([runA, runB, runC], region, stitchLength);
  // A->B linka (travel curto), B->C não (estoura o teto) -> 2 corridas finais.
  assert.equal(merged.length, 2);
});
