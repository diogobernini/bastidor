'use strict';
// Exportação SVG (uma polyline por trecho costurado, agrupada por cor).

const C = require('../commands');

function write(pattern, settings) {
  settings = settings || {};
  const strokeWidth = settings.strokeWidth !== undefined ? settings.strokeWidth : 4; // 0,4 mm
  const showJumps = !!settings.showJumps;

  const b = pattern.bounds();
  if (!isFinite(b[0])) return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const pad = 10;
  const minX = b[0] - pad;
  const minY = b[1] - pad;
  const width = b[2] - b[0] + pad * 2;
  const height = b[3] - b[1] + pad * 2;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(width)} ${fmt(height)}" ` +
      `width="${fmt(width / 10)}mm" height="${fmt(height / 10)}mm">`
  );
  parts.push(`<!-- Gerado pelo Bastidor. 1 unidade = 0,1 mm -->`);

  const blocks = pattern.getAsColorblocks();
  for (const [stitches, thread] of blocks) {
    const color = thread ? thread.hex() : '#888888';
    let run = [];
    let lastPos = null;
    const flush = () => {
      if (run.length > 1) {
        parts.push(
          `<polyline fill="none" stroke="${color}" stroke-width="${strokeWidth}" ` +
            `stroke-linecap="round" stroke-linejoin="round" points="${run.join(' ')}"/>`
        );
      }
      run = [];
    };
    for (const st of stitches) {
      const cmd = st[2] & C.COMMAND_MASK;
      if (cmd === C.STITCH || cmd === C.SEQUIN_EJECT) {
        if (run.length === 0 && lastPos) run.push(lastPos);
        const pt = `${fmt(st[0])},${fmt(st[1])}`;
        run.push(pt);
        lastPos = pt;
      } else if (cmd === C.JUMP) {
        if (showJumps && lastPos) {
          parts.push(
            `<line stroke="#999999" stroke-width="1" stroke-dasharray="6 4" ` +
              `x1="${lastPos.split(',')[0]}" y1="${lastPos.split(',')[1]}" x2="${fmt(st[0])}" y2="${fmt(st[1])}"/>`
          );
        }
        flush();
        lastPos = `${fmt(st[0])},${fmt(st[1])}`;
      } else if (cmd === C.TRIM || cmd === C.COLOR_CHANGE || cmd === C.STOP || cmd === C.END) {
        flush();
      }
    }
    flush();
  }
  parts.push('</svg>');
  return Buffer.from(parts.join('\n'), 'utf8');
}

function fmt(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

module.exports = { write };
