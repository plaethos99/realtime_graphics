import rough from 'roughjs';
import type { Options } from 'roughjs/bin/core';
import type { RoughSVG } from 'roughjs/bin/svg';
import { colorOf, PAPER } from './theme';
import { hasMath, svgMathLabel } from './math';
import { makeTag, makeText, svgEl } from './svg';
import type { ArrowEl, BoxEl, CircleEl, Element, LineEl, TextEl, Vec2 } from './types';

interface Geo {
  kind: 'box' | 'circle';
  cx: number;
  cy: number;
  w: number;
  h: number;
}

type Pt = { x: number; y: number };

const BASE: Options = { roughness: 1.05, bowing: 0.8, strokeWidth: 1.7, fillStyle: 'solid' };
// Paint order: connectors under shapes, arrows over shapes, free text on top.
const LAYER: Record<Element['kind'], number> = { line: 0, box: 1, circle: 1, arrow: 2, text: 3 };

/**
 * Draw diagram elements into an SVG whose viewBox is the panel's coordinate space.
 * With animate, each element is revealed in the order the model listed it.
 */
export function drawElements(svg: SVGSVGElement, elements: Element[], animate: boolean): void {
  const rc = rough.svg(svg);
  const geo = new Map<string, Geo>();
  for (const el of elements) {
    if (el.kind === 'box' && el.id) geo.set(el.id, { kind: 'box', cx: el.x + el.w / 2, cy: el.y + el.h / 2, w: el.w, h: el.h });
    if (el.kind === 'circle' && el.id) geo.set(el.id, { kind: 'circle', cx: el.x, cy: el.y, w: el.r * 2, h: el.r * 2 });
  }

  const ordered = elements
    .map((el, index) => ({ el, index }))
    .filter(({ el }) => el && el.kind in LAYER)
    .sort((a, b) => LAYER[a.el.kind] - LAYER[b.el.kind] || a.index - b.index);

  for (const { el, index } of ordered) {
    const seed = index + 1;
    let g: SVGGElement | null = null;
    try {
      if (el.kind === 'box') g = drawBox(rc, el, seed);
      else if (el.kind === 'circle') g = drawCircle(rc, el, seed);
      else if (el.kind === 'text') g = drawText(el);
      else if (el.kind === 'arrow') g = drawArrow(rc, el, geo, seed);
      else if (el.kind === 'line') g = drawLine(rc, el, seed);
    } catch (err) {
      console.warn('[realtime-graphics] skipped element', el, err);
    }
    if (!g) continue;
    g.classList.add('rtg-el');
    if (animate) {
      g.style.setProperty('--d', `${index * 80}ms`);
      markStrokes(g);
    }
    svg.appendChild(g);
  }
}

function markStrokes(g: SVGGElement): void {
  for (const path of g.querySelectorAll('path')) {
    const stroke = path.getAttribute('stroke');
    if (stroke && stroke !== 'none') {
      path.setAttribute('pathLength', '1');
      path.classList.add('rtg-stroke');
    }
  }
}

function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  return (
    `M${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} ` +
    `Q${x + w},${y + h} ${x + w - r},${y + h} H${x + r} Q${x},${y + h} ${x},${y + h - r} V${y + r} Q${x},${y} ${x + r},${y} Z`
  );
}

function labelSize(text: string, maxW: number, maxH: number): number {
  // Shrink long labels until they fit the shape.
  for (let size = 16; size > 10; size -= 1) {
    const perLine = Math.max(1, Math.floor(maxW / (size * 0.48)));
    const lines = Math.ceil(text.length / perLine);
    if (lines * size * 1.15 <= maxH) return size;
  }
  return 10;
}

function drawBox(rc: RoughSVG, el: BoxEl, seed: number): SVGGElement {
  const c = colorOf(el.color);
  const g = svgEl('g');
  g.appendChild(rc.path(roundedRect(el.x, el.y, el.w, el.h, 8), { ...BASE, seed, stroke: c.stroke, fill: c.fill }));
  if (el.label && hasMath(el.label)) {
    g.appendChild(svgMathLabel(el.label, el.x + el.w / 2, el.y + el.h / 2, { size: 15, color: c.stroke, maxWidth: el.w - 8 }));
  } else if (el.label) {
    const size = labelSize(el.label, el.w - 10, el.h - 4);
    g.appendChild(makeText(el.label, el.x + el.w / 2, el.y + el.h / 2, { size, color: c.stroke, maxWidth: el.w - 10 }));
  }
  return g;
}

function drawCircle(rc: RoughSVG, el: CircleEl, seed: number): SVGGElement {
  const c = colorOf(el.color);
  const g = svgEl('g');
  g.appendChild(rc.circle(el.x, el.y, el.r * 2, { ...BASE, seed, stroke: c.stroke, fill: c.fill }));
  if (el.label) {
    const inner = el.r * 1.5;
    const size = labelSize(el.label, inner, inner);
    g.appendChild(makeText(el.label, el.x, el.y, { size, color: c.stroke, maxWidth: inner }));
  }
  return g;
}

function drawText(el: TextEl): SVGGElement {
  const g = svgEl('g');
  const opts = { size: el.size ?? 15, color: colorOf(el.color).stroke, anchor: el.align ?? 'middle' } as const;
  g.appendChild(hasMath(el.text) ? svgMathLabel(el.text, el.x, el.y, { ...opts, maxWidth: 360 }) : makeText(el.text, el.x, el.y, opts));
  return g;
}

function drawLine(rc: RoughSVG, el: LineEl, seed: number): SVGGElement | null {
  const pts = (el.points ?? []).filter(isVec2);
  if (pts.length < 2) return null;
  const c = colorOf(el.color);
  const opts: Options = { ...BASE, seed, stroke: c.stroke, strokeLineDash: el.dashed ? [6, 5] : undefined };
  const g = svgEl('g');
  g.appendChild(el.closed || el.fill ? rc.polygon(pts, { ...opts, fill: el.fill ? c.fill : undefined }) : rc.linearPath(pts, opts));
  return g;
}

function isVec2(v: unknown): v is Vec2 {
  return Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);
}

function resolveEnd(ref: string | Vec2, geo: Map<string, Geo>): { pt: Pt; shape?: Geo } | null {
  if (typeof ref === 'string') {
    const shape = geo.get(ref);
    return shape ? { pt: { x: shape.cx, y: shape.cy }, shape } : null;
  }
  return isVec2(ref) ? { pt: { x: ref[0], y: ref[1] } } : null;
}

/** Where a ray from the shape's centre toward `toward` leaves the shape, plus a small gap. */
function edgePoint(shape: Geo, toward: Pt, gap = 5): Pt {
  const dx = toward.x - shape.cx;
  const dy = toward.y - shape.cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  if (shape.kind === 'circle') {
    const r = shape.w / 2 + gap;
    return { x: shape.cx + ux * r, y: shape.cy + uy * r };
  }
  const sx = Math.abs(ux) > 1e-6 ? shape.w / 2 / Math.abs(ux) : Infinity;
  const sy = Math.abs(uy) > 1e-6 ? shape.h / 2 / Math.abs(uy) : Infinity;
  const t = Math.min(sx, sy) + gap;
  return { x: shape.cx + ux * t, y: shape.cy + uy * t };
}

function arrowHead(rc: RoughSVG, tip: Pt, from: Pt, opts: Options): SVGGElement {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const len = 11;
  const spread = 0.5;
  const left: Vec2 = [tip.x - len * Math.cos(angle - spread), tip.y - len * Math.sin(angle - spread)];
  const right: Vec2 = [tip.x - len * Math.cos(angle + spread), tip.y - len * Math.sin(angle + spread)];
  return rc.linearPath([left, [tip.x, tip.y], right], { ...opts, strokeLineDash: undefined });
}

function drawArrow(rc: RoughSVG, el: ArrowEl, geo: Map<string, Geo>, seed: number): SVGGElement | null {
  const a = resolveEnd(el.from, geo);
  const b = resolveEnd(el.to, geo);
  if (!a || !b) return null;
  const c = colorOf(el.color);
  const opts: Options = { ...BASE, seed, stroke: c.stroke, strokeLineDash: el.dashed ? [6, 5] : undefined };

  const bend = el.bend ?? 0;
  const dx = b.pt.x - a.pt.x;
  const dy = b.pt.y - a.pt.y;
  const len = Math.hypot(dx, dy) || 1;
  // `bend` moves the arrow's midpoint sideways, perpendicular to its direction.
  const mid: Pt = { x: (a.pt.x + b.pt.x) / 2 + (-dy / len) * bend, y: (a.pt.y + b.pt.y) / 2 + (dx / len) * bend };

  const p0 = a.shape ? edgePoint(a.shape, bend ? mid : b.pt) : a.pt;
  const p1 = b.shape ? edgePoint(b.shape, bend ? mid : a.pt) : b.pt;

  const g = svgEl('g');
  g.appendChild(
    bend
      ? rc.curve([[p0.x, p0.y], [mid.x, mid.y], [p1.x, p1.y]], opts)
      : rc.line(p0.x, p0.y, p1.x, p1.y, opts),
  );
  g.appendChild(arrowHead(rc, p1, bend ? mid : p0, opts));
  if (el.both) g.appendChild(arrowHead(rc, p0, bend ? mid : p1, opts));
  if (el.label) {
    const at = bend ? mid : { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    // Sit horizontal-arrow labels just above the line; others centred on it.
    const lift = !bend && Math.abs(dy) < Math.abs(dx) * 0.3 ? -12 : 0;
    g.appendChild(makeTag(el.label, at.x, at.y + lift, 13, c.stroke, PAPER));
  }
  return g;
}
