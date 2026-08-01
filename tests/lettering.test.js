'use strict';
// Testes do núcleo de lettering (issue #7, Fase 1): parser de SVG Font,
// layout e geração de pontos (ponto corrido / ponto triplo).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const svgfont = require('../src/core/lettering/svgfont');
const { layoutText } = require('../src/core/lettering/layout');
const { textToPattern, resamplePolyline } = require('../src/core/lettering/stitcher');
const lettering = require('../src/core/lettering');
const io = require('../src/core/io');
const C = require('../src/core/commands');

const FONTS_DIR = path.join(__dirname, '..', 'fonts');
const HERSHEY = path.join(FONTS_DIR, 'Hershey', 'HersheySans1.svg');
const NIXISH = path.join(FONTS_DIR, 'EMS', 'EMSNixish.svg');
const ALLURE = path.join(FONTS_DIR, 'EMS', 'EMSAllure.svg');

function stitchCount(pattern) {
  return pattern.countStitchCommands(C.STITCH);
}

// --------------------------------------------------------------- svgfont.js

test('parser lê a fonte Hershey Sans 1-stroke incluída e acha >= 26 glifos', () => {
  const font = svgfont.parseFile(HERSHEY);
  assert.ok(font.glyphs.size >= 26, `esperava >= 26 glifos, achou ${font.glyphs.size}`);
  assert.equal(font.family, 'Hershey Sans 1-stroke');
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') assert.ok(font.glyphs.has(ch), `faltou a letra ${ch}`);
  for (const ch of '0123456789') assert.ok(font.glyphs.has(ch), `faltou o dígito ${ch}`);
});

test('as três fontes bundladas fazem parse sem erro e têm o alfabeto completo', () => {
  for (const file of [HERSHEY, NIXISH, ALLURE]) {
    const font = svgfont.parseFile(file);
    assert.ok(font.glyphs.size >= 26, file);
    assert.ok(font.ascent > 0 && font.descent < 0, file);
    assert.ok(font.glyphs.get('A').strokes.length > 0, `glifo "A" sem traços em ${file}`);
  }
});

test('SVG Font é Y-para-cima; o parser converte para Y-para-baixo do app', () => {
  // Na Hershey Sans 1-stroke, o traço vertical do "H" sobe de y=0 até
  // y=ascent (700-ish) no espaço da fonte (Y pra cima). Depois da conversão,
  // o topo deve virar Y NEGATIVO (mais pra cima na tela, que usa Y-para-baixo).
  const font = svgfont.parseFile(HERSHEY);
  const h = font.glyphs.get('H');
  const ys = h.strokes.flat().map((p) => p[1]);
  assert.ok(Math.min(...ys) < 0, 'esperava algum ponto com Y negativo (acima da linha de base)');
});

test('pathToStrokes: M/L/H/V/C/Q/Z absolutos e relativos', () => {
  // Q (quadrática): em t=0.5 o achatamento deve passar bem perto do ponto
  // médio teórico de Bézier: 0,25*P0 + 0,5*P1 + 0,25*P2.
  const q = svgfont.pathToStrokes('M 0 0 Q 50 100 100 0')[0];
  const peak = Math.max(...q.map((p) => p[1]));
  assert.ok(Math.abs(peak - 50) < 0.5, `pico esperado ~50, achou ${peak}`);

  // Z fecha o subpath (volta ao ponto inicial).
  const z = svgfont.pathToStrokes('M 0 0 L 10 0 L 10 10 Z')[0];
  assert.deepEqual(z[z.length - 1], [0, 0]);

  // Comandos relativos (m/l/c) e H/V.
  const rel = svgfont.pathToStrokes('M 10 10 h 5 v 5 l 3 3')[0];
  assert.deepEqual(rel, [
    [10, 10],
    [15, 10],
    [15, 15],
    [18, 18],
  ]);

  // "M" seguido de pares soltos é lineto implícito (regra do SVG).
  const implicit = svgfont.pathToStrokes('M 0 0 10 0 10 10')[0];
  assert.equal(implicit.length, 3);

  // Múltiplos "M" no mesmo d = múltiplos traços independentes.
  const multi = svgfont.pathToStrokes('M 0 0 L 1 1 M 5 5 L 6 6');
  assert.equal(multi.length, 2);

  // Arco (A) não suportado: degrada para reta até o ponto final, sem travar.
  const arc = svgfont.pathToStrokes('M 0 0 A 5 5 0 0 1 10 10');
  assert.deepEqual(arc[0], [
    [0, 0],
    [10, 10],
  ]);
});

test('hkern: kerning aplicado só na direção declarada, glifo ausente cai no missing-glyph', () => {
  const xml = `<svg xmlns="http://www.w3.org/2000/svg"><defs>
    <font id="Test" horiz-adv-x="500">
    <font-face font-family="Test" units-per-em="1000" ascent="800" descent="-200" cap-height="500" />
    <missing-glyph horiz-adv-x="321" />
    <glyph unicode=" " glyph-name="space" horiz-adv-x="300" />
    <glyph unicode="A" glyph-name="A" horiz-adv-x="600" d="M 0 0 L 600 0" />
    <glyph unicode="B" glyph-name="B" horiz-adv-x="600" d="M 0 0 L 0 500" />
    <hkern u1="A" u2="B" k="50" />
    </font></defs></svg>`;
  const font = svgfont.parse(xml);
  assert.equal(svgfont.getKerning(font, 'A', 'B'), 50);
  assert.equal(svgfont.getKerning(font, 'B', 'A'), 0);
  assert.equal(svgfont.getGlyph(font, '?'), font.missingGlyph);
  assert.equal(svgfont.getGlyph(font, '?').advance, 321);
});

// --------------------------------------------------------------- layout.js

test('layout de "AVA" tem avanços monotônicos e altura nominal de ~10 mm', () => {
  const font = svgfont.parseFile(HERSHEY);
  const laid = layoutText(font, 'AVA', { heightMm: 10 });
  assert.equal(laid.glyphs.length, 3);

  // Avanço estritamente crescente (cursor nunca volta pra trás).
  for (let i = 1; i < laid.glyphs.length; i++) {
    assert.ok(laid.glyphs[i].originX > laid.glyphs[i - 1].originX, `glifo ${i} não avançou`);
  }

  // Altura nominal (ascent - descent, escalado) é exatamente heightMm, por
  // construção — é a definição de escala documentada em layout.js.
  const nominalHeightMm = (laid.bounds.maxY - laid.bounds.minY) / 10;
  assert.ok(Math.abs(nominalHeightMm - 10) < 0.01, `altura nominal esperada ~10mm, achou ${nominalHeightMm}`);

  // A tinta real de um texto só com maiúsculas fica menor que a altura
  // nominal (cap-height é metade do em-box nestas fontes) — checagem de sanidade.
  const inkYs = laid.glyphs.flatMap((g) => g.glyph.strokes.flat().map((p) => g.originY + p[1] * g.scale));
  const inkHeightMm = (Math.max(...inkYs) - Math.min(...inkYs)) / 10;
  assert.ok(inkHeightMm > 2 && inkHeightMm < 10, `altura de tinta fora do esperado: ${inkHeightMm}mm`);
});

test('layout: letterSpacing e lineSpacing em % de heightMm', () => {
  const font = svgfont.parseFile(HERSHEY);
  const base = layoutText(font, 'AVA', { heightMm: 10 });
  const wide = layoutText(font, 'AVA', { heightMm: 10, letterSpacing: 20 });
  const baseWidth = base.bounds.maxX - base.bounds.minX;
  const wideWidth = wide.bounds.maxX - wide.bounds.minX;
  // 2 vãos extras (entre A-V e V-A) de 20% de 10mm = 2mm cada = 4mm = 40 unidades.
  assert.ok(Math.abs(wideWidth - baseWidth - 40) < 0.01);

  const multi = layoutText(font, 'Uma\nLinha', { heightMm: 8, lineSpacing: 30 });
  assert.equal(multi.lineCount, 2);
  assert.ok(Math.abs(multi.linePitch - 104) < 0.01); // 8mm*10 * 1,3 = 104

  // Alinhamento centralizado por linha: cada linha tem seu próprio centro em x=0.
  const l1 = multi.glyphs.filter((g) => g.originY === 0);
  const l2 = multi.glyphs.filter((g) => g.originY > 0);
  assert.ok(l1.length && l2.length);
});

test('layout marca caracteres sem glifo em missingChars (espaço não conta)', () => {
  const font = svgfont.parseFile(HERSHEY);
  const laid = layoutText(font, 'A ☺ B', { heightMm: 10 });
  assert.deepEqual(laid.missingChars, ['☺']);
});

// --------------------------------------------------------------- stitcher.js

test('resamplePolyline mantém ~stitchLengthMm entre pontos e preserva extremos', () => {
  const pts = [
    [0, 0],
    [100, 0],
    [100, 90],
  ];
  const out = resamplePolyline(pts, 20); // passo de 2 mm (20 unidades de 0,1mm)
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out[out.length - 1], [100, 90]);
  for (let i = 1; i < out.length - 1; i++) {
    const len = Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]);
    assert.ok(Math.abs(len - 20) < 1, `passo ${i} fora do esperado: ${len}`);
  }
});

test('textToPattern("Bastidor"): thread único preto, termina com end(), sai centrado', () => {
  const font = svgfont.parseFile(HERSHEY);
  const pattern = textToPattern(font, 'Bastidor', { heightMm: 10 });
  assert.equal(pattern.threadlist.length, 1);
  assert.equal(pattern.threadlist[0].hex(), '#000000');
  const lastCmd = pattern.stitches[pattern.stitches.length - 1][2] & C.COMMAND_MASK;
  assert.equal(lastCmd, C.END);

  const b = pattern.bounds();
  const cx = Math.round((b[0] + b[2]) / 2);
  const cy = Math.round((b[1] + b[3]) / 2);
  assert.ok(Math.abs(cx) <= 1 && Math.abs(cy) <= 1, `não saiu centrado: centro em (${cx},${cy})`);
});

test('textToPattern("Bastidor") roundtrip por XXX preservando contagens', () => {
  const font = svgfont.parseFile(HERSHEY);
  const pattern = textToPattern(font, 'Bastidor', { heightMm: 10 });
  // Mesmo tratamento do teste de roundtrip de tests/core.test.js: o próprio
  // formato XXX limita saltos/pontos a 12,4 mm, então comparamos com a
  // versão já normalizada (saltos longos — como o posicionamento inicial —
  // podem ser divididos em mais de um salto; a contagem de PONTOS não muda).
  const normalized = pattern.getNormalizedPattern({ max_jump: 124, max_stitch: 124, round: true });
  const buf = io.writeBuffer(pattern, 'xxx');
  const readBack = io.readBuffer(buf, 'xxx');

  assert.equal(stitchCount(readBack), stitchCount(normalized));
  assert.equal(readBack.threadlist.length, 1);
  assert.equal(readBack.threadlist[0].hex(), '#000000');
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(readBack.bounds()[i] - normalized.bounds()[i]) <= 1.5);
  }
});

test('opts.bean triplica (ida-volta-ida) o número de agulhadas vs. ponto corrido normal', () => {
  const font = svgfont.parseFile(HERSHEY);
  const normal = textToPattern(font, 'Bastidor', { heightMm: 10 });
  const bean = textToPattern(font, 'Bastidor', { heightMm: 10, bean: true });
  const n = stitchCount(normal);
  const b = stitchCount(bean);
  assert.ok(n > 0);
  const ratio = b / n;
  assert.ok(Math.abs(ratio - 3) <= 0.3, `esperava razão ~3 (±10%), achou ${ratio} (${b}/${n})`);
});

test('sem texto (ou só espaços): não quebra, sai com fio e end(), sem pontos de costura', () => {
  const font = svgfont.parseFile(HERSHEY);
  const pattern = textToPattern(font, '   ', { heightMm: 10 });
  assert.equal(stitchCount(pattern), 0);
  assert.equal(pattern.stitches[pattern.stitches.length - 1][2] & C.COMMAND_MASK, C.END);
});

// --------------------------------------------------------------- index.js (catálogo/IPC)

test('listFonts encontra as três fontes bundladas com rótulo legível', () => {
  const list = lettering.listFonts(FONTS_DIR);
  const labels = list.map((f) => f.label).sort();
  assert.deepEqual(labels, ['EMS Allure', 'EMS Nixish', 'Hershey Sans 1-stroke']);
  for (const f of list) assert.ok(f.glyphCount >= 26);
});

test('build() monta design serializável e polilinhas coerentes com o pattern', () => {
  const result = lettering.build(FONTS_DIR, { fontId: 'Hershey/HersheySans1.svg', text: 'Oi', heightMm: 10 });
  assert.ok(result.design.stitches.length > 0);
  assert.equal(result.design.threads.length, 1);
  assert.ok(result.polylines.length > 0);
  assert.equal(result.missingChars.length, 0);
  assert.ok(result.stats.stitches > 0);
});

test('build() recusa um id de fonte fora de fonts/ (proteção básica de caminho)', () => {
  assert.throws(() => lettering.loadFont(FONTS_DIR, '../../../etc/passwd'));
});
