'use strict';
// Tajima DST — formato de troca universal do mercado.
// Portado de pystitch (MIT, inkstitch/pystitch) — DstReader.py / DstWriter.py.
// Cabeçalho de 512 bytes + registros ternários de 3 bytes.

const C = require('../commands');
const { BinWriter } = require('../binary');

const WRITE_SETTINGS = {
  full_jump: false,
  round: true,
  max_jump: 121,
  max_stitch: 121,
  sequin_contingency: C.CONTINGENCY_SEQUIN_UTILIZE,
};

function getbit(b, pos) {
  return (b >> pos) & 1;
}

function decodeDx(b0, b1, b2) {
  let x = 0;
  x += getbit(b2, 2) * 81;
  x += getbit(b2, 3) * -81;
  x += getbit(b1, 2) * 27;
  x += getbit(b1, 3) * -27;
  x += getbit(b0, 2) * 9;
  x += getbit(b0, 3) * -9;
  x += getbit(b1, 0) * 3;
  x += getbit(b1, 1) * -3;
  x += getbit(b0, 0) * 1;
  x += getbit(b0, 1) * -1;
  return x;
}

function decodeDy(b0, b1, b2) {
  let y = 0;
  y += getbit(b2, 5) * 81;
  y += getbit(b2, 4) * -81;
  y += getbit(b1, 5) * 27;
  y += getbit(b1, 4) * -27;
  y += getbit(b0, 5) * 9;
  y += getbit(b0, 4) * -9;
  y += getbit(b1, 7) * 3;
  y += getbit(b1, 6) * -3;
  y += getbit(b0, 7) * 1;
  y += getbit(b0, 6) * -1;
  return -y;
}

function processHeaderInfo(out, prefix, value) {
  if (prefix === 'LA') {
    out.metadata('name', value);
  } else if (prefix === 'AU') {
    out.metadata('author', value);
  } else if (prefix === 'CP') {
    out.metadata('copyright', value);
  } else if (prefix === 'TC') {
    const values = value.split(',').map((s) => s.trim());
    out.addThread({ hex: values[0], description: values[1], catalog: values[2] });
  } else {
    out.metadata(prefix, value);
  }
}

function readHeader(buf, out) {
  const header = buf.subarray(0, 512);
  let start = 0;
  for (let i = 0; i < header.length; i++) {
    const element = header[i];
    if (element === 13 || element === 10) {
      const data = header.subarray(start, i);
      start = i;
      const line = data.toString('utf8').trim();
      if (line.length > 3) {
        processHeaderInfo(out, line.slice(0, 2).trim(), line.slice(3).trim());
      }
    }
  }
}

function readStitches(buf, out, settings) {
  let sequinMode = false;
  let pos = 512;
  while (pos + 3 <= buf.length) {
    const b0 = buf[pos];
    const b1 = buf[pos + 1];
    const b2 = buf[pos + 2];
    pos += 3;
    const dx = decodeDx(b0, b1, b2);
    const dy = decodeDy(b0, b1, b2);
    if ((b2 & 0b11110011) === 0b11110011) {
      break;
    } else if ((b2 & 0b11000011) === 0b11000011) {
      out.colorChange(dx, dy);
    } else if ((b2 & 0b01000011) === 0b01000011) {
      out.sequinMode(dx, dy);
      sequinMode = !sequinMode;
    } else if ((b2 & 0b10000011) === 0b10000011) {
      if (sequinMode) out.sequinEject(dx, dy);
      else out.move(dx, dy);
    } else {
      out.stitch(dx, dy);
    }
  }
  out.end();

  let countMax = 3;
  let clipping = true;
  let trimDistance = null;
  if (settings) {
    if (settings.trim_at !== undefined) countMax = settings.trim_at;
    if (settings.trim_distance !== undefined) trimDistance = settings.trim_distance;
    if (settings.clipping !== undefined) clipping = settings.clipping;
  }
  if (trimDistance !== null) trimDistance *= 10; // mm → unidades de 0,1 mm
  out.interpolateTrims(countMax, trimDistance, clipping);
}

function read(buf, out, settings) {
  readHeader(buf, out);
  readStitches(buf, out, settings);
}

function bit(b) {
  return 1 << b;
}

function encodeRecord(x, y, flags) {
  y = -y; // espelha o eixo Y
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  if (flags === C.JUMP || flags === C.SEQUIN_EJECT) {
    b2 += bit(7);
  }
  if (flags === C.STITCH || flags === C.JUMP || flags === C.SEQUIN_EJECT) {
    b2 += bit(0);
    b2 += bit(1);
    if (x > 40) { b2 += bit(2); x -= 81; }
    if (x < -40) { b2 += bit(3); x += 81; }
    if (x > 13) { b1 += bit(2); x -= 27; }
    if (x < -13) { b1 += bit(3); x += 27; }
    if (x > 4) { b0 += bit(2); x -= 9; }
    if (x < -4) { b0 += bit(3); x += 9; }
    if (x > 1) { b1 += bit(0); x -= 3; }
    if (x < -1) { b1 += bit(1); x += 3; }
    if (x > 0) { b0 += bit(0); x -= 1; }
    if (x < 0) { b0 += bit(1); x += 1; }
    if (x !== 0) throw new Error('Delta X excede o máximo permitido pelo DST.');
    if (y > 40) { b2 += bit(5); y -= 81; }
    if (y < -40) { b2 += bit(4); y += 81; }
    if (y > 13) { b1 += bit(5); y -= 27; }
    if (y < -13) { b1 += bit(4); y += 27; }
    if (y > 4) { b0 += bit(5); y -= 9; }
    if (y < -4) { b0 += bit(4); y += 9; }
    if (y > 1) { b1 += bit(7); y -= 3; }
    if (y < -1) { b1 += bit(6); y += 3; }
    if (y > 0) { b0 += bit(7); y -= 1; }
    if (y < 0) { b0 += bit(6); y += 1; }
    if (y !== 0) throw new Error('Delta Y excede o máximo permitido pelo DST.');
  } else if (flags === C.COLOR_CHANGE) {
    b2 = 0b11000011;
  } else if (flags === C.STOP) {
    b2 = 0b11000011;
  } else if (flags === C.END) {
    b2 = 0b11110011;
  } else if (flags === C.SEQUIN_MODE) {
    b2 = 0b01000011;
  }
  return [b0, b1, b2];
}

function padNum(v, width) {
  return String(Math.trunc(v)).padStart(width, ' ');
}

function write(pattern, settings) {
  let extendedHeader = false;
  let trimAt = 3;
  if (settings) {
    if (settings['extended header'] !== undefined) extendedHeader = settings['extended header'];
    if (settings.version === 'extended') extendedHeader = true;
    if (settings.trim_at !== undefined) trimAt = settings.trim_at;
  }
  const w = new BinWriter();
  const bounds = pattern.bounds();
  let name = pattern.getMetadata('name', 'Sem titulo');
  name = String(name).slice(0, 16);

  w.str(`LA:${name.padEnd(16, ' ')}\r`);
  w.str(`ST:${padNum(pattern.countStitches(), 7)}\r`);
  w.str(`CO:${padNum(pattern.countColorChanges() + pattern.countStitchCommands(C.STOP), 3)}\r`);
  w.str(`+X:${padNum(Math.abs(bounds[2]), 5)}\r`);
  w.str(`-X:${padNum(Math.abs(bounds[0]), 5)}\r`);
  w.str(`+Y:${padNum(Math.abs(bounds[3]), 5)}\r`);
  w.str(`-Y:${padNum(Math.abs(bounds[1]), 5)}\r`);
  let ax = 0;
  let ay = 0;
  if (pattern.stitches.length > 0) {
    const last = pattern.stitches[pattern.stitches.length - 1];
    ax = Math.trunc(last[0]);
    ay = -Math.trunc(last[1]);
  }
  w.str(ax >= 0 ? `AX:+${padNum(ax, 5)}\r` : `AX:-${padNum(Math.abs(ax), 5)}\r`);
  w.str(ay >= 0 ? `AY:+${padNum(ay, 5)}\r` : `AY:-${padNum(Math.abs(ay), 5)}\r`);
  w.str(`MX:+${padNum(0, 5)}\r`);
  w.str(`MY:+${padNum(0, 5)}\r`);
  w.str(`PD:******\r`);
  if (extendedHeader) {
    const author = pattern.getMetadata('author');
    if (author) w.str(`AU:${author}\r`);
    const copyright = pattern.getMetadata('copyright');
    if (copyright) w.str(`CP:${copyright}\r`);
    for (const thread of pattern.threadlist) {
      if (!thread) continue;
      w.str(`TC:${thread.hex()},${thread.description || ''},${thread.catalogNumber || ''}\r`);
    }
  }
  w.u8(0x1a);
  const headerLen = w.tell();
  w.fill(512 - headerLen, 0x20);

  let xx = 0;
  let yy = 0;
  for (const stitch of pattern.stitches) {
    const data = stitch[2] & C.COMMAND_MASK;
    const dx = Math.round(stitch[0] - xx);
    const dy = Math.round(stitch[1] - yy);
    xx += dx;
    yy += dy;
    if (data === C.TRIM) {
      // Corte via "wiggle" de saltos (algumas máquinas cortam após N saltos).
      let delta = -4;
      pushRecord(w, encodeRecord(-delta / 2, -delta / 2, C.JUMP));
      for (let p = 1; p < trimAt - 1; p++) {
        pushRecord(w, encodeRecord(delta, delta, C.JUMP));
        delta = -delta;
      }
      pushRecord(w, encodeRecord(delta / 2, delta / 2, C.JUMP));
    } else {
      pushRecord(w, encodeRecord(dx, dy, data));
    }
  }
  return w.toBuffer();
}

function pushRecord(w, rec) {
  w.u8(rec[0]);
  w.u8(rec[1]);
  w.u8(rec[2]);
}

module.exports = { read, write, WRITE_SETTINGS };
