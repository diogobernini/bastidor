'use strict';
// Husqvarna HUS (issue #18) — leitura.
// Portado de pystitch (MIT, inkstitch/pystitch) — HusReader.py / EmbThreadHus.py.
// Os pontos ficam em três fluxos comprimidos (comando, x, y) — ver
// src/core/huscompress.js para a descompressão (Huffman canônico + LZ77).

const { BinReader, signed8 } = require('../binary');
const { getHusThreadSet } = require('../palettes');
const { expand } = require('../huscompress');

function read(buf, out) {
  const r = new BinReader(buf);
  r.u32le(); // magic_code
  const numberOfStitches = r.u32le();
  const numberOfColors = r.u32le();

  if (!numberOfStitches) {
    throw new Error('HUS sem pontos: o arquivo parece corrompido.');
  }

  r.u16le(); // extend_pos_x
  r.u16le(); // extend_pos_y
  r.u16le(); // extend_neg_x
  r.u16le(); // extend_neg_y

  const commandOffset = r.u32le();
  const xOffset = r.u32le();
  const yOffset = r.u32le();

  r.str(8); // string_value (não usada)
  r.u16le(); // unknown_16_bit

  const husThreads = getHusThreadSet();
  for (let i = 0; i < (numberOfColors || 0); i++) {
    const index = r.u16le();
    // Fiel ao pystitch: indexa a paleta diretamente, sem módulo. Um índice
    // fora da faixa (arquivo corrompido) cai em `undefined` em vez de lançar
    // um IndexError como no Python — tratamos como fio desconhecido (preto).
    out.addThread(husThreads[index] || null);
  }

  r.seek(commandOffset);
  const commandCompressed = r.bytes(xOffset - commandOffset);
  r.seek(xOffset);
  const xCompressed = r.bytes(yOffset - xOffset);
  r.seek(yOffset);
  const yCompressed = r.bytes(r.length - yOffset);

  const commandDecompressed = expand(commandCompressed, numberOfStitches);
  const xDecompressed = expand(xCompressed, numberOfStitches);
  const yDecompressed = expand(yCompressed, numberOfStitches);

  const stitchCount = Math.min(commandDecompressed.length, xDecompressed.length, yDecompressed.length);

  for (let i = 0; i < stitchCount; i++) {
    const cmd = commandDecompressed[i];
    const x = signed8(xDecompressed[i]);
    const y = -signed8(yDecompressed[i]);
    if (cmd === 0x80) {
      out.stitch(x, y);
    } else if (cmd === 0x81) {
      out.move(x, y);
    } else if (cmd === 0x84) {
      out.colorChange(x, y);
    } else if (cmd === 0x88) {
      if (x !== 0 || y !== 0) out.move(x, y);
      out.trim();
    } else if (cmd === 0x90) {
      break;
    } else {
      break; // comando não mapeado
    }
  }
  out.end();
}

module.exports = { read };
