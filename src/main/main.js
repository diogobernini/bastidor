'use strict';
// Processo principal do Bastidor: janela, menu, IPC, arquivos e preferências.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const io = require('../core/io');
const { patternToDesign, designToPattern } = require('../core/design');
const digitize = require('../core/digitize');
const { SettingsStore, HOOP_PRESETS } = require('./settings');
const { STRINGS, resolveLang, makeT } = require('../i18n');
const drives = require('./drives');

let win = null;
let settings = null;
let pendingOpenPath = null; // arquivo aberto via Finder/associação antes da janela existir

// Flags de automação (autoteste): --open=arquivo --screenshot=saida.png --dialog=settings --lang=en
const argOpen = getArgValue('--open');
const argScreenshot = getArgValue('--screenshot');
const argDialog = getArgValue('--dialog');
const argLang = getArgValue('--lang');
// --fake-drive=pasta: apresenta uma pasta comum como pendrive "FAKE" (telas/testes sem hardware).
const argFakeDrive = getArgValue('--fake-drive');

function currentLang() {
  if (argLang) return resolveLang(argLang, 'en');
  const pref = settings ? settings.get().language : 'auto';
  return resolveLang(pref, app.getLocale());
}

function t(key, vars) {
  return makeT(currentLang())(key, vars);
}

function getArgValue(name) {
  for (const arg of process.argv) {
    if (arg.startsWith(name + '=')) return arg.slice(name.length + 1);
  }
  return null;
}

function firstFileArg() {
  // No Windows/Linux, abrir "com o Bastidor" passa o caminho como argumento.
  for (const arg of process.argv.slice(1)) {
    if (arg.startsWith('-')) continue;
    const ext = io.extOf(arg);
    if (io.supportedReadExtensions().includes(ext) && fs.existsSync(arg)) return arg;
  }
  return null;
}

function readDesignFromPath(filePath, opts = {}) {
  filePath = path.resolve(filePath);
  const ext = io.extOf(filePath);
  const buf = fs.readFileSync(filePath);
  const readSettings = { trim_at: settings.get().write.trimAtJumps };
  const pattern = io.readBuffer(buf, ext, readSettings);
  if (!opts.silent) settings.addRecent(filePath);
  rebuildMenu();
  return patternToDesign(pattern, {
    path: filePath,
    format: ext,
    name: path.basename(filePath),
  });
}

// Leitura "de espiada" para miniatura/contagem de pontos no gestor de pendrive:
// não entra em recentes nem reconstrói o menu, e nunca lança (tolerante a
// matriz corrompida ou formato inesperado na pasta).
function peekDesign(filePath) {
  try {
    const ext = io.extOf(filePath);
    const buf = fs.readFileSync(filePath);
    const pattern = io.readBuffer(buf, ext, { trim_at: settings.get().write.trimAtJumps });
    return { ok: true, design: patternToDesign(pattern, { path: filePath, format: ext, name: path.basename(filePath) }) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function writeSettingsFromPrefs() {
  const w = settings.get().write;
  const s = {
    tie_on: !!w.tieOn,
    tie_off: !!w.tieOff,
    trim_at: w.trimAtJumps,
  };
  if (w.limitStitchLength && w.maxStitchMm > 0) {
    s.max_stitch = Math.round(w.maxStitchMm * 10);
    s.max_jump = Math.round(w.maxStitchMm * 10);
  }
  return s;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    title: 'Bastidor',
    backgroundColor: '#101014',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ------------------------------------------------------------------ IPC

function setupIpc() {
  ipcMain.handle('app:launch-options', () => ({
    openPath: argOpen || pendingOpenPath || firstFileArg(),
    screenshotMode: !!argScreenshot,
    dialog: argDialog,
    hoopPresets: HOOP_PRESETS,
    version: app.getVersion(),
    lang: currentLang(),
    strings: STRINGS,
    platform: process.platform,
  }));

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (e, patch) => {
    const data = settings.set(patch);
    rebuildMenu(); // idioma ou recentes podem ter mudado
    return { settings: data, lang: currentLang() };
  });

  ipcMain.handle('recent:list', () => settings.get().recent.filter((p) => fs.existsSync(p)));
  ipcMain.handle('recent:clear', () => {
    settings.clearRecent();
    rebuildMenu();
    return [];
  });

  ipcMain.handle('dialog:open', async () => {
    const exts = io.supportedReadExtensions();
    const result = await dialog.showOpenDialog(win, {
      title: t('dlg.openTitle'),
      properties: ['openFile'],
      filters: [
        { name: t('dlg.filterAll'), extensions: exts },
        { name: 'Singer XXX', extensions: ['xxx'] },
        { name: 'Tajima DST', extensions: ['dst'] },
        { name: 'Brother PES/PEC', extensions: ['pes', 'pec'] },
        { name: 'Janome JEF', extensions: ['jef'] },
        { name: 'Melco EXP', extensions: ['exp'] },
        { name: t('dlg.filterAny'), extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return readDesignFromPath(result.filePaths[0]);
  });

  ipcMain.handle('design:read', (e, filePath) => readDesignFromPath(filePath));

  ipcMain.handle('dialog:save', async (e, { defaultName }) => {
    const result = await dialog.showSaveDialog(win, {
      title: t('dlg.saveTitle'),
      defaultPath: defaultName,
      filters: [
        { name: 'Singer XXX', extensions: ['xxx'] },
        { name: 'Tajima DST', extensions: ['dst'] },
        { name: 'Brother PES', extensions: ['pes'] },
        { name: 'Brother PEC', extensions: ['pec'] },
        { name: 'Janome JEF', extensions: ['jef'] },
        { name: 'Melco EXP', extensions: ['exp'] },
        { name: 'SVG', extensions: ['svg'] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  ipcMain.handle('dialog:export-png', async (e, { defaultName }) => {
    const result = await dialog.showSaveDialog(win, {
      title: t('dlg.exportPngTitle'),
      defaultPath: defaultName,
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  ipcMain.handle('design:write', (e, { filePath, design }) => {
    const ext = io.extOf(filePath);
    const pattern = designToPattern(design);
    if (!pattern.getMetadata('name')) {
      pattern.metadata('name', path.basename(filePath, path.extname(filePath)));
    }
    const buf = io.writeBuffer(pattern, ext, writeSettingsFromPrefs());
    fs.writeFileSync(filePath, buf);
    settings.addRecent(filePath);
    rebuildMenu();
    return { path: filePath, bytes: buf.length, format: ext };
  });

  ipcMain.handle('png:write', (e, { filePath, dataURL }) => {
    const base64 = dataURL.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return { path: filePath };
  });

  ipcMain.handle('shell:show-item', (e, filePath) => {
    shell.showItemInFolder(filePath);
  });

  // -------------------------------------------------------- gestão de pendrive
  ipcMain.handle('drives:list', () => drives.listRemovableDrives({ fakeDrivePath: argFakeDrive }));

  ipcMain.handle('drives:eject', (e, mount) => {
    if (argFakeDrive && path.resolve(mount) === path.resolve(argFakeDrive)) return { simulated: true };
    drives.eject(mount);
    return { simulated: false };
  });

  ipcMain.handle('drives:library-info', () => {
    const libPath = settings.get().library.path;
    drives.ensureDir(libPath);
    return { path: libPath };
  });

  ipcMain.handle('drives:choose-library', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: t('drv.chooseLibraryTitle'),
      defaultPath: settings.get().library.path,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const chosen = result.filePaths[0];
    settings.set({ library: { path: chosen } });
    return chosen;
  });

  ipcMain.handle('drives:scan', (e, dir) => drives.scanDesigns(dir));
  ipcMain.handle('drives:peek-design', (e, filePath) => peekDesign(filePath));
  ipcMain.handle('drives:copy', (e, { sources, destDir, overwrite }) => drives.copyFiles(sources, destDir, { overwrite }));
  ipcMain.handle('drives:delete', (e, { paths, root }) => drives.deleteWithinRoot(paths, root));
  ipcMain.handle('drives:clean-hidden', (e, driveRoot) => drives.cleanHiddenFiles(driveRoot));
  ipcMain.handle('drives:open-design', (e, filePath) => openPathIntoRenderer(filePath));

  // Digitalização: gera o Pattern no núcleo e publica pelo mesmo canal de
  // "design:opened" usado pela abertura normal de arquivos.
  ipcMain.handle('svg:import', (e, { text, opts, name, path: svgPath }) => {
    const pattern = digitize.importSvg(text, opts || {});
    const design = patternToDesign(pattern, {
      name: name || 'import.svg',
      path: svgPath || null,
      format: 'svg',
    });
    sendToRenderer('design:opened', design);
    return { ok: true, stitches: pattern.countStitches() };
  });

  // Sinal do renderer de que terminou de desenhar (usado no modo screenshot).
  ipcMain.on('render:ready', async () => {
    if (!argScreenshot || !win) return;
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(argScreenshot, image.toPNG());
        console.log('screenshot gravado em', argScreenshot);
      } catch (err) {
        console.error('falha no screenshot:', err);
      }
      app.quit();
    }, 600);
  });
}

// ------------------------------------------------------------------ Menu

function sendToRenderer(channel, payload) {
  if (win) win.webContents.send(channel, payload);
}

function buildMenuTemplate() {
  const isMac = process.platform === 'darwin';
  const recents = settings ? settings.get().recent.filter((p) => fs.existsSync(p)) : [];

  const recentItems = recents.length
    ? [
        ...recents.map((p) => ({
          label: path.basename(p),
          sublabel: isMac ? undefined : p,
          click: () => openPathIntoRenderer(p),
        })),
        { type: 'separator' },
        { label: t('menu.clearRecent'), click: () => {
            settings.clearRecent();
            rebuildMenu();
          } },
      ]
    : [{ label: t('menu.noRecent'), enabled: false }];

  return [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: t('menu.about') },
              { type: 'separator' },
              {
                label: t('menu.settings'),
                accelerator: 'CmdOrCtrl+,',
                click: () => sendToRenderer('menu', 'settings'),
              },
              { type: 'separator' },
              { role: 'hide', label: t('menu.hide') },
              { role: 'hideOthers', label: t('menu.hideOthers') },
              { role: 'unhide', label: t('menu.unhide') },
              { type: 'separator' },
              { role: 'quit', label: t('menu.quit') },
            ],
          },
        ]
      : []),
    {
      label: t('menu.file'),
      submenu: [
        {
          label: t('menu.open'),
          accelerator: 'CmdOrCtrl+O',
          click: () => sendToRenderer('menu', 'open'),
        },
        { label: t('menu.openRecent'), submenu: recentItems },
        {
          label: t('menu.importSvg'),
          click: () => importSvgFlow(),
        },
        { type: 'separator' },
        {
          label: t('menu.saveAs'),
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendToRenderer('menu', 'save-as'),
        },
        {
          label: t('menu.exportPng'),
          accelerator: 'CmdOrCtrl+E',
          click: () => sendToRenderer('menu', 'export-png'),
        },
        ...(!isMac
          ? [
              { type: 'separator' },
              {
                label: t('menu.settings'),
                accelerator: 'CmdOrCtrl+,',
                click: () => sendToRenderer('menu', 'settings'),
              },
              { type: 'separator' },
              { role: 'quit', label: t('menu.exit') },
            ]
          : []),
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        {
          label: t('menu.undo'),
          accelerator: 'CmdOrCtrl+Z',
          click: () => sendToRenderer('menu', 'undo'),
        },
        { type: 'separator' },
        { label: t('menu.center'), click: () => sendToRenderer('menu', 'center') },
        { label: t('menu.resize'), accelerator: 'CmdOrCtrl+R', click: () => sendToRenderer('menu', 'scale') },
        { label: t('menu.rotateCw'), click: () => sendToRenderer('menu', 'rotate-cw') },
        { label: t('menu.rotateCcw'), click: () => sendToRenderer('menu', 'rotate-ccw') },
        { label: t('menu.flipH'), click: () => sendToRenderer('menu', 'flip-h') },
        { label: t('menu.flipV'), click: () => sendToRenderer('menu', 'flip-v') },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.fit'), accelerator: 'CmdOrCtrl+0', click: () => sendToRenderer('menu', 'fit') },
        { label: t('menu.zoomIn'), accelerator: 'CmdOrCtrl+=', click: () => sendToRenderer('menu', 'zoom-in') },
        { label: t('menu.zoomOut'), accelerator: 'CmdOrCtrl+-', click: () => sendToRenderer('menu', 'zoom-out') },
        { type: 'separator' },
        { label: t('menu.grid'), click: () => sendToRenderer('menu', 'toggle-grid') },
        { label: t('menu.hoop'), click: () => sendToRenderer('menu', 'toggle-hoop') },
        { label: t('menu.jumps'), click: () => sendToRenderer('menu', 'toggle-jumps') },
        { type: 'separator' },
        ...(process.env.BASTIDOR_DEV
          ? [{ role: 'toggleDevTools', label: t('menu.devtools') }]
          : []),
        { role: 'togglefullscreen', label: t('menu.fullscreen') },
      ],
    },
    {
      label: t('menu.sim'),
      submenu: [
        { label: t('menu.simToggle'), click: () => sendToRenderer('menu', 'sim-toggle') },
        { label: t('menu.simReset'), click: () => sendToRenderer('menu', 'sim-reset') },
      ],
    },
    {
      label: t('menu.window'),
      submenu: [
        { role: 'minimize', label: t('menu.minimize') },
        { role: 'zoom', label: t('menu.zoom') },
        ...(isMac ? [{ role: 'front', label: t('menu.front') }] : [{ role: 'close', label: t('menu.close') }]),
      ],
    },
    {
      label: t('menu.help'),
      submenu: [
        {
          label: t('menu.formats'),
          click: () => sendToRenderer('menu', 'formats'),
        },
      ],
    },
  ];
}

function rebuildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

function openPathIntoRenderer(filePath) {
  try {
    const design = readDesignFromPath(filePath);
    sendToRenderer('design:opened', design);
  } catch (err) {
    dialog.showErrorBox(t('dlg.openError'), `${filePath}\n\n${err.message}`);
  }
}

// Escolhe o arquivo SVG (diálogo nativo) e manda o texto pro renderer, que
// mostra o dialog com os parâmetros de digitalização antes de importar.
async function importSvgFlow() {
  if (!win) return;
  const result = await dialog.showOpenDialog(win, {
    title: t('dlg.importSvgTitle'),
    properties: ['openFile'],
    filters: [
      { name: t('dlg.filterSvg'), extensions: ['svg'] },
      { name: t('dlg.filterAny'), extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  const filePath = result.filePaths[0];
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    sendToRenderer('svg:picked', { path: filePath, text, name: path.basename(filePath) });
  } catch (err) {
    dialog.showErrorBox(t('dlg.openError'), `${filePath}\n\n${err.message}`);
  }
}

// ------------------------------------------------------------------ App

// Arquivo aberto via Finder (macOS) antes ou depois da janela existir.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (win) openPathIntoRenderer(filePath);
  else pendingOpenPath = filePath;
});

app.whenReady().then(() => {
  settings = new SettingsStore(app.getPath('userData'));
  app.setAboutPanelOptions({
    applicationName: 'Bastidor',
    applicationVersion: app.getVersion(),
    copyright: t('about.copyright'),
  });
  setupIpc();
  rebuildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || argScreenshot) app.quit();
});
