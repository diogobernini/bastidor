'use strict';
// Digitalização: PNG/JPG/WebP -> vetor -> pontos (issue #2 do roadmap).
// Núcleo puro (sem Electron/canvas): recebe pixels já decodificados pelo
// chamador ({ width, height, data: Uint8ClampedArray RGBA }) e devolve
// contornos em pixels ou, no fim da pipeline, um Pattern pronto.
//
// Etapas: quantize (median-cut) -> traceRegions (marching squares, por cor)
// -> simplify (Douglas-Peucker, polígono fechado) -> rasterToPaths (junta
// tudo) -> pathsToPattern (ponto corrido pelos contornos).

const { Pattern } = require('../pattern');
const fill = require('./fill');
const runstitch = require('./runstitch');

// ------------------------------------------------------------ quantização

// Median-cut: divide os pixels opacos em até k grupos por cor, cada grupo
// tornando-se uma cor da paleta (média do grupo). Pixels com alpha < 128
// são ignorados e marcados como transparentes (255) no indexado.
function quantize(image, k) {
  const { width, height, data } = image;
  k = Math.max(2, Math.min(8, Math.round(k) || 2));
  const n = width * height;

  const opaqueIdx = [];
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] >= 128) opaqueIdx.push(i);
  }

  const indexed = new Uint8Array(n).fill(255);
  if (opaqueIdx.length === 0) return { palette: [], indexed };

  let buckets = [opaqueIdx];

  function channelRange(bucket, ch) {
    let min = 255;
    let max = 0;
    for (const i of bucket) {
      const v = data[i * 4 + ch];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return max - min;
  }

  // Canal (0=R,1=G,2=B) com maior variação no grupo: é o que mais separa cores ao dividir.
  function widestChannel(bucket) {
    const rr = channelRange(bucket, 0);
    const rg = channelRange(bucket, 1);
    const rb = channelRange(bucket, 2);
    if (rr >= rg && rr >= rb) return 0;
    if (rg >= rb) return 1;
    return 2;
  }

  while (buckets.length < k) {
    // Escolhe o grupo com maior faixa de cor para dividir (maior redução de erro).
    let splitIdx = -1;
    let splitRange = -1;
    let splitCh = 0;
    for (let bi = 0; bi < buckets.length; bi++) {
      if (buckets[bi].length < 2) continue;
      const ch = widestChannel(buckets[bi]);
      const range = channelRange(buckets[bi], ch);
      if (range > splitRange) {
        splitRange = range;
        splitIdx = bi;
        splitCh = ch;
      }
    }
    if (splitIdx === -1 || splitRange <= 0) break; // nada mais para dividir

    const bucket = buckets[splitIdx];
    bucket.sort((pa, pb) => data[pa * 4 + splitCh] - data[pb * 4 + splitCh]);

    // Divide na fronteira de valor mais próxima do meio, nunca no meio de um
    // empate: cortar por índice puro partiria um grupo de pixels da mesma
    // cor em dois, misturando cores na média final.
    const idealMid = bucket.length / 2;
    let mid = -1;
    let bestDist = Infinity;
    for (let i = 1; i < bucket.length; i++) {
      if (data[bucket[i] * 4 + splitCh] !== data[bucket[i - 1] * 4 + splitCh]) {
        const dist = Math.abs(i - idealMid);
        if (dist < bestDist) {
          bestDist = dist;
          mid = i;
        }
      }
    }
    if (mid === -1) break; // não deveria ocorrer (splitRange > 0 garante uma fronteira)
    buckets.splice(splitIdx, 1, bucket.slice(0, mid), bucket.slice(mid));
  }

  const palette = buckets.map((bucket) => {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (const i of bucket) {
      sr += data[i * 4];
      sg += data[i * 4 + 1];
      sb += data[i * 4 + 2];
    }
    const cnt = bucket.length;
    return [Math.round(sr / cnt), Math.round(sg / cnt), Math.round(sb / cnt)];
  });

  buckets.forEach((bucket, paletteIndex) => {
    for (const i of bucket) indexed[i] = paletteIndex;
  });

  return { palette, indexed };
}

// -------------------------------------------------------- marching squares

// Tabela de casos do marching squares para grade binária. Cada célula tem 4
// cantos (tl,tr,br,bl); idx = tl*8 + tr*4 + br*2 + bl. Os segmentos usam os
// pontos médios das arestas da célula (N=topo, E=direita, S=baixo, W=esquerda)
// e são direcionados de forma que a região "dentro" (valor 1) fique sempre à
// esquerda do sentido percorrido — por isso contornos externos e furos saem
// com orientação (sinal da área) sempre oposta, sem tratamento especial.
// Casos 5 e 10 são as saddles (cantos opostos), resolvidas como dois
// segmentos simples independentes.
const CASE_SEGMENTS = [
  /* 0 */ [],
  /* 1 */ [['S', 'W']],
  /* 2 */ [['E', 'S']],
  /* 3 */ [['E', 'W']],
  /* 4 */ [['N', 'E']],
  /* 5 */ [['N', 'E'], ['S', 'W']],
  /* 6 */ [['N', 'S']],
  /* 7 */ [['N', 'W']],
  /* 8 */ [['W', 'N']],
  /* 9 */ [['S', 'N']],
  /* 10 */ [['W', 'N'], ['E', 'S']],
  /* 11 */ [['E', 'N']],
  /* 12 */ [['W', 'E']],
  /* 13 */ [['S', 'E']],
  /* 14 */ [['W', 'S']],
  /* 15 */ [],
];

// Contornos fechados (marching squares) da região onde indexed[i] === colorIndex.
// Devolve uma lista de anéis [[x,y],...] em coordenadas de pixel (podem cair
// em meio-pixel, já que a fronteira passa entre um pixel da cor e outro que
// não é). Ilhas e furos saem como anéis independentes, com orientação
// (sinal da área via fórmula de Gauss) sempre oposta entre externo e furo.
function traceRegions(indexed, width, height, colorIndex) {
  // Grade com 1 pixel de moldura "fora" (valor 0) para fechar contornos que
  // tocam a borda da imagem.
  const W = width + 2;
  const H = height + 2;
  const val = (x, y) => {
    if (x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1) return 0;
    return indexed[(y - 1) * width + (x - 1)] === colorIndex ? 1 : 0;
  };

  const fromMap = new Map(); // "x,y" do ponto de partida -> [x,y] de chegada
  const key = (x, y) => x + ',' + y;

  for (let cy = 0; cy < H - 1; cy++) {
    for (let cx = 0; cx < W - 1; cx++) {
      const tl = val(cx, cy);
      const tr = val(cx + 1, cy);
      const br = val(cx + 1, cy + 1);
      const bl = val(cx, cy + 1);
      const idx = tl * 8 + tr * 4 + br * 2 + bl;
      const segs = CASE_SEGMENTS[idx];
      if (!segs.length) continue;
      const pts = {
        N: [cx + 0.5, cy],
        E: [cx + 1, cy + 0.5],
        S: [cx + 0.5, cy + 1],
        W: [cx, cy + 0.5],
      };
      for (const [from, to] of segs) {
        fromMap.set(key(...pts[from]), pts[to]);
      }
    }
  }

  // Encadeia os segmentos direcionados: cada ponto de cruzamento tem
  // exatamente uma saída e uma entrada, então seguir "de -> para" sempre
  // fecha em um anel simples.
  const visited = new Set();
  const contours = [];
  for (const startKey of fromMap.keys()) {
    if (visited.has(startKey)) continue;
    const contour = [];
    let curKey = startKey;
    let guard = 0;
    while (!visited.has(curKey)) {
      visited.add(curKey);
      const [xs, ys] = curKey.split(',').map(Number);
      contour.push([xs - 1, ys - 1]); // remove o deslocamento da moldura
      const to = fromMap.get(curKey);
      if (!to) break; // dados inconsistentes; encerra o anel aberto por segurança
      curKey = key(to[0], to[1]);
      guard++;
      if (guard > fromMap.size + 4) break; // guarda contra loop infinito
    }
    if (contour.length >= 3) contours.push(contour);
  }
  return contours;
}

// --------------------------------------------------------------- simplify

function perpendicularDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

// Douglas-Peucker clássico para uma cadeia aberta (mantém sempre o primeiro
// e o último ponto).
function douglasPeucker(points, tolerance) {
  if (points.length < 3) return points.slice();
  let maxDist = -1;
  let maxIdx = -1;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }
  if (maxDist <= tolerance) return [first, last];
  const left = douglasPeucker(points.slice(0, maxIdx + 1), tolerance);
  const right = douglasPeucker(points.slice(maxIdx), tolerance);
  return left.slice(0, -1).concat(right);
}

// Pontos de "points[from]" até "points[to]" andando sempre para frente,
// dando a volta (módulo) se to < from. Usado para partir o anel em duas
// cadeias abertas.
function sliceLoop(points, from, to) {
  const n = points.length;
  const out = [];
  let i = from;
  for (;;) {
    out.push(points[i]);
    if (i === to) break;
    i = (i + 1) % n;
  }
  return out;
}

// Douglas-Peucker para um polígono FECHADO (é assim que traceRegions sempre
// devolve os contornos: um anel, sem repetir o primeiro ponto no final).
// tolerance está na mesma unidade dos pontos recebidos (o nome "toleranceMm"
// só documenta o uso típico — quando os pontos já estão em milímetros; ao
// simplificar contornos em pixels, passe a tolerância equivalente em pixels).
function simplify(points, toleranceMm) {
  const tolerance = toleranceMm;
  const n = points.length;
  if (n <= 3 || !tolerance || tolerance <= 0) return points.slice();

  // Duas âncoras (mín-x e máx-x, com empate por y) que dividem o anel em
  // duas cadeias abertas; simplifica cada uma separadamente e junta o
  // resultado. Sem isso, o ponto onde o array "começa" ficaria preso mesmo
  // quando redundante (Douglas-Peucker aberto nunca remove suas próprias pontas).
  let iMin = 0;
  let iMax = 0;
  for (let i = 1; i < n; i++) {
    const p = points[i];
    if (p[0] < points[iMin][0] || (p[0] === points[iMin][0] && p[1] < points[iMin][1])) iMin = i;
    if (p[0] > points[iMax][0] || (p[0] === points[iMax][0] && p[1] > points[iMax][1])) iMax = i;
  }
  if (iMin === iMax) return points.slice(); // degenerado (todos no mesmo ponto)

  const chainA = sliceLoop(points, iMin, iMax);
  const chainB = sliceLoop(points, iMax, iMin);
  const a = douglasPeucker(chainA, tolerance);
  const b = douglasPeucker(chainB, tolerance);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

// ----------------------------------------------------------- rasterToPaths

function rgbToHex([r, g, b]) {
  const h = (v) => v.toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

// Pipeline completo em pixels: posteriza, traça e simplifica cada cor da
// paleta. options.colors: 2..8 (padrão 4). options.simplifyTol: tolerância
// do Douglas-Peucker EM PIXELS (padrão ~1,5 px); quem chama converte a
// tolerância em mm escolhida na interface para pixels antes de passar aqui.
// Índice de paleta mais frequente na borda da imagem: numa foto/logotipo o
// fundo encosta na moldura; é a cor que o usuário quase nunca quer costurar.
function borderBackgroundIndex(indexed, width, height) {
  const counts = new Map();
  const bump = (i) => {
    const v = indexed[i];
    if (v === 255) return; // transparente já não vira ponto
    counts.set(v, (counts.get(v) || 0) + 1);
  };
  for (let x = 0; x < width; x++) {
    bump(x);
    bump((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    bump(y * width);
    bump(y * width + width - 1);
  }
  let best = -1;
  let bestCount = 0;
  for (const [v, n] of counts) {
    if (n > bestCount) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}

function rasterToPaths(image, options = {}) {
  const colors = Math.max(2, Math.min(8, Math.round(options.colors !== undefined ? options.colors : 4)));
  const simplifyTol = options.simplifyTol !== undefined ? options.simplifyTol : 1.5;

  const { palette, indexed } = quantize(image, colors);
  const skipIndex = options.ignoreBackground
    ? borderBackgroundIndex(indexed, image.width, image.height)
    : -1;
  const paths = [];
  for (let ci = 0; ci < palette.length; ci++) {
    if (ci === skipIndex) continue;
    const rawContours = traceRegions(indexed, image.width, image.height, ci);
    const contours = [];
    for (const raw of rawContours) {
      const pts = simplifyTol > 0 ? simplify(raw, simplifyTol) : raw;
      if (pts.length >= 3) contours.push(pts);
    }
    if (contours.length) paths.push({ color: rgbToHex(palette[ci]), contours });
  }
  return paths;
}

// -------------------------------------------------------- paths -> Pattern

// Converte a saída de rasterToPaths em um Pattern: ponto corrido percorrendo
// cada contorno (jump até o início, ponto até fechar de volta no início),
// um bloco de cor por cor da paleta com COLOR_CHANGE entre blocos.
//
// options.scale: fator pixels -> unidade nativa do Pattern (0,1 mm). Ex.:
// para uma largura final de 80 mm numa imagem de 320 px, scale = 800/320 = 2,5.
// options.stitchLenMm: comprimento de ponto ao costurar os contornos (padrão 2,5 mm).
//
// PREENCHIMENTO (tatami): esta função gera só o contorno em ponto corrido.
// O preenchimento de área para formas fechadas é o algoritmo de fill da
// issue #1 (digitalização de SVG); quando estiver pronto, o lugar de
// encaixar entra bem aqui, dentro do laço de contornos abaixo — cada
// `contour` já é um polígono fechado e pode alimentar o fill diretamente,
// antes ou em vez do ponto corrido do contorno.
function pathsToPattern(paths, options = {}) {
  const scale = options.scale || 1;
  const outline = options.outline !== false;
  const outlineStitch = Math.max(1, Math.round((options.stitchLenMm !== undefined ? options.stitchLenMm : 2.5) * 10));
  const doFill = !!options.fill;
  // Parâmetros do tatami em unidades nativas (0,1 mm), mesmos nomes do
  // importador de SVG (fill.js é compartilhado entre os dois caminhos).
  const fillSpacing = Math.max(1, (options.fillSpacingMm !== undefined ? options.fillSpacingMm : 0.4) * 10);
  const fillAngle = options.fillAngleDeg !== undefined ? options.fillAngleDeg : 0;
  const fillStitch = Math.max(5, (options.fillStitchMm !== undefined ? options.fillStitchMm : 3) * 10);

  const pattern = new Pattern();
  const visible = paths.filter((p) => p.contours && p.contours.length);
  for (const p of visible) pattern.addThread(p.color);

  function emitRuns(runs) {
    for (const run of runs) {
      if (!run.length) continue;
      pattern.moveAbs(Math.round(run[0][0]), Math.round(run[0][1]));
      for (let i = 1; i < run.length; i++) pattern.stitchAbs(Math.round(run[i][0]), Math.round(run[i][1]));
    }
  }

  visible.forEach((p, pi) => {
    // Todos os anéis da cor entram juntos no preenchimento: o par-ímpar das
    // varreduras (spansAtY) é o que preserva os furos (contornos internos).
    const rings = p.contours.map((ct) => ct.map(([x, y]) => [x * scale, y * scale]));
    if (doFill) {
      emitRuns(fill.fillPolygonsTatami(rings, {
        angleDeg: fillAngle,
        rowSpacing: fillSpacing,
        stitchLength: fillStitch,
      }));
    }
    if (outline) {
      for (const ring of rings) {
        const resampled = runstitch.resampleRunStitch(ring, outlineStitch, true);
        if (resampled.length >= 2) emitRuns([[...resampled, resampled[0]]]);
      }
    }
    if (pi < visible.length - 1) pattern.colorChange();
  });
  pattern.end();
  return pattern;
}

module.exports = { quantize, traceRegions, simplify, rasterToPaths, pathsToPattern };
