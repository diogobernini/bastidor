'use strict';
// Digitalização: converte um SVG vetorial em uma matriz de bordado (Pattern).
// Um bloco de cor por cor do SVG — todos os preenchimentos primeiro, depois
// os contornos (traços/"stroke"), cada grupo na ordem de primeira aparição
// no documento — com troca de cor entre blocos e end() no final.

const { Pattern } = require('../pattern');
const svgimport = require('./svgimport');
const fill = require('./fill');
const runstitch = require('./runstitch');

const MM = 10; // 1 mm = 10 unidades internas (0,1 mm)

const DEFAULTS = {
  fillSpacingMm: 0.4,
  fillAngleDeg: 0,
  fillStitchMm: 3,
  outlineStitchMm: 2.5,
  outline: true,
  fill: true,
};

// Escala toda a geometria para a largura final pedida ANTES de costurar:
// assim o espaçamento/agulhada em mm valem de verdade (redimensionar o
// Pattern depois esmagaria ou esticaria a densidade).
function scaleGroupsToTargetWidth(groups, targetWidthMm) {
  if (!targetWidthMm || !(targetWidthMm > 0)) return;
  let minX = Infinity;
  let maxX = -Infinity;
  const visit = (pts) => {
    for (const p of pts) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
    }
  };
  for (const g of groups.fills) for (const r of g.rings) visit(r.points || r);
  for (const g of groups.strokes) for (const pl of g.polylines) visit(pl.points);
  const w = maxX - minX;
  if (!(w > 0)) return;
  const f = (targetWidthMm * MM) / w;
  const scalePts = (pts) => {
    for (const p of pts) {
      p[0] *= f;
      p[1] *= f;
    }
  };
  for (const g of groups.fills) for (const r of g.rings) scalePts(r.points || r);
  for (const g of groups.strokes) for (const pl of g.polylines) scalePts(pl.points);
}

function importSvg(svgText, opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts);
  const groups = svgimport.parseSvgToShapeGroups(svgText);
  scaleGroupsToTargetWidth(groups, cfg.targetWidthMm);

  const pattern = new Pattern();
  let started = false;

  for (const { color, rings } of cfg.fill === false ? [] : groups.fills) {
    const runs = fill.fillPolygonsTatami(rings, {
      angleDeg: cfg.fillAngleDeg,
      rowSpacing: cfg.fillSpacingMm * MM,
      stitchLength: cfg.fillStitchMm * MM,
    });
    if (!runs.length) continue;
    if (started) pattern.colorChange();
    pattern.addThread(color);
    emitRuns(pattern, runs);
    started = true;
  }

  if (cfg.outline) {
    for (const { color, polylines } of groups.strokes) {
      const runs = [];
      for (const pl of polylines) {
        if (!pl.points || pl.points.length < 2) continue;
        const resampled = runstitch.resampleRunStitch(pl.points, cfg.outlineStitchMm * MM, pl.closed);
        if (resampled.length < 2) continue;
        runs.push(pl.closed ? [...resampled, resampled[0]] : resampled);
      }
      if (!runs.length) continue;
      if (started) pattern.colorChange();
      pattern.addThread(color);
      emitRuns(pattern, runs);
      started = true;
    }
  }

  if (started) pattern.end();
  return pattern;
}

function emitRuns(pattern, runs) {
  for (const run of runs) {
    if (!run.length) continue;
    pattern.moveAbs(round2(run[0][0]), round2(run[0][1]));
    for (let i = 1; i < run.length; i++) pattern.stitchAbs(round2(run[i][0]), round2(run[i][1]));
  }
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

module.exports = {
  importSvg,
  parseSvgToShapeGroups: svgimport.parseSvgToShapeGroups,
  fillPolygonsTatami: fill.fillPolygonsTatami,
  resampleRunStitch: runstitch.resampleRunStitch,
  svgpath: require('./svgpath'),
};
