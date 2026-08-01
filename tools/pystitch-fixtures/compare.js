'use strict';
// Compara os dumps JS (dump-js.js) e pystitch (dump_pystitch.py) e imprime
// um relatório pass/fail por fixture (issue #18).
// Uso: node tools/pystitch-fixtures/compare.js <dir-js> <dir-pystitch>

const fs = require('fs');
const path = require('path');

const TOLERANCE = 1.01; // unidades de 0,1 mm — cobre arredondamentos de escala (VP3 100x, PCS 5/3)

function closeEnough(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

function compareOne(jsDir, pyDir, filename) {
  const jsPath = path.join(jsDir, filename);
  const pyPath = path.join(pyDir, filename);
  if (!fs.existsSync(jsPath) || !fs.existsSync(pyPath)) {
    return { filename, skipped: true };
  }
  const js = JSON.parse(fs.readFileSync(jsPath, 'utf8'));
  const py = JSON.parse(fs.readFileSync(pyPath, 'utf8'));
  const problems = [];

  if (js.stitches.length !== py.stitches.length) {
    problems.push(`nº de pontos: js=${js.stitches.length} py=${py.stitches.length}`);
  } else {
    let maxDelta = 0;
    let cmdMismatches = 0;
    for (let i = 0; i < js.stitches.length; i++) {
      const [jx, jy, jc] = js.stitches[i];
      const [px, py_, pc] = py.stitches[i];
      maxDelta = Math.max(maxDelta, Math.abs(jx - px), Math.abs(jy - py_));
      if (jc !== pc) cmdMismatches++;
    }
    if (maxDelta > TOLERANCE) problems.push(`maior desvio de coordenada: ${maxDelta.toFixed(3)}`);
    if (cmdMismatches > 0) problems.push(`${cmdMismatches} comandos divergentes`);
  }

  if (js.threads.length !== py.threads.length) {
    problems.push(`nº de fios: js=${js.threads.length} py=${py.threads.length}`);
  } else {
    for (let i = 0; i < js.threads.length; i++) {
      if ((js.threads[i] || '').toLowerCase() !== (py.threads[i] || '').toLowerCase()) {
        problems.push(`fio ${i}: js=${js.threads[i]} py=${py.threads[i]}`);
      }
    }
  }

  for (let i = 0; i < 4; i++) {
    if (!closeEnough(js.bounds[i], py.bounds[i], TOLERANCE)) {
      problems.push(`bounds[${i}]: js=${js.bounds[i]} py=${py.bounds[i]}`);
    }
  }

  for (const key of ['stitches', 'jumps', 'trims', 'colorChanges']) {
    if (js.counts[key] !== py.counts[key]) {
      problems.push(`counts.${key}: js=${js.counts[key]} py=${py.counts[key]}`);
    }
  }

  return { filename, ok: problems.length === 0, problems };
}

function main() {
  const [jsDir, pyDir] = process.argv.slice(2);
  const files = fs.readdirSync(jsDir).filter((f) => f.endsWith('.json'));
  let allOk = true;
  for (const f of files) {
    const result = compareOne(jsDir, pyDir, f);
    if (result.skipped) {
      console.log(`SKIP ${f} (faltando de um dos lados)`);
      continue;
    }
    if (result.ok) {
      console.log(`OK   ${f}`);
    } else {
      allOk = false;
      console.log(`FAIL ${f}`);
      for (const p of result.problems) console.log(`       - ${p}`);
    }
  }
  process.exit(allOk ? 0 : 1);
}

main();
