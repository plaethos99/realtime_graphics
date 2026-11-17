import { drawElements } from './diagram';
import { richEl } from './math';
import { drawPlot } from './plot';
import { createPlot3DView } from './plot3d';
import { drawPointers } from './pointers';
import { SVG_NS } from './svg';
import { createThreeView, type ThreeView } from './three-view';
import type { DiagramPanel, Element, Plot3DPanel, PlotPanel, Scene, StepsPanel, ThreePanel } from './types';

export interface OverlayOptions {
  /** Draw-in animations (default true; always off with prefers-reduced-motion). */
  animate?: boolean;
  /** Called when the user closes the card. */
  onClose?: () => void;
  /** "beside" (default) puts the card next to what it explains; "center" centres it (reading views). */
  layout?: 'beside' | 'center';
}

const MARGIN = 16;
const GAP = 28;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function diagramSvg(elements: Element[], width: number, height: number, animate: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', `rtg-diagram${animate ? ' rtg-anim' : ''}`);
  svg.setAttribute('role', 'img');
  drawElements(svg, elements ?? [], animate);
  return svg;
}

/**
 * Transparent layer that sits over the user's screen (or a screenshot of it) and shows one scene
 * at a time: pointers drawn on the screen itself, plus a card holding the diagram, steps or 3D view.
 * The layer ignores the mouse except on the card, so the app underneath stays usable.
 */
export class Overlay {
  readonly root: HTMLDivElement;
  private readonly pointerSvg: SVGSVGElement;
  private card: HTMLDivElement | null = null;
  private disposePanel: (() => void) | null = null;
  private scene: Scene | null = null;
  private moved = false;
  private readonly observer: ResizeObserver;
  private readonly animate: boolean;

  constructor(private readonly host: HTMLElement, private readonly options: OverlayOptions = {}) {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.animate = (options.animate ?? true) && !reduce;
    this.root = el('div', 'rtg-root');
    this.pointerSvg = document.createElementNS(SVG_NS, 'svg');
    this.pointerSvg.setAttribute('class', `rtg-pointers${this.animate ? ' rtg-anim' : ''}`);
    this.root.appendChild(this.pointerSvg);
    host.appendChild(this.root);
    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(host);
  }

  get current(): Scene | null {
    return this.scene;
  }

  render(scene: Scene | null): void {
    this.clear();
    if (!scene) return;
    this.scene = scene;
    this.moved = false;
    this.drawPointers();
    if (scene.panel || scene.title) this.buildCard(scene);
    requestAnimationFrame(() => this.place());
  }

  clear(): void {
    this.disposePanel?.();
    this.disposePanel = null;
    this.card?.remove();
    this.card = null;
    this.pointerSvg.replaceChildren();
    this.scene = null;
  }

  destroy(): void {
    this.clear();
    this.observer.disconnect();
    this.root.remove();
  }

  /** Screen areas that should receive mouse input (desktop shells use this to toggle click-through). */
  interactiveRects(): DOMRect[] {
    return this.card ? [this.card.getBoundingClientRect()] : [];
  }

  private layout(): void {
    if (!this.scene) return;
    this.drawPointers();
    if (!this.moved) this.place();
  }

  private drawPointers(): void {
    const { clientWidth: w, clientHeight: h } = this.host;
    drawPointers(this.pointerSvg, this.scene?.pointers ?? [], w, h, this.animate);
  }

  private buildCard(scene: Scene): void {
    const panel = scene.panel ?? null;
    const card = el('div', `rtg-card rtg-card-${panel?.type ?? 'note'}${this.animate ? ' rtg-card-in' : ''}`);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', scene.title ?? 'Explanation');
    card.tabIndex = -1;

    const head = el('div', 'rtg-head');
    head.appendChild(richEl('div', 'rtg-title', scene.title ?? ''));
    const close = el('button', 'rtg-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => {
      this.clear();
      this.options.onClose?.();
    });
    head.appendChild(close);
    card.appendChild(head);
    if (scene.subtitle) card.appendChild(richEl('div', 'rtg-sub', scene.subtitle));

    const body = el('div', 'rtg-body');
    card.appendChild(body);
    this.root.appendChild(card);
    this.card = card;
    this.enableDrag(card, head);

    if (panel?.type === 'diagram') this.renderDiagram(body, panel);
    else if (panel?.type === 'steps') this.renderSteps(card, body, panel);
    else if (panel?.type === '3d') this.render3D(body, panel);
    else if (panel?.type === 'plot') this.renderPlot(body, panel);
    else if (panel?.type === 'plot3d') this.render3D(body, panel);
  }

  private renderPlot(body: HTMLElement, panel: PlotPanel): void {
    body.appendChild(drawPlot(panel, this.animate));
  }

  private renderDiagram(body: HTMLElement, panel: DiagramPanel): void {
    body.appendChild(diagramSvg(panel.elements, panel.width ?? 400, panel.height ?? 280, this.animate));
  }

  private renderSteps(card: HTMLElement, body: HTMLElement, panel: StepsPanel): void {
    const steps = panel.steps?.length ? panel.steps : [{ title: 'No steps' }];
    let index = 0;
    let disposeStep: (() => void) | null = null; // a step's 3D view, replaced when the step changes
    this.disposePanel = () => disposeStep?.();
    const view = el('div', 'rtg-step');
    const nav = el('div', 'rtg-nav');
    const prev = el('button', 'rtg-btn', '‹ Back');
    const next = el('button', 'rtg-btn rtg-btn-primary', 'Next ›');
    const dots = el('div', 'rtg-dots');
    prev.type = next.type = 'button';
    nav.append(prev, dots, next);
    body.append(view, nav);

    const show = (i: number) => {
      index = Math.max(0, Math.min(steps.length - 1, i));
      const step = steps[index];
      disposeStep?.();
      disposeStep = null;
      view.replaceChildren();
      view.appendChild(el('div', 'rtg-step-count', `Step ${index + 1} of ${steps.length}`));
      view.appendChild(richEl('div', 'rtg-step-title', step.title));
      if (step.text) view.appendChild(richEl('div', 'rtg-step-text', step.text));
      if (step.elements?.length) view.appendChild(diagramSvg(step.elements, step.width ?? 400, step.height ?? 220, this.animate));
      if (step.plot?.items?.length) view.appendChild(drawPlot({ height: 240, ...step.plot }, this.animate));
      if (step.plot3d?.items?.length) {
        card.classList.add('rtg-card-wide');
        const stage = el('div', 'rtg-3d rtg-3d-step');
        view.append(stage, el('div', 'rtg-hint', 'Drag to rotate · scroll to zoom'));
        const view3d = createPlot3DView(stage, step.plot3d, this.animate);
        disposeStep = () => view3d.dispose();
      }
      dots.replaceChildren(
        ...steps.map((_, j) => {
          const dot = el('button', `rtg-dot${j === index ? ' rtg-dot-on' : ''}`);
          dot.type = 'button';
          dot.setAttribute('aria-label', `Step ${j + 1}`);
          dot.addEventListener('click', () => show(j));
          return dot;
        }),
      );
      prev.disabled = index === 0;
      next.textContent = index === steps.length - 1 ? 'Done' : 'Next ›';
      // Steps differ in height; keep the card fitted and on-screen unless the user dragged it.
      if (!this.moved) requestAnimationFrame(() => this.place());
    };
    prev.addEventListener('click', () => show(index - 1));
    next.addEventListener('click', () => {
      if (index < steps.length - 1) return show(index + 1);
      this.clear();
      this.options.onClose?.();
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') show(index + 1);
      if (e.key === 'ArrowLeft') show(index - 1);
    });
    show(0);
  }

  private render3D(body: HTMLElement, panel: ThreePanel | Plot3DPanel): void {
    const stage = el('div', 'rtg-3d');
    body.appendChild(stage);
    body.appendChild(el('div', 'rtg-hint', 'Drag to rotate · scroll to zoom'));
    const view: ThreeView =
      panel.type === 'plot3d' ? createPlot3DView(stage, panel, this.animate) : createThreeView(stage, panel, this.animate);
    this.disposePanel = () => view.dispose();
  }

  /** Put the card beside the point it explains, on whichever side has room, fully on-screen. */
  private place(): void {
    const card = this.card;
    if (!card) return;
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    // Shrink the whole card on small screens (phones, small windows) rather than scrolling it.
    card.style.scale = '';
    const fit = Math.min(1, (W - MARGIN * 2) / card.offsetWidth, (H - MARGIN * 2) / card.offsetHeight);
    if (fit < 1) card.style.scale = String(Math.max(0.4, fit));
    const cw = card.offsetWidth * fit;
    const ch = card.offsetHeight * fit;
    if (this.options.layout === 'center') {
      card.style.left = `${Math.round(Math.max(MARGIN, (W - cw) / 2))}px`;
      card.style.top = `${Math.round(Math.max(MARGIN, (H - ch) / 2))}px`;
      return;
    }

    // Things the card must not cover: each pointer plus room for its label.
    const avoid = (this.scene?.pointers ?? [])
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => {
        const hw = Math.max(36, ((p.w ?? 0) * W) / 2) + 30;
        const hh = Math.max(22, ((p.h ?? 0) * H) / 2) + 30;
        return { l: p.x * W - hw, t: p.y * H - hh - 20, r: p.x * W + hw + 120, b: p.y * H + hh };
      });

    const placement = this.scene?.placement;
    let ax: number;
    let ay: number;
    if (placement && Number.isFinite(placement.x) && Number.isFinite(placement.y)) {
      ax = placement.x * W;
      ay = placement.y * H;
    } else if (avoid.length) {
      ax = avoid.reduce((s, a) => s + (a.l + a.r) / 2, 0) / avoid.length;
      ay = avoid.reduce((s, a) => s + (a.t + a.b) / 2, 0) / avoid.length;
    } else {
      ax = W;
      ay = 0;
    }

    const clampX = (x: number) => Math.max(MARGIN, Math.min(x, W - cw - MARGIN));
    const clampY = (y: number) => Math.max(MARGIN, Math.min(y, H - ch - MARGIN));
    const candidates = [
      [ax + GAP, ay - ch / 2], // right of the target
      [ax - GAP - cw, ay - ch / 2], // left
      [ax - cw / 2, ay + GAP], // below
      [ax - cw / 2, ay - GAP - ch], // above
      [W - cw - MARGIN, MARGIN], // corners as a last resort
      [MARGIN, MARGIN],
      [W - cw - MARGIN, H - ch - MARGIN],
      [MARGIN, H - ch - MARGIN],
    ].map(([x, y]) => ({ left: clampX(x), top: clampY(y) }));

    const overlap = (left: number, top: number) =>
      avoid.reduce((sum, a) => {
        const w = Math.min(left + cw, a.r) - Math.max(left, a.l);
        const h = Math.min(top + ch, a.b) - Math.max(top, a.t);
        return sum + (w > 0 && h > 0 ? w * h : 0);
      }, 0);
    // Covering a pointer costs far more than sitting a little further from the target.
    const score = (c: { left: number; top: number }) =>
      overlap(c.left, c.top) * 4 + Math.hypot(c.left + cw / 2 - ax, c.top + ch / 2 - ay);
    const best = candidates.reduce((a, b) => (score(b) < score(a) ? b : a));

    card.style.left = `${Math.round(best.left)}px`;
    card.style.top = `${Math.round(best.top)}px`;
  }

  private enableDrag(card: HTMLElement, handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const startX = e.clientX - card.offsetLeft;
      const startY = e.clientY - card.offsetTop;
      handle.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        this.moved = true;
        card.style.left = `${ev.clientX - startX}px`;
        card.style.top = `${ev.clientY - startY}px`;
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }
}

export function createOverlay(host: HTMLElement, options?: OverlayOptions): Overlay {
  return new Overlay(host, options);
}
