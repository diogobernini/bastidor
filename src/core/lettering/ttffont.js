'use strict';
// Leitor de fontes TTF/OTF (issue #20, fase 3): usa opentype.js (MIT) para
// extrair os contornos dos glifos e adapta pro mesmo "formato de fonte"
// usado pelo resto do lettering — glyphs: Map<char, {advance, ...}>, ascent,
// descent, unitsPerEm, defaultAdvance, kernMap, missingGlyph — o mesmo shape
// que svgfont.js/inkstitchfont.js produzem, então layout.js não muda NADA
// (só olha .advance/.glyphs/.kernMap). A diferença fica marcada em
// font.kind: aqui é 'fill' (contornos fechados, preenchidos por
// src/core/digitize/fill.js), não 'stroke' (traço único/Ink-Stitch, ponto
// corrido/bean/satin ao longo do caminho) — stitcher.js é quem lê esse
// campo e escolhe o pipeline certo.
//
// Cada glifo do TTF já é uma curva vetorial fechada (com furos em letras
// como "o"/"a"/"e" — um anel por furo, regra even-odd) em unidades de fonte,
// Y para cima, baseline em 0 — a MESMA convenção do SVG Font que svgfont.js
// já trata. glyph.path.toPathData() (opentype.js) devolve isso como uma
// string "d" de SVG comum, então achatamos com o parser de path que a
// digitalização de SVG já usa (src/core/digitize/svgpath.js), sem duplicar
// nenhuma lógica de curva aqui.

const fs = require('fs');
const opentype = require('opentype.js');
const svgpath = require('../digitize/svgpath');

const DEFAULT_TOLERANCE_EM_FRACTION = 0.001; // 0,1% do units-per-em, igual ao svgfont.js

// Cobertura de glifos: ASCII imprimível + Latin-1 Supplement (0x20-0xFF) —
// cobre o alfabeto latino comum com acentos (pt-BR incluso) sem varrer os
// milhares de glifos que uma TTF completa pode ter (símbolos, ligaduras,
// outros scripts). Kerning só é calculado no subconjunto ASCII imprimível
// (0x21-0x7E): é o caso de longe mais comum e mantém o custo baixo (a
// combinatória de pares cresce com o quadrado da cobertura).
const GLYPH_RANGE = [0x20, 0xff];
const KERNING_RANGE = [0x21, 0x7e];

// glyph.path.commands -> anéis fechados (arrays de [x, y], já com Y
// invertido para baixo — mesma inversão de svgfont.js). Cada subpath vira um
// anel; glifos com furos (o, a, e...) têm mais de um anel, combinados depois
// pela regra even-odd de fill.fillPolygonsTatami (mesmo mecanismo que a
// digitalização de SVG já usa para furos).
function glyphToRings(glyph, tolerance) {
  const d = glyph.path.toPathData(4);
  if (!d) return [];
  const subpaths = svgpath.parsePathD(d);
  const flattened = svgpath.flattenSubpaths(subpaths, tolerance);
  const rings = [];
  for (const sp of flattened) {
    if (sp.points.length < 3) continue;
    rings.push(sp.points.map(([x, y]) => [x, -y]));
  }
  return rings;
}

function familyName(otFont, fallback) {
  const names = otFont.names || {};
  const table = names.windows || names.macintosh || {};
  const family = table.fontFamily;
  if (!family) return fallback;
  return family.en || Object.values(family)[0] || fallback;
}

function parseBuffer(buffer, fallbackFamily) {
  const otFont = opentype.parse(bufferToArrayBuffer(buffer));
  const unitsPerEm = otFont.unitsPerEm || 1000;
  const tolerance = unitsPerEm * DEFAULT_TOLERANCE_EM_FRACTION;
  const ascent = otFont.ascender || unitsPerEm * 0.8;
  const descent = otFont.descender || -unitsPerEm * 0.2;

  const spaceGlyph = otFont.charToGlyph(' ');
  const defaultAdvance = (spaceGlyph && spaceGlyph.index !== 0 && spaceGlyph.advanceWidth) || unitsPerEm / 2;

  const glyphs = new Map();
  for (let cp = GLYPH_RANGE[0]; cp <= GLYPH_RANGE[1]; cp++) {
    const ch = String.fromCodePoint(cp);
    if (ch === ' ') continue; // espaço só avança; layout.js já trata sem desenhar
    const glyph = otFont.charToGlyph(ch);
    if (!glyph || glyph.index === 0) continue; // .notdef: a fonte não tem esse caractere
    glyphs.set(ch, {
      advance: glyph.advanceWidth || defaultAdvance,
      rings: glyphToRings(glyph, tolerance),
    });
  }

  const kernMap = new Map();
  const kernChars = [];
  for (let cp = KERNING_RANGE[0]; cp <= KERNING_RANGE[1]; cp++) {
    const ch = String.fromCodePoint(cp);
    if (glyphs.has(ch)) kernChars.push(ch);
  }
  const kernGlyphs = kernChars.map((ch) => otFont.charToGlyph(ch));
  for (let i = 0; i < kernChars.length; i++) {
    for (let j = 0; j < kernChars.length; j++) {
      const k = otFont.getKerningValue(kernGlyphs[i], kernGlyphs[j]);
      if (k) kernMap.set(kernChars[i] + ' ' + kernChars[j], k);
    }
  }

  return {
    id: null,
    family: familyName(otFont, fallbackFamily),
    kind: 'fill',
    unitsPerEm,
    ascent,
    descent,
    capHeight: null,
    xHeight: null,
    defaultAdvance,
    glyphs,
    missingGlyph: { advance: defaultAdvance, rings: [] },
    kernMap,
  };
}

function bufferToArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function parseFile(absPath) {
  const path = require('path');
  const buffer = fs.readFileSync(absPath);
  return parseBuffer(buffer, path.basename(absPath).replace(/\.(ttf|otf)$/i, ''));
}

module.exports = { parseFile, parseBuffer };
