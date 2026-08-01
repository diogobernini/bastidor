'use strict';
// Testes de src/i18n.js (issue #28, item 4): resolveLang precisa aceitar
// "pt" e qualquer variante "pt-*" (pt-PT, pt_BR, PT maiúsculo...) como
// alias de 'pt-BR', sem regredir o comportamento de 'en', 'auto' (fallback
// pelo locale do sistema) ou do valor exato 'pt-BR' já suportado.

const test = require('node:test');
const assert = require('node:assert');

const { resolveLang, makeT, STRINGS } = require('../src/i18n');

test('resolveLang: "pt" resolve para pt-BR (alias pedido pelo backlog)', () => {
  assert.equal(resolveLang('pt', 'en-US'), 'pt-BR');
});

test('resolveLang: qualquer variante "pt-*" resolve para pt-BR', () => {
  assert.equal(resolveLang('pt-PT', 'en-US'), 'pt-BR');
  assert.equal(resolveLang('pt-pt', 'en-US'), 'pt-BR');
  assert.equal(resolveLang('pt_BR', 'en-US'), 'pt-BR'); // underscore (locale POSIX-like)
});

test('resolveLang: aceita maiúsculas ("PT", "EN")', () => {
  assert.equal(resolveLang('PT', 'en-US'), 'pt-BR');
  assert.equal(resolveLang('EN', 'pt-BR'), 'en');
});

test('resolveLang: "en" continua resolvendo para en, mesmo com sistema em pt', () => {
  assert.equal(resolveLang('en', 'pt-BR'), 'en');
});

test('resolveLang: "pt-BR" exato continua funcionando', () => {
  assert.equal(resolveLang('pt-BR', 'en-US'), 'pt-BR');
});

test('resolveLang: preferência vazia/"auto" cai no locale do sistema', () => {
  assert.equal(resolveLang('auto', 'pt-BR'), 'pt-BR');
  assert.equal(resolveLang('auto', 'pt-PT'), 'pt-BR');
  assert.equal(resolveLang('auto', 'en-US'), 'en');
  assert.equal(resolveLang(null, 'pt-BR'), 'pt-BR');
  assert.equal(resolveLang(undefined, 'en-GB'), 'en');
});

test('resolveLang: locale de sistema desconhecido cai para en', () => {
  assert.equal(resolveLang('auto', 'ja-JP'), 'en');
  assert.equal(resolveLang('auto', ''), 'en');
});

test('makeT: strings existem para "pt" resolvido (pt-BR) e para en, sem chave crua vazando', () => {
  const tPt = makeT(resolveLang('pt', 'en-US'));
  const tEn = makeT(resolveLang('en', 'pt-BR'));
  assert.equal(tPt('menu.open'), STRINGS['pt-BR']['menu.open']);
  assert.equal(tEn('menu.open'), STRINGS.en['menu.open']);
});
