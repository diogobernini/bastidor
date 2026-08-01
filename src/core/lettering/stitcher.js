'use strict';
// Converte texto (via layout.js) num Pattern do núcleo: cada traço de cada
// glifo se torna ponto corrido reamostrado a cada stitchLengthMm (padrão
// 2 mm), ponto triplo/"bean" (ida-volta-ida em cada segmento) quando
// opts.bean, ou ponto cheio/satin (zigue-zague via satin.js — issue #19)
// quando opts.finish === 'satin'; salto (sem costura) entre traços e entre
// letras; um único fio (preto, por padrão); termina com end(). Por padrão, o
// resultado sai centralizado na origem (opts.center = false para desligar).

const { Pattern, Thread } = require('../pattern');
const C = require('../commands');
const { layoutText } = require('./layout');
const { resamplePolyline } = require('./resample');
const satin = require('./satin');

const DEFAULT_STITCH_LENGTH_MM = 2;

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

// Acabamento pedido em opts: 'running' (ponto corrido, padrão), 'bean'
// (ponto triplo) ou 'satin' (ponto cheio). opts.finish é a forma nova e
// preferida; opts.bean continua funcionando sozinho (compatibilidade com a
// fase 1) quando opts.finish não é informado.
function resolveFinish(opts) {
  if (opts.finish === 'satin') return 'satin';
  if (opts.finish === 'bean' || opts.bean) return 'bean';
  return 'running';
}

// Monta a sequência de agulhadas do ponto cheio para um traço: o zigue-zague
// (satin.satinizeStroke) e, se opts.underlay, um ponto corrido pelo centro
// do traço antes dele. Quando há underlay, o zigue-zague é percorrido de
// trás para frente (do fim do traço para o início): o underlay já deixou a
// agulha perto do fim do traço, então "voltar" pelo satin evita uma agulhada
// longa ligando o fim do underlay ao início do zigue-zague (que começa perto
// do início do traço, do outro lado do glifo).
function buildSatinSequence(pts, { widthUnits, densityUnits, underlay, stepUnits }) {
  const zigzag = satin.satinizeStroke(pts, { widthUnits, densityUnits });
  if (!underlay) return zigzag;
  const under = resamplePolyline(pts, stepUnits);
  if (under.length < 2) return zigzag;
  if (zigzag.length < 2) return under;
  return [...under, ...zigzag.slice().reverse()];
}

function textToPattern(font, text, opts = {}) {
  const stitchLengthMm = opts.stitchLengthMm > 0 ? opts.stitchLengthMm : DEFAULT_STITCH_LENGTH_MM;
  const stepUnits = stitchLengthMm * 10; // 0,1 mm
  const finish = resolveFinish(opts);
  const color = opts.color !== undefined ? opts.color : 0x000000;
  const satinWidthUnits = (opts.satinWidthMm > 0 ? opts.satinWidthMm : satin.DEFAULT_WIDTH_MM) * 10;
  const satinDensityUnits = (opts.satinDensityMm > 0 ? opts.satinDensityMm : satin.DEFAULT_DENSITY_MM) * 10;
  const underlay = finish === 'satin' && !!opts.underlay;

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

      const sequence =
        finish === 'satin'
          ? buildSatinSequence(pts, { widthUnits: satinWidthUnits, densityUnits: satinDensityUnits, underlay, stepUnits })
          : resamplePolyline(pts, stepUnits);
      if (sequence.length < 2) continue;

      pattern.moveAbs(sequence[0][0], sequence[0][1]);
      hasStitches = true;
      stitchSegments(pattern, sequence, finish === 'bean');
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
  resolveFinish,
  buildSatinSequence,
  DEFAULT_STITCH_LENGTH_MM,
};
