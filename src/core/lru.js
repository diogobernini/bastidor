'use strict';
// Teto simples para caches em memória do renderer (issue #28, item 3):
// state.drives.cache (peek de matriz) e state.library.thumbCache (promessas
// de miniatura) cresciam sem limite durante a sessão. Mesmo mecanismo que
// libThumbImages já usava ad hoc em renderer.js (Map + descarta a entrada
// mais antiga ao passar o teto) — extraído aqui para ser reaproveitado pelos
// dois caches e testado isoladamente por node:test.
//
// Não é um LRU "de verdade" (que promoveria uma chave ao ser lida de novo):
// é um teto por ordem de inserção (a mais antiga cai primeiro), que é
// exatamente o que os três caches do app precisam — cada chave (caminho +
// mtime) é escrita uma única vez e só relida, nunca "renovada".
//
// Módulo puro (sem DOM, sem Node): carregado tanto via
// <script src="../core/lru.js"> em index.html (antes de renderer.js) quanto
// via require() nos testes — mesmo padrão de spatial.js/densityscale.js.

const LruCap = (function () {
  // Grava map.set(key, value) e, se isso deixar o Map com mais de `cap`
  // entradas, descarta a mais antiga (Map preserva ordem de inserção) até
  // caber de novo. Atualizar uma chave já existente não conta como
  // crescimento (Map.set não altera a posição de uma chave existente).
  function setWithCap(map, key, value, cap) {
    map.set(key, value);
    while (map.size > cap) {
      map.delete(map.keys().next().value);
    }
    return map;
  }

  // Teto por CUSTO, não por contagem (issue #57): um teto de N entradas não
  // protege um cache cujas entradas variam de bytes a megabytes — o cache de
  // peek guarda matrizes inteiras (~1 MB cada em catálogo real), então 2000
  // entradas eram ~2 GB e derrubavam o renderer por OOM. Aqui o chamador
  // descreve o custo de cada valor (costOf, ex.: nº de agulhadas retidas) e
  // um orçamento total; descartamos as entradas mais antigas até o somatório
  // caber. O(n) por chamada — os caches do app têm no máximo centenas de
  // entradas vivas, então não vale carregar contabilidade incremental.
  function evictToBudget(map, costOf, budget) {
    let total = 0;
    for (const v of map.values()) total += costOf(v) || 0;
    const oldest = map.keys();
    while (total > budget) {
      const k = oldest.next().value;
      if (k === undefined) break;
      total -= costOf(map.get(k)) || 0;
      map.delete(k);
    }
    return map;
  }

  return { setWithCap, evictToBudget };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LruCap;
}
