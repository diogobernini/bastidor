'use strict';
// Guarda de distância mínima entre agulhadas ("ponto muito perto", issue #29
// fase 1). Depois de mover/redimensionar um objeto (bloco de cor), agulhadas
// STITCH consecutivas podem ficar mais próximas do que o tecido tolera sem
// furar demais; esta guarda funde essas agulhadas de volta a uma distância
// segura — configurável em Configurações > Gravação (write.minSpacingMm,
// padrão 0,3 mm).
//
// Módulo puro (sem DOM, sem Electron): carregado via require() pelos testes
// e também via <script> no renderer (mesma técnica de src/core/densityscale.js
// e src/core/spatial.js) — por isso tudo fica dentro de uma IIFE, e só
// "MinSpacing" escapa para o escopo global da página. regenerateBlock
// depende de DensityScale (detectSatinRuns/rescaleWithDensity), resolvida
// via require() ou window.DensityScale, o que estiver disponível.

(function () {
  const STITCH_CMD = 0; // igual a src/core/commands.js; duplicado para não criar dependência.
  const COMMAND_MASK = 0xff;

  function resolveDensityScale() {
    if (typeof window !== 'undefined' && window.DensityScale) return window.DensityScale;
    if (typeof module !== 'undefined' && module.exports) return require('./densityscale.js');
    return null;
  }
  const DensityScale = resolveDensityScale();

  function isStitch(st) {
    return (st[2] & COMMAND_MASK) === STITCH_CMD;
  }

  function dist(a, b) {
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  // Funde agulhadas STITCH consecutivas mais próximas que `minDist` (mesma
  // unidade dos pontos, 0,1 mm): descarta a segunda agulhada do par e
  // mantém a primeira, andando da esquerda para a direita (uma fusão nunca
  // desloca o restante da corrida, só encurta). Comandos que não são STITCH
  // (salto, corte, parada, troca de cor, ejeção de paetê) nunca são
  // removidos nem comparados entre si: cada um reinicia a corrida de
  // comparação, então a guarda nunca funde através de um salto.
  // minDist <= 0 é tratado como "guarda desligada" (nada é fundido).
  // Retorna { stitches, removed }.
  function enforceMinSpacing(stitches, minDist) {
    if (!stitches || stitches.length === 0 || !(minDist > 0)) {
      return { stitches: stitches ? stitches.slice() : [], removed: 0 };
    }
    const out = [];
    let removed = 0;
    let lastStitch = null; // última agulhada STITCH mantida em `out`
    for (const st of stitches) {
      if (!isStitch(st)) {
        out.push(st);
        lastStitch = null;
        continue;
      }
      if (lastStitch && dist(lastStitch, st) < minDist) {
        removed++;
        continue;
      }
      out.push(st);
      lastStitch = st;
    }
    return { stitches: out, removed };
  }

  function translate(st, dx, dy) {
    return [st[0] + dx, st[1] + dy, st[2]];
  }

  function scaleAxes(st, sx, sy, pivot) {
    return [pivot[0] + (st[0] - pivot[0]) * sx, pivot[1] + (st[1] - pivot[1]) * sy, st[2]];
  }

  // Regenera os pontos de UM objeto (bloco de cor) depois de mover e/ou
  // redimensionar pela alça (issue #29, fase 1). `transform`:
  //   dx, dy: deslocamento (mover)
  //   scaleX, scaleY: fator de escala em cada eixo, a partir de `pivot`
  //   pivot: [x, y] ponto fixo da escala (o canto oposto à alça arrastada)
  //
  // Deslocamento puro (scaleX = scaleY = 1) só translada: nunca reamostra,
  // então nunca altera a densidade nem o espaçamento. Escala uniforme
  // (scaleX === scaleY, redimensionamento proporcional/padrão) reconstrói
  // ponto cheio preservando a densidade via DensityScale — a mesma lógica de
  // "manter densidade" já usada no redimensionamento do desenho inteiro.
  // Escala livre (Alt, eixos diferentes) usa escala geométrica simples por
  // eixo: DensityScale só sabe reconstruir com um único fator, então a
  // reconstrução de densidade fica fora do escopo da fase 1 nesse caso (ver
  // limitações no relatório). Em qualquer caminho, a guarda de espaçamento
  // mínimo roda no final sobre o resultado.
  // Retorna { stitches, removed }.
  function regenerateBlock(stitches, transform, options = {}) {
    const dx = transform.dx || 0;
    const dy = transform.dy || 0;
    const sx = transform.scaleX != null ? transform.scaleX : 1;
    const sy = transform.scaleY != null ? transform.scaleY : 1;
    const pivot = transform.pivot || [0, 0];
    const uniform = Math.abs(sx - sy) < 1e-9;

    let out;
    if (sx === 1 && sy === 1) {
      out = stitches.map((st) => translate(st, dx, dy));
    } else if (uniform) {
      if (!DensityScale) throw new Error('DensityScale indisponível para regenerateBlock');
      out = DensityScale.rescaleWithDensity(stitches, sx, { center: pivot });
      if (dx || dy) out = out.map((st) => translate(st, dx, dy));
    } else {
      out = stitches.map((st) => scaleAxes(st, sx, sy, pivot));
      if (dx || dy) out = out.map((st) => translate(st, dx, dy));
    }

    const minDist = options.minSpacingUnits > 0 ? options.minSpacingUnits : 0;
    return enforceMinSpacing(out, minDist);
  }

  const exported = { enforceMinSpacing, regenerateBlock };

  // CommonJS (testes, processo principal), guardado para não quebrar em
  // contexto de navegador puro (nodeIntegration desligado).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  // <script> comum no renderer: o IIFE isola os identificadores do escopo
  // global (scripts clássicos compartilham o escopo léxico da página).
  if (typeof window !== 'undefined') {
    window.MinSpacing = exported;
  }
})();
