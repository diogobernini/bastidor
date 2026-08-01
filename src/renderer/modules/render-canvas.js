'use strict';
// render-canvas: grade, bastidor, tecido de fundo, pontos, cache do modo
// realista e o loop render() principal do <canvas id="cv">; também as
// miniaturas genéricas de "design" (drawDesignThumbnail/drawDesignInto),
// reaproveitadas pelo gestor de pendrive, pela biblioteca e pelas prévias
// dos dialogs de importar SVG/digitalizar imagem.
//
// Consome (globais de renderer.js): state, canvas/ctx/dpr (elemento
// principal, criado em renderer.js e mutado por resizeCanvas), $, threadColor,
// STITCH/JUMP/TRIM/STOP/COLOR_CHANGE/SEQUIN_EJECT/COMMAND_MASK, FILLER_COLORS;
// I18n.fmtNum (contador da linha do tempo); window.ObjectCanvas (bbox/alças
// do objeto selecionado e o gancho de "arrastando objeto" que evita
// recachear a arte realista em cima do gesto — issue #29).
window.RenderCanvas = (function () {

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  requestRender();
}

function requestRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    render();
  });
}

function toScreen(x, y) {
  return [x * state.view.scale + state.view.tx, y * state.view.scale + state.view.ty];
}

function toDesign(sx, sy) {
  return [(sx - state.view.tx) / state.view.scale, (sy - state.view.ty) / state.view.scale];
}

function fitView() {
  const rect = canvas.getBoundingClientRect();
  let minX;
  let minY;
  let maxX;
  let maxY;
  if (state.design && isFinite(state.stats.minX)) {
    minX = state.stats.minX;
    minY = state.stats.minY;
    maxX = state.stats.maxX;
    maxY = state.stats.maxY;
  } else {
    const h = state.settings.hoop;
    minX = (-h.width * 10) / 2;
    maxX = (h.width * 10) / 2;
    minY = (-h.height * 10) / 2;
    maxY = (h.height * 10) / 2;
  }
  const w = Math.max(maxX - minX, 10);
  const h = Math.max(maxY - minY, 10);
  const scale = Math.min((rect.width * 0.86) / w, (rect.height * 0.86) / h);
  state.view.scale = scale;
  state.view.tx = rect.width / 2 - ((minX + maxX) / 2) * scale;
  state.view.ty = rect.height / 2 - ((minY + maxY) / 2) * scale;
  updateZoomLabel();
  requestRender();
}

function updateZoomLabel() {
  // 100% = 10 px por mm (escala 1 no espaço de 0,1 mm).
  $('zoom-label').textContent = Math.round(state.view.scale * 100) + '%';
}

function zoomAt(cx, cy, factor) {
  const before = toDesign(cx, cy);
  state.view.scale = Math.min(80, Math.max(0.02, state.view.scale * factor));
  const after = toScreen(before[0], before[1]);
  state.view.tx += cx - after[0];
  state.view.ty += cy - after[1];
  updateZoomLabel();
  requestRender();
}

function drawGrid(rect) {
  const g = state.settings.grid;
  if (!g.show) return;
  const spacing = g.spacingMm * 10 * state.view.scale;
  if (spacing < 7) return; // grade densa demais nesse zoom
  const [dx0, dy0] = toDesign(0, 0);
  const [dx1, dy1] = toDesign(rect.width, rect.height);
  const step = g.spacingMm * 10;
  ctx.lineWidth = 1;
  const startX = Math.floor(dx0 / step) * step;
  const startY = Math.floor(dy0 / step) * step;
  for (let x = startX; x <= dx1; x += step) {
    const major = Math.round(x / step) % 5 === 0;
    ctx.strokeStyle = major ? 'rgba(232,230,225,0.10)' : 'rgba(232,230,225,0.045)';
    ctx.beginPath();
    const sx = Math.round(toScreen(x, 0)[0]) + 0.5;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, rect.height);
    ctx.stroke();
  }
  for (let y = startY; y <= dy1; y += step) {
    const major = Math.round(y / step) % 5 === 0;
    ctx.strokeStyle = major ? 'rgba(232,230,225,0.10)' : 'rgba(232,230,225,0.045)';
    ctx.beginPath();
    const sy = Math.round(toScreen(0, y)[1]) + 0.5;
    ctx.moveTo(0, sy);
    ctx.lineTo(rect.width, sy);
    ctx.stroke();
  }
  // Eixos na origem.
  ctx.strokeStyle = 'rgba(232,161,61,0.22)';
  const [ox, oy] = toScreen(0, 0);
  ctx.beginPath();
  ctx.moveTo(Math.round(ox) + 0.5, 0);
  ctx.lineTo(Math.round(ox) + 0.5, rect.height);
  ctx.moveTo(0, Math.round(oy) + 0.5);
  ctx.lineTo(rect.width, Math.round(oy) + 0.5);
  ctx.stroke();
}

function drawHoop() {
  const h = state.settings.hoop;
  if (!h.show) return;
  const w = h.width * 10;
  const ht = h.height * 10;
  const [x0, y0] = toScreen(-w / 2, -ht / 2);
  const [x1, y1] = toScreen(w / 2, ht / 2);
  const r = Math.min(60 * state.view.scale, (x1 - x0) / 6);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(155,152,143,0.55)';
  roundRect(ctx, x0, y0, x1 - x0, y1 - y0, r);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(155,152,143,0.28)';
  roundRect(ctx, x0 - 7, y0 - 7, x1 - x0 + 14, y1 - y0 + 14, r + 5);
  ctx.stroke();
  // Marcas centrais nas bordas.
  ctx.strokeStyle = 'rgba(155,152,143,0.5)';
  const [cx, cy] = toScreen(0, 0);
  const tick = 7;
  ctx.beginPath();
  ctx.moveTo(cx, y0);
  ctx.lineTo(cx, y0 + tick);
  ctx.moveTo(cx, y1);
  ctx.lineTo(cx, y1 - tick);
  ctx.moveTo(x0, cy);
  ctx.lineTo(x0 + tick, cy);
  ctx.moveTo(x1, cy);
  ctx.lineTo(x1 - tick, cy);
  ctx.stroke();
}

function roundRect(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// ------------------------------------------------------- realismo do fio

// Ajustes da técnica de 3 passadas (base escura, corpo, brilho deslocado).
const REALISTIC_DARK_AMOUNT = 0.35; // escurecimento da base larga
const REALISTIC_LIGHT_AMOUNT = 0.45; // clareamento do brilho
const REALISTIC_BASE_WIDTH_MUL = 1.15; // largura da base em relação ao fio
const REALISTIC_GLOW_WIDTH_MUL = 0.25; // largura do brilho em relação ao fio
const REALISTIC_GLOW_OFFSET_MUL = 0.3; // deslocamento perpendicular do brilho
const REALISTIC_GLOW_ALPHA = 0.8;

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [200, 200, 200];
  const num = parseInt(m[1], 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// Escurece/clareia uma cor hex no espaço RGB simples (sem HSL).
function darkenColor(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${clamp255(r * (1 - amount))}, ${clamp255(g * (1 - amount))}, ${clamp255(b * (1 - amount))})`;
}

function lightenColor(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${clamp255(r + (255 - r) * amount)}, ${clamp255(g + (255 - g) * amount)}, ${clamp255(b + (255 - b) * amount)})`;
}

// Desenha os pontos até "limit" usando a função de projeção dada.
// Compartilhado entre a tela e a exportação PNG.
function drawStitches(c, project, scale, limit, opts) {
  if (!state.design) return null;
  const stitches = state.design.stitches;
  const showJumps = opts.showJumps;
  const lineWidth = Math.max(state.settings.view.threadWidthMm * 10 * scale, opts.minLineWidth);
  c.lineCap = 'round';
  c.lineJoin = 'round';

  let color = state.blocks.length ? threadColor(state.blocks[0].threadIndex) : '#cccccc';
  let colorCount = 0;
  let penDown = false;
  let px = null;
  let py = null;
  let lastPos = null;
  const max = Math.min(limit, stitches.length);

  // ---- modo normal: um traço só por bloco de cor (rápido) ----
  if (!opts.realistic) {
    c.strokeStyle = color;
    c.lineWidth = lineWidth;
    c.beginPath();

    for (let i = 0; i < max; i++) {
      const st = stitches[i];
      const cmd = st[2] & COMMAND_MASK;
      if (cmd === STITCH || cmd === SEQUIN_EJECT) {
        const [sx, sy] = project(st[0], st[1]);
        if (!penDown || px === null) {
          c.moveTo(px === null ? sx : px, py === null ? sy : py);
          penDown = true;
        }
        c.lineTo(sx, sy);
        px = sx;
        py = sy;
        lastPos = [sx, sy];
      } else if (cmd === JUMP) {
        const [sx, sy] = project(st[0], st[1]);
        if (showJumps && px !== null) {
          c.stroke();
          c.save();
          c.strokeStyle = 'rgba(155,152,143,0.5)';
          c.lineWidth = Math.max(1, lineWidth * 0.4);
          c.setLineDash([5, 4]);
          c.beginPath();
          c.moveTo(px, py);
          c.lineTo(sx, sy);
          c.stroke();
          c.restore();
          c.strokeStyle = color;
          c.lineWidth = lineWidth;
          c.beginPath();
        }
        penDown = false;
        px = sx;
        py = sy;
        lastPos = [sx, sy];
      } else if (cmd === TRIM || cmd === STOP) {
        penDown = false;
      } else if (cmd === COLOR_CHANGE) {
        c.stroke();
        colorCount++;
        color = threadColor(colorCount);
        c.strokeStyle = color;
        c.lineWidth = lineWidth;
        c.beginPath();
        penDown = false;
      }
    }
    c.stroke();
    return lastPos;
  }

  // ---- modo realista: base escura + corpo + brilho deslocado (3 passadas) ----
  const glowOffset = lineWidth * REALISTIC_GLOW_OFFSET_MUL;
  const glowWidth = Math.max(lineWidth * REALISTIC_GLOW_WIDTH_MUL, 0.6);
  let mainPath = new Path2D();
  let glowPath = new Path2D();

  const flush = () => {
    c.strokeStyle = darkenColor(color, REALISTIC_DARK_AMOUNT);
    c.lineWidth = lineWidth * REALISTIC_BASE_WIDTH_MUL;
    c.stroke(mainPath);
    c.strokeStyle = color;
    c.lineWidth = lineWidth;
    c.stroke(mainPath);
    c.save();
    c.globalAlpha = REALISTIC_GLOW_ALPHA;
    c.strokeStyle = lightenColor(color, REALISTIC_LIGHT_AMOUNT);
    c.lineWidth = glowWidth;
    c.stroke(glowPath);
    c.restore();
    mainPath = new Path2D();
    glowPath = new Path2D();
  };

  for (let i = 0; i < max; i++) {
    const st = stitches[i];
    const cmd = st[2] & COMMAND_MASK;
    if (cmd === STITCH || cmd === SEQUIN_EJECT) {
      const [sx, sy] = project(st[0], st[1]);
      if (!penDown || px === null) {
        // Igual ao modo normal: o ponto parte da posição anterior (pós-salto).
        mainPath.moveTo(px === null ? sx : px, py === null ? sy : py);
      }
      mainPath.lineTo(sx, sy);
      if (px !== null) {
        const dx = sx - px;
        const dy = sy - py;
        const len = Math.hypot(dx, dy);
        if (len > 1e-6) {
          const nx = (-dy / len) * glowOffset;
          const ny = (dx / len) * glowOffset;
          glowPath.moveTo(px + nx, py + ny);
          glowPath.lineTo(sx + nx, sy + ny);
        }
      }
      penDown = true;
      px = sx;
      py = sy;
      lastPos = [sx, sy];
    } else if (cmd === JUMP) {
      const [sx, sy] = project(st[0], st[1]);
      if (showJumps && px !== null) {
        flush();
        c.save();
        c.strokeStyle = 'rgba(155,152,143,0.5)';
        c.lineWidth = Math.max(1, lineWidth * 0.4);
        c.setLineDash([5, 4]);
        c.beginPath();
        c.moveTo(px, py);
        c.lineTo(sx, sy);
        c.stroke();
        c.restore();
      }
      penDown = false;
      px = sx;
      py = sy;
      lastPos = [sx, sy];
    } else if (cmd === TRIM || cmd === STOP) {
      penDown = false;
    } else if (cmd === COLOR_CHANGE) {
      flush();
      colorCount++;
      color = threadColor(colorCount);
      penDown = false;
    }
  }
  flush();
  return lastPos;
}

// Garante um canvas offscreen com a arte realista pronta para a view atual;
// só refaz o desenho quando o design/view mudou e não há interação em curso.
function ensureRealisticCache() {
  if (!state.design) return null;
  let cache = state.realisticCache;
  const needFresh = !cache || cache.pxWidth !== canvas.width || cache.pxHeight !== canvas.height || cache.dpr !== dpr;
  if (needFresh) {
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    cache = state.realisticCache = {
      canvas: off,
      pxWidth: canvas.width,
      pxHeight: canvas.height,
      dpr,
      view: { scale: NaN, tx: NaN, ty: NaN },
      artVersion: NaN,
    };
  }
  const viewChanged =
    cache.view.scale !== state.view.scale || cache.view.tx !== state.view.tx || cache.view.ty !== state.view.ty;
  const contentChanged = cache.artVersion !== state.artVersion;
  if (!state.interacting && (needFresh || viewChanged || contentChanged)) {
    const octx = cache.canvas.getContext('2d');
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, cache.canvas.width, cache.canvas.height);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStitches(octx, toScreen, state.view.scale, state.design.stitches.length, {
      showJumps: state.settings.view.showJumps,
      minLineWidth: 1.1,
      realistic: true,
    });
    cache.view = { scale: state.view.scale, tx: state.view.tx, ty: state.view.ty };
    cache.artVersion = state.artVersion;
  }
  return cache;
}

// Compõe a arte realista cacheada na tela. Enquanto o usuário arrasta/dá
// zoom, reaproveita o bitmap antigo com um transform barato (sem redesenhar
// os pontos) para manter a interação fluida mesmo em designs grandes.
function renderRealisticCached() {
  const cache = ensureRealisticCache();
  if (!cache) return;
  const matches =
    cache.view.scale === state.view.scale && cache.view.tx === state.view.tx && cache.view.ty === state.view.ty;
  ctx.save();
  if (matches) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    const k = state.view.scale / cache.view.scale;
    const offsetX = dpr * (state.view.tx - k * cache.view.tx);
    const offsetY = dpr * (state.view.ty - k * cache.view.ty);
    ctx.setTransform(k, 0, 0, k, offsetX, offsetY);
  }
  ctx.drawImage(cache.canvas, 0, 0);
  ctx.restore();
}

// ------------------------------------------------------------- fundo de tecido
//
// Trama simples (tela) desenhada num tile procedural e repetida como pattern
// com a transformação da vista, para o desenho ficar "pousado" no tecido ao
// dar pan/zoom. As cores derivam da cor de fundo dos ajustes: escolher a cor
// do tecido é escolher a cor de fundo.
const fabric = { pattern: null, color: null };
const FABRIC_CELL_PX = 24; // px de um fio no tile
const FABRIC_UNITS_PER_CELL = 5; // um fio da trama a cada 0,5 mm (unidades de 0,1 mm)

function fabricShade(hex, delta) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, v + delta));
  return `rgb(${ch(n >> 16)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
}

function ensureFabricPattern(color) {
  if (fabric.pattern && fabric.color === color) return;
  const cell = FABRIC_CELL_PX;
  const cells = 4; // 4x4 fios por tile: o jitter não repete de forma óbvia
  const tile = document.createElement('canvas');
  tile.width = cell * cells;
  tile.height = cell * cells;
  const c = tile.getContext('2d');
  c.fillStyle = fabricShade(color, -14); // vão entre os fios
  c.fillRect(0, 0, tile.width, tile.height);
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const x = i * cell;
      const y = j * cell;
      const jitter = (((i * 7 + j * 13) % 5) - 2) * 3; // variação determinística
      const horizontal = (i + j) % 2 === 0;
      const g = horizontal
        ? c.createLinearGradient(0, y, 0, y + cell)
        : c.createLinearGradient(x, 0, x + cell, 0);
      g.addColorStop(0, fabricShade(color, -10 + jitter));
      g.addColorStop(0.45, fabricShade(color, 22 + jitter));
      g.addColorStop(1, fabricShade(color, -12 + jitter));
      c.fillStyle = g;
      const inset = Math.round(cell * 0.06);
      if (horizontal) c.fillRect(x, y + inset, cell, cell - inset * 2);
      else c.fillRect(x + inset, y, cell - inset * 2, cell);
    }
  }
  fabric.pattern = ctx.createPattern(tile, 'repeat');
  fabric.color = color;
}

function drawFabric(rect) {
  const color = state.settings.view.background;
  const k = (state.view.scale * FABRIC_UNITS_PER_CELL) / FABRIC_CELL_PX;
  // Muito afastado a trama viraria moiré: some gradualmente.
  const alpha = Math.max(0, Math.min(1, (FABRIC_CELL_PX * k - 1.2) / 2.4));
  if (alpha <= 0 || !isFinite(k) || k <= 0) return;
  ensureFabricPattern(color);
  fabric.pattern.setTransform(new DOMMatrix([k, 0, 0, k, state.view.tx, state.view.ty]));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = fabric.pattern;
  ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.restore();
}

// Agulhadas como pontinhos (toggle "Pontos" na toolbar): facilita mirar um
// ponto específico, principalmente no modo de edição.
function drawPoints(limit) {
  const r = Math.max(1.2, Math.min(3, state.view.scale * 0.55));
  // Contraste com o fundo: tecido claro pede ponto escuro.
  const n = parseInt(state.settings.view.background.slice(1), 16);
  const lum = 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  ctx.save();
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = lum > 140 ? '#1c1c22' : '#f2f2f5';
  const sts = state.design.stitches;
  for (let i = 0; i < limit; i++) {
    const cmd = sts[i][2] & COMMAND_MASK;
    if (cmd !== STITCH && cmd !== SEQUIN_EJECT) continue;
    const [px, py] = toScreen(sts[i][0], sts[i][1]);
    ctx.fillRect(px - r, py - r, r * 2, r * 2);
  }
  ctx.restore();
}

// --------------------------------------------------------------- linha do tempo
//
// Desenho da barra (o "seek" propriamente dito, simSeekFraction, mora em
// Sim — ver sim.js).
function drawTimeline() {
  const bar = $('timeline');
  const shouldShow = !!state.design && state.blocks.length > 0;
  bar.hidden = !shouldShow;
  if (!shouldShow) return;
  const cv = $('timeline-canvas');
  const rect = cv.getBoundingClientRect();
  if (rect.width < 1) return;
  if (cv.width !== Math.round(rect.width * dpr) || cv.height !== Math.round(rect.height * dpr)) {
    cv.width = Math.round(rect.width * dpr);
    cv.height = Math.round(rect.height * dpr);
  }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, rect.width, rect.height);
  const total = state.design.stitches.length;
  for (const block of state.blocks) {
    const x = (block.start / total) * rect.width;
    const w = Math.max(((block.end - block.start) / total) * rect.width, 0.5);
    c.fillStyle = threadColor(block.threadIndex);
    c.fillRect(x, 0, w, rect.height);
  }
  c.fillStyle = 'rgba(0,0,0,0.35)';
  for (const block of state.blocks.slice(1)) {
    c.fillRect((block.start / total) * rect.width - 0.5, 0, 1, rect.height);
  }
  const simming = state.sim.pos !== Infinity;
  if (simming) {
    const x = (state.sim.pos / total) * rect.width;
    c.fillStyle = 'rgba(16,16,20,0.45)'; // esmaece o que ainda não foi costurado
    c.fillRect(x, 0, rect.width - x, rect.height);
    c.fillStyle = '#e8a13d';
    c.fillRect(x - 1, 0, 2.5, rect.height);
  }
  const pos = simming ? Math.floor(state.sim.pos) : total;
  $('timeline-count').textContent = `${I18n.fmtNum(pos)} / ${I18n.fmtNum(total)}`;
}

function render() {
  const rect = canvas.getBoundingClientRect();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = state.settings ? state.settings.view.background : '#101014';
  ctx.fillRect(0, 0, rect.width, rect.height);
  if (!state.settings) return;
  if (state.settings.view.fabric) drawFabric(rect);

  drawGrid(rect);
  drawHoop();

  if (state.design) {
    const simming = state.sim.pos !== Infinity;
    const limit = simming ? Math.floor(state.sim.pos) : state.design.stitches.length;
    const realistic = !!state.settings.view.realistic;
    let needle = null;
    const objDragging = !!(window.ObjectCanvas && ObjectCanvas.isDragging()); // issue #29
    if (realistic && !simming && !state.edit.active && !objDragging) {
      // Fora da simulação e da edição dá pra cachear a arte. No modo de
      // edição (ou arrastando um objeto) desenha ao vivo: mudar a arte a
      // cada frame com o blit do cache mostraria o fio parado.
      renderRealisticCached();
    } else {
      needle = drawStitches(ctx, toScreen, state.view.scale, limit, {
        showJumps: state.settings.view.showJumps,
        minLineWidth: 1.1,
        realistic,
      });
    }
    if (state.settings.view.showPoints) drawPoints(limit);
    // Agulha na simulação.
    if (simming && needle) {
      ctx.strokeStyle = '#e8a13d';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(needle[0] - 9, needle[1]);
      ctx.lineTo(needle[0] + 9, needle[1]);
      ctx.moveTo(needle[0], needle[1] - 9);
      ctx.lineTo(needle[0], needle[1] + 9);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(needle[0], needle[1], 4.2, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Marcador do ponto selecionado no modo de edição.
    if (state.edit.active && state.edit.selected >= 0 && state.edit.selected < state.design.stitches.length) {
      const st = state.design.stitches[state.edit.selected];
      const [px, py] = toScreen(st[0], st[1]);
      ctx.fillStyle = 'rgba(232,161,61,0.3)';
      ctx.strokeStyle = '#e8a13d';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (window.ObjectCanvas) ObjectCanvas.draw(ctx); // bbox + alças do objeto selecionado (issue #29)
  }

  drawTimeline();
}

function designThreadColor(design, i) {
  const t = design.threads && design.threads[i];
  return t && t.color ? t.color : FILLER_COLORS[i % FILLER_COLORS.length];
}

function designBounds(design) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const st of design.stitches) {
    const cmd = st[2] & COMMAND_MASK;
    if (cmd === STITCH || cmd === JUMP || cmd === SEQUIN_EJECT) {
      if (st[0] < minX) minX = st[0];
      if (st[0] > maxX) maxX = st[0];
      if (st[1] < minY) minY = st[1];
      if (st[1] > maxY) maxY = st[1];
    }
  }
  return { minX, minY, maxX, maxY };
}

function countStitches(design) {
  let n = 0;
  for (const st of design.stitches) {
    if ((st[2] & COMMAND_MASK) === STITCH) n++;
  }
  return n;
}

// Miniatura num canvas pequeno, com a mesma lógica de polilinha do desenho
// principal (drawStitches: moveTo só no primeiro ponto após a pena levantada
// por salto/corte/parada/troca de cor, o resto encadeia com lineTo) — só que
// operando sobre um "design" qualquer, não o state.design global.
function drawDesignThumbnail(canvas, design, size = 72) {
  drawDesignInto(canvas, design, size, size, 6);
}

// Desenha um "design" qualquer num canvas de tamanho arbitrário (miniaturas
// do pendrive e da biblioteca, prévia da digitalização), com a mesma lógica
// de polilinha do desenho principal.
function drawDesignInto(canvas, design, cssW, cssH, margin, opts = {}) {
  const localDpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(cssW * localDpr));
  canvas.height = Math.max(1, Math.round(cssH * localDpr));
  const c = canvas.getContext('2d');
  c.setTransform(localDpr, 0, 0, localDpr, 0, 0);
  c.clearRect(0, 0, cssW, cssH);
  if (opts.autoBg) {
    // Fundo com contraste automático: linhas escuras pedem prévia clara (um
    // logo azul-marinho some no painel escuro) e vice-versa. A luminância é
    // ponderada pelos pontos de cada bloco: um detalhe branco pequeno não
    // pode vencer um preenchimento escuro dominante.
    const counts = [];
    let bi = 0;
    for (const st of design.stitches) {
      const cmd = st[2] & COMMAND_MASK;
      if (cmd === COLOR_CHANGE) bi++;
      else if (cmd === STITCH) counts[bi] = (counts[bi] || 0) + 1;
    }
    let lum = 0;
    let n = 0;
    (design.threads || []).forEach((t, i) => {
      if (!t || typeof t.color !== 'string' || t.color[0] !== '#') return;
      const v = parseInt(t.color.slice(1), 16);
      const weight = counts[i] || 0;
      lum += (0.2126 * (v >> 16) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) * weight;
      n += weight;
    });
    c.fillStyle = n && lum / n < 110 ? '#e9e9ee' : '#141419';
    c.fillRect(0, 0, cssW, cssH);
  }

  const stitches = design.stitches;
  const b = designBounds(design);
  if (!stitches.length || !isFinite(b.minX)) return;
  const w = Math.max(b.maxX - b.minX, 1);
  const h = Math.max(b.maxY - b.minY, 1);
  const scale = Math.min((cssW - margin * 2) / w, (cssH - margin * 2) / h);
  const tx = cssW / 2 - ((b.minX + b.maxX) / 2) * scale;
  const ty = cssH / 2 - ((b.minY + b.maxY) / 2) * scale;
  const project = (x, y) => [x * scale + tx, y * scale + ty];

  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.lineWidth = Math.max(0.9, scale * 0.4);

  let colorIndex = 0;
  c.strokeStyle = designThreadColor(design, colorIndex);
  c.beginPath();
  let penDown = false;
  let px = null;
  let py = null;
  for (const st of stitches) {
    const cmd = st[2] & COMMAND_MASK;
    if (cmd === STITCH || cmd === SEQUIN_EJECT) {
      const [sx, sy] = project(st[0], st[1]);
      if (!penDown || px === null) c.moveTo(px === null ? sx : px, py === null ? sy : py);
      c.lineTo(sx, sy);
      px = sx;
      py = sy;
      penDown = true;
    } else if (cmd === JUMP) {
      const [sx, sy] = project(st[0], st[1]);
      penDown = false;
      px = sx;
      py = sy;
    } else if (cmd === TRIM || cmd === STOP) {
      penDown = false;
    } else if (cmd === COLOR_CHANGE) {
      c.stroke();
      colorIndex++;
      c.strokeStyle = designThreadColor(design, colorIndex);
      c.beginPath();
      penDown = false;
    }
  }
  c.stroke();
}

function zoomCenter(factor) {
  const rect = canvas.getBoundingClientRect();
  zoomAt(rect.width / 2, rect.height / 2, factor);
}

  return {
    resizeCanvas,
    requestRender,
    toScreen,
    toDesign,
    fitView,
    updateZoomLabel,
    zoomAt,
    drawGrid,
    drawHoop,
    roundRect,
    hexToRgb,
    clamp255,
    darkenColor,
    lightenColor,
    drawStitches,
    ensureRealisticCache,
    renderRealisticCached,
    fabricShade,
    ensureFabricPattern,
    drawFabric,
    drawPoints,
    drawTimeline,
    render,
    designThreadColor,
    designBounds,
    countStitches,
    drawDesignThumbnail,
    drawDesignInto,
    zoomCenter,
  };
})();
