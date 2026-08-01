'use strict';
// Formato de projeto nativo .bastidor (issue #29, fase 2): "Introduce a
// native project file (.bastidor, JSON: objects + threads + params) so
// parametric editing survives save/reopen; machine formats stay as flat
// export." — os 10 formatos de máquina (src/core/io/*.js) continuam vendo
// só a PROJEÇÃO achatada (design.stitches), sem nunca saber de objects[].
//
// O array de agulhadas achatado entra no arquivo JUNTO com objects[] (não só
// os objetos): reabrir um projeto não precisa invocar nenhum gerador de novo
// (fonte/imagem podem nem estar mais disponíveis no disco na hora de abrir)
// — o design abre exatamente como qualquer outro, pelo array de agulhadas
// salvo. objects[] fica pronto pra um redimensionamento FUTURO rodar o
// gerador de novo (mesmo mecanismo de src/renderer/objects.js), com
// source/stitchParams/blockCount preservados tal como estavam ao salvar.
//
// Núcleo puro (sem Electron/fs, sem depender de src/core/pattern.js): quem
// lê/escreve o arquivo em disco é src/main/main.js (project:save/
// project:open), mesmo padrão de design:write/design:read pros formatos de
// máquina. Exportado via module.exports (Node/main process/testes) — ao
// contrário de objects.js/objectmodel.js, este módulo não precisa rodar no
// renderer via <script> clássico (a serialização acontece só no processo
// principal), então não tem o par de exportação window.*.

const FORMAT_VERSION = 1;

// design: { name, metadata, threads, objects, stitches } (o mesmo shape que
// trafega pelo IPC como "design", ver src/core/design.js) -> string JSON.
function serializeProject(design) {
  if (!design || !Array.isArray(design.stitches)) {
    throw new Error('project: design inválido (stitches ausente)');
  }
  const payload = {
    formatVersion: FORMAT_VERSION,
    app: 'bastidor',
    name: design.name || null,
    metadata: design.metadata || {},
    threads: design.threads || [],
    objects: design.objects || [],
    stitches: design.stitches,
  };
  return JSON.stringify(payload);
}

// string JSON (lida do arquivo .bastidor) -> design pronto pra setDesign().
// Tolerante a campos ausentes de versões futuras/arquivos editados à mão
// (threads/objects viram array vazio, nunca derruba a leitura) — só
// "stitches" é obrigatório, é o que faz o design existir de verdade.
function parseProject(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error('project: JSON inválido (' + err.message + ')');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('project: conteúdo não é um objeto JSON');
  }
  if (!Array.isArray(data.stitches)) {
    throw new Error('project: campo "stitches" ausente ou inválido');
  }
  return {
    name: typeof data.name === 'string' ? data.name : null,
    metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
    threads: Array.isArray(data.threads) ? data.threads : [],
    objects: Array.isArray(data.objects) ? data.objects : [],
    stitches: data.stitches.map((s) => [s[0], s[1], s[2]]),
  };
}

module.exports = { FORMAT_VERSION, serializeProject, parseProject };
