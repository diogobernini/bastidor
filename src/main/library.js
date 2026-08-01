'use strict';
// Gestão de biblioteca (issue #17): navegação por pastas, busca por nome,
// contenção de caminho, favoritos e cache de miniaturas em disco.
//
// Puro Node (fs, path, crypto), sem dependência do Electron — no mesmo
// espírito de drives.js — para poder ser testado com node:test e diretórios
// temporários, sem precisar subir a aplicação.
//
// Arquitetura (v1, simplificada a partir da issue): em vez de manter um
// índice completo dos 10-15 mil arquivos em memória/disco, a navegação é
// sempre por pasta (listFolderContents só lê a pasta atual, nunca a árvore
// inteira) — é o que resolve o volume grande (requisito 1). A busca por nome
// (requisito 2) atravessa a árvore inteira mas com um teto de resultados
// (MAX_SEARCH_RESULTS), já que é um atalho complementar à navegação, não uma
// listagem completa. Metadados "pesados" (pontos, dimensões) continuam vindo
// de peekDesign (main.js/drives:peek-design), reaproveitado pelo renderer
// item a item, sob demanda — não há parser de cabeçalho leve nos formatos
// atuais, então evitamos aplicá-lo em massa sobre o catálogo inteiro.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const io = require('../core/io');

const MAX_SEARCH_RESULTS = 500; // busca cobre a árvore inteira: teto para não travar com 10-15 mil arquivos
const MAX_SEARCH_DEPTH = 24; // suficiente para qualquer árvore razoável de biblioteca
const FAVORITES_FILE = 'library-favorites.json';
const THUMBS_DIRNAME = 'thumbs';

// ------------------------------------------------------------------ contenção de caminho

// Resolve um caminho relativo (ou absoluto) contra a raiz da biblioteca e
// garante que o resultado não escapa dela — mesma cautela de drives.js
// (deleteWithinRoot/cleanHiddenFiles): nenhuma operação pode sair da pasta
// configurada, nem por ".." nem por um caminho absoluto de fora.
function resolveWithinRoot(root, relOrAbsPath) {
  const base = path.resolve(root);
  const target = path.isAbsolute(relOrAbsPath || '') ? path.resolve(relOrAbsPath) : path.resolve(base, relOrAbsPath || '.');
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error('Caminho fora da raiz da biblioteca');
  }
  return target;
}

function isWithinRoot(root, absPath) {
  const base = path.resolve(root);
  const target = path.resolve(absPath);
  return target === base || target.startsWith(base + path.sep);
}

// ------------------------------------------------------------------ navegação por pastas

// Só as subpastas imediatas de relDir — usado pela árvore lateral, carregada
// sob demanda (clique expande) em vez de varrer tudo de uma vez.
function listSubfolders(root, relDir) {
  const dir = resolveWithinRoot(root, relDir || '.');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) continue; // symlinks (Dirent por lstat) não entram em nenhum ramo
    // Espia se há pelo menos uma subpasta: a árvore só mostra o caret quando
    // expandir levaria a algum lugar (pasta-folha fica sem caret e sem "vazia").
    let hasChildren = false;
    try {
      for (const sub of fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true })) {
        if (!sub.name.startsWith('.') && sub.isDirectory()) {
          hasChildren = true;
          break;
        }
      }
    } catch {
      hasChildren = false;
    }
    out.push({ name: entry.name, relDir: path.join(relDir || '', entry.name), hasChildren });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Conteúdo (subpastas + arquivos de matriz suportados) de uma única pasta,
// não recursivo: é o que a grade mostra quando não há busca ativa.
function listFolderContents(root, relDir) {
  const exts = new Set(io.supportedReadExtensions());
  const dir = resolveWithinRoot(root, relDir || '.');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { folders: [], files: [] };
  }
  const folders = [];
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      folders.push({ name: entry.name, relDir: path.join(relDir || '', entry.name) });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (!exts.has(ext)) continue;
      try {
        const stat = fs.statSync(full);
        files.push({
          path: full,
          relPath: path.join(relDir || '', entry.name),
          name: entry.name,
          ext,
          sizeBytes: stat.size,
          mtime: stat.mtimeMs,
        });
      } catch {
        // arquivo removido/inacessível entre o readdir e o stat
      }
    }
    // symlinks: nem isDirectory() nem isFile() — ficam de fora dos dois ramos.
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { folders, files };
}

// Busca recursiva por nome (contém, sem diferenciar maiúsculas/minúsculas),
// atravessando toda a árvore a partir da raiz. Teto em maxResults: a
// navegação por pastas (listFolderContents) é o caminho principal para
// catálogos grandes; a busca é um atalho complementar.
function searchDesigns(root, query, opts = {}) {
  const exts = new Set(io.supportedReadExtensions());
  const needle = String(query || '').toLowerCase().trim();
  const base = path.resolve(root);
  const maxResults = opts.maxResults || MAX_SEARCH_RESULTS;
  const maxDepth = opts.maxDepth || MAX_SEARCH_DEPTH;
  const out = [];
  let truncated = false;

  function walk(dir, relDir, depth) {
    if (truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, path.join(relDir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (!exts.has(ext)) continue;
        if (needle && !entry.name.toLowerCase().includes(needle)) continue;
        try {
          const stat = fs.statSync(full);
          out.push({
            path: full,
            relPath: path.join(relDir, entry.name),
            name: entry.name,
            ext,
            sizeBytes: stat.size,
            mtime: stat.mtimeMs,
          });
          if (out.length >= maxResults) {
            truncated = true;
            return;
          }
        } catch {
          // ignora arquivo removido/inacessível entre o readdir e o stat
        }
      }
    }
  }

  walk(base, '', 0);
  return { items: out, truncated };
}

// ------------------------------------------------------------------ renomear / mover

// Renomeia mantendo o arquivo na mesma pasta. newName não pode conter
// separador de caminho (senão viraria um "mover" disfarçado, sem passar pela
// validação de destino de moveEntry).
function renameEntry(root, filePath, newName) {
  const base = path.resolve(root);
  const src = path.resolve(filePath);
  if (!isWithinRoot(base, src)) throw new Error('Arquivo fora da raiz da biblioteca');
  if (!newName || /[\\/]/.test(newName)) throw new Error('Nome inválido');
  const dest = path.join(path.dirname(src), newName);
  if (!isWithinRoot(base, dest)) throw new Error('Destino fora da raiz da biblioteca');
  if (path.resolve(dest) === src) return { path: src }; // nome igual: nada a fazer
  if (fs.existsSync(dest)) throw new Error('Já existe um arquivo com esse nome');
  fs.renameSync(src, dest);
  return { path: dest };
}

// Move para outra subpasta da biblioteca (o nome do arquivo não muda).
function moveEntry(root, filePath, destRelDir) {
  const base = path.resolve(root);
  const src = path.resolve(filePath);
  if (!isWithinRoot(base, src)) throw new Error('Arquivo fora da raiz da biblioteca');
  const destDir = resolveWithinRoot(base, destRelDir || '.');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(src));
  if (path.resolve(dest) === src) return { path: src }; // já está lá
  if (fs.existsSync(dest)) throw new Error('Já existe um arquivo com esse nome na pasta de destino');
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest); // volumes diferentes: rename não serve, copia e remove
    fs.unlinkSync(src);
  }
  return { path: dest };
}

// ------------------------------------------------------------------ favoritos

function favoritesFilePath(userDataDir) {
  return path.join(userDataDir, FAVORITES_FILE);
}

function loadFavorites(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(favoritesFilePath(userDataDir), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveFavorites(userDataDir, list) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(favoritesFilePath(userDataDir), JSON.stringify(list, null, 2));
}

// Alterna o favorito de um caminho (absoluto) e devolve a lista atualizada.
function toggleFavorite(userDataDir, filePath) {
  const abs = path.resolve(filePath);
  const list = loadFavorites(userDataDir);
  const idx = list.indexOf(abs);
  if (idx === -1) list.push(abs);
  else list.splice(idx, 1);
  saveFavorites(userDataDir, list);
  return list;
}

// ------------------------------------------------------------------ cache de miniaturas

function thumbsDir(userDataDir) {
  return path.join(userDataDir, THUMBS_DIRNAME);
}

// Hash estável do caminho absoluto: identifica o arquivo independente do
// mtime (usado para localizar/limpar versões antigas da mesma miniatura).
function thumbHash(filePath) {
  return crypto.createHash('sha1').update(path.resolve(filePath)).digest('hex');
}

// mtime no nome do arquivo de cache: uma mudança no arquivo de origem gera um
// nome novo, invalidando o cache automaticamente, sem precisar de um índice
// à parte para checar "está desatualizado?".
function thumbFileName(filePath, mtime) {
  return `${thumbHash(filePath)}-${Math.round(mtime)}.png`;
}

function readCachedThumb(userDataDir, filePath, mtime) {
  const file = path.join(thumbsDir(userDataDir), thumbFileName(filePath, mtime));
  try {
    const buf = fs.readFileSync(file);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// Grava a miniatura no cache e remove versões antigas do mesmo arquivo
// (mtime diferente), para não acumular lixo indefinidamente a cada edição do
// original.
function writeCachedThumb(userDataDir, filePath, mtime, dataURL) {
  const dir = thumbsDir(userDataDir);
  fs.mkdirSync(dir, { recursive: true });
  const hash = thumbHash(filePath);
  const fileName = thumbFileName(filePath, mtime);
  const base64 = String(dataURL || '').replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(path.join(dir, fileName), Buffer.from(base64, 'base64'));
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (name.startsWith(hash + '-') && name !== fileName) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        // melhor esforço: um arquivo de cache órfão não é grave
      }
    }
  }
  return { path: path.join(dir, fileName) };
}

module.exports = {
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_DEPTH,
  resolveWithinRoot,
  isWithinRoot,
  listSubfolders,
  listFolderContents,
  searchDesigns,
  renameEntry,
  moveEntry,
  loadFavorites,
  saveFavorites,
  toggleFavorite,
  thumbsDir,
  thumbHash,
  thumbFileName,
  readCachedThumb,
  writeCachedThumb,
};
