'use strict';
// Decomposição de uma região em seções monotônicas (issue #69, refina o
// preenchimento "por objeto" da issue #67/#68): dentro de UMA região,
// fillRegion hoje varre TODOS os anéis numa scanline só; quando a região tem
// mais de um vão (span) na mesma fileira — duas pernas, um braço + tronco —
// a serpentina alterna entre os galhos fileira a fileira, e cada alternância
// vira um travel (ou salto). Num boneco de palito real isso rendeu 43
// corridas e 12 travels numa região só.
//
// Este módulo faz a varredura "pensar por galho": gera as fileiras da região
// uma única vez (mesma spansAtY/pointsAlongSpan de fill.js, mesmo
// rowSpacing/grid/stagger — a geometria das agulhadas não muda, só o
// roteiro), liga cada vão da fileira k aos vãos da fileira k+1 que
// sobrepõem em X, e corta a seção sempre que um vão tem mais de um pai
// (merge) ou mais de um filho (split). Cada galho do desenho (tronco, cada
// perna, cada braço, a cabeça) vira uma seção própria, costurada por dentro
// como uma serpentina completa; quem liga as seções entre si (travel só nas
// junções, política de teto, ordem por DFS) é regions.js — este módulo só
// decompõe e costura CADA seção isoladamente.
//
// Implementação própria (não portada do Ink/Stitch, GPL): decompor um
// desenho em "fatias monotônicas" ligando vãos de fileiras vizinhas por
// sobreposição em X é a mesma ideia clássica de trapezoidação/decomposição
// vertical de polígonos que qualquer livro de geometria computacional
// descreve — não é específica de nenhuma ferramenta de bordado.

const fill = require('./fill');

const EPS = 1e-6;

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function rotatePoint(x, y, cos, sin) {
  return [x * cos + y * sin, -x * sin + y * cos];
}

function unrotatePoint(x, y, cos, sin) {
  return [x * cos - y * sin, x * sin + y * cos];
}

// --------------------------------------------------- 0) gerar as fileiras

// Mesma varredura que fill.fillPolygonsTatami já faz (gira pro espaço de
// cálculo, varre em Y a cada rowSpacing, spansAtY por fileira, grid global
// escalonado 1/3 em pointsAlongSpan) — só que devolvendo a estrutura
// intermediária por fileira/vão em vez de já juntar tudo em corridas. Os
// pontos de cada vão já saem DEGIRADOS (espaço real), na ordem de X
// crescente do espaço de cálculo; rowIndex/forward (fileira par/ímpar)
// decide a ordem de visita na hora de montar a corrida de cada seção
// (buildSectionRun), exatamente como fill.js decide "forward" hoje.
function computeRegionRows(region, opts) {
  const angleDeg = opts.angleDeg || 0;
  const rowSpacing = opts.rowSpacing > 0 ? opts.rowSpacing : 4;
  const stitchLength = opts.stitchLength > 0 ? opts.stitchLength : 30;

  const rings = region.rings || [];
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotatedRings = rings.map((pts) => pts.map(([x, y]) => rotatePoint(x, y, cos, sin)));

  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  for (const ring of rotatedRings) {
    for (const [x, y] of ring) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x < minX) minX = x;
    }
  }
  if (!isFinite(minY) || !isFinite(maxY) || maxY - minY < EPS) return { rows: [], stitchLength, rowSpacing };

  const rows = [];
  let rowIndex = 0;
  for (let y = minY + rowSpacing / 2; y < maxY; y += rowSpacing, rowIndex++) {
    const spans = fill.spansAtY(rotatedRings, y);
    if (spans.length === 0) continue;
    const phase = ((rowIndex % 3) * stitchLength) / 3;
    const gridOrigin = minX + phase;
    const spanNodes = spans.map(([a, b]) => {
      const xs = fill.pointsAlongSpan(a, b, gridOrigin, stitchLength);
      return { a, b, points: xs.map((x) => unrotatePoint(x, y, cos, sin)) };
    });
    rows.push({ rowIndex, spans: spanNodes });
  }
  return { rows, stitchLength, rowSpacing };
}

// --------------------------------------------------- 1) decompor em seções

// Duas fileiras vizinhas na lista `rows` (que já pula fileiras sem vão
// nenhum — ver computeRegionRows) são tratadas como "fileira k" e "fileira
// k+1" para fins de encadeamento; um pulo real de rowIndex (fileira
// intermediária sem vão nenhum — só ocorre num ponto degenerado de área
// zero, ex. o vértice de um triângulo) é raríssimo e não quebra o
// algoritmo, só significa que ligamos por cima desse ponto.
function overlapsInX(s1, s2) {
  return Math.min(s1.b, s2.b) - Math.max(s1.a, s2.a) > EPS;
}

// Decompõe as fileiras em seções monotônicas: cada vão é um nó com pais
// (vãos da fileira anterior que sobrepõem em X) e filhos (vãos da fileira
// seguinte que sobrepõem em X). Um nó com 0 ou 1 pai E cujo pai (se houver)
// tem 0 ou 1 filho continua a seção do pai; qualquer outro caso (0 pais, ou
// pai com split, ou 2+ pais = merge) abre uma seção NOVA. Devolve as seções
// (cada uma só com as fileiras/pontos, ainda sem stitching resolvido) e as
// arestas do grafo de junções entre seções (split/merge), usadas por
// orderSectionsByGraph pra decidir a ordem (regions.js decide o travel).
function decomposeSections(region, opts = {}) {
  const { rows } = computeRegionRows(region, opts);
  if (rows.length === 0) return { sections: [], edges: [] };

  // nodes[r][s] = { r, s, a, b, points, parents: [nó,...], children: [nó,...] }
  const nodes = rows.map((row, r) =>
    row.spans.map((sp, s) => ({ r, s, a: sp.a, b: sp.b, points: sp.points, parents: [], children: [] }))
  );

  for (let r = 0; r + 1 < nodes.length; r++) {
    for (const parent of nodes[r]) {
      for (const child of nodes[r + 1]) {
        if (overlapsInX(parent, child)) {
          parent.children.push(child);
          child.parents.push(parent);
        }
      }
    }
  }

  const sectionOfNode = new Map();
  const key = (n) => n.r + ':' + n.s;
  const sections = [];

  for (let r = 0; r < nodes.length; r++) {
    for (const node of nodes[r]) {
      if (sectionOfNode.has(key(node))) continue; // já absorvido pelo walk de outro nó
      const startsNew = node.parents.length !== 1 || node.parents[0].children.length !== 1;
      if (!startsNew) continue; // será varrido quando processarmos seu único pai (fileira anterior)

      const secIndex = sections.length;
      const secRows = [];
      let cur = node;
      for (;;) {
        secRows.push({ rowIndex: rows[cur.r].rowIndex, a: cur.a, b: cur.b, points: cur.points.slice() });
        sectionOfNode.set(key(cur), secIndex);
        if (cur.children.length === 1 && cur.children[0].parents.length === 1) {
          cur = cur.children[0];
          continue;
        }
        break;
      }
      sections.push({ rows: secRows, lastNode: cur });
    }
  }

  // arestas: da seção que TERMINA num split/merge pra cada seção filha (que
  // sempre começa exatamente no nó seguinte, já mapeado acima).
  const edges = [];
  for (let secIndex = 0; secIndex < sections.length; secIndex++) {
    const last = sections[secIndex].lastNode;
    for (const child of last.children) {
      const childSec = sectionOfNode.get(key(child));
      if (childSec !== undefined && childSec !== secIndex) edges.push({ from: secIndex, to: childSec });
    }
  }

  // lastNode era só um apoio interno pro cálculo das arestas.
  for (const sec of sections) delete sec.lastNode;

  return { sections, edges };
}

// --------------------------------------------------- 2) costurar 1 seção

// Funde, nas DUAS pontas da seção, uma fileira de <=2 pontos com a fileira
// vizinha da MESMA seção (issue #69 item 5): em vez de uma corrida-toco
// separada, os pontos da ponta são visitados a caminho da vizinha, na ordem
// que encosta mais perto dela primeiro. Segue alterando `orderedRows` (dá
// pra chamar 2x, uma pra cada ponta, sem se atrapalharem: depois de fundir a
// primeira fileira a lista encolhe e a checagem da última fileira já opera
// sobre a lista atualizada).
function mergeStubRows(orderedRows) {
  if (orderedRows.length < 2) return;

  if (orderedRows[0].points.length <= 2) {
    const stub = orderedRows.shift();
    const neighbor = orderedRows[0];
    const anchor = neighbor.points[0];
    const stubPts = stub.points.slice().sort((p1, p2) => dist(p2, anchor) - dist(p1, anchor));
    neighbor.points = stubPts.concat(neighbor.points);
  }

  if (orderedRows.length >= 2) {
    const lastIdx = orderedRows.length - 1;
    if (orderedRows[lastIdx].points.length <= 2) {
      const stub = orderedRows.pop();
      const neighbor = orderedRows[orderedRows.length - 1];
      const anchor = neighbor.points[neighbor.points.length - 1];
      const stubPts = stub.points.slice().sort((p1, p2) => dist(p1, anchor) - dist(p2, anchor));
      neighbor.points = neighbor.points.concat(stubPts);
    }
  }
}

// Resolve o traçado completo de UMA seção: direção por fileira alternando
// por rowIndex par/ímpar (mesma regra "forward" de fill.js, aplicada com o
// rowIndex GLOBAL da região — fileiras vizinhas sempre têm paridade
// diferente, então a serpentina alterna direção normalmente dentro da
// seção, sem precisar reiniciar a contagem), funde fileiras-toco nas pontas,
// e concatena tudo numa corrida só (as fileiras vizinhas já saem a
// ~rowSpacing de distância real, cabendo numa agulhada normal — nenhum
// travel/salto acontece DENTRO de uma seção).
function buildSectionRun(section) {
  const orderedRows = section.rows.map((row) => {
    const forward = row.rowIndex % 2 === 0;
    return { points: forward ? row.points.slice() : row.points.slice().reverse() };
  });
  mergeStubRows(orderedRows);
  const points = [];
  for (const row of orderedRows) points.push(...row.points);
  return points;
}

// --------------------------------------------------- 3) ordenar seções (DFS)

// Uma seção inteira pode ser percorrida em qualquer uma das duas direções
// (início->fim ou fim->início) sem alterar o conjunto de agulhadas nem
// quebrar a serpentina interna: inverter o array de pontos por completo
// (não fileira a fileira) preserva toda adjacência fileira-a-fileira já
// construída em buildSectionRun, só troca qual ponta é "entrada". Sem essa
// escolha, a junção entre duas seções (que sempre SOBREPÕEM em X, por
// construção) ainda podia sair longe: a direção de cada fileira alterna
// pelo rowIndex GLOBAL da região (independente de onde a seção começa), então
// a ponta "de entrada" de uma seção nem sempre cai do lado que encosta na
// vizinha — pode ser a ponta oposta (o "galho" inteiro invertido). Ver
// forensics no relatório da issue #69 (H sintético: uma junção virava salto
// de ~98 unidades por causa disso, mesmo as fileiras se sobrepondo em X).
function closerEnd(run, point) {
  const dStart = dist(point, run[0]);
  const dEnd = dist(point, run[run.length - 1]);
  return dStart <= dEnd ? { dist: dStart, reversed: false } : { dist: dEnd, reversed: true };
}

// Percorre o grafo de junções (split/merge) em DFS a partir da seção mais
// próxima da agulha (startPoint); em cada bifurcação visita primeiro o
// vizinho não visitado mais próximo (evita, ex., pular do fim de um braço
// pro início do OUTRO lado do tronco quando o braço mais próximo ainda não
// foi visitado) — a proximidade considera as DUAS pontas de cada candidato
// (closerEnd), não só o início "natural". Seções fora do componente
// alcançado pelo DFS (raro — só junções degeneradas, ver computeRegionRows)
// entram no fim, sempre pela mais próxima da posição corrente. Devolve, na
// ordem de visita, `{ index, reversed }` — `index` é a posição em `runs`,
// `reversed` diz se essa seção deve ser percorrida de trás pra frente pra
// encostar na posição corrente; regions.js decide como LIGAR cada transição
// (merge/travel/salto) usando essa orientação.
function orderSectionsByGraph(runs, edges, startPoint) {
  const n = runs.length;
  if (n === 0) return [];
  const adj = Array.from({ length: n }, () => []);
  for (const e of edges || []) {
    adj[e.from].push(e.to);
    adj[e.to].push(e.from);
  }

  const visited = new Array(n).fill(false);
  const order = [];
  let current = startPoint || [0, 0];

  function visit(idx) {
    visited[idx] = true;
    const { reversed } = closerEnd(runs[idx], current);
    order.push({ index: idx, reversed });
    const run = runs[idx];
    current = reversed ? run[0] : run[run.length - 1];
  }

  function dfs(startIdx) {
    const stack = [startIdx];
    while (stack.length) {
      const idx = stack.pop();
      if (visited[idx]) continue;
      visit(idx);
      const nexts = adj[idx].filter((k) => !visited[k]);
      // Empilha do mais longe pro mais próximo: o pop() tira o TOPO, então o
      // mais próximo (empilhado por último) é visitado primeiro a seguir.
      nexts.sort((a, b) => closerEnd(runs[b], current).dist - closerEnd(runs[a], current).dist);
      for (const nb of nexts) stack.push(nb);
    }
  }

  while (order.length < n) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      const d = closerEnd(runs[i], current).dist;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    dfs(bestIdx);
  }

  return order;
}

// --------------------------------------------- 4) travel pela fileira de junção

// Anda ao longo de UMA fileira (seus pontos já em ordem crescente do
// espaço de cálculo — ver computeRegionRows) a partir de uma ponta
// (`current` precisa ser exatamente pts[0] ou pts[last], dentro de EPS —
// é assim que qualquer seção termina/começa, seja qual for sua orientação
// e a paridade própria dessa fileira) até o ponto da MESMA fileira mais
// próximo de `target`. Devolve só os pontos intermediários (sem `current`
// nem o ponto de chegada — quem chama ainda precisa ligar esse ponto de
// chegada até `target`, um salto curto que quase sempre cabe num
// comprimento de ponto). null se `current` não estiver em nenhuma ponta
// desta fileira (a orientação escolhida pra essa seção não expôs esta
// junção — quem chama cai pro travel/salto normal).
function junctionRowWalk(row, current, target) {
  const pts = row && row.points;
  if (!pts || pts.length === 0) return null;
  const atStart = dist(current, pts[0]) <= EPS;
  const atEnd = dist(current, pts[pts.length - 1]) <= EPS;
  if (!atStart && !atEnd) return null;

  let bestIdx = atStart ? 0 : pts.length - 1;
  let bestDist = dist(pts[bestIdx], target);
  for (let i = 0; i < pts.length; i++) {
    const d = dist(pts[i], target);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }

  if (atStart) return pts.slice(1, bestIdx + 1);
  return pts.slice(bestIdx, pts.length - 1).reverse();
}

// Travel pela fileira de junção pra uma transição que É aresta direta do
// grafo de seções (split/merge) — não um "backtrack" entre galhos
// paralelos. A fileira de junção de quem está SAINDO (a última, se sai por
// split; a primeira, se sai por merge) contém pontos garantidamente
// interiores — é a própria agulhada já prevista, uma fileira da MESMA cor
// já costurada — e por construção (foi essa sobreposição em X que criou a
// aresta em decomposeSections) ela se aproxima da fileira de entrada de
// quem está chegando. Caminho em L: anda por essa fileira até a coluna de
// entrada do outro lado (junctionRowWalk) e só então conecta ao primeiro
// ponto de quem chega — curto por construção, quase sempre um comprimento
// de ponto. Devolve null se não houver aresta direta entre as duas seções,
// ou se a orientação escolhida não deixou `current` na fileira de junção
// (quem chama cai pro findTravelPath normal).
function findJunctionTravel(sections, edges, fromIdx, toIdx, current, target) {
  const edge = (edges || []).find(
    (e) => (e.from === fromIdx && e.to === toIdx) || (e.from === toIdx && e.to === fromIdx)
  );
  if (!edge) return null;

  const fromIsParent = edge.from === fromIdx;
  const fromRows = sections[fromIdx] && sections[fromIdx].rows;
  if (!fromRows || !fromRows.length) return null;
  const relevantRow = fromIsParent ? fromRows[fromRows.length - 1] : fromRows[0];

  return junctionRowWalk(relevantRow, current, target);
}

module.exports = {
  decomposeSections,
  buildSectionRun,
  orderSectionsByGraph,
  mergeStubRows,
  junctionRowWalk,
  findJunctionTravel,
};
