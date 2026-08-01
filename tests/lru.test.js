'use strict';
// Testes do teto de cache extraído de renderer.js (issue #28, item 3):
// state.drives.cache (peek) e state.library.thumbCache (miniaturas) usam
// este helper para não crescer sem limite numa sessão longa com um catálogo
// grande — mesmo mecanismo simples que libThumbImages já usava ad hoc
// (Map + descarta a entrada mais antiga ao passar o teto).

const test = require('node:test');
const assert = require('node:assert');

const { setWithCap, evictToBudget } = require('../src/core/lru');

test('setWithCap: abaixo do teto, só acrescenta (nada é descartado)', () => {
  const map = new Map();
  setWithCap(map, 'a', 1, 3);
  setWithCap(map, 'b', 2, 3);
  assert.deepEqual([...map.entries()], [['a', 1], ['b', 2]]);
});

test('setWithCap: ao passar o teto, descarta a entrada mais antiga (ordem de inserção)', () => {
  const map = new Map();
  setWithCap(map, 'a', 1, 2);
  setWithCap(map, 'b', 2, 2);
  setWithCap(map, 'c', 3, 2); // empurra "a" para fora
  assert.equal(map.size, 2);
  assert.deepEqual([...map.keys()], ['b', 'c']);
  assert.equal(map.has('a'), false);
});

test('setWithCap: nunca deixa o Map passar do teto, mesmo inserindo várias chaves seguidas', () => {
  const map = new Map();
  for (let i = 0; i < 50; i++) setWithCap(map, `k${i}`, i, 5);
  assert.equal(map.size, 5);
  assert.deepEqual([...map.keys()], ['k45', 'k46', 'k47', 'k48', 'k49']);
});

test('setWithCap: atualizar uma chave já existente não conta como crescimento (não descarta nada)', () => {
  const map = new Map();
  setWithCap(map, 'a', 1, 2);
  setWithCap(map, 'b', 2, 2);
  setWithCap(map, 'a', 'atualizado', 2); // reescreve "a": Map não move a posição
  assert.equal(map.size, 2);
  assert.deepEqual([...map.keys()], ['a', 'b']);
  assert.equal(map.get('a'), 'atualizado');
});

test('setWithCap: teto 0 esvazia o Map a cada inserção', () => {
  const map = new Map();
  setWithCap(map, 'a', 1, 0);
  assert.equal(map.size, 0);
});

test('setWithCap: devolve o próprio Map (encadeável)', () => {
  const map = new Map();
  const result = setWithCap(map, 'a', 1, 5);
  assert.equal(result, map);
});

// ---- evictToBudget (issue #57): teto por custo, não por contagem ----
// O cache de peek retém matrizes inteiras (~1 MB cada em catálogo real); o
// custo de cada entrada é o nº de agulhadas e o teto é um orçamento total.

const costIsValue = (v) => v; // nos testes, o próprio valor é o custo

test('evictToBudget: dentro do orçamento, não descarta nada', () => {
  const map = new Map([['a', 10], ['b', 20]]);
  evictToBudget(map, costIsValue, 30);
  assert.deepEqual([...map.keys()], ['a', 'b']);
});

test('evictToBudget: acima do orçamento, descarta as mais antigas até caber', () => {
  const map = new Map([['a', 40], ['b', 30], ['c', 20]]);
  evictToBudget(map, costIsValue, 60); // 90 > 60: derruba "a" (fica 50)
  assert.deepEqual([...map.keys()], ['b', 'c']);
});

test('evictToBudget: uma única entrada acima do orçamento também é descartada', () => {
  const map = new Map([['gigante', 1000]]);
  evictToBudget(map, costIsValue, 400);
  assert.equal(map.size, 0);
});

test('evictToBudget: entradas de custo zero (pendências/erros) não pesam nem são alvo preferencial', () => {
  const map = new Map([['pendente', 0], ['a', 300], ['b', 300]]);
  evictToBudget(map, costIsValue, 400); // derruba "pendente" (custo 0, mais antiga) e depois "a"
  assert.deepEqual([...map.keys()], ['b']);
});

test('evictToBudget: custo não numérico conta como zero (não quebra)', () => {
  const map = new Map([['a', undefined], ['b', 50]]);
  evictToBudget(map, costIsValue, 40); // total 50 > 40: derruba "a" (0), depois "b"
  assert.equal(map.size, 0);
});

test('evictToBudget: devolve o próprio Map (encadeável)', () => {
  const map = new Map();
  assert.equal(evictToBudget(map, costIsValue, 10), map);
});
