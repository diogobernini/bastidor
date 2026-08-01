'use strict';
// Ponto de entrada de src/core/lettering (núcleo Node puro, sem Electron):
// agrega o parser de SVG Font, o layout e o gerador de pontos, e resolve /
// cacheia as fontes bundladas em fonts/. Usado pelo processo principal via
// IPC (ver src/main/main.js) e diretamente pelos testes.

const fs = require('fs');
const path = require('path');

const svgfont = require('./svgfont');
const { layoutText, DEFAULT_HEIGHT_MM } = require('./layout');
const { textToPattern, resamplePolyline, patternPolylines, DEFAULT_STITCH_LENGTH_MM } = require('./stitcher');
const { patternToDesign } = require('../design');
const C = require('../commands');

const fontCache = new Map(); // caminho absoluto -> fonte já parseada

function loadFontFile(absPath) {
  let font = fontCache.get(absPath);
  if (!font) {
    font = svgfont.parseFile(absPath);
    fontCache.set(absPath, font);
  }
  return font;
}

// Varre fontsDir por arquivos .svg (fontes SVG Font) e devolve um catálogo
// leve para preencher o seletor da UI. "id" é o caminho relativo a fontsDir
// (ex.: "EMS/EMSNixish.svg"), usado depois em loadFont()/build().
function listFonts(fontsDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.svg')) {
        try {
          const font = loadFontFile(full);
          out.push({
            id: path.relative(fontsDir, full).split(path.sep).join('/'),
            label: font.family,
            glyphCount: font.glyphs.size,
          });
        } catch {
          // Arquivo .svg inválido/corrompido: ignora, não derruba a listagem.
        }
      }
    }
  };
  walk(fontsDir);
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

function loadFont(fontsDir, id) {
  if (!id) throw new Error('lettering: fonte não informada');
  const base = path.resolve(fontsDir);
  const absPath = path.join(base, id);
  if (absPath !== base && !absPath.startsWith(base + path.sep)) {
    throw new Error('lettering: fonte inválida');
  }
  if (!fs.existsSync(absPath)) throw new Error('lettering: fonte não encontrada: ' + id);
  return loadFontFile(absPath);
}

// Caracteres do texto sem glifo próprio na fonte (fora do espaço/quebra de
// linha, que sempre só avançam sem desenhar).
function findMissingChars(font, text) {
  const missing = new Set();
  for (const ch of Array.from(String(text || ''))) {
    if (ch === '\n' || ch === ' ') continue;
    if (!font.glyphs.has(ch)) missing.add(ch);
  }
  return Array.from(missing);
}

// Monta o texto (fonte + layout + pontos) num pacote pronto para IPC: design
// serializável (para inserir/salvar) e polilinhas (para a pré-visualização —
// o mesmo traçado que sairá gravado, via patternPolylines).
function build(fontsDir, opts) {
  const font = loadFont(fontsDir, opts.fontId);
  const text = opts.text || '';
  const pattern = textToPattern(font, text, opts);
  const design = patternToDesign(pattern);
  const b = pattern.bounds();
  return {
    design,
    polylines: patternPolylines(pattern),
    bounds: Number.isFinite(b[0]) ? b : [0, 0, 0, 0],
    stats: {
      stitches: pattern.countStitchCommands(C.STITCH),
      jumps: pattern.countStitchCommands(C.JUMP),
    },
    missingChars: findMissingChars(font, text),
  };
}

module.exports = {
  svgfont,
  layoutText,
  textToPattern,
  resamplePolyline,
  patternPolylines,
  listFonts,
  loadFont,
  build,
  findMissingChars,
  DEFAULT_HEIGHT_MM,
  DEFAULT_STITCH_LENGTH_MM,
};
