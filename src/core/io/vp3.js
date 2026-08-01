'use strict';
// Husqvarna/Pfaff VP3 (issue #18).
// Portado de pystitch (MIT, inkstitch/pystitch) — Vp3Reader.py / Vp3Writer.py.
// Formato big-endian, com blocos aninhados prefixados por "distância até o fim
// do bloco" (em vez de tamanho total). Unidade nativa do arquivo é 1/100 da
// unidade do Pattern (0,1 mm) — ou seja, 0,001 mm por passo bruto.

const C = require('../commands');
const { BinReader, BinWriter, signed16 } = require('../binary');
const { Thread } = require('../pattern');

// ---------------------------------------------------------------- helpers

function signed32(v) {
  v = v >>> 0;
  return v > 0x7fffffff ? v - 0x100000000 : v;
}

// Strings do cabeçalho (UTF-16BE): tamanho em bytes (16be) + texto. São
// sempre descartadas na leitura (nunca guardadas no Pattern) — replicamos
// esse "skip" fiel ao pystitch (skip_vp3_string).
function skipVp3String(r) {
  const len = r.u16be();
  if (len === null) return;
  r.skip(len);
}

function writeVp3String16(w, s) {
  const bytes = Buffer.from(String(s), 'utf16le').swap16(); // UTF-16BE
  w.u16be(bytes.length);
  for (const b of bytes) w.u8(b);
}

// Strings do corpo (catalog/description/brand): tamanho em BYTES (16be) +
// UTF-8. Nota de fidelidade (mesmo bug do PES, ver src/core/io/pes.js): o
// pystitch grava len(string) em CARACTERES mas lê como bytes — desalinha para
// texto não-ASCII (ex.: "Bordô"). Aqui gravamos o nº de bytes UTF-8, que é o
// que o leitor (nosso e o do pystitch) realmente espera.
function readVp3String8(r) {
  const len = r.u16be();
  if (len === null || len === 0) return len === 0 ? '' : null;
  return r.str(len, 'utf8');
}

function writeVp3String8(w, s) {
  const bytes = Buffer.from(String(s == null ? '' : s), 'utf8');
  w.u16be(bytes.length);
  for (const b of bytes) w.u8(b);
}

// ---------------------------------------------------------------- read

function vp3ReadThread(r) {
  const thread = new Thread();
  const colors = r.u8();
  r.u8(); // transition
  for (let m = 0; m < (colors || 0); m++) {
    const rgb = r.u24be();
    thread.color = rgb === null ? 0 : rgb & 0xffffff;
    r.u8(); // parts
    r.u16be(); // color_length
  }
  r.u8(); // thread_type
  r.u8(); // weight
  thread.catalogNumber = readVp3String8(r);
  thread.description = readVp3String8(r);
  thread.brand = readVp3String8(r);
  return thread;
}

function vp3ReadColorblock(r, out, centerX, centerY) {
  r.skip(3); // \x00\x05\x00
  const distanceToNext = r.u32be();
  const blockEndPosition = distanceToNext + r.tell();

  const startX = signed32(r.u32be()) / 100;
  const startY = -(signed32(r.u32be()) / 100);
  const absX = startX + centerX;
  const absY = startY + centerY;
  if (absX !== 0 && absY !== 0) out.moveAbs(absX, absY);

  const thread = vp3ReadThread(r);
  out.addThread(thread);
  r.skip(15);
  r.skip(3); // \x0A\xF6\x00

  const stitchByteLength = blockEndPosition - r.tell();
  let i = 0;
  while (i < stitchByteLength - 1) {
    const b0 = r.u8();
    const b1 = r.u8();
    if (b0 === null || b1 === null) break;
    i += 2;
    if (b0 !== 0x80) {
      out.stitch(signedByte(b0), signedByte(b1));
      continue;
    }
    if (b1 === 0x01) {
      const xhi = r.u8();
      const xlo = r.u8();
      i += 2;
      const yhi = r.u8();
      const ylo = r.u8();
      i += 2;
      if (xhi === null || yhi === null || ylo === null) break;
      const x = signed16((xhi << 8) | xlo);
      const y = signed16((yhi << 8) | ylo);
      out.stitch(x, y);
      r.skip(2); // marcador final (tipicamente \x80\x02), ignorado
      i += 2;
    } else if (b1 === 0x02) {
      // sem efeito conhecido
    } else if (b1 === 0x03) {
      out.trim();
    }
  }
  // O pystitch lê o bloco inteiro (stitch_byte_length bytes) de uma vez para
  // um array antes de percorrê-lo — por construção, o cursor sempre termina
  // exatamente em blockEndPosition, mesmo quando o laço para 1 byte antes (a
  // condição "i < tamanho - 1" deliberadamente deixa de examinar o último
  // byte solto). Nossa leitura é em fluxo (sem essa pré-carga), então
  // precisamos reposicionar explicitamente para não desalinhar o bloco
  // seguinte.
  r.seek(blockEndPosition);
}

function signedByte(b) {
  return b > 127 ? b - 256 : b;
}

function read(buf, out) {
  const r = new BinReader(buf);
  r.skip(6); // magic: "%vsm%\0"
  skipVp3String(r); // "Produced by     Software Ltd"
  r.skip(7);
  skipVp3String(r); // notas/comentários
  r.skip(32);
  const centerX = signed32(r.u32be()) / 100;
  const centerY = -(signed32(r.u32be()) / 100);
  r.skip(27);
  skipVp3String(r);
  r.skip(24);
  skipVp3String(r);
  const countColors = r.u16be();
  if (countColors === null) {
    out.end();
    return;
  }
  for (let i = 0; i < countColors; i++) {
    vp3ReadColorblock(r, out, centerX, centerY);
    if (i + 1 < countColors) out.colorChange();
  }
  out.end();
}

// ---------------------------------------------------------------- write

const WRITE_SETTINGS = {
  full_jump: false, // VP3 não tem comando de salto: é descartado (posição já muda no próximo ponto)
  round: true,
  max_jump: 3200,
  max_stitch: 255,
  sequin_contingency: C.CONTINGENCY_SEQUIN_JUMP,
};

// Segmentação específica do VP3 (Vp3Writer.get_as_colorblocks): diferente de
// Pattern.getAsColorblocks(), o próprio ponto de troca de cor vira o PRIMEIRO
// elemento do bloco seguinte (serve de âncora de posição), em vez de ficar no
// fim do bloco anterior.
function vp3GetAsColorblocks(pattern) {
  const blocks = [];
  let threadIndex = 0;
  let lastPos = 0;
  const stitches = pattern.stitches;
  for (let pos = 0; pos < stitches.length; pos++) {
    const command = stitches[pos][2] & C.COMMAND_MASK;
    if (command !== C.COLOR_CHANGE) continue;
    const thread = pattern.getThreadOrFiller(threadIndex++);
    blocks.push([stitches.slice(lastPos, pos), thread]);
    lastPos = pos;
  }
  const thread = pattern.getThreadOrFiller(threadIndex);
  blocks.push([stitches.slice(lastPos), thread]);
  return blocks;
}

function vp3WriteThread(w, thread) {
  w.u8(1); // um único segmento de cor
  w.u8(0); // sem transição
  w.u24be(thread.color);
  w.u8(0); // parts
  w.u16be(0); // color_length
  w.u8(5); // thread_type
  w.u8(0x28); // weight: Rayon 40
  writeVp3String8(w, thread.catalogNumber);
  writeVp3String8(w, thread.description !== null && thread.description !== undefined ? thread.description : thread.hex());
  writeVp3String8(w, thread.brand);
}

function writeStitchesBlock(w, stitches, firstPosX, firstPosY) {
  w.u8(0);
  w.u8(1);
  w.u8(0);
  const placeholder = w.tell();
  w.u32be(0);
  w.u8(0x0a);
  w.u8(0xf6);
  w.u8(0);

  let lastX = firstPosX;
  let lastY = firstPosY;
  for (const stitch of stitches) {
    const x = stitch[0];
    const y = stitch[1];
    const flags = stitch[2] & C.COMMAND_MASK;
    const alt = stitch[2] & C.FLAGS_MASK;
    if (flags === C.END) {
      w.u8(0x80);
      w.u8(0x03);
      break;
    } else if (flags === C.COLOR_CHANGE) {
      continue;
    } else if (flags === C.TRIM) {
      w.u8(0x80);
      w.u8(0x03);
      continue;
    } else if (flags === C.SEQUIN_MODE || flags === C.SEQUIN_EJECT || flags === C.STOP || flags === C.JUMP) {
      continue; // VP3 não tem esses comandos: posição avança sem gravar nada
    }
    const dx = Math.round(x - lastX);
    const dy = Math.round(y - lastY);
    lastX += dx;
    lastY += dy;
    if (flags === C.STITCH) {
      if (dx >= -127 && dx <= 127 && dy >= -127 && dy <= 127 && alt === 0) {
        w.u8(dx & 0xff);
        w.u8(dy & 0xff);
      } else {
        w.u8(0x80);
        w.u8(0x01);
        w.u16be(dx & 0xffff);
        w.u16be(dy & 0xffff);
        w.u8(0x80);
        w.u8(0x02);
      }
    }
  }
  w.patchU32be(placeholder, w.tell() - placeholder - 4);
}

function writeVp3Colorblock(w, first, centerX, centerY, stitches, thread) {
  w.u8(0);
  w.u8(5);
  w.u8(0);
  const placeholder = w.tell();
  w.u32be(0);

  let firstPosX = 0;
  let firstPosY = 0;
  let lastPosX = 0;
  let lastPosY = 0;
  if (stitches.length > 0) {
    firstPosX = stitches[0][0];
    firstPosY = stitches[0][1];
    if (first) {
      firstPosX = 0;
      firstPosY = 0;
    }
    lastPosX = stitches[stitches.length - 1][0];
    lastPosY = stitches[stitches.length - 1][1];
  }
  const startFromCenterX = firstPosX - centerX;
  const startFromCenterY = -(firstPosY - centerY);
  w.u32be(Math.trunc(startFromCenterX) * 100);
  w.u32be(Math.trunc(startFromCenterY) * 100);

  vp3WriteThread(w, thread);

  const blockShiftX = lastPosX - firstPosX;
  const blockShiftY = -(lastPosY - firstPosY);
  w.u32be(Math.trunc(blockShiftX) * 100);
  w.u32be(Math.trunc(blockShiftY) * 100);

  writeStitchesBlock(w, stitches, firstPosX, firstPosY);

  w.u8(0);
  w.patchU32be(placeholder, w.tell() - placeholder - 4);
}

function writeDesignBlock(w, extends_, colorblocks) {
  w.u8(0);
  w.u8(3);
  w.u8(0);
  const placeholder = w.tell();
  w.u32be(0);

  const width = extends_[2] - extends_[0];
  const height = extends_[3] - extends_[1];
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const centerX = extends_[2] - halfWidth;
  const centerY = extends_[3] - halfHeight;

  w.u32be(Math.trunc(centerX) * 100);
  w.u32be(Math.trunc(centerY) * -100);
  w.u8(0);
  w.u8(0);
  w.u8(0);

  w.u32be(Math.trunc(halfWidth) * -100);
  w.u32be(Math.trunc(halfWidth) * 100);
  w.u32be(Math.trunc(halfHeight) * -100);
  w.u32be(Math.trunc(halfHeight) * 100);

  w.u32be(Math.trunc(width) * 100);
  w.u32be(Math.trunc(height) * 100);
  writeVp3String16(w, '');

  w.u8(0x64);
  w.u8(0x64);
  w.u32be(4096);
  w.u32be(0);
  w.u32be(0);
  w.u32be(4096);

  w.str('xxPP');
  w.u8(1);
  w.u8(0);

  writeVp3String16(w, 'Produced by     Software Ltd');

  w.u16be(colorblocks.length);
  let first = true;
  for (const [stitches, thread] of colorblocks) {
    writeVp3Colorblock(w, first, centerX, centerY, stitches, thread);
    first = false;
  }
  w.patchU32be(placeholder, w.tell() - placeholder - 4);
}

function writeFile(pattern, w) {
  w.u8(0);
  w.u8(2);
  w.u8(0);
  const placeholder = w.tell();
  w.u32be(0);

  writeVp3String16(w, '');

  const colorblocks = vp3GetAsColorblocks(pattern);
  const extends_ = pattern.bounds();
  w.u32be(Math.trunc(extends_[2] * 100));
  w.u32be(Math.trunc(extends_[1] * -100));
  w.u32be(Math.trunc(extends_[0] * 100));
  w.u32be(Math.trunc(extends_[3] * -100));

  const ends = pattern.countStitchCommands(C.END);
  const countJustStitches = pattern.stitches.length - ends;
  w.u32be(countJustStitches);
  w.u8(0);
  w.u8(colorblocks.length);
  w.u8(0x0c);
  w.u8(0);

  w.u8(1); // count_designs
  writeDesignBlock(w, extends_, colorblocks);
  w.patchU32be(placeholder, w.tell() - placeholder - 4);
}

function write(pattern) {
  pattern.fixColorCount();
  const w = new BinWriter();
  w.str('%vsm%');
  w.u8(0);
  writeVp3String16(w, 'Produced by     Software Ltd');
  writeFile(pattern, w);
  return w.toBuffer();
}

module.exports = { read, write, WRITE_SETTINGS };
