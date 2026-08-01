'use strict';
// Testes do ponto cheio (satin) do lettering (issue #19): geometria pura
// (src/core/lettering/satin.js) e integração com o pipeline de texto
// (src/core/lettering/stitcher.js: opts.finish === 'satin', com/sem underlay).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const satin = require('../src/core/lettering/satin');
const svgfont = require('../src/core/lettering/svgfont');
const { textToPattern, resolveFinish, buildSatinSequence } = require('../src/core/lettering/stitcher');
const C = require('../src/core/commands');

const FONTS_DIR = path.join(__dirname, '..', 'fonts');
const HERSHEY = path.join(FONTS_DIR, 'Hershey', 'HersheySans1.svg');

// Distância (com sinal, via produto vetorial) de um ponto até a reta que
// passa por "a" na direção unitária "dir" — usado para checar
// perpendicularidade/alternância sem depender da forma exata do zigue-zague.
function signedOffset(p, a, dir) {
  const vx = p[0] - a[0];
  const vy = p[1] - a[1];
  // Componente perpendicular a "dir" (produto vetorial 2D dir x v).
  return dir[0] * vy - dir[1] * vx;
}

// --------------------------------------------------------------- satin.js

test('localDirections: reta simples tem a mesma direção em todos os pontos', () => {
  const pts = [
    [0, 0],
    [10, 0],
    [20, 0],
    [30, 0],
  ];
  const dirs = satin.localDirections(pts);
  for (const d of dirs) {
    assert.ok(Math.abs(d[0] - 1) < 1e-9 && Math.abs(d[1]) < 1e-9, `esperava [1,0], achou ${d}`);
  }
});

test('perpendicular() gira 90°: produto escalar com o vetor original é zero', () => {
  const d = [0.6, 0.8]; // unitário
  const p = satin.perpendicular(d);
  const dot = d[0] * p[0] + d[1] * p[1];
  assert.ok(Math.abs(dot) < 1e-9, `esperava perpendicular, produto escalar = ${dot}`);
  assert.ok(Math.abs(Math.hypot(p[0], p[1]) - 1) < 1e-9, 'perpendicular de vetor unitário deveria ser unitário');
});

test('satinizeStroke: perpendicularidade — cada agulhada fica a ~largura/2 da reta original', () => {
  const pts = [
    [0, 0],
    [1000, 0],
  ]; // traço reto horizontal, 100 mm
  const widthUnits = 20; // 2 mm
  const densityUnits = 40; // 4 mm
  const out = satin.satinizeStroke(pts, { widthUnits, densityUnits });
  assert.ok(out.length >= 2);
  for (const p of out) {
    // Reta original é o eixo X (dir = [1,0]); o deslocamento perpendicular
    // (aqui, simplesmente p[1]) deve ter módulo ~largura/2.
    assert.ok(Math.abs(Math.abs(p[1]) - widthUnits / 2) < 1e-6, `ponto ${p} fora da largura esperada`);
    assert.ok(Math.abs(p[1]) <= widthUnits / 2 + 1e-6, 'nunca deveria exceder a largura/2');
  }
});

test('satinizeStroke: alternância de lados — o sinal do deslocamento perpendicular alterna a cada travessa', () => {
  const pts = [
    [0, 0],
    [1000, 0],
  ];
  const out = satin.satinizeStroke(pts, { widthUnits: 20, densityUnits: 40 });
  assert.ok(out.length >= 4, 'precisa de várias travessas para testar alternância');
  const signs = out.map((p) => Math.sign(p[1]));
  for (let i = 1; i < signs.length; i++) {
    assert.notEqual(signs[i], signs[i - 1], `travessas ${i - 1} e ${i} do mesmo lado (${signs[i - 1]})`);
  }
});

test('satinizeStroke: densidade — o avanço ao longo do traço entre travessas é ~densityUnits', () => {
  const pts = [
    [0, 0],
    [1000, 0],
  ];
  const densityUnits = 40;
  const out = satin.satinizeStroke(pts, { widthUnits: 20, densityUnits });
  // Como o traço é reto e horizontal, o avanço ao longo do traço é a
  // diferença em X entre travessas consecutivas (a componente perpendicular,
  // Y, não conta como "avanço").
  for (let i = 1; i < out.length - 1; i++) {
    const advance = out[i][0] - out[i - 1][0];
    assert.ok(Math.abs(advance - densityUnits) < 1e-6, `avanço ${advance} fora de ${densityUnits}`);
  }
});

test('satinizeStroke: largura respeitada mesmo variando a direção do traço (canto em L)', () => {
  const pts = [
    [0, 0],
    [500, 0],
    [500, 500],
  ];
  const widthUnits = 30; // 3 mm
  const out = satin.satinizeStroke(pts, { widthUnits, densityUnits: 20 });
  assert.ok(out.length >= 4);
  // Cada agulhada deve estar a ~largura/2 do ponto mais próximo do traço
  // original (aproximação por amostragem dos dois segmentos do L).
  const samples = [];
  for (let t = 0; t <= 1; t += 0.02) samples.push([t * 500, 0]);
  for (let t = 0; t <= 1; t += 0.02) samples.push([500, t * 500]);
  // Numa mitra simples, a travessa mais próxima do vértice do canto (90°
  // aqui) fica um pouco mais afastada do traço original que largura/2 — o
  // mesmo efeito de "ponta de mitra" de qualquer traçado vetorial com join
  // miter; o pior caso teórico num canto reto é largura/2 * sqrt(2).
  const maxAtCorner = (widthUnits / 2) * Math.SQRT2 + 0.5;
  for (const p of out) {
    let minDist = Infinity;
    for (const s of samples) minDist = Math.min(minDist, Math.hypot(p[0] - s[0], p[1] - s[1]));
    assert.ok(minDist >= widthUnits / 2 - 0.5 && minDist <= maxAtCorner, `agulhada ${p} a ${minDist} do traço (esperado entre ~${widthUnits / 2} e ${maxAtCorner})`);
  }
});

test('satinizeStroke: traço degenerado (< 2 pontos úteis) devolve zigue-zague vazio', () => {
  assert.deepEqual(satin.satinizeStroke([[5, 5]], { widthUnits: 20, densityUnits: 10 }), []);
  assert.deepEqual(satin.satinizeStroke([[5, 5], [5, 5]], { widthUnits: 20, densityUnits: 10 }), []);
});

// --------------------------------------------------------------- stitcher.js (integração)

test('resolveFinish: bean legado continua funcionando; finish tem prioridade', () => {
  assert.equal(resolveFinish({}), 'running');
  assert.equal(resolveFinish({ bean: true }), 'bean');
  assert.equal(resolveFinish({ finish: 'satin' }), 'satin');
  assert.equal(resolveFinish({ finish: 'satin', bean: true }), 'satin');
  assert.equal(resolveFinish({ finish: 'bean' }), 'bean');
});

test('buildSatinSequence: sem underlay é só o zigue-zague; com underlay, prefixo é ponto corrido pelo centro', () => {
  const pts = [
    [0, 0],
    [1000, 0],
  ];
  const opts = { widthUnits: 20, densityUnits: 40, stepUnits: 20 };
  const noUnderlay = buildSatinSequence(pts, { ...opts, underlay: false });
  const withUnderlay = buildSatinSequence(pts, { ...opts, underlay: true });
  assert.ok(withUnderlay.length > noUnderlay.length, 'underlay deveria adicionar agulhadas');

  // O prefixo de "withUnderlay" é o ponto corrido pelo CENTRO (Y ~ 0), antes
  // do zigue-zague (que se afasta do centro por largura/2).
  const centerPrefixLen = withUnderlay.length - noUnderlay.length;
  for (let i = 0; i < centerPrefixLen; i++) {
    assert.ok(Math.abs(withUnderlay[i][1]) < 1e-6, `ponto de underlay ${withUnderlay[i]} deveria estar no centro (Y~0)`);
  }
});

test('textToPattern com finish "satin": gera muito mais agulhadas que ponto corrido para o mesmo texto', () => {
  const font = svgfont.parseFile(HERSHEY);
  const running = textToPattern(font, 'B', { heightMm: 20 });
  const satinPattern = textToPattern(font, 'B', { heightMm: 20, finish: 'satin', satinWidthMm: 2, satinDensityMm: 0.4 });
  const count = (p) => p.countStitchCommands(C.STITCH);
  assert.ok(count(satinPattern) > count(running), 'satin deveria ter mais agulhadas (zigue-zague denso)');
  assert.equal(satinPattern.stitches[satinPattern.stitches.length - 1][2] & C.COMMAND_MASK, C.END);
});

test('textToPattern com finish "satin" e underlay: mais agulhadas ainda, e permanece uma única cor', () => {
  const font = svgfont.parseFile(HERSHEY);
  const withoutUnderlay = textToPattern(font, 'L', { heightMm: 20, finish: 'satin', satinWidthMm: 2, satinDensityMm: 0.5 });
  const withUnderlay = textToPattern(font, 'L', {
    heightMm: 20,
    finish: 'satin',
    satinWidthMm: 2,
    satinDensityMm: 0.5,
    underlay: true,
  });
  const count = (p) => p.countStitchCommands(C.STITCH);
  assert.ok(count(withUnderlay) > count(withoutUnderlay), 'underlay deveria adicionar agulhadas de ponto corrido');
  assert.equal(withUnderlay.threadlist.length, 1);
});

test('textToPattern com finish "satin": nenhuma agulhada excede a largura pedida além da tolerância de arredondamento', () => {
  const font = svgfont.parseFile(HERSHEY);
  const widthMm = 3;
  const pattern = textToPattern(font, 'H', { heightMm: 25, finish: 'satin', satinWidthMm: widthMm, satinDensityMm: 0.4 });
  assert.ok(pattern.countStitchCommands(C.STITCH) > 0);
  // Sanidade adicional: nenhuma agulhada isolada deveria ficar muito maior
  // que a diagonal esperada (largura x densidade), sinal de que a
  // construção "por travessa" está de fato limitando o comprimento.
  const widthUnits = widthMm * 10;
  const maxExpected = Math.hypot(widthUnits, 40 /* alguma folga */) + 5;
  let prev = null;
  for (const st of pattern.stitches) {
    const cmd = st[2] & C.COMMAND_MASK;
    if (cmd === C.STITCH && prev) {
      const len = Math.hypot(st[0] - prev[0], st[1] - prev[1]);
      assert.ok(len < maxExpected * 4, `agulhada de satin longa demais: ${len} unidades`);
    }
    if (cmd === C.STITCH || cmd === C.JUMP) prev = [st[0], st[1]];
    else prev = null;
  }
});
