'use strict';
// Testes das fontes TTF/OTF e Ink/Stitch do lettering (issue #20, fase 3):
// - src/core/lettering/ttffont.js: leitor via opentype.js (glifos -> anéis
//   fechados) e o pipeline TTF -> contornos -> preenchimento em stitcher.js.
// - src/core/lettering/inkstitchfont.js: leitor PRÓPRIO do formato de fonte
//   (pasta com font.json + um SVG por glifo) — glifos, métricas, kerning.
// - src/core/lettering/index.js: catálogo (listFonts) e build() reconhecendo
//   os três tipos de fonte pelo prefixo do "id".

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ttffont = require('../src/core/lettering/ttffont');
const inkstitchfont = require('../src/core/lettering/inkstitchfont');
const lettering = require('../src/core/lettering');
const { textToPattern } = require('../src/core/lettering/stitcher');
const C = require('../src/core/commands');

const FONTS_DIR = path.join(__dirname, '..', 'fonts');
const PACIFICO_TTF = path.join(FONTS_DIR, 'ttf', 'Pacifico-Regular.ttf');
const ALLEGRIA_DIR = path.join(FONTS_DIR, 'inkstitch', 'allegria_sample');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function stitchCount(pattern) {
  return pattern.countStitchCommands(C.STITCH);
}

// --------------------------------------------------------------- ttffont.js

// Carregamento sob demanda (issue #28, item 5): font.glyphs/kernMap começam
// vazios; ensureGlyphsForText(text) é o mesmo hook que layout.js chama
// internamente (ver textToPattern mais abaixo), exposto aqui para testar o
// leitor isoladamente, sem depender do layout.

test('ttffont.parseFile: nada é carregado até algum texto ser pedido (sob demanda)', () => {
  const font = ttffont.parseFile(PACIFICO_TTF);
  assert.equal(font.kind, 'fill');
  assert.ok(font.unitsPerEm > 0);
  assert.ok(font.ascent > 0 && font.descent < 0);
  assert.equal(font.glyphs.size, 0, 'nenhum anel deveria estar calculado antes do primeiro ensureGlyphsForText');
  assert.equal(font.kernMap.size, 0);
  assert.ok(font.glyphCount > 26, `esperava o total real de glifos da fonte, achou ${font.glyphCount}`);
});

test('ttffont.parseFile: ensureGlyphsForText carrega só os glifos do texto pedido, com anéis fechados', () => {
  const font = ttffont.parseFile(PACIFICO_TTF);
  font.ensureGlyphsForText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
  assert.ok(font.glyphs.size > 26, `esperava vários glifos, achou ${font.glyphs.size}`);

  const a = font.glyphs.get('A');
  assert.ok(a.advance > 0);
  assert.ok(a.rings.length >= 1);
  for (const ring of a.rings) assert.ok(ring.length >= 3, 'anel precisa de pelo menos 3 pontos pra fechar um polígono');

  // Um segundo pedido, com um texto menor e já coberto, não deveria "perder"
  // o que já foi carregado (cumulativo, não substitui).
  font.ensureGlyphsForText('A');
  assert.ok(font.glyphs.size > 26);
});

test('ttffont.parseFile: letras com contraforma (furo) viram mais de um anel', () => {
  const font = ttffont.parseFile(PACIFICO_TTF);
  font.ensureGlyphsForText('oea');
  for (const ch of ['o', 'e', 'a']) {
    const glyph = font.glyphs.get(ch);
    assert.ok(glyph, `glifo "${ch}" ausente`);
    assert.ok(glyph.rings.length >= 2, `"${ch}" deveria ter >= 2 anéis (contorno + furo), achou ${glyph.rings.length}`);
  }
});

test('ttffont.parseFile: cobertura vai além de Latin-1 quando o texto pede (a versão antiga varria só 0x20-0xFF)', () => {
  const font = ttffont.parseFile(PACIFICO_TTF);
  // Latin Extended-A e Cirílico: fora de Latin-1, mas presentes na fonte.
  font.ensureGlyphsForText('ĀāŐőЖ');
  for (const ch of ['Ā', 'ā', 'Ő', 'ő', 'Ж']) {
    assert.ok(font.glyphs.has(ch), `esperava glifo para "${ch}" (fora de Latin-1, mas presente na fonte)`);
  }
  // Caracteres que a fonte realmente não tem continuam ausentes.
  font.ensureGlyphsForText('あ' + String.fromCodePoint(0x1f600));
  assert.equal(font.glyphs.has('あ'), false);
  assert.equal(font.glyphs.has(String.fromCodePoint(0x1f600)), false);
});

test('ttffont.parseFile: kerning (GPOS) calculado só para os pares adjacentes do texto pedido', () => {
  const font = ttffont.parseFile(PACIFICO_TTF);
  // "AB": Pacifico tem kerning GPOS positivo para esse par específico.
  font.ensureGlyphsForText('AB');
  assert.equal(font.kernMap.size, 1, 'só o par adjacente pedido deveria ter sido consultado');
  assert.equal(font.kernMap.get('A B'), 20);
  assert.equal(font.kernMap.has('B A'), false, 'par inverso não apareceu no texto, não deveria ter sido calculado');
});

// --------------------------------------------------------- stitcher.js (fill)

test('textToPattern com fonte TTF: preenchimento gera pontos > 0 e bounds coerentes com a altura pedida', () => {
  const font = ttffont.parseFile(PACIFICO_TTF);
  const heightMm = 20;
  const pattern = textToPattern(font, 'Bastidor', { heightMm, fillSpacingMm: 0.4, fillStitchMm: 3 });
  assert.ok(stitchCount(pattern) > 0);
  const b = pattern.bounds();
  const heightUnits = b[3] - b[1];
  // Mesma garantia de layout.js: a altura nominal (ascent-descent, escalada)
  // é exatamente heightMm por construção — mas o preenchimento em si só
  // cobre a TINTA de cada glifo, então a bounding box real do pattern fica
  // menor ou igual à altura nominal (nunca maior).
  assert.ok(heightUnits > 0 && heightUnits <= heightMm * 10 + 1, `altura do pattern (${heightUnits / 10}mm) fora do esperado para ${heightMm}mm nominal`);
  assert.ok(heightUnits > heightMm * 10 * 0.2, 'altura do pattern parece baixa demais pro texto pedido');
});

test('textToPattern com fonte TTF: outline soma agulhadas de contorno ao preenchimento', () => {
  const font = ttffont.parseFile(PACIFICO_TTF);
  const withoutOutline = textToPattern(font, 'B', { heightMm: 20 });
  const withOutline = textToPattern(font, 'B', { heightMm: 20, outline: true });
  assert.ok(stitchCount(withOutline) > stitchCount(withoutOutline), 'outline deveria acrescentar agulhadas');
});

test('textToPattern com fonte TTF: fileira mais apertada (fillSpacingMm menor) aumenta a contagem de pontos', () => {
  const font = ttffont.parseFile(PACIFICO_TTF);
  const loose = textToPattern(font, 'O', { heightMm: 25, fillSpacingMm: 1 });
  const tight = textToPattern(font, 'O', { heightMm: 25, fillSpacingMm: 0.3 });
  assert.ok(stitchCount(tight) > stitchCount(loose));
});

// --------------------------------------------------------------- inkstitchfont.js

test('inkstitchfont.loadDir: lê a fonte bundlada (glifos, métricas)', () => {
  const font = inkstitchfont.loadDir(ALLEGRIA_DIR);
  assert.equal(font.kind, 'stroke');
  assert.equal(font.license, 'SIL Open Font License v1.1');
  assert.ok(font.unitsPerEm > 0);
  assert.ok(font.ascent > 0 && font.descent < 0);
  assert.equal(font.glyphs.size, 66);

  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') assert.ok(font.glyphs.has(ch), `faltou a letra ${ch}`);
  for (const ch of 'abcdefghijklmnopqrstuvwxyz') assert.ok(font.glyphs.has(ch), `faltou a letra ${ch}`);
  for (const ch of '0123456789') assert.ok(font.glyphs.has(ch), `faltou o dígito ${ch}`);

  const a = font.glyphs.get('A');
  assert.ok(a.advance > 0);
  assert.ok(a.strokes.length > 0);
  assert.ok(a.strokes[0].length >= 2);

  // Espaço não tem arquivo de glifo próprio (mesma convenção do svgfont.js:
  // nunca desenha, só avança) — cai no missingGlyph, com o avanço certo.
  assert.equal(font.glyphs.has(' '), false);
  assert.ok(font.missingGlyph.advance > 0);
});

test('inkstitchfont.loadDir: kerning do font.json populado no kernMap', () => {
  const font = inkstitchfont.loadDir(ALLEGRIA_DIR);
  assert.ok(font.kernMap.size > 0);
  assert.equal(font.kernMap.get('R S'), -7.27);
  assert.equal(font.kernMap.get('S R'), undefined); // só a direção declarada no font.json
});

test('inkstitchfont.listDirs: acha a pasta bundlada dentro de fonts/inkstitch', () => {
  const names = inkstitchfont.listDirs(path.join(FONTS_DIR, 'inkstitch'));
  assert.ok(names.includes('allegria_sample'));
});

test('textToPattern com fonte Ink/Stitch: ponto corrido e satin funcionam (mesmo pipeline das fontes de traço único)', () => {
  const font = inkstitchfont.loadDir(ALLEGRIA_DIR);
  const running = textToPattern(font, 'Oi', { heightMm: 15 });
  const satinPattern = textToPattern(font, 'Oi', { heightMm: 15, finish: 'satin', satinWidthMm: 1.5, satinDensityMm: 0.4 });
  assert.ok(stitchCount(running) > 0);
  assert.ok(stitchCount(satinPattern) > stitchCount(running));
});

// ---------------------------------------------- inkstitchfont.js (robustez)

test('inkstitchfont.loadDir: glifo sem "file" (só avanço) não quebra a leitura', () => {
  const dir = makeTmpDir('bastidor-inkstitch-');
  try {
    fs.writeFileSync(
      path.join(dir, 'font.json'),
      JSON.stringify({
        family: 'Teste',
        unitsPerEm: 1000,
        ascent: 800,
        descent: -200,
        defaultAdvance: 500,
        glyphs: [
          { char: 'A', file: 'A.svg', advance: 600 },
          { char: '?', advance: 400 }, // sem arquivo: só métrica, não deveria virar entrada
        ],
      })
    );
    fs.writeFileSync(path.join(dir, 'A.svg'), '<svg><path d="M 0 0 L 600 0 L 600 500 Z"/></svg>');
    const font = inkstitchfont.loadDir(dir);
    assert.equal(font.glyphs.size, 1);
    assert.ok(font.glyphs.has('A'));
    assert.equal(font.glyphs.has('?'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inkstitchfont.loadDir: glifo com múltiplos <path> vira múltiplos traços', () => {
  const dir = makeTmpDir('bastidor-inkstitch-');
  try {
    fs.writeFileSync(
      path.join(dir, 'font.json'),
      JSON.stringify({
        family: 'Teste multi-traço',
        unitsPerEm: 1000,
        ascent: 800,
        descent: -200,
        defaultAdvance: 500,
        glyphs: [{ char: 'i', file: 'i.svg', advance: 300 }],
      })
    );
    fs.writeFileSync(
      path.join(dir, 'i.svg'),
      '<svg><path d="M 0 0 L 0 400"/><path d="M 0 500 L 0 520"/></svg>'
    );
    const font = inkstitchfont.loadDir(dir);
    const glyph = font.glyphs.get('i');
    assert.equal(glyph.strokes.length, 2, 'ponto do "i" + haste deveriam virar dois traços independentes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------- index.js (catálogo/IPC)

test('listFonts: catálogo inclui os três tipos, cada um com o "type" certo', () => {
  const list = lettering.listFonts(FONTS_DIR);
  const byId = new Map(list.map((f) => [f.id, f]));
  assert.equal(byId.get('Hershey/HersheySans1.svg').type, 'stroke');
  assert.equal(byId.get('ttf/Pacifico-Regular.ttf').type, 'ttf');
  assert.equal(byId.get('inkstitch/allegria_sample').type, 'inkstitch');
});

test('build(): reconhece fontId com prefixo ttf/ e inkstitch/', () => {
  const ttfResult = lettering.build(FONTS_DIR, { fontId: 'ttf/Pacifico-Regular.ttf', text: 'Oi', heightMm: 15 });
  assert.ok(ttfResult.design.stitches.length > 0);
  assert.ok(ttfResult.stats.stitches > 0);

  const inkResult = lettering.build(FONTS_DIR, { fontId: 'inkstitch/allegria_sample', text: 'Oi', heightMm: 15 });
  assert.ok(inkResult.design.stitches.length > 0);
  assert.ok(inkResult.stats.stitches > 0);
});

test('build(): missingChars funciona igual para os três tipos de fonte', () => {
  const strokeResult = lettering.build(FONTS_DIR, { fontId: 'Hershey/HersheySans1.svg', text: 'A☺', heightMm: 10 });
  const ttfResult = lettering.build(FONTS_DIR, { fontId: 'ttf/Pacifico-Regular.ttf', text: 'A☺', heightMm: 10 });
  const inkResult = lettering.build(FONTS_DIR, { fontId: 'inkstitch/allegria_sample', text: 'A☺', heightMm: 10 });
  assert.deepEqual(strokeResult.missingChars, ['☺']);
  assert.deepEqual(ttfResult.missingChars, ['☺']);
  assert.deepEqual(inkResult.missingChars, ['☺']);
});

test('build() com fonte TTF: caractere fora de Latin-1 mas presente na fonte não vira missingChars (issue #28 item 5)', () => {
  const result = lettering.build(FONTS_DIR, { fontId: 'ttf/Pacifico-Regular.ttf', text: 'Āford', heightMm: 15 });
  assert.deepEqual(result.missingChars, []);
  assert.ok(result.design.stitches.length > 0);
});

test('loadFont: recusa ids ttf/ e inkstitch/ fora de fonts/ (mesma proteção de caminho)', () => {
  assert.throws(() => lettering.loadFont(FONTS_DIR, 'ttf/../../../../etc/passwd'));
  assert.throws(() => lettering.loadFont(FONTS_DIR, 'inkstitch/../../../../etc'));
});

// --------------------------------------------------------------- addTtfFont

test('addTtfFont: copia um .ttf pra fonts/ttf/ e devolve o id certo; recusa extensão errada', () => {
  const tmpFontsDir = makeTmpDir('bastidor-fontsdir-');
  try {
    const id = lettering.addTtfFont(tmpFontsDir, PACIFICO_TTF);
    assert.equal(id, 'ttf/Pacifico-Regular.ttf');
    assert.ok(fs.existsSync(path.join(tmpFontsDir, 'ttf', 'Pacifico-Regular.ttf')));

    // fonte copiada é utilizável imediatamente pelo catálogo/loadFont.
    const list = lettering.listFonts(tmpFontsDir);
    assert.ok(list.some((f) => f.id === 'ttf/Pacifico-Regular.ttf' && f.type === 'ttf'));

    // extensão inválida: recusa sem copiar nada.
    const fakePath = path.join(tmpFontsDir, 'nota.txt');
    fs.writeFileSync(fakePath, 'não é uma fonte');
    assert.throws(() => lettering.addTtfFont(tmpFontsDir, fakePath));

    // nome duplicado: não sobrescreve, gera um novo nome.
    const id2 = lettering.addTtfFont(tmpFontsDir, PACIFICO_TTF);
    assert.equal(id2, 'ttf/Pacifico-Regular-2.ttf');
  } finally {
    fs.rmSync(tmpFontsDir, { recursive: true, force: true });
  }
});
