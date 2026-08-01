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
const { patternToDesign } = require('../core/design');
const { COMMAND_MASK, STITCH, JUMP, SEQUIN_EJECT } = require('../core/commands');

const MAX_SEARCH_RESULTS = 500; // busca cobre a árvore inteira: teto para não travar com 10-15 mil arquivos
const MAX_SEARCH_DEPTH = 24; // suficiente para qualquer árvore razoável de biblioteca
const FAVORITES_FILE = 'library-favorites.json';
const THUMBS_DIRNAME = 'thumbs';
const INDEX_FILE = 'library-index.json'; // metadados leves (dimensão/pontos) por arquivo, issue #35
const THUMB_ACCESS_FILE = 'thumbs-access.json'; // último acesso por miniatura, para a evicção do teto de disco
const DEFAULT_THUMB_CACHE_CAP_BYTES = 200 * 1024 * 1024; // 200 MB, configurável (settings.library.thumbCacheCapMB)

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

// ------------------------------------------------------------------ índice persistente (issue #35)
//
// Metadados leves (largura/altura/pontos) por arquivo, persistidos entre
// sessões: a primeira varredura de uma pasta grande espia cada arquivo
// (leitura completa do formato, mais pesada) e guarda o resultado aqui; nas
// próximas aberturas — mesmo depois de reiniciar o app — o mtime já bate e
// não é preciso reabrir/reparsear nada ("aberturas seguintes vêm do
// índice"). Complementa o cache de miniaturas (que guarda o PNG já
// desenhado): este índice guarda os números usados pelos filtros de
// dimensão/pontos, que hoje exigem espiar cada item do conjunto visível —
// inviável numa pasta de 10-15 mil arquivos sem esse atalho persistido.

function indexFilePath(userDataDir) {
  return path.join(userDataDir, INDEX_FILE);
}

function loadIndexFile(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexFilePath(userDataDir), 'utf8'));
    if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') {
      return { version: 1, entries: raw.entries };
    }
  } catch {
    // sem índice ainda, ou arquivo corrompido: começa do zero (tolerante, igual aos favoritos)
  }
  return { version: 1, entries: {} };
}

function saveIndexFile(userDataDir, indexData) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(indexFilePath(userDataDir), JSON.stringify(indexData));
  } catch (err) {
    console.error('Falha ao salvar índice da biblioteca:', err);
  }
}

// Uma entrada só serve se o mtime bater: qualquer edição do arquivo original
// (mesmo fora do app) invalida o metadado guardado, do mesmo jeito que o
// cache de miniaturas invalida por mtime no nome do arquivo.
function isEntryFresh(entry, mtime) {
  return !!entry && entry.mtime === mtime;
}

function pickSummary(s) {
  return s.ok ? { ok: true, wMm: s.wMm, hMm: s.hMm, stitches: s.stitches } : { ok: false };
}

// Espiada "pesada": lê e parseia o arquivo inteiro para tirar bounding box e
// contagem de pontos. Mesma lógica de designBounds/countStitches do
// renderer (src/renderer/renderer.js), portada aqui para não precisar
// mandar o design inteiro (todos os pontos) pelo IPC por arquivo — só o
// resumo. Tolerante a erro, como peekDesign (main.js).
function summarizeDesignFile(filePath, opts = {}) {
  try {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const buf = fs.readFileSync(filePath);
    const pattern = io.readBuffer(buf, ext, { trim_at: opts.trimAt });
    const design = patternToDesign(pattern, { path: filePath, format: ext, name: path.basename(filePath) });
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let stitches = 0;
    for (const st of design.stitches) {
      const cmd = st[2] & COMMAND_MASK;
      if (cmd === STITCH || cmd === JUMP || cmd === SEQUIN_EJECT) {
        if (st[0] < minX) minX = st[0];
        if (st[0] > maxX) maxX = st[0];
        if (st[1] < minY) minY = st[1];
        if (st[1] > maxY) maxY = st[1];
      }
      if (cmd === STITCH) stitches++;
    }
    const wMm = isFinite(minX) ? (maxX - minX) / 10 : 0;
    const hMm = isFinite(minY) ? (maxY - minY) / 10 : 0;
    return { ok: true, wMm, hMm, stitches };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Núcleo sem gravação: reaproveita entradas frescas do índice (nenhuma
// leitura de arquivo, só consulta em memória) e espia só as que faltam ou
// mudaram de mtime, mutando indexData.entries em memória. Separado de
// indexBatch (abaixo) para o processo principal poder fatiar um lote grande
// em pedaços menores (setImmediate entre eles, sem travar o loop de
// eventos) e gravar o índice só uma vez ao final do lote inteiro — não uma
// vez por pedaço, o que reescreveria o JSON do índice completo repetidas
// vezes à toa.
function indexItemsInto(indexData, items, opts = {}) {
  let dirty = false;
  const results = items.map((item) => {
    const abs = path.resolve(item.path);
    const cached = indexData.entries[abs];
    if (isEntryFresh(cached, item.mtime)) {
      return { path: item.path, fromCache: true, ...pickSummary(cached) };
    }
    const summary = summarizeDesignFile(abs, opts);
    indexData.entries[abs] = { mtime: item.mtime, ...pickSummary(summary) };
    dirty = true;
    return { path: item.path, fromCache: false, ...pickSummary(summary) };
  });
  return { results, dirty };
}

// Indexa um lote de itens ({path, mtime}) e grava o índice uma vez ao final
// (não a cada arquivo), para não martelar o disco a cada 200 itens.
// indexData é o objeto já carregado (loadIndexFile); quem chama decide se
// mantém em memória entre lotes — main.js faz isso, para não reler o JSON
// do disco a cada lote indexado pela varredura incremental do renderer.
function indexBatch(indexData, userDataDir, items, opts = {}) {
  const { results, dirty } = indexItemsInto(indexData, items, opts);
  if (dirty) saveIndexFile(userDataDir, indexData);
  return results;
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
  const fileName = thumbFileName(filePath, mtime);
  const file = path.join(thumbsDir(userDataDir), fileName);
  try {
    const buf = fs.readFileSync(file);
    touchThumbAccess(userDataDir, fileName);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// Grava a miniatura no cache e remove versões antigas do mesmo arquivo
// (mtime diferente), para não acumular lixo indefinidamente a cada edição do
// original. Em seguida aplica o teto de espaço (capBytes, padrão
// DEFAULT_THUMB_CACHE_CAP_BYTES): ver enforceThumbCacheCap.
function writeCachedThumb(userDataDir, filePath, mtime, dataURL, capBytes) {
  const dir = thumbsDir(userDataDir);
  fs.mkdirSync(dir, { recursive: true });
  const hash = thumbHash(filePath);
  const fileName = thumbFileName(filePath, mtime);
  const base64 = String(dataURL || '').replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(path.join(dir, fileName), Buffer.from(base64, 'base64'));
  touchThumbAccess(userDataDir, fileName);
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
  enforceThumbCacheCap(userDataDir, capBytes);
  return { path: path.join(dir, fileName) };
}

// ------------------------------------------------------------------ teto do cache de miniaturas (issue #35)
//
// O cache em disco (acima) não tinha limite: cresce um PNG por arquivo
// visto, para sempre — ao longo de vários catálogos de 10-15 mil designs,
// isso acumula sem parar. Aplica um teto de espaço (padrão 200 MB,
// configurável em settings.library.thumbCacheCapMB) com evicção pelo
// acesso mais antigo — não pela data de criação, para não descartar
// miniaturas de designs revisitados com frequência. O acesso é rastreado
// num manifesto pequeno ao lado dos PNGs (thumbs-access.json), já que o
// atime do arquivo não é confiável (alguns volumes montam com noatime).
// Complementa o cache em memória (LIB_THUMB_IMG_CAP, renderer.js): aquele
// já limita as Image decodificadas durante a sessão; este limita os PNGs em
// disco entre sessões — tetos independentes, sem duplicar o mesmo controle.

// Fora de thumbsDir (não junto dos PNGs): código existente (e os testes de
// mtime/limpeza abaixo) espera que thumbsDir contenha só miniaturas.
function thumbAccessFilePath(userDataDir) {
  return path.join(userDataDir, THUMB_ACCESS_FILE);
}

function loadThumbAccess(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(thumbAccessFilePath(userDataDir), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveThumbAccess(userDataDir, access) {
  try {
    fs.writeFileSync(thumbAccessFilePath(userDataDir), JSON.stringify(access));
  } catch {
    // melhor esforço: perder o manifesto de acesso só piora a ordem de evicção, não corrompe miniaturas
  }
}

// Marca uma miniatura como acessada agora (leitura ou escrita) — chamado por
// readCachedThumb (hit) e writeCachedThumb, para a evicção achar "a que
// ninguém pede há mais tempo" em vez de "a mais antiga gravada no disco".
function touchThumbAccess(userDataDir, fileName) {
  const access = loadThumbAccess(userDataDir);
  access[fileName] = Date.now();
  saveThumbAccess(userDataDir, access);
}

// Soma o tamanho de todas as miniaturas em disco.
function thumbCacheUsageBytes(userDataDir) {
  const dir = thumbsDir(userDataDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of entries) {
    try {
      total += fs.statSync(path.join(dir, name)).size;
    } catch {
      // arquivo removido entre o readdir e o stat: ignora
    }
  }
  return total;
}

// Remove as miniaturas menos recentemente acessadas até o total cair dentro
// do teto. Arquivos sem entrada no manifesto (ex.: miniaturas gravadas antes
// desta versão existir) são tratados como o acesso mais antigo possível
// (0), e evictados primeiro.
function enforceThumbCacheCap(userDataDir, capBytes) {
  const cap = capBytes > 0 ? capBytes : DEFAULT_THUMB_CACHE_CAP_BYTES;
  const dir = thumbsDir(userDataDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { evicted: 0, usageBytes: 0 };
  }
  const access = loadThumbAccess(userDataDir);
  const files = [];
  let total = 0;
  for (const name of entries) {
    let size;
    try {
      size = fs.statSync(path.join(dir, name)).size;
    } catch {
      continue; // removido entre o readdir e o stat
    }
    total += size;
    files.push({ name, size, lastAccess: access[name] || 0 });
  }
  if (total <= cap) return { evicted: 0, usageBytes: total };

  files.sort((a, b) => a.lastAccess - b.lastAccess); // acesso mais antigo primeiro
  let evicted = 0;
  for (const f of files) {
    if (total <= cap) break;
    try {
      fs.unlinkSync(path.join(dir, f.name));
      delete access[f.name];
      total -= f.size;
      evicted++;
    } catch {
      // melhor esforço
    }
  }
  if (evicted) saveThumbAccess(userDataDir, access);
  return { evicted, usageBytes: total };
}

module.exports = {
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_DEPTH,
  DEFAULT_THUMB_CACHE_CAP_BYTES,
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
  thumbCacheUsageBytes,
  enforceThumbCacheCap,
  indexFilePath,
  loadIndexFile,
  saveIndexFile,
  isEntryFresh,
  summarizeDesignFile,
  indexItemsInto,
  indexBatch,
};
