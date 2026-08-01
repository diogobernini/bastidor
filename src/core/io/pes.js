'use strict';
// Brother PES/PEC.
// Portado de pystitch (MIT, inkstitch/pystitch) — PesReader.py / PecReader.py / PesWriter.py.
// O PES embute um bloco PEC com os pontos; versões 5+ trazem fios próprios.

const C = require('../commands');
const { BinReader, BinWriter } = require('../binary');
const { Thread } = require('../pattern');
const { getPecThreadSet, findNearestColorIndex } = require('../palettes');
const pec = require('./pec');

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

// ---------------------------------------------------------------- write
// PesWriter.py: por padrão grava a versão 1 (só o bloco PEC embutido); a
// versão 6 adiciona cabeçalho completo + fios próprios + segmentos CSewSeg.
// As variantes "truncated" do pystitch (stubs mínimos) não foram portadas.

const WRITE_SETTINGS = {
  full_jump: true,
  round: true,
  max_jump: 2047,
  max_stitch: 2047,
  sequin_contingency: C.CONTINGENCY_SEQUIN_JUMP,
};

const VERSION_1 = 1.0;
const VERSION_6 = 6.0;
const PES_VERSION_1_SIGNATURE = '#PES0001';
const PES_VERSION_6_SIGNATURE = '#PES0060';
const EMB_ONE = 'CEmbOne';
const EMB_SEG = 'CSewSeg';

// Nota de fidelidade: o pystitch usa len(string) (nº de caracteres) como
// prefixo de tamanho, mas seu próprio leitor (read_string_8) lê esse valor
// como Nº DE BYTES. Isso é autoinconsistente para texto não-ASCII (ex.:
// "Bordô" tem 5 caracteres mas 6 bytes em UTF-8) — um nome/descrição com
// acento faz o pystitch desalinhar a própria leitura. Como nosso leitor
// (readPesString) também interpreta o prefixo como bytes, gravamos bytes
// UTF-8 aqui (não .length) para que a ida-e-volta funcione com texto em
// português. Isso só afeta a versão 6 (metadados e fios); a v1, padrão, não
// grava essas strings.
function writePesString8(w, s) {
  if (s === null || s === undefined) {
    w.u8(0);
    return;
  }
  let bytes = Buffer.from(String(s), 'utf8');
  if (bytes.length > 255) bytes = bytes.subarray(0, 255);
  w.u8(bytes.length);
  for (const b of bytes) w.u8(b);
}

function writePesString16(w, s) {
  if (s === null || s === undefined) {
    w.u16le(0);
    return;
  }
  const bytes = Buffer.from(String(s), 'utf8');
  w.u16le(bytes.length);
  for (const b of bytes) w.u8(b);
}

function writePesThread(w, thread) {
  writePesString8(w, thread.catalogNumber);
  w.u8(thread.red());
  w.u8(thread.green());
  w.u8(thread.blue());
  w.u8(0); // desconhecido
  w.u32le(0x0a); // 0xA = cor personalizada
  writePesString8(w, thread.description);
  writePesString8(w, thread.brand);
  writePesString8(w, thread.chart);
}

function writePesHeaderV1(w, distinctBlockObjects) {
  w.u16le(0x01); // ajustar à área
  w.u16le(0x01); // bastidor 100x100/130x180
  w.u16le(distinctBlockObjects);
}

function writePesHeaderV6(pattern, w, chart, distinctBlockObjects) {
  w.u16le(0x01);
  w.str('02'); // número ascii de 2 dígitos (não é o byte 0x02)
  writePesString8(w, pattern.getMetadata('name'));
  writePesString8(w, pattern.getMetadata('category'));
  writePesString8(w, pattern.getMetadata('author'));
  writePesString8(w, pattern.getMetadata('keywords'));
  writePesString8(w, pattern.getMetadata('comments'));
  w.u16le(0); // OptimizeHoopChange
  w.u16le(0); // DesignPageIsCustom
  w.u16le(0x64); // largura do bastidor
  w.u16le(0x64); // altura do bastidor
  w.u16le(0); // UseExistingDesignArea
  w.u16le(0xc8); // designWidth
  w.u16le(0xc8); // designHeight
  w.u16le(0x64); // designPageSectionWidth
  w.u16le(0x64); // designPageSectionHeight
  w.u16le(0x64);
  w.u16le(0x07); // cor de fundo da página
  w.u16le(0x13); // cor de frente da página
  w.u16le(0x01); // ShowGrid
  w.u16le(0x01); // WithAxes
  w.u16le(0x00); // SnapToGrid
  w.u16le(100); // GridInterval
  w.u16le(0x01);
  w.u16le(0x00); // OptimizeEntryExitPoints
  w.u8(0); // tamanho do nome do arquivo de imagem de origem (nenhum)
  w.f32le(1);
  w.f32le(0);
  w.f32le(0);
  w.f32le(1);
  w.f32le(0);
  w.f32le(0);
  w.u16le(0); // numberOfProgrammableFillPatterns
  w.u16le(0); // numberOfMotifPatterns
  w.u16le(0); // featherPatternCount
  const countThread = chart.length;
  w.u16le(countThread);
  for (const thread of chart) writePesThread(w, thread);
  w.u16le(distinctBlockObjects);
}

function writePesAddendum(w, colorInfo) {
  const [colorIndexList, rgbList] = colorInfo;
  const count = colorIndexList.length;
  for (const b of colorIndexList) w.u8(b);
  w.fill(128 - count, 0x20);
  for (let s = 0; s < rgbList.length; s++) w.fill(0x90, 0x00);
  for (const r of rgbList) w.u24le(r);
}

function writePesSewsegheader(w, left, top, right, bottom) {
  const width = right - left;
  const height = bottom - top;
  const hoopHeight = 1800;
  const hoopWidth = 1300;
  w.u16le(0);
  w.u16le(0);
  w.u16le(0);
  w.u16le(0);
  w.u16le(0);
  w.u16le(0);
  w.u16le(0);
  w.u16le(0);
  let transX = 350;
  let transY = 100 + height;
  transX += hoopWidth / 2;
  transY += hoopHeight / 2;
  transX += -width / 2;
  transY += -height / 2;
  w.f32le(1);
  w.f32le(0);
  w.f32le(0);
  w.f32le(1);
  w.f32le(transX);
  w.f32le(transY);
  w.u16le(1);
  w.u16le(0);
  w.u16le(0);
  w.u16le(Math.trunc(width));
  w.u16le(Math.trunc(height));
  w.fill(8, 0x00);
  const placeholder = w.tell();
  w.u16le(0); // número de seções, corrigido depois
  return placeholder;
}

// Um segmento por bloco de comando: saltos colapsam num traço de 2 pontos
// (posição anterior → fim do salto); pontos corridos entram ponto a ponto.
function getAsSegmentsBlocks(pattern, chart, adjustX, adjustY) {
  const segments = [];
  let colorIndex = 0;
  let currentThread = pattern.getThreadOrFiller(colorIndex++);
  let colorCode = findNearestColorIndex(currentThread, chart);
  let stitchedX = 0;
  let stitchedY = 0;
  for (const commandBlock of pattern.getAsCommandBlocks()) {
    if (commandBlock.length === 0) continue;
    const command = commandBlock[0][2] & C.COMMAND_MASK;
    const block = [];
    let flag;
    if (command === C.JUMP) {
      block.push([stitchedX - adjustX, stitchedY - adjustY]);
      const lastPos = commandBlock[commandBlock.length - 1];
      block.push([lastPos[0] - adjustX, lastPos[1] - adjustY]);
      flag = 1;
    } else if (command === C.COLOR_CHANGE) {
      currentThread = pattern.getThreadOrFiller(colorIndex++);
      colorCode = findNearestColorIndex(currentThread, chart);
      continue;
    } else if (command === C.STITCH) {
      for (const stitch of commandBlock) {
        stitchedX = stitch[0];
        stitchedY = stitch[1];
        block.push([stitchedX - adjustX, stitchedY - adjustY]);
      }
      flag = 0;
    } else {
      continue;
    }
    segments.push([block, colorCode, flag]);
  }
  return segments;
}

function writePesEmbsewsegSegments(w, pattern, chart, left, bottom, cx, cy) {
  let section = 0;
  const colorlog = [];
  let previousColorCode = -1;
  let started = false;
  const adjustX = left + cx;
  const adjustY = bottom + cy;
  for (const segs of getAsSegmentsBlocks(pattern, chart, adjustX, adjustY)) {
    if (started) w.u16le(0x8003); // marca de fim de seção (não vai antes da 1ª)
    started = true;
    const [segments, colorCode, flag] = segs;
    if (previousColorCode !== colorCode) {
      colorlog.push([section, colorCode]);
      previousColorCode = colorCode;
    }
    w.u16le(flag);
    w.u16le(colorCode);
    w.u16le(segments.length);
    for (const s of segments) {
      w.u16le(Math.trunc(s[0]));
      w.u16le(Math.trunc(s[1]));
    }
    section++;
  }
  w.u16le(colorlog.length);
  for (const item of colorlog) {
    w.u16le(item[0]);
    w.u16le(item[1]);
  }
  return { sections: section, colorlog };
}

function writePesBlocks(w, pattern, chart, left, top, right, bottom, cx, cy) {
  if (pattern.stitches.length === 0) return null;
  writePesString16(w, EMB_ONE);
  const placeholder = writePesSewsegheader(w, left, top, right, bottom);
  w.u16le(0xffff);
  w.u16le(0x0000);
  writePesString16(w, EMB_SEG);
  const { sections, colorlog } = writePesEmbsewsegSegments(w, pattern, chart, left, bottom, cx, cy);
  w.patchU16le(placeholder, sections);
  w.u16le(0x0000);
  w.u16le(0x0000); // 0x00000000: não há mais blocos
  return colorlog;
}

function writeVersion1(pattern, w) {
  const chart = getPecThreadSet();
  w.str(PES_VERSION_1_SIGNATURE);
  const extendsRect = pattern.bounds();
  const cx = (extendsRect[2] + extendsRect[0]) / 2;
  const cy = (extendsRect[3] + extendsRect[1]) / 2;
  const left = extendsRect[0] - cx;
  const top = extendsRect[1] - cy;
  const right = extendsRect[2] - cx;
  const bottom = extendsRect[3] - cy;
  const placeholderPecBlock = w.tell();
  w.u32le(0);
  if (pattern.stitches.length === 0) {
    writePesHeaderV1(w, 0);
    w.u16le(0x0000);
    w.u16le(0x0000);
  } else {
    writePesHeaderV1(w, 1);
    w.u16le(0xffff);
    w.u16le(0x0000);
    writePesBlocks(w, pattern, chart, left, top, right, bottom, cx, cy);
  }
  w.patchU32le(placeholderPecBlock, w.tell());
  pec.writePec(pattern, w);
}

function writeVersion6(pattern, w) {
  pattern.fixColorCount();
  const chart = pattern.threadlist;
  w.str(PES_VERSION_6_SIGNATURE);
  const extendsRect = pattern.bounds();
  const cx = (extendsRect[2] + extendsRect[0]) / 2;
  const cy = (extendsRect[3] + extendsRect[1]) / 2;
  const left = extendsRect[0] - cx;
  const top = extendsRect[1] - cy;
  const right = extendsRect[2] - cx;
  const bottom = extendsRect[3] - cy;
  const placeholderPecBlock = w.tell();
  w.u32le(0);
  let log = [];
  if (pattern.stitches.length === 0) {
    writePesHeaderV6(pattern, w, chart, 0);
    w.u16le(0x0000);
    w.u16le(0x0000);
  } else {
    writePesHeaderV6(pattern, w, chart, 1);
    w.u16le(0xffff);
    w.u16le(0x0000);
    log = writePesBlocks(w, pattern, chart, left, top, right, bottom, cx, cy) || [];
    w.u32le(0);
    w.u32le(0);
    for (let i = 0; i < log.length; i++) {
      w.u32le(i);
      w.u32le(0);
    }
  }
  w.patchU32le(placeholderPecBlock, w.tell());
  const colorInfo = pec.writePec(pattern, w);
  writePesAddendum(w, colorInfo);
  w.u16le(0x0000);
}

function write(pattern, settings) {
  pattern.fixColorCount();
  pattern.interpolateStopAsDuplicateColor();
  let version = VERSION_1;
  if (settings && settings.version !== undefined && settings.version !== null) {
    version = Number(settings.version);
  }
  const w = new BinWriter();
  if (version === VERSION_6) writeVersion6(pattern, w);
  else writeVersion1(pattern, w);
  return w.toBuffer();
}

module.exports = { read, readPec, write, WRITE_SETTINGS };
