'use strict';
// Singer XXX (Compucon/Singer Futura).
// Portado de pystitch (MIT, inkstitch/pystitch) — XxxReader.py / XxxWriter.py.
//
// Códigos de controle:
//   7F 01 xx yy  salto
//   7F 03 xx yy  corte (+ deslocamento opcional)
//   7F 08 xx yy  troca de cor (0x0A..0x17 também)
//   7F 7F 02 14  fim
//   7D xxxx yyyy ponto longo (16 bits)

const C = require('../commands');
const { BinReader, BinWriter, signed8, signed16 } = require('../binary');

const WRITE_SETTINGS = {
  full_jump: false,
  round: true,
  max_jump: 124,
  max_stitch: 124,
};

function read(buf, out) {
  const r = new BinReader(buf);
  r.seek(0x27);
  const numColors = r.u16le();
  r.seek(0x100);
  for (;;) {
    const b1 = r.u8();
    if (b1 === null) break;
    if (b1 === 0x7d || b1 === 0x7e) {
      const x = r.u16le();
      const y = r.u16le();
      if (x === null || y === null) break;
      out.move(signed16(x), -signed16(y));
      continue;
    }
    const b2 = r.u8();
    if (b2 === null) break;
    if (b1 !== 0x7f) {
      out.stitch(signed8(b1), -signed8(b2));
      continue;
    }
    const b3 = r.u8();
    const b4 = r.u8();
    if (b3 === null || b4 === null) break;
    if (b2 === 0x01) {
      out.move(signed8(b3), -signed8(b4));
      continue;
    }
    if (b2 === 0x03) {
      out.trim();
      const x = signed8(b3);
      const y = -signed8(b4);
      if (x !== 0 || y !== 0) out.move(x, y);
      continue;
    }
    if (b2 === 0x08 || (b2 >= 0x0a && b2 <= 0x17)) {
      out.colorChange();
      continue;
    }
    if (b2 === 0x7f || b2 === 0x18) break;
    // Registro desconhecido: ignora (mesmo comportamento do pystitch).
  }
  out.end();
  r.skip(2);
  for (let i = 0; i < numColors; i++) {
    const color = r.u32be();
    if (color === null) break;
    out.addThread({ color: color & 0xffffff });
  }
}

function writeHeader(pattern, w) {
  const stitches = pattern.stitches;
  w.fill(0x17, 0x00);
  w.u32le(stitches.length - 1); // END não conta como comando
  w.fill(0x0c, 0x00);
  w.u32le(pattern.threadlist.length);
  w.u16le(0x0000);

  const b = pattern.bounds();
  const width = Math.trunc(b[2] - b[0]);
  const height = Math.trunc(b[3] - b[1]);
  const last = stitches[stitches.length - 1];
  w.u16le(width);
  w.u16le(height);
  w.u16le(Math.trunc(last[0]));
  w.u16le(Math.trunc(-last[1]));
  w.u16le(Math.trunc(-b[0]));
  w.u16le(Math.trunc(b[3]));
  w.fill(0x42, 0x00);
  w.u16le(0x00);
  w.u16le(0x00);
  w.fill(0x73, 0x00);
  w.u16le(0x20);
  w.fill(0x08, 0x00);
}

function writeStitches(pattern, w) {
  let xx = 0;
  let yy = 0;
  for (const stitch of pattern.stitches) {
    const data = stitch[2] & C.COMMAND_MASK;
    const dx = Math.round(stitch[0] - xx);
    const dy = Math.round(stitch[1] - yy);
    xx += dx;
    yy += dy;
    if (data === C.COLOR_CHANGE || data === C.STOP) {
      w.u8(0x7f);
      w.u8(0x08);
      w.u8(dx);
      w.u8(-dy);
      continue;
    }
    if (data === C.END) break;
    if (data === C.STITCH) {
      if (dx > -124 && dx < 124 && dy > -124 && dy < 124) {
        w.u8(dx);
        w.u8(-dy);
      } else {
        w.u8(0x7d);
        w.u16le(dx);
        w.u16le(-dy);
      }
      continue;
    }
    if (data === C.TRIM) {
      w.u8(0x7f);
      w.u8(0x03);
      w.u8(dx);
      w.u8(-dy);
      continue;
    }
    if (data === C.JUMP) {
      w.u8(0x7f);
      w.u8(0x01);
      w.u8(dx);
      w.u8(-dy);
    }
  }
}

function writeColors(pattern, w) {
  w.u8(0x00);
  w.u8(0x00);
  const colors = pattern.threadlist;
  for (const color of colors) {
    w.u8(0x00);
    w.u8(color ? color.red() : 0);
    w.u8(color ? color.green() : 0);
    w.u8(color ? color.blue() : 0);
  }
  for (let i = 0; i < Math.max(0, 21 - colors.length); i++) {
    w.u32le(0x00000000);
  }
  w.u32le(0xffffff00);
  w.u8(0x00);
  w.u8(0x01);
}

function write(pattern) {
  const w = new BinWriter();
  writeHeader(pattern, w);
  const placeholderForEnd = w.tell();
  w.u32le(0x00000000);
  writeStitches(pattern, w);
  const endOfStitches = w.tell();
  w.patchU32le(placeholderForEnd, endOfStitches);
  w.u8(0x7f);
  w.u8(0x7f);
  w.u8(0x02);
  w.u8(0x14);
  writeColors(pattern, w);
  return w.toBuffer();
}

module.exports = { read, write, WRITE_SETTINGS };
