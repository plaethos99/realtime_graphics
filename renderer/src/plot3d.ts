// 3D math plots: surfaces z = f(x, y), parametric surfaces and curves, points and vectors, inside a
// labelled plot box. Math coordinates are z-up; three.js is y-up, so (x, y, z) maps to (x, z, -y).
import * as THREE from 'three';
import { compile, type Compiled } from './expr';
import { colorOf } from './theme';
import { arrowFor, createStage, leaderLabel, tag, type ThreeView } from './three-view';
import type { Plot3DItem, Plot3DSpec, Range, Vec3 } from './types';

const BOX = 5; // longest side of the plot box, in scene units
const SURFACE_COLORS = ['blue', 'orange', 'green', 'purple', 'teal', 'red'];
const INK = 0x2b2a28;

const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length >= 3 && ok(v[0]) && ok(v[1]) && ok(v[2]);

function validRange(r: unknown): Range | null {
  if (!Array.isArray(r) || r.length < 2 || !ok(r[0]) || !ok(r[1]) || r[0] === r[1]) return null;
  return r[0] < r[1] ? [r[0], r[1]] : [r[1], r[0]];
}

function settle(values: number[], pad = 0.1): Range | null {
  if (!values.length) return null;
  let lo = Math.min(...values);
  let hi = Math.max(...values);
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

function fmt(v: number, span: number): string {
  const decimals = Math.max(0, 2 - Math.floor(Math.log10(span)));
  return String(+v.toFixed(Math.min(decimals, 3))).replace('-', '−');
}

type Sampled =
  | { item: Plot3DItem & { kind: 'surface' }; f: Compiled }
  | { item: Plot3DItem & { kind: 'psurface' }; grid: Vec3[][] }
  | { item: Plot3DItem & { kind: 'curve' }; pts: Vec3[] }
  | { item: Plot3DItem & { kind: 'point' } }
  | { item: Plot3DItem & { kind: 'vector' } };

export function createPlot3DView(host: HTMLElement, panel: Plot3DSpec, animate: boolean): ThreeView {
  const stage = createStage(host, animate);
  if (!stage) return { dispose: () => host.replaceChildren() };
  const { content } = stage;
  const errors: string[] = [];
  const tryCompile = (src: string, vars: string[]): Compiled | null => {
    try {
      return compile(src, vars);
    } catch (err) {
      errors.push(`${src}: ${(err as Error).message}`);
      return null;
    }
  };

  // ---- sample everything in math coordinates ----
  const sampled: Sampled[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const addPt = (p: Vec3) => {
    if (!isVec3(p)) return;
    xs.push(p[0]);
    ys.push(p[1]);
    zs.push(p[2]);
  };
  for (const item of panel.items ?? []) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'surface') {
      const f = tryCompile(item.fn, ['x', 'y']);
      if (f) sampled.push({ item, f });
    } else if (item.kind === 'psurface') {
      const X = tryCompile(item.x, ['u', 'v']);
      const Y = tryCompile(item.y, ['u', 'v']);
      const Z = tryCompile(item.z, ['u', 'v']);
      if (!X || !Y || !Z) continue;
      const u = validRange(item.u) ?? [0, Math.PI * 2];
      const v = validRange(item.v) ?? [0, Math.PI];
      const n = 56;
      const grid: Vec3[][] = [];
      for (let i = 0; i <= n; i++) {
        const row: Vec3[] = [];
        for (let j = 0; j <= n; j++) {
          const s = { u: u[0] + ((u[1] - u[0]) * i) / n, v: v[0] + ((v[1] - v[0]) * j) / n };
          const p: Vec3 = [X(s), Y(s), Z(s)];
          row.push(p);
          addPt(p);
        }
        grid.push(row);
      }
      sampled.push({ item, grid });
    } else if (item.kind === 'curve') {
      const X = tryCompile(item.x, ['t']);
      const Y = tryCompile(item.y, ['t']);
      const Z = tryCompile(item.z, ['t']);
      if (!X || !Y || !Z) continue;
      const t = validRange(item.t) ?? [0, Math.PI * 2];
      const pts: Vec3[] = [];
      for (let i = 0; i <= 400; i++) {
        const s = { t: t[0] + ((t[1] - t[0]) * i) / 400 };
        const p: Vec3 = [X(s), Y(s), Z(s)];
        if (isVec3(p)) {
          pts.push(p);
          addPt(p);
        }
      }
      sampled.push({ item, pts });
    } else if (item.kind === 'point' && isVec3(item.at)) {
      addPt(item.at);
      sampled.push({ item });
    } else if (item.kind === 'vector' && isVec3(item.to)) {
      addPt(item.to);
      addPt(isVec3(item.from) ? item.from : [0, 0, 0]);
      sampled.push({ item });
    }
  }

  const hasSurface = sampled.some((s) => s.item.kind === 'surface');
  const xr = validRange(panel.x) ?? (hasSurface || !xs.length ? [-3, 3] : settle(xs)!);
  const yr = validRange(panel.y) ?? (hasSurface || !ys.length ? [-3, 3] : settle(ys)!);

  // Surfaces z = f(x, y) are sampled once the x/y window is known.
  const N = 64;
  const surfaces = new Map<Sampled, number[][]>();
  const surfaceZ: number[] = [];
  for (const s of sampled) {
    if (s.item.kind !== 'surface' || !('f' in s)) continue;
    const grid: number[][] = [];
    for (let i = 0; i <= N; i++) {
      const row: number[] = [];
      for (let j = 0; j <= N; j++) {
        const z = s.f({ x: xr[0] + ((xr[1] - xr[0]) * i) / N, y: yr[0] + ((yr[1] - yr[0]) * j) / N });
        row.push(z);
        if (ok(z)) surfaceZ.push(z);
      }
      grid.push(row);
    }
    surfaces.set(s, grid);
  }
  surfaceZ.sort((a, b) => a - b);
  const q = (p: number) => surfaceZ[Math.round(p * (surfaceZ.length - 1))];
  const zr =
    validRange(panel.z) ??
    settle([...(surfaceZ.length ? [q(0.02), q(0.98)] : []), ...zs]) ??
    [-3, 3];

  // ---- math -> scene mapping ----
  const span = [xr[1] - xr[0], yr[1] - yr[0], zr[1] - zr[0]];
  const longest = Math.max(...span);
  const scale = panel.equal
    ? [BOX / longest, BOX / longest, BOX / longest]
    : [BOX / span[0], BOX / span[1], (BOX * 0.75) / span[2]];
  const mid = [(xr[0] + xr[1]) / 2, (yr[0] + yr[1]) / 2, (zr[0] + zr[1]) / 2];
  const zClamp = (z: number) => Math.max(zr[0] - span[2] * 0.04, Math.min(zr[1] + span[2] * 0.04, z));
  const map = (x: number, y: number, z: number) =>
    new THREE.Vector3((x - mid[0]) * scale[0], (zClamp(z) - mid[2]) * scale[2], -(y - mid[1]) * scale[1]);
  const mapV = (p: Vec3) => map(p[0], p[1], p[2]);
  const half = new THREE.Vector3((span[0] * scale[0]) / 2, (span[2] * scale[2]) / 2, (span[1] * scale[1]) / 2);

  content.add(axesFor(panel, xr, yr, zr, map, half));

  let colorIndex = 0;
  const nextColor = (c?: string) => c ?? SURFACE_COLORS[colorIndex++ % SURFACE_COLORS.length];

  for (const s of sampled) {
    const item = s.item;
    if (item.kind === 'surface') {
      const grid = surfaces.get(s)!;
      const pts = grid.map((row, i) =>
        row.map((z, j) => map(xr[0] + (span[0] * i) / N, yr[0] + (span[1] * j) / N, ok(z) ? z : zr[0])),
      );
      const mesh = surfaceMesh(pts, nextColor(item.color), item.opacity, (p) => (p.y / scale[2] + mid[2] - zr[0]) / span[2]);
      content.add(mesh);
      if (item.label) {
        // Tag the highest visible point of the surface.
        let top = pts[0][0];
        for (const row of pts) for (const p of row) if (p.y > top.y) top = p;
        content.add(...leaderLabel(item.label, top.clone(), top.clone().add(new THREE.Vector3(0, 0.8, 0))));
      }
    } else if (item.kind === 'psurface' && 'grid' in s) {
      const pts = s.grid.map((row) => row.map((p) => (isVec3(p) ? mapV(p) : new THREE.Vector3())));
      const mesh = surfaceMesh(pts, nextColor(item.color), item.opacity, (p) => (p.y / scale[2] + mid[2] - zr[0]) / span[2]);
      content.add(mesh);
      if (item.label) {
        const p = pts[Math.floor(pts.length / 4)][Math.floor(pts[0].length / 3)];
        content.add(...leaderLabel(item.label, p.clone(), p.clone().add(new THREE.Vector3(0.6, 0.8, 0))));
      }
    } else if (item.kind === 'curve' && 'pts' in s) {
      if (s.pts.length < 2) continue;
      const path = new THREE.CatmullRomCurve3(s.pts.map(mapV));
      const color = colorOf(nextColor(item.color), 'red').solid;
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(path, Math.min(600, s.pts.length * 2), 0.045, 8, false),
        new THREE.MeshStandardMaterial({ color, roughness: 0.4 }),
      );
      content.add(mesh);
      if (item.label) {
        const p = path.getPoint(0.85);
        content.add(...leaderLabel(item.label, p.clone(), p.clone().add(new THREE.Vector3(0.5, 0.6, 0))));
      }
    } else if (item.kind === 'point') {
      const p = mapV(item.at);
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 16, 12),
        new THREE.MeshStandardMaterial({ color: colorOf(item.color ?? 'ink').solid, roughness: 0.4 }),
      );
      ball.position.copy(p);
      content.add(ball);
      if (item.label) content.add(...leaderLabel(item.label, p.clone(), p.clone().add(new THREE.Vector3(0.3, 0.55, 0))));
    } else if (item.kind === 'vector') {
      const from = mapV(isVec3(item.from) ? item.from : [0, 0, 0]);
      const to = mapV(item.to);
      const arrow = arrowFor({ from: from.toArray() as Vec3, to: to.toArray() as Vec3, color: nextColor(item.color) });
      if (!arrow) continue;
      content.add(arrow);
      if (item.label) {
        const t = tag(item.label, 'arrow', colorOf(item.color, 'red').stroke);
        t.position.copy(to.clone().add(to.clone().sub(from).normalize().multiplyScalar(0.35)));
        content.add(t);
      }
    }
  }

  if (errors.length) console.warn('[realtime-graphics] plot3d formulas skipped:', errors);
  return stage.start({ autoRotate: panel.autoRotate, zoom: 0.78 });
}

/** Height-shaded surface from a grid of scene-space points, with a light ink wireframe on top. */
function surfaceMesh(pts: THREE.Vector3[][], colorName: string, opacity: number | undefined, height: (p: THREE.Vector3) => number): THREE.Mesh {
  const rows = pts.length;
  const cols = pts[0]?.length ?? 0;
  const positions = new Float32Array(rows * cols * 3);
  const colors = new Float32Array(rows * cols * 3);
  const base = new THREE.Color(colorOf(colorName, 'blue').solid);
  const low = base.clone().multiplyScalar(0.55);
  const high = base.clone().lerp(new THREE.Color(0xffffff), 0.55);
  const c = new THREE.Color();
  pts.forEach((row, i) =>
    row.forEach((p, j) => {
      const k = (i * cols + j) * 3;
      positions.set([p.x, p.y, p.z], k);
      c.copy(low).lerp(high, Math.max(0, Math.min(1, height(p))));
      colors.set([c.r, c.g, c.b], k);
    }),
  );
  const index: number[] = [];
  for (let i = 0; i < rows - 1; i++)
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      const b = a + cols;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  const alpha = ok(opacity) ? Math.max(0.1, Math.min(1, opacity)) : 0.92;
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.6,
      metalness: 0.02,
      transparent: alpha < 1,
      opacity: alpha,
      depthWrite: alpha >= 0.99,
    }),
  );

  const wire: number[] = [];
  const every = Math.max(1, Math.round((rows - 1) / 12));
  for (let i = 0; i < rows; i += every)
    for (let j = 0; j + 1 < cols; j++) wire.push(...pts[i][j].toArray(), ...pts[i][j + 1].toArray());
  for (let j = 0; j < cols; j += every)
    for (let i = 0; i + 1 < rows; i++) wire.push(...pts[i][j].toArray(), ...pts[i + 1][j].toArray());
  const lines = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(wire, 3)),
    new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.22 }),
  );
  mesh.add(lines);
  return mesh;
}

/** Plot box outline, floor grid, the three axes through the origin (or the box edge) and their ranges. */
function axesFor(
  panel: Plot3DSpec,
  xr: Range,
  yr: Range,
  zr: Range,
  map: (x: number, y: number, z: number) => THREE.Vector3,
  half: THREE.Vector3,
): THREE.Group {
  const group = new THREE.Group();
  group.userData.noPop = true;
  const faint = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.18 });
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2)), faint);
  group.add(box);

  const grid: number[] = [];
  for (let k = 0; k <= 10; k++) {
    const x = xr[0] + ((xr[1] - xr[0]) * k) / 10;
    const y = yr[0] + ((yr[1] - yr[0]) * k) / 10;
    grid.push(...map(x, yr[0], zr[0]).toArray(), ...map(x, yr[1], zr[0]).toArray());
    grid.push(...map(xr[0], y, zr[0]).toArray(), ...map(xr[1], y, zr[0]).toArray());
  }
  group.add(
    new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(grid, 3)),
      new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.1 }),
    ),
  );

  // Axes pass through 0 when it's in range, otherwise along the box edge.
  const at = (r: Range) => (r[0] <= 0 && r[1] >= 0 ? 0 : r[0]);
  const ox = at(xr);
  const oy = at(yr);
  const oz = at(zr);
  const axes: [THREE.Vector3, THREE.Vector3, string][] = [
    [map(xr[0], oy, oz), map(xr[1], oy, oz), panel.xLabel ?? 'x'],
    [map(ox, yr[0], oz), map(ox, yr[1], oz), panel.yLabel ?? 'y'],
    [map(ox, oy, zr[0]), map(ox, oy, zr[1]), panel.zLabel ?? 'z'],
  ];
  for (const [from, to, name] of axes) {
    const dir = to.clone().sub(from).normalize();
    const tip = to.clone().addScaledVector(dir, 0.45);
    const arrow = arrowFor({ from: from.toArray() as Vec3, to: tip.toArray() as Vec3, color: 'ink' });
    if (arrow) {
      arrow.scale.setScalar(1); // axes don't pop in
      arrow.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m) m.color.set(0x55524d);
      });
      group.add(arrow);
    }
    const label = tag(name, 'axis');
    label.position.copy(tip.clone().addScaledVector(dir, 0.3));
    group.add(label);
  }

  // Range values at the ends of the floor edges and the vertical edge.
  const ticks: [THREE.Vector3, string][] = [
    [map(xr[0], yr[0], zr[0]), `x = ${fmt(xr[0], xr[1] - xr[0])}`],
    [map(xr[1], yr[0], zr[0]), `x = ${fmt(xr[1], xr[1] - xr[0])}`],
    [map(xr[1], yr[1], zr[0]), `y = ${fmt(yr[1], yr[1] - yr[0])}`],
    [map(xr[0], yr[1], zr[1]), `z = ${fmt(zr[1], zr[1] - zr[0])}`],
  ];
  for (const [p, text] of ticks) {
    const t = tag(text, 'axis');
    t.element.firstElementChild?.classList.add('rtg-tag3d-tick');
    t.position.copy(p);
    group.add(t);
  }
  return group;
}
