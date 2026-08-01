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
