'use strict';
// Lê as fixtures com o leitor JS do Bastidor e grava um JSON por arquivo,
// para comparação cruzada com dump_pystitch.py (issue #18).
// Uso: node tools/pystitch-fixtures/dump-js.js <dir-de-saida>

const fs = require('fs');
const path = require('path');
const io = require('../../src/core/io');
const C = require('../../src/core/commands');

function statsOf(pattern) {
  const bounds = pattern.bounds();
  let jumps = 0;
  let trims = 0;
  let colorChanges = 0;
  let stitches = 0;
  for (const st of pattern.stitches) {
    const cmd = st[2] & C.COMMAND_MASK;
    if (cmd === C.STITCH) stitches++;
    else if (cmd === C.JUMP) jumps++;
    else if (cmd === C.TRIM) trims++;
    else if (cmd === C.COLOR_CHANGE) colorChanges++;
  }
  return {
    stitches: pattern.stitches.map((s) => [s[0], s[1], s[2] & C.COMMAND_MASK]),
    threads: pattern.threadlist.map((t) => (t ? t.hex() : null)),
    bounds,
    counts: { stitches, jumps, trims, colorChanges, total: pattern.stitches.length },
  };
}

function main() {
  const outDir = process.argv[2];
  fs.mkdirSync(outDir, { recursive: true });
  const fixturesDir = path.join(__dirname, '..', '..', 'tests', 'fixtures');
  const names = ['rosacea', 'multicolor'];
  const exts = ['vp3', 'hus', 'sew', 'pcs'];
  for (const name of names) {
    for (const ext of exts) {
      const file = path.join(fixturesDir, `${name}.${ext}`);
      if (!fs.existsSync(file)) continue;
      const buf = fs.readFileSync(file);
      const pattern = io.readBuffer(buf, ext);
      const stats = statsOf(pattern);
      fs.writeFileSync(path.join(outDir, `${name}.${ext}.json`), JSON.stringify(stats));
      console.log(`js: ${name}.${ext} -> stitches=${stats.counts.total} threads=${stats.threads.length}`);
    }
  }
}

main();
