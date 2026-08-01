'use strict';
// Janome JEF.
// Portado de pystitch (MIT, inkstitch/pystitch) — JefReader.py / JefWriter.py.

const C = require('../commands');
const { BinReader, BinWriter, signed8 } = require('../binary');
const { getJefThreadSet, findNearestColorIndex } = require('../palettes');
const { threadsEqual } = require('../pattern');

const WRITE_SETTINGS = {
  full_jump: true,
  round: true,
  max_jump: 127,
  max_stitch: 127,
  sequin_contingency: C.CONTINGENCY_SEQUIN_JUMP,
};

// Tamanhos de bastidor conhecidos pelo formato (mm, unidades de 0,1 mm).
const HOOP_110X110 = 0;
const HOOP_50X50 = 1;
const HOOP_140X200 = 2;
const HOOP_126X110 = 3;
const HOOP_200X200 = 4;

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

// ---------------------------------------------------------------- write

function getJefHoopSize(width, height) {
  if (width < 500 && height < 500) return HOOP_50X50;
  if (width < 1260 && height < 1100) return HOOP_126X110;
  if (width < 1400 && height < 2000) return HOOP_140X200;
  if (width < 2000 && height < 2000) return HOOP_200X200;
  return HOOP_110X110;
}

function writeHoopEdgeDistance(w, xHoopEdge, yHoopEdge) {
  if (Math.min(xHoopEdge, yHoopEdge) >= 0) {
    w.u32le(xHoopEdge);
    w.u32le(yHoopEdge);
    w.u32le(xHoopEdge);
    w.u32le(yHoopEdge);
  } else {
    w.u32le(-1);
    w.u32le(-1);
    w.u32le(-1);
    w.u32le(-1);
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Formato fixo de 14 caracteres ("%Y%m%d%H%M%S" do pystitch). O deslocamento
// dos pontos (0x74 + cores*8) pressupõe exatamente esse tamanho — igual ao
// pystitch, que também não recalcula esse valor se a data vier de settings.
function defaultJefDate() {
  const d = new Date();
  return (
    String(d.getFullYear()) +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds())
  );
}

function write(pattern, settings) {
  let trims = false;
  let commandCountMax = 3;
  let dateString = defaultJefDate();
  if (settings) {
    if (settings.trims !== undefined) trims = settings.trims;
    if (settings.trim_at !== undefined) commandCountMax = settings.trim_at;
    if (settings.date !== undefined) dateString = settings.date;
  }
  pattern.fixColorCount();

  // Escolhe, por troca de cor/parada, o índice mais próximo na paleta de
  // fábrica — evitando repetir o mesmo índice em cores adjacentes distintas.
  const jefThreads = getJefThreadSet();
  let lastIndex = null;
  let lastThread = null;
  const palette = [];
  let colorToggled = false;
  let colorCount = 0;
  let indexInThreadlist = 0;
  for (const stitch of pattern.stitches) {
    const flags = stitch[2] & C.COMMAND_MASK;
    if (flags === C.COLOR_CHANGE || indexInThreadlist === 0) {
      const thread = pattern.threadlist[indexInThreadlist];
      indexInThreadlist++;
      colorCount++;
      let indexOfJefthread = findNearestColorIndex(thread, jefThreads);
      if (lastIndex === indexOfJefthread && !threadsEqual(lastThread, thread)) {
        const repeatedThread = jefThreads[indexOfJefthread];
        const repeatedIndex = indexOfJefthread;
        jefThreads[indexOfJefthread] = null;
        indexOfJefthread = findNearestColorIndex(thread, jefThreads);
        jefThreads[repeatedIndex] = repeatedThread;
      }
      palette.push(indexOfJefthread);
      lastIndex = indexOfJefthread;
      lastThread = thread;
      colorToggled = false;
    }
    if (flags === C.STOP) {
      colorCount++;
      colorToggled = !colorToggled;
      palette.push(colorToggled ? 0 : lastIndex);
    }
  }

  const w = new BinWriter();
  const offsets = 0x74 + colorCount * 8;
  w.u32le(offsets);
  w.u32le(0x14);
  w.str(dateString);
  w.u8(0);
  w.u8(0);
  w.u32le(colorCount);

  let pointCount = 1; // 1 comando para o END
  for (const stitch of pattern.stitches) {
    const data = stitch[2] & C.COMMAND_MASK;
    if (data === C.STITCH) pointCount += 1;
    else if (data === C.JUMP) pointCount += 2;
    else if (data === C.TRIM) {
      if (trims) pointCount += 2 * commandCountMax;
    } else if (data === C.COLOR_CHANGE || data === C.STOP) pointCount += 2;
    else if (data === C.END) break;
  }
  w.u32le(pointCount);

  const extendsRect = pattern.bounds();
  const designWidth = Math.round(extendsRect[2] - extendsRect[0]);
  const designHeight = Math.round(extendsRect[3] - extendsRect[1]);
  w.u32le(getJefHoopSize(designWidth, designHeight));
  const halfWidth = Math.round(designWidth / 2);
  const halfHeight = Math.round(designHeight / 2);

  // distância do centro do bastidor
  w.u32le(halfWidth);
  w.u32le(halfHeight);
  w.u32le(halfWidth);
  w.u32le(halfHeight);

  // distância da borda dos bastidores padrão (110x110, 50x50, 140x200, "personalizado")
  writeHoopEdgeDistance(w, 550 - halfWidth, 550 - halfHeight);
  writeHoopEdgeDistance(w, 250 - halfWidth, 250 - halfHeight);
  writeHoopEdgeDistance(w, 700 - halfWidth, 1000 - halfHeight);
  writeHoopEdgeDistance(w, 700 - halfWidth, 1000 - halfHeight);

  for (const t of palette) w.u32le(t);
  for (let i = 0; i < colorCount; i++) w.u32le(0x0d);

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
    } else if (data === C.COLOR_CHANGE || data === C.STOP) {
      w.u8(0x80);
      w.u8(0x01);
      w.u8(dx);
      w.u8(-dy);
    } else if (data === C.TRIM) {
      if (trims) {
        for (let k = 0; k < commandCountMax; k++) {
          w.u8(0x80);
          w.u8(0x02);
          w.u8(0x00);
          w.u8(0x00);
        }
      }
    } else if (data === C.JUMP) {
      w.u8(0x80);
      w.u8(0x02);
      w.u8(dx);
      w.u8(-dy);
    } else if (data === C.END) {
      break;
    }
  }
  w.u8(0x80);
  w.u8(0x10);
  return w.toBuffer();
}

module.exports = { read, write, WRITE_SETTINGS };
