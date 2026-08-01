'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  launchOptions: () => ipcRenderer.invoke('app:launch-options'),

  // Caminho real de um File solto na janela (drag & drop).
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  listRecent: () => ipcRenderer.invoke('recent:list'),
  clearRecent: () => ipcRenderer.invoke('recent:clear'),

  openDialog: () => ipcRenderer.invoke('dialog:open'),
  readDesign: (filePath) => ipcRenderer.invoke('design:read', filePath),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts),
  exportPngDialog: (opts) => ipcRenderer.invoke('dialog:export-png', opts),
  writeDesign: (filePath, design) => ipcRenderer.invoke('design:write', { filePath, design }),
  writePng: (filePath, dataURL) => ipcRenderer.invoke('png:write', { filePath, dataURL }),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:show-item', filePath),

  notifyRenderReady: () => ipcRenderer.send('render:ready'),

  onMenu: (cb) => ipcRenderer.on('menu', (e, action) => cb(action)),
  onDesignOpened: (cb) => ipcRenderer.on('design:opened', (e, design) => cb(design)),
});
