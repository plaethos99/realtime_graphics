// 2D math plots: curves are computed from the model's formulas (so they are exact even when the model's
// arithmetic isn't), drawn over hand-lettered axes. Data coordinates have y growing up.
import rough from 'roughjs';
import type { Options } from 'roughjs/bin/core';
import { compile, compileEquation, type Compiled } from './expr';
import { hasMath, svgMathLabel } from './math';
import { SVG_NS, makeText, svgEl, textWidth } from './svg';
import { colorOf, PAPER } from './theme';
import type { PlotItem, PlotSpec, Range, Vec2 } from './types';

const PAD = { l: 34, r: 14, t: 14, b: 24 };
const CURVE_COLORS = ['blue', 'red', 'green', 'purple', 'orange', 'teal'];
const MUTED = '#8a867e';
let clipCounter = 0;

const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec2 = (v: unknown): v is Vec2 => Array.isArray(v) && v.length >= 2 && ok(v[0]) && ok(v[1]);

function validRange(r: unknown): Range | null {
  if (!Array.isArray(r) || r.length < 2 || !ok(r[0]) || !ok(r[1]) || r[0] === r[1]) return null;
  return r[0] < r[1] ? [r[0], r[1]] : [r[1], r[0]];
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/** Grow [lo, hi] by `pad` of its span, keep a minimum size, and snap to 0 when 0 is close. */
function settle(lo: number, hi: number, pad: number): Range {
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const span = hi - lo;
  if (lo > 0 && lo < span * 0.6) lo = 0;
  if (hi < 0 && -hi < span * 0.6) hi = 0;
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

function niceStep(span: number, target: number): number {
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

function fmt(v: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return String(+v.toFixed(decimals)).replace('-', '−');
}

interface Ctx {
  svg: SVGSVGElement;
  rc: ReturnType<typeof rough.svg>;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  sx: (x: number) => number;
  sy: (y: number) => number;
  plotArea: { l: number; t: number; r: number; b: number };
  placed: { l: number; t: number; r: number; b: number }[];
  errors: string[];
}

export function drawPlot(spec: PlotSpec, animate: boolean): SVGSVGElement {
  const W = Math.min(800, Math.max(220, spec.width ?? 400));
  const H = Math.min(700, Math.max(160, spec.height ?? 300));
  const items = (spec.items ?? []).filter((it) => it && typeof it === 'object');
  const errors: string[] = [];

  // Functions can be referred to by id (points on a curve, tangents, areas).
  const named = new Map<string, Compiled>();
  const fx = (ref: string | undefined): Compiled | null => {
    if (!ref) return null;
    const hit = named.get(ref);
    if (hit) return hit;
    try {
      return compile(ref, ['x']);
    } catch (err) {
      errors.push(`${ref}: ${(err as Error).message}`);
      return null;
    }
  };
  const curves: { item: Extract<PlotItem, { kind: 'function' }>; f: Compiled }[] = [];
  for (const it of items) {
    if (it.kind !== 'function') continue;
    const f = fx(it.fn);
    if (!f) continue;
    curves.push({ item: it, f });
    if (it.id) named.set(it.id, f);
  }
  const param = (src: string, v: string): Compiled | null => {
    try {
      return compile(src, [v]);
    } catch (err) {
      errors.push(`${src}: ${(err as Error).message}`);
      return null;
    }
  };

  // ---- ranges ----
  const geoX: number[] = [];
  const geoY: number[] = [];
  const addPt = (p: unknown) => {
    if (isVec2(p)) {
      geoX.push(p[0]);
      geoY.push(p[1]);
    }
  };
  for (const it of items) {
    if (it.kind === 'point') {
      if (isVec2(it.at)) addPt(it.at);
      else if (ok(it.x)) geoX.push(it.x);
    } else if (it.kind === 'segment') [it.from, it.to].forEach(addPt);
    else if (it.kind === 'polygon') (it.points ?? []).forEach(addPt);
    else if (it.kind === 'angle') [it.at, it.from, it.to].forEach(addPt);
    else if (it.kind === 'text') addPt(it.at);
    else if (it.kind === 'circle' && isVec2(it.center) && ok(it.r)) {
      addPt([it.center[0] - it.r, it.center[1] - it.r]);
      addPt([it.center[0] + it.r, it.center[1] + it.r]);
    } else if (it.kind === 'vline' && ok(it.x)) geoX.push(it.x);
    else if (it.kind === 'hline' && ok(it.y)) geoY.push(it.y);
    else if (it.kind === 'area') [it.from, it.to].filter(ok).forEach((v) => geoX.push(v));
    else if (it.kind === 'tangent' && ok(it.at)) geoX.push(it.at);
    else if (it.kind === 'parametric') {
      const X = param(it.x, 't');
      const Y = param(it.y, 't');
      const t = validRange(it.t) ?? [0, Math.PI * 2];
      if (X && Y)
        for (let i = 0; i <= 120; i++) {
          const s = { t: t[0] + ((t[1] - t[0]) * i) / 120 };
          addPt([X(s), Y(s)]);
        }
    }
  }
  const onlyFunctions = !geoX.length;
  let [x0, x1] = validRange(spec.x) ?? (onlyFunctions ? [-10, 10] : settle(Math.min(...geoX), Math.max(...geoX), 0.15));

  let yr = validRange(spec.y);
  if (!yr) {
    const ys: number[] = [];
    for (const { item, f } of curves) {
      const d = validRange(item.domain) ?? [x0, x1];
      for (let i = 0; i <= 240; i++) {
        const y = f({ x: d[0] + ((d[1] - d[0]) * i) / 240 });
        if (ok(y)) ys.push(y);
      }
    }
    ys.sort((a, b) => a - b);
    // Quantiles ignore the spikes near asymptotes (tan x, 1/x); geometry is always fully shown.
    const lo = Math.min(...(ys.length ? [quantile(ys, 0.03)] : []), ...geoY);
    const hi = Math.max(...(ys.length ? [quantile(ys, 0.97)] : []), ...geoY);
    yr = Number.isFinite(lo) && Number.isFinite(hi) ? settle(lo, hi, 0.1) : [-10, 10];
  }
  let [y0, y1] = yr;

  const pw = W - PAD.l - PAD.r;
  const ph = H - PAD.t - PAD.b;
  if (spec.equal) {
    // Same units per pixel on both axes: widen whichever range is too narrow.
    const unit = Math.max((x1 - x0) / pw, (y1 - y0) / ph);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    [x0, x1] = [cx - (unit * pw) / 2, cx + (unit * pw) / 2];
    [y0, y1] = [cy - (unit * ph) / 2, cy + (unit * ph) / 2];
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', `rtg-diagram rtg-plot${animate ? ' rtg-anim' : ''}`);
  svg.setAttribute('role', 'img');
  const ctx: Ctx = {
    svg,
    rc: rough.svg(svg),
    x0,
    x1,
    y0,
    y1,
    sx: (x) => PAD.l + ((x - x0) / (x1 - x0)) * pw,
    sy: (y) => PAD.t + ((y1 - y) / (y1 - y0)) * ph,
    plotArea: { l: PAD.l, t: PAD.t, r: PAD.l + pw, b: PAD.t + ph },
    placed: [],
    errors,
  };

  const clipId = `rtg-clip-${++clipCounter}`;
  const defs = svgEl('defs');
  const clip = svgEl('clipPath', { id: clipId });
  clip.appendChild(svgEl('rect', { x: PAD.l, y: PAD.t, width: pw, height: ph }));
  defs.appendChild(clip);
  svg.appendChild(defs);

  drawAxes(ctx, spec);

  let order = 1;
  let curveIndex = 0;
  const add = (g: SVGGElement | null, clipped = true) => {
    if (!g) return;
    g.classList.add('rtg-el');
    if (clipped) g.setAttribute('clip-path', `url(#${clipId})`);
    if (animate) {
      g.style.setProperty('--d', `${order * 160}ms`);
      for (const path of g.querySelectorAll('path')) {
        const stroke = path.getAttribute('stroke');
        if (stroke && stroke !== 'none' && !path.dataset.static) {
          path.setAttribute('pathLength', '1');
          path.classList.add('rtg-stroke');
        }
      }
    }
    svg.appendChild(g);
    order++;
  };
  const labels: (() => void)[] = []; // drawn last so they sit on top
  const curveColor = (c?: string) => c ?? CURVE_COLORS[curveIndex++ % CURVE_COLORS.length];

  // Fills first, then curves and shapes, then points.
  for (const it of items) {
    if (it.kind !== 'area') continue;
    const top = fx(it.fn);
    const bottom = it.fn2 ? fx(it.fn2) : () => 0;
    if (!top || !bottom || !ok(it.from) || !ok(it.to)) continue;
    const color = colorOf(it.color ?? 'blue');
    const pts: Vec2[] = [];
    const n = 80;
    for (let i = 0; i <= n; i++) {
      const x = it.from + ((it.to - it.from) * i) / n;
      pts.push([ctx.sx(x), ctx.sy(clampY(ctx, top({ x })))]);
    }
    for (let i = n; i >= 0; i--) {
      const x = it.from + ((it.to - it.from) * i) / n;
      pts.push([ctx.sx(x), ctx.sy(clampY(ctx, bottom({ x })))]);
    }
    const g = svgEl('g');
    g.appendChild(
      ctx.rc.polygon(pts, { roughness: 0.6, seed: order, stroke: 'none', fill: color.stroke, fillStyle: 'hachure', hachureGap: 5, fillWeight: 1.1, hachureAngle: -41 }),
    );
    add(g);
    if (it.label) {
      const mx = (it.from + it.to) / 2;
      const my = (top({ x: mx }) + bottom({ x: mx })) / 2;
      labels.push(() => label(ctx, it.label!, ctx.sx(mx), ctx.sy(clampY(ctx, my)), color.stroke, 'middle'));
    }
  }

  for (const it of items) {
    switch (it.kind) {
      case 'function': {
        const entry = curves.find((c) => c.item === it);
        if (!entry) break;
        const d = validRange(it.domain) ?? [x0, x1];
        const pieces = sampleFunction(ctx, entry.f, Math.max(d[0], x0), Math.min(d[1], x1));
        const color = colorOf(curveColor(it.color));
        add(curvePath(pieces.map((p) => p.map(([x, y]) => [ctx.sx(x), ctx.sy(y)] as Vec2)), color.stroke, it.dashed));
        if (it.label) {
          const at = curveLabelPoint(ctx, pieces);
          if (at) labels.push(() => label(ctx, it.label!, at[0], at[1], color.stroke, 'end'));
        }
        break;
      }
      case 'parametric': {
        const X = param(it.x, 't');
        const Y = param(it.y, 't');
        if (!X || !Y) break;
        const t = validRange(it.t) ?? [0, Math.PI * 2];
        const pts: Vec2[] = [];
        for (let i = 0; i <= 600; i++) {
          const s = { t: t[0] + ((t[1] - t[0]) * i) / 600 };
          const x = X(s);
          const y = Y(s);
          if (ok(x) && ok(y)) pts.push([ctx.sx(x), ctx.sy(clampY(ctx, y))]);
        }
        const color = colorOf(curveColor(it.color));
        add(curvePath([pts], color.stroke, it.dashed));
        if (it.label && pts.length) {
          const p = pts[Math.floor(pts.length * 0.15)];
          labels.push(() => label(ctx, it.label!, p[0] + 8, p[1] - 12, color.stroke, 'start'));
        }
        break;
      }
      case 'implicit': {
        let f: Compiled;
        try {
          f = compileEquation(it.eq);
        } catch (err) {
          errors.push(`${it.eq}: ${(err as Error).message}`);
          break;
        }
        const color = colorOf(curveColor(it.color));
        const { d, top } = contour(ctx, f);
        if (!d) break;
        const g = svgEl('g');
        const path = svgEl('path', { d, fill: 'none', stroke: color.stroke, 'stroke-width': 2.4, 'stroke-linecap': 'round' });
        if (it.dashed) path.setAttribute('stroke-dasharray', '7 6');
        path.dataset.static = '1'; // many tiny segments: fade in rather than trace
        g.appendChild(path);
        add(g);
        if (it.label && top) labels.push(() => label(ctx, it.label!, top[0] + 8, top[1] - 12, color.stroke, 'start'));
        break;
      }
      case 'tangent': {
        const f = fx(it.of);
        if (!f || !ok(it.at)) break;
        const h = (x1 - x0) * 1e-4;
        const y = f({ x: it.at });
        const m = (f({ x: it.at + h }) - f({ x: it.at - h })) / (2 * h);
        if (!ok(y) || !ok(m)) break;
        const color = colorOf(it.color ?? 'orange');
        const line = (x: number): Vec2 => [ctx.sx(x), ctx.sy(clampY(ctx, y + m * (x - it.at)))];
        add(curvePath([[line(x0), line(x1)]], color.stroke, it.dashed ?? true));
        add(dot(ctx.sx(it.at), ctx.sy(y), color.stroke, false), false);
        if (it.label) labels.push(() => label(ctx, it.label!, ctx.sx(it.at) + 10, ctx.sy(y) + 16, color.stroke, 'start'));
        break;
      }
      case 'segment': {
        if (!isVec2(it.from) || !isVec2(it.to)) break;
        const color = colorOf(it.color);
        const a: Vec2 = [ctx.sx(it.from[0]), ctx.sy(it.from[1])];
        const b: Vec2 = [ctx.sx(it.to[0]), ctx.sy(it.to[1])];
        const g = svgEl('g');
        const opts: Options = { roughness: 0.5, seed: order, stroke: color.stroke, strokeWidth: 2, strokeLineDash: it.dashed ? [6, 5] : undefined };
        g.appendChild(ctx.rc.line(a[0], a[1], b[0], b[1], opts));
        if (it.arrow) g.appendChild(arrowHead(ctx, b, a, opts));
        add(g);
        if (it.label) {
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const nx = -(b[1] - a[1]) / len;
          const ny = (b[0] - a[0]) / len;
          // Put the label on the outside (upper) side of the segment.
          const s = ny > 0 ? -1 : 1;
          labels.push(() => label(ctx, it.label!, (a[0] + b[0]) / 2 + nx * 13 * s, (a[1] + b[1]) / 2 + ny * 13 * s, color.stroke, 'middle'));
        }
        break;
      }
      case 'vline':
      case 'hline': {
        const v = it.kind === 'vline' ? it.x : it.y;
        if (!ok(v)) break;
        const color = colorOf(it.color ?? 'gray');
        const a: Vec2 = it.kind === 'vline' ? [ctx.sx(v), PAD.t] : [PAD.l, ctx.sy(v)];
        const b: Vec2 = it.kind === 'vline' ? [ctx.sx(v), PAD.t + ph] : [PAD.l + pw, ctx.sy(v)];
        add(curvePath([[a, b]], color.stroke, it.dashed ?? true, 1.6));
        if (it.label)
          labels.push(() =>
            it.kind === 'vline'
              ? label(ctx, it.label!, a[0] + 6, PAD.t + 12, color.stroke, 'start')
              : label(ctx, it.label!, b[0] - 4, b[1] - 12, color.stroke, 'end'),
          );
        break;
      }
      case 'polygon': {
        const pts = (it.points ?? []).filter(isVec2).map(([x, y]) => [ctx.sx(x), ctx.sy(y)] as Vec2);
        if (pts.length < 2) break;
        const color = colorOf(it.color);
        const g = svgEl('g');
        g.appendChild(
          ctx.rc.polygon(pts, { roughness: 0.6, seed: order, stroke: color.stroke, strokeWidth: 2, fill: it.fill ? color.fill : undefined, fillStyle: 'solid' }),
        );
        add(g);
        if (it.label) {
          const c = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length], [0, 0]);
          labels.push(() => label(ctx, it.label!, c[0], c[1], color.stroke, 'middle'));
        }
        break;
      }
      case 'circle': {
        if (!isVec2(it.center) || !ok(it.r)) break;
        const color = colorOf(it.color);
        const cx = ctx.sx(it.center[0]);
        const cy = ctx.sy(it.center[1]);
        const g = svgEl('g');
        g.appendChild(
          ctx.rc.ellipse(cx, cy, Math.abs(ctx.sx(it.r) - ctx.sx(0)) * 2, Math.abs(ctx.sy(it.r) - ctx.sy(0)) * 2, {
            roughness: 0.6,
            seed: order,
            stroke: color.stroke,
            strokeWidth: 2,
            fill: it.fill ? color.fill : undefined,
            fillStyle: 'solid',
          }),
        );
        add(g);
        if (it.label) labels.push(() => label(ctx, it.label!, cx, cy, color.stroke, 'middle'));
        break;
      }
      case 'angle': {
        if (!isVec2(it.at) || !isVec2(it.from) || !isVec2(it.to)) break;
        const color = colorOf(it.color ?? 'red');
        const g = angleMark(ctx, it.at, it.from, it.to, !!it.right, color.stroke, it.label, labels);
        add(g, false);
        break;
      }
      default:
        break;
    }
  }

  for (const it of items) {
    if (it.kind === 'point') {
      let at: Vec2 | null = isVec2(it.at) ? it.at : null;
      if (!at && it.on && ok(it.x)) {
        const f = fx(it.on);
        const y = f?.({ x: it.x });
        if (ok(y)) at = [it.x, y];
      }
      if (!at) continue;
      const color = colorOf(it.color ?? 'ink');
      const px = ctx.sx(at[0]);
      const py = ctx.sy(at[1]);
      add(dot(px, py, color.stroke, !!it.hollow), false);
      if (it.label) {
        const right = px < ctx.plotArea.r - 60;
        labels.push(() => label(ctx, it.label!, px + (right ? 9 : -9), py - 13, color.stroke, right ? 'start' : 'end'));
      }
    } else if (it.kind === 'text' && isVec2(it.at) && it.text) {
      labels.push(() => label(ctx, it.text, ctx.sx(it.at[0]), ctx.sy(it.at[1]), colorOf(it.color).stroke, 'middle', false));
    }
  }

  for (const draw of labels) {
    const before = svg.childNodes.length;
    draw();
    for (let k = before; k < svg.childNodes.length; k++) {
      const node = svg.childNodes[k] as SVGElement;
      node.classList.add('rtg-el');
      if (animate) node.style.setProperty('--d', `${order * 160}ms`);
    }
  }

  if (errors.length) {
    console.warn('[realtime-graphics] plot formulas skipped:', errors);
    svg.appendChild(makeText(`Couldn't draw: ${errors[0]}`.slice(0, 70), PAD.l + 6, PAD.t + 8, { size: 11, color: '#c43f38', anchor: 'start' }));
  }
  return svg;
}

function clampY(ctx: Ctx, y: number): number {
  const span = ctx.y1 - ctx.y0;
  return Math.max(ctx.y0 - span * 3, Math.min(ctx.y1 + span * 3, y));
}

/** Sample y = f(x), splitting the curve where it is undefined or jumps (asymptotes). */
function sampleFunction(ctx: Ctx, f: Compiled, a: number, b: number): Vec2[][] {
  const pieces: Vec2[][] = [];
  if (!(b > a)) return pieces;
  const span = ctx.y1 - ctx.y0;
  const n = 700;
  let cur: Vec2[] = [];
  let prev: number | null = null;
  for (let i = 0; i <= n; i++) {
    const x = a + ((b - a) * i) / n;
    const y = f({ x });
    if (!ok(y)) {
      if (cur.length > 1) pieces.push(cur);
      cur = [];
      prev = null;
      continue;
    }
    if (prev !== null && Math.abs(y - prev) > span * 2.5) {
      if (cur.length > 1) pieces.push(cur);
      cur = [];
    }
    cur.push([x, clampY(ctx, y)]);
    prev = y;
  }
  if (cur.length > 1) pieces.push(cur);
  return pieces;
}

function curvePath(pieces: Vec2[][], stroke: string, dashed?: boolean, width = 2.6): SVGGElement {
  const d = pieces
    .filter((p) => p.length > 1)
    .map((p) => 'M' + p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L'))
    .join('');
  const g = svgEl('g');
  if (!d) return g;
  const path = svgEl('path', { d, fill: 'none', stroke, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  if (dashed) {
    path.setAttribute('stroke-dasharray', '7 6');
    path.dataset.static = '1'; // the trace animation would replace the dash pattern
  }
  g.appendChild(path);
  return g;
}

/** A point on the curve near the right of the view, inside the frame, for its label. */
function curveLabelPoint(ctx: Ctx, pieces: Vec2[][]): Vec2 | null {
  const inside = pieces.flat().filter(([, y]) => y > ctx.y0 + (ctx.y1 - ctx.y0) * 0.08 && y < ctx.y1 - (ctx.y1 - ctx.y0) * 0.08);
  if (!inside.length) return null;
  const target = ctx.x0 + (ctx.x1 - ctx.x0) * 0.88;
  const best = inside.reduce((a, b) => (Math.abs(b[0] - target) < Math.abs(a[0] - target) ? b : a));
  return [ctx.sx(best[0]) - 6, ctx.sy(best[1]) - 14];
}

/** Marching squares over the view for f(x, y) = 0. Returns one path of short segments. */
function contour(ctx: Ctx, f: Compiled): { d: string; top: Vec2 | null } {
  const nx = 140;
  const ny = 110;
  const xs = (i: number) => ctx.x0 + ((ctx.x1 - ctx.x0) * i) / nx;
  const ys = (j: number) => ctx.y0 + ((ctx.y1 - ctx.y0) * j) / ny;
  const v: number[][] = [];
  for (let j = 0; j <= ny; j++) {
    const row: number[] = [];
    for (let i = 0; i <= nx; i++) row.push(f({ x: xs(i), y: ys(j) }));
    v.push(row);
  }
  let d = '';
  let top: Vec2 | null = null;
  const lerp = (a: number, b: number) => (Math.abs(a - b) < 1e-12 ? 0.5 : a / (a - b));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = [v[j][i], v[j][i + 1], v[j + 1][i + 1], v[j + 1][i]];
      if (!c.every(ok)) continue;
      // Edge crossings: bottom (0-1), right (1-2), top (2-3), left (3-0) of the cell.
      const pts: Vec2[] = [];
      const edges: [number, number, () => Vec2][] = [
        [0, 1, () => [xs(i + lerp(c[0], c[1])), ys(j)]],
        [1, 2, () => [xs(i + 1), ys(j + lerp(c[1], c[2]))]],
        [2, 3, () => [xs(i + 1 - lerp(c[2], c[3])), ys(j + 1)]],
        [3, 0, () => [xs(i), ys(j + 1 - lerp(c[3], c[0]))]],
      ];
      for (const [a, b, at] of edges) if (c[a] > 0 !== c[b] > 0) pts.push(at());
      // Ignore cells straddling a pole (1/x-like jumps): the values on either side are huge.
      if (pts.length < 2 || Math.max(...c.map(Math.abs)) > 1e6) continue;
      for (let k = 0; k + 1 < pts.length; k += 2) {
        const [p, q] = [pts[k], pts[k + 1]];
        d += `M${ctx.sx(p[0]).toFixed(1)},${ctx.sy(p[1]).toFixed(1)}L${ctx.sx(q[0]).toFixed(1)},${ctx.sy(q[1]).toFixed(1)}`;
        if (!top || ctx.sy(p[1]) < top[1]) top = [ctx.sx(p[0]), ctx.sy(p[1])];
      }
    }
  }
  return { d, top };
}

function dot(x: number, y: number, color: string, hollow: boolean): SVGGElement {
  const g = svgEl('g');
  g.appendChild(svgEl('circle', { cx: x, cy: y, r: 4.6, fill: hollow ? PAPER : color, stroke: color, 'stroke-width': 2 }));
  return g;
}

function arrowHead(ctx: Ctx, tip: Vec2, from: Vec2, opts: Options): SVGGElement {
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const len = 11;
  const left: Vec2 = [tip[0] - len * Math.cos(angle - 0.5), tip[1] - len * Math.sin(angle - 0.5)];
  const right: Vec2 = [tip[0] - len * Math.cos(angle + 0.5), tip[1] - len * Math.sin(angle + 0.5)];
  return ctx.rc.linearPath([left, tip, right], { ...opts, strokeLineDash: undefined });
}

function angleMark(
  ctx: Ctx,
  at: Vec2,
  from: Vec2,
  to: Vec2,
  right: boolean,
  color: string,
  text: string | undefined,
  labels: (() => void)[],
): SVGGElement {
  const v: Vec2 = [ctx.sx(at[0]), ctx.sy(at[1])];
  const a1 = Math.atan2(ctx.sy(from[1]) - v[1], ctx.sx(from[0]) - v[0]);
  const a2 = Math.atan2(ctx.sy(to[1]) - v[1], ctx.sx(to[0]) - v[0]);
  let delta = a2 - a1;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta <= -Math.PI) delta += Math.PI * 2;
  const r = 20;
  const g = svgEl('g');
  const style = { fill: 'none', stroke: color, 'stroke-width': 1.8, 'stroke-linecap': 'round' };
  if (right) {
    const s = 11;
    const u1: Vec2 = [Math.cos(a1) * s, Math.sin(a1) * s];
    const u2: Vec2 = [Math.cos(a2) * s, Math.sin(a2) * s];
    g.appendChild(svgEl('path', { ...style, d: `M${v[0] + u1[0]},${v[1] + u1[1]}L${v[0] + u1[0] + u2[0]},${v[1] + u1[1] + u2[1]}L${v[0] + u2[0]},${v[1] + u2[1]}` }));
  } else {
    const p1: Vec2 = [v[0] + Math.cos(a1) * r, v[1] + Math.sin(a1) * r];
    const p2: Vec2 = [v[0] + Math.cos(a2) * r, v[1] + Math.sin(a2) * r];
    g.appendChild(svgEl('path', { ...style, d: `M${p1[0]},${p1[1]}A${r},${r} 0 0 ${delta > 0 ? 1 : 0} ${p2[0]},${p2[1]}` }));
  }
  if (text) {
    const mid = a1 + delta / 2;
    labels.push(() => label(ctx, text, v[0] + Math.cos(mid) * (r + 22), v[1] + Math.sin(mid) * (r + 22), color, 'middle', false));
  }
  return g;
}

/** A label on a paper backing, nudged down if it would overlap one already placed. */
function label(ctx: Ctx, text: string, x: number, y: number, color: string, anchor: 'start' | 'middle' | 'end', backing = true): void {
  const size = 14;
  const w = textWidth(text.replace(/\$|\\[a-z]+|[{}^_]/gi, ''), size) + 12;
  const h = size * 1.4;
  let left = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
  left = Math.max(2, Math.min(left, ctx.plotArea.r + PAD.r - w - 2));
  let top = Math.max(2, y - h / 2);
  for (let tries = 0; tries < 6; tries++) {
    const hit = ctx.placed.find((p) => left < p.r && left + w > p.l && top < p.b && top + h > p.t);
    if (!hit) break;
    top = hit.b + 2;
  }
  ctx.placed.push({ l: left, t: top, r: left + w, b: top + h });
  const cx = left + w / 2;
  const cy = top + h / 2;
  if (hasMath(text)) {
    ctx.svg.appendChild(svgMathLabel(text, cx, cy, { size, color, backing, maxWidth: 200 }));
    return;
  }
  const g = svgEl('g');
  if (backing) g.appendChild(svgEl('rect', { x: left, y: top, width: w, height: h, rx: 4, fill: PAPER, opacity: 0.9 }));
  g.appendChild(makeText(text, cx, cy, { size, color }));
  ctx.svg.appendChild(g);
}

function drawAxes(ctx: Ctx, spec: PlotSpec): void {
  const { x0, x1, y0, y1, sx, sy, plotArea: A } = ctx;
  const g = svgEl('g', { class: 'rtg-axes' });
  const xStep = niceStep(x1 - x0, (A.r - A.l) / 55);
  const yStep = niceStep(y1 - y0, (A.b - A.t) / 40);
  const ax = y0 <= 0 && y1 >= 0 ? sy(0) : A.b; // where the x axis sits
  const ay = x0 <= 0 && x1 >= 0 ? sx(0) : A.l;

  if (spec.grid !== false) {
    for (let v = Math.ceil(x0 / xStep) * xStep; v <= x1 + 1e-9; v += xStep)
      g.appendChild(svgEl('line', { x1: sx(v), x2: sx(v), y1: A.t, y2: A.b, stroke: 'rgba(43,42,40,0.09)', 'stroke-width': 1 }));
    for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1 + 1e-9; v += yStep)
      g.appendChild(svgEl('line', { x1: A.l, x2: A.r, y1: sy(v), y2: sy(v), stroke: 'rgba(43,42,40,0.09)', 'stroke-width': 1 }));
  }
  const ink = '#2b2a28';
  const axisStyle = { stroke: ink, 'stroke-width': 1.6, 'stroke-linecap': 'round' };
  g.appendChild(svgEl('line', { ...axisStyle, x1: A.l, x2: A.r + 6, y1: ax, y2: ax }));
  g.appendChild(svgEl('line', { ...axisStyle, x1: ay, x2: ay, y1: A.b, y2: A.t - 6 }));
  g.appendChild(svgEl('path', { ...axisStyle, fill: 'none', d: `M${A.r},${ax - 4}L${A.r + 7},${ax}L${A.r},${ax + 4}` }));
  g.appendChild(svgEl('path', { ...axisStyle, fill: 'none', d: `M${ay - 4},${A.t}L${ay},${A.t - 7}L${ay + 4},${A.t}` }));

  for (let v = Math.ceil(x0 / xStep) * xStep; v <= x1 + 1e-9; v += xStep) {
    if (Math.abs(v) < xStep / 2 && ay !== A.l) continue;
    const x = sx(v);
    if (x > A.r - 4) continue;
    g.appendChild(svgEl('line', { ...axisStyle, 'stroke-width': 1.2, x1: x, x2: x, y1: ax - 3, y2: ax + 3 }));
    const ty = Math.min(ax + 12, A.b + 13);
    g.appendChild(makeText(fmt(v, xStep), x, ty, { size: 11, color: MUTED }));
  }
  for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1 + 1e-9; v += yStep) {
    if (Math.abs(v) < yStep / 2 && ax !== A.b) continue;
    const y = sy(v);
    if (y < A.t + 4) continue;
    g.appendChild(svgEl('line', { ...axisStyle, 'stroke-width': 1.2, x1: ay - 3, x2: ay + 3, y1: y, y2: y }));
    const tx = Math.max(ay - 6, A.l - 4);
    g.appendChild(makeText(fmt(v, yStep), tx, y, { size: 11, color: MUTED, anchor: 'end' }));
  }
  if (ax !== A.b && ay !== A.l) g.appendChild(makeText('0', ay - 6, ax + 11, { size: 11, color: MUTED, anchor: 'end' }));
  ctx.svg.appendChild(g);
  if (spec.xLabel) label(ctx, spec.xLabel, A.r + 4, ax - 14, ink, 'end', true);
  if (spec.yLabel) label(ctx, spec.yLabel, ay + 8, A.t + 6, ink, 'start', true);
}
