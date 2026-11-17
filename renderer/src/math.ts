// Text that may contain LaTeX: "$x^2$" inline, "$$\int_0^1 x\,dx$$" on its own line (also \( \) and \[ \]).
import katex from 'katex';
import { SVG_NS } from './svg';

type Piece = { math: false; text: string } | { math: true; tex: string; display: boolean };

const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^\s$](?:[^$]*?[^\s$])?)\$(?!\d)/g;
const MATH_TEST = new RegExp(MATH_RE.source); // non-global: test() keeps no state between calls

/**
 * JSON turns an unescaped "\frac" into a form feed + "rac", "\theta" into a tab + "heta", and so on.
 * Put those backslashes back inside math.
 */
function repairTex(tex: string): string {
  return tex
    .replace(/\f/g, '\\f')
    .replace(/\t/g, '\\t')
    .replace(/\x08/g, '\\b')
    .replace(/\r/g, '\\r')
    .replace(/\v/g, '\\v')
    .replace(/\n(?=[a-zA-Z])/g, '\\n');
}

function split(text: string): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(MATH_RE)) {
    if (m.index! > last) pieces.push({ math: false, text: text.slice(last, m.index) });
    const display = m[1] !== undefined || m[2] !== undefined;
    pieces.push({ math: true, tex: repairTex(m[1] ?? m[2] ?? m[3] ?? m[4]), display });
    last = m.index! + m[0].length;
  }
  if (last < text.length) pieces.push({ math: false, text: text.slice(last) });
  return pieces;
}

export function hasMath(text: string | undefined): boolean {
  return !!text && MATH_TEST.test(text);
}

/** Fill `el` with `text`, typesetting any math in it. Plain text stays plain text (never parsed as HTML). */
export function setRichText(el: HTMLElement, text: string): HTMLElement {
  el.replaceChildren();
  for (const piece of split(text ?? '')) {
    if (!piece.math) {
      el.append(piece.text);
      continue;
    }
    const span = document.createElement('span');
    span.className = piece.display ? 'rtg-math rtg-math-display' : 'rtg-math';
    try {
      katex.render(piece.tex, span, { displayMode: piece.display, throwOnError: false, strict: 'ignore', output: 'html' });
    } catch {
      span.textContent = piece.tex;
    }
    el.append(span);
  }
  return el;
}

export function richEl<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) setRichText(node, text);
  return node;
}

/**
 * A label with math, for use inside SVG: HTML in a foreignObject, centred on (x, y) in viewBox units.
 * `anchor` picks which side of the label sits on x, like SVG text-anchor.
 */
export function svgMathLabel(
  text: string,
  x: number,
  y: number,
  opts: { size?: number; color?: string; maxWidth?: number; anchor?: 'start' | 'middle' | 'end'; backing?: boolean } = {},
): SVGForeignObjectElement {
  const maxWidth = opts.maxWidth ?? 220;
  const fo = document.createElementNS(SVG_NS, 'foreignObject');
  const box = maxWidth + 40;
  const left = opts.anchor === 'start' ? x : opts.anchor === 'end' ? x - box : x - box / 2;
  fo.setAttribute('x', String(left));
  fo.setAttribute('y', String(y - 60));
  fo.setAttribute('width', String(box));
  fo.setAttribute('height', '120');
  fo.setAttribute('class', 'rtg-fo');
  const wrap = document.createElement('div');
  wrap.className = `rtg-fo-wrap rtg-fo-${opts.anchor ?? 'middle'}`;
  const label = document.createElement('div');
  label.className = `rtg-fo-label${opts.backing ? ' rtg-fo-backed' : ''}`;
  label.style.fontSize = `${opts.size ?? 15}px`;
  label.style.maxWidth = `${maxWidth}px`;
  if (opts.color) label.style.color = opts.color;
  setRichText(label, text);
  wrap.appendChild(label);
  fo.appendChild(wrap);
  return fo;
}
