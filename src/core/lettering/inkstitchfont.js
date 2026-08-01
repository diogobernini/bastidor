'use strict';
// Leitor PRÓPRIO do formato de fontes do Ink/Stitch (issue #20, fase 3): NÃO
// porta a engine deles (GPL, github.com/inkstitch/inkstitch) — lê apenas uma
// convenção de arquivo simples e nossa, inspirada na deles (uma pasta por
// fonte, com um "font.json" de metadados de bordado — nomes de campo no
// mesmo espírito dos usados por eles: units_per_em, horiz_adv_x, kerning —
// e um SVG por glifo). Os dados de fonte embutidos em fonts/inkstitch/ são
// OFL (ver LICENSE-OFL.txt em cada pasta de fonte, com a atribuição
// original).
//
// Cada arquivo de glifo é um SVG simples com um ou mais <path d="...">, em
// unidades de fonte e Y para cima (mesma convenção do SVG Font que
// svgfont.js já trata) — reusamos o parser de "d" de path da digitalização
// de SVG (src/core/digitize/svgpath.js) pra achatar, exatamente como a
// issue pediu, sem duplicar nenhuma lógica de curva aqui.
//
// O objeto de fonte devolvido tem o MESMO formato de svgfont.js (glyphs:
// Map<char, {advance, strokes}>, ascent, descent, unitsPerEm, kernMap) — só
// difere no field "kind": aqui também é 'stroke' (ponto corrido/bean/satin
// ao longo do traço, igual às fontes de traço único — a descrição da fonte
// real de onde os exemplos foram derivados já as chama de "running stitch
// font"), então layout.js e stitcher.js não precisam de nenhum código
// específico para esse tipo de fonte.

const fs = require('fs');
const path = require('path');
const svgpath = require('../digitize/svgpath');

const DEFAULT_TOLERANCE_EM_FRACTION = 0.001;

// Todos os atributos "d" de <path> num arquivo SVG de glifo. Não é um parser
// XML genérico (como svgfont.js, procura direto a tag "path").
function extractPathDs(svgText) {
  const ds = [];
  const re = /<path\b[^>]*\bd\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(svgText))) ds.push(unescapeXml(m[1]));
  return ds;
}

function unescapeXml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Um arquivo de glifo -> traços (polilinhas), Y já convertido pra baixo
// (mesma inversão de svgfont.js).
function loadGlyphStrokes(svgPath, tolerance) {
  const text = fs.readFileSync(svgPath, 'utf8');
  const strokes = [];
  for (const d of extractPathDs(text)) {
    const subpaths = svgpath.parsePathD(d);
    const flattened = svgpath.flattenSubpaths(subpaths, tolerance);
    for (const sp of flattened) {
      if (sp.points.length < 2) continue;
      strokes.push(sp.points.map(([x, y]) => [x, -y]));
    }
  }
  return strokes;
}

// font.json esperado: { family, license, unitsPerEm, ascent, descent,
// defaultAdvance, glyphs: [{char, file, advance}], kerning: [{first, second, amount}] }
function loadDir(dirPath) {
  const jsonPath = path.join(dirPath, 'font.json');
  const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const unitsPerEm = meta.unitsPerEm > 0 ? meta.unitsPerEm : 1000;
  const tolerance = unitsPerEm * DEFAULT_TOLERANCE_EM_FRACTION;
  const ascent = Number.isFinite(meta.ascent) ? meta.ascent : unitsPerEm * 0.8;
  const descent = Number.isFinite(meta.descent) ? meta.descent : -unitsPerEm * 0.2;
  const defaultAdvance = meta.defaultAdvance > 0 ? meta.defaultAdvance : unitsPerEm / 2;

  const glyphs = new Map();
  for (const g of meta.glyphs || []) {
    if (!g || !g.char || !g.file) continue;
    const glyphPath = path.join(dirPath, g.file);
    glyphs.set(g.char, {
      advance: g.advance > 0 ? g.advance : defaultAdvance,
      strokes: loadGlyphStrokes(glyphPath, tolerance),
    });
  }

  const kernMap = new Map();
  for (const k of meta.kerning || []) {
    if (!k || !k.first || !k.second || !Number.isFinite(k.amount)) continue;
    kernMap.set(k.first + ' ' + k.second, k.amount);
  }

  return {
    id: null,
    family: meta.family || path.basename(dirPath),
    kind: 'stroke',
    license: meta.license || null,
    unitsPerEm,
    ascent,
    descent,
    capHeight: null,
    xHeight: null,
    defaultAdvance,
    glyphs,
    missingGlyph: { advance: defaultAdvance, strokes: [] },
    kernMap,
  };
}

// Varre um diretório (ex.: fonts/inkstitch/) por subpastas com font.json —
// usado pelo catálogo em index.js, no mesmo espírito de listFonts().
function listDirs(baseDir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(baseDir, entry.name);
    if (!fs.existsSync(path.join(full, 'font.json'))) continue;
    out.push(entry.name);
  }
  return out;
}

module.exports = { loadDir, listDirs, extractPathDs };
