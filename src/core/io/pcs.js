'use strict';
// Pfaff PCS (issue #18) — leitura e gravação.
// Leitura portada de pystitch (MIT, inkstitch/pystitch) — PcsReader.py.
//
// Nota importante: o pystitch NÃO tem um PcsWriter (só existe PcsReader.py;
// não há "writer" registrado para "pcs" em __init__.py, nem no pyembroidery
// original). A gravação abaixo foi escrita do zero, seguindo estritamente o
// layout que o PcsReader espera (ver comentários), para que o resultado seja
// lido de volta tanto pelo nosso leitor quanto pelo do pystitch.
//
// Formato: sem compressão, posições ABSOLUTAS em 24 bits (não há limite
// prático de comprimento de ponto/salto). Unidade nativa do arquivo = unidade
// do Pattern (0,1 mm) dividida por 5/3 (PC_SIZE_CONVERSION_RATIO).

const C = require('../commands');
const { BinReader, BinWriter, signed24 } = require('../binary');
const { Thread } = require('../pattern');

const PC_SIZE_CONVERSION_RATIO = 5.0 / 3.0;

function read(buf, out) {
  const r = new BinReader(buf);
  r.u8(); // version
  r.u8(); // hoop_size (0 PCD · 1 PCQ/MAXI · 2 PCS bastidor pequeno · 3 PCS bastidor grande)
  const colorCount = r.u16le() || 0;
  for (let i = 0; i < colorCount; i++) {
    const thread = new Thread();
    const rgb = r.u24be();
    thread.color = rgb === null ? 0 : rgb & 0xffffff;
    out.addThread(thread);
    r.skip(1);
  }

  r.u16le(); // stitch_count (não usado pelo leitor — apenas informativo)
  for (;;) {
    const c0 = r.u8();
    let x = r.u24le();
    const c1 = r.u8();
    let y = r.u24le();
    const ctrl = r.u8();
    if (ctrl === null) break;
    x = signed24(x) * PC_SIZE_CONVERSION_RATIO;
    y = -signed24(y) * PC_SIZE_CONVERSION_RATIO;
    if (ctrl === 0x00) {
      out.stitchAbs(x, y);
      continue;
    }
    if (ctrl & 0x01) {
      out.colorChange();
      continue;
    }
    if (ctrl & 0x04) {
      out.moveAbs(x, y);
      continue;
    }
    break; // controle não reconhecido
  }
  out.end();
}

// ---------------------------------------------------------------- write

// Sem limite de comprimento de ponto/salto: as posições são absolutas em 24
// bits (± ~8 388 607 unidades nativas, bem além de qualquer bastidor real).
const WRITE_SETTINGS = {
  full_jump: true,
  round: true,
  max_jump: Infinity,
  max_stitch: Infinity,
  sequin_contingency: C.CONTINGENCY_SEQUIN_JUMP,
};

function write(pattern) {
  pattern.fixColorCount();
  const w = new BinWriter();
  w.u8(1); // version (arbitrário — o leitor não valida este campo)
  w.u8(3); // hoop_size: bastidor grande

  w.u16le(pattern.threadlist.length);
  for (const thread of pattern.threadlist) {
    const t = thread || new Thread(0);
    w.u24be(t.color);
    w.u8(0);
  }

  const stitchCount = pattern.countStitchCommands(C.STITCH);
  w.u16le(stitchCount);

  for (const stitch of pattern.stitches) {
    const flags = stitch[2] & C.COMMAND_MASK;
    let ctrl;
    if (flags === C.STITCH) ctrl = 0x00;
    else if (flags === C.COLOR_CHANGE) ctrl = 0x01;
    else if (flags === C.JUMP) ctrl = 0x04;
    else continue; // TRIM/STOP/SEQUIN_*/END: sem representação no PCS

    const x = Math.round(stitch[0] / PC_SIZE_CONVERSION_RATIO);
    const y = Math.round(-stitch[1] / PC_SIZE_CONVERSION_RATIO);
    w.u8(0); // c0 (não usado pelo leitor)
    w.u24le(x);
    w.u8(0); // c1 (não usado pelo leitor)
    w.u24le(y);
    w.u8(ctrl);
  }
  // Sem marcador de fim: o leitor para ao encontrar EOF exatamente na
  // fronteira de um registro (ver PcsReader.py: `if ctrl is None: break`).
  return w.toBuffer();
}

module.exports = { read, write, WRITE_SETTINGS };
