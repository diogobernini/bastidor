'use strict';
// Processo principal do Bastidor: janela, menu, IPC, arquivos e preferências.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const io = require('../core/io');
const { patternToDesign, designToPattern } = require('../core/design');
const { SettingsStore, HOOP_PRESETS } = require('./settings');

let win = null;
let settings = null;
let pendingOpenPath = null; // arquivo aberto via Finder/associação antes da janela existir

// Flags de automação (autoteste): --open=arquivo --screenshot=saida.png --dialog=settings
const argOpen = getArgValue('--open');
const argScreenshot = getArgValue('--screenshot');
const argDialog = getArgValue('--dialog');

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
  }));

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (e, patch) => settings.set(patch));

  ipcMain.handle('recent:list', () => settings.get().recent.filter((p) => fs.existsSync(p)));
  ipcMain.handle('recent:clear', () => {
    settings.clearRecent();
    rebuildMenu();
    return [];
  });

  ipcMain.handle('dialog:open', async () => {
    const exts = io.supportedReadExtensions();
    const result = await dialog.showOpenDialog(win, {
      title: 'Abrir matriz de bordado',
      properties: ['openFile'],
      filters: [
        { name: 'Matrizes de bordado', extensions: exts },
        { name: 'Singer XXX', extensions: ['xxx'] },
        { name: 'Tajima DST', extensions: ['dst'] },
        { name: 'Brother PES/PEC', extensions: ['pes', 'pec'] },
        { name: 'Janome JEF', extensions: ['jef'] },
        { name: 'Melco EXP', extensions: ['exp'] },
        { name: 'Todos os arquivos', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return readDesignFromPath(result.filePaths[0]);
  });

  ipcMain.handle('design:read', (e, filePath) => readDesignFromPath(filePath));

  ipcMain.handle('dialog:save', async (e, { defaultName }) => {
    const result = await dialog.showSaveDialog(win, {
      title: 'Salvar matriz como',
      defaultPath: defaultName,
      filters: [
        { name: 'Singer XXX', extensions: ['xxx'] },
        { name: 'Tajima DST', extensions: ['dst'] },
        { name: 'Melco EXP', extensions: ['exp'] },
        { name: 'SVG (vetor)', extensions: ['svg'] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  ipcMain.handle('dialog:export-png', async (e, { defaultName }) => {
    const result = await dialog.showSaveDialog(win, {
      title: 'Exportar PNG',
      defaultPath: defaultName,
      filters: [{ name: 'Imagem PNG', extensions: ['png'] }],
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
        { label: 'Limpar recentes', click: () => {
            settings.clearRecent();
            rebuildMenu();
          } },
      ]
    : [{ label: 'Nenhum arquivo recente', enabled: false }];

  return [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: 'Sobre o Bastidor' },
              { type: 'separator' },
              {
                label: 'Configurações…',
                accelerator: 'CmdOrCtrl+,',
                click: () => sendToRenderer('menu', 'settings'),
              },
              { type: 'separator' },
              { role: 'hide', label: 'Ocultar Bastidor' },
              { role: 'hideOthers', label: 'Ocultar outros' },
              { role: 'unhide', label: 'Mostrar tudo' },
              { type: 'separator' },
              { role: 'quit', label: 'Encerrar Bastidor' },
            ],
          },
        ]
      : []),
    {
      label: 'Arquivo',
      submenu: [
        {
          label: 'Abrir…',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendToRenderer('menu', 'open'),
        },
        { label: 'Abrir recente', submenu: recentItems },
        { type: 'separator' },
        {
          label: 'Salvar como…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendToRenderer('menu', 'save-as'),
        },
        {
          label: 'Exportar PNG…',
          accelerator: 'CmdOrCtrl+E',
          click: () => sendToRenderer('menu', 'export-png'),
        },
        ...(!isMac
          ? [
              { type: 'separator' },
              {
                label: 'Configurações…',
                accelerator: 'CmdOrCtrl+,',
                click: () => sendToRenderer('menu', 'settings'),
              },
              { type: 'separator' },
              { role: 'quit', label: 'Sair' },
            ]
          : []),
      ],
    },
    {
      label: 'Editar',
      submenu: [
        {
          label: 'Desfazer',
          accelerator: 'CmdOrCtrl+Z',
          click: () => sendToRenderer('menu', 'undo'),
        },
        { type: 'separator' },
        { label: 'Centralizar na origem', click: () => sendToRenderer('menu', 'center') },
        { label: 'Redimensionar…', accelerator: 'CmdOrCtrl+R', click: () => sendToRenderer('menu', 'scale') },
        { label: 'Girar 90° horário', click: () => sendToRenderer('menu', 'rotate-cw') },
        { label: 'Girar 90° anti-horário', click: () => sendToRenderer('menu', 'rotate-ccw') },
        { label: 'Espelhar horizontal', click: () => sendToRenderer('menu', 'flip-h') },
        { label: 'Espelhar vertical', click: () => sendToRenderer('menu', 'flip-v') },
      ],
    },
    {
      label: 'Exibir',
      submenu: [
        { label: 'Ajustar à tela', accelerator: 'CmdOrCtrl+0', click: () => sendToRenderer('menu', 'fit') },
        { label: 'Aproximar', accelerator: 'CmdOrCtrl+=', click: () => sendToRenderer('menu', 'zoom-in') },
        { label: 'Afastar', accelerator: 'CmdOrCtrl+-', click: () => sendToRenderer('menu', 'zoom-out') },
        { type: 'separator' },
        { label: 'Grade', click: () => sendToRenderer('menu', 'toggle-grid') },
        { label: 'Bastidor', click: () => sendToRenderer('menu', 'toggle-hoop') },
        { label: 'Saltos', click: () => sendToRenderer('menu', 'toggle-jumps') },
        { type: 'separator' },
        ...(process.env.BASTIDOR_DEV
          ? [{ role: 'toggleDevTools', label: 'Ferramentas de desenvolvimento' }]
          : []),
        { role: 'togglefullscreen', label: 'Tela cheia' },
      ],
    },
    {
      label: 'Simulação',
      submenu: [
        { label: 'Reproduzir/Pausar', click: () => sendToRenderer('menu', 'sim-toggle') },
        { label: 'Reiniciar', click: () => sendToRenderer('menu', 'sim-reset') },
      ],
    },
    {
      label: 'Janela',
      submenu: [
        { role: 'minimize', label: 'Minimizar' },
        { role: 'zoom', label: 'Zoom' },
        ...(isMac ? [{ role: 'front', label: 'Trazer tudo para frente' }] : [{ role: 'close', label: 'Fechar' }]),
      ],
    },
    {
      label: 'Ajuda',
      submenu: [
        {
          label: 'Formatos suportados',
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
    dialog.showErrorBox('Não foi possível abrir', `${filePath}\n\n${err.message}`);
  }
}

// ------------------------------------------------------------------ App

app.setAboutPanelOptions({
  applicationName: 'Bastidor',
  applicationVersion: app.getVersion(),
  copyright: 'Estúdio de bordado · matrizes Singer XXX, DST, PES, JEF, EXP',
});

// Arquivo aberto via Finder (macOS) antes ou depois da janela existir.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (win) openPathIntoRenderer(filePath);
  else pendingOpenPath = filePath;
});

app.whenReady().then(() => {
  settings = new SettingsStore(app.getPath('userData'));
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
