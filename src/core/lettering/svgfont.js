'use strict';
// Parser de fontes SVG 1.1 Font (subconjunto usado pelas fontes de traço único
// em fonts/: Hershey e EMS). Não é um parser XML genérico: procura direto as
// tags <font>, <font-face>, <glyph>, <missing-glyph> e <hkern> via expressões
// regulares (a gramática dessas fontes é simples e sem aninhamento relevante),
// decodifica entidades XML básicas e converte o atributo "d" de cada glifo em
// "traços" (arrays de pontos [x, y]).
//
// ATENÇÃO: SVG Font usa Y crescendo para cima (baseline em 0, ascendentes
// positivos). O Bastidor usa Y crescendo para baixo (ver src/core/pattern.js).
// A inversão (y -> -y) é feita aqui, uma única vez, ao montar cada glifo —
// todo o resto do núcleo (layout, stitcher) já trabalha em Y-para-baixo.

const DEFAULT_TOLERANCE_EM_FRACTION = 0.001; // 0,1% do units-per-em

// --------------------------------------------------------------- XML mínimo

function unescapeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Atributos de uma tag (o miolo entre "<nome" e o ">" final).
function parseAttrs(tagInner) {
  const attrs = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tagInner))) {
    attrs[m[1]] = unescapeXml(m[2]);
  }
  return attrs;
}

// Todas as ocorrências de uma tag `<nome ...>` ou `<nome ... />`, com atributos
// possivelmente quebrados em várias linhas. Retorna o miolo (sem os `<nome`/`>`).
function findTags(xml, name) {
  const re = new RegExp('<' + name + '(?![\\w-])([^>]*)>', 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function numOr(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// --------------------------------------------------------------- path "d"

// Tokeniza o atributo d: comandos (uma letra) e números (com sinal, ponto
// decimal e notação científica), sem exigir separador entre eles.
function tokenizePathData(d) {
  const re = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?/g;
  return d.match(re) || [];
}

const LETTER_RE = /^[MmLlHhVvCcSsQqTtAaZz]$/;

function mid(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function pointLineDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

// Achata uma cúbica de Bézier adaptativamente (subdivisão de De Casteljau):
// subdivide enquanto os pontos de controle estiverem além da tolerância da
// corda p0-p3; empilha o ponto final de cada trecho já "reto o bastante".
function flattenCubic(p0, p1, p2, p3, tolerance, depth, out) {
  const flat = depth <= 0 || (pointLineDist(p1, p0, p3) <= tolerance && pointLineDist(p2, p0, p3) <= tolerance);
  if (flat) {
    out.push(p3);
    return;
  }
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const p0123 = mid(p012, p123);
  flattenCubic(p0, p01, p012, p0123, tolerance, depth - 1, out);
  flattenCubic(p0123, p123, p23, p3, tolerance, depth - 1, out);
}

// Converte o atributo "d" em uma lista de traços (arrays de [x, y]), em
// coordenadas cruas da fonte (Y para cima, sem escala). Cada "M"/"m" inicia
// um novo traço (o app costura um salto entre traços — ver stitcher.js).
//
// Suporta M/L/H/V/C/S/Q/T/Z e as variantes relativas (minúsculas). Arcos
// (A/a) não são usados por nenhuma fonte de traço único conhecida desta
// coleção; quando aparecem, degradam-se com segurança para uma linha reta
// até o ponto final (evita travar o parser em fontes exóticas).
function pathToStrokes(d, opts) {
  const tolerance = (opts && opts.tolerance) || 1;
  const maxDepth = (opts && opts.maxDepth) || 16;
  const tokens = tokenizePathData(d);
  const strokes = [];
  let idx = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let stroke = null;
  let letter = null;
  let prevCubicCtrl = null; // último ponto de controle explícito, p/ reflexão de S/s
  let prevQuadCtrl = null; // idem, p/ T/t

  function beginStroke(x, y) {
    stroke = [[x, y]];
    strokes.push(stroke);
    cx = x;
    cy = y;
    sx = x;
    sy = y;
  }
  function lineTo(x, y) {
    if (!stroke) beginStroke(cx, cy);
    stroke.push([x, y]);
    cx = x;
    cy = y;
  }
  function cubicTo(x1, y1, x2, y2, x, y) {
    if (!stroke) beginStroke(cx, cy);
    flattenCubic([cx, cy], [x1, y1], [x2, y2], [x, y], tolerance, maxDepth, stroke);
    cx = x;
    cy = y;
  }
  function quadTo(x1, y1, x, y) {
    // Eleva a quadrática a uma cúbica equivalente (fórmula padrão) e reusa o achatamento cúbico.
    const c1x = cx + (2 / 3) * (x1 - cx);
    const c1y = cy + (2 / 3) * (y1 - cy);
    const c2x = x + (2 / 3) * (x1 - x);
    const c2y = y + (2 / 3) * (y1 - y);
    cubicTo(c1x, c1y, c2x, c2y, x, y);
  }

  const num = () => parseFloat(tokens[idx++]);

  while (idx < tokens.length) {
    const before = idx;
    const tok = tokens[idx];
    if (LETTER_RE.test(tok)) {
      letter = tok;
      idx++;
    } else if (letter === null) {
      break; // número sem comando ativo — entrada malformada, para com segurança
    } else if (letter === 'M') {
      letter = 'L'; // pares extras após "M" são implicitamente lineto (regra do SVG)
    } else if (letter === 'm') {
      letter = 'l';
    }

    let resetCtrl = true;
    switch (letter) {
      case 'M':
        beginStroke(num(), num());
        break;
      case 'm':
        beginStroke(cx + num(), cy + num());
        break;
      case 'L':
        lineTo(num(), num());
        break;
      case 'l':
        lineTo(cx + num(), cy + num());
        break;
      case 'H':
        lineTo(num(), cy);
        break;
      case 'h':
        lineTo(cx + num(), cy);
        break;
      case 'V':
        lineTo(cx, num());
        break;
      case 'v':
        lineTo(cx, cy + num());
        break;
      case 'C': {
        const x1 = num();
        const y1 = num();
        const x2 = num();
        const y2 = num();
        const x = num();
        const y = num();
        cubicTo(x1, y1, x2, y2, x, y);
        prevCubicCtrl = [x2, y2];
        resetCtrl = false;
        break;
      }
      case 'c': {
        const x1 = cx + num();
        const y1 = cy + num();
        const x2 = cx + num();
        const y2 = cy + num();
        const x = cx + num();
        const y = cy + num();
        cubicTo(x1, y1, x2, y2, x, y);
        prevCubicCtrl = [x2, y2];
        resetCtrl = false;
        break;
      }
      case 'S':
      case 's': {
        const rel = letter === 's';
        const x1 = prevCubicCtrl ? 2 * cx - prevCubicCtrl[0] : cx;
        const y1 = prevCubicCtrl ? 2 * cy - prevCubicCtrl[1] : cy;
        const x2 = rel ? cx + num() : num();
        const y2 = rel ? cy + num() : num();
        const x = rel ? cx + num() : num();
        const y = rel ? cy + num() : num();
        cubicTo(x1, y1, x2, y2, x, y);
        prevCubicCtrl = [x2, y2];
        resetCtrl = false;
        break;
      }
      case 'Q': {
        const x1 = num();
        const y1 = num();
        const x = num();
        const y = num();
        quadTo(x1, y1, x, y);
        prevQuadCtrl = [x1, y1];
        resetCtrl = false;
        break;
      }
      case 'q': {
        const x1 = cx + num();
        const y1 = cy + num();
        const x = cx + num();
        const y = cy + num();
        quadTo(x1, y1, x, y);
        prevQuadCtrl = [x1, y1];
        resetCtrl = false;
        break;
      }
      case 'T':
      case 't': {
        const rel = letter === 't';
        const x1 = prevQuadCtrl ? 2 * cx - prevQuadCtrl[0] : cx;
        const y1 = prevQuadCtrl ? 2 * cy - prevQuadCtrl[1] : cy;
        const x = rel ? cx + num() : num();
        const y = rel ? cy + num() : num();
        quadTo(x1, y1, x, y);
        prevQuadCtrl = [x1, y1];
        resetCtrl = false;
        break;
      }
      case 'A':
      case 'a': {
        // Sem suporte a arco elíptico: consome os 7 argumentos e traça reto
        // até o ponto final, só para não travar em fontes fora desta coleção.
        num();
        num();
        num();
        num();
        num();
        const x = letter === 'a' ? cx + num() : num();
        const y = letter === 'a' ? cy + num() : num();
        lineTo(x, y);
        break;
      }
      case 'Z':
      case 'z':
        lineTo(sx, sy);
        break;
      default:
        idx = tokens.length; // comando desconhecido: aborta com segurança
        break;
    }
    if (resetCtrl) {
      prevCubicCtrl = null;
      prevQuadCtrl = null;
    }
    if (idx === before) {
      // Nenhum token consumido (ex.: "Z" seguido de número solto) — evita
      // laço infinito: só continua se o próximo token for um novo comando.
      if (idx < tokens.length && LETTER_RE.test(tokens[idx])) continue;
      break;
    }
  }
  return strokes;
}

// --------------------------------------------------------------- hkern

function expandCharList(spec) {
  // "A,B,C" ou faixas simples "A-F"; fontes desta coleção não usam hkern,
  // então isto só é exercitado pelos testes com fixtures sintéticas.
  if (!spec) return [];
  const out = [];
  for (const part of spec.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(.)-(.)$/u.exec(p);
    if (m && m[1].codePointAt(0) <= m[2].codePointAt(0)) {
      for (let c = m[1].codePointAt(0); c <= m[2].codePointAt(0); c++) out.push(String.fromCodePoint(c));
    } else {
      out.push(p);
    }
  }
  return out;
}

// --------------------------------------------------------------- fonte

function buildGlyph(attrs, defaultAdvance, tolerance) {
  const advance = numOr(attrs['horiz-adv-x'], defaultAdvance);
  const strokes = attrs.d
    ? pathToStrokes(attrs.d, { tolerance }).map((stroke) => stroke.map(([x, y]) => [x, -y]))
    : [];
  return {
    unicode: attrs.unicode !== undefined ? attrs.unicode : null,
    name: attrs['glyph-name'] || '',
    advance,
    strokes, // Y já convertido para baixo
  };
}

// Faz o parse de um documento SVG Font completo (string) e devolve um objeto
// de fonte pronto para uso por layout.js/stitcher.js.
function parse(xmlText) {
  const fontTags = findTags(xmlText, 'font');
  if (!fontTags.length) throw new Error('SVG Font: elemento <font> não encontrado');
  const fontAttrs = parseAttrs(fontTags[0]);

  const faceTags = findTags(xmlText, 'font-face');
  const faceAttrs = faceTags.length ? parseAttrs(faceTags[0]) : {};

  const unitsPerEm = numOr(faceAttrs['units-per-em'], 1000);
  const ascent = numOr(faceAttrs.ascent, unitsPerEm * 0.8);
  const descent = numOr(faceAttrs.descent, -unitsPerEm * 0.2);
  const defaultAdvance = numOr(fontAttrs['horiz-adv-x'], unitsPerEm);
  const tolerance = unitsPerEm * DEFAULT_TOLERANCE_EM_FRACTION;

  const missingTags = findTags(xmlText, 'missing-glyph');
  const missingGlyph = missingTags.length
    ? buildGlyph(parseAttrs(missingTags[0]), defaultAdvance, tolerance)
    : { unicode: null, name: '.notdef', advance: defaultAdvance, strokes: [] };

  const glyphs = new Map();
  for (const inner of findTags(xmlText, 'glyph')) {
    const attrs = parseAttrs(inner);
    if (attrs.unicode === undefined) continue;
    glyphs.set(attrs.unicode, buildGlyph(attrs, defaultAdvance, tolerance));
  }

  const kernMap = new Map();
  for (const inner of findTags(xmlText, 'hkern')) {
    const attrs = parseAttrs(inner);
    const firsts = expandCharList(attrs.u1);
    const seconds = expandCharList(attrs.u2);
    const k = numOr(attrs.k, 0);
    if (!firsts.length || !seconds.length || !k) continue;
    for (const a of firsts) {
      for (const b of seconds) kernMap.set(a + ' ' + b, k);
    }
  }

  return {
    id: fontAttrs.id || faceAttrs['font-family'] || null,
    family: faceAttrs['font-family'] || fontAttrs.id || 'font',
    unitsPerEm,
    ascent,
    descent,
    capHeight: faceAttrs['cap-height'] !== undefined ? numOr(faceAttrs['cap-height'], null) : null,
    xHeight: faceAttrs['x-height'] !== undefined ? numOr(faceAttrs['x-height'], null) : null,
    defaultAdvance,
    glyphs,
    missingGlyph,
    kernMap,
  };
}

function parseFile(filePath) {
  const fs = require('fs');
  return parse(fs.readFileSync(filePath, 'utf8'));
}

// Glifo de um caractere, com fallback para o glifo de reposição (.notdef).
function getGlyph(font, ch) {
  return font.glyphs.get(ch) || font.missingGlyph;
}

// Kerning (em unidades da fonte) entre dois caracteres consecutivos, 0 se não houver.
function getKerning(font, a, b) {
  return font.kernMap.get(a + ' ' + b) || 0;
}

module.exports = {
  parse,
  parseFile,
  getGlyph,
  getKerning,
  pathToStrokes, // exposto para testes unitários do parser de "d"
};
