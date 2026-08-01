'use strict';
// Descompressão usada pelo HUS (Husqvarna) — porte fiel de EmbCompress.py
// (pystitch, MIT, inkstitch/pystitch). É um esquema Huffman canônico + LZ77
// (no estilo clássico "LZH"): cada bloco traz três tabelas de Huffman —
// "comprimento de código" (meta-tabela), "caractere" (literais 0-255 +
// referências de repetição 256-509 + fim-de-fluxo 510) e "distância" — e os
// tokens do bloco são decodificados por essas tabelas.
//
// Nota: o pystitch expõe também um `compress()` (EmbCompress.py), mas ele só
// escreve um cabeçalho de 6 bytes na frente dos dados CRUS — não implementa a
// codificação Huffman/LZ real, então NÃO é o inverso de `expand`. O próprio
// teste do pystitch para isso existe mas está marcado `@unittest.skip` no
// repositório (test/test_read_hus.py: test_fake_compression), confirmando que
// os mantenedores sabem que esse roundtrip está quebrado. Por isso o Bastidor
// só porta a DEcompressão (o que basta para leitura de .hus reais) — a
// gravação de fixtures de teste usa um codificador equivalente à parte,
// mantido fora do app (ver tools/pystitch-fixtures/), nunca este arquivo.

class BitSource {
  constructor(data) {
    this.data = data;
    this.bitPosition = 0;
  }

  getBits(startPosInBits, length) {
    const endPosInBits = startPosInBits + length - 1;
    const startByte = (startPosInBits / 8) | 0;
    const endByte = (endPosInBits / 8) | 0;
    let value = 0;
    for (let i = startByte; i <= endByte; i++) {
      value = (value << 8) | (this.data[i] || 0);
    }
    const unusedBitsRight = (8 - ((endPosInBits + 1) % 8)) % 8;
    const mask = (1 << length) - 1;
    return (value >>> unusedBitsRight) & mask;
  }

  peek(bitCount) {
    return this.getBits(this.bitPosition, bitCount);
  }

  pop(bitCount) {
    const v = this.peek(bitCount);
    this.slide(bitCount);
    return v;
  }

  slide(bitCount) {
    this.bitPosition += bitCount;
  }

  readVariableLength() {
    let m = this.pop(3);
    if (m !== 7) return m;
    for (let q = 0; q < 13; q++) {
      const s = this.pop(1);
      if (s === 1) m += 1;
      else break;
    }
    return m;
  }
}

class Huffman {
  constructor(lengths = null, value = 0) {
    this.defaultValue = value;
    this.lengths = lengths;
    this.table = null;
    this.tableWidth = 0;
  }

  // Constrói a tabela plana de decodificação (Huffman canônico: códigos mais
  // curtos primeiro, e dentro do mesmo comprimento, em ordem crescente de
  // índice de símbolo — quem ganha empate é o de MENOR índice).
  buildTable() {
    this.tableWidth = Math.max(...this.lengths);
    this.table = [];
    let size = 1 << this.tableWidth;
    for (let bitLength = 1; bitLength <= this.tableWidth; bitLength++) {
      size = size / 2;
      for (let lenIndex = 0; lenIndex < this.lengths.length; lenIndex++) {
        if (this.lengths[lenIndex] === bitLength) {
          for (let k = 0; k < size; k++) this.table.push(lenIndex);
        }
      }
    }
  }

  lookup(byteLookup) {
    if (this.table === null) return [this.defaultValue, 0];
    const v = this.table[byteLookup >>> (16 - this.tableWidth)];
    return [v, this.lengths[v]];
  }
}

class EmbCompress {
  constructor() {
    this.bits = null;
    this.blockElements = 0;
    this.characterHuffman = null;
    this.distanceHuffman = null;
  }

  loadCharacterLengthHuffman() {
    const count = this.bits.pop(5);
    if (count === 0) {
      const v = this.bits.pop(5);
      return new Huffman(null, v);
    }
    const lengths = new Array(count).fill(0);
    let index = 0;
    while (index < count) {
      if (index === 3) index += this.bits.pop(2);
      lengths[index] = this.bits.readVariableLength();
      index += 1;
    }
    const huffman = new Huffman(lengths, 8);
    huffman.buildTable();
    return huffman;
  }

  loadCharacterHuffman(lengthHuffman) {
    const count = this.bits.pop(9);
    if (count === 0) {
      const v = this.bits.pop(9);
      return new Huffman(null, v);
    }
    const lengths = new Array(count).fill(0);
    let index = 0;
    while (index < count) {
      const [c0, len] = lengthHuffman.lookup(this.bits.peek(16));
      this.bits.slide(len);
      let c = c0;
      if (c === 0) {
        index += 1;
      } else if (c === 1) {
        c = 3 + this.bits.pop(4);
        index += c;
      } else if (c === 2) {
        c = 20 + this.bits.pop(9);
        index += c;
      } else {
        c -= 2;
        lengths[index] = c;
        index += 1;
      }
    }
    const huffman = new Huffman(lengths);
    huffman.buildTable();
    return huffman;
  }

  loadDistanceHuffman() {
    const count = this.bits.pop(5);
    if (count === 0) {
      const v = this.bits.pop(5);
      return new Huffman(null, v);
    }
    const lengths = new Array(count).fill(0);
    for (let i = 0; i < count; i++) {
      lengths[i] = this.bits.readVariableLength();
    }
    const huffman = new Huffman(lengths);
    huffman.buildTable();
    return huffman;
  }

  loadBlock() {
    this.blockElements = this.bits.pop(16);
    const lengthHuffman = this.loadCharacterLengthHuffman();
    this.characterHuffman = this.loadCharacterHuffman(lengthHuffman);
    this.distanceHuffman = this.loadDistanceHuffman();
  }

  getToken() {
    if (this.blockElements <= 0) this.loadBlock();
    this.blockElements -= 1;
    const [v, len] = this.characterHuffman.lookup(this.bits.peek(16));
    this.bits.slide(len);
    return v;
  }

  getPosition() {
    const [v0, len] = this.distanceHuffman.lookup(this.bits.peek(16));
    this.bits.slide(len);
    if (v0 === 0) return 0;
    const v = v0 - 1;
    return (1 << v) + this.bits.pop(v);
  }

  decompress(inputData, uncompressedSize) {
    this.bits = new BitSource(inputData);
    const output = [];
    this.blockElements = -1;
    const bitsTotal = inputData.length * 8;
    while (
      bitsTotal > this.bits.bitPosition &&
      (uncompressedSize === null || uncompressedSize === undefined || output.length <= uncompressedSize)
    ) {
      const character = this.getToken();
      if (character <= 255) {
        output.push(character);
      } else if (character === 510) {
        break;
      } else {
        const length = character - 253; // comprimento mínimo é 3 (256-253)
        const back = this.getPosition() + 1;
        const position = output.length - back;
        // O pystitch faz uma cópia em bloco quando as faixas não se sobrepõem
        // (back > length) e byte-a-byte caso contrário (LZ77 com sobreposição
        // permitida). Aqui sempre copiamos byte-a-byte: dá o mesmo resultado
        // nos dois casos e simplifica o porte. Em fluxo corrompido (back maior
        // que os dados já produzidos, position negativo), o pystitch lê "de
        // trás para frente" da lista Python (índice negativo) — aqui isso
        // resulta em `undefined`/NaN em vez desse efeito acidental; não é um
        // comportamento real do formato, então não foi replicado.
        for (let k = 0; k < length; k++) {
          output.push(output[position + k]);
        }
      }
    }
    return output;
  }
}

function expand(data, uncompressedSize) {
  const emb = new EmbCompress();
  return emb.decompress(data, uncompressedSize);
}

module.exports = { expand, EmbCompress, Huffman, BitSource };
