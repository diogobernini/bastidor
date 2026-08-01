'use strict';
// Gera as fixtures .pcs (issue #18) usando o NOSSO writer JS
// (src/core/io/pcs.js), já que o pystitch não tem PcsWriter — ver o
// comentário no topo de generate_fixtures.py e em src/core/io/pcs.js.
// Uso: node tools/pystitch-fixtures/generate-pcs-fixtures.js

const fs = require('fs');
const path = require('path');
const io = require('../../src/core/io');
const { buildMultiColorSample } = require('../make-samples');

function main() {
  const fixturesDir = path.join(__dirname, '..', '..', 'tests', 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });

  const rosaceaBuf = fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'rosacea.xxx'));
  const rosacea = io.readBuffer(rosaceaBuf, 'xxx');

  const multicolor = buildMultiColorSample();

  for (const [name, pattern] of [['rosacea', rosacea], ['multicolor', multicolor]]) {
    const buf = io.writeBuffer(pattern, 'pcs');
    const file = path.join(fixturesDir, `${name}.pcs`);
    fs.writeFileSync(file, buf);
    console.log(`gravado ${file} (${buf.length} bytes)`);
  }
}

main();
