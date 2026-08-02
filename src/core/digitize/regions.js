'use strict';
// Roteamento de preenchimento "por objeto" (issue #67, consolida o forensics
// da issue #64): hoje fillPolygonsTatami varre TODOS os anéis de uma cor de
// uma vez só, com scanline even-odd global. Quando a cor tem várias regiões
// desconexas (ilhas), cada fileira cruza de uma região pra outra e volta na
// fileira seguinte — um salto de ida, ponto(s), salto de volta, repetido a
// cada fileira, como impressora jato de tinta. Num desenho real digitalizado
// isso já rendeu 58 séries de salto cruzando o tecido (e, no arquivo gravado
// pra máquina física, um jump de delta (0,0) — ver coalesceZeroGapRuns).
//
// Este módulo faz o preenchimento "pensar por objeto", como um slicer de
// impressão 3D: agrupa os anéis em regiões conexas (contorno externo + seus
// furos), preenche e fecha uma região por vez (reaproveitando o scanline
// serpentina de fill.js sem alterá-lo) e só então passa pra próxima —
// ordenadas por vizinho mais próximo a partir da agulha. Dentro de uma
// região, tenta ligar corridas distantes por ponto corrido (travel) que
// nunca saia da região, em vez de saltar; entre regiões o salto continua
// inevitável (são áreas desconexas de verdade), mas cai para ~1 por região.
//
// Implementação própria — não portada do Ink/Stitch (GPL). Agrupar
// contornos por contenção par/ímpar e escolher a próxima região por vizinho
// mais próximo são técnicas clássicas de geometria computacional, não
// específicas de nenhuma ferramenta; a ideia de "fechar uma peça antes de
// começar a próxima" é a mesma de qualquer slicer de impressão 3D comum.

const fill = require('./fill');
const sections = require('./sections');

const EPS = 1e-6;
// Folga para o ponto de travel "colar" numa aresta da região: absorve o
// arredondamento de ponto flutuante do giro/degiro de fillPolygonsTatami
// (rotatePoint/unrotatePoint), bem maior que o erro esperado (~1e-10 pra
// coordenadas nesta faixa) e bem menor que qualquer agulhada real.
const BOUNDARY_EPS = 1e-2;

// Teto de travel (issue #69 item 3): um travel só vale a pena se for
// mesmo "quase direto". Sem teto, um travel podia serpentear a borda de
// uma região grande por centenas de unidades pra evitar um salto de poucos
// mm — pior pro resultado final (mais agulhadas, mais tempo de máquina) do
// que só saltar. Rejeita (devolve pro chamador usar salto) se o caminho
// passar de 150 unidades (15mm em 0,1mm) OU de 3x a distância direta entre
// as pontas — o que for mais restritivo.
const TRAVEL_MAX_UNITS = 150;
const TRAVEL_MAX_RATIO = 3;

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// Mesma normalização de entrada que fill.fillPolygonsTatami já faz: aceita
// tanto [{points:[...]}] quanto [[...pontos...]] direto.
function normalizeRings(polygons) {
  return (polygons || []).map((p) => p.points || p).filter((pts) => pts && pts.length >= 3);
}

function normalize2(v) {
  const len = Math.hypot(v[0], v[1]);
  return len > EPS ? [v[0] / len, v[1] / len] : [0, 0];
}

// Remove pontos consecutivos repetidos (inclusive um eventual fechamento
// duplicado, último ponto == primeiro) — os produtores de anéis deste
// projeto não duplicam o fechamento (fill.js já documenta a convenção de
// anel implicitamente fechado), mas é defensivo e barato garantir aqui.
function dedupeRing(ring) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    if (i === 0 || dist(ring[i], ring[i - 1]) > EPS) out.push(ring[i]);
  }
  if (out.length > 1 && dist(out[0], out[out.length - 1]) <= EPS) out.pop();
  return out;
}

// --------------------------------------------------------- ponto-em-polígono

// Ponto-em-polígono contra UM anel: regra even-odd por contagem de
// cruzamentos de um raio horizontal, mesma convenção de intervalo semiaberto
// de fill.spansAtY (evita contar duas vezes um raio que passa exatamente por
// um vértice).
function pointInRing(pt, ring) {
  const [px, py] = pt;
  let crossings = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    if (y0 === y1) continue;
    const crosses = (y0 <= py && py < y1) || (y1 <= py && py < y0);
    if (!crosses) continue;
    const t = (py - y0) / (y1 - y0);
    if (x0 + t * (x1 - x0) > px) crossings++;
  }
  return crossings % 2 === 1;
}

// Even-odd combinando VÁRIOS anéis (contorno externo + furos de uma
// região): alterna dentro/fora a cada anel que "contém" o ponto (paridade
// da soma dos cruzamentos de todos os anéis == XOR da paridade de cada
// anel, é só aritmética de paridade) — exatamente a mesma regra que
// spansAtY usa ao juntar todos os cruzamentos de todos os anéis antes de
// parear por X, só que pra um ponto solto em vez de uma fileira inteira.
function pointInsideRings(pt, rings) {
  let inside = false;
  for (const ring of rings) {
    if (pointInRing(pt, ring)) inside = !inside;
  }
  return inside;
}

function isInsideRegion(pt, region) {
  return pointInsideRings(pt, region.rings);
}

// Ponto de amostra garantidamente DENTRO de um anel simples (não
// autointersectante), mesmo se côncavo (letras C/S/G, formas em U etc.): o
// vértice de Y mínimo de qualquer polígono simples é sempre convexo — não
// importa quão irregular seja o resto do contorno, olhando só a vizinhança
// imediata desse vértice, o interior fica sempre "entre" as duas arestas que
// nele se encontram (na bissetriz do ângulo formado por elas). Um passo bem
// pequeno (relativo à menor aresta do anel) nessa direção, a partir do
// vértice, fica dentro dessa vizinhança segura sem precisar saber a
// orientação (sentido) do anel.
function interiorSamplePoint(ring) {
  const pts = dedupeRing(ring);
  const n = pts.length;
  if (n < 3) return ring[0];

  let vi = 0;
  for (let i = 1; i < n; i++) {
    if (pts[i][1] < pts[vi][1] || (pts[i][1] === pts[vi][1] && pts[i][0] < pts[vi][0])) vi = i;
  }
  const V = pts[vi];
  const A = pts[(vi - 1 + n) % n];
  const Cp = pts[(vi + 1) % n];

  const dA = normalize2([A[0] - V[0], A[1] - V[1]]);
  const dC = normalize2([Cp[0] - V[0], Cp[1] - V[1]]);
  let dir = [dA[0] + dC[0], dA[1] + dC[1]];
  if (Math.hypot(dir[0], dir[1]) < EPS) {
    // Vizinhos quase opostos (V quase colinear entre eles): usa a normal de
    // uma das arestas como direção interna aproximada.
    dir = [-dA[1], dA[0]];
  }
  dir = normalize2(dir);

  let minEdge = Infinity;
  for (let i = 0; i < n; i++) {
    const d = dist(pts[i], pts[(i + 1) % n]);
    if (d > EPS && d < minEdge) minEdge = d;
  }
  const step = (isFinite(minEdge) ? minEdge : 1) * 1e-3;
  return [V[0] + dir[0] * step, V[1] + dir[1] * step];
}

// --------------------------------------------------- 1) agrupar em regiões

// Agrupa anéis em regiões conexas (contorno externo + seus furos) por
// contenção ponto-em-polígono: para cada anel, conta em quantos OUTROS
// anéis o seu ponto de amostra cai dentro — a profundidade de aninhamento.
// Anéis de profundidade PAR são raiz de uma região (o contorno mais externo,
// ou uma ilha preenchida dentro de um furo mais acima — o mesmo anel volta a
// ser "tinta" a cada nível de aninhamento par). Anéis de profundidade ÍMPAR
// são furo do seu contêiner IMEDIATO: o menor/mais interno dos anéis que o
// contêm (que por construção — contenção sempre encadeada quando os anéis
// não se cruzam — tem profundidade par, então é sempre a raiz de alguma
// região).
//
// Assume anéis simples (não autointersectantes) e "laminares" (nunca se
// cruzam nem se sobrepõem parcialmente) — a mesma suposição implícita que
// fill.fillPolygonsTatami já faz ao tratar cada anel como um contorno
// fechado independente.
function groupRingsIntoRegions(polygons) {
  const rings = normalizeRings(polygons);
  const n = rings.length;
  if (n === 0) return [];

  const samples = rings.map(interiorSamplePoint);
  const containers = new Array(n);
  const depth = new Array(n);
  for (let i = 0; i < n; i++) {
    const list = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (pointInRing(samples[i], rings[j])) list.push(j);
    }
    containers[i] = list;
    depth[i] = list.length;
  }

  // Contêiner imediato = o de maior profundidade entre os que contêm o
  // anel (o mais interno da cadeia de contenção).
  const parent = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let best = -1;
    let bestDepth = -1;
    for (const j of containers[i]) {
      if (depth[j] > bestDepth) {
        bestDepth = depth[j];
        best = j;
      }
    }
    parent[i] = best;
  }

  const regions = [];
  const regionIndexByRoot = new Map();
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 === 0) {
      regionIndexByRoot.set(i, regions.length);
      regions.push({ rings: [rings[i]], outerIndex: i, holeIndices: [] });
    }
  }
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 === 1) {
      const regionIdx = regionIndexByRoot.get(parent[i]);
      const region = regions[regionIdx];
      region.rings.push(rings[i]);
      region.holeIndices.push(i);
    }
  }
  return regions;
}

// --------------------------------------------------- distância a uma região

function closestPointOnSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > EPS ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const proj = [a[0] + dx * t, a[1] + dy * t];
  return { point: proj, dist: dist(p, proj), t };
}

// Ponto mais próximo de `p` em qualquer aresta de qualquer anel da região
// (contorno externo ou furo) — usado tanto pra ordenar regiões por
// proximidade quanto pra localizar em qual anel/aresta um ponto de travel
// está apoiado.
function closestPointOnRegion(p, region) {
  let best = null;
  let bestDist = Infinity;
  for (const ring of region.rings) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const cp = closestPointOnSegment(p, ring[i], ring[(i + 1) % n]);
      if (cp.dist < bestDist) {
        bestDist = cp.dist;
        best = cp.point;
      }
    }
  }
  return { point: best, dist: bestDist };
}

// -------------------------------------------------- 4) ordenar por proximidade

// Vizinho mais próximo, greedy: a partir de startPoint (posição atual da
// agulha; default [0,0]), escolhe sempre a região restante cujo ponto mais
// próximo está mais perto da posição atual, "anda" até esse ponto e repete
// — a primeira região da lista devolvida é a mais próxima do fim do
// trabalho anterior, exatamente como um slicer de impressão 3D decide a
// ordem das peças de uma impressão (não a ordem de aparição no desenho).
function orderRegionsByProximity(regions, startPoint) {
  const remaining = regions.slice();
  const ordered = [];
  let current = startPoint || [0, 0];
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    let bestPoint = current;
    for (let k = 0; k < remaining.length; k++) {
      const { point, dist: d } = closestPointOnRegion(current, remaining[k]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = k;
        bestPoint = point;
      }
    }
    ordered.push(remaining.splice(bestIdx, 1)[0]);
    current = bestPoint;
  }
  return ordered;
}

// Menor distância entre a borda de duas regiões: mínimo, dos dois lados,
// de "vértice de uma região" até "aresta mais próxima da outra" — a
// distância mínima entre dois polígonos simples sempre ocorre num par
// vértice-aresta (nunca no interior de duas arestas, a menos que sejam
// paralelas encostadas, e mesmo aí as pontas capturam o mínimo). Simétrica
// e independente de "por onde se chega" — exatamente o que o 2-opt precisa
// pra comparar trocas sem ter que preencher a região de fato pra saber onde
// a agulha realmente entraria.
function regionsDistance(a, b) {
  let best = Infinity;
  for (const ring of a.rings) {
    for (const v of ring) {
      const { dist: d } = closestPointOnRegion(v, b);
      if (d < best) best = d;
    }
  }
  for (const ring of b.rings) {
    for (const v of ring) {
      const { dist: d } = closestPointOnRegion(v, a);
      if (d < best) best = d;
    }
  }
  return best;
}

// Passe 2-opt clássico sobre uma sequência (caminho, não ciclo — a agulha
// não precisa voltar pro início): repete até não achar mais troca que
// melhore, ou até maxIterations. `distFn.fromStart(i)` é o custo de partir
// do ponto inicial pro item i; `distFn.between(i,j)` é o custo item i -> item
// j. Uma troca 2-opt reverte o trecho seq[i..j]; só as DUAS arestas de
// borda desse trecho mudam de custo (as internas só trocam de sentido, e a
// distância usada aqui é simétrica), então cada candidato é O(1) pra
// avaliar dado o cache de distâncias.
function twoOptImprove(seq, distFn) {
  const order = seq.slice();
  const n = order.length;
  let improved = true;
  let iterations = 0;
  const maxIterations = 200;
  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const oldBefore = i === 0 ? distFn.fromStart(order[i]) : distFn.between(order[i - 1], order[i]);
        const oldAfter = j === n - 1 ? 0 : distFn.between(order[j], order[j + 1]);
        const newBefore = i === 0 ? distFn.fromStart(order[j]) : distFn.between(order[i - 1], order[j]);
        const newAfter = j === n - 1 ? 0 : distFn.between(order[i], order[j + 1]);
        if (newBefore + newAfter < oldBefore + oldAfter - EPS) {
          let lo = i;
          let hi = j;
          while (lo < hi) {
            const tmp = order[lo];
            order[lo] = order[hi];
            order[hi] = tmp;
            lo++;
            hi--;
          }
          improved = true;
        }
      }
    }
  }
  return order;
}

// Ordena regiões pelo greedy de sempre e então refina com um passe 2-opt
// (issue #69 item 4): o vizinho-mais-próximo greedy é míope — perto do fim
// pode sobrar só a região mais longe de tudo, obrigando um salto que
// atravessa o desenho inteiro pra alcançá-la. 2-opt corrige exatamente esse
// tipo de "cruzamento": acha um par de trechos da sequência cuja troca (via
// reversão) reduz a distância total, sem mudar QUAIS regiões entram, só a
// ORDEM. Com <=2 regiões não há troca possível que mude nada — devolve o
// greedy como está.
function orderRegionsWithTwoOpt(regions, startPoint) {
  const greedyOrder = orderRegionsByProximity(regions, startPoint);
  if (greedyOrder.length <= 2) return greedyOrder;

  const start = startPoint || [0, 0];
  const distCache = new Map();
  function pairDist(i, j) {
    const key = i < j ? i + ':' + j : j + ':' + i;
    let d = distCache.get(key);
    if (d === undefined) {
      d = regionsDistance(greedyOrder[i], greedyOrder[j]);
      distCache.set(key, d);
    }
    return d;
  }
  const distFn = {
    fromStart: (i) => closestPointOnRegion(start, greedyOrder[i]).dist,
    between: (i, j) => pairDist(i, j),
  };

  const initial = greedyOrder.map((_, i) => i);
  const optimized = twoOptImprove(initial, distFn);
  return optimized.map((i) => greedyOrder[i]);
}

// -------------------------------------------------------- 3) travel sem salto

// Nº de segmentos <= stitchLength pra cobrir `total` de distância
// (arredonda pra CIMA: nunca deixa um segmento maior que o configurado).
function segmentCountFor(total, stitchLength) {
  const len = stitchLength > 0 ? stitchLength : total || 1;
  return Math.max(1, Math.ceil(total / len));
}

function sampleStraight(from, to, count) {
  const pts = [];
  for (let i = 1; i < count; i++) {
    const t = i / count;
    pts.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
  }
  return pts;
}

// Verifica se o segmento reto from->to fica INTEIRAMENTE dentro da região,
// amostrando numa resolução mais fina que a agulhada final (reduz — sem
// eliminar — o risco de uma reentrância fina da região escapar entre duas
// amostras; ver limitações conhecidas no relatório). Usada tanto pelo
// travel (tryStraightTravel) quanto por connectRuns pra decidir se um gap
// CURTO (<= stitchLength) pode mesmo colar direto: um segmento reto sem
// essa checagem é exatamente o defeito relatado na arte real (issue #69,
// rodada 2) — pontos atravessando o vão entre cabeça e braço, ou a
// virilha, porque "gap curto" foi tratado como sinônimo de "está dentro".
function isStraightSegmentInside(from, to, region, stitchLength) {
  const total = dist(from, to);
  if (total <= EPS) return true;
  const checkCount = Math.max(segmentCountFor(total, stitchLength) * 4, 4);
  for (let i = 1; i < checkCount; i++) {
    const t = i / checkCount;
    const p = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
    if (!pointInsideRings(p, region.rings)) return false;
  }
  return true;
}

// Tenta ligar from -> to por uma linha reta inteiramente dentro da região;
// só gera os pontos reais (no espaçamento pedido) se isStraightSegmentInside
// passar.
function tryStraightTravel(from, to, region, stitchLength) {
  const total = dist(from, to);
  if (total <= EPS) return [];
  if (!isStraightSegmentInside(from, to, region, stitchLength)) return null;
  return sampleStraight(from, to, segmentCountFor(total, stitchLength));
}

// Localiza em qual anel/aresta da região um ponto se apoia (from/to de um
// travel SEMPRE caem exatamente sobre uma aresta de algum anel da região,
// pois vêm de um cruzamento de scanline calculado por fill.spansAtY). null
// se o ponto não estiver "colado" em nenhuma aresta da região.
function locateOnRegionBoundary(pt, region) {
  let best = null;
  let bestDist = Infinity;
  region.rings.forEach((ring, ringIndex) => {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const cp = closestPointOnSegment(pt, ring[i], ring[(i + 1) % n]);
      if (cp.dist < bestDist) {
        bestDist = cp.dist;
        best = { ringIndex, edgeIndex: i, t: cp.t };
      }
    }
  });
  return best && bestDist <= BOUNDARY_EPS ? best : null;
}

function ringArcLengths(ring) {
  const n = ring.length;
  const cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + dist(ring[i], ring[(i + 1) % n]));
  return cum;
}

function arcPositionOf(cum, edgeIndex, t) {
  return cum[edgeIndex] + t * (cum[edgeIndex + 1] - cum[edgeIndex]);
}

// Ponto do anel na distância de arco `s` a partir do vértice 0 (percorrendo
// sempre em ordem crescente de índice, módulo o perímetro total).
function pointAtArc(ring, cum, s) {
  const total = cum[cum.length - 1];
  let d = s % total;
  if (d < 0) d += total;
  const n = ring.length;
  let i = 0;
  while (i < n - 1 && cum[i + 1] < d) i++;
  const segLen = cum[i + 1] - cum[i];
  const t = segLen > EPS ? (d - cum[i]) / segLen : 0;
  const a = ring[i];
  const b = ring[(i + 1) % n];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// Caminha pela borda de UM anel de posA até posB (posições devolvidas por
// locateOnRegionBoundary), pelo sentido MAIS CURTO dos dois possíveis,
// devolvendo só os pontos intermediários (sem incluir as pontas), espaçados
// a no máximo stitchLength.
function walkAlongRing(ring, posA, posB, stitchLength) {
  const cum = ringArcLengths(ring);
  const total = cum[cum.length - 1];
  if (total <= EPS) return [];
  const a = arcPositionOf(cum, posA.edgeIndex, posA.t);
  const b = arcPositionOf(cum, posB.edgeIndex, posB.t);
  let forward = (b - a) % total;
  forward = (forward + total) % total;
  const backward = total - forward;
  const goForward = forward <= backward;
  const travelDist = goForward ? forward : backward;
  if (travelDist <= EPS) return [];

  const count = segmentCountFor(travelDist, stitchLength);
  const pts = [];
  for (let i = 1; i < count; i++) {
    const s = goForward ? a + (travelDist * i) / count : a - (travelDist * i) / count;
    pts.push(pointAtArc(ring, cum, s));
  }
  return pts;
}

function tryBoundaryWalkTravel(from, to, region, stitchLength) {
  const locA = locateOnRegionBoundary(from, region);
  const locB = locateOnRegionBoundary(to, region);
  if (!locA || !locB || locA.ringIndex !== locB.ringIndex) return null;
  return walkAlongRing(region.rings[locA.ringIndex], locA, locB, stitchLength);
}

// Acha um caminho de travel de `from` até `to`, inteiramente DENTRO da
// região (region.rings), em segmentos <= stitchLength: linha reta se couber
// inteira dentro da região; senão caminha pela borda do polígono (o menor
// dos dois sentidos), se from/to caírem sobre o MESMO anel; senão, null (não
// existe travel válido — quem chama decide o salto). Devolve só os pontos
// INTERMEDIÁRIOS (sem from/to): [] é uma resposta válida ("liga direto, sem
// pontos extras"), distinta de null ("impossível, mantenha o salto").
function findTravelPath(from, to, region, stitchLength) {
  const straight = tryStraightTravel(from, to, region, stitchLength);
  if (straight) return straight;
  return tryBoundaryWalkTravel(from, to, region, stitchLength);
}

// Soma o comprimento real de from -> ...path... -> to (não a distância
// direta): um travel pela borda pode ziguezaguear bem mais que a linha reta
// entre as pontas, e é esse comprimento percorrido que conta como fio/tempo
// de máquina extra, não o quanto from/to estão próximos entre si.
function travelPathLength(from, to, path) {
  let total = 0;
  let prev = from;
  for (const p of path) {
    total += dist(prev, p);
    prev = p;
  }
  total += dist(prev, to);
  return total;
}

// Teto de travel (issue #69 item 3, ver TRAVEL_MAX_UNITS/TRAVEL_MAX_RATIO):
// rejeita um travel válido (achado por findTravelPath) se ele for longo
// demais em absoluto OU longo demais frente à distância direta — nesses
// casos um salto reto é preferível (menos agulhadas, mesmo cruzando por
// fora da região por um instante, o que é aceitável pra um JUMP).
function exceedsTravelCeiling(from, to, path) {
  const direct = dist(from, to);
  const length = travelPathLength(from, to, path);
  return length > TRAVEL_MAX_UNITS || length > direct * TRAVEL_MAX_RATIO;
}

// Liga uma sequência de corridas (já prontas, cada uma sua própria
// serpentina) numa lista de corridas finais, tentando reduzir o número de
// saltos: gap ~0 cola sem duplicar ponto; gap <= stitchLength só cola
// direto se o segmento reto ficar DENTRO da região (isStraightSegmentInside
// — issue #69 rodada 2, item 1: "gap curto" não é sinônimo de "está
// dentro", ver comentário lá); senão tenta primeiro `findJunctionTravel
// (fromOriginalIdx, toOriginalIdx, from, to)` (se fornecida — travel pela
// fileira de junção, curto por construção pras transições que são aresta
// direta do grafo de seções) e, faltando ou estourando o teto, cai pro
// findTravelPath genérico (reta ou borda, também sujeito ao teto); só
// quando nada disso serve é que abre corrida nova (salto). `fromOriginalIdx`
// e `toOriginalIdx` são os índices em `runs` (antes de descartar corridas
// vazias) das duas corridas envolvidas nessa transição — é isso que
// findJunctionTravel usa pra saber a que seção cada corrida corresponde.
// Compartilhada entre o fluxo de seções (fillRegion) e qualquer chamador
// futuro que precise ligar corridas dentro da mesma região.
function connectRuns(runs, region, stitchLength, findJunctionTravel) {
  const nonEmpty = [];
  const nonEmptyIndices = [];
  for (let i = 0; i < runs.length; i++) {
    if (runs[i] && runs[i].length) {
      nonEmpty.push(runs[i]);
      nonEmptyIndices.push(i);
    }
  }
  if (nonEmpty.length === 0) return [];

  const merged = [nonEmpty[0].slice()];
  for (let k = 1; k < nonEmpty.length; k++) {
    const nextRun = nonEmpty[k];
    const cur = merged[merged.length - 1];
    const from = cur[cur.length - 1];
    const to = nextRun[0];
    const gap = dist(from, to);

    if (gap <= EPS) {
      // Pontos praticamente coincidentes: cola sem duplicar (e sem deixar
      // nenhum salto de distância zero no meio do caminho).
      cur.push(...nextRun.slice(1));
      continue;
    }

    if (gap <= stitchLength && isStraightSegmentInside(from, to, region, stitchLength)) {
      cur.push(...nextRun);
      continue;
    }

    let travel = findJunctionTravel
      ? findJunctionTravel(nonEmptyIndices[k - 1], nonEmptyIndices[k], from, to)
      : null;
    if (!travel || exceedsTravelCeiling(from, to, travel)) {
      travel = findTravelPath(from, to, region, stitchLength);
    }
    if (travel && !exceedsTravelCeiling(from, to, travel)) {
      cur.push(...travel, ...nextRun);
    } else {
      merged.push(nextRun.slice());
    }
  }
  return merged;
}

// ------------------------------------------------- preencher UMA região

// Preenche uma única região decompondo-a em seções monotônicas (issue #69,
// sections.js): cada galho do desenho (tronco, cada perna, cada braço, a
// cabeça) é uma seção própria, costurada por dentro como uma serpentina
// completa (buildSectionRun) sem nenhum travel/salto interno. A ORDEM entre
// seções segue o grafo de junções (split/merge) em DFS a partir da mais
// próxima da agulha (orderSectionsByGraph); a LIGAÇÃO entre seções vizinhas
// reaproveita connectRuns, que tenta primeiro o travel pela fileira de
// junção (sections.findJunctionTravel — issue #69 rodada 2, item 2: curto
// por construção pras transições que são aresta direta do grafo, mesmo
// quando a serpentina de quem sai termina na ponta oposta da junção) antes
// do travel genérico; fora das junções (voltando de um galho pra visitar o
// próximo na ordem do DFS) o teto de travel decide entre travel curto ou
// salto.
function fillRegion(region, opts) {
  const stitchLength = opts.stitchLength > 0 ? opts.stitchLength : 30;
  const { sections: secs, edges } = sections.decomposeSections(region, opts);
  if (secs.length === 0) return [];

  const builtRuns = secs.map((sec) => sections.buildSectionRun(sec));
  const startPoint = opts.startPoint || [0, 0];
  const order = sections.orderSectionsByGraph(builtRuns, edges, startPoint);
  // Cada seção pode ser percorrida em qualquer direção sem quebrar sua
  // própria serpentina interna (ver comentário de closerEnd em sections.js);
  // orderSectionsByGraph já escolheu, pra cada uma, a orientação que encosta
  // mais perto da posição corrente — aqui só materializa isso invertendo o
  // array de pontos quando `reversed` for true.
  const orderedRuns = order.map(({ index, reversed }) =>
    reversed ? builtRuns[index].slice().reverse() : builtRuns[index]
  );

  const findJunctionTravel = (fromK, toK, from, to) =>
    sections.findJunctionTravel(secs, edges, order[fromK].index, order[toK].index, from, to);

  return connectRuns(orderedRuns, region, stitchLength, findJunctionTravel);
}

// -------------------------------------------- nunca deixar salto de distância zero

// Última passada de segurança: funde corridas adjacentes cujo ponto final e
// inicial já coincidem (distância ~0). fillRegion nunca deixa isso ocorrer
// DENTRO de uma região (todo novo item de `merged` só nasce por um gap >
// stitchLength > 0), mas a concatenação ENTRE regiões pode, em tese, colocar
// lado a lado duas corridas cujas pontas se tocam (regiões que só se tocam
// num único ponto, ou a posição inicial pedida já coincidir com o primeiro
// ponto da primeira região) — foi exatamente esse tipo de salto de delta
// (0,0) que apareceu no arquivo gravado pra máquina física (issue #64) e
// quebrou agulhas: um JUMP sem deslocamento nenhum. Ver testes.
function coalesceZeroGapRuns(runs) {
  const out = [];
  for (const run of runs) {
    if (!run || !run.length) continue;
    if (out.length === 0) {
      out.push(run.slice());
      continue;
    }
    const cur = out[out.length - 1];
    const from = cur[cur.length - 1];
    const to = run[0];
    if (dist(from, to) <= EPS) {
      cur.push(...run.slice(1));
    } else {
      out.push(run.slice());
    }
  }
  return out;
}

// ------------------------------------------------------------- orquestrador

// Fluxo completo "por objeto": agrupa em regiões, ordena por proximidade e
// refina com 2-opt a partir de opts.startPoint (posição atual da agulha;
// default [0,0]; issue #69 item 4 — corrige o salto que a ordem greedy
// sozinha às vezes cria atravessando o desenho), preenche e liga cada
// região por vez, e só então passa pra próxima — igual a um slicer de
// impressão 3D. A posição da agulha é atualizada região a região (fim da
// última corrida de uma vira o startPoint da próxima), pra que a escolha da
// seção inicial DENTRO de cada região (fillRegion -> sections.
// orderSectionsByGraph) também parta de onde a agulha está de fato, não só
// da posição anterior a todo o bloco. Entre regiões o salto é inevitável
// (são áreas desconexas de verdade), mas fica só ~1 por região, não mais ~2
// por fileira cruzando de uma pra outra e voltando; e nunca um salto de
// distância zero (coalesceZeroGapRuns).
function fillRegionsTatami(polygons, opts = {}) {
  const regions = groupRingsIntoRegions(polygons);
  if (regions.length === 0) return [];
  const ordered = orderRegionsWithTwoOpt(regions, opts.startPoint);
  const runs = [];
  let needle = opts.startPoint || [0, 0];
  for (const region of ordered) {
    const regionOpts = Object.assign({}, opts, { startPoint: needle });
    for (const run of fillRegion(region, regionOpts)) {
      if (run.length) {
        runs.push(run);
        needle = run[run.length - 1];
      }
    }
  }
  return coalesceZeroGapRuns(runs);
}

module.exports = {
  groupRingsIntoRegions,
  orderRegionsByProximity,
  orderRegionsWithTwoOpt,
  regionsDistance,
  findTravelPath,
  isStraightSegmentInside,
  exceedsTravelCeiling,
  connectRuns,
  isInsideRegion,
  fillRegion,
  fillRegionsTatami,
  coalesceZeroGapRuns,
};
