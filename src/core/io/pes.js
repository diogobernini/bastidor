'use strict';
// Brother PES/PEC (somente leitura na v1).
// Portado de pystitch (MIT, inkstitch/pystitch) — PesReader.py / PecReader.py.
// O PES embute um bloco PEC com os pontos; versões 5+ trazem fios próprios.

const { BinReader } = require('../binary');
const { Thread } = require('../pattern');
const { getPecThreadSet } = require('../palettes');

const JUMP_CODE = 0x10;
const TRIM_CODE = 0x20;
const FLAG_LONG = 0x80;

// ---------------------------------------------------------------- PEC

function signed12(b) {
  b &= 0xfff;
  return b > 0x7ff ? b - 0x1000 : b;
}

function signed7(b) {
  return b > 63 ? b - 128 : b;
}

function processPecColors(colorBytes, out, values) {
  const threadSet = getPecThreadSet();
  const max = threadSet.length;
  for (const byte of colorBytes) {
    let thread = threadSet[byte % max];
    if (!thread) {
      thread = new Thread(0x000000);
      thread.description = 'Desconhecida';
    }
    out.addThread(thread);
    values.push(thread);
  }
}

function processPecTable(colorBytes, out, chart, values) {
  const threadSet = getPecThreadSet();
  const max = threadSet.length;
  const threadMap = {};
  for (let i = 0; i < colorBytes.length; i++) {
    const colorIndex = colorBytes[i] % max;
    let thread = threadMap[colorIndex];
    if (thread === undefined || thread === null) {
      if (chart.length > 0) {
        thread = chart.shift();
      } else {
        thread = threadSet[colorIndex];
      }
      threadMap[colorIndex] = thread;
    }
    out.addThread(thread);
    values.push(thread);
  }
}

function mapPecColors(colorBytes, out, chart, values) {
  if (!chart || chart.length === 0) {
    processPecColors(colorBytes, out, values);
  } else if (chart.length >= colorBytes.length) {
    for (const thread of chart) {
      out.addThread(thread);
      values.push(thread);
    }
  } else {
    processPecTable(colorBytes, out, chart, values);
  }
}

function readPecStitches(r, out) {
  for (;;) {
    let val1 = r.u8();
    let val2 = r.u8();
    if ((val1 === 0xff && val2 === 0x00) || val2 === null) break;
    if (val1 === 0xfe && val2 === 0xb0) {
      r.skip(1);
      out.colorChange(0, 0);
      continue;
    }
    let jump = false;
    let trim = false;
    let x;
    let y;
    if ((val1 & FLAG_LONG) !== 0) {
      if ((val1 & TRIM_CODE) !== 0) trim = true;
      if ((val1 & JUMP_CODE) !== 0) jump = true;
      x = signed12((val1 << 8) | val2);
      val2 = r.u8();
      if (val2 === null) break;
    } else {
      x = signed7(val1);
    }
    if ((val2 & FLAG_LONG) !== 0) {
      if ((val2 & TRIM_CODE) !== 0) trim = true;
      if ((val2 & JUMP_CODE) !== 0) jump = true;
      const val3 = r.u8();
      if (val3 === null) break;
      y = signed12((val2 << 8) | val3);
    } else {
      y = signed7(val2);
    }
    if (jump) {
      out.move(x, y);
    } else if (trim) {
      out.trim();
      out.move(x, y);
    } else {
      out.stitch(x, y);
    }
  }
  out.end();
}

// Lê um bloco PEC a partir da posição atual (logo após o magic "#PEC0001"
// no caso de arquivo .pec, ou na posição indicada pelo cabeçalho PES).
function readPec(r, out, pesChart) {
  r.skip(3); // "LA:"
  const label = r.str(16);
  if (label !== null) out.metadata('name', label.trim());
  r.skip(0xf);
  r.u8(); // stride do gráfico (miniatura, não usada)
  r.u8(); // altura do gráfico
  r.skip(0xc);
  const colorChanges = r.u8();
  const countColors = colorChanges + 1; // 0xFF significa 0
  const colorBytes = r.bytes(countColors);
  const threads = [];
  mapPecColors(colorBytes, out, pesChart || null, threads);
  r.skip(0x1d0 - colorChanges);
  const len = r.u24le();
  if (len === null) return;
  r.skip(0x0f);
  readPecStitches(r, out);
  // Os gráficos de miniatura após o bloco de pontos são ignorados.
}

// ---------------------------------------------------------------- PES

function readPesString(r) {
  const length = r.u8();
  if (length === null || length === 0) return null;
  return r.str(length);
}

function readPesMetadata(r, out) {
  const fields = ['name', 'category', 'author', 'keywords', 'comments'];
  for (const field of fields) {
    const v = readPesString(r);
    if (v !== null && v.length > 0) out.metadata(field, v);
  }
}

function readPesThread(r, threadlist) {
  const thread = new Thread();
  thread.catalogNumber = readPesString(r);
  const rgb = r.u24be();
  thread.color = rgb === null ? 0 : rgb & 0xffffff;
  r.skip(5);
  thread.description = readPesString(r);
  thread.brand = readPesString(r);
  thread.chart = readPesString(r);
  threadlist.push(thread);
}

// As versões diferem nos offsets fixos entre os metadados e a lista de fios.
function readPesHeader(r, out, threadlist, skipA, skipB, hoopName) {
  r.skip(4);
  readPesMetadata(r, out);
  if (hoopName) {
    r.skip(14);
    const v = readPesString(r);
    if (v !== null && v.length > 0) out.metadata('hoop_name', v);
  }
  r.skip(skipA);
  const image = readPesString(r);
  if (image !== null && image.length > 0) out.metadata('image_file', image);
  r.skip(skipB);
  const countProgrammableFills = r.u16le();
  if (countProgrammableFills !== 0) return;
  const countMotifs = r.u16le();
  if (countMotifs !== 0) return;
  const countFeatherPatterns = r.u16le();
  if (countFeatherPatterns !== 0) return;
  const countThreads = r.u16le();
  for (let i = 0; i < countThreads; i++) {
    readPesThread(r, threadlist);
  }
}

function read(buf, out) {
  const r = new BinReader(buf);
  const loadedThreads = [];
  const magic = r.str(8);

  if (magic === '#PEC0001') {
    readPec(r, out, loadedThreads);
    out.interpolateDuplicateColorAsStop();
    return;
  }

  const pecBlockPosition = r.u32le();

  if (magic === '#PES0100') {
    out.metadata('version', 10);
    readPesHeader(r, out, loadedThreads, 38, 34, true);
  } else if (magic === '#PES0090') {
    out.metadata('version', 9);
    readPesHeader(r, out, loadedThreads, 30, 34, true);
  } else if (magic === '#PES0080') {
    out.metadata('version', 8);
    readPesHeader(r, out, loadedThreads, 38, 26, false);
  } else if (magic === '#PES0070') {
    out.metadata('version', 7);
    readPesHeader(r, out, loadedThreads, 36, 24, false);
  } else if (magic === '#PES0060') {
    out.metadata('version', 6);
    readPesHeader(r, out, loadedThreads, 36, 24, false);
  } else if (magic === '#PES0050' || magic === '#PES0055' || magic === '#PES0056') {
    out.metadata('version', 5);
    readPesHeader(r, out, loadedThreads, 24, 24, false);
  } else if (magic === '#PES0040') {
    out.metadata('version', 4);
    r.skip(4);
    readPesMetadata(r, out);
  } else if (magic === '#PES0030' || magic === '#PES0022' || magic === '#PES0020' || magic === '#PES0001') {
    const versions = { '#PES0030': 3, '#PES0022': 2.2, '#PES0020': 2, '#PES0001': 1 };
    out.metadata('version', versions[magic]);
  } else if (magic === null || !magic.startsWith('#PES')) {
    // Cabeçalho irreconhecível: tenta mesmo assim ler o bloco PEC.
  }
  if (pecBlockPosition === null) return;
  r.seek(pecBlockPosition);
  readPec(r, out, loadedThreads);
  out.interpolateDuplicateColorAsStop();
}

module.exports = { read, readPec };
