'use strict';
// Conversão entre Pattern (núcleo) e o objeto simples "design" que trafega
// pelo IPC até o renderer (apenas dados serializáveis).

const { Pattern, Thread } = require('./pattern');

function patternToDesign(pattern, extra) {
  const metadata = {};
  for (const [k, v] of Object.entries(pattern.extras)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      metadata[k] = v;
    }
  }
  const design = {
    stitches: pattern.stitches.map((s) => [s[0], s[1], s[2]]),
    threads: pattern.threadlist.map((t) =>
      t
        ? {
            color: t.hex(),
            description: t.description || null,
            catalog: t.catalogNumber || null,
            brand: t.brand || null,
          }
        : null
    ),
    metadata,
  };
  return Object.assign(design, extra || {});
}

function designToPattern(design) {
  const pattern = new Pattern();
  for (const s of design.stitches) {
    pattern.stitches.push([s[0], s[1], s[2]]);
  }
  for (const t of design.threads) {
    if (t === null) {
      pattern.threadlist.push(null);
    } else {
      const thread = new Thread(t.color);
      thread.description = t.description || null;
      thread.catalogNumber = t.catalog || null;
      thread.brand = t.brand || null;
      pattern.addThread(thread);
    }
  }
  for (const [k, v] of Object.entries(design.metadata || {})) {
    pattern.metadata(k, v);
  }
  return pattern;
}

module.exports = { patternToDesign, designToPattern };
