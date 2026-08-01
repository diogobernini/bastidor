'use strict';
// Preferências persistentes (JSON em userData/settings.json).

const fs = require('fs');
const os = require('os');
const path = require('path');

// Pasta padrão da biblioteca de matrizes (gestão de pendrive): ~/Bordados no
// darwin/linux, ~\Documents\Bordados no win32. Só é criada sob demanda.
function defaultLibraryPath() {
  const home = os.homedir();
  return process.platform === 'win32' ? path.join(home, 'Documents', 'Bordados') : path.join(home, 'Bordados');
}

const DEFAULTS = {
  language: 'auto', // 'auto' | 'en' | 'pt-BR'
  units: 'mm', // 'mm' | 'in'
  grid: { show: true, spacingMm: 10 },
  hoop: { show: true, preset: '130x180', width: 130, height: 180 },
  view: {
    background: '#101014',
    fabric: true, // textura de trama sobre a cor de fundo
    showPoints: false, // agulhadas como pontinhos (toggle na toolbar)
    threadWidthMm: 0.4,
    showJumps: false,
    realistic: false,
  },
  sim: { stitchesPerSecond: 600 },
  // Velocidade real da máquina (issue #38), usada na estimativa "confecção ≈"
  // da biblioteca — diferente de sim.stitchesPerSecond, que é só a velocidade
  // da simulação na tela.
  machine: { speedSpm: 650 },
  write: {
    maxStitchMm: 12.1,
    limitStitchLength: false,
    tieOn: false,
    tieOff: false,
    trimAtJumps: 3,
    minSpacingMm: 0.3, // guarda de distância mínima entre agulhadas (issue #29)
  },
  warnings: {
    longStitchMm: 12.1,
  },
  library: { path: defaultLibraryPath(), thumbCacheCapMB: 200 }, // teto do cache de miniaturas em disco (issue #35)
  // Auto-update (issue #31): gates the startup electron-updater check in
  // src/main/main.js. Only takes effect for packaged builds; there is no
  // settings UI for this yet, just the "Check for updates…" menu item.
  updates: { autoCheck: true },
  recent: [],
};

const HOOP_PRESETS = {
  '100x100': { width: 100, height: 100, label: '100 × 100 mm' },
  '130x180': { width: 130, height: 180, label: '130 × 180 mm' },
  '160x260': { width: 160, height: 260, labelKey: 'hoop.futuraLarge' },
  '102x102': { width: 102, height: 102, labelKey: 'hoop.futuraSmall' },
  '200x280': { width: 200, height: 280, label: '200 × 280 mm' },
  '300x200': { width: 300, height: 200, label: '300 × 200 mm' },
  custom: { labelKey: 'hoop.custom' },
};

class SettingsStore {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = deepMerge(structuredClone(DEFAULTS), this._load());
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  get() {
    return this.data;
  }

  set(patch) {
    this.data = deepMerge(this.data, patch);
    this._save();
    return this.data;
  }

  addRecent(filePath) {
    const list = this.data.recent.filter((p) => p !== filePath);
    list.unshift(filePath);
    this.data.recent = list.slice(0, 8);
    this._save();
  }

  clearRecent() {
    this.data.recent = [];
    this._save();
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('Falha ao salvar preferências:', err);
    }
  }
}

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch) || typeof patch !== 'object') return patch;
  const out = typeof base === 'object' && base !== null && !Array.isArray(base) ? base : {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = deepMerge(out[k], v);
  }
  return out;
}

module.exports = { SettingsStore, DEFAULTS, HOOP_PRESETS };
