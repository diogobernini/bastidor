'use strict';
// Testes do gestor de biblioteca (src/main/library.js, issue #17): navegação
// por pastas, busca por nome, contenção de caminho, favoritos e o cache de
// miniaturas por mtime. Tudo com diretórios temporários sintéticos, no mesmo
// espírito de tests/drives.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const library = require('../src/main/library');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ------------------------------------------------------------------ listSubfolders

test('listSubfolders: só subpastas imediatas, ignora ocultas e arquivos', () => {
  const root = makeTmpDir('bastidor-lib-sub-');
  try {
    fs.mkdirSync(path.join(root, 'Bordados 2024'));
    fs.mkdirSync(path.join(root, 'Ponto cheio'));
    fs.mkdirSync(path.join(root, '.oculta'));
    fs.writeFileSync(path.join(root, 'rosa.dst'), 'x');
    fs.mkdirSync(path.join(root, 'Bordados 2024', 'neta')); // não deve aparecer (não imediata)

    const subs = library.listSubfolders(root, '');
    assert.deepEqual(
      subs.map((s) => s.name),
      ['Bordados 2024', 'Ponto cheio']
    );
    assert.equal(subs[0].relDir, 'Bordados 2024');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listSubfolders: pasta inexistente devolve lista vazia (não lança)', () => {
  assert.deepEqual(library.listSubfolders('/caminho/inexistente/de/verdade', ''), []);
});

// ------------------------------------------------------------------ listFolderContents

test('listFolderContents: separa pastas e arquivos suportados, ordenados, ignora ocultos e extensões não suportadas', () => {
  const root = makeTmpDir('bastidor-lib-list-');
  try {
    fs.mkdirSync(path.join(root, 'zeta'));
    fs.mkdirSync(path.join(root, 'alfa'));
    fs.writeFileSync(path.join(root, 'rosa.dst'), 'conteudo');
    fs.writeFileSync(path.join(root, 'nota.txt'), 'x'); // extensão não suportada
    fs.writeFileSync(path.join(root, '.oculto.jef'), 'x'); // arquivo oculto

    const { folders, files } = library.listFolderContents(root, '');
    assert.deepEqual(folders.map((f) => f.name), ['alfa', 'zeta']);
    assert.deepEqual(files.map((f) => f.name), ['rosa.dst']);
    assert.equal(files[0].ext, 'dst');
    assert.equal(files[0].sizeBytes, 'conteudo'.length);
    assert.equal(typeof files[0].mtime, 'number');
    assert.equal(files[0].relPath, 'rosa.dst');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listFolderContents: lista subpasta (relDir) com caminhos relativos corretos', () => {
  const root = makeTmpDir('bastidor-lib-sublist-');
  try {
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'flor.pes'), 'x');

    const { files } = library.listFolderContents(root, 'sub');
    assert.equal(files.length, 1);
    assert.equal(files[0].relPath, path.join('sub', 'flor.pes'));
    assert.equal(files[0].path, path.join(root, 'sub', 'flor.pes'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listFolderContents: pasta inexistente devolve listas vazias (não lança)', () => {
  assert.deepEqual(library.listFolderContents('/caminho/inexistente/de/verdade', ''), { folders: [], files: [] });
});

// ------------------------------------------------------------------ searchDesigns

test('searchDesigns: encontra por substring sem diferenciar maiúsculas, em qualquer subpasta', () => {
  const root = makeTmpDir('bastidor-lib-search-');
  try {
    fs.writeFileSync(path.join(root, 'Rosacea.dst'), 'x');
    fs.mkdirSync(path.join(root, 'flores'));
    fs.writeFileSync(path.join(root, 'flores', 'rosa-grande.jef'), 'x');
    fs.writeFileSync(path.join(root, 'flores', 'margarida.pes'), 'x');

    const { items, truncated } = library.searchDesigns(root, 'rosa');
    assert.equal(truncated, false);
    assert.deepEqual(
      items.map((i) => i.relPath).sort(),
      ['Rosacea.dst', path.join('flores', 'rosa-grande.jef')].sort()
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('searchDesigns: query vazia devolve todos os arquivos suportados da árvore', () => {
  const root = makeTmpDir('bastidor-lib-search-all-');
  try {
    fs.writeFileSync(path.join(root, 'a.dst'), 'x');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'b.jef'), 'x');
    fs.writeFileSync(path.join(root, 'sub', 'nota.txt'), 'x');

    const { items } = library.searchDesigns(root, '');
    assert.deepEqual(items.map((i) => i.name).sort(), ['a.dst', 'b.jef']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('searchDesigns: respeita o teto de resultados e sinaliza truncamento', () => {
  const root = makeTmpDir('bastidor-lib-search-cap-');
  try {
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(root, `m${i}.dst`), 'x');
    const { items, truncated } = library.searchDesigns(root, '', { maxResults: 3 });
    assert.equal(items.length, 3);
    assert.equal(truncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('searchDesigns: pasta inexistente devolve lista vazia (não lança)', () => {
  const { items, truncated } = library.searchDesigns('/caminho/inexistente/de/verdade', 'x');
  assert.deepEqual(items, []);
  assert.equal(truncated, false);
});

// ------------------------------------------------------------------ contenção de caminho

test('resolveWithinRoot: aceita relativo dentro da raiz, recusa ".." e absoluto de fora', () => {
  const root = makeTmpDir('bastidor-lib-contain-');
  try {
    assert.equal(library.resolveWithinRoot(root, 'sub/x'), path.resolve(root, 'sub/x'));
    assert.throws(() => library.resolveWithinRoot(root, '../fora'));
    assert.throws(() => library.resolveWithinRoot(root, '/etc/passwd'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isWithinRoot: verdadeiro para a própria raiz e para dentro, falso para fora', () => {
  const root = makeTmpDir('bastidor-lib-within-');
  try {
    assert.equal(library.isWithinRoot(root, root), true);
    assert.equal(library.isWithinRoot(root, path.join(root, 'a', 'b.dst')), true);
    assert.equal(library.isWithinRoot(root, os.tmpdir()), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ renameEntry / moveEntry

test('renameEntry: renomeia dentro da mesma pasta e recusa nome com separador de caminho', () => {
  const root = makeTmpDir('bastidor-lib-rename-');
  try {
    const src = path.join(root, 'antigo.dst');
    fs.writeFileSync(src, 'conteudo');

    const result = library.renameEntry(root, src, 'novo.dst');
    assert.equal(result.path, path.join(root, 'novo.dst'));
    assert.ok(!fs.existsSync(src));
    assert.equal(fs.readFileSync(result.path, 'utf8'), 'conteudo');

    assert.throws(() => library.renameEntry(root, result.path, '../fora.dst'));
    assert.throws(() => library.renameEntry(root, result.path, 'sub/outro.dst'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renameEntry: recusa sobrescrever um arquivo existente e recusa arquivo fora da raiz', () => {
  const root = makeTmpDir('bastidor-lib-rename-conflict-');
  const outside = makeTmpDir('bastidor-lib-rename-outside-');
  try {
    fs.writeFileSync(path.join(root, 'a.dst'), 'a');
    fs.writeFileSync(path.join(root, 'b.dst'), 'b');
    assert.throws(() => library.renameEntry(root, path.join(root, 'a.dst'), 'b.dst'));

    const outsideFile = path.join(outside, 'fora.dst');
    fs.writeFileSync(outsideFile, 'x');
    assert.throws(() => library.renameEntry(root, outsideFile, 'novo.dst'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('moveEntry: move para subpasta (criando-a) e recusa sobrescrever no destino', () => {
  const root = makeTmpDir('bastidor-lib-move-');
  try {
    const src = path.join(root, 'flor.jef');
    fs.writeFileSync(src, 'conteudo');

    const result = library.moveEntry(root, src, path.join('coleção', '2024'));
    assert.equal(result.path, path.join(root, 'coleção', '2024', 'flor.jef'));
    assert.ok(!fs.existsSync(src));
    assert.equal(fs.readFileSync(result.path, 'utf8'), 'conteudo');

    // Já existe um "flor.jef" na raiz: mover de volta para lá deve recusar.
    fs.writeFileSync(path.join(root, 'flor.jef'), 'outro conteudo');
    assert.throws(() => library.moveEntry(root, result.path, '.'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('moveEntry: recusa destino fora da raiz', () => {
  const root = makeTmpDir('bastidor-lib-move-escape-');
  try {
    const src = path.join(root, 'flor.jef');
    fs.writeFileSync(src, 'x');
    assert.throws(() => library.moveEntry(root, src, '../fora'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ favoritos

test('favoritos: alterna adicionar/remover e persiste entre carregamentos', () => {
  const userData = makeTmpDir('bastidor-lib-fav-');
  try {
    const filePath = '/biblioteca/rosa.dst';
    let list = library.toggleFavorite(userData, filePath);
    assert.deepEqual(list, [path.resolve(filePath)]);

    const reloaded = library.loadFavorites(userData);
    assert.deepEqual(reloaded, [path.resolve(filePath)]);

    list = library.toggleFavorite(userData, filePath);
    assert.deepEqual(list, []);
    assert.deepEqual(library.loadFavorites(userData), []);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('favoritos: userData sem arquivo ainda devolve lista vazia (não lança)', () => {
  const userData = makeTmpDir('bastidor-lib-fav-empty-');
  try {
    assert.deepEqual(library.loadFavorites(userData), []);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ cache de miniaturas

test('cache de miniaturas: grava e lê de volta a mesma dataURL', () => {
  const userData = makeTmpDir('bastidor-lib-thumb-');
  try {
    const filePath = '/biblioteca/flores/rosa.dst';
    const mtime = 1700000000000;
    const dataURL = 'data:image/png;base64,' + Buffer.from('imagem-fake').toString('base64');

    assert.equal(library.readCachedThumb(userData, filePath, mtime), null);
    library.writeCachedThumb(userData, filePath, mtime, dataURL);
    assert.equal(library.readCachedThumb(userData, filePath, mtime), dataURL);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('cache de miniaturas: invalida por mtime (mtime diferente é cache miss) e remove versões antigas', () => {
  const userData = makeTmpDir('bastidor-lib-thumb-mtime-');
  try {
    const filePath = '/biblioteca/flores/rosa.dst';
    const dataURL1 = 'data:image/png;base64,' + Buffer.from('v1').toString('base64');
    const dataURL2 = 'data:image/png;base64,' + Buffer.from('v2').toString('base64');

    library.writeCachedThumb(userData, filePath, 1000, dataURL1);
    assert.equal(library.readCachedThumb(userData, filePath, 1000), dataURL1);

    // Arquivo original mudou (novo mtime): cache antigo não deve responder por ele...
    assert.equal(library.readCachedThumb(userData, filePath, 2000), null);

    library.writeCachedThumb(userData, filePath, 2000, dataURL2);
    assert.equal(library.readCachedThumb(userData, filePath, 2000), dataURL2);

    // ...e a versão antiga (mtime 1000) deve ter sido removida do disco (sem acumular lixo).
    assert.equal(library.readCachedThumb(userData, filePath, 1000), null);
    const remaining = fs.readdirSync(library.thumbsDir(userData));
    assert.equal(remaining.length, 1);
    assert.ok(remaining[0].includes('2000'));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('cache de miniaturas: arquivos diferentes não colidem (hashes distintos)', () => {
  const userData = makeTmpDir('bastidor-lib-thumb-distinct-');
  try {
    const dataURLA = 'data:image/png;base64,' + Buffer.from('a').toString('base64');
    const dataURLB = 'data:image/png;base64,' + Buffer.from('b').toString('base64');
    library.writeCachedThumb(userData, '/lib/a.dst', 1000, dataURLA);
    library.writeCachedThumb(userData, '/lib/b.dst', 1000, dataURLB);
    assert.equal(library.readCachedThumb(userData, '/lib/a.dst', 1000), dataURLA);
    assert.equal(library.readCachedThumb(userData, '/lib/b.dst', 1000), dataURLB);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ índice persistente (issue #35)

test('loadIndexFile: sem arquivo ainda devolve índice vazio (não lança)', () => {
  const userData = makeTmpDir('bastidor-lib-index-empty-');
  try {
    assert.deepEqual(library.loadIndexFile(userData), { version: 1, entries: {} });
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('saveIndexFile/loadIndexFile: grava e relê o mesmo conteúdo', () => {
  const userData = makeTmpDir('bastidor-lib-index-roundtrip-');
  try {
    const data = { version: 1, entries: { '/lib/a.dst': { mtime: 1000, ok: true, wMm: 10, hMm: 20, stitches: 300 } } };
    library.saveIndexFile(userData, data);
    assert.deepEqual(library.loadIndexFile(userData), data);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('loadIndexFile: arquivo corrompido é tratado como índice vazio (não lança)', () => {
  const userData = makeTmpDir('bastidor-lib-index-corrupt-');
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(library.indexFilePath(userData), '{ não é json');
    assert.deepEqual(library.loadIndexFile(userData), { version: 1, entries: {} });
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('isEntryFresh: só é fresca se existir e o mtime bater exatamente', () => {
  assert.equal(library.isEntryFresh({ mtime: 1000 }, 1000), true);
  assert.equal(library.isEntryFresh({ mtime: 1000 }, 2000), false);
  assert.equal(library.isEntryFresh(undefined, 1000), false);
  assert.equal(library.isEntryFresh(null, 1000), false);
});

test('summarizeDesignFile: lê matriz real e devolve largura/altura/pontos (mesmos números do pystitch)', () => {
  const filePath = path.join(__dirname, 'fixtures', 'rosacea.jef');
  const summary = library.summarizeDesignFile(filePath, { trimAt: 3 });
  // Fixture conferida em tests/core.test.js: 2253 pontos, bounds ~[-495,-495,495,495] (0,1mm) => 99x99mm.
  assert.deepEqual(summary, { ok: true, wMm: 99, hMm: 99, stitches: 2253 });
});

test('summarizeDesignFile: arquivo inexistente ou corrompido devolve {ok:false} (não lança)', () => {
  assert.equal(library.summarizeDesignFile('/caminho/inexistente.dst').ok, false);
  const userData = makeTmpDir('bastidor-lib-summarize-corrupt-');
  try {
    // .hus: formato com validação de tamanho no cabeçalho, lança em texto
    // aleatório (outros formatos, ex. .dst, apenas leem um design vazio).
    const bad = path.join(userData, 'quebrado.hus');
    fs.writeFileSync(bad, 'não é uma matriz de bordado de verdade');
    assert.equal(library.summarizeDesignFile(bad).ok, false);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('indexBatch: espia arquivos novos, persiste no índice e devolve o resumo', () => {
  const userData = makeTmpDir('bastidor-lib-indexbatch-new-');
  try {
    const filePath = path.join(__dirname, 'fixtures', 'rosacea.jef');
    const mtime = 12345;
    const indexData = library.loadIndexFile(userData);
    const results = library.indexBatch(indexData, userData, [{ path: filePath, mtime }], { trimAt: 3 });

    assert.equal(results.length, 1);
    assert.deepEqual(results[0], { path: filePath, fromCache: false, ok: true, wMm: 99, hMm: 99, stitches: 2253 });

    // persistiu: uma nova instância carregada do disco já vê a entrada fresca
    const reloaded = library.loadIndexFile(userData);
    assert.equal(library.isEntryFresh(reloaded.entries[path.resolve(filePath)], mtime), true);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('indexBatch: entrada fresca não é reaberta/reparseada (mtime igual reaproveita o índice)', () => {
  const userData = makeTmpDir('bastidor-lib-indexbatch-fresh-');
  try {
    // Caminho que não existe de verdade: se indexBatch tentasse reabrir, lançaria
    // dentro de summarizeDesignFile (capturado) e devolveria ok:false — o teste
    // prova que a entrada fresca é servida do índice, sem tocar no arquivo.
    const filePath = '/biblioteca/nao-existe-de-verdade.dst';
    const mtime = 5000;
    const indexData = { version: 1, entries: { [path.resolve(filePath)]: { mtime, ok: true, wMm: 40, hMm: 50, stitches: 900 } } };

    const results = library.indexBatch(indexData, userData, [{ path: filePath, mtime }], {});
    assert.deepEqual(results, [{ path: filePath, fromCache: true, ok: true, wMm: 40, hMm: 50, stitches: 900 }]);

    // nada mudou: como não houve entrada "dirty", o índice não precisou ser regravado
    assert.equal(fs.existsSync(library.indexFilePath(userData)), false);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('indexBatch: mtime diferente invalida a entrada e reindexação (arquivo "mudou")', () => {
  const userData = makeTmpDir('bastidor-lib-indexbatch-stale-');
  try {
    const filePath = path.join(__dirname, 'fixtures', 'rosacea.jef');
    const staleEntry = { mtime: 1, ok: true, wMm: 1, hMm: 1, stitches: 1 }; // valores claramente antigos/errados
    const indexData = { version: 1, entries: { [path.resolve(filePath)]: staleEntry } };

    const results = library.indexBatch(indexData, userData, [{ path: filePath, mtime: 2 }], { trimAt: 3 });
    assert.equal(results[0].fromCache, false);
    assert.deepEqual(results[0], { path: filePath, fromCache: false, ok: true, wMm: 99, hMm: 99, stitches: 2253 });
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('indexBatch: arquivo corrompido não lança, e a falha também fica cacheada (não tenta de novo com o mesmo mtime)', () => {
  const userData = makeTmpDir('bastidor-lib-indexbatch-error-');
  try {
    const bad = path.join(userData, 'quebrado.hus'); // .hus valida tamanho no cabeçalho e lança em texto aleatório
    fs.writeFileSync(bad, 'lixo');
    const mtime = fs.statSync(bad).mtimeMs;

    const indexData = library.loadIndexFile(userData);
    const results = library.indexBatch(indexData, userData, [{ path: bad, mtime }], {});
    assert.equal(results[0].ok, false);

    // remove o arquivo: se a 2ª chamada tentasse reabrir, lançaria ENOENT
    // (capturado por summarizeDesignFile) — mas como o mtime bate, nem chega a tentar.
    fs.unlinkSync(bad);
    const again = library.indexBatch(indexData, userData, [{ path: bad, mtime }], {});
    assert.deepEqual(again, [{ path: bad, fromCache: true, ok: false }]);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('indexItemsInto: núcleo sem gravação — muta o índice em memória mas não escreve no disco', () => {
  const userData = makeTmpDir('bastidor-lib-indexitemsinto-');
  try {
    const filePath = path.join(__dirname, 'fixtures', 'rosacea.jef');
    const indexData = library.loadIndexFile(userData);
    const { results, dirty } = library.indexItemsInto(indexData, [{ path: filePath, mtime: 1 }], { trimAt: 3 });

    assert.equal(dirty, true);
    assert.equal(results[0].stitches, 2253);
    assert.equal(indexData.entries[path.resolve(filePath)].stitches, 2253); // mutou em memória
    assert.equal(fs.existsSync(library.indexFilePath(userData)), false); // mas não gravou no disco

    // permite ao chamador fatiar um lote grande e gravar só uma vez ao final
    // (é isso que a fatia por setImmediate do processo principal explora)
    library.saveIndexFile(userData, indexData);
    assert.equal(library.loadIndexFile(userData).entries[path.resolve(filePath)].stitches, 2253);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('indexBatch: lote misto (fresco + novo) só reindexa o que faltava', () => {
  const userData = makeTmpDir('bastidor-lib-indexbatch-mixed-');
  try {
    const real = path.join(__dirname, 'fixtures', 'rosacea.jef');
    const fake = '/biblioteca/outra-inexistente.dst';
    const indexData = { version: 1, entries: { [path.resolve(fake)]: { mtime: 7, ok: true, wMm: 5, hMm: 6, stitches: 7 } } };

    const results = library.indexBatch(
      indexData,
      userData,
      [
        { path: fake, mtime: 7 }, // fresco
        { path: real, mtime: 42 }, // precisa indexar
      ],
      { trimAt: 3 }
    );
    assert.equal(results[0].fromCache, true);
    assert.equal(results[1].fromCache, false);
    assert.equal(results[1].stitches, 2253);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ teto do cache de miniaturas em disco (issue #35)

function writeFakeThumb(userData, filePath, mtime, sizeBytes) {
  const dataURL = 'data:image/png;base64,' + Buffer.alloc(sizeBytes, 65).toString('base64');
  return library.writeCachedThumb(userData, filePath, mtime, dataURL, 10 * 1024 * 1024); // teto bem alto: não evict nesta escrita
}

// O manifesto de acesso usa Date.now() (resolução de 1ms): em disco rápido
// (tmpfs/SSD), duas escritas seguidas podem cair no mesmo milissegundo.
// Os testes de ORDEM de evicção esperam por esse intervalo entre os passos
// que precisam ficar em milissegundos distintos e comparáveis.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('thumbCacheUsageBytes: soma o tamanho de todas as miniaturas gravadas', () => {
  const userData = makeTmpDir('bastidor-lib-usage-');
  try {
    assert.equal(library.thumbCacheUsageBytes(userData), 0);
    writeFakeThumb(userData, '/lib/a.dst', 1, 100);
    writeFakeThumb(userData, '/lib/b.dst', 1, 200);
    assert.equal(library.thumbCacheUsageBytes(userData), 300);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('enforceThumbCacheCap: dentro do teto não evict nada', () => {
  const userData = makeTmpDir('bastidor-lib-cap-under-');
  try {
    writeFakeThumb(userData, '/lib/a.dst', 1, 100);
    const result = library.enforceThumbCacheCap(userData, 1000);
    assert.equal(result.evicted, 0);
    assert.equal(fs.readdirSync(library.thumbsDir(userData)).length, 1);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('enforceThumbCacheCap: acima do teto evict pelo acesso mais antigo primeiro, não pela ordem de criação', async () => {
  const userData = makeTmpDir('bastidor-lib-cap-evict-');
  try {
    // Três miniaturas de 100 bytes cada: teto de 250 só cabe duas. Um
    // pequeno intervalo entre escritas garante marcas de acesso em
    // milissegundos distintos (ver sleep() acima).
    writeFakeThumb(userData, '/lib/a.dst', 1, 100);
    await sleep(5);
    writeFakeThumb(userData, '/lib/b.dst', 1, 100);
    await sleep(5);
    writeFakeThumb(userData, '/lib/c.dst', 1, 100);
    await sleep(5);

    // Sem tocar em nada, a ordem de acesso é a ordem de escrita: a -> b -> c.
    // Lê "a" de novo para tornar seu acesso o mais recente dos três — só "b"
    // (nunca mais tocada) deve ser a mais antiga agora.
    library.readCachedThumb(userData, '/lib/a.dst', 1);

    const result = library.enforceThumbCacheCap(userData, 250);
    assert.equal(result.evicted, 1);
    assert.equal(result.usageBytes, 200);

    // "b" (acesso mais antigo) foi removida; "a" (relida) e "c" (mais recente) sobrevivem.
    assert.equal(library.readCachedThumb(userData, '/lib/b.dst', 1), null);
    assert.notEqual(library.readCachedThumb(userData, '/lib/a.dst', 1), null);
    assert.notEqual(library.readCachedThumb(userData, '/lib/c.dst', 1), null);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('enforceThumbCacheCap: miniatura sem registro de acesso (pré-existente) é evictada primeiro', () => {
  const userData = makeTmpDir('bastidor-lib-cap-noaccess-');
  try {
    // Simula uma miniatura gravada por uma versão anterior do app, sem
    // manifesto de acesso: cria o PNG direto no diretório, sem passar por
    // writeCachedThumb.
    fs.mkdirSync(library.thumbsDir(userData), { recursive: true });
    fs.writeFileSync(path.join(library.thumbsDir(userData), 'legado-sem-acesso.png'), Buffer.alloc(100, 66));

    writeFakeThumb(userData, '/lib/nova.dst', 1, 100);

    const result = library.enforceThumbCacheCap(userData, 150);
    assert.equal(result.evicted, 1);
    const remaining = fs.readdirSync(library.thumbsDir(userData));
    assert.ok(!remaining.includes('legado-sem-acesso.png'));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('writeCachedThumb: aplica o teto (capBytes) automaticamente após gravar', async () => {
  const userData = makeTmpDir('bastidor-lib-cap-onwrite-');
  try {
    const dataURL = (n) => 'data:image/png;base64,' + Buffer.alloc(n, 67).toString('base64');
    library.writeCachedThumb(userData, '/lib/a.dst', 1, dataURL(100), 150);
    await sleep(5);
    library.writeCachedThumb(userData, '/lib/b.dst', 1, dataURL(100), 150); // ultrapassa 150: deve evict "a"

    assert.equal(library.readCachedThumb(userData, '/lib/a.dst', 1), null);
    assert.notEqual(library.readCachedThumb(userData, '/lib/b.dst', 1), null);
    assert.ok(library.thumbCacheUsageBytes(userData) <= 150);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('writeCachedThumb: sem capBytes explícito usa o teto padrão (200 MB) e não evict miniaturas pequenas', () => {
  const userData = makeTmpDir('bastidor-lib-cap-default-');
  try {
    const dataURL = 'data:image/png;base64,' + Buffer.alloc(1000, 68).toString('base64');
    library.writeCachedThumb(userData, '/lib/a.dst', 1, dataURL);
    library.writeCachedThumb(userData, '/lib/b.dst', 1, dataURL);
    assert.equal(fs.readdirSync(library.thumbsDir(userData)).length, 2);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
