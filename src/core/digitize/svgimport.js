'use strict';
// Leitura de SVG para digitalização: parser XML minimalista próprio (sem
// expressões regulares — apenas varredura de caracteres — e sem DOMParser,
// já que o núcleo roda em Node puro), suficiente para as tags mais comuns
// (path, rect, circle, ellipse, line, polyline, polygon, g com transform).
// Extrai fill/stroke de atributos e de "style" inline e agrupa a geometria
// resultante por cor (na unidade interna do Bastidor, 0,1 mm).

const svgpath = require('./svgpath');

const EPS = 1e-9;
const FLATTEN_TOLERANCE = 0.5; // 0,05 mm em unidades internas — fino o bastante p/ ponto

// ------------------------------------------------------------------ parser XML

// Nó: { tag, attrs, children, type: 'element' }. Texto é ignorado (não é
// necessário para geometria de formas). Tolerante a XML malformado: tags de
// fechamento sem abertura correspondente são ignoradas.
function parseXml(text) {
  const s = String(text || '');
  const n = s.length;
  let i = 0;
  const root = { tag: '#root', attrs: {}, children: [], type: 'element' };
  const stack = [root];

  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt === -1) break;
    i = lt;

    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (s.startsWith('<!', i) || s.startsWith('<?', i)) {
      const end = s.indexOf('>', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (s.startsWith('</', i)) {
      const end = s.indexOf('>', i);
      const name = s.slice(i + 2, end === -1 ? n : end).trim();
      i = end === -1 ? n : end + 1;
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const tagInfo = readTag(s, i);
    if (!tagInfo) {
      i++;
      continue;
    }
    const node = { tag: tagInfo.tag, attrs: tagInfo.attrs, children: [], type: 'element' };
    stack[stack.length - 1].children.push(node);
    i = tagInfo.nextIndex;
    if (!tagInfo.selfClose) stack.push(node);
  }
  return root;
}

function isSpace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

// Lê "<tag attr="valor" ...>" ou "<tag .../>" a partir de "i" (aponta p/ "<").
function readTag(s, i) {
  const n = s.length;
  let j = i + 1;
  const tagStart = j;
  while (j < n && !isSpace(s[j]) && s[j] !== '>' && s[j] !== '/') j++;
  const tag = s.slice(tagStart, j);
  if (!tag) return null;

  const attrs = {};
  let selfClose = false;
  for (;;) {
    while (j < n && isSpace(s[j])) j++;
    if (j >= n) break;
    if (s[j] === '/') {
      selfClose = true;
      j++;
      while (j < n && s[j] !== '>') j++;
      j++;
      break;
    }
    if (s[j] === '>') {
      j++;
      break;
    }
    const nameStart = j;
    while (j < n && s[j] !== '=' && !isSpace(s[j]) && s[j] !== '>' && s[j] !== '/') j++;
    const name = s.slice(nameStart, j);
    while (j < n && isSpace(s[j])) j++;
    let value = '';
    if (s[j] === '=') {
      j++;
      while (j < n && isSpace(s[j])) j++;
      if (s[j] === '"' || s[j] === "'") {
        const quote = s[j];
        j++;
        const valStart = j;
        while (j < n && s[j] !== quote) j++;
        value = s.slice(valStart, j);
        if (j < n) j++;
      } else {
        const valStart = j;
        while (j < n && !isSpace(s[j]) && s[j] !== '>' && s[j] !== '/') j++;
        value = s.slice(valStart, j);
      }
    }
    if (name) attrs[name] = decodeEntities(value);
    if (!name && !value) break; // evita loop infinito em lixo inesperado
  }
  return { tag, attrs, selfClose, nextIndex: j };
}

function decodeEntities(str) {
  if (str.indexOf('&') === -1) return str;
  let out = '';
  let i = 0;
  const n = str.length;
  while (i < n) {
    if (str[i] === '&') {
      const semi = str.indexOf(';', i);
      if (semi !== -1 && semi - i <= 10) {
        const decoded = decodeEntity(str.slice(i + 1, semi));
        if (decoded !== null) {
          out += decoded;
          i = semi + 1;
          continue;
        }
      }
    }
    out += str[i];
    i++;
  }
  return out;
}

function decodeEntity(ent) {
  if (ent === 'amp') return '&';
  if (ent === 'lt') return '<';
  if (ent === 'gt') return '>';
  if (ent === 'quot') return '"';
  if (ent === 'apos') return "'";
  if (ent[0] === '#') {
    const isHex = ent[1] === 'x' || ent[1] === 'X';
    const num = isHex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    if (!Number.isNaN(num)) return String.fromCodePoint(num);
  }
  return null;
}

function findChildTag(node, tag) {
  for (const child of node.children) {
    if (child.type === 'element' && child.tag.toLowerCase() === tag) return child;
  }
  return null;
}

// ------------------------------------------------------------------ unidades

const PX_TO_MM = 25.4 / 96;
const UNIT_TO_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: PX_TO_MM, '': PX_TO_MM };

function parseLength(str) {
  const s = String(str).trim();
  const n = s.length;
  let i = 0;
  if (s[i] === '+' || s[i] === '-') i++;
  while (i < n && s[i] >= '0' && s[i] <= '9') i++;
  if (s[i] === '.') {
    i++;
    while (i < n && s[i] >= '0' && s[i] <= '9') i++;
  }
  const value = parseFloat(s.slice(0, i));
  if (Number.isNaN(value)) return null;
  const unit = s.slice(i).trim().toLowerCase();
  const mmPerUnit = UNIT_TO_MM[unit] !== undefined ? UNIT_TO_MM[unit] : PX_TO_MM;
  return { value, unit, mm: value * mmPerUnit };
}

function parseViewBox(str) {
  if (!str) return null;
  const nums = svgpath.parseNumberList(str);
  if (nums.length < 4) return null;
  return { minx: nums[0], miny: nums[1], w: nums[2], h: nums[3] };
}

// Matriz "raiz": de unidades de usuário do <svg> (espaço do viewBox) para a
// unidade interna do Bastidor (0,1 mm). Convenção (ver docs/limitações):
// - viewBox + width/height físico -> escala = largura_mm / largura_viewBox;
// - viewBox sem width/height -> assume 1 unidade de usuário = 1 mm;
// - sem viewBox -> 1 unidade de usuário = 1px a 96dpi (regra do próprio SVG),
//   mesmo que width/height tragam outra unidade (que só define o viewport).
function computeUnitsMatrix(attrs) {
  const vb = parseViewBox(attrs.viewBox);
  const wUnit = attrs.width !== undefined ? parseLength(attrs.width) : null;
  let scaleMm;
  let originX = 0;
  let originY = 0;
  if (vb) {
    originX = vb.minx;
    originY = vb.miny;
    scaleMm = wUnit && vb.w > EPS ? wUnit.mm / vb.w : 1;
  } else {
    scaleMm = PX_TO_MM;
  }
  const k = scaleMm * 10; // mm -> 0,1 mm
  return { a: k, b: 0, c: 0, d: k, e: -originX * k, f: -originY * k };
}

// ------------------------------------------------------------------ cor

const NAMED_COLORS = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
  blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff',
  gray: '#808080', grey: '#808080', orange: '#ffa500', purple: '#800080',
  brown: '#a52a2a', pink: '#ffc0cb', lime: '#00ff00', navy: '#000080',
  teal: '#008080', maroon: '#800000', olive: '#808000', silver: '#c0c0c0',
  gold: '#ffd700', indigo: '#4b0082', violet: '#ee82ee', darkgreen: '#006400',
  darkred: '#8b0000', darkblue: '#00008b', beige: '#f5f5dc',
};

function parseColor(value) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim();
  if (v === '') return null;
  const lower = v.toLowerCase();
  if (lower === 'none' || lower === 'transparent') return 'none';
  if (lower === 'currentcolor') return '#000000'; // limitação: sem cascata de "color" do CSS
  if (v[0] === '#') return normalizeHex(v);
  if (lower.startsWith('rgb')) return parseRgbFunc(v);
  if (NAMED_COLORS[lower]) return NAMED_COLORS[lower];
  return '#000000'; // fallback documentado (hsl(), url(#gradiente), etc.)
}

function normalizeHex(v) {
  let h = v.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return '#000000';
  const n = parseInt(h, 16);
  return Number.isNaN(n) ? '#000000' : '#' + h.toLowerCase();
}

function parseRgbFunc(v) {
  const open = v.indexOf('(');
  const close = v.indexOf(')');
  if (open === -1 || close === -1) return '#000000';
  const parts = v.slice(open + 1, close).split(',');
  if (parts.length < 3) return '#000000';
  const chan = (raw) => {
    const s = raw.trim();
    const isPct = s.endsWith('%');
    const num = parseFloat(isPct ? s.slice(0, -1) : s);
    if (Number.isNaN(num)) return 0;
    const v255 = isPct ? (num * 255) / 100 : num;
    return Math.max(0, Math.min(255, Math.round(v255)));
  };
  const hex = [chan(parts[0]), chan(parts[1]), chan(parts[2])]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
  return '#' + hex;
}

function parseInlineStyle(styleStr) {
  const result = {};
  const decls = String(styleStr || '').split(';');
  for (const decl of decls) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const key = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function resolveStyle(attrs, inherited) {
  let fill = inherited.fill;
  let stroke = inherited.stroke;
  if (attrs.fill !== undefined) fill = attrs.fill;
  if (attrs.stroke !== undefined) stroke = attrs.stroke;
  if (attrs.style) {
    const decls = parseInlineStyle(attrs.style);
    if (decls.fill !== undefined) fill = decls.fill;
    if (decls.stroke !== undefined) stroke = decls.stroke;
  }
  return { fill: parseColor(fill), stroke: parseColor(stroke) };
}

function isDisplayNone(attrs) {
  if (attrs.display && attrs.display.trim().toLowerCase() === 'none') return true;
  if (attrs.style) {
    const decls = parseInlineStyle(attrs.style);
    if (decls.display && decls.display.trim().toLowerCase() === 'none') return true;
  }
  return false;
}

// ------------------------------------------------------------------ formas -> subpaths

function num(v, fallback) {
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}

function rectToSubpaths(attrs) {
  const x = num(attrs.x, 0);
  const y = num(attrs.y, 0);
  const w = num(attrs.width, 0);
  const h = num(attrs.height, 0);
  if (!(w > 0) || !(h > 0)) return [];
  let rx = attrs.rx !== undefined ? num(attrs.rx, 0) : attrs.ry !== undefined ? num(attrs.ry, 0) : 0;
  let ry = attrs.ry !== undefined ? num(attrs.ry, 0) : rx;
  rx = Math.max(0, Math.min(rx, w / 2));
  ry = Math.max(0, Math.min(ry, h / 2));
  let d;
  if (rx > EPS && ry > EPS) {
    d =
      `M${x + rx},${y} H${x + w - rx} A${rx},${ry} 0 0 1 ${x + w},${y + ry} ` +
      `V${y + h - ry} A${rx},${ry} 0 0 1 ${x + w - rx},${y + h} ` +
      `H${x + rx} A${rx},${ry} 0 0 1 ${x},${y + h - ry} ` +
      `V${y + ry} A${rx},${ry} 0 0 1 ${x + rx},${y} Z`;
  } else {
    d = `M${x},${y} H${x + w} V${y + h} H${x} Z`;
  }
  return svgpath.parsePathD(d);
}

function ellipseSubpaths(cx, cy, rx, ry) {
  if (!(rx > EPS) || !(ry > EPS)) return [];
  const d = `M${cx - rx},${cy} A${rx},${ry} 0 1 1 ${cx + rx},${cy} A${rx},${ry} 0 1 1 ${cx - rx},${cy} Z`;
  return svgpath.parsePathD(d);
}

function lineToSubpaths(attrs) {
  const p0 = [num(attrs.x1, 0), num(attrs.y1, 0)];
  const p3 = [num(attrs.x2, 0), num(attrs.y2, 0)];
  if (Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) < EPS) return [];
  return [{ closed: false, segments: [svgpath.lineAsCubic(p0, p3)] }];
}

function pointsToSubpaths(attrs, closed) {
  const nums = svgpath.parseNumberList(attrs.points);
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  if (pts.length < 2) return [];
  const segments = [];
  for (let i = 1; i < pts.length; i++) segments.push(svgpath.lineAsCubic(pts[i - 1], pts[i]));
  if (closed) segments.push(svgpath.lineAsCubic(pts[pts.length - 1], pts[0]));
  return [{ closed, segments }];
}

function shapeToSubpaths(tag, attrs) {
  switch (tag) {
    case 'path':
      return svgpath.parsePathD(attrs.d || '');
    case 'rect':
      return rectToSubpaths(attrs);
    case 'circle':
      return ellipseSubpaths(num(attrs.cx, 0), num(attrs.cy, 0), num(attrs.r, 0), num(attrs.r, 0));
    case 'ellipse':
      return ellipseSubpaths(num(attrs.cx, 0), num(attrs.cy, 0), num(attrs.rx, 0), num(attrs.ry, 0));
    case 'line':
      return lineToSubpaths(attrs);
    case 'polyline':
      return pointsToSubpaths(attrs, false);
    case 'polygon':
      return pointsToSubpaths(attrs, true);
    default:
      return null;
  }
}

// Tags que não representam forma visível diretamente (definições/metadados).
const SKIP_TAGS = new Set(['defs', 'clippath', 'mask', 'symbol', 'style', 'title', 'desc', 'metadata']);
const CONTAINER_TAGS = new Set(['g', 'a', 'svg']);

// ------------------------------------------------------------------ API principal

// Devolve { fills: [{color, rings}], strokes: [{color, polylines}] }, ambos
// na ordem de primeira aparição no documento. "rings"/"polylines" já estão
// achatados e na unidade interna do Bastidor (0,1 mm), incluindo transforms
// (do próprio elemento e de todos os <g> ancestrais, aninhados ou não).
function parseSvgToShapeGroups(svgText) {
  const root = parseXml(svgText);
  const svgEl = findChildTag(root, 'svg');
  const fillMap = new Map();
  const fillOrder = [];
  const strokeMap = new Map();
  const strokeOrder = [];

  if (!svgEl) return { fills: [], strokes: [] };

  function addFill(color, rings) {
    if (!rings.length) return;
    if (!fillMap.has(color)) {
      fillMap.set(color, []);
      fillOrder.push(color);
    }
    fillMap.get(color).push(...rings);
  }

  function addStroke(color, polylines) {
    if (!polylines.length) return;
    if (!strokeMap.has(color)) {
      strokeMap.set(color, []);
      strokeOrder.push(color);
    }
    strokeMap.get(color).push(...polylines);
  }

  function walk(node, ctm, style) {
    for (const child of node.children) {
      if (!child || child.type !== 'element') continue;
      const tag = child.tag.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (isDisplayNone(child.attrs)) continue;

      const ownTransform = child.attrs.transform ? svgpath.parseTransformList(child.attrs.transform) : svgpath.IDENTITY;
      const childCtm = svgpath.multiply(ctm, ownTransform);
      const childStyle = resolveStyle(child.attrs, style);

      if (CONTAINER_TAGS.has(tag)) {
        walk(child, childCtm, childStyle);
        continue;
      }

      const subpaths = shapeToSubpaths(tag, child.attrs);
      if (!subpaths || subpaths.length === 0) continue;
      const transformed = svgpath.transformSubpaths(subpaths, childCtm);
      const flat = svgpath.flattenSubpaths(transformed, FLATTEN_TOLERANCE);

      if (childStyle.fill && childStyle.fill !== 'none') {
        addFill(childStyle.fill, flat.filter((sp) => sp.points.length >= 3).map((sp) => ({ points: sp.points })));
      }
      if (childStyle.stroke && childStyle.stroke !== 'none') {
        addStroke(
          childStyle.stroke,
          flat.filter((sp) => sp.points.length >= 2).map((sp) => ({ points: sp.points, closed: sp.closed }))
        );
      }
    }
  }

  const unitsCtm = computeUnitsMatrix(svgEl.attrs);
  walk(svgEl, unitsCtm, { fill: '#000000', stroke: 'none' });

  return {
    fills: fillOrder.map((color) => ({ color, rings: fillMap.get(color) })),
    strokes: strokeOrder.map((color) => ({ color, polylines: strokeMap.get(color) })),
  };
}

module.exports = {
  parseXml,
  parseSvgToShapeGroups,
  parseColor,
  parseLength,
  computeUnitsMatrix,
};
