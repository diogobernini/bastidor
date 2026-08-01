'use strict';
// Leitor de fontes TTF/OTF (issue #20, fase 3): usa opentype.js (MIT) para
// extrair os contornos dos glifos e adapta pro mesmo "formato de fonte"
// usado pelo resto do lettering — glyphs: Map<char, {advance, ...}>, ascent,
// descent, unitsPerEm, defaultAdvance, kernMap, missingGlyph — o mesmo shape
// que svgfont.js/inkstitchfont.js produzem, então layout.js não precisa saber
// qual dos três leitores está por trás (só olha .advance/.glyphs/.kernMap e,
// opcionalmente, o hook ensureGlyphsForText descrito abaixo).
//
// Cada glifo do TTF já é uma curva vetorial fechada (com furos em letras
// como "o"/"a"/"e" — um anel por furo, regra even-odd) em unidades de fonte,
// Y para cima, baseline em 0 — a MESMA convenção do SVG Font que svgfont.js
// já trata. glyph.path.toPathData() (opentype.js) devolve isso como uma
// string "d" de SVG comum, então achatamos com o parser de path que a
// digitalização de SVG já usa (src/core/digitize/svgpath.js), sem duplicar
// nenhuma lógica de curva aqui.
//
// Carregamento sob demanda (issue #28, item 5): uma fonte TTF pode ter
// milhares de glifos (Pacifico-Regular.ttf tem ~1500) e calcular o contorno
// (rings) de cada um no carregamento seria desperdício quase sempre — o
// texto digitado é sempre um subconjunto minúsculo disso. Em vez de
// pré-carregar um intervalo fixo de código (a versão anterior varria só
// Latin-1, 0x20-0xFF, deixando de fora Latin Extended-A, Cirílico etc. mesmo
// quando a fonte tinha esses glifos), font.glyphs começa vazio e
// ensureGlyphsForText(text) — chamado por layout.js antes de percorrer o
// texto — busca em opentype.js só os caracteres realmente pedidos, com
// resultado cacheado em font.glyphs/font._missing (idempotente: textos
// repetidos ou prefixos já vistos não recalculam nada). O kerning segue a
// mesma lógica: só os pares ADJACENTES que aparecem no texto pedido são
// consultados (antes, era o produto cartesiano de todo o subconjunto ASCII
// imprimível no carregamento — O(n²) mesmo que o texto usasse duas letras).
// font.glyphCount (total de glifos da fonte, via opentype.js) fica disponível
// para o catálogo (listFonts) sem precisar carregar nenhum anel.

const fs = require('fs');
const opentype = require('opentype.js');
const svgpath = require('../digitize/svgpath');

const DEFAULT_TOLERANCE_EM_FRACTION = 0.001; // 0,1% do units-per-em, igual ao svgfont.js

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

// Garante que "ch" está em font.glyphs (ou confirmadamente ausente da
// fonte, em font._missing) — computa o anel/avanço uma única vez por
// caractere, na primeira vez que algum texto pedir por ele.
function ensureGlyph(font, ch) {
  if (font.glyphs.has(ch) || font._missing.has(ch)) return;
  const glyph = font._otFont.charToGlyph(ch);
  if (!glyph || glyph.index === 0) {
    font._missing.add(ch); // .notdef: a fonte não tem esse caractere
    return;
  }
  font.glyphs.set(ch, {
    advance: glyph.advanceWidth || font.defaultAdvance,
    rings: glyphToRings(glyph, font._tolerance),
  });
}

// Kerning entre um par ADJACENTE (a seguido de b) do texto pedido — nunca o
// produto cartesiano do alfabeto. font._kernChecked evita reconsultar
// opentype.js para o mesmo par em textos futuros (inclusive pares sem
// kerning, que getKerningValue devolve 0 e por isso nunca entram em kernMap).
function ensureKernPair(font, a, b) {
  const key = a + ' ' + b;
  if (font.kernMap.has(key) || font._kernChecked.has(key)) return;
  font._kernChecked.add(key);
  const ga = font._otFont.charToGlyph(a);
  const gb = font._otFont.charToGlyph(b);
  if (!ga || !gb || ga.index === 0 || gb.index === 0) return;
  const k = font._otFont.getKerningValue(ga, gb);
  if (k) font.kernMap.set(key, k);
}

// Hook chamado por layout.js antes de percorrer o texto: carrega glifos e
// kerning só do que este texto específico precisa. Idempotente e cumulativo
// (chamar de novo com um texto diferente só acrescenta o que faltar).
function ensureGlyphsForText(font, text) {
  const lines = String(text == null ? '' : text).split('\n');
  for (const line of lines) {
    const chars = Array.from(line);
    let prev = null;
    for (const ch of chars) {
      if (ch !== ' ') ensureGlyph(font, ch); // espaço nunca desenha, só avança (ver layout.js)
      if (prev !== null) ensureKernPair(font, prev, ch);
      prev = ch;
    }
  }
}

function parseBuffer(buffer, fallbackFamily) {
  const otFont = opentype.parse(bufferToArrayBuffer(buffer));
  const unitsPerEm = otFont.unitsPerEm || 1000;
  const tolerance = unitsPerEm * DEFAULT_TOLERANCE_EM_FRACTION;
  const ascent = otFont.ascender || unitsPerEm * 0.8;
  const descent = otFont.descender || -unitsPerEm * 0.2;

  const spaceGlyph = otFont.charToGlyph(' ');
  const defaultAdvance = (spaceGlyph && spaceGlyph.index !== 0 && spaceGlyph.advanceWidth) || unitsPerEm / 2;

  const font = {
    id: null,
    family: familyName(otFont, fallbackFamily),
    kind: 'fill',
    unitsPerEm,
    ascent,
    descent,
    capHeight: null,
    xHeight: null,
    defaultAdvance,
    glyphs: new Map(), // preenchido sob demanda por ensureGlyphsForText
    missingGlyph: { advance: defaultAdvance, rings: [] },
    kernMap: new Map(), // idem
    glyphCount: otFont.numGlyphs || 0, // total real da fonte, sem carregar nenhum anel (catálogo)
  };
  // Estado interno do carregamento sob demanda — não faz parte do "formato de
  // fonte" comum a svgfont.js/inkstitchfont.js, só ttffont.js usa.
  font._otFont = otFont;
  font._tolerance = tolerance;
  font._missing = new Set();
  font._kernChecked = new Set();
  font.ensureGlyphsForText = (text) => ensureGlyphsForText(font, text);

  return font;
}

function bufferToArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function parseFile(absPath) {
  const path = require('path');
  const buffer = fs.readFileSync(absPath);
  return parseBuffer(buffer, path.basename(absPath).replace(/\.(ttf|otf)$/i, ''));
}

module.exports = { parseFile, parseBuffer, ensureGlyphsForText };
