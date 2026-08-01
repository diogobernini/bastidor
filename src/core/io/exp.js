'use strict';
// Melco EXP.
// Portado de pystitch (MIT, inkstitch/pystitch) — ExpReader.py / ExpWriter.py.

const C = require('../commands');
const { BinReader, BinWriter, signed8 } = require('../binary');

const WRITE_SETTINGS = {
  full_jump: true,
  round: true,
  max_jump: 127,
  max_stitch: 127,
  sequin_contingency: C.CONTINGENCY_SEQUIN_JUMP,
};

function read(buf, out) {
  const r = new BinReader(buf);
  for (;;) {
    const b0 = r.u8();
    const b1 = r.u8();
    if (b0 === null || b1 === null) break;
    if (b0 !== 0x80) {
      out.stitch(signed8(b0), -signed8(b1));
      continue;
    }
    const control = b1;
    const c0 = r.u8();
    const c1 = r.u8();
    if (c0 === null || c1 === null) break;
    const x = signed8(c0);
    const y = -signed8(c1);
    if (control === 0x80) {
      out.trim();
      continue;
    }
    if (control === 0x02) {
      out.stitch(x, y);
      continue;
    }
    if (control === 0x04) {
      out.move(x, y);
      continue;
    }
    if (control === 0x01) {
      out.colorChange();
      if (x !== 0 || y !== 0) out.move(x, y);
      continue;
    }
    break; // controle desconhecido
  }
  out.end();
}

function write(pattern) {
  const w = new BinWriter();
  let xx = 0;
  let yy = 0;
  for (const stitch of pattern.stitches) {
    const data = stitch[2] & C.COMMAND_MASK;
    const dx = Math.round(stitch[0] - xx);
    const dy = Math.round(stitch[1] - yy);
    xx += dx;
    yy += dy;
    if (data === C.STITCH) {
      w.u8(dx);
      w.u8(-dy);
    } else if (data === C.JUMP) {
      w.u8(0x80);
      w.u8(0x04);
      w.u8(dx);
      w.u8(-dy);
    } else if (data === C.TRIM) {
      w.u8(0x80);
      w.u8(0x80);
      w.u8(0x07);
      w.u8(0x00);
    } else if (data === C.COLOR_CHANGE || data === C.STOP) {
      w.u8(0x80);
      w.u8(0x01);
      w.u8(0x00);
      w.u8(0x00);
    }
  }
  return w.toBuffer();
}

module.exports = { read, write, WRITE_SETTINGS };
