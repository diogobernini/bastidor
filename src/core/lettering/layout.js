'use strict';
// Layout de texto sobre uma fonte SVG de traço único: calcula a escala, o
// avanço de cada glifo (com kerning, se a fonte tiver) e a posição final de
// cada glifo já centralizado por linha. Unidades de saída: 0,1 mm, Y para
// baixo (mesma convenção do resto do núcleo — ver src/core/pattern.js).
//
// Decisão de escala (documentada conforme pedido): usamos
//   scale = alturaDesejada / (font.ascent - font.descent)
// ou seja, "heightMm" é a altura do "corpo" da fonte (da linha de base ao
// topo do ascendente, mais o que desce abaixo da linha de base) — o mesmo
// sentido de "tamanho da fonte" em tipografia comum, e não a altura de tinta
// de uma letra maiúscula específica. Nas três fontes incluídas em fonts/,
// cap-height = (ascent - descent) / 2, então um texto só com maiúsculas (ex.:
// um monograma "AVA") sai com ~metade da altura nominal em tinta — é
// esperado e documentado aqui e nos comentários dos testes.
//
// Espaçamento entre letras/linhas é dado em porcentagem de heightMm (mais
// intuitivo para quem está digitando "10 mm" na UI do que uma porcentagem
// relativa a units-per-em): 0% é o avanço nativo da fonte; 20% soma 20% da
// altura pedida como vão extra depois de cada glifo (letterSpacing) ou como
// espaçamento adicional entre linhas de base (lineSpacing, sobre 100%).

const svgfont = require('./svgfont');

const DEFAULT_HEIGHT_MM = 10;

function layoutText(font, text, opts = {}) {
  // Fontes com carregamento sob demanda (TTF/OTF — issue #28 item 5) expõem
  // esse hook opcional para garantir os glifos/kerning do texto ANTES de
  // percorrê-lo abaixo; fontes que já carregam tudo de uma vez (SVG Font,
  // Ink/Stitch) simplesmente não o implementam.
  if (typeof font.ensureGlyphsForText === 'function') font.ensureGlyphsForText(text);

  const heightMm = opts.heightMm > 0 ? opts.heightMm : DEFAULT_HEIGHT_MM;
  const letterSpacingPct = Number.isFinite(opts.letterSpacing) ? opts.letterSpacing : 0;
  const lineSpacingPct = Number.isFinite(opts.lineSpacing) ? opts.lineSpacing : 0;

  const heightUnits = heightMm * 10; // 0,1 mm
  const emUnits = font.ascent - font.descent || font.unitsPerEm || 1;
  const scale = heightUnits / emUnits;
  const letterGap = heightUnits * (letterSpacingPct / 100);
  const linePitch = heightUnits * (1 + lineSpacingPct / 100);

  const rawLines = String(text == null ? '' : text).split('\n');
  const lineInfos = rawLines.map((rawLine) => {
    const chars = Array.from(rawLine);
    const items = [];
    let cursor = 0;
    let prevChar = null;
    for (const ch of chars) {
      const glyph = svgfont.getGlyph(font, ch);
      if (prevChar !== null) cursor += svgfont.getKerning(font, prevChar, ch) * scale;
      items.push({ char: ch, glyph, x: cursor });
      cursor += glyph.advance * scale + letterGap;
      prevChar = ch;
    }
    const width = items.length ? cursor - letterGap : 0;
    return { items, width };
  });

  const glyphs = [];
  const missingChars = new Set();
  lineInfos.forEach((line, i) => {
    const offsetX = -line.width / 2; // alinhamento centralizado por linha
    const baselineY = i * linePitch;
    for (const item of line.items) {
      if (item.char !== ' ' && !font.glyphs.has(item.char)) missingChars.add(item.char);
      glyphs.push({
        char: item.char,
        glyph: item.glyph,
        originX: offsetX + item.x,
        originY: baselineY,
        scale,
      });
    }
  });

  // Caixa nominal (métrica da fonte, não a tinta real dos traços): útil para
  // pré-visualizações rápidas sem precisar percorrer os traços.
  const maxWidth = lineInfos.reduce((m, l) => Math.max(m, l.width), 0);
  const lastBaseline = (lineInfos.length - 1) * linePitch;
  const bounds = {
    minX: -maxWidth / 2,
    maxX: maxWidth / 2,
    minY: -font.ascent * scale,
    maxY: lastBaseline - font.descent * scale,
  };

  return {
    heightMm,
    scale,
    lineCount: lineInfos.length,
    linePitch,
    glyphs, // [{char, glyph, originX, originY, scale}]
    bounds,
    missingChars: Array.from(missingChars),
  };
}

module.exports = { layoutText, DEFAULT_HEIGHT_MM };
