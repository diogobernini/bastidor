'use strict';
// drives-ui: gestor de pendrive (dlg-drives) - modal de dois painéis
// (biblioteca "simples" <-> pendrive selecionado), com leitura tolerante a
// erro (peekDriveDesign, cacheada por caminho+mtime) e as ações de copiar,
// apagar, ejetar e limpar arquivos ocultos do macOS.
//
// Consome (globais de renderer.js): state, $, toast; I18n.tr/I18n.fmtNum/
// I18n.fmtBytesLocal; RenderCanvas.drawDesignThumbnail/RenderCanvas.countStitches;
// Dialogs.confirmDialog; LruCap.setWithCap (src/core/lru.js, teto do cache de
// peek — issue #28). peekDriveDesign também é usado por LibraryUI (carregado
// depois deste módulo).
window.DrivesUI = (function () {

// --------------------------------------------------------------- gestão de pendrive
//
// Modal de dois painéis (biblioteca <-> pendrive selecionado). Cada arquivo listado
// é só metadado (io principal manda path/nome/tamanho/mtime); a miniatura e a
// contagem de pontos vêm de uma leitura preguiçosa (drives:peek-design), tolerante
// a erro, cacheada por caminho+mtime para não reparsear ao reabrir o modal.

// Teto do cache de peek (state.drives.cache): usado tanto pela gestão de
// pendrive quanto pela grade/hover/filtros da biblioteca, sem limite cresceria
// pelo tamanho do catálogo inteiro numa sessão longa (issue #28, item 3).
const DRIVE_PEEK_CACHE_CAP = 2000;

function driveCacheKey(item) {
  return `${item.path}::${item.mtime}`;
}

// Lê e cacheia (por caminho+mtime) o design de um item da lista. Tolerante a
// erro: nunca rejeita, devolve {ok:false, error} para a UI mostrar um rótulo.
function peekDriveDesign(item) {
  const key = driveCacheKey(item);
  const cached = state.drives.cache.get(key);
  if (cached) return cached;
  const pending = window.api
    .peekDesign(item.path)
    .then((res) => {
      const entry = res && res.ok ? { ok: true, design: res.design } : { ok: false, error: res && res.error };
      state.drives.cache.set(key, entry); // já existe (chave inserida abaixo): só atualiza o valor, não cresce
      return entry;
    })
    .catch((err) => {
      const entry = { ok: false, error: err.message };
      state.drives.cache.set(key, entry);
      return entry;
    });
  LruCap.setWithCap(state.drives.cache, key, pending, DRIVE_PEEK_CACHE_CAP);
  return pending;
}

function drivesSideRoot(side) {
  return side === 'library' ? state.drives.libraryPath : state.drives.selectedMount;
}

function updateDriveActionButtons() {
  const hasLib = state.drives.selection.library.size > 0;
  const hasDrive = state.drives.selection.drive.size > 0;
  $('lib-copy-to-drive').disabled = !hasLib || !state.drives.selectedMount;
  $('drive-copy-to-lib').disabled = !hasDrive;
  $('drive-delete').disabled = !hasDrive;
}

function buildDriveItemRow(item, side) {
  const li = document.createElement('li');
  li.className = 'drive-item';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = state.drives.selection[side].has(item.path);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) state.drives.selection[side].add(item.path);
    else state.drives.selection[side].delete(item.path);
    updateDriveActionButtons();
  });

  const thumb = document.createElement('canvas');
  thumb.className = 'drive-thumb';

  const info = document.createElement('div');
  info.className = 'drive-item-info';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = item.name;
  const meta = document.createElement('div');
  meta.className = 'meta muted';
  meta.textContent = I18n.fmtBytesLocal(item.sizeBytes);
  info.append(name, meta);

  li.append(checkbox, thumb, info);
  li.addEventListener('dblclick', () => openDesignFromDriveManager(item.path));

  Promise.resolve(peekDriveDesign(item)).then((entry) => {
    if (entry.ok) {
      RenderCanvas.drawDesignThumbnail(thumb, entry.design);
      meta.textContent = `${I18n.fmtBytesLocal(item.sizeBytes)} · ${I18n.tr('status.stitches', { n: I18n.fmtNum(RenderCanvas.countStitches(entry.design)) })}`;
    } else {
      meta.textContent = `${I18n.fmtBytesLocal(item.sizeBytes)} · ${I18n.tr('drv.parseError')}`;
    }
  });

  return li;
}

function renderDriveList(listEl, items, side) {
  listEl.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'drive-empty';
    li.textContent = I18n.tr(side === 'library' ? 'drv.emptyLibrary' : 'drv.emptyDrive');
    listEl.appendChild(li);
    return;
  }
  for (const item of items) listEl.appendChild(buildDriveItemRow(item, side));
}

async function refreshLibraryPane() {
  const info = await window.api.libraryInfo();
  state.drives.libraryPath = info.path;
  $('library-path-label').textContent = info.path;
  const items = await window.api.scanDesigns(info.path);
  state.drives.libraryItems = items;
  renderDriveList($('library-list'), items, 'library');
  updateDriveActionButtons();
}

async function refreshDrivePane() {
  const mount = state.drives.selectedMount;
  const drive = state.drives.list.find((d) => d.mount === mount);
  $('drive-eject').disabled = !drive;
  $('drive-clean-hidden').disabled = !drive;
  if (!drive) {
    $('drive-space').textContent = '';
    $('drive-fswarn').hidden = true;
    state.drives.driveItems = [];
    state.drives.selection.drive.clear();
    renderDriveList($('drive-list'), [], 'drive');
    updateDriveActionButtons();
    return;
  }
  $('drive-space').textContent =
    drive.capacityBytes != null
      ? I18n.tr('drv.freeOf', { free: I18n.fmtBytesLocal(drive.freeBytes), total: I18n.fmtBytesLocal(drive.capacityBytes) })
      : I18n.tr('drv.unknownSpace');
  $('drive-fswarn').hidden = /fat/i.test(drive.filesystem || '');
  const items = await window.api.scanDesigns(mount);
  state.drives.driveItems = items;
  for (const p of [...state.drives.selection.drive]) {
    if (!items.some((it) => it.path === p)) state.drives.selection.drive.delete(p);
  }
  renderDriveList($('drive-list'), items, 'drive');
  updateDriveActionButtons();
}

async function refreshDriveSelectList() {
  const list = await window.api.listDrives();
  state.drives.list = list;
  const sel = $('drive-select');
  const prevMount = state.drives.selectedMount;
  sel.innerHTML = '';
  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = I18n.tr('drv.noDrive');
    sel.appendChild(opt);
    sel.disabled = true;
    state.drives.selectedMount = null;
  } else {
    sel.disabled = false;
    for (const d of list) {
      const opt = document.createElement('option');
      opt.value = d.mount;
      opt.textContent = d.name || d.mount;
      sel.appendChild(opt);
    }
    const stillThere = prevMount && list.some((d) => d.mount === prevMount);
    state.drives.selectedMount = stillThere ? prevMount : list[0].mount;
    sel.value = state.drives.selectedMount;
  }
  await refreshDrivePane();
}

async function refreshDriveSide(side) {
  if (side === 'library') await refreshLibraryPane();
  else await refreshDrivePane();
}

async function copySelectedDesigns(fromSide) {
  const toSide = fromSide === 'library' ? 'drive' : 'library';
  const sources = [...state.drives.selection[fromSide]];
  if (!sources.length) return;
  const destDir = drivesSideRoot(toSide);
  if (!destDir) {
    toast(I18n.tr('drv.noDriveSelected'), 'warn');
    return;
  }
  let results = await window.api.copyDesigns(sources, destDir, false);
  const conflicts = results.filter((r) => r.status === 'conflict');
  if (conflicts.length) {
    const ok = await Dialogs.confirmDialog({
      title: I18n.tr('drv.confirmOverwriteTitle'),
      message: I18n.tr('drv.confirmOverwriteMsg', { n: conflicts.length, names: conflicts.map((c) => c.name).join(', ') }),
      okLabel: I18n.tr('drv.confirmOverwriteOk'),
    });
    if (!ok) {
      const copiedCount = results.filter((r) => r.status === 'copied').length;
      toast(I18n.tr('drv.copyPartial', { n: copiedCount }));
      await refreshDriveSide(toSide);
      return;
    }
    results = await window.api.copyDesigns(sources, destDir, true);
  }
  const copiedCount = results.filter((r) => r.status === 'copied').length;
  toast(I18n.tr('drv.copyDone', { n: copiedCount }));
  await refreshDriveSide(toSide);
}

async function deleteSelectedFromDrive() {
  const sources = [...state.drives.selection.drive];
  if (!sources.length) return;
  const ok = await Dialogs.confirmDialog({
    title: I18n.tr('drv.confirmDeleteTitle'),
    message: I18n.tr('drv.confirmDeleteMsg', { n: sources.length }),
    okLabel: I18n.tr('drv.confirmDeleteOk'),
  });
  if (!ok) return;
  const results = await window.api.deleteFromDrive(sources, state.drives.selectedMount);
  const okCount = results.filter((r) => r.ok).length;
  toast(I18n.tr('drv.deleteDone', { n: okCount }));
  await refreshDrivePane();
}

async function ejectSelectedDrive() {
  const mount = state.drives.selectedMount;
  if (!mount) return;
  try {
    await window.api.ejectDrive(mount);
    toast(I18n.tr('drv.ejected'));
    await refreshDriveSelectList();
  } catch (err) {
    toast(I18n.tr('drv.ejectError') + err.message, 'error', 5000);
  }
}

async function cleanHiddenOnDrive() {
  const mount = state.drives.selectedMount;
  if (!mount) return;
  const count = await window.api.cleanHiddenFiles(mount);
  toast(I18n.tr('drv.cleanDone', { n: count }));
  await refreshDrivePane();
}

// Duplo clique num item (biblioteca ou pendrive): mesmo fluxo de abrir usado
// pelo menu Recentes/Finder (main emite design:opened; ver bindMenuAndKeys).
async function openDesignFromDriveManager(filePath) {
  await window.api.openFromDrive(filePath);
}

async function openDrivesDialog() {
  $('drive-clean-hidden').hidden = state.platform !== 'darwin';
  state.drives.selection.library.clear();
  state.drives.selection.drive.clear();
  $('dlg-drives').showModal();
  await Promise.all([refreshLibraryPane(), refreshDriveSelectList()]);
  if (state.drives.refreshTimer) clearInterval(state.drives.refreshTimer);
  state.drives.refreshTimer = setInterval(refreshDriveSelectList, 3000);
}

function closeDrivesDialog() {
  const dlg = $('dlg-drives');
  if (dlg.open) dlg.close();
}

function bindDrivesDialog() {
  $('btn-drives').addEventListener('click', openDrivesDialog);
  $('drives-close').addEventListener('click', closeDrivesDialog);
  $('dlg-drives').addEventListener('close', () => {
    if (state.drives.refreshTimer) {
      clearInterval(state.drives.refreshTimer);
      state.drives.refreshTimer = null;
    }
  });

  $('drive-select').addEventListener('change', async (e) => {
    state.drives.selectedMount = e.target.value || null;
    state.drives.selection.drive.clear();
    await refreshDrivePane();
  });
  $('drive-refresh').addEventListener('click', () => refreshDriveSelectList());
  $('drive-eject').addEventListener('click', ejectSelectedDrive);
  $('drive-clean-hidden').addEventListener('click', cleanHiddenOnDrive);
  $('drive-delete').addEventListener('click', deleteSelectedFromDrive);
  $('lib-copy-to-drive').addEventListener('click', () => copySelectedDesigns('library'));
  $('drive-copy-to-lib').addEventListener('click', () => copySelectedDesigns('drive'));

  $('set-librarypath-choose').addEventListener('click', async () => {
    const chosen = await window.api.chooseLibraryFolder();
    if (!chosen) return;
    state.settings.library = { path: chosen };
    $('set-librarypath').value = chosen;
  });
}

  return {
    driveCacheKey,
    peekDriveDesign,
    drivesSideRoot,
    updateDriveActionButtons,
    buildDriveItemRow,
    renderDriveList,
    refreshLibraryPane,
    refreshDrivePane,
    refreshDriveSelectList,
    refreshDriveSide,
    copySelectedDesigns,
    deleteSelectedFromDrive,
    ejectSelectedDrive,
    cleanHiddenOnDrive,
    openDesignFromDriveManager,
    openDrivesDialog,
    closeDrivesDialog,
    bindDrivesDialog,
  };
})();
