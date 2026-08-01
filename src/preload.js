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

  // Lettering (issue #7): texto -> pontos, via núcleo no processo principal.
  letteringListFonts: () => ipcRenderer.invoke('lettering:list-fonts'),
  letteringBuild: (opts) => ipcRenderer.invoke('lettering:build', opts),

  notifyRenderReady: () => ipcRenderer.send('render:ready'),

  onMenu: (cb) => ipcRenderer.on('menu', (e, action) => cb(action)),
  onDesignOpened: (cb) => ipcRenderer.on('design:opened', (e, design) => cb(design)),

  // Gestão de pendrive
  listDrives: () => ipcRenderer.invoke('drives:list'),
  ejectDrive: (mount) => ipcRenderer.invoke('drives:eject', mount),
  libraryInfo: () => ipcRenderer.invoke('drives:library-info'),
  chooseLibraryFolder: () => ipcRenderer.invoke('drives:choose-library'),
  scanDesigns: (dir) => ipcRenderer.invoke('drives:scan', dir),
  peekDesign: (filePath) => ipcRenderer.invoke('drives:peek-design', filePath),
  copyDesigns: (sources, destDir, overwrite) => ipcRenderer.invoke('drives:copy', { sources, destDir, overwrite }),
  deleteFromDrive: (paths, root) => ipcRenderer.invoke('drives:delete', { paths, root }),
  cleanHiddenFiles: (driveRoot) => ipcRenderer.invoke('drives:clean-hidden', driveRoot),
  openFromDrive: (filePath) => ipcRenderer.invoke('drives:open-design', filePath),
  // Digitalização (importar SVG): main escolhe o arquivo e avisa o renderer.
  onSvgPicked: (cb) => ipcRenderer.on('svg:picked', (e, payload) => cb(payload)),
  importSvg: (payload) => ipcRenderer.invoke('svg:import', payload),
  // Digitalizar imagem (PNG -> vetor): o preload roda sandboxed (sem 'fs'
  // direto), então a leitura do arquivo e o processamento (quantize/traceRegions)
  // ficam no processo principal; aqui é só a ponte de IPC, igual ao resto da API.
  openImageDialog: () => ipcRenderer.invoke('dialog:open-image'),
  digitizePosterize: (image, colors) => ipcRenderer.invoke('digitize:posterize', { image, colors }),
  digitizeGenerate: (image, opts) => ipcRenderer.invoke('digitize:generate', { image, opts }),

  // Gestão de biblioteca (issue #17): navegador por pastas com busca,
  // favoritos e cache de miniaturas. Abrir/copiar-para-pendrive/mostrar-no-
  // Finder reaproveitam as pontes já existentes acima (openFromDrive,
  // copyDesigns, showItemInFolder, peekDesign, listDrives).
  libraryRoot: () => ipcRenderer.invoke('library:root'),
  libraryListFolder: (relDir) => ipcRenderer.invoke('library:list-folder', relDir),
  libraryListSubfolders: (relDir) => ipcRenderer.invoke('library:list-subfolders', relDir),
  librarySearch: (query) => ipcRenderer.invoke('library:search', query),
  libraryFavoritesList: () => ipcRenderer.invoke('library:favorites-list'),
  libraryFavoriteToggle: (filePath) => ipcRenderer.invoke('library:favorites-toggle', filePath),
  libraryThumbGet: (filePath, mtime) => ipcRenderer.invoke('library:thumb-get', { filePath, mtime }),
  libraryThumbSave: (filePath, mtime, dataURL) => ipcRenderer.invoke('library:thumb-save', { filePath, mtime, dataURL }),
  libraryRename: (filePath, newName) => ipcRenderer.invoke('library:rename', { filePath, newName }),
  libraryMove: (filePath, destRelDir) => ipcRenderer.invoke('library:move', { filePath, destRelDir }),
  libraryTrash: (filePath) => ipcRenderer.invoke('library:trash', filePath),
  libraryWriteDesign: (relDir, fileName, design) => ipcRenderer.invoke('library:write-design', { relDir, fileName, design }),
});
