'use strict';
// i18n-ui: tradução de strings (tr), locale para toLocaleString, aplicação
// das strings estáticas marcadas com data-i18n* no DOM (applyI18n) e
// formatadores numéricos/de unidade usados na sidebar, status bar, dialogs,
// biblioteca e gestor de pendrive (fmtMm/fmtNum/fmtBytesLocal).
//
// Consome (globais definidos em renderer.js): state (strings/lang/settings),
// $, populateHoopPresets (re-rotula os presets de bastidor, chamado no fim
// de applyI18n). A ordem dos <script> não é exigida pela correção (tudo
// aqui só roda dentro de funções, chamadas depois que boot() executa ao
// final da lista de módulos), mas este é o primeiro módulo do index.html,
// por ser o mais consumido pelos demais.
window.I18n = (function () {

function tr(key, vars) {
  const table = state.strings[state.lang] || {};
  const en = state.strings.en || {};
  let s = table[key] !== undefined ? table[key] : en[key] !== undefined ? en[key] : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll('{' + k + '}', String(v));
  }
  return s;
}

function locale() {
  return state.lang === 'pt-BR' ? 'pt-BR' : 'en-US';
}

// Aplica as strings estáticas marcadas com data-i18n / data-i18n-title / data-i18n-placeholder.
function applyI18n() {
  document.documentElement.lang = state.lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = tr(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = tr(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title); // issue #38: tooltip dobra de rótulo p/ leitor de tela nos botões só-ícone
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = tr(el.dataset.i18nPlaceholder);
  });
  const speedSel = $('sim-speed');
  const current = speedSel.value;
  speedSel.innerHTML = '';
  for (const v of [150, 300, 600, 1200, 2500]) {
    const opt = document.createElement('option');
    opt.value = String(v);
    opt.textContent = `${v} ${tr('unit.sps')}`;
    speedSel.appendChild(opt);
  }
  if (current) speedSel.value = current;
  populateHoopPresets();
}

// --------------------------------------------------------------- utilidades

function fmtMm(units01mm, decimals = 1) {
  const mm = units01mm / 10;
  if (state.settings && state.settings.units === 'in') {
    const v = (mm / 25.4).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${v} ${tr('unit.in')}`;
  }
  const v = mm.toLocaleString(locale(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${v} ${tr('unit.mm')}`;
}

function fmtNum(n) {
  return n.toLocaleString(locale());
}

function fmtBytesLocal(bytes) {
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

  return {
    tr,
    locale,
    applyI18n,
    fmtMm,
    fmtNum,
    fmtBytesLocal,
  };
})();
