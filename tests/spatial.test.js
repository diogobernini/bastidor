'use strict';
// Testes do módulo puro de edição espacial (issue #3: mover, apagar, inserir pontos).

const test = require('node:test');
const assert = require('node:assert');

const { nearestStitch, insertMidpoint } = require('../src/core/spatial');

test('nearestStitch retorna -1 para lista vazia', () => {
  assert.equal(nearestStitch([], 0, 0, 8), -1);
});

test('nearestStitch encontra o ponto exato quando a distância é zero', () => {
  const stitches = [[0, 0, 0], [50, 50, 0], [100, 0, 0]];
  assert.equal(nearestStitch(stitches, 50, 50, 8), 1);
});

test('nearestStitch respeita o raio máximo', () => {
  const stitches = [[0, 0, 0], [100, 0, 0]];
  assert.equal(nearestStitch(stitches, 50, 0, 8), -1, 'nada a 50 unidades quando o raio é 8');
  assert.equal(nearestStitch(stitches, 5, 0, 8), 0, 'dentro do raio deve achar o ponto 0');
});

test('nearestStitch escolhe o mais próximo entre vários candidatos', () => {
  const stitches = [
    [0, 0, 0],
    [3, 0, 0], // mais próximo de (5,0)
    [10, 0, 0],
  ];
  assert.equal(nearestStitch(stitches, 5, 0, 8), 1);
});

test('nearestStitch encontra pontos em células vizinhas (perto da borda da grade)', () => {
  // cellSize = maxDist = 8: o alvo (7,0) fica perto do fim da célula 0 e o
  // ponto (9,0) já cai na célula vizinha (1), mas a distância real (2) está
  // bem dentro do raio — só funciona varrendo as 9 células ao redor do alvo.
  const stitches = [[9, 0, 0]];
  assert.equal(nearestStitch(stitches, 7, 0, 8), 0);
});

test('nearestStitch ignora pontos na mesma célula mas fora do raio real', () => {
  // (7,7) cai na mesma célula que a origem (cellSize=8), mas a distância
  // euclidiana real (~9,9) excede o raio de 8: bucket não basta, tem que
  // conferir a distância exata.
  const stitches = [[7, 7, 0]];
  assert.equal(nearestStitch(stitches, 0, 0, 8), -1);
});

test('insertMidpoint insere ponto STITCH no meio do segmento e retorna o novo índice', () => {
  const stitches = [[0, 0, 1], [100, 200, 1]];
  const idx = insertMidpoint(stitches, 0);
  assert.equal(idx, 1);
  assert.equal(stitches.length, 3);
  assert.deepEqual(stitches[1], [50, 100, 0]);
  assert.deepEqual(stitches[0], [0, 0, 1]);
  assert.deepEqual(stitches[2], [100, 200, 1]);
});

test('insertMidpoint arredonda coordenadas fracionárias', () => {
  const stitches = [[0, 0, 0], [1, 1, 0]];
  insertMidpoint(stitches, 0);
  assert.deepEqual(stitches[1], [1, 1, 0]); // (0+1)/2 = 0,5 -> arredonda p/ 1 (Math.round)
});

test('insertMidpoint retorna -1 quando não há próximo ponto', () => {
  const stitches = [[0, 0, 0], [1, 1, 0]];
  assert.equal(insertMidpoint(stitches, 1), -1, 'último ponto não tem sucessor');
  assert.equal(insertMidpoint(stitches, 5), -1, 'índice fora da faixa');
  assert.equal(insertMidpoint(stitches, -1), -1, 'índice negativo');
  assert.equal(stitches.length, 2, 'nada deve ter sido inserido');
});

test('insertMidpoint em lista de um único ponto não insere nada', () => {
  const stitches = [[0, 0, 0]];
  assert.equal(insertMidpoint(stitches, 0), -1);
});

test('nearestStitch continua correto e rápido com 100 mil pontos', () => {
  const stitches = [];
  for (let i = 0; i < 100000; i++) {
    stitches.push([(i * 37) % 200000 - 100000, (i * 53) % 200000 - 100000, 0]);
  }
  // planta um ponto num lugar conhecido, longe de qualquer outro
  stitches.push([123456, -54321, 0]);
  const plantedIndex = stitches.length - 1;

  const start = Date.now();
  const idx = nearestStitch(stitches, 123458, -54320, 8);
  const elapsedMs = Date.now() - start;

  assert.equal(idx, plantedIndex);
  assert.ok(elapsedMs < 1000, `esperava responder em menos de 1s, levou ${elapsedMs}ms`);
});
