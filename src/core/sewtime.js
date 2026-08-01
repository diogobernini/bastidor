'use strict';
// Estimativa de tempo de confecção (issue #38): pontos e trocas de cor de um
// design -> tempo aproximado de bordado, dada a velocidade da máquina em
// agulhadas por minuto (preferência machine.speedSpm, configurável em
// Configurações · Visualização; ver src/main/settings.js). Antes a
// velocidade ficava fixa (600 spm) direto no hover da biblioteca.
// Módulo puro (sem DOM, sem Node): mesmo espírito de src/core/spatial.js,
// dois exports — module.exports para os testes em node:test e
// window.SewTime para o <script> clássico em index.html, antes de
// renderer.js (showLibHover, src/renderer/renderer.js).

const SewTime = (function () {
  const COLOR_CHANGE_MIN = 0.5; // ~30s por troca de linha, estimativa

  // Minutos aproximados de confecção. spm <= 0 (preferência corrompida ou
  // ausente) cai para 1 em vez de dividir por zero/negativo.
  function estimateMinutes(stitches, colorChanges, spm) {
    const rate = spm > 0 ? spm : 1;
    return stitches / rate + colorChanges * COLOR_CHANGE_MIN;
  }

  // minutos -> "< 1 min" | "42 min" | "1 h 05 min".
  function formatMinutes(totalMinutes) {
    if (totalMinutes < 1) return '< 1 min';
    const h = Math.floor(totalMinutes / 60);
    const m = Math.round(totalMinutes % 60);
    return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
  }

  function fmtSewTime(stitches, colorChanges, spm) {
    return formatMinutes(estimateMinutes(stitches, colorChanges, spm));
  }

  return { estimateMinutes, formatMinutes, fmtSewTime };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SewTime;
}
if (typeof window !== 'undefined') {
  window.SewTime = SewTime;
}
