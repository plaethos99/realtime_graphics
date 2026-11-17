import type { ColorName } from './types';

export interface Swatch {
  stroke: string; // outlines and text
  fill: string; // pale fill behind labels
  solid: string; // 3D surfaces and arrows
}

const NAMED: Record<ColorName, Swatch> = {
  ink: { stroke: '#2b2a28', fill: '#efebe2', solid: '#4a4844' },
  blue: { stroke: '#2563c9', fill: '#dce7fa', solid: '#4f86df' },
  red: { stroke: '#c43f38', fill: '#fadcd9', solid: '#df625a' },
  orange: { stroke: '#cc7220', fill: '#fce6cf', solid: '#ee9640' },
  green: { stroke: '#2e8549', fill: '#daf0e0', solid: '#4cac69' },
  purple: { stroke: '#7650c2', fill: '#e9e1f9', solid: '#946fd9' },
  yellow: { stroke: '#a7800f', fill: '#faefc6', solid: '#e6be3e' },
  teal: { stroke: '#1d8686', fill: '#d4efee', solid: '#38abab' },
  pink: { stroke: '#c03f7b', fill: '#f9dae8', solid: '#de669d' },
  gray: { stroke: '#67645e', fill: '#ebe8e2', solid: '#b3afa7' },
};

export const PAPER = '#fbf8f1';
export const ACCENT = '#e5484d';
export const FONT_BODY = '"Patrick Hand", "Comic Sans MS", "Segoe Print", cursive';
export const FONT_TITLE = '"Caveat", "Patrick Hand", "Segoe Print", cursive';

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function withAlpha(hex: string, alpha: number): string {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Resolve a model-supplied colour (palette name or hex) to a swatch; anything else falls back. */
export function colorOf(color: string | undefined, fallback: ColorName = 'ink'): Swatch {
  if (color && color in NAMED) return NAMED[color as ColorName];
  if (color && HEX.test(color)) return { stroke: color, fill: withAlpha(color, 0.18), solid: color };
  return NAMED[fallback];
}
