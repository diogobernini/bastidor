'use strict';
// Testes do núcleo de digitalização PNG -> vetor (issue #2): quantização por
// median-cut, contorno por marching squares, simplificação Douglas-Peucker e
// a pipeline completa até um Pattern costurável.

const test = require('node:test');
const assert = require('node:assert');

const { quantize, traceRegions, simplify, rasterToPaths, pathsToPattern } = require('../src/core/digitize/raster');
const C = require('../src/core/commands');
const io = require('../src/core/io');

// Desenha um retângulo cheio (x0..x1, y0..y1 exclusivo) numa imagem RGBA.
function fillRect(image, x0, y0, x1, y1, [r, g, b, a = 255]) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = a;
    }
  }
}

function blankImage(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    area += x0 * y1 - x1 * y0;
  }
  return area / 2;
}

test('quantize: imagem sintética de 3 cores gera paleta de 3 e indexed coerente', () => {
  const img = blankImage(30, 10);
  fillRect(img, 0, 0, 10, 10, [255, 0, 0]);
  fillRect(img, 10, 0, 20, 10, [0, 255, 0]);
  fillRect(img, 20, 0, 30, 10, [0, 0, 255]);

  const { palette, indexed } = quantize(img, 3);
  assert.equal(palette.length, 3);

  const idxRed = indexed[5];
  const idxGreen = indexed[15];
  const idxBlue = indexed[25];
  assert.notEqual(idxRed, idxGreen);
  assert.notEqual(idxGreen, idxBlue);
  assert.notEqual(idxRed, idxBlue);

  // cada região deve mapear inteiramente para o mesmo índice (sem mistura de cor)
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) assert.equal(indexed[y * 30 + x], idxRed);
    for (let x = 10; x < 20; x++) assert.equal(indexed[y * 30 + x], idxGreen);
    for (let x = 20; x < 30; x++) assert.equal(indexed[y * 30 + x], idxBlue);
  }

  // as cores da paleta devem corresponder às cores originais (dentro de arredondamento)
  const byIndex = { [idxRed]: [255, 0, 0], [idxGreen]: [0, 255, 0], [idxBlue]: [0, 0, 255] };
  for (const [idx, expected] of Object.entries(byIndex)) {
    assert.deepEqual(palette[Number(idx)], expected);
  }
});

test('quantize: pixels com alpha < 128 ficam marcados como transparentes (255)', () => {
  const img = blankImage(4, 4);
  fillRect(img, 0, 0, 4, 2, [200, 50, 50, 255]); // metade opaca
  fillRect(img, 0, 2, 4, 4, [200, 50, 50, 40]); // metade quase transparente
  const { indexed } = quantize(img, 4);
  for (let i = 0; i < 8; i++) assert.notEqual(indexed[i], 255);
  for (let i = 8; i < 16; i++) assert.equal(indexed[i], 255);
});

test('traceRegions: máscara quadrada gera 1 contorno que após simplify vira ~4 cantos', () => {
  const width = 60;
  const height = 60;
  const indexed = new Uint8Array(width * height).fill(255);
  for (let y = 10; y < 50; y++) {
    for (let x = 10; x < 50; x++) indexed[y * width + x] = 0;
  }

  const contours = traceRegions(indexed, width, height, 0);
  assert.equal(contours.length, 1, 'um quadrado sólido é 1 contorno');

  const simplified = simplify(contours[0], 1.0);
  assert.ok(
    simplified.length >= 4 && simplified.length <= 6,
    `esperava ~4 cantos, obteve ${simplified.length}: ${JSON.stringify(simplified)}`
  );

  const area = Math.abs(signedArea(contours[0]));
  assert.ok(Math.abs(area - 1600) < 5, `área do quadrado bruto deveria ser ~1600, obteve ${area}`);
});

test('traceRegions: anel (quadrado com furo) gera 2 contornos com orientação oposta', () => {
  const width = 60;
  const height = 60;
  const indexed = new Uint8Array(width * height).fill(255);
  for (let y = 10; y < 50; y++) {
    for (let x = 10; x < 50; x++) indexed[y * width + x] = 0;
  }
  for (let y = 20; y < 40; y++) {
    for (let x = 20; x < 40; x++) indexed[y * width + x] = 255; // furo
  }

  const contours = traceRegions(indexed, width, height, 0);
  assert.equal(contours.length, 2, 'anel = contorno externo + furo');

  const areas = contours.map(signedArea);
  assert.ok((areas[0] > 0) !== (areas[1] > 0), 'contorno externo e furo devem ter sinais de área opostos');

  const abs = areas.map(Math.abs).sort((a, b) => b - a);
  assert.ok(Math.abs(abs[0] - 1600) < 5, `área externa deveria ser ~1600, obteve ${abs[0]}`);
  assert.ok(Math.abs(abs[1] - 400) < 5, `área do furo deveria ser ~400, obteve ${abs[1]}`);
});

test('pipeline completo: imagem sintética -> Pattern com N blocos e roundtrip por XXX', () => {
  // Imagem 90x60: fundo verde, quadrado vermelho à esquerda, círculo azul à direita.
  const width = 90;
  const height = 60;
  const img = blankImage(width, height);
  fillRect(img, 0, 0, width, height, [40, 160, 90]);
  fillRect(img, 8, 8, 38, 38, [200, 40, 40]);
  const cx = 65;
  const cy = 30;
  const r = 20;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
        const i = (y * width + x) * 4;
        img.data[i] = 40;
        img.data[i + 1] = 90;
        img.data[i + 2] = 220;
        img.data[i + 3] = 255;
      }
    }
  }

  const paths = rasterToPaths(img, { colors: 3, simplifyTol: 1.2 });
  assert.equal(paths.length, 3, 'as 3 cores da paleta deveriam gerar caminho (nenhuma some por área zero)');

  const scale = 20; // 1 px = 2,0 mm (unidade nativa = 0,1 mm)
  const pattern = pathsToPattern(paths, { scale, stitchLenMm: 2.5 });

  assert.equal(pattern.threadlist.length, 3);
  assert.equal(pattern.countColorChanges(), 2, 'N cores -> N-1 trocas de cor');
  const last = pattern.stitches[pattern.stitches.length - 1];
  assert.equal(last[2] & C.COMMAND_MASK, C.END);
  assert.ok(pattern.countStitches() > 20, 'deveria ter pontos suficientes para desenhar os contornos');

  const blocks = pattern.getAsColorblocks();
  assert.equal(blocks.length, 3);
  for (const [stitches] of blocks) {
    assert.ok(stitches.some((s) => (s[2] & C.COMMAND_MASK) === C.STITCH), 'todo bloco deve costurar algo');
  }

  // Roundtrip: grava em XXX e lê de volta, preservando cores e nº de pontos.
  const buf = io.writeBuffer(pattern, 'xxx');
  const readBack = io.readBuffer(buf, 'xxx');
  assert.equal(readBack.threadlist.length, 3);
  assert.deepEqual(readBack.threadlist.map((t) => t.hex()), pattern.threadlist.map((t) => t.hex()));

  const countStitch = (p) => p.stitches.filter((s) => (s[2] & C.COMMAND_MASK) === C.STITCH).length;
  const normalized = pattern.getNormalizedPattern({ max_jump: 124, max_stitch: 124, round: true });
  assert.equal(countStitch(readBack), countStitch(normalized));
});

test('pathsToPattern: sem cores visíveis gera Pattern vazio mas válido (só END)', () => {
  const pattern = pathsToPattern([], {});
  assert.equal(pattern.threadlist.length, 0);
  assert.equal(pattern.stitches.length, 1);
  assert.equal(pattern.stitches[0][2] & C.COMMAND_MASK, C.END);
});
