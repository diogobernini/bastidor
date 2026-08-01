'use strict';
// sim: simulador de costura (play/pause, avanço por tempo, reset) e o
// "seek" da linha do tempo (arrastar/clicar na barra pula a simulação).
//
// Consome (globais de renderer.js): state, $, RenderCanvas.requestRender;
// window.ObjectCanvas (mutuamente exclusivo com o modo de objetos — issue
// #29). simSetPlaying chama Edit.setEditMode(false) (mutuamente exclusivo
// com o modo de edição) e Edit.setEditMode chama de volta Sim.simReset() —
// dependência circular resolvida porque os dois módulos existem antes de
// boot() executar; a ordem de <script> entre sim.js e edit.js não importa.
window.Sim = (function () {

// Barra embaixo do canvas com um segmento por bloco de cor, proporcional à
// quantidade de pontos: mostra "que horas" entra cada linha. Clique/arrasto
// pula a simulação para aquele ponto.
function simSeekFraction(f) {
  if (!state.design) return;
  state.sim.playing = false;
  $('btn-sim').textContent = '▶';
  const clamped = Math.max(0, Math.min(1, f));
  state.sim.pos = clamped >= 1 ? Infinity : clamped * state.design.stitches.length;
  $('sim-progress').value = Math.round(clamped * 1000);
  RenderCanvas.requestRender();
}

function simSetPlaying(playing) {
  if (!state.design) return;
  if (playing && state.edit.active) Edit.setEditMode(false); // mutuamente exclusivo com a edição
  if (playing && window.ObjectCanvas && ObjectCanvas.isActive()) ObjectCanvas.setActive(false); // idem, objetos (issue #29)
  state.sim.playing = playing;
  $('btn-sim').textContent = playing ? '⏸' : '▶';
  if (playing) {
    if (state.sim.pos === Infinity || state.sim.pos >= state.design.stitches.length) {
      state.sim.pos = 0;
    }
    state.sim.lastT = performance.now();
    requestAnimationFrame(simTick);
  }
}

function simTick(t) {
  if (!state.sim.playing || !state.design) return;
  const dt = (t - state.sim.lastT) / 1000;
  state.sim.lastT = t;
  const sps = state.settings.sim.stitchesPerSecond;
  state.sim.pos += sps * dt;
  const total = state.design.stitches.length;
  if (state.sim.pos >= total) {
    state.sim.pos = Infinity;
    state.sim.playing = false;
    $('btn-sim').textContent = '▶';
    $('sim-progress').value = 1000;
    RenderCanvas.requestRender();
    return;
  }
  $('sim-progress').value = Math.round((state.sim.pos / total) * 1000);
  RenderCanvas.requestRender();
  requestAnimationFrame(simTick);
}

function simReset() {
  state.sim.pos = Infinity;
  state.sim.playing = false;
  $('btn-sim').textContent = '▶';
  $('sim-progress').value = 1000;
  RenderCanvas.requestRender();
}

  return {
    simSeekFraction,
    simSetPlaying,
    simTick,
    simReset,
  };
})();
