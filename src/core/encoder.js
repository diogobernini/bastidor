'use strict';
// Normalizador de padrões para gravação ("regulagens" de escrita):
// divide pontos/saltos longos, aplica arremates (tie-on/tie-off), trata
// lantejoulas e reconstroi a sequência de cores.
// Porta do Transcoder do pystitch (MIT, inkstitch/pystitch — EmbEncoder.py),
// sem os comandos de matriz/agulha que o Bastidor não produz.

const C = require('./commands');

class Transcoder {
  constructor(settings) {
    settings = settings || {};
    this.maxStitch = settings.max_stitch !== undefined ? settings.max_stitch : Infinity;
    this.maxJump = settings.max_jump !== undefined ? settings.max_jump : Infinity;
    this.fullJump = settings.full_jump || false;
    this.round = settings.round || false;
    this.writesSpeeds = settings.writes_speeds !== undefined ? settings.writes_speeds : true;
    this.explicitTrim = settings.explicit_trim || false;

    this.sequinContingency =
      settings.sequin_contingency !== undefined ? settings.sequin_contingency : C.CONTINGENCY_SEQUIN_JUMP;

    this.tieOnContingency = settings.tie_on !== undefined ? settings.tie_on : C.CONTINGENCY_TIE_ON_NONE;
    if (this.tieOnContingency === true) this.tieOnContingency = C.CONTINGENCY_TIE_ON_THREE_SMALL;
    if (this.tieOnContingency === false) this.tieOnContingency = C.CONTINGENCY_TIE_ON_NONE;

    this.tieOffContingency = settings.tie_off !== undefined ? settings.tie_off : C.CONTINGENCY_TIE_OFF_NONE;
    if (this.tieOffContingency === true) this.tieOffContingency = C.CONTINGENCY_TIE_OFF_THREE_SMALL;
    if (this.tieOffContingency === false) this.tieOffContingency = C.CONTINGENCY_TIE_OFF_NONE;

    this.longStitchContingency =
      settings.long_stitch_contingency !== undefined
        ? settings.long_stitch_contingency
        : C.CONTINGENCY_LONG_STITCH_JUMP_NEEDLE;

    this.source = null;
    this.dest = null;
    this.position = 0;
    this.orderIndex = -1;
    this.stateTrimmed = true;
    this.stateSequinMode = false;
    this.stateJumping = false;
    this.needleX = 0;
    this.needleY = 0;
    this.highFlags = 0;
  }

  transcode(source, dest) {
    this.source = source;
    this.dest = dest;
    Object.assign(dest.extras, source.extras);
    this.transcodeMain();
    return dest;
  }

  transcodeMain() {
    const source = this.source.stitches;
    this.stateTrimmed = true;
    this.needleX = 0;
    this.needleY = 0;
    this.position = 0;
    this.orderIndex = -1;

    let flags = C.NO_COMMAND;
    for (this.position = 0; this.position < source.length; this.position++) {
      const stitch = source[this.position];
      let x = stitch[0];
      let y = stitch[1];
      if (this.round) {
        x = Math.round(x);
        y = Math.round(y);
      }
      flags = stitch[2] & C.COMMAND_MASK;
      this.highFlags = stitch[2] & C.FLAGS_MASK;

      if (flags === C.NO_COMMAND) continue;

      if (flags === C.STITCH) {
        if (this.stateTrimmed) {
          this.declareNotTrimmed();
          this.jumpToWithinStitchrange(x, y);
          this.stitchAt(x, y);
          this.tieOn();
        } else if (this.stateJumping) {
          this.needleTo(x, y);
          this.stateJumping = false;
        } else {
          this.stitchWithContingency(x, y);
        }
      } else if (flags === C.STITCH_BREAK) {
        this.stateJumping = true;
      } else if (flags === C.SEQUENCE_BREAK) {
        this.tieOffAndTrimIfNeeded();
      } else if (flags === C.COLOR_BREAK) {
        this.colorBreak();
      } else if (flags === C.TIE_OFF) {
        this.tieOffCommand();
      } else if (flags === C.TIE_ON) {
        this.tieOn();
      } else if (flags === C.TRIM) {
        this.tieOffAndTrimIfNeeded();
      } else if (flags === C.JUMP) {
        if (!this.stateJumping) this.jumpTo(x, y);
      } else if (flags === C.SEQUIN_MODE) {
        this.toggleSequins();
      } else if (flags === C.SEQUIN_EJECT) {
        if (this.stateTrimmed) {
          this.declareNotTrimmed();
          this.jumpToWithinStitchrange(x, y);
          this.stitchAt(x, y);
          this.tieOn();
        }
        if (!this.stateSequinMode) this.toggleSequins();
        this.sequinAt(x, y);
      } else if (flags === C.COLOR_CHANGE || flags === C.NEEDLE_SET) {
        this.tieOffTrimColorChange();
      } else if (flags === C.STOP) {
        this.stopHere();
      } else if (flags === C.SLOW) {
        if (this.writesSpeeds) this.add(C.SLOW);
      } else if (flags === C.FAST) {
        if (this.writesSpeeds) this.add(C.FAST);
      } else if (flags === C.END) {
        this.endHere();
        break;
      } else if (flags === C.OPTION_MAX_JUMP_LENGTH) {
        this.maxJump = stitch[0];
      } else if (flags === C.OPTION_MAX_STITCH_LENGTH) {
        this.maxStitch = stitch[0];
      } else if (flags === C.OPTION_EXPLICIT_TRIM) {
        this.explicitTrim = true;
      } else if (flags === C.OPTION_IMPLICIT_TRIM) {
        this.explicitTrim = false;
      } else if (
        flags === C.CONTINGENCY_TIE_ON_THREE_SMALL ||
        flags === C.CONTINGENCY_TIE_ON_NONE
      ) {
        this.tieOnContingency = flags;
      } else if (
        flags === C.CONTINGENCY_TIE_OFF_THREE_SMALL ||
        flags === C.CONTINGENCY_TIE_OFF_NONE
      ) {
        this.tieOffContingency = flags;
      } else if (
        flags === C.CONTINGENCY_LONG_STITCH_NONE ||
        flags === C.CONTINGENCY_LONG_STITCH_JUMP_NEEDLE ||
        flags === C.CONTINGENCY_LONG_STITCH_SEW_TO
      ) {
        this.longStitchContingency = flags;
      }
    }
    if (flags !== C.END) this.endHere();
  }

  updateNeedlePosition(x, y) {
    this.needleX = x;
    this.needleY = y;
  }

  declareNotTrimmed() {
    if (this.orderIndex === -1) this.nextChangeSequence();
    this.stateTrimmed = false;
  }

  add(flags, x, y) {
    if (x === undefined) x = this.needleX;
    if (y === undefined) y = this.needleY;
    this.dest.stitches.push([x, y, flags | this.highFlags]);
  }

  lookaheadStitch() {
    const source = this.source.stitches;
    for (let pos = this.position; pos < source.length; pos++) {
      const flags = source[pos][2] & C.COMMAND_MASK;
      if (flags === C.STITCH || flags === C.NEEDLE_AT || flags === C.SEW_TO || flags === C.TIE_ON || flags === C.SEQUIN_EJECT) {
        return true;
      }
      if (flags === C.END) return false;
    }
    return false;
  }

  colorBreak() {
    if (this.orderIndex < 0) return;
    if (!this.stateTrimmed) {
      this.tieOff();
      if (this.explicitTrim) this.trimHere();
    }
    if (!this.lookaheadStitch()) return;
    this.nextChangeSequence();
    this.stateTrimmed = true;
  }

  tieOffTrimColorChange() {
    if (!this.stateTrimmed) {
      this.tieOff();
      if (this.explicitTrim) this.trimHere();
    }
    this.nextChangeSequence();
    this.stateTrimmed = true;
  }

  tieOffAndTrimIfNeeded() {
    if (!this.stateTrimmed) {
      this.tieOff();
      this.trimHere();
    }
  }

  tieOffCommand() {
    this.tieOff();
  }

  tieOff() {
    if (this.tieOffContingency === C.CONTINGENCY_TIE_OFF_THREE_SMALL) {
      const b = this.source.stitches[this.position - 1];
      if (b) {
        const flags = b[2] & C.COMMAND_MASK;
        if (flags === C.STITCH || flags === C.NEEDLE_AT || flags === C.SEW_TO || flags === C.SEQUIN_EJECT) {
          this.lockStitch(this.needleX, this.needleY, b[0], b[1], this.maxStitch);
        }
      }
    }
  }

  tieOn() {
    if (this.tieOnContingency === C.CONTINGENCY_TIE_ON_THREE_SMALL) {
      const b = this.source.stitches[this.position + 1];
      if (b) {
        const flags = b[2] & C.COMMAND_MASK;
        if (flags === C.STITCH || flags === C.NEEDLE_AT || flags === C.SEW_TO || flags === C.SEQUIN_EJECT) {
          this.lockStitch(this.needleX, this.needleY, b[0], b[1], this.maxStitch);
        }
      }
    }
  }

  trimHere() {
    if (this.stateSequinMode) this.toggleSequins();
    this.add(C.TRIM);
    this.stateTrimmed = true;
  }

  toggleSequins() {
    if (this.sequinContingency === C.CONTINGENCY_SEQUIN_UTILIZE) {
      this.add(C.SEQUIN_MODE);
      this.stateSequinMode = !this.stateSequinMode;
    }
  }

  jumpToWithinStitchrange(newX, newY) {
    this.interpolateGapStitches(this.needleX, this.needleY, newX, newY, this.maxJump, C.JUMP);
    if (this.fullJump) {
      if (this.needleX !== newX || this.needleY !== newY) {
        this.jumpAt(newX, newY);
      }
    }
  }

  jumpTo(newX, newY) {
    this.interpolateGapStitches(this.needleX, this.needleY, newX, newY, this.maxJump, C.JUMP);
    this.jumpAt(newX, newY);
  }

  jumpAt(newX, newY) {
    if (this.stateSequinMode) this.toggleSequins();
    this.add(C.JUMP, newX, newY);
    this.updateNeedlePosition(newX, newY);
  }

  stitchWithContingency(newX, newY) {
    if (this.longStitchContingency === C.CONTINGENCY_LONG_STITCH_SEW_TO) {
      this.sewTo(newX, newY);
    } else if (this.longStitchContingency === C.CONTINGENCY_LONG_STITCH_JUMP_NEEDLE) {
      this.needleTo(newX, newY);
    } else {
      this.stitchAt(newX, newY);
    }
  }

  sewTo(newX, newY) {
    this.interpolateGapStitches(this.needleX, this.needleY, newX, newY, this.maxStitch, C.STITCH);
    this.stitchAt(newX, newY);
  }

  needleTo(newX, newY) {
    this.interpolateGapStitches(this.needleX, this.needleY, newX, newY, this.maxStitch, C.JUMP);
    this.stitchAt(newX, newY);
  }

  stitchAt(newX, newY) {
    this.add(C.STITCH, newX, newY);
    this.updateNeedlePosition(newX, newY);
  }

  sequinAt(newX, newY) {
    const contingency = this.sequinContingency;
    if (contingency === C.CONTINGENCY_SEQUIN_REMOVE) return;
    this.interpolateGapStitches(this.needleX, this.needleY, newX, newY, this.maxStitch, C.STITCH);
    if (contingency === C.CONTINGENCY_SEQUIN_UTILIZE) this.add(C.SEQUIN_EJECT, newX, newY);
    else if (contingency === C.CONTINGENCY_SEQUIN_JUMP) this.add(C.JUMP, newX, newY);
    else if (contingency === C.CONTINGENCY_SEQUIN_STITCH) this.add(C.STITCH, newX, newY);
    this.updateNeedlePosition(newX, newY);
  }

  stopHere() {
    this.add(C.STOP);
    this.stateTrimmed = true;
  }

  endHere() {
    this.add(C.END);
    this.stateTrimmed = true;
  }

  nextChangeSequence() {
    this.orderIndex++;
    this.dest.threadlist.push(this.source.getThreadOrFiller(this.orderIndex));
    if (this.orderIndex !== 0) {
      this.dest.stitches.push([this.needleX, this.needleY, C.COLOR_CHANGE]);
    }
    this.stateTrimmed = true;
  }

  interpolateGapStitches(x0, y0, x1, y1, maxLength, data) {
    const distanceX = x1 - x0;
    const distanceY = y1 - y0;
    if (Math.abs(distanceX) > maxLength || Math.abs(distanceY) > maxLength) {
      if (data === C.JUMP && this.stateSequinMode) this.toggleSequins();
      const stepsX = Math.ceil(Math.abs(distanceX / maxLength));
      const stepsY = Math.ceil(Math.abs(distanceY / maxLength));
      const steps = Math.max(stepsX, stepsY);
      const stepSizeX = distanceX / steps;
      const stepSizeY = distanceY / steps;
      let qx = x0;
      let qy = y0;
      for (let q = 1; q < steps; q++) {
        qx += stepSizeX;
        qy += stepSizeY;
        const st = [qx, qy, data | this.highFlags];
        this.dest.stitches.push(st);
        this.updateNeedlePosition(st[0], st[1]);
      }
    }
  }

  lockStitch(x, y, anchorX, anchorY, maxLength) {
    if (maxLength === undefined || maxLength === null) maxLength = this.maxStitch;
    const length = Math.hypot(anchorX - x, anchorY - y);
    if (length > maxLength) {
      const radians = Math.atan2(anchorY - y, anchorX - x);
      anchorX = x + maxLength * Math.cos(radians);
      anchorY = y + maxLength * Math.sin(radians);
    }
    for (const amount of [0.33, 0.66, 0.33, 0]) {
      this.dest.stitches.push([
        towards(x, anchorX, amount),
        towards(y, anchorY, amount),
        C.STITCH,
      ]);
    }
  }
}

function towards(a, b, amount) {
  return amount * (b - a) + a;
}

module.exports = { Transcoder };
