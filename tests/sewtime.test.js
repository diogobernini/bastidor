'use strict';
// Testes da estimativa de tempo de confecção (issue #38): antes a velocidade
// da máquina (spm) ficava fixa em 600 dentro do renderer; agora vem da
// preferência machine.speedSpm (padrão 650, configurável em Configurações)
// e a função em si é pura, testável sem Electron/DOM.

const test = require('node:test');
const assert = require('node:assert');

const { estimateMinutes, formatMinutes, fmtSewTime } = require('../src/core/sewtime');

test('estimateMinutes: só pontos, sem trocas de cor', () => {
  assert.equal(estimateMinutes(6500, 0, 650), 10);
});

test('estimateMinutes: soma 0,5 min por troca de cor', () => {
  assert.equal(estimateMinutes(650, 2, 650), 1 + 1); // 1 min de pontos + 1 min de trocas
});

test('estimateMinutes: spm maior custeia menos tempo (preferência configurável)', () => {
  const lento = estimateMinutes(1300, 0, 650);
  const rapido = estimateMinutes(1300, 0, 1300);
  assert.equal(lento, 2);
  assert.equal(rapido, 1);
  assert.ok(rapido < lento);
});

test('estimateMinutes: spm zero ou negativo cai para 1 (não divide por zero)', () => {
  assert.equal(estimateMinutes(5, 0, 0), 5);
  assert.equal(estimateMinutes(5, 0, -10), 5);
});

test('formatMinutes: menos de 1 minuto', () => {
  assert.equal(formatMinutes(0.5), '< 1 min');
  assert.equal(formatMinutes(0), '< 1 min');
});

test('formatMinutes: minutos redondos, sem horas', () => {
  assert.equal(formatMinutes(1), '1 min');
  assert.equal(formatMinutes(42), '42 min');
});

test('formatMinutes: horas e minutos, com zero à esquerda', () => {
  assert.equal(formatMinutes(65), '1 h 05 min');
  assert.equal(formatMinutes(125), '2 h 05 min');
  assert.equal(formatMinutes(90), '1 h 30 min');
});

test('fmtSewTime: combina estimativa e formatação, spm configurável de ponta a ponta', () => {
  assert.equal(fmtSewTime(6500, 0, 650), '10 min');
  // mesma matriz, máquina mais rápida (spm maior) => estimativa menor
  assert.equal(fmtSewTime(6500, 0, 1300), '5 min');
  assert.equal(fmtSewTime(0, 1, 650), '< 1 min');
});
