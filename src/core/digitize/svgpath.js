'use strict';
// Geometria de path SVG: parser do atributo "d", conversão de arcos em
// curvas de Bézier cúbicas e matrizes de transform (translate/scale/rotate/
// matrix/skew), com composição para transforms aninhados (grupos <g>).
//
// Todo segmento interno é representado como cúbica (p0, c1, c2, p3): uma
// reta é apenas uma cúbica degenerada (pontos de controle sobre a reta),
// o que mantém achatamento e transform num único código sem casos especiais.

const EPS = 1e-9;

// ------------------------------------------------------------------ matrizes
// Convenção SVG: x' = a*x + c*y + e ; y' = b*x + d*y + f.

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function multiply(m1, m2) {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

function applyPoint(m, x, y) {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

function translate(tx, ty = 0) {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

function scaleM(sx, sy = sx) {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

function rotateM(deg, cx, cy) {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const rot = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
  if (cx === undefined) return rot;
  return multiply(multiply(translate(cx, cy), rot), translate(-cx, -cy));
}

function skewXM(deg) {
  return { a: 1, b: 0, c: Math.tan((deg * Math.PI) / 180), d: 1, e: 0, f: 0 };
}

function skewYM(deg) {
  return { a: 1, b: Math.tan((deg * Math.PI) / 180), c: 0, d: 1, e: 0, f: 0 };
}

// Tokenizador simples de "translate(1 2) scale(2) ..." sem expressões regulares.
function parseTransformList(str) {
  let result = IDENTITY;
  if (!str) return result;
  const s = String(str);
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && isSeparator(s[i])) i++;
    let nameStart = i;
    while (i < n && isLetter(s[i])) i++;
    const name = s.slice(nameStart, i);
    if (!name) break;
    while (i < n && isSeparator(s[i])) i++;
    if (s[i] !== '(') break;
    i++;
    const args = [];
    for (;;) {
      while (i < n && isSeparator(s[i])) i++;
      if (i >= n || s[i] === ')') break;
      const start = i;
      i = readNumberAt(s, i);
      if (i === start) break;
      args.push(parseFloat(s.slice(start, i)));
    }
    while (i < n && isSeparator(s[i])) i++;
    if (s[i] === ')') i++;
    result = multiply(result, transformFromArgs(name, args));
  }
  return result;
}

function transformFromArgs(name, a) {
  switch (name) {
    case 'translate':
      return translate(a[0] || 0, a[1] || 0);
    case 'scale':
      return scaleM(a[0] === undefined ? 1 : a[0], a[1] === undefined ? a[0] : a[1]);
    case 'rotate':
      return rotateM(a[0] || 0, a[1], a[2]);
    case 'skewX':
      return skewXM(a[0] || 0);
    case 'skewY':
      return skewYM(a[0] || 0);
    case 'matrix':
      return { a: a[0] || 0, b: a[1] || 0, c: a[2] || 0, d: a[3] || 0, e: a[4] || 0, f: a[5] || 0 };
    default:
      return IDENTITY;
  }
}

function isSeparator(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',';
}

function isLetter(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

// Lê um número (com sinal/decimal/expoente) a partir de "i"; devolve o
// índice após o número (igual a "i" se não havia número ali).
function readNumberAt(s, i) {
  const n = s.length;
  let j = i;
  if (s[j] === '+' || s[j] === '-') j++;
  let intDigits = 0;
  let fracDigits = 0;
  while (j < n && isDigit(s[j])) {
    j++;
    intDigits++;
  }
  if (s[j] === '.') {
    j++;
    while (j < n && isDigit(s[j])) {
      j++;
      fracDigits++;
    }
  }
  if (intDigits === 0 && fracDigits === 0) return i;
  if (s[j] === 'e' || s[j] === 'E') {
    let k = j + 1;
    if (s[k] === '+' || s[k] === '-') k++;
    if (isDigit(s[k])) {
      while (k < n && isDigit(s[k])) k++;
      j = k;
    }
  }
  return j;
}

function isDigit(c) {
  return c >= '0' && c <= '9';
}

// Extrai todos os números de uma lista separada por espaço/vírgula (usado
// para "viewBox" e "points"). Sem expressões regulares.
function parseNumberList(str) {
  const s = String(str || '');
  const n = s.length;
  const out = [];
  let i = 0;
  while (i < n) {
    while (i < n && isSeparator(s[i])) i++;
    if (i >= n) break;
    const start = i;
    const end = readNumberAt(s, i);
    if (end === i) {
      i++; // caractere inesperado: pula e continua tolerante
      continue;
    }
    out.push(parseFloat(s.slice(start, end)));
    i = end;
  }
  return out;
}

// ------------------------------------------------------------------ parser de "d"

class PathScanner {
  constructor(d) {
    this.s = String(d || '');
    this.n = this.s.length;
    this.i = 0;
  }

  skipSeparators() {
    while (this.i < this.n && isSeparator(this.s[this.i])) this.i++;
  }

  peek() {
    return this.i < this.n ? this.s[this.i] : '';
  }

  hasMore() {
    this.skipSeparators();
    return this.i < this.n;
  }

  readCommand() {
    this.skipSeparators();
    const c = this.peek();
    if ('MmLlHhVvCcSsQqTtAaZz'.includes(c)) {
      this.i++;
      return c;
    }
    return null;
  }

  // Espia se o próximo token parece um número (permite continuar repetindo
  // os argumentos de um comando sem repetir a letra, regra padrão do SVG).
  peekIsNumber() {
    this.skipSeparators();
    return readNumberAt(this.s, this.i) !== this.i;
  }

  readNumber() {
    this.skipSeparators();
    const start = this.i;
    const end = readNumberAt(this.s, start);
    if (end === start) return null;
    this.i = end;
    return parseFloat(this.s.slice(start, end));
  }

  // Flag de arco: exatamente um dígito 0 ou 1, sem exigir separador antes
  // do próximo número (ex.: "1150,50" = flag 1, flag 1, 50, 50).
  readFlag() {
    this.skipSeparators();
    const c = this.peek();
    if (c === '0' || c === '1') {
      this.i++;
      return c === '1';
    }
    return null;
  }
}

// Converte o "d" em subpaths: { closed, segments: [{p0,c1,c2,p3}, ...] }.
// Coordenadas absolutas no espaço local do elemento (antes de qualquer
// transform). Comandos desconhecidos ou "d" vazio geram lista vazia.
function parsePathD(d) {
  const sc = new PathScanner(d);
  const subpaths = [];
  let cur = null; // subpath em construção
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastCubicCtrl = null; // p/ reflexo do C/S
  let lastQuadCtrl = null; // p/ reflexo do Q/T
  let lastCmd = '';

  function startSubpath(x, y) {
    cur = { closed: false, segments: [] };
    subpaths.push(cur);
    cx = x;
    cy = y;
    sx = x;
    sy = y;
  }

  function pushLine(x, y) {
    if (!cur) startSubpath(cx, cy);
    const p0 = [cx, cy];
    const p3 = [x, y];
    cur.segments.push(lineAsCubic(p0, p3));
    cx = x;
    cy = y;
  }

  function pushCubic(x1, y1, x2, y2, x, y) {
    if (!cur) startSubpath(cx, cy);
    cur.segments.push({ p0: [cx, cy], c1: [x1, y1], c2: [x2, y2], p3: [x, y] });
    cx = x;
    cy = y;
  }

  for (;;) {
    const cmd = sc.readCommand();
    if (cmd === null) break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    if (C === 'M') {
      let first = true;
      while (first || sc.peekIsNumber()) {
        const x0 = sc.readNumber();
        const y0 = sc.readNumber();
        if (x0 === null || y0 === null) break;
        const x = rel && !first ? cx + x0 : rel && first ? cx + x0 : x0;
        const y = rel && !first ? cy + y0 : rel && first ? cy + y0 : y0;
        if (first) {
          startSubpath(x, y);
        } else {
          pushLine(x, y);
        }
        first = false;
        lastCubicCtrl = null;
        lastQuadCtrl = null;
      }
      lastCmd = 'M';
      continue;
    }

    if (C === 'Z') {
      if (cur) {
        if (Math.hypot(cx - sx, cy - sy) > EPS) {
          cur.segments.push(lineAsCubic([cx, cy], [sx, sy]));
        }
        cur.closed = true;
        cx = sx;
        cy = sy;
      }
      lastCmd = 'Z';
      continue;
    }

    if (C === 'L' || C === 'H' || C === 'V') {
      let any = false;
      while (any === false || sc.peekIsNumber()) {
        let x;
        let y;
        if (C === 'H') {
          const v = sc.readNumber();
          if (v === null) break;
          x = rel ? cx + v : v;
          y = cy;
        } else if (C === 'V') {
          const v = sc.readNumber();
          if (v === null) break;
          x = cx;
          y = rel ? cy + v : v;
        } else {
          const x0 = sc.readNumber();
          const y0 = sc.readNumber();
          if (x0 === null || y0 === null) break;
          x = rel ? cx + x0 : x0;
          y = rel ? cy + y0 : y0;
        }
        pushLine(x, y);
        any = true;
      }
      lastCubicCtrl = null;
      lastQuadCtrl = null;
      lastCmd = C;
      continue;
    }

    if (C === 'C' || C === 'S') {
      let any = false;
      while (any === false || sc.peekIsNumber()) {
        let x1;
        let y1;
        if (C === 'S') {
          if (lastCmd === 'C' || lastCmd === 'S') {
            x1 = 2 * cx - lastCubicCtrl[0];
            y1 = 2 * cy - lastCubicCtrl[1];
          } else {
            x1 = cx;
            y1 = cy;
          }
        } else {
          const rx1 = sc.readNumber();
          const ry1 = sc.readNumber();
          if (rx1 === null || ry1 === null) break;
          x1 = rel ? cx + rx1 : rx1;
          y1 = rel ? cy + ry1 : ry1;
        }
        const rx2 = sc.readNumber();
        const ry2 = sc.readNumber();
        const rx3 = sc.readNumber();
        const ry3 = sc.readNumber();
        if (rx2 === null || ry2 === null || rx3 === null || ry3 === null) break;
        const x2 = rel ? cx + rx2 : rx2;
        const y2 = rel ? cy + ry2 : ry2;
        const x3 = rel ? cx + rx3 : rx3;
        const y3 = rel ? cy + ry3 : ry3;
        pushCubic(x1, y1, x2, y2, x3, y3);
        lastCubicCtrl = [x2, y2];
        lastQuadCtrl = null;
        lastCmd = C;
        any = true;
      }
      continue;
    }

    if (C === 'Q' || C === 'T') {
      let any = false;
      while (any === false || sc.peekIsNumber()) {
        let qx;
        let qy;
        if (C === 'T') {
          if (lastCmd === 'Q' || lastCmd === 'T') {
            qx = 2 * cx - lastQuadCtrl[0];
            qy = 2 * cy - lastQuadCtrl[1];
          } else {
            qx = cx;
            qy = cy;
          }
        } else {
          const rqx = sc.readNumber();
          const rqy = sc.readNumber();
          if (rqx === null || rqy === null) break;
          qx = rel ? cx + rqx : rqx;
          qy = rel ? cy + rqy : rqy;
        }
        const rex = sc.readNumber();
        const rey = sc.readNumber();
        if (rex === null || rey === null) break;
        const ex = rel ? cx + rex : rex;
        const ey = rel ? cy + rey : rey;
        // Quadrática -> cúbica: C1 = P0 + 2/3*(Q-P0), C2 = P3 + 2/3*(Q-P3).
        const x1 = cx + (2 / 3) * (qx - cx);
        const y1 = cy + (2 / 3) * (qy - cy);
        const x2 = ex + (2 / 3) * (qx - ex);
        const y2 = ey + (2 / 3) * (qy - ey);
        pushCubic(x1, y1, x2, y2, ex, ey);
        lastQuadCtrl = [qx, qy];
        lastCubicCtrl = null;
        lastCmd = C;
        any = true;
      }
      continue;
    }

    if (C === 'A') {
      let any = false;
      while (any === false || sc.peekIsNumber()) {
        const rx = sc.readNumber();
        const ry = sc.readNumber();
        const xRot = sc.readNumber();
        const largeArc = sc.readFlag();
        const sweep = sc.readFlag();
        const ex0 = sc.readNumber();
        const ey0 = sc.readNumber();
        if (
          rx === null || ry === null || xRot === null || largeArc === null ||
          sweep === null || ex0 === null || ey0 === null
        ) {
          break;
        }
        const ex = rel ? cx + ex0 : ex0;
        const ey = rel ? cy + ey0 : ey0;
        const cubics = arcToCubics(cx, cy, rx, ry, xRot, largeArc, sweep, ex, ey);
        for (const q of cubics) pushCubic(q.c1[0], q.c1[1], q.c2[0], q.c2[1], q.p3[0], q.p3[1]);
        lastCubicCtrl = null;
        lastQuadCtrl = null;
        lastCmd = 'A';
        any = true;
      }
      continue;
    }

    // Comando não suportado: para a leitura (evita loop infinito).
    break;
  }

  return subpaths;
}

function lineAsCubic(p0, p3) {
  return {
    p0,
    c1: [p0[0] + (p3[0] - p0[0]) / 3, p0[1] + (p3[1] - p0[1]) / 3],
    c2: [p0[0] + (2 * (p3[0] - p0[0])) / 3, p0[1] + (2 * (p3[1] - p0[1])) / 3],
    p3,
  };
}

// ------------------------------------------------------------------ arco -> cúbicas
// "Elliptical arc implementation notes" (spec SVG, apêndice F.6): endpoint ->
// centro, dividido em segmentos <=90° aproximados por cúbicas (fórmula
// clássica kappa = 4/3*tan(theta/4), igual à usada em snap.svg/fontello a2c).

function arcToCubics(x1, y1, rx, ry, xAxisRotationDeg, largeArc, sweep, x2, y2) {
  if (rx === 0 || ry === 0 || (Math.abs(x1 - x2) < EPS && Math.abs(y1 - y2) < EPS)) {
    return [{ c1: [x1, y1], c2: [x2, y2], p3: [x2, y2] }]; // degenera em reta
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = ((xAxisRotationDeg % 360) * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // Ajuste de raio (se pequeno demais para alcançar o ponto final).
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const rxSq = rx * rx;
  const rySq = ry * ry;
  const x1pSq = x1p * x1p;
  const y1pSq = y1p * y1p;
  let num = rxSq * rySq - rxSq * y1pSq - rySq * x1pSq;
  const den = rxSq * y1pSq + rySq * x1pSq;
  let co = den > EPS ? Math.sqrt(Math.max(0, num / den)) : 0;
  if (largeArc === sweep) co = -co;

  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const theta1 = angleBetween(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = angleBetween((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;

  const segCount = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)));
  const delta = dtheta / segCount;
  const cubics = [];
  let a1 = theta1;
  for (let i = 0; i < segCount; i++) {
    const a2 = a1 + delta;
    cubics.push(unitArcToCubic(a1, a2, cx, cy, rx, ry, cosPhi, sinPhi));
    a1 = a2;
  }
  return cubics;
}

function unitArcToCubic(a1, a2, cx, cy, rx, ry, cosPhi, sinPhi) {
  // Constante clássica de aproximação de arco unitário por cúbica
  // (mesma usada em snap.svg/fontello "a2c"): alpha = 4/3 * tan(dtheta/4).
  const alpha = (4 / 3) * Math.tan((a2 - a1) / 4);
  const cos1 = Math.cos(a1);
  const sin1 = Math.sin(a1);
  const cos2 = Math.cos(a2);
  const sin2 = Math.sin(a2);

  const p1 = [cos1 - sin1 * alpha, sin1 + cos1 * alpha];
  const p2 = [cos2 + sin2 * alpha, sin2 - cos2 * alpha];
  const p3u = [cos2, sin2];

  const map = ([ux, uy]) => [cx + rx * ux * cosPhi - ry * uy * sinPhi, cy + rx * ux * sinPhi + ry * uy * cosPhi];
  return { c1: map(p1), c2: map(p2), p3: map(p3u) };
}

function angleBetween(ux, uy, vx, vy) {
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  let dot = ux * vx + uy * vy;
  const lenU = Math.hypot(ux, uy);
  const lenV = Math.hypot(vx, vy);
  const denom = lenU * lenV;
  dot = denom > EPS ? dot / denom : 1;
  dot = Math.min(1, Math.max(-1, dot));
  return sign * Math.acos(dot);
}

// ------------------------------------------------------------------ transform + achatamento

function transformSubpaths(subpaths, m) {
  const tp = (p) => applyPoint(m, p[0], p[1]);
  return subpaths.map((sp) => ({
    closed: sp.closed,
    segments: sp.segments.map((seg) => ({
      p0: tp(seg.p0),
      c1: tp(seg.c1),
      c2: tp(seg.c2),
      p3: tp(seg.p3),
    })),
  }));
}

// Achata uma cúbica por subdivisão adaptativa (de Casteljau), testando a
// distância dos pontos de controle à corda p0-p3 contra "tolerance".
function flattenCubic(p0, c1, c2, p3, tolerance, out, depth) {
  depth = depth || 0;
  if (depth > 24 || isFlatEnough(p0, c1, c2, p3, tolerance)) {
    out.push(p3);
    return;
  }
  // Subdivisão de de Casteljau em t=0,5.
  const p01 = mid(p0, c1);
  const p12 = mid(c1, c2);
  const p23 = mid(c2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const p0123 = mid(p012, p123);
  flattenCubic(p0, p01, p012, p0123, tolerance, out, depth + 1);
  flattenCubic(p0123, p123, p23, p3, tolerance, out, depth + 1);
}

function mid(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function isFlatEnough(p0, c1, c2, p3, tolerance) {
  const d1 = pointLineDistance(c1, p0, p3);
  const d2 = pointLineDistance(c2, p0, p3);
  return d1 <= tolerance && d2 <= tolerance;
}

function pointLineDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < EPS) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

// subpaths (com segmentos já transformados) -> polilinhas achatadas.
function flattenSubpaths(subpaths, tolerance) {
  return subpaths.map((sp) => {
    const pts = [];
    if (sp.segments.length === 0) return { points: pts, closed: sp.closed };
    pts.push(sp.segments[0].p0);
    for (const seg of sp.segments) {
      flattenCubic(seg.p0, seg.c1, seg.c2, seg.p3, tolerance, pts, 0);
    }
    return { points: pts, closed: sp.closed };
  });
}

// Conveniência: "d" -> polilinhas já no espaço final (após aplicar matrix).
function pathToPolylines(d, matrix, tolerance) {
  const subpaths = parsePathD(d);
  const transformed = transformSubpaths(subpaths, matrix || IDENTITY);
  return flattenSubpaths(transformed, tolerance === undefined ? 0.05 : tolerance);
}

module.exports = {
  IDENTITY,
  multiply,
  applyPoint,
  translate,
  scale: scaleM,
  rotate: rotateM,
  skewX: skewXM,
  skewY: skewYM,
  parseTransformList,
  parseNumberList,
  parsePathD,
  transformSubpaths,
  flattenSubpaths,
  flattenCubic,
  pathToPolylines,
  lineAsCubic,
  arcToCubics,
};
