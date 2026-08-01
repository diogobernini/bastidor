'use strict';
// Gera matrizes de exemplo em samples/ usando os writers do próprio app.
// Uso: npm run samples

const fs = require('fs');
const path = require('path');
const { Pattern } = require('../src/core/pattern');
const io = require('../src/core/io');

// Rosácea de 3 cores (~90 mm): espirógrafo em ponto corrido, anel em ponto
// cheio (zigue-zague) e miolo em espiral. Unidades de 0,1 mm.
function buildRosacea() {
  const p = new Pattern();
  p.metadata('name', 'ROSACEA');

  p.addThread({ color: 0x8c1d2f, description: 'Bordô' });
  p.addThread({ color: 0xe8a13d, description: 'Âmbar' });
  p.addThread({ color: 0x2f6f6a, description: 'Verde-abeto' });

  const STITCH_LEN = 25; // 2,5 mm

  // Costura em linha reta até (x, y) em passos de até STITCH_LEN.
  function sewTo(x, y) {
    const x0 = p._previousX;
    const y0 = p._previousY;
    const dist = Math.hypot(x - x0, y - y0);
    const steps = Math.max(1, Math.ceil(dist / STITCH_LEN));
    for (let s = 1; s <= steps; s++) {
      p.stitchAbs(Math.round(x0 + ((x - x0) * s) / steps), Math.round(y0 + ((y - y0) * s) / steps));
    }
  }

  // Cor 1: espirógrafo com 12 elipses rotacionadas, ligadas pelo centro.
  const LOOPS = 12;
  const A = 420;
  const B = 170;
  let first = true;
  for (let k = 0; k < LOOPS; k++) {
    const rot = (k * Math.PI) / LOOPS;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const pointAt = (t) => {
      const ex = A * Math.cos(t);
      const ey = B * Math.sin(t);
      return [Math.round(ex * cos - ey * sin), Math.round(ex * sin + ey * cos)];
    };
    const start = pointAt(0);
    if (first) {
      p.moveAbs(start[0], start[1]);
      first = false;
    } else {
      sewTo(0, 0);
      sewTo(start[0], start[1]);
    }
    const per = 2 * Math.PI * Math.sqrt((A * A + B * B) / 2);
    const steps = Math.ceil(per / STITCH_LEN);
    for (let s = 1; s <= steps; s++) {
      const [x, y] = pointAt((2 * Math.PI * s) / steps);
      p.stitchAbs(x, y);
    }
  }
  p.colorChange();

  // Cor 2: anel em ponto cheio, zigue-zague entre dois raios.
  const R_IN = 460;
  const R_OUT = 495;
  const SPACING = 4.5; // 0,45 mm entre agulhadas na borda externa
  const satinSteps = Math.ceil((2 * Math.PI * R_OUT) / SPACING / 2);
  p.moveAbs(R_IN, 0);
  for (let s = 0; s <= satinSteps; s++) {
    const t = (2 * Math.PI * s) / satinSteps;
    const tHalf = t + Math.PI / satinSteps;
    p.stitchAbs(Math.round(R_IN * Math.cos(t)), Math.round(R_IN * Math.sin(t)));
    p.stitchAbs(Math.round(R_OUT * Math.cos(tHalf)), Math.round(R_OUT * Math.sin(tHalf)));
  }
  p.colorChange();

  // Cor 3: miolo em espiral.
  const R_CORE = 110;
  const PITCH = 9;
  p.moveAbs(0, 0);
  const turns = R_CORE / PITCH;
  const spiralSteps = Math.ceil((2 * Math.PI * turns * R_CORE) / 2 / 20);
  for (let s = 0; s <= spiralSteps; s++) {
    const t = (turns * 2 * Math.PI * s) / spiralSteps;
    const r = (R_CORE * s) / spiralSteps;
    p.stitchAbs(Math.round(r * Math.cos(t)), Math.round(r * Math.sin(t)));
  }
  p.end();
  return p;
}

// Amostra com pontos propositalmente longos para exercitar o encoder.
function buildLongStitchTest() {
  const p = new Pattern();
  p.metadata('name', 'LONGO');
  p.addThread({ color: 0x333333, description: 'Grafite' });
  p.moveAbs(0, 0);
  p.stitchAbs(0, 0);
  p.stitchAbs(500, 0);
  p.stitchAbs(500, 380);
  p.stitchAbs(-260, 380);
  p.stitchAbs(-260, -140);
  p.stitchAbs(0, 0);
  p.end();
  return p;
}

// Matriz sintética de 4 cores (issue #18 — fixtures VP3/HUS/SEW/PCS): usada
// junto com a rosácea para validação cruzada com o pystitch. Só segmentos
// alinhados aos eixos (múltiplos exatos de STEP) — evita qualquer ambiguidade
// de arredondamento entre o Math.round (JS, sempre arredonda 0,5 pra cima) e
// o round() do Python (banker's rounding) no espelho usado para gerar as
// fixtures de referência (ver tools/pystitch-fixtures/).
function buildMultiColorSample() {
  const p = new Pattern();
  p.metadata('name', 'MULTICOR');
  p.addThread({ color: 0xd11f2c, description: 'Vermelho' });
  p.addThread({ color: 0x1f9d55, description: 'Verde' });
  p.addThread({ color: 0x1f5fd1, description: 'Azul' });
  p.addThread({ color: 0xe8c200, description: 'Amarelo' });

  const STEP = 20;
  function lineTo(x, y) {
    const x0 = p._previousX;
    const y0 = p._previousY;
    const dist = Math.abs(x - x0) + Math.abs(y - y0); // sempre um só eixo muda
    const steps = Math.round(dist / STEP);
    for (let s = 1; s <= steps; s++) {
      p.stitchAbs(x0 + Math.round(((x - x0) * s) / steps), y0 + Math.round(((y - y0) * s) / steps));
    }
  }

  // Cor 1 (vermelho): quadrado 300x300.
  p.moveAbs(-400, -400);
  lineTo(-100, -400);
  lineTo(-100, -100);
  lineTo(-400, -100);
  lineTo(-400, -400);
  p.trim();
  p.colorChange();

  // Cor 2 (verde): retângulo 200x200, depois de um salto grande.
  p.moveAbs(300, -400);
  lineTo(500, -400);
  lineTo(500, -200);
  lineTo(300, -200);
  lineTo(300, -400);
  p.trim();
  p.colorChange();

  // Cor 3 (azul): escada em zigue-zague.
  p.moveAbs(-400, 200);
  for (let i = 0; i < 6; i++) {
    lineTo(p._previousX + 60, p._previousY);
    lineTo(p._previousX, p._previousY + 60);
  }
  p.trim();
  p.colorChange();

  // Cor 4 (amarelo): pontos isolados (saltos entre agulhadas soltas).
  p.moveAbs(200, 200);
  p.stitchAbs(200, 200);
  for (let i = 1; i < 6; i++) {
    p.moveAbs(200 + i * 60, 200 + (i % 2) * 60);
    p.stitchAbs(200 + i * 60, 200 + (i % 2) * 60);
  }
  p.end();
  return p;
}

function main() {
  const outDir = path.join(__dirname, '..', 'samples');
  fs.mkdirSync(outDir, { recursive: true });
  const rosacea = buildRosacea();
  for (const ext of ['xxx', 'dst', 'exp', 'svg']) {
    const buf = io.writeBuffer(rosacea, ext);
    const file = path.join(outDir, `rosacea.${ext}`);
    fs.writeFileSync(file, buf);
    console.log(`gravado ${file} (${buf.length} bytes)`);
  }
}

if (require.main === module) main();

module.exports = { buildRosacea, buildLongStitchTest, buildMultiColorSample };
