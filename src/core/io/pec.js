'use strict';
// Brother PEC: bloco de pontos + miniaturas. writePec é reutilizável — o PES
// embute exatamente este bloco (sem o magic "#PEC0001", que é só do .pec avulso).
// Portado de pystitch (MIT, inkstitch/pystitch) — PecGraphics.py / PecWriter.py.

const C = require('../commands');
const { BinWriter } = require('../binary');
const { getPecThreadSet, buildUniquePalette } = require('../palettes');

const WRITE_SETTINGS = {
  full_jump: true,
  round: true,
  max_jump: 2047,
  max_stitch: 2047,
  sequin_contingency: C.CONTINGENCY_SEQUIN_JUMP,
};

const MASK_07_BIT = 0b01111111;
const JUMP_CODE = 0b00010000;
const TRIM_CODE = 0b00100000;
const PEC_ICON_WIDTH = 48;
const PEC_ICON_HEIGHT = 38;

// ---------------------------------------------------------- PecGraphics
// Só o necessário para o PecWriter (miniatura combinada + uma por cor).
// "blank" não é zerado: é a moldura decorativa que já vem com o ícone.

const BLANK_GRAPHIC = [
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0xff, 0xff, 0xff, 0xff, 0x0f,
  0x08, 0x00, 0x00, 0x00, 0x00, 0x10, 0x04, 0x00, 0x00, 0x00, 0x00, 0x20,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x04, 0x00, 0x00, 0x00, 0x00, 0x20, 0x08, 0x00, 0x00, 0x00, 0x00, 0x10,
  0xf0, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

function getBlank() {
  return BLANK_GRAPHIC.slice();
}

function graphicMarkBit(graphic, x, y, stride) {
  const idx = y * stride + Math.trunc(x / 8);
  if (idx < 0 || idx >= graphic.length) return; // fora dos limites: ignora (== IndexError silencioso do pystitch)
  const bit = ((x % 8) + 8) % 8; // módulo "estilo Python" (x pode ser negativo)
  graphic[idx] |= 1 << bit;
}

// extendsRect: [left, top, right, bottom]. O PecWriter só chama com bounds
// reais (nunca null), então o ramo "extends is None" do pystitch não existe aqui.
function drawScaled(extendsRect, points, graphic, stride, buffer = 5) {
  const [left, top, right, bottom] = extendsRect;
  let diagramWidth = right - left;
  let diagramHeight = bottom - top;
  const graphicWidth = stride * 8;
  const graphicHeight = graphic.length / stride;
  if (diagramWidth === 0) diagramWidth = 1;
  if (diagramHeight === 0) diagramHeight = 1;
  const scale = Math.min((graphicWidth - buffer) / diagramWidth, (graphicHeight - buffer) / diagramHeight);
  const cx = (right + left) / 2;
  const cy = (bottom + top) / 2;
  const translateX = -cx * scale + graphicWidth / 2;
  const translateY = -cy * scale + graphicHeight / 2;
  for (const point of points) {
    const gx = Math.floor(point[0] * scale + translateX);
    const gy = Math.floor(point[1] * scale + translateY);
    graphicMarkBit(graphic, gx, gy, stride);
  }
}

// ---------------------------------------------------------- PecWriter

function write(pattern) {
  pattern.fixColorCount();
  pattern.interpolateStopAsDuplicateColor();
  const w = new BinWriter();
  w.str('#PEC0001');
  writePec(pattern, w);
  return w.toBuffer();
}

// threadlistOverride: usado pelo PES versão 6, que já resolveu sua própria
// paleta (pattern.threadlist) antes de embutir o bloco PEC.
function writePec(pattern, w, threadlistOverride) {
  const extendsRect = pattern.bounds();
  let threadlist = threadlistOverride;
  if (!threadlist) {
    pattern.fixColorCount();
    threadlist = pattern.threadlist;
  }
  const colorInfo = writePecHeader(pattern, w, threadlist);
  writePecBlock(pattern, w, extendsRect);
  writePecGraphics(pattern, w, extendsRect);
  return colorInfo;
}

function writePecHeader(pattern, w, threadlist) {
  let name = String(pattern.getMetadata('name', 'Untitled'));
  name = name.replace(/[^A-Za-z0-9]+/g, '') || 'Untitled';
  w.str('LA:' + name.slice(0, 8).padEnd(16, ' ') + '\r');
  w.fill(12, 0x20);
  w.u8(0xff);
  w.u8(0x00);
  w.u8(Math.trunc(PEC_ICON_WIDTH / 8)); // stride do gráfico (6)
  w.u8(PEC_ICON_HEIGHT); // altura do gráfico (38)

  const threadSet = getPecThreadSet();
  const colorIndexList = buildUniquePalette(threadSet, pattern.threadlist);
  const rgbList = threadlist.map((t) => (t ? t.color : 0));

  const currentThreadCount = colorIndexList.length;
  if (currentThreadCount !== 0) {
    w.fill(12, 0x20);
    const addValue = currentThreadCount - 1;
    colorIndexList.unshift(addValue);
    if (colorIndexList[0] > 255) {
      throw new Error(`Muitas trocas de cor para o PEC: ${colorIndexList.length} (limite 256).`);
    }
    for (const b of colorIndexList) w.u8(b);
  } else {
    for (const b of [0x20, 0x20, 0x20, 0x20, 0x64, 0x20, 0x00, 0x20, 0x00, 0x20, 0x20, 0x20, 0xff]) w.u8(b);
  }
  for (let i = currentThreadCount; i < 463; i++) w.u8(0x20);
  return [colorIndexList, rgbList];
}

function writePecBlock(pattern, w, extendsRect) {
  const width = extendsRect[2] - extendsRect[0];
  const height = extendsRect[3] - extendsRect[1];
  const stitchBlockStart = w.tell();
  w.u8(0x00);
  w.u8(0x00);
  w.u24le(0); // reserva o tamanho do bloco, corrigido depois
  w.u8(0x31);
  w.u8(0xff);
  w.u8(0xf0);
  w.u16le(Math.round(width));
  w.u16le(Math.round(height));
  w.u16le(0x1e0);
  w.u16le(0x1b0);
  writeJump(w, -Math.round(extendsRect[0]), -Math.round(extendsRect[1]));
  pecEncode(pattern, w);
  const stitchBlockLength = w.tell() - stitchBlockStart;
  w.patchU24le(stitchBlockStart + 2, stitchBlockLength);
}

function writePecGraphics(pattern, w, extendsRect) {
  const blank = getBlank();
  for (const block of pattern.getAsStitchblock()) {
    drawScaled(extendsRect, block[0], blank, 6, 4);
  }
  for (const b of blank) w.u8(b);

  for (const block of pattern.getAsColorblocks()) {
    const stitches = block[0].filter((s) => s[2] === C.STITCH);
    const colorBlank = getBlank();
    drawScaled(extendsRect, stitches, colorBlank, 6);
    for (const b of colorBlank) w.u8(b);
  }
}

function writeValue(w, value, long, flag = 0) {
  if (!long && value > -64 && value < 63) {
    w.u8(value & MASK_07_BIT);
    return;
  }
  value &= 0b0000111111111111;
  value |= 0b1000000000000000;
  value |= flag << 8;
  w.u8((value >> 8) & 0xff);
  w.u8(value & 0xff);
}

function writeTrimjump(w, dx, dy) {
  writeValue(w, dx, true, TRIM_CODE);
  writeValue(w, dy, true, TRIM_CODE);
}

function writeJump(w, dx, dy) {
  writeValue(w, dx, true, JUMP_CODE);
  writeValue(w, dy, true, JUMP_CODE);
}

// GROUP_LONG do pystitch é sempre False: cada eixo escolhe forma curta/longa
// independentemente (não força os dois juntos).
function writeStitch(w, dx, dy) {
  writeValue(w, dx, false);
  writeValue(w, dy, false);
}

function pecEncode(pattern, w) {
  let colorTwo = true;
  let jumping = true;
  let init = true;
  let xx = 0;
  let yy = 0;
  for (const stitch of pattern.stitches) {
    const x = stitch[0];
    const y = stitch[1];
    const data = stitch[2] & C.COMMAND_MASK;
    const dx = Math.round(x - xx);
    const dy = Math.round(y - yy);
    xx += dx;
    yy += dy;
    if (data === C.STITCH) {
      if (jumping) {
        if (dx !== 0 && dy !== 0) writeStitch(w, 0, 0);
        jumping = false;
      }
      writeStitch(w, dx, dy);
    } else if (data === C.JUMP) {
      jumping = true;
      if (init) writeJump(w, dx, dy);
      else writeTrimjump(w, dx, dy);
    } else if (data === C.COLOR_CHANGE) {
      if (jumping) {
        writeStitch(w, 0, 0);
        jumping = false;
      }
      w.u8(0xfe);
      w.u8(0xb0);
      w.u8(colorTwo ? 0x02 : 0x01);
      colorTwo = !colorTwo;
    } else if (data === C.STOP) {
      // já convertido em troca de cor duplicada antes de chegar aqui (fallback silencioso).
    } else if (data === C.TRIM) {
      // PEC não grava corte explícito: o corte é implícito no salto seguinte.
    } else if (data === C.END) {
      w.u8(0xff);
      break;
    }
    init = false;
  }
}

module.exports = { write, writePec, WRITE_SETTINGS, getBlank, drawScaled };
