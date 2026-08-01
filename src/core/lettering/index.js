'use strict';
// Ponto de entrada de src/core/lettering (núcleo Node puro, sem Electron):
// agrega os três leitores de fonte (svgfont.js — traço único; inkstitchfont.js
// — formato próprio inspirado no Ink/Stitch; ttffont.js — TTF/OTF via
// opentype.js, issue #20), o layout e o gerador de pontos, e resolve /
// cacheia as fontes bundladas em fonts/. Usado pelo processo principal via
// IPC (ver src/main/main.js) e diretamente pelos testes.
//
// Os três leitores produzem o MESMO "formato de fonte" (glyphs: Map<char,
// {advance, ...}>, ascent, descent, unitsPerEm, defaultAdvance, kernMap,
// missingGlyph, e um campo "kind": 'stroke' ou 'fill') — layout.js não sabe
// nem precisa saber qual dos três está por trás; só stitcher.js olha
// font.kind pra escolher o pipeline de pontos certo. O "id" de cada fonte
// (usado em loadFont()/build()) tem um prefixo que indica o leitor: nenhum
// prefixo = SVG Font de traço único (compatibilidade com a Fase 1), "ttf/"
// = TTF/OTF, "inkstitch/" = pasta no formato Ink/Stitch.

const fs = require('fs');
const path = require('path');

const svgfont = require('./svgfont');
const ttffont = require('./ttffont');
const inkstitchfont = require('./inkstitchfont');
const { layoutText, DEFAULT_HEIGHT_MM } = require('./layout');
const { textToPattern, resamplePolyline, patternPolylines, DEFAULT_STITCH_LENGTH_MM } = require('./stitcher');
const { patternToDesign } = require('../design');
const C = require('../commands');

const TTF_SUBDIR = 'ttf';
const INKSTITCH_SUBDIR = 'inkstitch';

const svgFontCache = new Map(); // caminho absoluto -> fonte de traço único já parseada
const ttfFontCache = new Map(); // caminho absoluto -> fonte TTF/OTF já parseada
const inkstitchFontCache = new Map(); // caminho absoluto da pasta -> fonte Ink/Stitch já parseada

function loadFontFile(absPath) {
  let font = svgFontCache.get(absPath);
  if (!font) {
    font = svgfont.parseFile(absPath);
    font.kind = 'stroke';
    svgFontCache.set(absPath, font);
  }
  return font;
}

function loadTtfFontFile(absPath) {
  let font = ttfFontCache.get(absPath);
  if (!font) {
    font = ttffont.parseFile(absPath);
    ttfFontCache.set(absPath, font);
  }
  return font;
}

function loadInkstitchFontDir(absPath) {
  let font = inkstitchFontCache.get(absPath);
  if (!font) {
    font = inkstitchfont.loadDir(absPath);
    inkstitchFontCache.set(absPath, font);
  }
  return font;
}

// Resolve um "id" relativo dentro de fontsDir com proteção básica contra
// path traversal (mesma checagem para os três tipos de fonte).
function resolveWithin(fontsDir, id) {
  const base = path.resolve(fontsDir);
  const absPath = path.resolve(path.join(base, id));
  if (absPath !== base && !absPath.startsWith(base + path.sep)) {
    throw new Error('lettering: fonte inválida');
  }
  return absPath;
}

// Varre fontsDir por fontes dos três tipos e devolve um catálogo leve para
// preencher o seletor da UI. "id" é o que se passa depois em
// loadFont()/build(); "type" rotula o tipo pro seletor ("stroke" | "ttf" |
// "inkstitch") — a UI usa isso pra decidir quais parâmetros mostrar
// (satin/corrido vs. preenchimento).
function listFonts(fontsDir) {
  const out = [];

  // ---- fontes de traço único (SVG Font), recursivo — mesma varredura da
  // Fase 1, só pulando as subpastas dos dois tipos novos.
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
        if (entry.name === TTF_SUBDIR || entry.name === INKSTITCH_SUBDIR) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.svg')) {
        try {
          const font = loadFontFile(full);
          out.push({
            id: path.relative(fontsDir, full).split(path.sep).join('/'),
            label: font.family,
            glyphCount: font.glyphs.size,
            type: 'stroke',
          });
        } catch {
          // Arquivo .svg inválido/corrompido: ignora, não derruba a listagem.
        }
      }
    }
  };
  walk(fontsDir);

  // ---- TTF/OTF (fonts/ttf/*.ttf|*.otf)
  const ttfDir = path.join(fontsDir, TTF_SUBDIR);
  let ttfEntries = [];
  try {
    ttfEntries = fs.readdirSync(ttfDir, { withFileTypes: true });
  } catch {
    ttfEntries = [];
  }
  for (const entry of ttfEntries) {
    if (!entry.isFile() || !/\.(ttf|otf)$/i.test(entry.name)) continue;
    try {
      const font = loadTtfFontFile(path.join(ttfDir, entry.name));
      out.push({
        id: TTF_SUBDIR + '/' + entry.name,
        label: font.family,
        glyphCount: font.glyphs.size,
        type: 'ttf',
      });
    } catch {
      // TTF/OTF inválido/corrompido: ignora.
    }
  }

  // ---- Ink/Stitch (fonts/inkstitch/<nome>/font.json)
  const inkDir = path.join(fontsDir, INKSTITCH_SUBDIR);
  for (const name of inkstitchfont.listDirs(inkDir)) {
    try {
      const font = loadInkstitchFontDir(path.join(inkDir, name));
      out.push({
        id: INKSTITCH_SUBDIR + '/' + name,
        label: font.family,
        glyphCount: font.glyphs.size,
        type: 'inkstitch',
      });
    } catch {
      // font.json/SVGs inválidos: ignora.
    }
  }

  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

function loadFont(fontsDir, id) {
  if (!id) throw new Error('lettering: fonte não informada');
  if (id.startsWith(TTF_SUBDIR + '/')) {
    const absPath = resolveWithin(fontsDir, id);
    if (!fs.existsSync(absPath)) throw new Error('lettering: fonte não encontrada: ' + id);
    return loadTtfFontFile(absPath);
  }
  if (id.startsWith(INKSTITCH_SUBDIR + '/')) {
    const absPath = resolveWithin(fontsDir, id);
    if (!fs.existsSync(path.join(absPath, 'font.json'))) throw new Error('lettering: fonte não encontrada: ' + id);
    return loadInkstitchFontDir(absPath);
  }
  const absPath = resolveWithin(fontsDir, id);
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

// Copia um .ttf/.otf escolhido pelo usuário para fonts/ttf/ (botão "adicionar
// fonte…" do diálogo de texto — issue #20). Protege contra sobrescrever
// arquivos fora da pasta e contra extensões que não sejam TTF/OTF.
function addTtfFont(fontsDir, sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext !== '.ttf' && ext !== '.otf') throw new Error('lettering: só arquivos .ttf/.otf');
  const ttfDir = path.join(path.resolve(fontsDir), TTF_SUBDIR);
  fs.mkdirSync(ttfDir, { recursive: true });
  let destName = path.basename(sourcePath);
  let dest = path.join(ttfDir, destName);
  let n = 1;
  while (fs.existsSync(dest)) {
    n++;
    destName = path.basename(sourcePath, ext) + '-' + n + ext;
    dest = path.join(ttfDir, destName);
  }
  fs.copyFileSync(sourcePath, dest);
  ttfFontCache.delete(dest); // por precaução (não deveria haver entrada prévia)
  return TTF_SUBDIR + '/' + destName;
}

module.exports = {
  svgfont,
  ttffont,
  inkstitchfont,
  layoutText,
  textToPattern,
  resamplePolyline,
  patternPolylines,
  listFonts,
  loadFont,
  build,
  addTtfFont,
  findMissingChars,
  DEFAULT_HEIGHT_MM,
  DEFAULT_STITCH_LENGTH_MM,
};
