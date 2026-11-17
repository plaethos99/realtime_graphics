import { FONT_BODY } from './theme';

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Rough width of a string in the handwriting font; good enough for wrapping and label backgrounds. */
export function textWidth(text: string, size: number): number {
  return text.length * size * 0.48;
}

export function wrap(text: string, maxWidth: number, size: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Multi-line text centred vertically on y. */
export function makeText(
  text: string,
  x: number,
  y: number,
  opts: { size?: number; color?: string; anchor?: 'start' | 'middle' | 'end'; maxWidth?: number; weight?: number } = {},
): SVGTextElement {
  const size = opts.size ?? 15;
  const lines = opts.maxWidth ? wrap(text, opts.maxWidth, size) : text.split('\n');
  const lineHeight = size * 1.15;
  const el = svgEl('text', {
    x,
    y,
    'font-size': size,
    'font-family': FONT_BODY,
    fill: opts.color ?? '#2b2a28',
    'text-anchor': opts.anchor ?? 'middle',
    'dominant-baseline': 'central',
  });
  if (opts.weight) el.setAttribute('font-weight', String(opts.weight));
  lines.forEach((line, i) => {
    const tspan = svgEl('tspan', { x, dy: i === 0 ? -((lines.length - 1) * lineHeight) / 2 : lineHeight });
    tspan.textContent = line;
    el.appendChild(tspan);
  });
  return el;
}

/** A text label on a paper-coloured backing so it stays legible over lines. */
export function makeTag(text: string, x: number, y: number, size: number, color: string, paper: string): SVGGElement {
  const g = svgEl('g');
  const w = textWidth(text, size) + 10;
  const h = size * 1.3;
  g.appendChild(svgEl('rect', { x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 4, fill: paper, opacity: 0.92 }));
  g.appendChild(makeText(text, x, y, { size, color }));
  return g;
}
