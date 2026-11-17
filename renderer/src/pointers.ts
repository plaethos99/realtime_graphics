import rough from 'roughjs';
import type { Options } from 'roughjs/bin/core';
import { ACCENT, FONT_BODY } from './theme';
import { svgEl, textWidth } from './svg';
import type { Pointer } from './types';

const OPTS: Options = { stroke: ACCENT, strokeWidth: 3, roughness: 1.4, bowing: 1.2 };

/** Annotate things on the user's screen. The SVG covers the whole host; units are host pixels. */
export function drawPointers(svg: SVGSVGElement, pointers: Pointer[], width: number, height: number, animate: boolean): void {
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const rc = rough.svg(svg);

  pointers.forEach((p, i) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    const cx = p.x * width;
    const cy = p.y * height;
    const w = Math.max(28, (p.w ?? 0) * width || 72);
    const h = Math.max(22, (p.h ?? 0) * height || 44);
    const opts = { ...OPTS, seed: 100 + i };
    const g = svgEl('g', { class: 'rtg-el' });
    let labelAt = { x: cx + w / 2 + 14, y: cy - h / 2 - 16 };

    switch (p.style ?? 'circle') {
      case 'box':
        g.appendChild(rc.rectangle(cx - w / 2 - 8, cy - h / 2 - 8, w + 16, h + 16, opts));
        break;
      case 'underline':
        g.appendChild(rc.line(cx - w / 2, cy + h / 2 + 6, cx + w / 2, cy + h / 2 + 6, { ...opts, strokeWidth: 3.5 }));
        labelAt = { x: cx - w / 2, y: cy + h / 2 + 26 };
        break;
      case 'arrow': {
        const dir = cx > width * 0.7 ? -1 : 1;
        const start = { x: cx + dir * (w / 2 + 90), y: cy - h / 2 - 60 };
        const tip = { x: cx + dir * (w / 2 + 6), y: cy - 4 };
        const mid = { x: (start.x + tip.x) / 2 + dir * 10, y: (start.y + tip.y) / 2 - 18 };
        g.appendChild(rc.curve([[start.x, start.y], [mid.x, mid.y], [tip.x, tip.y]], opts));
        const a = Math.atan2(tip.y - mid.y, tip.x - mid.x);
        g.appendChild(
          rc.linearPath(
            [
              [tip.x - 14 * Math.cos(a - 0.5), tip.y - 14 * Math.sin(a - 0.5)],
              [tip.x, tip.y],
              [tip.x - 14 * Math.cos(a + 0.5), tip.y - 14 * Math.sin(a + 0.5)],
            ],
            opts,
          ),
        );
        labelAt = { x: start.x + (dir < 0 ? -8 : 8), y: start.y - 14 };
        break;
      }
      default:
        g.appendChild(rc.ellipse(cx, cy, w + 26, h + 22, opts));
    }

    if (p.label) {
      const size = 16;
      const tw = textWidth(p.label, size) + 18;
      // Keep the tag on-screen.
      const x = Math.min(Math.max(8, labelAt.x), width - tw - 8);
      const y = Math.min(Math.max(8, labelAt.y - 13), height - 34);
      g.appendChild(svgEl('rect', { x, y, width: tw, height: 26, rx: 13, fill: ACCENT }));
      const text = svgEl('text', {
        x: x + tw / 2,
        y: y + 13,
        fill: '#fff',
        'font-size': size,
        'font-family': FONT_BODY,
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
      });
      text.textContent = p.label;
      g.appendChild(text);
    }

    if (animate) {
      g.style.setProperty('--d', `${150 + i * 120}ms`);
      for (const path of g.querySelectorAll('path')) {
        path.setAttribute('pathLength', '1');
        path.classList.add('rtg-stroke');
      }
    }
    svg.appendChild(g);
  });
}
