'use strict';
// dialogs: configurações (dlg-settings), redimensionar (dlg-scale, incluindo
// scaleDesign/scaleDesignWithDensity), confirmação genérica (dlg-confirm,
// usada por DrivesUI e LibraryUI), texto/lettering (dlg-text), importar SVG
// (dlg-svg-import) e digitalizar imagem/raster (dlg-digitize) — além da
// tabela de atalhos de teclado (dlg-shortcuts, issue #38: os bindings REAIS
// ficam em bindMenuAndKeys, no remainder de renderer.js).
//
// Consome (globais de renderer.js): state, $, toast, bumpArt, deriveBlocks,
// deriveStats, updateSidebar, updateStatusbar, setDesign, pushHistory
// (issue #37 — undo/redo delta-based), cloneDesignData, designCenter,
// applyTransform, window.DensityScale (src/core/densityscale.js);
// I18n.tr/I18n.fmtNum/I18n.fmtMm/I18n.locale/I18n.applyI18n; RenderCanvas.fitView/
// RenderCanvas.requestRender/RenderCanvas.drawDesignInto. confirmDialog é usado
// por DrivesUI e LibraryUI (ainda não extraídos — chamam Dialogs.confirmDialog
// bare a partir do renderer.js remainder).
//
// issue #29 (fase 2): insertTextDesign/applySvgImport/confirmDigitize também
// registram o objeto paramétrico recém-inserido via window.ObjectCanvas.
// registerObject (src/renderer/objects.js) e window.ObjectModel.
// rasterOptsFromParams (src/core/objectmodel.js) — ambos scripts clássicos
// carregados antes deste módulo, ver index.html.
window.Dialogs = (function () {

function scaleDesign(factor) {
  const [cx, cy] = designCenter();
  applyTransform('scale', { cx, cy, factor });
  RenderCanvas.fitView();
  if (Math.abs(factor - 1) > 0.2) {
    toast(I18n.tr('toast.scaleWarn'), 'warn', 4600);
  }
}

// Como scaleDesign, mas recalcula a densidade das corridas de ponto cheio
// (issue #4, v1) em vez de só escalar as coordenadas. Substitui o array de
// agulhadas por inteiro (o tamanho muda): não tem inversa analítica barata,
// por isso usa o fallback 'snapshot' (cópia completa antes/depois) em vez
// de applyTransform.
function scaleDesignWithDensity(factor) {
  if (!state.design) return;
  const { detectSatinRuns, rescaleWithDensity } = window.DensityScale;
  const [cx, cy] = designCenter();
  const before = cloneDesignData();
  const runs = detectSatinRuns(state.design.stitches);
  state.design.stitches = rescaleWithDensity(state.design.stitches, factor, { center: [cx, cy] });
  pushHistory({ type: 'snapshot', before, after: cloneDesignData() });
  bumpArt(); // invalida o cache do modo realista (integração dos PRs #9 e #10)
  deriveBlocks();
  deriveStats();
  updateSidebar();
  updateStatusbar();
  RenderCanvas.fitView();
  RenderCanvas.requestRender();
  toast(I18n.tr('toast.densityRescaled', { n: I18n.fmtNum(runs.length) }));
}

// --------------------------------------------------------------- configurações

function populateHoopPresets() {
  const sel = $('set-hooppreset');
  const current = sel.value;
  sel.innerHTML = '';
  for (const [key, preset] of Object.entries(state.hoopPresets)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = preset.labelKey ? I18n.tr(preset.labelKey) : preset.label;
    sel.appendChild(opt);
  }
  if (current) sel.value = current;
}

function settingsToForm() {
  const s = state.settings;
  $('set-language').value = s.language || 'auto';
  $('set-units').value = s.units;
  $('set-background').value = s.view.background;
  $('set-fabric').checked = !!s.view.fabric;
  $('set-threadwidth').value = s.view.threadWidthMm;
  $('set-showjumps').checked = s.view.showJumps;
  $('set-realistic').checked = s.view.realistic;
  $('set-simspeed').value = s.sim.stitchesPerSecond;
  $('set-machinespeed').value = s.machine.speedSpm;
  $('set-hoopshow').checked = s.hoop.show;
  $('set-hooppreset').value = s.hoop.preset;
  $('set-hoopw').value = s.hoop.width;
  $('set-hooph').value = s.hoop.height;
  $('set-gridshow').checked = s.grid.show;
  $('set-gridspacing').value = s.grid.spacingMm;
  $('set-limitstitch').checked = s.write.limitStitchLength;
  $('set-maxstitch').value = s.write.maxStitchMm;
  $('set-tieon').checked = s.write.tieOn;
  $('set-tieoff').checked = s.write.tieOff;
  $('set-trimat').value = s.write.trimAtJumps;
  $('set-minspacing').value = s.write.minSpacingMm;
  $('set-warnlong').value = s.warnings.longStitchMm;
  $('set-librarypath').value = s.library.path;
  $('set-thumbcachecap').value = s.library.thumbCacheCapMB;
  syncHoopCustomVisibility();
}

function formToSettings() {
  const presetKey = $('set-hooppreset').value;
  const preset = state.hoopPresets[presetKey];
  let width = parseFloat($('set-hoopw').value) || 130;
  let height = parseFloat($('set-hooph').value) || 180;
  if (preset && preset.width) {
    width = preset.width;
    height = preset.height;
  }
  return {
    language: $('set-language').value,
    units: $('set-units').value,
    view: {
      background: $('set-background').value,
      fabric: $('set-fabric').checked,
      showPoints: !!state.settings.view.showPoints,
      threadWidthMm: clampNum($('set-threadwidth').value, 0.1, 1.5, 0.4),
      showJumps: $('set-showjumps').checked,
      realistic: $('set-realistic').checked,
    },
    sim: { stitchesPerSecond: clampNum($('set-simspeed').value, 50, 5000, 600) },
    // Velocidade real da máquina (issue #38): usada na estimativa "confecção
    // ≈" da biblioteca (src/core/sewtime.js), não na simulação acima.
    machine: { speedSpm: Math.round(clampNum($('set-machinespeed').value, 100, 2000, 650)) },
    hoop: { show: $('set-hoopshow').checked, preset: presetKey, width, height },
    grid: { show: $('set-gridshow').checked, spacingMm: clampNum($('set-gridspacing').value, 1, 100, 10) },
    write: {
      limitStitchLength: $('set-limitstitch').checked,
      maxStitchMm: clampNum($('set-maxstitch').value, 1, 12.7, 12.1),
      tieOn: $('set-tieon').checked,
      tieOff: $('set-tieoff').checked,
      trimAtJumps: Math.round(clampNum($('set-trimat').value, 2, 8, 3)),
      minSpacingMm: clampNum($('set-minspacing').value, 0, 2, 0.3),
    },
    warnings: { longStitchMm: clampNum($('set-warnlong').value, 1, 30, 12.1) },
    // library.path fica de fora: é salvo direto em "Escolher pasta…"
    // (settings:set já roda ali), sem esperar o "Salvar" deste formulário.
    library: { thumbCacheCapMB: Math.round(clampNum($('set-thumbcachecap').value, 10, 5000, 200)) },
  };
}

function clampNum(v, min, max, fallback) {
  const n = parseFloat(v);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function syncHoopCustomVisibility() {
  const isCustom = $('set-hooppreset').value === 'custom';
  $('hoop-custom').style.opacity = isCustom ? '1' : '0.45';
  $('set-hoopw').disabled = !isCustom;
  $('set-hooph').disabled = !isCustom;
  if (!isCustom) {
    const preset = state.hoopPresets[$('set-hooppreset').value];
    if (preset && preset.width) {
      $('set-hoopw').value = preset.width;
      $('set-hooph').value = preset.height;
    }
  }
}

function openSettings() {
  settingsToForm();
  $('dlg-settings').showModal();
}

async function applySettingsFromForm() {
  const result = await window.api.setSettings(formToSettings());
  state.settings = result.settings;
  bumpArt(); // espessura do fio, saltos ou modo realista podem ter mudado
  const langChanged = result.lang !== state.lang;
  state.lang = result.lang;
  if (langChanged) I18n.applyI18n();
  $('sim-speed').value = String(nearestSimOption(state.settings.sim.stitchesPerSecond));
  if (state.design) {
    deriveStats();
    updateSidebar();
  }
  updateStatusbar();
  RenderCanvas.requestRender();
}

function nearestSimOption(v) {
  const opts = [150, 300, 600, 1200, 2500];
  return opts.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
}

// Diálogo de confirmação genérico (sobrescrever/apagar), devolve true/false.
function confirmDialog({ title, message, okLabel }) {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-ok').textContent = okLabel;
    const dlg = $('dlg-confirm');
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok');
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

// --------------------------------------------------------------- lettering (texto)
// Ferramenta "Texto" (issue #7, fase 1): a fonte, o layout e a geração de
// pontos rodam no núcleo, no processo principal (src/core/lettering); aqui
// só populamos o formulário, pedimos a pré-visualização (debounced) e, ao
// inserir, emendamos o Pattern resultante no design atual (ou criamos um
// design novo, se não houver nenhum aberto).

// Rótulo do tipo de fonte no seletor (issue #20): "Nome · tipo", sem
// travessão, separador "·" (convenção do app).
const FONT_TYPE_LABEL_KEY = { stroke: 'text.typeStroke', inkstitch: 'text.typeInkstitch', ttf: 'text.typeTtf' };

function populateTextFontSelect() {
  const sel = $('text-font');
  const previous = sel.value;
  sel.innerHTML = '';
  for (const f of state.lettering.fonts) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.label + ' · ' + I18n.tr(FONT_TYPE_LABEL_KEY[f.type] || 'text.typeStroke');
    sel.appendChild(opt);
  }
  if (previous && state.lettering.fonts.some((f) => f.id === previous)) {
    sel.value = previous; // preserva a seleção ao repopular (ex.: depois de "adicionar fonte…")
  } else {
    const hershey = state.lettering.fonts.find((f) => f.id.includes('Hershey'));
    if (hershey) sel.value = hershey.id;
  }
}

function currentFontType() {
  const id = $('text-font').value;
  const font = state.lettering.fonts.find((f) => f.id === id);
  return font ? font.type : 'stroke';
}

function readTextFormOpts() {
  return {
    fontId: $('text-font').value,
    text: $('text-input').value,
    heightMm: clampNum($('text-height').value, 2, 200, 10),
    letterSpacing: clampNum($('text-letterspacing').value, -20, 300, 0),
    lineSpacing: clampNum($('text-linespacing').value, -20, 300, 0),
    stitchLengthMm: clampNum($('text-stitchlen').value, 0.5, 6, 2),
    finish: $('text-finish').value,
    satinWidthMm: clampNum($('text-satinwidth').value, 0.8, 5, 2),
    satinDensityMm: clampNum($('text-satindensity').value, 0.2, 1.5, 0.4),
    underlay: $('text-underlay').checked,
    fillSpacingMm: clampNum($('text-fillspacing').value, 0.2, 2, 0.4),
    fillAngleDeg: clampNum($('text-fillangle').value, -90, 90, 0),
    fillStitchMm: clampNum($('text-fillstitch').value, 1, 6, 3),
    outline: $('text-outline').checked,
    outlineStitchMm: clampNum($('text-outlinestitch').value, 0.5, 6, 2.5),
  };
}

// Os parâmetros mostrados se adaptam ao TIPO de fonte selecionada (issue
// #20: traço único/Ink/Stitch mostram ponto corrido/bean/satin; TTF mostra
// preenchimento) e, dentro do primeiro grupo, ao acabamento escolhido (os
// campos de largura/densidade/underlay só valem para satin).
function syncTextFieldVisibility() {
  const isFill = currentFontType() === 'ttf';
  $('text-stroke-fields').hidden = isFill;
  $('text-fill-fields').hidden = !isFill;
  if (isFill) {
    $('text-outline-fields').hidden = !$('text-outline').checked;
  } else {
    const isSatin = $('text-finish').value === 'satin';
    $('text-satin-fields').hidden = !isSatin;
    $('text-underlay-row').hidden = !isSatin;
  }
}

// "Adicionar fonte…" (issue #20): o processo principal escolhe o .ttf/.otf
// e copia pra fonts/ttf/ (preload sandboxed não tem 'fs' — I/O só via IPC).
async function addTtfFontFlow() {
  const result = await window.api.letteringAddTtfFont();
  if (!result) return; // usuário cancelou o diálogo de arquivo
  if (!result.ok) {
    toast(I18n.tr('toast.fontAddError') + result.error, 'error', 4200);
    return;
  }
  state.lettering.fonts = result.fonts;
  populateTextFontSelect();
  $('text-font').value = result.fontId;
  syncTextFieldVisibility();
  scheduleTextPreview();
  const added = state.lettering.fonts.find((f) => f.id === result.fontId);
  toast(I18n.tr('toast.fontAdded', { name: added ? added.label : result.fontId }));
}

function sizeTextPreviewCanvas() {
  const cv = $('text-preview');
  const rect = cv.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const d = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(rect.width * d));
  cv.height = Math.max(1, Math.round(rect.height * d));
}

function clearTextPreview(message) {
  const cv = $('text-preview');
  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  if (!message) return;
  const d = window.devicePixelRatio || 1;
  c.fillStyle = '#5b5b66';
  c.font = `${Math.round(12 * d)}px -apple-system, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(message, cv.width / 2, cv.height / 2);
}

// Desenha as polilinhas devolvidas por lettering:build — o mesmo traçado que
// vai ser gravado (ver patternPolylines em src/core/lettering/stitcher.js).
function drawTextPreview(result) {
  const cv = $('text-preview');
  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  if (!result.polylines.length) {
    clearTextPreview(I18n.tr('text.previewEmpty'));
    return;
  }
  const d = window.devicePixelRatio || 1;
  const [minX, minY, maxX, maxY] = result.bounds;
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const pad = 14 * d;
  const scale = Math.min((cv.width - pad * 2) / w, (cv.height - pad * 2) / h);
  const tx = cv.width / 2 - ((minX + maxX) / 2) * scale;
  const ty = cv.height / 2 - ((minY + maxY) / 2) * scale;
  c.strokeStyle = '#e8a13d';
  c.lineWidth = Math.max(1, 1.3 * d);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const line of result.polylines) {
    c.beginPath();
    line.forEach(([x, y], i) => {
      const sx = x * scale + tx;
      const sy = y * scale + ty;
      if (i === 0) c.moveTo(sx, sy);
      else c.lineTo(sx, sy);
    });
    c.stroke();
  }
}

let textPreviewTimer = null;
function scheduleTextPreview() {
  clearTimeout(textPreviewTimer);
  textPreviewTimer = setTimeout(refreshTextPreview, 150);
}

async function refreshTextPreview() {
  const hasText = $('text-input').value.trim().length > 0;
  if (!hasText) {
    state.lettering.lastResult = null;
    clearTextPreview(I18n.tr('text.previewEmpty'));
    $('text-stats').textContent = '';
    $('text-missing').hidden = true;
    return;
  }
  const result = await window.api.letteringBuild(readTextFormOpts());
  if (!result.ok) {
    state.lettering.lastResult = null;
    clearTextPreview(I18n.tr('text.previewEmpty'));
    $('text-stats').textContent = '';
    $('text-missing').hidden = true;
    toast(I18n.tr('toast.textError') + result.error, 'error', 4200);
    return;
  }
  state.lettering.lastResult = result;
  drawTextPreview(result);
  const opt = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  const w = ((result.bounds[2] - result.bounds[0]) / 10).toLocaleString(I18n.locale(), opt);
  const h = ((result.bounds[3] - result.bounds[1]) / 10).toLocaleString(I18n.locale(), opt);
  $('text-stats').textContent = I18n.tr('text.stats', { n: I18n.fmtNum(result.stats.stitches), w, h });
  if (result.missingChars.length) {
    $('text-missing').hidden = false;
    $('text-missing').textContent = I18n.tr('text.missingChars', { chars: result.missingChars.join(' ') });
  } else {
    $('text-missing').hidden = true;
  }
}

// Redesenha o resultado mais recente, ou a mensagem de "vazio" — usado tanto
// ao abrir o diálogo quanto pelo ResizeObserver (redimensionar o <canvas>
// via .width/.height sempre limpa o conteúdo, mesmo quando o tamanho não mudou).
function redrawTextPreview() {
  if (state.lettering.lastResult) drawTextPreview(state.lettering.lastResult);
  else clearTextPreview(I18n.tr('text.previewEmpty'));
}

function openTextDialog() {
  $('dlg-text').showModal();
  syncTextFieldVisibility();
  sizeTextPreviewCanvas();
  redrawTextPreview();
  $('text-input').focus();
  if ($('text-input').value.trim()) scheduleTextPreview();
}

// Registra o objeto paramétrico (issue #29 fase 2) para o texto recém
// inserido: `source` guarda o texto+fonte (o que identifica QUAL glifo
// desenhar), `stitchParams` guarda o resto (tamanho, espaçamento,
// acabamento) — resizedTextParams em src/core/objectmodel.js só mexe em
// heightMm num redimensionamento futuro, mantendo densidade/comprimento de
// ponto como configurados aqui.
function registerTextObject(opts, threadCount) {
  if (!window.ObjectCanvas) return;
  const source = { text: opts.text, fontId: opts.fontId };
  const stitchParams = Object.assign({}, opts);
  delete stitchParams.text;
  delete stitchParams.fontId;
  ObjectCanvas.registerObject('text', source, stitchParams, threadCount);
}

// Insere o texto: se já há um design aberto, emenda como um novo bloco de
// cor ao final (COLOR_CHANGE antes, se já houver pontos); senão, o texto
// vira o design. Em ambos os casos o bloco de texto já chega centrado na
// origem (textToPattern centra por padrão).
async function insertTextDesign() {
  if (!$('text-input').value.trim()) {
    toast(I18n.tr('toast.textEmpty'), 'warn');
    return;
  }
  const opts = readTextFormOpts();
  const result = await window.api.letteringBuild(opts);
  if (!result.ok) {
    toast(I18n.tr('toast.textError') + result.error, 'error', 4200);
    return;
  }
  const textDesign = result.design;
  if (!textDesign.stitches.length) {
    toast(I18n.tr('toast.textEmpty'), 'warn');
    return;
  }

  if (!state.design) {
    setDesign(textDesign);
    registerTextObject(opts, textDesign.threads.length);
    toast(I18n.tr('toast.textCreated'));
  } else {
    // Operação composta (agulhadas + threads mudam juntas, tamanho do
    // array cresce): sem inversa analítica barata, usa o fallback 'snapshot'.
    const before = cloneDesignData();
    let stitches = state.design.stitches;
    if (stitches.length && (stitches[stitches.length - 1][2] & COMMAND_MASK) === END) {
      stitches = stitches.slice(0, -1); // um único END sobrevive, no fim de tudo
    }
    if (stitches.length) {
      const last = stitches[stitches.length - 1];
      stitches.push([last[0], last[1], COLOR_CHANGE]);
    }
    for (const st of textDesign.stitches) stitches.push([st[0], st[1], st[2]]);
    state.design.stitches = stitches;
    state.design.threads.push(...textDesign.threads);
    registerTextObject(opts, textDesign.threads.length);
    pushHistory({ type: 'snapshot', before, after: cloneDesignData() });
    bumpArt();
    deriveBlocks();
    deriveStats();
    updateSidebar();
    updateStatusbar();
    RenderCanvas.requestRender();
    toast(I18n.tr('toast.textInserted'));
  }
  $('dlg-text').close();
}

// true depois que o usuário toca no checkbox "Manter densidade" à mão;
// enquanto for false, o valor padrão reage ao % digitado.
let keepDensityTouched = false;

function openScaleDialog() {
  if (!state.design) return;
  $('scale-percent').value = 100;
  keepDensityTouched = false;
  updateScalePreview();
  $('dlg-scale').showModal();
}

// Padrão: marcado quando a escala passa de ±10% (abaixo disso o ganho de
// manter a densidade do ponto cheio é pequeno). Só se aplica até o
// usuário tocar no checkbox manualmente (ver keepDensityTouched).
function syncKeepDensityDefault(pct) {
  if (keepDensityTouched) return;
  $('scale-keepdensity').checked = Math.abs(pct / 100 - 1) > 0.1;
}

function updateScalePreview() {
  const pct = clampNum($('scale-percent').value, 10, 400, 100);
  const s = state.stats;
  $('scale-preview').textContent =
    `${I18n.fmtMm(s.width)} × ${I18n.fmtMm(s.height)}  →  ${I18n.fmtMm((s.width * pct) / 100)} × ${I18n.fmtMm((s.height * pct) / 100)}`;
  syncKeepDensityDefault(pct);
}

function bindDialogs() {
  $('scale-percent').addEventListener('input', updateScalePreview);
  $('scale-keepdensity').addEventListener('change', () => {
    keepDensityTouched = true;
  });
  $('scale-form').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'apply') {
      const pct = clampNum($('scale-percent').value, 10, 400, 100);
      if (pct !== 100) {
        if ($('scale-keepdensity').checked) scaleDesignWithDensity(pct / 100);
        else scaleDesign(pct / 100);
      }
    }
  });

  $('settings-form').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'save') applySettingsFromForm();
  });

  $('text-form').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'insert') {
      e.preventDefault(); // async e pode falhar (texto vazio, erro de IPC) — fecha só se der certo
      insertTextDesign();
    }
  });
  for (const id of [
    'text-input', 'text-height', 'text-letterspacing', 'text-linespacing', 'text-stitchlen',
    'text-satinwidth', 'text-satindensity', 'text-fillspacing', 'text-fillangle', 'text-fillstitch', 'text-outlinestitch',
  ]) {
    $(id).addEventListener('input', scheduleTextPreview);
  }
  $('text-font').addEventListener('change', () => {
    syncTextFieldVisibility();
    scheduleTextPreview();
  });
  $('text-finish').addEventListener('change', () => {
    syncTextFieldVisibility();
    scheduleTextPreview();
  });
  $('text-underlay').addEventListener('change', scheduleTextPreview);
  $('text-outline').addEventListener('change', () => {
    syncTextFieldVisibility();
    scheduleTextPreview();
  });
  $('text-addfont-btn').addEventListener('click', addTtfFontFlow);
  new ResizeObserver(() => {
    sizeTextPreviewCanvas();
    redrawTextPreview();
  }).observe($('text-preview'));

  document.querySelectorAll('.tabs input[name="tab"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      document.querySelectorAll('.tab-pane').forEach((pane) => {
        pane.hidden = pane.dataset.tab !== radio.value;
      });
    });
  });

  $('set-hooppreset').addEventListener('change', syncHoopCustomVisibility);
}

// --------------------------------------------------------------- importar SVG

const svgPrev = { timer: null, token: 0, aspect: null };

function handleSvgPicked(payload) {
  if (state.design && !confirm(I18n.tr('svgimport.confirmReplace'))) return;
  state.svgImport = payload;
  svgPrev.aspect = null; // preenchido pela primeira prévia (tamanho natural)
  $('svgimport-filename').textContent = payload.name;
  $('svgimport-width').value = '';
  $('svgimport-height').value = '';
  $('svgimport-stats').textContent = '';
  $('dlg-svg-import').showModal();
  runSvgPreview();
}

function svgImportOpts() {
  const opts = {
    fillSpacingMm: clampNum($('svgimport-spacing').value, 0.1, 2, 0.4),
    fillAngleDeg: clampNum($('svgimport-angle').value, -180, 180, 0),
    autoAngle: $('svgimport-autoangle').checked,
    fillStitchMm: clampNum($('svgimport-fillstitch').value, 1, 8, 3),
    outlineStitchMm: clampNum($('svgimport-outlinestitch').value, 0.5, 8, 2.5),
    outline: $('svgimport-outline').checked,
    fill: $('svgimport-fill').checked,
  };
  const w = Number($('svgimport-width').value);
  if (w > 0) opts.targetWidthMm = Math.max(5, Math.min(600, w));
  return opts;
}

// Prévia do SVG: gera de verdade no núcleo (modo preview, sem design:opened)
// e desenha; a primeira resposta define o tamanho natural nos campos.
function runSvgPreview() {
  const picked = state.svgImport;
  if (!picked) return;
  const token = ++svgPrev.token;
  window.api
    .importSvg({ text: picked.text, opts: svgImportOpts(), name: picked.name, path: picked.path, preview: true })
    .then((res) => {
      if (token !== svgPrev.token || !res || !res.ok || !state.svgImport) return;
      if (svgPrev.aspect === null && res.widthMm > 0) {
        svgPrev.aspect = res.heightMm / res.widthMm;
        $('svgimport-width').value = Math.round(res.widthMm);
        $('svgimport-height').value = Math.round(res.heightMm);
      }
      const cv = $('svgimport-cv');
      const rect = cv.getBoundingClientRect();
      if (rect.width > 0) RenderCanvas.drawDesignInto(cv, res.design, rect.width, rect.height, 10, { autoBg: true });
      let n = 0;
      for (const st of res.design.stitches) {
        if ((st[2] & COMMAND_MASK) === STITCH) n++;
      }
      $('svgimport-stats').textContent =
        res.widthMm.toFixed(0) + ' × ' + res.heightMm.toFixed(0) + ' mm · ' +
        I18n.tr('dig.previewStats', { n: I18n.fmtNum(n), c: res.design.threads.length });
    })
    .catch(() => {});
}

function queueSvgPreview() {
  clearTimeout(svgPrev.timer);
  svgPrev.timer = setTimeout(runSvgPreview, 280);
}

async function applySvgImport() {
  const picked = state.svgImport;
  if (!picked) return;
  try {
    const opts = svgImportOpts();
    const res = await window.api.importSvg({ text: picked.text, opts, name: picked.name, path: picked.path });
    // Registra o objeto paramétrico (issue #29 fase 2): a importação
    // SUBSTITUI o design inteiro (ver handleSvgPicked/confirmReplace), então
    // o objeto cobre todas as cores. `res` chega DEPOIS de "design:opened"
    // já ter trocado state.design (mesmo canal IPC, ordem preservada) — o
    // resto dos parâmetros (largura-alvo concreta, mesmo que o campo tenha
    // ficado em branco) vem de res.widthMm, não do <input> vazio.
    if (window.ObjectCanvas && state.design) {
      const source = { svgText: picked.text, name: picked.name, path: picked.path };
      const stitchParams = Object.assign({}, opts, { targetWidthMm: res.widthMm });
      ObjectCanvas.registerObject('svg-shape', source, stitchParams, res.design.threads.length);
    }
    toast(I18n.tr('toast.svgImported', { name: picked.name }));
  } catch (err) {
    toast(I18n.tr('toast.svgImportError') + err.message, 'error', 5000);
  }
}

function bindSvgImportDialog() {
  window.api.onSvgPicked(handleSvgPicked);
  $('svgimport-form').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'apply') applySvgImport();
  });
  $('svgimport-width').addEventListener('input', () => {
    const w = Number($('svgimport-width').value);
    if (svgPrev.aspect !== null && w > 0) $('svgimport-height').value = Math.round(w * svgPrev.aspect);
    queueSvgPreview();
  });
  $('svgimport-height').addEventListener('input', () => {
    const h = Number($('svgimport-height').value);
    if (svgPrev.aspect !== null && svgPrev.aspect > 0 && h > 0) {
      $('svgimport-width').value = Math.round(h / svgPrev.aspect);
    }
    queueSvgPreview();
  });
  for (const id of ['svgimport-spacing', 'svgimport-angle', 'svgimport-fillstitch', 'svgimport-outlinestitch']) {
    $(id).addEventListener('input', queueSvgPreview);
  }
  $('svgimport-outline').addEventListener('change', queueSvgPreview);
  $('svgimport-fill').addEventListener('change', queueSvgPreview);
  $('svgimport-autoangle').addEventListener('change', queueSvgPreview);
}

// --------------------------------------------------------------- atalhos de teclado (issue #38)

// Fonte única do diálogo "?" (dlg-shortcuts, abaixo): os bindings REAIS
// ficam em bindMenuAndKeys, no remainder de renderer.js — o keydown global
// (Espaço/E/G/B/J/0/+/-/?, e dentro do modo de edição Esc/Delete/I/setas) —
// e nos accelerators do menu Electron (src/main/main.js, buildMenuTemplate,
// os Cmd/Ctrl+...). Esta tabela só DOCUMENTA esses dois lugares para
// renderizar o diálogo; não os registra. Mudou um atalho? Atualize os dois:
// o handler de verdade e esta lista.
const SHORTCUTS = [
  { keys: 'Space', i18n: 'shortcuts.desc.sim', context: 'global' },
  { keys: 'E', i18n: 'shortcuts.desc.edit', context: 'global' },
  { keys: 'G', i18n: 'shortcuts.desc.grid', context: 'global' },
  { keys: 'B', i18n: 'shortcuts.desc.hoop', context: 'global' },
  { keys: 'J', i18n: 'shortcuts.desc.jumps', context: 'global' },
  { keys: '0', i18n: 'shortcuts.desc.fit', context: 'global' },
  { keys: '+', i18n: 'shortcuts.desc.zoomIn', context: 'global' },
  { keys: '-', i18n: 'shortcuts.desc.zoomOut', context: 'global' },
  { keys: '?', i18n: 'shortcuts.desc.help', context: 'global' },
  { keys: 'I', i18n: 'shortcuts.desc.insertPoint', context: 'edit' },
  { keys: '↑ ↓ ← →', i18n: 'shortcuts.desc.nudgePoint', context: 'edit' },
  { keys: 'Shift+↑↓←→', i18n: 'shortcuts.desc.nudgePoint10', context: 'edit' },
  { keys: 'Delete', i18n: 'shortcuts.desc.deletePoint', context: 'edit' },
  { keys: 'Esc', i18n: 'shortcuts.desc.deselectPoint', context: 'edit' },
  { keys: 'Esc', i18n: 'shortcuts.desc.closeDialog', context: 'dialog' },
  { keys: 'Cmd/Ctrl+O', i18n: 'shortcuts.desc.open', context: 'global' },
  { keys: 'Cmd/Ctrl+Shift+S', i18n: 'shortcuts.desc.saveAs', context: 'global' },
  { keys: 'Cmd/Ctrl+E', i18n: 'shortcuts.desc.exportPng', context: 'global' },
  { keys: 'Cmd/Ctrl+R', i18n: 'shortcuts.desc.resize', context: 'global' },
  { keys: 'Cmd/Ctrl+Z', i18n: 'shortcuts.desc.undo', context: 'global' },
  { keys: 'Cmd/Ctrl+Shift+Z', i18n: 'shortcuts.desc.redo', context: 'global' },
  { keys: 'Cmd/Ctrl+,', i18n: 'shortcuts.desc.settings', context: 'global' },
];

const SHORTCUT_CONTEXT_I18N = { global: 'shortcuts.ctxGlobal', edit: 'shortcuts.ctxEdit', dialog: 'shortcuts.ctxDialog' };

function renderShortcutsTable() {
  const tbody = $('shortcuts-body');
  tbody.innerHTML = '';
  for (const row of SHORTCUTS) {
    const rowEl = document.createElement('tr'); // "tr" já é a função de tradução; evita sombrear
    const tdKeys = document.createElement('td');
    tdKeys.className = 'mono';
    tdKeys.textContent = row.keys;
    const tdDesc = document.createElement('td');
    tdDesc.textContent = I18n.tr(row.i18n);
    const tdCtx = document.createElement('td');
    tdCtx.className = 'muted';
    tdCtx.textContent = I18n.tr(SHORTCUT_CONTEXT_I18N[row.context]);
    rowEl.append(tdKeys, tdDesc, tdCtx);
    tbody.appendChild(rowEl);
  }
}

// Renderiza de novo a cada abertura (idioma pode ter mudado desde a última vez).
function openShortcutsDialog() {
  renderShortcutsTable();
  $('dlg-shortcuts').showModal();
}

// --------------------------------------------------------------- digitalizar imagem (PNG -> vetor)
// Fluxo: Arquivo > Digitalizar imagem… -> escolhe PNG/JPG/WEBP -> preview
// lado a lado (original · posterizada) com reposterização ao vivo numa
// versão reduzida (~256 px) -> confirma -> gera o Pattern (só o contorno em
// ponto corrido; preenchimento tatami fica para a issue #1) e abre como o
// design atual, do mesmo jeito que abrir um arquivo (setDesign).

const digitize = {
  full: null, // { width, height, data } na resolução original (usado só ao confirmar)
  work: null, // { width, height, data } reduzido a ~256 px (preview ao vivo)
  name: '',
  previewTimer: null,
  previewToken: 0,
  stitchTimer: null,
  stitchToken: 0,
};

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    img.src = src;
  });
}

// Desenha a imagem num canvas fora de tela e devolve os pixels crus.
function imageToImageData(img, maxSide) {
  const scale = maxSide ? Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight)) : 1;
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const octx = off.getContext('2d');
  octx.drawImage(img, 0, 0, w, h);
  const d = octx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: d.data };
}

function paintImageData(canvasEl, imgData) {
  canvasEl.width = imgData.width;
  canvasEl.height = imgData.height;
  canvasEl.getContext('2d').putImageData(new ImageData(imgData.data, imgData.width, imgData.height), 0, 0);
}

// Codifica pixels crus como PNG em base64 (issue #29 fase 2): guardado como
// `source.imageDataURL` de um objeto raster-trace, pra reconstruir a
// ImageData completa quando o usuário redimensiona o objeto e o gerador
// precisa rodar de novo (ver decodeDataURLImage e regenerateParametric em
// src/renderer/objects.js).
function imageDataToDataURL(imgData) {
  const cv = document.createElement('canvas');
  cv.width = imgData.width;
  cv.height = imgData.height;
  cv.getContext('2d').putImageData(new ImageData(imgData.data, imgData.width, imgData.height), 0, 0);
  return cv.toDataURL('image/png');
}

// Caminho inverso: decodifica o dataURL guardado de volta pra ImageData na
// resolução original (sem downscale, ao contrário do imageToImageData(img,
// 256) usado só pra prévia do diálogo). Exportado como Dialogs.
// decodeDataURLImage e injetado no ObjectCanvas via host.decodeDataURLImage
// — ver boot() no remainder de renderer.js.
function decodeDataURLImage(dataURL) {
  return loadImageEl(dataURL).then((img) => imageToImageData(img, null));
}

function digitizeColorsLabel() {
  $('dig-colors-value').textContent = $('dig-colors').value;
}

function updateDigitizeSummary(previewDesign) {
  if (!digitize.full) return;
  const widthMm = clampNum($('dig-width').value, 5, 600, 80);
  const heightMm = widthMm * (digitize.full.height / digitize.full.width);
  let txt = `${widthMm.toFixed(0)} × ${heightMm.toFixed(0)} mm`;
  if (previewDesign) {
    let n = 0;
    for (const st of previewDesign.stitches) {
      if ((st[2] & COMMAND_MASK) === STITCH) n++;
    }
    txt += ' · ' + I18n.tr('dig.previewStats', { n: I18n.fmtNum(n), c: previewDesign.threads.length });
  }
  $('dig-summary').textContent = txt;
}

// Parâmetros CRUS do formulário (largura/tolerância em mm, não convertidos
// pra escala de pixel): é isso que fica guardado como stitchParams de um
// objeto raster-trace (issue #29 fase 2) — ObjectModel.rasterOptsFromParams
// deriva os campos que dependem da resolução da imagem (scale/simplifyTol) a
// partir daqui, tanto pro diálogo quanto pra um redimensionamento futuro.
function digitizeRawParams() {
  return {
    widthMm: clampNum($('dig-width').value, 5, 600, 80),
    toleranceMm: clampNum($('dig-tolerance').value, 0, 5, 0.3),
    colors: Number($('dig-colors').value),
    ignoreBackground: $('dig-ignorebg').checked,
    stitchLenMm: clampNum($('dig-stitchlen').value, 0.5, 6, 2.5),
    outline: $('dig-outline').checked,
    fill: $('dig-fill').checked,
    fillSpacingMm: clampNum($('dig-fillspacing').value, 0.1, 2, 0.4),
    fillAngleDeg: clampNum($('dig-fillangle').value, -180, 180, 0),
    autoAngle: $('dig-autoangle').checked,
    fillStitchMm: clampNum($('dig-fillstitch').value, 1, 8, 3),
    name: digitize.name,
  };
}

// Parâmetros do formulário para uma imagem (work no preview, full ao aplicar):
// escala px->0,1mm e tolerância dependem da resolução da imagem usada.
function digitizeOptsFor(image) {
  return window.ObjectModel.rasterOptsFromParams(digitizeRawParams(), image.width);
}

// Prévia dos pontos: gera de verdade (na imagem de trabalho, menor) e desenha
// as polilinhas coloridas; debounced porque cada mudança de parâmetro regenera.
function runDigitizeStitchPreview() {
  if (!digitize.work) return;
  const token = ++digitize.stitchToken;
  window.api
    .digitizeGenerate(digitize.work, digitizeOptsFor(digitize.work))
    .then((design) => {
      if (token !== digitize.stitchToken) return;
      const cv = $('dig-cv-stitches');
      const rect = cv.getBoundingClientRect();
      if (rect.width > 0) RenderCanvas.drawDesignInto(cv, design, rect.width, rect.height, 10, { autoBg: true });
      updateDigitizeSummary(design);
    })
    .catch(() => {});
}

function queueDigitizeStitchPreview() {
  clearTimeout(digitize.stitchTimer);
  digitize.stitchTimer = setTimeout(runDigitizeStitchPreview, 280);
}

// digitize:posterize roda por IPC no processo principal (o preload é
// sandboxed e não tem 'fs'/núcleo direto), então a resposta é assíncrona;
// o token evita pintar uma resposta antiga se o slider já mudou de novo.
function runDigitizePreview() {
  if (!digitize.work) return;
  const colors = Number($('dig-colors').value);
  const token = ++digitize.previewToken;
  window.api.digitizePosterize(digitize.work, colors).then((posterized) => {
    if (token !== digitize.previewToken) return;
    paintImageData($('dig-cv-posterized'), posterized);
  });
}

function queueDigitizePreview() {
  clearTimeout(digitize.previewTimer);
  digitize.previewTimer = setTimeout(runDigitizePreview, 60);
}

async function openDigitizeDialog() {
  let picked;
  try {
    picked = await window.api.openImageDialog();
  } catch (err) {
    toast(I18n.tr('dig.openError') + err.message, 'error', 5000);
    return;
  }
  if (!picked) return;
  await openDigitizeWith(picked);
}

async function openDigitizeWith(picked) {
  try {
    const img = await loadImageEl(picked.dataURL);
    digitize.full = imageToImageData(img, null);
    digitize.work = imageToImageData(img, 256);
    digitize.name = picked.name;
    paintImageData($('dig-cv-original'), digitize.work);
    $('dig-colors').value = 4;
    digitizeColorsLabel();
    $('dig-width').value = 80;
    $('dig-height').value = (80 * (digitize.full.height / digitize.full.width)).toFixed(0);
    $('dig-tolerance').value = 0.3;
    $('dig-stitchlen').value = 2.5;
    $('dig-fill').checked = true;
    $('dig-ignorebg').checked = true;
    $('dig-outline').checked = true;
    $('dig-fillspacing').value = 0.4;
    $('dig-fillangle').value = 0;
    $('dig-autoangle').checked = true;
    $('dig-fillstitch').value = 3;
    updateDigitizeSummary();
    runDigitizePreview();
    $('dlg-digitize').showModal();
    queueDigitizeStitchPreview(); // depois do showModal: o canvas precisa de layout
  } catch (err) {
    toast(I18n.tr('dig.openError') + err.message, 'error', 5000);
  }
}

// Devolve true se gerou e aplicou o design (para o chamador decidir se fecha
// o modal); false se o usuário desistiu na confirmação de substituição ou se
// a geração falhou — nesses casos o modal continua aberto com os ajustes.
async function confirmDigitize() {
  if (!digitize.full) return false;
  if (state.design && !window.confirm(I18n.tr('dig.confirmReplace'))) return false;
  try {
    const rawParams = digitizeRawParams();
    const design = await window.api.digitizeGenerate(digitize.full, window.ObjectModel.rasterOptsFromParams(rawParams, digitize.full.width));
    setDesign(design);
    // Registra o objeto paramétrico (issue #29 fase 2): digitalizar SUBSTITUI
    // o design inteiro, então o objeto cobre todas as cores. `source` guarda
    // a imagem original codificada em PNG/base64 (imageDataToDataURL) — é o
    // que permite rodar raster.rasterToPaths de novo num redimensionamento
    // futuro, na resolução completa, em vez de escalar as coordenadas.
    if (window.ObjectCanvas) {
      const source = { imageDataURL: imageDataToDataURL(digitize.full), name: digitize.name };
      ObjectCanvas.registerObject('raster-trace', source, rawParams, state.blocks.length);
    }
    toast(I18n.tr('toast.digitized', { n: I18n.fmtNum(state.stats.stitches), c: I18n.fmtNum(state.blocks.length) }));
    return true;
  } catch (err) {
    toast(I18n.tr('dig.openError') + err.message, 'error', 5000);
    return false;
  }
}

function bindDigitizeDialog() {
  $('dig-colors').addEventListener('input', () => {
    digitizeColorsLabel();
    queueDigitizePreview();
    queueDigitizeStitchPreview();
  });
  $('dig-width').addEventListener('input', () => {
    if (digitize.full) {
      const w = clampNum($('dig-width').value, 5, 600, 80);
      $('dig-height').value = (w * (digitize.full.height / digitize.full.width)).toFixed(0);
    }
    updateDigitizeSummary();
    queueDigitizeStitchPreview();
  });
  $('dig-height').addEventListener('input', () => {
    if (digitize.full) {
      const h = clampNum($('dig-height').value, 5, 600, 80);
      $('dig-width').value = (h * (digitize.full.width / digitize.full.height)).toFixed(0);
    }
    updateDigitizeSummary();
    queueDigitizeStitchPreview();
  });
  for (const id of ['dig-tolerance', 'dig-stitchlen', 'dig-fillspacing', 'dig-fillangle', 'dig-fillstitch']) {
    $(id).addEventListener('input', queueDigitizeStitchPreview);
  }
  for (const id of ['dig-fill', 'dig-outline', 'dig-ignorebg', 'dig-autoangle']) {
    $(id).addEventListener('change', queueDigitizeStitchPreview);
  }
  // Não deixa o <form method="dialog"> fechar o modal por conta própria: se o
  // usuário desistir da confirmação de substituição, os ajustes continuam ali.
  $('digitize-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.submitter && e.submitter.value === 'confirm') {
      if (await confirmDigitize()) $('dlg-digitize').close();
    } else {
      $('dlg-digitize').close();
    }
  });
}

  return {
    scaleDesign,
    scaleDesignWithDensity,
    populateHoopPresets,
    settingsToForm,
    formToSettings,
    clampNum,
    syncHoopCustomVisibility,
    openSettings,
    applySettingsFromForm,
    nearestSimOption,
    confirmDialog,
    populateTextFontSelect,
    currentFontType,
    readTextFormOpts,
    syncTextFieldVisibility,
    addTtfFontFlow,
    sizeTextPreviewCanvas,
    clearTextPreview,
    drawTextPreview,
    scheduleTextPreview,
    refreshTextPreview,
    redrawTextPreview,
    openTextDialog,
    insertTextDesign,
    openScaleDialog,
    syncKeepDensityDefault,
    updateScalePreview,
    bindDialogs,
    handleSvgPicked,
    svgImportOpts,
    runSvgPreview,
    queueSvgPreview,
    applySvgImport,
    bindSvgImportDialog,
    renderShortcutsTable,
    openShortcutsDialog,
    loadImageEl,
    imageToImageData,
    paintImageData,
    imageDataToDataURL,
    decodeDataURLImage,
    digitizeColorsLabel,
    updateDigitizeSummary,
    digitizeRawParams,
    digitizeOptsFor,
    runDigitizeStitchPreview,
    queueDigitizeStitchPreview,
    runDigitizePreview,
    queueDigitizePreview,
    openDigitizeDialog,
    openDigitizeWith,
    confirmDigitize,
    bindDigitizeDialog,
  };
})();
