'use strict';
// Converte texto (via layout.js) num Pattern do núcleo: cada traço de cada
// glifo se torna ponto corrido reamostrado a cada stitchLengthMm (padrão
// 2 mm), ou ponto triplo/"bean" (ida-volta-ida em cada segmento) quando
// opts.bean; salto (sem costura) entre traços e entre letras; um único fio
// (preto, por padrão); termina com end(). Por padrão, o resultado sai
// centralizado na origem (opts.center = false para desligar).

const { Pattern, Thread } = require('../pattern');
const C = require('../commands');
const { layoutText } = require('./layout');

const DEFAULT_STITCH_LENGTH_MM = 2;

function dedupePoints(points) {
  const out = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 1e-6) out.push(p);
  }
  return out;
}

function roundDedupe(points) {
  return dedupePoints(points.map(([x, y]) => [Math.round(x), Math.round(y)]));
}

// Reamostra uma polilinha para que os pontos de saída fiquem a ~stepUnits de
// distância entre si (acumulando a sobra de cada segmento para o próximo, o
// que mantém o compasso constante mesmo atravessando vértices). Preserva o
// primeiro e o último ponto originais; o trecho final por isso pode ficar
// mais curto que stepUnits — prática comum em digitalização, para acertar
// exatamente o ponto final do traço.
function resamplePolyline(points, stepUnits) {
  const pts = dedupePoints(points);
  if (pts.length < 2) return [];
  if (!(stepUnits > 0)) return roundDedupe(pts);

  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const segLen = Math.hypot(x1 - x0, y1 - y0);
    if (segLen <= 1e-9) continue;
    let dist = stepUnits - carry;
    while (dist <= segLen) {
      const t = dist / segLen;
      out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
      dist += stepUnits;
    }
    carry = segLen - (dist - stepUnits);
  }
  const last = pts[pts.length - 1];
  const outLast = out[out.length - 1];
  if (Math.hypot(last[0] - outLast[0], last[1] - outLast[1]) > 1e-6) out.push(last);

  const rounded = roundDedupe(out);
  return rounded.length >= 2 ? rounded : roundDedupe([pts[0], pts[pts.length - 1]]);
}

// Costura os segmentos de uma polilinha já reamostrada. Ponto triplo (bean):
// cada segmento é percorrido ida-volta-ida (3 agulhadas por segmento em vez
// de 1), sempre terminando no ponto de chegada, para reforçar traços finos.
function stitchSegments(pattern, points, bean) {
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    if (bean) {
      pattern.stitchAbs(bx, by);
      pattern.stitchAbs(ax, ay);
      pattern.stitchAbs(bx, by);
    } else {
      pattern.stitchAbs(bx, by);
    }
  }
}

function textToPattern(font, text, opts = {}) {
  const stitchLengthMm = opts.stitchLengthMm > 0 ? opts.stitchLengthMm : DEFAULT_STITCH_LENGTH_MM;
  const stepUnits = stitchLengthMm * 10; // 0,1 mm
  const bean = !!opts.bean;
  const color = opts.color !== undefined ? opts.color : 0x000000;

  const laid = layoutText(font, text, opts);

  const pattern = new Pattern();
  pattern.addThread(new Thread(color));

  let hasStitches = false;
  for (const placed of laid.glyphs) {
    for (const strokeFontPts of placed.glyph.strokes) {
      if (strokeFontPts.length < 2) continue;
      const pts = strokeFontPts.map(([x, y]) => [
        placed.originX + x * placed.scale,
        placed.originY + y * placed.scale,
      ]);
      const resampled = resamplePolyline(pts, stepUnits);
      if (resampled.length < 2) continue;

      pattern.moveAbs(resampled[0][0], resampled[0][1]);
      hasStitches = true;
      stitchSegments(pattern, resampled, bean);
    }
  }

  if (!hasStitches) {
    // Texto vazio ou sem nenhum traço desenhável (ex.: só espaços/caracteres
    // não suportados): matriz sem pontos, mas ainda válida (fio + end).
    pattern.moveAbs(0, 0);
  }

  // end() precisa vir antes do recentro: Pattern.translate() (usado por
  // moveCenterToOrigin) desloca todos os pontos em this.stitches, mas não
  // atualiza _previousX/_previousY — chamando end() depois do recentro, o
  // registro de END ficaria com as coordenadas antigas (pré-recentro).
  pattern.end();
  if (opts.center !== false) pattern.moveCenterToOrigin();
  return pattern;
}

// Agrupa pattern.stitches em polilinhas contíguas (cortadas em saltos, trocas
// de cor etc.) — mesma lógica de src/core/io/svg.js — para a pré-visualização
// da UI desenhar exatamente o traçado que será gravado.
function patternPolylines(pattern) {
  const polylines = [];
  let run = [];
  let lastPos = null;
  const flush = () => {
    if (run.length > 1) polylines.push(run);
    run = [];
  };
  for (const st of pattern.stitches) {
    const cmd = st[2] & C.COMMAND_MASK;
    const pt = [st[0], st[1]];
    if (cmd === C.STITCH || cmd === C.SEQUIN_EJECT) {
      if (run.length === 0 && lastPos) run.push(lastPos);
      run.push(pt);
      lastPos = pt;
    } else {
      flush();
      lastPos = pt;
    }
  }
  flush();
  return polylines;
}

module.exports = {
  textToPattern,
  resamplePolyline,
  patternPolylines,
  DEFAULT_STITCH_LENGTH_MM,
};
