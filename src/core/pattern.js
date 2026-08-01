'use strict';
// Modelo de matriz de bordado (pontos + fios + metadados).
// Portado de pystitch (MIT, inkstitch/pystitch) — EmbPattern.py / EmbThread.py.
// Unidades nativas: 1 unidade = 0,1 mm. Y cresce para baixo.

const C = require('./commands');

// Cores de preenchimento determinísticas para blocos sem fio definido
// (pystitch usa cor aleatória; aqui é estável entre aberturas).
const FILLER_COLORS = [
  0xc94f4f, 0x4f7dc9, 0x4fc98a, 0xc9b44f, 0x9a4fc9, 0xc9784f,
  0x4fc4c9, 0xc94f9e, 0x7dc94f, 0x5e5ec9, 0x8a6f52, 0x4f9ac9,
];

class Thread {
  constructor(init) {
    this.color = 0x000000;
    this.description = null;
    this.catalogNumber = null;
    this.brand = null;
    this.chart = null;
    if (init !== undefined && init !== null) this.set(init);
  }

  set(init) {
    if (init instanceof Thread) {
      this.color = init.color;
      this.description = init.description;
      this.catalogNumber = init.catalogNumber;
      this.brand = init.brand;
      this.chart = init.chart;
      return;
    }
    if (typeof init === 'number') {
      this.color = init & 0xffffff;
      return;
    }
    if (typeof init === 'string') {
      this.color = parseHexColor(init);
      return;
    }
    if (typeof init === 'object') {
      if (init.hex !== undefined) this.color = parseHexColor(init.hex);
      if (init.color !== undefined) {
        this.color = typeof init.color === 'string' ? parseHexColor(init.color) : init.color & 0xffffff;
      }
      if (init.description !== undefined) this.description = init.description;
      if (init.catalog !== undefined) this.catalogNumber = init.catalog;
      if (init.catalogNumber !== undefined) this.catalogNumber = init.catalogNumber;
      if (init.brand !== undefined) this.brand = init.brand;
      if (init.chart !== undefined) this.chart = init.chart;
    }
  }

  red() {
    return (this.color >> 16) & 0xff;
  }

  green() {
    return (this.color >> 8) & 0xff;
  }

  blue() {
    return this.color & 0xff;
  }

  hex() {
    return '#' + this.color.toString(16).padStart(6, '0');
  }
}

function parseHexColor(s) {
  s = String(s).trim().replace(/^#/, '').replace(/^0x/i, '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const v = parseInt(s, 16);
  return Number.isNaN(v) ? 0 : v & 0xffffff;
}

class Pattern {
  constructor() {
    this.stitches = []; // [x, y, comando]
    this.threadlist = []; // Thread | null (JEF usa null como marcador de STOP)
    this.extras = {};
    this._previousX = 0;
    this._previousY = 0;
  }

  addStitchAbs(cmd, x = 0, y = 0) {
    this.stitches.push([x, y, cmd]);
    this._previousX = x;
    this._previousY = y;
  }

  addStitchRel(cmd, dx = 0, dy = 0) {
    this.addStitchAbs(cmd, this._previousX + dx, this._previousY + dy);
  }

  insertStitchRel(position, cmd, dx = 0, dy = 0) {
    if (position < 0) position += this.stitches.length;
    if (position === 0) {
      this.stitches.unshift([dx, dy, cmd]);
    } else if (position === this.stitches.length || position == null) {
      this.addStitchRel(cmd, dx, dy);
    } else if (position > 0 && position < this.stitches.length) {
      const p = this.stitches[position - 1];
      this.stitches.splice(position, 0, [p[0] + dx, p[1] + dy, cmd]);
    }
  }

  move(dx = 0, dy = 0, position = null) {
    if (position === null) this.addStitchRel(C.JUMP, dx, dy);
    else this.insertStitchRel(position, C.JUMP, dx, dy);
  }

  moveAbs(x, y) {
    this.addStitchAbs(C.JUMP, x, y);
  }

  stitch(dx = 0, dy = 0) {
    this.addStitchRel(C.STITCH, dx, dy);
  }

  stitchAbs(x, y) {
    this.addStitchAbs(C.STITCH, x, y);
  }

  stop(dx = 0, dy = 0) {
    this.addStitchRel(C.STOP, dx, dy);
  }

  trim(dx = 0, dy = 0, position = null) {
    if (position === null) this.addStitchRel(C.TRIM, dx, dy);
    else this.insertStitchRel(position, C.TRIM, dx, dy);
  }

  colorChange(dx = 0, dy = 0) {
    this.addStitchRel(C.COLOR_CHANGE, dx, dy);
  }

  sequinMode(dx = 0, dy = 0) {
    this.addStitchRel(C.SEQUIN_MODE, dx, dy);
  }

  sequinEject(dx = 0, dy = 0) {
    this.addStitchRel(C.SEQUIN_EJECT, dx, dy);
  }

  end(dx = 0, dy = 0) {
    this.addStitchRel(C.END, dx, dy);
  }

  addThread(thread) {
    if (thread === null || thread === undefined) {
      this.threadlist.push(null);
      return;
    }
    this.threadlist.push(thread instanceof Thread ? thread : new Thread(thread));
  }

  metadata(name, data) {
    this.extras[name] = data;
  }

  getMetadata(name, fallback = null) {
    return this.extras[name] !== undefined ? this.extras[name] : fallback;
  }

  // Posição atual da agulha (fim da última agulhada/salto/etc. gravada, ou
  // [0,0] se o Pattern ainda estiver vazio) — usada pelo roteamento de
  // preenchimento por região (src/core/digitize/regions.js) pra ordenar as
  // regiões a partir de onde a agulha realmente está, em vez de sempre
  // recomeçar do zero a cada bloco de cor/glifo.
  currentPosition() {
    return [this._previousX, this._previousY];
  }

  bounds() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const st of this.stitches) {
      if (st[0] > maxX) maxX = st[0];
      if (st[0] < minX) minX = st[0];
      if (st[1] > maxY) maxY = st[1];
      if (st[1] < minY) minY = st[1];
    }
    return [minX, minY, maxX, maxY];
  }

  countStitchCommands(command) {
    let count = 0;
    for (const st of this.stitches) {
      if ((st[2] & C.COMMAND_MASK) === command) count++;
    }
    return count;
  }

  countColorChanges() {
    return this.countStitchCommands(C.COLOR_CHANGE);
  }

  countStitches() {
    return this.stitches.length;
  }

  getThreadOrFiller(index) {
    const t = this.threadlist.length > index ? this.threadlist[index] : null;
    if (t) return t;
    // Sem descrição: o rótulo localizado fica por conta da interface.
    return new Thread(FILLER_COLORS[index % FILLER_COLORS.length]);
  }

  // Gera blocos de cor: [fatiaDePontos, fio]. Blocos delimitados por
  // COLOR_CHANGE incluem o próprio comando no fim do bloco (igual ao pystitch).
  getAsColorblocks() {
    const blocks = [];
    let threadIndex = 0;
    let start = 0;
    for (let pos = 0; pos < this.stitches.length; pos++) {
      const command = this.stitches[pos][2] & C.COMMAND_MASK;
      if (command === C.COLOR_BREAK) {
        if (start !== pos) {
          blocks.push([this.stitches.slice(start, pos), this.getThreadOrFiller(threadIndex++)]);
        }
        start = pos + 1;
        continue;
      }
      if (command === C.COLOR_CHANGE) {
        blocks.push([this.stitches.slice(start, pos + 1), this.getThreadOrFiller(threadIndex++)]);
        start = pos + 1;
      }
    }
    if (start !== this.stitches.length) {
      blocks.push([this.stitches.slice(start), this.getThreadOrFiller(threadIndex)]);
    }
    return blocks;
  }

  // Garante um fio para cada bloco de cor.
  fixColorCount() {
    let threadIndex = 0;
    let initColor = true;
    for (const st of this.stitches) {
      const data = st[2] & C.COMMAND_MASK;
      if (data === C.STITCH || data === C.SEW_TO || data === C.NEEDLE_AT) {
        if (initColor) {
          threadIndex++;
          initColor = false;
        }
      } else if (data === C.COLOR_CHANGE || data === C.COLOR_BREAK || data === C.NEEDLE_SET) {
        initColor = true;
      }
    }
    while (this.threadlist.length < threadIndex) {
      this.addThread(this.getThreadOrFiller(this.threadlist.length));
    }
  }

  // Blocos de ponto corrido separados por qualquer outro comando; troca de
  // fio só avança em COLOR_CHANGE (usado pelas miniaturas do PEC).
  getAsStitchblock() {
    const blocks = [];
    let stitchblock = [];
    let thread = this.getThreadOrFiller(0);
    let threadIndex = 1;
    for (const st of this.stitches) {
      const flags = st[2] & C.COMMAND_MASK;
      if (flags === C.STITCH) {
        stitchblock.push(st);
      } else {
        if (stitchblock.length > 0) {
          blocks.push([stitchblock, thread]);
          stitchblock = [];
        }
        if (flags === C.COLOR_CHANGE) {
          thread = this.getThreadOrFiller(threadIndex++);
        }
      }
    }
    if (stitchblock.length > 0) blocks.push([stitchblock, thread]);
    return blocks;
  }

  // Blocos de pontos consecutivos com o mesmo comando bruto (sem máscara),
  // usado para reconstituir os segmentos vetoriais do PES (CSewSeg).
  getAsCommandBlocks() {
    const blocks = [];
    let lastPos = 0;
    let lastCommand = C.NO_COMMAND;
    for (let pos = 0; pos < this.stitches.length; pos++) {
      const command = this.stitches[pos][2] & C.COMMAND_MASK;
      if (command === lastCommand || lastCommand === C.NO_COMMAND) {
        lastCommand = command;
        continue;
      }
      lastCommand = command;
      blocks.push(this.stitches.slice(lastPos, pos));
      lastPos = pos;
    }
    blocks.push(this.stitches.slice(lastPos));
    return blocks;
  }

  // Cores duplicadas consecutivas viram STOP (aplique) — usado pelo PES/PEC.
  interpolateDuplicateColorAsStop() {
    let threadIndex = 0;
    let initColor = true;
    let lastChange = null;
    for (let position = 0; position < this.stitches.length; position++) {
      const data = this.stitches[position][2] & C.COMMAND_MASK;
      if (data === C.STITCH || data === C.SEW_TO || data === C.NEEDLE_AT) {
        if (initColor) {
          if (lastChange !== null && threadIndex !== 0) {
            if (threadIndex >= this.threadlist.length) return;
            if (threadsEqual(this.threadlist[threadIndex - 1], this.threadlist[threadIndex])) {
              this.threadlist.splice(threadIndex, 1);
              this.stitches[lastChange][2] = C.STOP;
            } else {
              threadIndex++;
            }
          } else {
            threadIndex++;
          }
          initColor = false;
        }
      } else if (data === C.COLOR_CHANGE || data === C.COLOR_BREAK || data === C.NEEDLE_SET) {
        initColor = true;
        lastChange = position;
      }
    }
  }

  // Inverso da anterior: STOP passa a ser uma troca de cor duplicada (usado
  // ao gravar PEC/PES, que não têm o conceito de parada, só cores repetidas).
  interpolateStopAsDuplicateColor(threadChangeCommand = C.COLOR_CHANGE) {
    let threadIndex = 0;
    for (let position = 0; position < this.stitches.length; position++) {
      const data = this.stitches[position][2] & C.COMMAND_MASK;
      if (data === C.STITCH || data === C.SEW_TO || data === C.NEEDLE_AT) {
        continue;
      } else if (data === C.COLOR_CHANGE || data === C.COLOR_BREAK || data === C.NEEDLE_SET) {
        threadIndex++;
      } else if (data === C.STOP) {
        if (threadIndex >= this.threadlist.length) return; // sem fio para duplicar
        this.threadlist.splice(threadIndex, 0, this.threadlist[threadIndex]);
        this.stitches[position][2] = threadChangeCommand;
        threadIndex++;
      }
    }
  }

  // Insere TRIM conforme critérios (nº de saltos seguidos ou distância) e
  // remove saltos com deslocamento nulo (clipping). Porta fiel do pystitch.
  interpolateTrims(jumpsToRequireTrim = null, distanceToRequireTrim = null, clipping = true) {
    let i = -1;
    let ie = this.stitches.length - 1;
    let x = 0;
    let y = 0;
    let jumpCount = 0;
    let jumpStart = 0;
    let jumpDx = 0;
    let jumpDy = 0;
    let jumping = false;
    let trimmed = true;
    while (i < ie) {
      i++;
      const st = this.stitches[i];
      const dx = st[0] - x;
      const dy = st[1] - y;
      x = st[0];
      y = st[1];
      const command = st[2] & C.COMMAND_MASK;
      if (command === C.STITCH || command === C.SEQUIN_EJECT) {
        trimmed = false;
        jumping = false;
      } else if (command === C.COLOR_CHANGE || command === C.NEEDLE_SET || command === C.TRIM) {
        trimmed = true;
        jumping = false;
      }
      if (command === C.JUMP) {
        if (!jumping) {
          jumpDx = 0;
          jumpDy = 0;
          jumpCount = 0;
          jumpStart = i;
          jumping = true;
        }
        jumpCount++;
        jumpDx += dx;
        jumpDy += dy;
        if (!trimmed) {
          if (
            jumpCount === jumpsToRequireTrim ||
            (distanceToRequireTrim !== null &&
              (Math.abs(jumpDy) > distanceToRequireTrim || Math.abs(jumpDx) > distanceToRequireTrim))
          ) {
            this.trim(0, 0, jumpStart);
            jumpStart++;
            i++;
            ie++;
            trimmed = true;
          }
        }
        if (clipping && jumpDx === 0 && jumpDy === 0) {
          this.stitches.splice(jumpStart, i + 1 - jumpStart);
          i = jumpStart - 1;
          ie = this.stitches.length - 1;
        }
      }
    }
  }

  translate(dx, dy) {
    for (const st of this.stitches) {
      st[0] += dx;
      st[1] += dy;
    }
  }

  moveCenterToOrigin() {
    const b = this.bounds();
    const cx = Math.round((b[2] + b[0]) / 2);
    const cy = Math.round((b[3] + b[1]) / 2);
    this.translate(-cx, -cy);
  }

  getNormalizedPattern(settings) {
    const { Transcoder } = require('./encoder');
    const out = new Pattern();
    new Transcoder(settings).transcode(this, out);
    return out;
  }
}

function threadsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.color === b.color && a.description === b.description && a.catalogNumber === b.catalogNumber;
}

module.exports = { Pattern, Thread, FILLER_COLORS, parseHexColor, threadsEqual };
