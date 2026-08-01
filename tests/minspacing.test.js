'use strict';
// Testes da guarda de distância mínima entre agulhadas e da regeneração por
// objeto (issue #29, fase 1).

const test = require('node:test');
const assert = require('node:assert');

const { enforceMinSpacing, regenerateBlock } = require('../src/core/minspacing');
const C = require('../src/core/commands');

// ------------------------------------------------------------------ fixtures
// (mesma técnica de tests/densityscale.test.js: cada arquivo de teste tem sua
// própria cópia local do gerador de coluna satin sintética, para não validar
// a implementação contra si mesma.)

function resample(points, spacing) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  const steps = Math.max(1, Math.round(total / spacing));
  const step = total / steps;
  const out = [];
  let seg = 0;
  for (let s = 0; s <= steps; s++) {
    const target = s * step;
    while (seg < cum.length - 2 && cum[seg + 1] < target) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    const t = segLen > 1e-9 ? (target - cum[seg]) / segLen : 0;
    const a = points[seg];
    const b = points[seg + 1];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

function tangentAt(points, i) {
  const a = points[Math.max(0, i - 1)];
  const b = points[Math.min(points.length - 1, i + 1)];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return len > 0 ? [dx / len, dy / len] : [1, 0];
}

// Coluna de ponto cheio sintética: zigue-zague de largura `width` ao longo de
// uma senoide, com `spacing` de espaçamento ao longo da espinha. Devolve
// [x, y, cmd] com um JUMP inicial seguido só de STITCH, como um bloco real.
function buildSatinColumn({ length = 800, amplitude = 80, cycles = 1.5, width = 30, spacing = 4.5 } = {}) {
  const fine = [];
  const fineSteps = 4000;
  for (let i = 0; i <= fineSteps; i++) {
    const u = i / fineSteps;
    fine.push([u * length, amplitude * Math.sin(u * cycles * 2 * Math.PI)]);
  }
  const spine = resample(fine, spacing);
  const stitches = [[Math.round(spine[0][0]), Math.round(spine[0][1]), C.JUMP]];
  for (let j = 0; j < spine.length; j++) {
    const [tx, ty] = tangentAt(spine, j);
    const nx = -ty;
    const ny = tx;
    const sign = j % 2 === 0 ? 1 : -1;
    const x = spine[j][0] + nx * (width / 2) * sign;
    const y = spine[j][1] + ny * (width / 2) * sign;
    stitches.push([Math.round(x), Math.round(y), C.STITCH]);
  }
  return stitches;
}

// Espinha (pontos médios de agulhadas consecutivas) de um trecho só-STITCH;
// devolve espaçamento médio ao longo dela e largura média. Recalculado de
// forma independente do núcleo (não usa densityscale.js internamente).
function spineStats(stitches) {
  const spine = [];
  for (let i = 0; i < stitches.length - 1; i++) {
    spine.push([(stitches[i][0] + stitches[i + 1][0]) / 2, (stitches[i][1] + stitches[i + 1][1]) / 2]);
  }
  let len = 0;
  for (let i = 1; i < spine.length; i++) {
    len += Math.hypot(spine[i][0] - spine[i - 1][0], spine[i][1] - spine[i - 1][1]);
  }
  const avgSpacing = len / (spine.length - 1);
  let widthSum = 0;
  for (let i = 0; i < stitches.length - 1; i++) {
    const segLen = Math.hypot(stitches[i + 1][0] - stitches[i][0], stitches[i + 1][1] - stitches[i][1]);
    widthSum += Math.sqrt(Math.max(0, segLen * segLen - avgSpacing * avgSpacing));
  }
  const avgWidth = widthSum / (stitches.length - 1);
  return { avgSpacing, avgWidth };
}

function stitchCountOf(stitches) {
  return stitches.filter((s) => (s[2] & 0xff) === C.STITCH).length;
}

// --------------------------------------------------------- enforceMinSpacing

test('enforceMinSpacing: nenhuma agulhada removida quando o espaçamento já é maior que o limite', () => {
  const stitches = [[0, 0, C.STITCH], [10, 0, C.STITCH], [20, 0, C.STITCH], [30, 0, C.STITCH]];
  const { stitches: out, removed } = enforceMinSpacing(stitches, 3);
  assert.equal(removed, 0);
  assert.deepStrictEqual(out, stitches);
});

test('enforceMinSpacing: funde exatamente um par mais próximo que o limite', () => {
  // (10,0) -> (12,0) está a 2 unidades: abaixo do limite de 3 (0,3 mm).
  const stitches = [[0, 0, C.STITCH], [10, 0, C.STITCH], [12, 0, C.STITCH], [22, 0, C.STITCH]];
  const { stitches: out, removed } = enforceMinSpacing(stitches, 3);
  assert.equal(removed, 1);
  assert.deepStrictEqual(out, [[0, 0, C.STITCH], [10, 0, C.STITCH], [22, 0, C.STITCH]]);
});

test('enforceMinSpacing: corrida inteira mais próxima que o limite colapsa mantendo o espaçamento mínimo', () => {
  // 10 agulhadas a 1 unidade uma da outra, limite de 5: cada nova agulhada só
  // sobrevive quando já se afastou o bastante da última mantida.
  const stitches = [];
  for (let i = 0; i < 10; i++) stitches.push([i, 0, C.STITCH]);
  const { stitches: out, removed } = enforceMinSpacing(stitches, 5);

  assert.ok(removed > 0, 'deveria remover pelo menos uma agulhada');
  assert.ok(out.length < stitches.length, 'a corrida deveria encolher');
  for (let i = 1; i < out.length; i++) {
    const d = Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]);
    assert.ok(d >= 5, `espaçamento ${d} deveria respeitar o mínimo de 5`);
  }
  // a primeira agulhada da corrida nunca se move (fusão só descarta a
  // segunda do par, nunca desloca a que já foi mantida).
  assert.deepStrictEqual(out[0], [0, 0, C.STITCH]);
});

test('enforceMinSpacing: comandos não-STITCH nunca são removidos', () => {
  const stitches = [
    [0, 0, C.STITCH],
    [1, 0, C.STITCH], // a 1 unidade de (0,0): funde com o limite de 3
    [1, 0, C.JUMP],
    [2, 0, C.STITCH],
  ];
  const { stitches: out, removed } = enforceMinSpacing(stitches, 3);
  assert.equal(removed, 1);
  assert.deepStrictEqual(out, [[0, 0, C.STITCH], [1, 0, C.JUMP], [2, 0, C.STITCH]]);
});

test('enforceMinSpacing: salto entre dois pontos próximos impede a fusão entre eles', () => {
  const stitches = [[0, 0, C.STITCH], [0, 0, C.JUMP], [1, 0, C.STITCH]];
  const { stitches: out, removed } = enforceMinSpacing(stitches, 3);
  assert.equal(removed, 0, 'o salto reinicia a corrida: a agulhada depois dele não compara com a de antes');
  assert.deepStrictEqual(out, stitches);
});

test('enforceMinSpacing: minDist <= 0 desliga a guarda (no-op)', () => {
  const stitches = [[0, 0, C.STITCH], [0, 0, C.STITCH], [0, 0, C.STITCH]];
  const { stitches: out, removed } = enforceMinSpacing(stitches, 0);
  assert.equal(removed, 0);
  assert.deepStrictEqual(out, stitches);
});

test('enforceMinSpacing: lista vazia devolve vazio sem erro', () => {
  assert.deepStrictEqual(enforceMinSpacing([], 3), { stitches: [], removed: 0 });
});

// ------------------------------------------------------------- regenerateBlock

test('regenerateBlock: deslocamento puro translada exatamente, sem reamostrar nem remover', () => {
  const stitches = buildSatinColumn();
  const before = stitchCountOf(stitches);
  const { stitches: out, removed } = regenerateBlock(stitches, { dx: 50, dy: -30, scaleX: 1, scaleY: 1 }, {});
  assert.equal(removed, 0);
  assert.equal(out.length, stitches.length);
  for (let i = 0; i < stitches.length; i++) {
    assert.equal(out[i][0], stitches[i][0] + 50);
    assert.equal(out[i][1], stitches[i][1] - 30);
    assert.equal(out[i][2], stitches[i][2]);
  }
  assert.equal(stitchCountOf(out), before);
});

test('regenerateBlock: redimensionamento proporcional (uniforme) preserva a densidade do ponto cheio', () => {
  const stitches = buildSatinColumn();
  const before = spineStats(stitches.slice(1));

  const pivot = [stitches[0][0], stitches[0][1]];
  const { stitches: out, removed } = regenerateBlock(stitches, { scaleX: 1.5, scaleY: 1.5, pivot }, {});
  const after = spineStats(out.slice(1));

  assert.equal(removed, 0, 'em 1,5x não deveria disparar a guarda de espaçamento mínimo');
  const spacingRatio = after.avgSpacing / before.avgSpacing;
  assert.ok(spacingRatio >= 0.9 && spacingRatio <= 1.1, `razão de espaçamento ${spacingRatio} fora de [0.9, 1.1]`);
  const widthRatio = after.avgWidth / before.avgWidth;
  assert.ok(Math.abs(widthRatio - 1.5) <= 0.2, `razão de largura ${widthRatio} deveria ser ~1,5`);
});

test('regenerateBlock: encolher ponto cheio (satin) bastante NÃO precisa da guarda — a densidade já protege o espaçamento ao longo da espinha', () => {
  const stitches = buildSatinColumn({ spacing: 4.5 }); // ~0,45 mm ao longo da espinha
  const before = spineStats(stitches.slice(1));
  const pivot = [stitches[0][0], stitches[0][1]];
  // fator 0,1: só a LARGURA da coluna encolhe; o espaçamento ao longo da
  // espinha (a distância que importa pra guarda) fica igual ao original,
  // porque reconstruir com densidade preservada é exatamente isso.
  const { stitches: out, removed } = regenerateBlock(stitches, { scaleX: 0.1, scaleY: 0.1, pivot }, { minSpacingUnits: 3 });
  const after = spineStats(out.slice(1));

  assert.equal(removed, 0, 'densidade preservada: a guarda não deveria precisar agir');
  const spacingRatio = after.avgSpacing / before.avgSpacing;
  assert.ok(spacingRatio >= 0.9 && spacingRatio <= 1.1, `razão de espaçamento ${spacingRatio} fora de [0.9, 1.1]`);
});

test('regenerateBlock: encolher ponto corrido (não-satin) dispara a guarda de espaçamento mínimo', () => {
  // Ponto corrido reto (sem zigue-zague, então não é detectado como satin):
  // a reconstrução de densidade só existe para ponto cheio (ver DEFAULTS de
  // densityscale.js) — ponto corrido escala com fator simples, então
  // encolher de fato aproxima as agulhadas, e é aí que a guarda entra.
  const stitches = [];
  for (let i = 0; i < 20; i++) stitches.push([i * 10, 0, C.STITCH]); // 1,0 mm de espaçamento
  const pivot = [0, 0];
  // fator 0,1: espaçamento cairia para ~0,1 mm, abaixo do limite de 0,3 mm
  // (3 unidades de 0,1 mm).
  const { stitches: out, removed } = regenerateBlock(stitches, { scaleX: 0.1, scaleY: 0.1, pivot }, { minSpacingUnits: 3 });

  assert.ok(removed > 0, 'deveria ter fundido agulhadas para respeitar o mínimo');
  for (let i = 1; i < out.length; i++) {
    const d = Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]);
    assert.ok(d >= 3, `espaçamento ${d} deveria respeitar o mínimo de 3 (0,3 mm)`);
  }
});

test('regenerateBlock: redimensionamento livre (Alt) escala cada eixo de forma independente', () => {
  const stitches = [[0, 0, C.JUMP], [10, 0, C.STITCH], [10, 20, C.STITCH], [0, 20, C.STITCH]];
  const pivot = [0, 0];
  const { stitches: out, removed } = regenerateBlock(stitches, { scaleX: 2, scaleY: 0.5, pivot }, {});
  assert.equal(removed, 0);
  assert.deepStrictEqual(out, [[0, 0, C.JUMP], [20, 0, C.STITCH], [20, 10, C.STITCH], [0, 10, C.STITCH]]);
});

test('regenerateBlock: escala livre soma com deslocamento adicional', () => {
  const stitches = [[0, 0, C.STITCH], [10, 10, C.STITCH]];
  const { stitches: out } = regenerateBlock(stitches, { dx: 5, dy: 5, scaleX: 2, scaleY: 1, pivot: [0, 0] }, {});
  assert.deepStrictEqual(out, [[5, 5, C.STITCH], [25, 15, C.STITCH]]);
});
