// Scene format produced by the proxy. Keep in sync with proxy/app/scene.py.
// Screen positions (placement, pointers) are 0..1 fractions of the overlay host.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export type ColorName = 'ink' | 'blue' | 'red' | 'orange' | 'green' | 'purple' | 'yellow' | 'teal' | 'pink' | 'gray';
export type Color = ColorName | string;

export interface BoxEl {
  kind: 'box';
  id?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  color?: Color;
}

export interface CircleEl {
  kind: 'circle';
  id?: string;
  x: number;
  y: number;
  r: number;
  label?: string;
  color?: Color;
}

export interface TextEl {
  kind: 'text';
  x: number;
  y: number;
  text: string;
  size?: number;
  color?: Color;
  align?: 'start' | 'middle' | 'end';
}

export interface ArrowEl {
  kind: 'arrow';
  from: string | Vec2;
  to: string | Vec2;
  label?: string;
  color?: Color;
  dashed?: boolean;
  bend?: number;
  both?: boolean;
}

export interface LineEl {
  kind: 'line';
  points: Vec2[];
  color?: Color;
  dashed?: boolean;
  closed?: boolean;
  fill?: boolean;
}

export type Element = BoxEl | CircleEl | TextEl | ArrowEl | LineEl;

export interface DiagramPanel {
  type: 'diagram';
  width?: number;
  height?: number;
  elements: Element[];
}

export interface Step {
  title: string;
  text?: string;
  width?: number;
  height?: number;
  elements?: Element[];
  /** A graph for this step (a plot panel without "type"). */
  plot?: PlotSpec;
  /** A 3D graph for this step (a plot3d panel without "type"). */
  plot3d?: Plot3DSpec;
}

export interface StepsPanel {
  type: 'steps';
  steps: Step[];
}

export type Shape3D = 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'capsule' | 'plane' | 'lathe' | 'extrude' | 'tube' | 'model';

export interface Obj3D {
  id?: string;
  parent?: string;
  shape: Shape3D;
  size?: number[];
  /** Name of a ready-made object when shape is 'model' (see models.ts). */
  model?: string;
  /** Profile for lathe [r, y], outline for extrude [x, y], path for tube [x, y, z]. */
  points?: number[][];
  /** plastic (default), matte, metal, glass, rubber, wood or glow. */
  material?: string;
  position?: Vec3;
  rotation?: Vec3; // degrees
  scale?: Vec3;
  color?: Color;
  opacity?: number;
  spin?: { axis?: 'x' | 'y' | 'z'; speed?: number };
}

export interface Label3D {
  text: string;
  at: string | Vec3;
  offset?: Vec3;
}

export interface Arrow3D {
  from: Vec3;
  to: Vec3;
  color?: Color;
  label?: string;
}

export interface ThreePanel {
  type: '3d';
  objects: Obj3D[];
  labels?: Label3D[];
  arrows?: Arrow3D[];
  camera?: { position: Vec3; target?: Vec3 };
  autoRotate?: boolean;
}

// ---- math plots. Math coordinates: y (2D) or z (3D) grows UP. Formulas are strings, see expr.ts. ----

export type Range = [number, number];

interface PlotStyle {
  color?: Color;
  label?: string;
  dashed?: boolean;
}

export type PlotItem =
  | ({ kind: 'function'; id?: string; fn: string; domain?: Range } & PlotStyle)
  | ({ kind: 'parametric'; x: string; y: string; t?: Range } & PlotStyle)
  | ({ kind: 'implicit'; eq: string } & PlotStyle)
  | ({ kind: 'point'; at?: Vec2; on?: string; x?: number; hollow?: boolean } & PlotStyle)
  | ({ kind: 'tangent'; of: string; at: number } & PlotStyle)
  | ({ kind: 'area'; fn: string; fn2?: string; from: number; to: number } & PlotStyle)
  | ({ kind: 'segment'; from: Vec2; to: Vec2; arrow?: boolean } & PlotStyle)
  | ({ kind: 'vline'; x: number } & PlotStyle)
  | ({ kind: 'hline'; y: number } & PlotStyle)
  | ({ kind: 'polygon'; points: Vec2[]; fill?: boolean } & PlotStyle)
  | ({ kind: 'circle'; center: Vec2; r: number; fill?: boolean } & PlotStyle)
  | ({ kind: 'angle'; at: Vec2; from: Vec2; to: Vec2; right?: boolean } & PlotStyle)
  | { kind: 'text'; at: Vec2; text: string; color?: Color };

export interface PlotSpec {
  x?: Range;
  y?: Range;
  /** Same scale on both axes (geometry, circles). */
  equal?: boolean;
  grid?: boolean;
  xLabel?: string;
  yLabel?: string;
  width?: number;
  height?: number;
  items: PlotItem[];
}

export interface PlotPanel extends PlotSpec {
  type: 'plot';
}

interface Plot3DStyle {
  color?: Color;
  label?: string;
}

export type Plot3DItem =
  | ({ kind: 'surface'; fn: string; opacity?: number } & Plot3DStyle)
  | ({ kind: 'psurface'; x: string; y: string; z: string; u?: Range; v?: Range; opacity?: number } & Plot3DStyle)
  | ({ kind: 'curve'; x: string; y: string; z: string; t?: Range } & Plot3DStyle)
  | ({ kind: 'point'; at: Vec3 } & Plot3DStyle)
  | ({ kind: 'vector'; from?: Vec3; to: Vec3 } & Plot3DStyle);

export interface Plot3DSpec {
  x?: Range;
  y?: Range;
  z?: Range;
  equal?: boolean;
  xLabel?: string;
  yLabel?: string;
  zLabel?: string;
  autoRotate?: boolean;
  items: Plot3DItem[];
}

export interface Plot3DPanel extends Plot3DSpec {
  type: 'plot3d';
}

export type Panel = DiagramPanel | StepsPanel | ThreePanel | PlotPanel | Plot3DPanel;

export interface Pointer {
  x: number;
  y: number;
  w?: number;
  h?: number;
  label?: string;
  style?: 'circle' | 'box' | 'arrow' | 'underline';
}

export interface Scene {
  title?: string;
  subtitle?: string;
  placement?: { x: number; y: number } | null;
  pointers?: Pointer[];
  panel?: Panel | null;
}
