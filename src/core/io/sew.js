'use strict';
// Janome SEW (issue #18) — leitura.
// Portado de pystitch (MIT, inkstitch/pystitch) — SewReader.py / EmbThreadSew.py.
// Formato simples, sem compressão: cabeçalho com paleta (índices numa tabela
// de fábrica de 79 cores) e pontos a partir do offset fixo 0x1D78.

const { BinReader, signed8 } = require('../binary');
const { getSewThreadSet } = require('../palettes');

const STITCH_OFFSET = 0x1d78;

function readSewStitches(r, out) {
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
    if (control & 1) {
      // A posição do segundo par (c0, c1) é descartada — fiel ao pystitch.
      out.colorChange();
      continue;
    }
    if (control === 0x04 || control === 0x02) {
      out.move(signed8(c0), -signed8(c1));
      continue;
    }
    if (control === 0x10) {
      out.stitch(signed8(c0), -signed8(c1));
      continue;
    }
    break; // controle desconhecido
  }
  out.end();
}

function read(buf, out) {
  const r = new BinReader(buf);
  const threads = getSewThreadSet();
  const colors = r.u16le() || 0;
  for (let c = 0; c < colors; c++) {
    const index = r.u16le();
    if (index === null) break;
    out.addThread(threads[index % threads.length]);
  }

  r.seek(STITCH_OFFSET);
  readSewStitches(r, out);
}

module.exports = { read };
