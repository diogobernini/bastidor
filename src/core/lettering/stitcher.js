'use strict';
// Converte texto (via layout.js) num Pattern do núcleo. Duas famílias de
// fonte, discriminadas por font.kind (ver svgfont.js/inkstitchfont.js/
// ttffont.js — os três produzem o mesmo "formato de fonte", só mudando o
// conteúdo de cada glifo e esse campo):
//
// - font.kind === 'stroke' (fontes de traço único e Ink/Stitch): cada traço
//   do glifo vira ponto corrido reamostrado a cada stitchLengthMm (padrão
//   2 mm), ponto triplo/"bean" (ida-volta-ida em cada segmento) quando
//   opts.bean, ou ponto cheio/satin (zigue-zague via satin.js — issue #19)
//   quando opts.finish === 'satin'.
// - font.kind === 'fill' (fontes TTF/OTF — issue #20): cada glifo é um ou
//   mais contornos fechados (com furos em letras como "o"/"a"/"e", e até
//   mais de uma região desconexa — "i", ":", "%"), preenchidos região por
//   região pelo roteamento de preenchimento existente
//   (src/core/digitize/regions.js, issue #67, por cima do motor de
//   preenchimento tatami em src/core/digitize/fill.js) e, opcionalmente,
//   contornados em ponto corrido (src/core/digitize/runstitch.js) — os
//   mesmos mecanismos que a digitalização de SVG já usa.
//
// Em ambos os casos: salto (sem costura) entre traços/contornos e entre
// letras; um único fio (preto, por padrão); termina com end(). Por padrão, o
// resultado sai centralizado na origem (opts.center = false para desligar).

const { Pattern, Thread } = require('../pattern');
const C = require('../commands');
const { layoutText } = require('./layout');
const { resamplePolyline } = require('./resample');
const satin = require('./satin');
const regions = require('../digitize/regions');
const runstitch = require('../digitize/runstitch');

const DEFAULT_STITCH_LENGTH_MM = 2;
const DEFAULT_FILL_SPACING_MM = 0.4;
const DEFAULT_FILL_STITCH_MM = 3;
const DEFAULT_OUTLINE_STITCH_MM = 2.5;

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

// Preenche (e, opcionalmente, contorna) UM glifo de fonte TTF/OTF já
// posicionado no design (placed.glyph.rings ainda em unidades de fonte).
// Devolve true se alguma agulhada foi de fato gravada (glifo com tinta).
function emitFillGlyph(pattern, placed, opts) {
  const rings = (placed.glyph.rings || [])
    .map((ring) => ring.map(([x, y]) => [placed.originX + x * placed.scale, placed.originY + y * placed.scale]))
    .filter((ring) => ring.length >= 3);
  if (!rings.length) return false;

  let emitted = false;
  // fillRegionsTatami (issue #67): um glifo TTF pode ter mais de uma região
  // desconexa (ponto do "i", os dois círculos do "%", etc.) — preenche cada
  // uma isoladamente e ordena pela posição atual da agulha, em vez de
  // varrer todos os anéis do glifo numa scanline global só.
  const runs = regions.fillRegionsTatami(
    rings.map((points) => ({ points })),
    {
      angleDeg: opts.fillAngleDeg,
      rowSpacing: opts.fillSpacingUnits,
      stitchLength: opts.fillStitchUnits,
      startPoint: pattern.currentPosition(),
    }
  );
  for (const run of runs) {
    if (!run.length) continue;
    pattern.moveAbs(run[0][0], run[0][1]);
    emitted = true;
    for (let i = 1; i < run.length; i++) pattern.stitchAbs(run[i][0], run[i][1]);
  }

  if (opts.outline) {
    for (const ring of rings) {
      const resampled = runstitch.resampleRunStitch(ring, opts.outlineStepUnits, true);
      if (resampled.length < 2) continue;
      pattern.moveAbs(resampled[0][0], resampled[0][1]);
      emitted = true;
      for (let i = 1; i < resampled.length; i++) pattern.stitchAbs(resampled[i][0], resampled[i][1]);
      pattern.stitchAbs(resampled[0][0], resampled[0][1]); // fecha o contorno de volta ao início
    }
  }
  return emitted;
}

function textToPattern(font, text, opts = {}) {
  const stitchLengthMm = opts.stitchLengthMm > 0 ? opts.stitchLengthMm : DEFAULT_STITCH_LENGTH_MM;
  const stepUnits = stitchLengthMm * 10; // 0,1 mm
  const finish = resolveFinish(opts);
  const color = opts.color !== undefined ? opts.color : 0x000000;
  const satinWidthUnits = (opts.satinWidthMm > 0 ? opts.satinWidthMm : satin.DEFAULT_WIDTH_MM) * 10;
  const satinDensityUnits = (opts.satinDensityMm > 0 ? opts.satinDensityMm : satin.DEFAULT_DENSITY_MM) * 10;
  const underlay = finish === 'satin' && !!opts.underlay;
  const fillOpts = {
    fillAngleDeg: Number.isFinite(opts.fillAngleDeg) ? opts.fillAngleDeg : 0,
    fillSpacingUnits: (opts.fillSpacingMm > 0 ? opts.fillSpacingMm : DEFAULT_FILL_SPACING_MM) * 10,
    fillStitchUnits: (opts.fillStitchMm > 0 ? opts.fillStitchMm : DEFAULT_FILL_STITCH_MM) * 10,
    outline: !!opts.outline,
    outlineStepUnits: (opts.outlineStitchMm > 0 ? opts.outlineStitchMm : DEFAULT_OUTLINE_STITCH_MM) * 10,
  };

  const laid = layoutText(font, text, opts);

  const pattern = new Pattern();
  pattern.addThread(new Thread(color));

  let hasStitches = false;
  for (const placed of laid.glyphs) {
    if (font.kind === 'fill') {
      if (emitFillGlyph(pattern, placed, fillOpts)) hasStitches = true;
      continue;
    }
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
