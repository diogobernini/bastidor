'use strict';
// edit: modo "Editar pontos" (issue #3) - selecionar, mover (nudge), inserir
// e apagar agulhadas individuais.
//
// Consome (globais de renderer.js): state, $, canvas (classList toggle),
// pushHistory (issue #37 - undo/redo delta-based), bumpArt, deriveStats,
// updateSidebar, updateStatusbar, updateToolbarEnabled; Sim.simReset (ao
// entrar em edição); RenderCanvas.requestRender; Spatial (src/core/spatial.js,
// carregado antes de renderer.js) para inserir ponto no meio de um segmento;
// window.ObjectCanvas (mutuamente exclusivo com o modo de objetos — issue #29).
window.Edit = (function () {

// Liga/desliga o modo "Editar pontos". Mutuamente exclusivo com a simulação:
// entrar em edição pausa e reseta a simulação em andamento.
function setEditMode(active) {
  active = !!active && !!state.design;
  state.edit.active = active;
  $('btn-edit').classList.toggle('on', active);
  canvas.classList.toggle('edit-mode', active);
  if (active) {
    Sim.simReset();
    if (window.ObjectCanvas) ObjectCanvas.setActive(false); // mutuamente exclusivo (issue #29)
  }
  updateToolbarEnabled();
  setSelectedStitch(-1);
}

function toggleEditMode() {
  if (!state.design) return;
  setEditMode(!state.edit.active);
}

function setSelectedStitch(index) {
  const valid = state.design && index >= 0 && index < state.design.stitches.length;
  state.edit.selected = valid ? index : -1;
  updateStatusbar();
  RenderCanvas.requestRender();
}

function selectedStitch() {
  if (!state.design || state.edit.selected < 0) return null;
  return state.design.stitches[state.edit.selected] || null;
}

// Chamado depois de qualquer mutação de ponto (mover, apagar, inserir).
function afterPointMutation() {
  bumpArt(); // invalida o cache do modo realista
  deriveStats();
  updateSidebar();
  updateStatusbar();
  RenderCanvas.requestRender();
}

function deleteSelectedStitch() {
  const i = state.edit.selected;
  if (!state.design || i < 0 || i >= state.design.stitches.length) return;
  const stitch = state.design.stitches[i].slice();
  pushHistory({ type: 'deletePoint', index: i, stitch });
  state.design.stitches.splice(i, 1);
  state.edit.selected = -1;
  afterPointMutation();
}

// Insere um ponto STITCH no meio do segmento entre o ponto selecionado e o
// próximo (tecla I ou duplo clique). O novo ponto passa a ser o selecionado,
// permitindo subdividir o mesmo trecho repetidamente.
function insertAfterSelected() {
  const i = state.edit.selected;
  if (!state.design || i < 0 || i >= state.design.stitches.length - 1) return;
  const newIndex = Spatial.insertMidpoint(state.design.stitches, i);
  if (newIndex === -1) return;
  pushHistory({ type: 'insertPoint', index: newIndex, stitch: state.design.stitches[newIndex].slice() });
  state.edit.selected = newIndex;
  afterPointMutation();
}

function nudgeSelectedStitch(dx, dy) {
  const st = selectedStitch();
  if (!st) return;
  const from = [st[0], st[1]];
  const to = [st[0] + dx, st[1] + dy];
  pushHistory({ type: 'movePoint', index: state.edit.selected, from, to });
  st[0] = to[0];
  st[1] = to[1];
  afterPointMutation();
}

  return {
    setEditMode,
    toggleEditMode,
    setSelectedStitch,
    selectedStitch,
    afterPointMutation,
    deleteSelectedStitch,
    insertAfterSelected,
    nudgeSelectedStitch,
  };
})();
