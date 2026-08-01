'use strict';
// Gestão de pendrive: detecção de mídia removível, ejeção, varredura de
// matrizes e limpeza de arquivos ocultos do macOS.
//
// Sem dependência nativa: só child_process (comandos do próprio SO) e fs/path.
// Os parsers das saídas externas (plist do diskutil, JSON do PowerShell, df)
// são funções puras separadas do exec, para poder testá-los com fixtures
// gravadas, sem precisar de hardware ou do SO alvo.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const io = require('../core/io');

const MAX_SCAN_DEPTH = 4; // níveis de subpastas a partir da raiz varrida
const FAKE_DRIVE_NAME = 'FAKE';

// ------------------------------------------------------------------ exec

// Roda um comando externo e devolve stdout, ou null se falhar (sem lançar):
// a detecção de drives deve ser tolerante a comandos ausentes ou volumes
// que somem entre a listagem e a consulta.
function runCommand(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function numberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ------------------------------------------------------------------ plist (darwin)

function skipWs(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

function unescapeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const PLIST_SIMPLE_TAGS = ['string', 'integer', 'real', 'date'];

// Parser mínimo de plist XML (subconjunto usado pelo diskutil): dict, array,
// string, integer, real, date, data, true/false. Devolve [valor, próximoÍndice].
function parsePlistValue(xml, index) {
  const i = skipWs(xml, index);
  if (xml.startsWith('<true/>', i)) return [true, i + 7];
  if (xml.startsWith('<false/>', i)) return [false, i + 8];
  if (xml.startsWith('<dict/>', i)) return [{}, i + 7];
  if (xml.startsWith('<array/>', i)) return [[], i + 8];
  if (xml.startsWith('<dict>', i)) return parsePlistDict(xml, i + 6);
  if (xml.startsWith('<array>', i)) return parsePlistArray(xml, i + 7);
  for (const tag of PLIST_SIMPLE_TAGS) {
    const openTag = `<${tag}>`;
    if (xml.startsWith(openTag, i)) {
      const closeTag = `</${tag}>`;
      const end = xml.indexOf(closeTag, i + openTag.length);
      if (end === -1) throw new Error(`plist malformado: <${tag}> sem fechamento`);
      const raw = unescapeXml(xml.slice(i + openTag.length, end));
      const value = tag === 'integer' ? parseInt(raw, 10) : tag === 'real' ? parseFloat(raw) : raw;
      return [value, end + closeTag.length];
    }
    const selfClose = `<${tag}/>`;
    if (xml.startsWith(selfClose, i)) return [tag === 'string' || tag === 'date' ? '' : 0, i + selfClose.length];
  }
  if (xml.startsWith('<data>', i)) {
    const end = xml.indexOf('</data>', i);
    if (end === -1) throw new Error('plist malformado: <data> sem fechamento');
    return [xml.slice(i + 6, end).trim(), end + 7];
  }
  throw new Error(`plist malformado próximo de: ${xml.slice(i, i + 40)}`);
}

function parsePlistDict(xml, index) {
  const dict = {};
  let i = skipWs(xml, index);
  while (!xml.startsWith('</dict>', i)) {
    if (!xml.startsWith('<key>', i)) {
      throw new Error(`plist malformado: esperava <key> próximo de: ${xml.slice(i, i + 40)}`);
    }
    const keyEnd = xml.indexOf('</key>', i);
    if (keyEnd === -1) throw new Error('plist malformado: <key> sem fechamento');
    const key = unescapeXml(xml.slice(i + 5, keyEnd));
    const afterKey = skipWs(xml, keyEnd + 6);
    const [value, next] = parsePlistValue(xml, afterKey);
    dict[key] = value;
    i = skipWs(xml, next);
  }
  return [dict, i + 7];
}

function parsePlistArray(xml, index) {
  const arr = [];
  let i = skipWs(xml, index);
  while (!xml.startsWith('</array>', i)) {
    const [value, next] = parsePlistValue(xml, i);
    arr.push(value);
    i = skipWs(xml, next);
  }
  return [arr, i + 8];
}

// Ponto de entrada: texto completo de `diskutil info -plist <vol>` -> objeto JS.
function parseDiskutilInfoPlist(xmlText) {
  const plistOpen = xmlText.indexOf('<plist');
  if (plistOpen === -1) throw new Error('plist inválido: tag <plist> não encontrada');
  const tagClose = xmlText.indexOf('>', plistOpen);
  const start = skipWs(xmlText, tagClose + 1);
  const [value] = parsePlistValue(xmlText, start);
  return value;
}

// Aplica o filtro de pendrive (RemovableMedia + Ejectable, ignora o volume do
// sistema) sobre o objeto já parseado do diskutil. Pura: não faz exec.
function diskutilInfoToDrive(info, fallbackMount, dfInfo) {
  if (!info || info.Error || !info.RemovableMedia || !info.Ejectable) return null;
  const mount = info.MountPoint || fallbackMount;
  if (!mount || mount === '/') return null;
  return {
    mount,
    name: info.VolumeName || path.basename(mount),
    filesystem: info.FilesystemName || info.FilesystemType || '',
    capacityBytes: (dfInfo && dfInfo.capacityBytes) || numberOrNull(info.TotalSize) || numberOrNull(info.Size),
    freeBytes: (dfInfo && dfInfo.freeBytes) != null ? dfInfo.freeBytes : numberOrNull(info.FreeSpace),
  };
}

// ------------------------------------------------------------------ df -k

// Uma linha de dados de `df -k <caminho>` (cabeçalho + 1 linha, já que sempre
// consultamos um caminho específico). Devolve o dispositivo (para reconsultar
// no diskutil) e capacidade/livre em bytes (colunas vêm em blocos de 1024).
function parseDfOutput(dfText) {
  const lines = String(dfText || '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const parts = lines[1].trim().split(/\s+/);
  if (parts.length < 4) return null;
  const totalKb = parseInt(parts[1], 10);
  const availKb = parseInt(parts[3], 10);
  if (!Number.isFinite(totalKb) || !Number.isFinite(availKb)) return null;
  return {
    device: parts[0],
    capacityBytes: totalKb * 1024,
    freeBytes: availKb * 1024,
  };
}

// ------------------------------------------------------------------ darwin

function listRemovableDrivesDarwin() {
  let names;
  try {
    names = fs.readdirSync('/Volumes');
  } catch {
    return [];
  }
  const drives = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const drive = darwinVolumeToDrive(path.join('/Volumes', name));
    if (drive) drives.push(drive);
  }
  return drives;
}

// Descreve um volume (ponto de montagem ou qualquer caminho dentro dele) e já
// aplica o filtro de pendrive. Usada tanto na listagem de /Volumes quanto pelo
// pendrive falso (--fake-drive), que aponta para uma pasta qualquer.
function darwinVolumeToDrive(anyPathInVolume) {
  const dfText = runCommand('df', ['-k', anyPathInVolume]);
  const dfInfo = dfText ? parseDfOutput(dfText) : null;
  const infoTarget = (dfInfo && dfInfo.device) || anyPathInVolume;
  const plistText = runCommand('diskutil', ['info', '-plist', infoTarget]);
  if (!plistText) return null;
  let info;
  try {
    info = parseDiskutilInfoPlist(plistText);
  } catch {
    return null;
  }
  return diskutilInfoToDrive(info, anyPathInVolume, dfInfo);
}

// ------------------------------------------------------------------ win32

// Saída de:
//   Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2" |
//     Select-Object DeviceID,VolumeName,Size,FreeSpace,FileSystem | ConvertTo-Json
// DriveType=2 é "Removable Disk" no WMI. Com 1 resultado o ConvertTo-Json do
// PowerShell devolve um objeto solto (não um array) — por isso a normalização.
function parseWin32LogicalDiskJson(jsonText) {
  const trimmed = String(jsonText || '').trim();
  if (!trimmed || trimmed === 'null') return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((row) => row && row.DeviceID)
    .map((row) => ({
      mount: `${row.DeviceID}\\`,
      name: row.VolumeName || row.DeviceID,
      filesystem: row.FileSystem || '',
      capacityBytes: numberOrNull(row.Size),
      freeBytes: numberOrNull(row.FreeSpace),
    }));
}

function listRemovableDrivesWin32() {
  const script =
    'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2" | ' +
    'Select-Object DeviceID,VolumeName,Size,FreeSpace,FileSystem | ConvertTo-Json';
  const jsonText = runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (jsonText === null) return [];
  return parseWin32LogicalDiskJson(jsonText);
}

// ------------------------------------------------------------------ pendrive falso

// --fake-drive=<pasta>: apresenta uma pasta comum como se fosse um pendrive
// chamado "FAKE", para telas e capturas de tela sem precisar de hardware.
// Em darwin tentamos capacidade/livre e filesystem reais (via df/diskutil no
// caminho da própria pasta); em outros SOs ficam null e o rótulo "FAKE".
function fakeDrive(dirPath) {
  const root = path.resolve(dirPath);
  fs.mkdirSync(root, { recursive: true });
  let capacityBytes = null;
  let freeBytes = null;
  let filesystem = FAKE_DRIVE_NAME;
  if (process.platform === 'darwin') {
    const dfText = runCommand('df', ['-k', root]);
    const dfInfo = dfText ? parseDfOutput(dfText) : null;
    if (dfInfo) {
      capacityBytes = dfInfo.capacityBytes;
      freeBytes = dfInfo.freeBytes;
      const plistText = runCommand('diskutil', ['info', '-plist', dfInfo.device]);
      if (plistText) {
        try {
          const info = parseDiskutilInfoPlist(plistText);
          if (info && info.FilesystemName) filesystem = info.FilesystemName;
        } catch {
          // mantém o rótulo FAKE se o plist vier malformado
        }
      }
    }
  }
  return { mount: root, name: FAKE_DRIVE_NAME, filesystem, capacityBytes, freeBytes, fake: true };
}

// ------------------------------------------------------------------ API pública

// opts.fakeDrivePath: quando presente, ignora a detecção real e devolve só o
// pendrive falso (determinístico para telas/capturas, sem depender do que
// estiver plugado na máquina).
function listRemovableDrives(opts = {}) {
  if (opts.fakeDrivePath) return [fakeDrive(opts.fakeDrivePath)];
  if (process.platform === 'darwin') return listRemovableDrivesDarwin();
  if (process.platform === 'win32') return listRemovableDrivesWin32();
  return []; // linux: sem enumeração padronizada de mídia removível (ver README/limitações)
}

// Ejeção segura. darwin: `diskutil eject`. win32: verbo "Eject" do namespace
// de unidades do Shell.Application via PowerShell (mesmo truque usado por
// vários one-liners de administração; sem SDK/driver dedicado).
//
// Limitações documentadas (não testadas em máquina Windows real):
// - InvokeVerb('Eject') não lança exceção nem devolve status: não há como
//   confirmar programaticamente se a ejeção realmente aconteceu.
// - Se houver identificadores abertos (Explorer, outro processo) o verbo pode
//   simplesmente não fazer nada, às vezes com um aviso nativo do Windows.
// - Exige o objeto COM Shell.Application (sessão de desktop interativa).
function eject(mount) {
  if (process.platform === 'darwin') {
    execFileSync('diskutil', ['eject', mount], { stdio: 'ignore' });
    return;
  }
  if (process.platform === 'win32') {
    const drive = mount.replace(/[\\/]+$/, '');
    if (!/^[A-Za-z]:$/.test(drive)) {
      throw new Error(`Caminho de unidade inválido para ejeção: ${mount}`);
    }
    const script = [
      '$sh = New-Object -ComObject Shell.Application',
      '$ns = $sh.NameSpace(17)',
      `$item = $ns.ParseName('${drive}\\')`,
      "if ($null -eq $item) { throw 'drive not found' }",
      "$item.InvokeVerb('Eject')",
    ].join('; ');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
    return;
  }
  throw new Error(`Ejeção não suportada em ${process.platform}`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Varredura recursiva por matrizes suportadas. Profundidade limitada (a pasta
// raiz é profundidade 0) e diretórios/arquivos ocultos são ignorados — o que
// também livra a lista de sobras do tipo "._matriz.dst" (AppleDouble).
function scanDesigns(rootDir) {
  const exts = new Set(io.supportedReadExtensions());
  const out = [];

  function walk(dir, depth) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // pasta inacessível ou removida durante a varredura
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH) walk(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (!exts.has(ext)) continue;
        try {
          const stat = fs.statSync(full);
          out.push({ path: full, name: entry.name, sizeBytes: stat.size, mtime: stat.mtimeMs });
        } catch {
          // arquivo removido/inacessível entre o readdir e o stat
        }
      }
      // links simbólicos: Dirent não marca isDirectory()/isFile() para eles
      // (é baseado em lstat), então já saem de ambos os ramos acima.
    }
  }

  walk(path.resolve(rootDir), 0);
  return out;
}

// Remove somente ._* (AppleDouble) e .DS_Store dentro do drive, recursivo.
// Nunca segue links simbólicos nem sai da raiz (checagem por path.resolve a
// cada entrada) — proteção contra um link malicioso apontando para fora do
// pendrive.
function cleanHiddenFiles(driveRoot) {
  const root = path.resolve(driveRoot);
  let removed = 0;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const resolved = path.resolve(full);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && (entry.name === '.DS_Store' || entry.name.startsWith('._'))) {
        try {
          fs.unlinkSync(full);
          removed++;
        } catch {
          // sem permissão ou já removido: ignora e segue a varredura
        }
      }
    }
  }

  walk(root);
  return removed;
}

// Copia arquivos para destDir (nome original preservado). Sem overwrite,
// conflitos (destino já existe) são reportados como 'conflict' sem copiar —
// o chamador decide se confirma a sobrescrita e chama de novo com overwrite:true.
function copyFiles(sources, destDir, opts = {}) {
  const overwrite = !!opts.overwrite;
  ensureDir(destDir);
  return sources.map((src) => {
    const name = path.basename(src);
    const dest = path.join(destDir, name);
    try {
      if (path.resolve(src) === path.resolve(dest)) {
        return { path: src, dest, name, status: 'skipped-same' };
      }
      if (fs.existsSync(dest) && !overwrite) {
        return { path: src, dest, name, status: 'conflict' };
      }
      fs.copyFileSync(src, dest);
      return { path: src, dest, name, status: 'copied' };
    } catch (err) {
      return { path: src, dest, name, status: 'error', error: err.message };
    }
  });
}

// Apaga arquivos, recusando qualquer caminho que não esteja dentro de `root`
// (mesma cautela de cleanHiddenFiles, para o botão de apagar do pendrive).
function deleteWithinRoot(paths, root) {
  const base = path.resolve(root);
  return paths.map((p) => {
    const resolved = path.resolve(p);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      return { path: p, ok: false, error: 'fora da raiz do pendrive' };
    }
    try {
      fs.unlinkSync(resolved);
      return { path: p, ok: true };
    } catch (err) {
      return { path: p, ok: false, error: err.message };
    }
  });
}

// Formatação binária (1024) com rótulos KB/MB/GB/TB, para os números de
// capacidade/livre do pendrive.
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const decimals = value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[i]}`;
}

module.exports = {
  MAX_SCAN_DEPTH,
  FAKE_DRIVE_NAME,
  listRemovableDrives,
  eject,
  ensureDir,
  scanDesigns,
  cleanHiddenFiles,
  copyFiles,
  deleteWithinRoot,
  formatBytes,
  // exportadas para teste com fixtures (puras, sem exec):
  parseDiskutilInfoPlist,
  diskutilInfoToDrive,
  parseDfOutput,
  parseWin32LogicalDiskJson,
};
