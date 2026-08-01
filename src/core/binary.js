'use strict';
// Leitura/escrita binária com a mesma semântica dos helpers do pystitch
// (ReadHelper.py / WriteHelper.py): leituras além do fim retornam null.

function signed8(b) {
  return b > 127 ? b - 256 : b;
}

function signed16(v) {
  v &= 0xffff;
  return v > 0x7fff ? v - 0x10000 : v;
}

function signed24(v) {
  v &= 0xffffff;
  return v > 0x7fffff ? v - 0x1000000 : v;
}

class BinReader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  get length() {
    return this.buf.length;
  }

  tell() {
    return this.pos;
  }

  seek(p) {
    this.pos = p;
  }

  skip(n) {
    this.pos += n;
  }

  eof() {
    return this.pos >= this.buf.length;
  }

  u8() {
    if (this.pos + 1 > this.buf.length) return null;
    return this.buf[this.pos++];
  }

  s8() {
    const v = this.u8();
    return v === null ? null : signed8(v);
  }

  u16le() {
    if (this.pos + 2 > this.buf.length) return null;
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  u16be() {
    if (this.pos + 2 > this.buf.length) return null;
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  u24le() {
    if (this.pos + 3 > this.buf.length) return null;
    const v = this.buf.readUIntLE(this.pos, 3);
    this.pos += 3;
    return v;
  }

  u24be() {
    if (this.pos + 3 > this.buf.length) return null;
    const v = this.buf.readUIntBE(this.pos, 3);
    this.pos += 3;
    return v;
  }

  u32le() {
    if (this.pos + 4 > this.buf.length) return null;
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  u32be() {
    if (this.pos + 4 > this.buf.length) return null;
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  bytes(n) {
    const end = Math.min(this.pos + n, this.buf.length);
    const b = this.buf.subarray(this.pos, end);
    this.pos = end;
    return b;
  }

  str(n, encoding = 'utf8') {
    const b = this.bytes(n);
    if (b.length === 0) return null;
    return b.toString(encoding);
  }
}

class BinWriter {
  constructor() {
    this.bytes = [];
  }

  tell() {
    return this.bytes.length;
  }

  u8(v) {
    this.bytes.push(v & 0xff);
  }

  u16le(v) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff);
  }

  u16be(v) {
    this.bytes.push((v >> 8) & 0xff, v & 0xff);
  }

  u24le(v) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff);
  }

  u32le(v) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  }

  u32be(v) {
    this.bytes.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }

  str(s, encoding = 'utf8') {
    for (const b of Buffer.from(s, encoding)) this.bytes.push(b);
  }

  fill(n, v = 0) {
    for (let i = 0; i < n; i++) this.bytes.push(v & 0xff);
  }

  patchU32le(pos, v) {
    this.bytes[pos] = v & 0xff;
    this.bytes[pos + 1] = (v >> 8) & 0xff;
    this.bytes[pos + 2] = (v >> 16) & 0xff;
    this.bytes[pos + 3] = (v >> 24) & 0xff;
  }

  toBuffer() {
    return Buffer.from(this.bytes);
  }
}

module.exports = { BinReader, BinWriter, signed8, signed16, signed24 };
