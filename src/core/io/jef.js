'use strict';
// Janome JEF (somente leitura na v1).
// Portado de pystitch (MIT, inkstitch/pystitch) — JefReader.py.

const C = require('../commands');
const { BinReader, signed8 } = require('../binary');
const { getJefThreadSet } = require('../palettes');

function readStitches(r, out, settings) {
  let colorIndex = 1;
  for (;;) {
    const b0 = r.u8();
    const b1 = r.u8();
    if (b0 === null || b1 === null) break;
    if (b0 !== 0x80) {
      out.stitch(signed8(b0), -signed8(b1));
      continue;
    }
    const ctrl = b1;
    const c0 = r.u8();
    const c1 = r.u8();
    if (c0 === null || c1 === null) break;
    const x = signed8(c0);
    const y = -signed8(c1);
    if (ctrl === 0x02) {
      if (x === 0 && y === 0) {
        // Um salto de comprimento zero é gravado como corte nos JEF do mercado.
        out.trim(x, y);
      } else {
        out.move(x, y);
      }
      continue;
    }
    if (ctrl === 0x01) {
      // null na lista de fios significa STOP (era a cor 0).
      if (out.threadlist[colorIndex] === null || out.threadlist[colorIndex] === undefined) {
        out.stop(0, 0);
        out.threadlist.splice(colorIndex, 1);
      } else {
        out.colorChange(0, 0);
        colorIndex++;
      }
      continue;
    }
    if (ctrl === 0x10) break;
    break; // controle desconhecido
  }
  out.end(0, 0);

  let clipping = true;
  let trims = false;
  let countMax = null;
  let trimDistance = 3.0;
  if (settings) {
    if (settings.trim_at !== undefined) countMax = settings.trim_at;
    if (settings.trims !== undefined) trims = settings.trims;
    if (settings.trim_distance !== undefined) trimDistance = settings.trim_distance;
    if (settings.clipping !== undefined) clipping = settings.clipping;
  }
  if (trims && countMax === null) countMax = 3;
  if (trimDistance !== null) trimDistance *= 10;
  out.interpolateTrims(countMax, trimDistance, clipping);
}

function read(buf, out, settings) {
  const r = new BinReader(buf);
  const jefThreads = getJefThreadSet();
  const stitchOffset = r.u32le();
  r.skip(20);
  const countColors = r.u32le();
  r.skip(88);

  for (let i = 0; i < countColors; i++) {
    const v = r.u32le();
    if (v === null) break;
    const index = v >>> 0;
    if (index === 0) {
      out.threadlist.push(null);
    } else {
      out.addThread(jefThreads[index % jefThreads.length]);
    }
  }

  r.seek(stitchOffset);
  readStitches(r, out, settings);
}

module.exports = { read };
