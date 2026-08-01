'use strict';
// Registro de formatos: leitura, escrita e as regulagens de gravação
// (mesmo fluxo do write_embroidery do pystitch: os limites do formato entram
// como padrão e as preferências do usuário refinam por cima).

const path = require('path');
const { Pattern } = require('../pattern');

const xxx = require('./xxx');
const dst = require('./dst');
const exp = require('./exp');
const jef = require('./jef');
const pes = require('./pes');
const pec = require('./pec');
const svg = require('./svg');
const vp3 = require('./vp3');
const hus = require('./hus');
const sew = require('./sew');
const pcs = require('./pcs');

const FORMATS = {
  xxx: { name: 'Singer XXX', read: xxx.read, write: xxx.write, writeSettings: xxx.WRITE_SETTINGS },
  dst: { name: 'Tajima DST', read: dst.read, write: dst.write, writeSettings: dst.WRITE_SETTINGS },
  exp: { name: 'Melco EXP', read: exp.read, write: exp.write, writeSettings: exp.WRITE_SETTINGS },
  jef: { name: 'Janome JEF', read: jef.read, write: jef.write, writeSettings: jef.WRITE_SETTINGS },
  pes: { name: 'Brother PES', read: pes.read, write: pes.write, writeSettings: pes.WRITE_SETTINGS },
  pec: { name: 'Brother PEC', read: pes.read, write: pec.write, writeSettings: pec.WRITE_SETTINGS },
  vp3: { name: 'Husqvarna/Pfaff VP3', read: vp3.read, write: vp3.write, writeSettings: vp3.WRITE_SETTINGS },
  hus: { name: 'Husqvarna HUS', read: hus.read },
  sew: { name: 'Janome SEW', read: sew.read },
  pcs: { name: 'Pfaff PCS', read: pcs.read, write: pcs.write, writeSettings: pcs.WRITE_SETTINGS },
  svg: { name: 'SVG (vetor)', write: svg.write, plain: true },
};

function extOf(filePath) {
  return path.extname(filePath).replace(/^\./, '').toLowerCase();
}

function supportedReadExtensions() {
  return Object.keys(FORMATS).filter((ext) => FORMATS[ext].read);
}

function supportedWriteExtensions() {
  return Object.keys(FORMATS).filter((ext) => FORMATS[ext].write);
}

function readBuffer(buf, ext, settings) {
  const format = FORMATS[ext];
  if (!format || !format.read) {
    throw new Error(`Formato não suportado para leitura: .${ext}`);
  }
  const pattern = new Pattern();
  format.read(buf, pattern, settings);
  pattern.fixColorCount();
  return pattern;
}

// userSettings (opcional): { max_stitch, max_jump, tie_on, tie_off, trim_at, explicit_trim }
// Valores de comprimento em unidades de 0,1 mm.
function writeBuffer(pattern, ext, userSettings) {
  const format = FORMATS[ext];
  if (!format || !format.write) {
    throw new Error(`Formato não suportado para gravação: .${ext}`);
  }
  if (format.plain) {
    return format.write(pattern, userSettings);
  }
  const settings = Object.assign({}, format.writeSettings);
  const user = userSettings || {};
  // Os limites do formato são obrigatórios; os do usuário só apertam.
  if (user.max_stitch !== undefined && user.max_stitch !== null) {
    settings.max_stitch = Math.min(settings.max_stitch, user.max_stitch);
  }
  if (user.max_jump !== undefined && user.max_jump !== null) {
    settings.max_jump = Math.min(settings.max_jump, user.max_jump);
  }
  if (user.tie_on !== undefined) settings.tie_on = user.tie_on;
  if (user.tie_off !== undefined) settings.tie_off = user.tie_off;
  if (user.explicit_trim !== undefined) settings.explicit_trim = user.explicit_trim;
  if (user.trim_at !== undefined) settings.trim_at = user.trim_at;
  if (user.version !== undefined) settings.version = user.version; // PES: 1 (padrão) ou 6
  if (user.trims !== undefined) settings.trims = user.trims; // JEF: grava corte explícito
  if (user.date !== undefined) settings.date = user.date; // JEF: data do cabeçalho

  const normalized = pattern.getNormalizedPattern(settings);
  return format.write(normalized, settings);
}

module.exports = {
  FORMATS,
  extOf,
  readBuffer,
  writeBuffer,
  supportedReadExtensions,
  supportedWriteExtensions,
};
