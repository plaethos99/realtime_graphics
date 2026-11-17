import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Ready-made 3D objects built from code, so scenes can say { shape: "model", model: "car" } instead of
// assembling one from primitives. The names must match MODELS in proxy/app/scene.py (a test checks this).

const DEG = Math.PI / 180;

export type MaterialKind = 'plastic' | 'matte' | 'metal' | 'glass' | 'rubber' | 'wood' | 'glow';

const PRESETS: Record<Exclude<MaterialKind, 'glow' | 'glass'>, { roughness: number; metalness: number }> = {
  plastic: { roughness: 0.42, metalness: 0 },
  matte: { roughness: 0.85, metalness: 0 },
  metal: { roughness: 0.26, metalness: 0.95 },
  rubber: { roughness: 0.92, metalness: 0 },
  wood: { roughness: 0.72, metalness: 0 },
};

export function materialFor(color: string, kind: string = 'plastic', opacity = 1): THREE.MeshStandardMaterial {
  if (kind === 'glass') {
    return new THREE.MeshStandardMaterial({
      color,
      roughness: 0.06,
      metalness: 0,
      transparent: true,
      opacity: Math.min(opacity, 0.32),
      depthWrite: false,
      side: THREE.DoubleSide,
      envMapIntensity: 1.6,
    });
  }
  if (kind === 'glow') {
    return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, roughness: 0.5, transparent: opacity < 0.99, opacity });
  }
  const translucent = opacity < 0.99;
  return new THREE.MeshStandardMaterial({
    color,
    ...(PRESETS[kind as keyof typeof PRESETS] ?? PRESETS.plastic),
    transparent: translucent,
    opacity,
    depthWrite: !translucent,
    side: translucent ? THREE.DoubleSide : THREE.FrontSide,
  });
}

// ---------- geometry builders, also used for the lathe, extrude and tube shapes ----------

const finite = (p: number[] | undefined, n: number) => Array.isArray(p) && p.length >= n && p.slice(0, n).every(Number.isFinite);

/** Spins a side profile of [radius, height] points around Y. Smooth unless `sharp`; open ends are closed. */
export function latheGeometry(profile: number[][], sharp = false): THREE.BufferGeometry | null {
  const pts = profile.filter((p) => finite(p, 2)).map(([r, y]) => new THREE.Vector3(Math.max(0, r), y, 0));
  if (pts.length < 2) return null;
  const line = sharp || pts.length < 3 ? pts : new THREE.CatmullRomCurve3(pts, false, 'centripetal').getPoints(pts.length * 6);
  const out = line.map((p) => new THREE.Vector2(Math.max(0, p.x), p.y));
  if (out[0].x > 0) out.unshift(new THREE.Vector2(0, out[0].y));
  if (out[out.length - 1].x > 0) out.push(new THREE.Vector2(0, out[out.length - 1].y));
  return new THREE.LatheGeometry(out, 48);
}

/** A flat outline of [x, y] points (or a Shape) given thickness along Z, centred on z = 0, with soft edges. */
export function extrudeGeometry(outline: number[][] | THREE.Shape, depth = 0.2): THREE.BufferGeometry | null {
  let shape: THREE.Shape;
  if (outline instanceof THREE.Shape) {
    shape = outline;
  } else {
    const pts = outline.filter((p) => finite(p, 2)).map(([x, y]) => new THREE.Vector2(x, y));
    if (pts.length < 3) return null;
    shape = new THREE.Shape(pts);
  }
  const bevel = Math.min(depth * 0.2, 0.04);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 24,
  });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

/** A round pipe along a smooth path of [x, y, z] points. */
export function tubeGeometry(path: number[][], radius = 0.1): THREE.BufferGeometry | null {
  const pts = path.filter((p) => finite(p, 3)).map(([x, y, z]) => new THREE.Vector3(x, y, z));
  if (pts.length < 2) return null;
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal'), Math.max(16, pts.length * 12), radius, 14, false);
}

export function roundedBox(w: number, h: number, d: number, radius?: number): THREE.BufferGeometry {
  return new RoundedBoxGeometry(w, h, d, 3, radius ?? Math.min(w, h, d) * 0.08);
}

// ---------- parts ----------

type V3 = [number, number, number];
interface Place {
  p?: V3;
  r?: V3; // degrees
  s?: V3;
  k?: MaterialKind;
  flat?: boolean;
}

function P(geometry: THREE.BufferGeometry | null, color: string, { p, r, s, k, flat }: Place = {}): THREE.Mesh {
  const material = materialFor(color, k);
  if (flat) material.flatShading = true;
  const mesh = new THREE.Mesh(geometry ?? new THREE.BufferGeometry(), material);
  if (p) mesh.position.set(...p);
  if (r) mesh.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG);
  if (s) mesh.scale.set(...s);
  return mesh;
}

const box = roundedBox;
const cyl = (rTop: number, rBottom: number, h: number, seg = 32) => new THREE.CylinderGeometry(rTop, rBottom, h, seg);
const ball = (r: number) => new THREE.SphereGeometry(r, 32, 20);
const cone = (r: number, h: number, seg = 32) => new THREE.ConeGeometry(r, h, seg);
const ring = (R: number, t: number) => new THREE.TorusGeometry(R, t, 16, 48);
const pill = (r: number, l: number) => new THREE.CapsuleGeometry(r, l, 8, 20);

/** A cylinder stretched between two points: bonds, ropes, legs. */
function rod(a: V3, b: V3, r: number, color: string, k?: MaterialKind): THREE.Mesh {
  const from = new THREE.Vector3(...a);
  const to = new THREE.Vector3(...b);
  const dir = to.clone().sub(from);
  const mesh = P(cyl(r, r, dir.length(), 12), color, { k });
  mesh.position.copy(from.addScaledVector(dir, 0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

const WHITE = '#f3f1ea';
const DARK = '#3b3a3f';
const STEEL = '#b4bac2';
const GOLD = '#e8b63e';
const WOODY = '#9a6b3f';
const SKIN = '#e9b995';
const GLASS = '#bfe3f2';
const LEAF = '#4f9d57';
const FIRE = '#f08a24';
const RED = '#d9504a';
const BLUE = '#4f86df';
const SCREEN = '#5fb6ee';

function globeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2f77c9';
  g.fillRect(0, 0, 512, 256);
  // Fixed blob positions, so the globe looks the same every time.
  const land: [number, number, number][] = [
    [90, 80, 34], [120, 110, 26], [145, 170, 24], [160, 205, 16], [255, 80, 22], [285, 70, 26], [270, 140, 30],
    [285, 180, 18], [340, 80, 38], [390, 95, 34], [405, 170, 18], [440, 190, 16], [190, 25, 22], [60, 60, 18],
  ];
  g.fillStyle = '#58a65c';
  for (const [x, y, r] of land) {
    for (let i = 0; i < 7; i++) {
      g.beginPath();
      g.arc(x + Math.sin(i * 2.4 + x) * r * 0.8, y + Math.cos(i * 1.7 + y) * r * 0.6, r * 0.62, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.fillStyle = '#eef3f5';
  g.fillRect(0, 0, 512, 12);
  g.fillRect(0, 244, 512, 12);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function gearShape(teeth = 10, outer = 0.8, root = 0.62, hole = 0.22): THREE.Shape {
  const shape = new THREE.Shape();
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const pts: [number, number][] = [
      [root, a],
      [outer, a + step * 0.16],
      [outer, a + step * 0.42],
      [root, a + step * 0.58],
    ];
    pts.forEach(([r, t], j) => {
      const x = Math.cos(t) * r;
      const y = Math.sin(t) * r;
      if (i === 0 && j === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    });
  }
  shape.closePath();
  const inner = new THREE.Path();
  inner.absarc(0, 0, hole, 0, Math.PI * 2, true);
  shape.holes.push(inner);
  return shape;
}

function heartShape(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(0, -0.9);
  s.bezierCurveTo(-1.3, -0.1, -1, 0.9, -0.42, 0.9);
  s.bezierCurveTo(-0.15, 0.9, 0, 0.7, 0, 0.5);
  s.bezierCurveTo(0, 0.7, 0.15, 0.9, 0.42, 0.9);
  s.bezierCurveTo(1, 0.9, 1.3, -0.1, 0, -0.9);
  return s;
}

function shieldShape(scale = 1): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-0.7 * scale, 0.8 * scale);
  s.lineTo(0.7 * scale, 0.8 * scale);
  s.bezierCurveTo(0.75 * scale, -0.1 * scale, 0.45 * scale, -0.6 * scale, 0, -0.95 * scale);
  s.bezierCurveTo(-0.45 * scale, -0.6 * scale, -0.75 * scale, -0.1 * scale, -0.7 * scale, 0.8 * scale);
  return s;
}

function bubbleShape(): THREE.Shape {
  const s = new THREE.Shape();
  const w = 0.9;
  const h = 0.55;
  const r = 0.25;
  s.moveTo(-w + r, -h);
  s.lineTo(-0.3, -h);
  s.lineTo(-0.5, -h - 0.35);
  s.lineTo(0.05, -h);
  s.lineTo(w - r, -h);
  s.quadraticCurveTo(w, -h, w, -h + r);
  s.lineTo(w, h - r);
  s.quadraticCurveTo(w, h, w - r, h);
  s.lineTo(-w + r, h);
  s.quadraticCurveTo(-w, h, -w, h - r);
  s.lineTo(-w, -h + r);
  s.quadraticCurveTo(-w, -h, -w + r, -h);
  return s;
}

const wheel = (x: number, z: number, r = 0.2): THREE.Object3D[] => [
  P(cyl(r, r, 0.14), '#26262a', { p: [x, r, z], r: [90, 0, 0], k: 'rubber' }),
  P(cyl(r * 0.5, r * 0.5, 0.15), STEEL, { p: [x, r, z], r: [90, 0, 0], k: 'metal' }),
];

// ---------- the kit. Each one faces +Z with Y up; sizes are arbitrary because buildModel normalises them. ----------

const KIT: Record<string, (main?: string) => THREE.Object3D[]> = {
  // people and bodies
  person: (c = BLUE) => [
    P(pill(0.09, 0.5), DARK, { p: [-0.12, 0.34, 0] }),
    P(pill(0.09, 0.5), DARK, { p: [0.12, 0.34, 0] }),
    P(pill(0.21, 0.34), c, { p: [0, 0.95, 0] }),
    P(pill(0.065, 0.46), c, { p: [-0.3, 0.96, 0], r: [0, 0, -10] }),
    P(pill(0.065, 0.46), c, { p: [0.3, 0.96, 0], r: [0, 0, 10] }),
    P(ball(0.07), SKIN, { p: [-0.35, 0.66, 0] }),
    P(ball(0.07), SKIN, { p: [0.35, 0.66, 0] }),
    P(ball(0.18), SKIN, { p: [0, 1.53, 0] }),
    P(new THREE.SphereGeometry(0.19, 32, 20, 0, Math.PI * 2, 0, Math.PI * 0.48), '#4a3323', { p: [0, 1.55, -0.02], r: [-14, 0, 0] }),
  ],
  robot: (c = '#b9c0c9') => [
    P(box(0.2, 0.46, 0.26), DARK, { p: [-0.17, 0.23, 0] }),
    P(box(0.2, 0.46, 0.26), DARK, { p: [0.17, 0.23, 0] }),
    P(box(0.7, 0.62, 0.42), c, { p: [0, 0.78, 0], k: 'metal' }),
    P(box(0.34, 0.2, 0.03), SCREEN, { p: [0, 0.82, 0.215], k: 'glow' }),
    P(pill(0.07, 0.4), c, { p: [-0.46, 0.8, 0], k: 'metal' }),
    P(pill(0.07, 0.4), c, { p: [0.46, 0.8, 0], k: 'metal' }),
    P(box(0.56, 0.4, 0.42), c, { p: [0, 1.36, 0], k: 'metal' }),
    P(ball(0.065), SCREEN, { p: [-0.13, 1.4, 0.21], k: 'glow' }),
    P(ball(0.065), SCREEN, { p: [0.13, 1.4, 0.21], k: 'glow' }),
    P(box(0.24, 0.04, 0.02), DARK, { p: [0, 1.26, 0.215] }),
    P(cyl(0.015, 0.015, 0.2), DARK, { p: [0, 1.65, 0] }),
    P(ball(0.05), RED, { p: [0, 1.77, 0], k: 'glow' }),
  ],
  heart: (c = RED) => [P(extrudeGeometry(heartShape(), 0.45), c)],
  brain: (c = '#e79aa8') => {
    // Lumps on two ellipsoids, leaving a groove down the middle.
    const parts: THREE.Object3D[] = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < 34; i++) {
        const y = 1 - (2 * (i + 0.5)) / 34;
        const r = Math.sqrt(1 - y * y);
        const a = i * 2.39996;
        const x = Math.abs(Math.cos(a) * r);
        parts.push(P(ball(0.17), c, { p: [side * (0.1 + x * 0.42), y * 0.46 + 0.7, Math.sin(a) * r * 0.7], s: [1, 0.9, 1.1], k: 'matte' }));
      }
      parts.push(P(ball(0.46), '#c97f8e', { p: [side * 0.27, 0.7, 0], s: [0.8, 1, 1.45], k: 'matte' }));
    }
    parts.push(P(cyl(0.09, 0.05, 0.4), '#c97f8e', { p: [0, 0.16, -0.25], r: [18, 0, 0], k: 'matte' }));
    return parts;
  },
  eye: (c = '#4f86df') => [
    P(ball(0.7), WHITE),
    P(new THREE.SphereGeometry(0.705, 32, 12, 0, Math.PI * 2, 0, 0.5), c, { r: [90, 0, 0] }),
    P(new THREE.SphereGeometry(0.71, 32, 12, 0, Math.PI * 2, 0, 0.24), '#15151a', { r: [90, 0, 0] }),
    P(ball(0.05), '#ffffff', { p: [0.12, 0.13, 0.69], k: 'glow' }),
  ],

  // nature
  tree: (c = LEAF) => [
    P(cyl(0.09, 0.16, 0.8), WOODY, { p: [0, 0.4, 0], k: 'wood' }),
    P(ball(0.5), c, { p: [0, 1.2, 0], k: 'matte' }),
    P(ball(0.34), c, { p: [0.34, 0.95, 0.1], k: 'matte' }),
    P(ball(0.36), c, { p: [-0.32, 1, -0.06], k: 'matte' }),
    P(ball(0.3), c, { p: [0, 0.98, 0.32], k: 'matte' }),
  ],
  plant: (c = LEAF) => [
    P(cyl(0.3, 0.22, 0.4), '#b5623e', { p: [0, 0.2, 0], k: 'matte' }),
    P(cyl(0.27, 0.27, 0.02), '#4a3323', { p: [0, 0.4, 0], k: 'matte' }),
    P(cyl(0.022, 0.03, 0.5), c, { p: [0, 0.64, 0] }),
    P(ball(0.17), c, { p: [-0.17, 0.88, 0], s: [1.25, 0.28, 0.65], r: [0, 0, 24] }),
    P(ball(0.17), c, { p: [0.17, 0.96, 0], s: [1.25, 0.28, 0.65], r: [0, 0, -24] }),
  ],
  mountain: (c = '#8b8d93') => [
    P(cone(1, 1.5, 7), c, { p: [0, 0.75, 0], flat: true, k: 'matte' }),
    P(cone(0.36, 0.54, 7), WHITE, { p: [0, 1.235, 0], flat: true, k: 'matte' }),
    P(cone(0.62, 0.85, 6), '#74767c', { p: [0.95, 0.425, 0.25], flat: true, k: 'matte' }),
  ],
  sun: (c = '#f6c343') => [
    P(ball(0.55), c, { k: 'glow' }),
    ...Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2;
      return P(cone(0.09, 0.28), FIRE, { p: [Math.cos(a) * 0.76, Math.sin(a) * 0.76, 0], r: [0, 0, (a * 180) / Math.PI - 90], k: 'glow' });
    }),
  ],
  cloud: (c = '#f4f6f8') => [
    P(ball(0.42), c, { k: 'matte' }),
    P(ball(0.32), c, { p: [0.48, -0.08, 0], k: 'matte' }),
    P(ball(0.32), c, { p: [-0.48, -0.08, 0], k: 'matte' }),
    P(ball(0.27), c, { p: [0.18, -0.12, 0.26], k: 'matte' }),
    P(ball(0.25), c, { p: [-0.2, -0.14, -0.24], k: 'matte' }),
  ],
  globe: () => {
    const earth = P(ball(0.8), '#ffffff', { r: [0, 0, -14] });
    (earth.material as THREE.MeshStandardMaterial).map = globeTexture();
    return [earth];
  },
  planet: (c = '#d9a066') => [
    P(ball(0.6), c, { k: 'matte' }),
    P(new THREE.TorusGeometry(0.92, 0.09, 8, 64), '#c9b89a', { r: [72, 12, 0], s: [1, 1, 0.12], k: 'matte' }),
  ],
  flame: (c = FIRE) => [
    P(latheGeometry([[0, 0], [0.32, 0.22], [0.36, 0.5], [0.2, 0.95], [0, 1.4]]), c, { k: 'glow' }),
    P(latheGeometry([[0, 0.02], [0.17, 0.16], [0.19, 0.36], [0.1, 0.62], [0, 0.85]]), '#ffd95a', { p: [0, 0.02, 0.24], k: 'glow' }),
  ],
  drop: (c = '#4f9fdf') => [P(latheGeometry([[0, 0], [0.32, 0.1], [0.42, 0.36], [0.26, 0.76], [0, 1.25]]), c, { k: 'plastic' })],
  rock: (c = '#8b8d93') => [P(new THREE.IcosahedronGeometry(0.6, 1), c, { p: [0, 0.4, 0], s: [1.2, 0.7, 1], flat: true, k: 'matte' })],

  // buildings and places
  house: (c = '#e6d3b3') => [
    P(box(1.5, 0.95, 1.2), c, { p: [0, 0.475, 0], k: 'matte' }),
    P(cone(1.22, 0.75, 4), '#b5533c', { p: [0, 1.32, 0], r: [0, 45, 0], s: [1, 1, 0.84], flat: true }),
    P(box(0.28, 0.56, 0.05), '#7a4b2b', { p: [0, 0.28, 0.61], k: 'wood' }),
    P(box(0.28, 0.28, 0.04), GLASS, { p: [-0.48, 0.56, 0.61] }),
    P(box(0.28, 0.28, 0.04), GLASS, { p: [0.48, 0.56, 0.61] }),
    P(box(0.2, 0.5, 0.2), '#8f4a36', { p: [0.42, 1.5, -0.2], k: 'matte' }),
  ],
  office: (c = '#8ca3b8') => {
    const parts: THREE.Object3D[] = [P(box(1, 2.6, 1), c, { p: [0, 1.3, 0], k: 'metal' })];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 4; col++) {
        const lit = (row * 3 + col * 5) % 4 === 0;
        parts.push(P(box(0.15, 0.2, 0.02), lit ? '#ffe08a' : '#2f4358', { p: [-0.3 + col * 0.2, 0.3 + row * 0.3, 0.505], k: lit ? 'glow' : 'plastic' }));
        parts.push(P(box(0.02, 0.2, 0.15), '#2f4358', { p: [0.505, 0.3 + row * 0.3, -0.3 + col * 0.2] }));
      }
    }
    return parts;
  },
  factory: (c = '#b0725a') => [
    P(box(2, 0.8, 1.1), c, { p: [0, 0.4, 0], k: 'matte' }),
    ...[-0.67, 0, 0.67].map((x) => P(extrudeGeometry([[-0.33, 0], [0.33, 0], [0.33, 0.36]], 1), '#74767c', { p: [x, 0.8, 0], flat: true })),
    P(cyl(0.11, 0.15, 1.1), '#8c5745', { p: [-0.7, 1.35, -0.3], k: 'matte' }),
    P(cyl(0.09, 0.13, 0.9), '#8c5745', { p: [-0.3, 1.25, -0.3], k: 'matte' }),
    P(box(0.34, 0.5, 0.04), DARK, { p: [0.5, 0.25, 0.56] }),
    ...[-0.7, -0.3].map((x) => P(box(0.26, 0.2, 0.04), GLASS, { p: [x, 0.42, 0.56] })),
  ],
  castle: (c = '#a8a59d') => {
    const parts: THREE.Object3D[] = [
      P(box(1.8, 0.9, 1.8), c, { p: [0, 0.45, 0], k: 'matte' }),
      P(box(0.8, 1.4, 0.8), c, { p: [0, 0.7, 0], k: 'matte' }),
      P(cone(0.56, 0.6, 4), '#5a6fa8', { p: [0, 1.7, 0], r: [0, 45, 0], flat: true }),
      P(box(0.36, 0.56, 0.05), '#5c3b22', { p: [0, 0.28, 0.91], k: 'wood' }),
    ];
    for (const [x, z] of [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]]) {
      parts.push(P(cyl(0.26, 0.28, 1.25), c, { p: [x, 0.625, z], k: 'matte' }));
      parts.push(P(cone(0.34, 0.5), '#5a6fa8', { p: [x, 1.5, z] }));
    }
    for (let i = -3; i <= 3; i += 2) {
      parts.push(P(box(0.12, 0.13, 0.1), c, { p: [i * 0.12, 0.96, 0.87], k: 'matte' }));
      parts.push(P(box(0.12, 0.13, 0.1), c, { p: [i * 0.12, 0.96, -0.87], k: 'matte' }));
    }
    return parts;
  },
  bridge: (c = '#c9553d') => {
    const parts: THREE.Object3D[] = [P(box(3.6, 0.09, 0.5), DARK, { p: [0, 0.6, 0] })];
    const cable: number[][] = [];
    for (let i = 0; i <= 8; i++) {
      const x = -1.6 + i * 0.4;
      const y = 0.72 + 0.82 * ((x / 1.6) ** 2 ) ;
      cable.push([x, y, 0]);
    }
    for (const z of [-0.22, 0.22]) {
      for (const x of [-1.6, 1.6]) parts.push(P(box(0.14, 1.65, 0.1), c, { p: [x, 0.825, z] }));
      parts.push(P(tubeGeometry(cable, 0.018), c, { p: [0, 0, z] }));
      for (const [x, y] of cable.slice(1, -1)) parts.push(rod([x, 0.62, z], [x, y, z], 0.008, c));
    }
    return parts;
  },
  wall: (c = '#b5623e') => {
    const parts: THREE.Object3D[] = [];
    for (let row = 0; row < 6; row++) {
      const shift = row % 2 ? 0.2 : 0;
      for (let col = 0; col < 5; col++) parts.push(P(box(0.38, 0.19, 0.3, 0.02), c, { p: [-0.8 + col * 0.4 + shift, 0.1 + row * 0.205, 0], k: 'matte' }));
    }
    return parts;
  },
  stairs: (c = '#c7c2b8') => Array.from({ length: 6 }, (_, i) => P(box(1.1, 0.26 * (i + 1), 0.34, 0.02), c, { p: [0, 0.13 * (i + 1), -i * 0.34], k: 'matte' })),
  road: (c = '#3f4045') => [
    P(box(1, 0.04, 3.2, 0.01), c, { p: [0, 0.02, 0], k: 'matte' }),
    ...[-1.2, -0.4, 0.4, 1.2].map((z) => P(box(0.06, 0.012, 0.45, 0.003), '#f4e7b5', { p: [0, 0.045, z], k: 'matte' })),
  ],
  door: (c = '#7a4b2b') => [
    P(box(1.05, 2.05, 0.12), '#d9d4c8', { p: [0, 1.02, 0], k: 'matte' }),
    P(box(0.88, 1.92, 0.08), c, { p: [0, 0.98, 0.05], k: 'wood' }),
    P(box(0.6, 0.72, 0.03), '#6a4023', { p: [0, 1.42, 0.09], k: 'wood' }),
    P(box(0.6, 0.72, 0.03), '#6a4023', { p: [0, 0.56, 0.09], k: 'wood' }),
    P(ball(0.05), GOLD, { p: [0.34, 1, 0.14], k: 'metal' }),
  ],
  ladder: (c = WOODY) => [
    P(cyl(0.04, 0.04, 2.4), c, { p: [-0.3, 1.2, 0], k: 'wood' }),
    P(cyl(0.04, 0.04, 2.4), c, { p: [0.3, 1.2, 0], k: 'wood' }),
    ...Array.from({ length: 7 }, (_, i) => P(cyl(0.028, 0.028, 0.6), c, { p: [0, 0.25 + i * 0.32, 0], r: [0, 0, 90], k: 'wood' })),
  ],
  signpost: (c = WOODY) => [
    P(cyl(0.05, 0.06, 1.9), c, { p: [0, 0.95, 0], k: 'wood' }),
    P(extrudeGeometry([[-0.45, -0.13], [0.35, -0.13], [0.55, 0], [0.35, 0.13], [-0.45, 0.13]], 0.05), '#d9b679', { p: [0.14, 1.6, 0], k: 'wood' }),
    P(extrudeGeometry([[-0.55, 0], [-0.35, -0.13], [0.45, -0.13], [0.45, 0.13], [-0.35, 0.13]], 0.05), '#cda765', { p: [-0.14, 1.22, 0], k: 'wood' }),
  ],
  flag: (c = RED) => {
    const cloth = new THREE.PlaneGeometry(1, 0.62, 24, 6);
    const pos = cloth.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin((pos.getX(i) + 0.5) * 7) * 0.05 * (pos.getX(i) + 0.5));
    cloth.computeVertexNormals();
    const banner = P(cloth, c, { p: [0.53, 1.65, 0] });
    (banner.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    return [P(cyl(0.025, 0.03, 2), STEEL, { p: [0, 1, 0], k: 'metal' }), P(ball(0.05), GOLD, { p: [0, 2.03, 0], k: 'metal' }), banner];
  },

  // vehicles
  car: (c = RED) => [
    P(box(1.9, 0.36, 0.9, 0.12), c, { p: [0, 0.38, 0] }),
    P(box(1, 0.36, 0.78, 0.14), c, { p: [-0.1, 0.68, 0] }),
    P(box(0.03, 0.26, 0.68, 0.01), '#26323f', { p: [0.4, 0.69, 0], r: [0, 0, -16] }),
    P(box(0.86, 0.25, 0.8, 0.05), '#26323f', { p: [-0.1, 0.7, 0] }),
    ...wheel(0.58, 0.45),
    ...wheel(0.58, -0.45),
    ...wheel(-0.58, 0.45),
    ...wheel(-0.58, -0.45),
    P(ball(0.06), '#fff5c9', { p: [0.94, 0.42, 0.3], k: 'glow' }),
    P(ball(0.06), '#fff5c9', { p: [0.94, 0.42, -0.3], k: 'glow' }),
    P(ball(0.05), '#ff4d4d', { p: [-0.94, 0.42, 0.3], k: 'glow' }),
    P(ball(0.05), '#ff4d4d', { p: [-0.94, 0.42, -0.3], k: 'glow' }),
  ],
  ship: (c = '#2f4e78') => [
    P(extrudeGeometry([[-1.05, 0.34], [-0.95, 0], [0.8, 0], [1.25, 0.42], [-1.05, 0.42]], 0.6), c, { p: [0, 0, 0] }),
    P(box(2.25, 0.04, 0.68, 0.01), RED, { p: [0.08, 0.09, 0] }),
    P(box(1, 0.3, 0.56), WHITE, { p: [-0.2, 0.62, 0] }),
    P(box(0.5, 0.24, 0.46), WHITE, { p: [-0.2, 0.89, 0] }),
    P(cyl(0.1, 0.12, 0.34), RED, { p: [-0.5, 0.94, 0] }),
    ...[-0.5, -0.2, 0.1].map((x) => P(ball(0.04), '#26323f', { p: [x, 0.64, 0.29] })),
  ],
  plane: (c = '#eef1f4') => [
    P(pill(0.2, 2), c, { p: [0, 0.3, 0], r: [0, 0, 90] }),
    P(extrudeGeometry([[0.25, 0], [-0.25, 0], [-0.55, 1.15], [-0.32, 1.15]], 0.05), c, { p: [0, 0.27, 0.12], r: [90, 0, 0] }),
    P(extrudeGeometry([[0.25, 0], [-0.25, 0], [-0.55, 1.15], [-0.32, 1.15]], 0.05), c, { p: [0, 0.27, -0.12], r: [-90, 0, 0] }),
    P(extrudeGeometry([[0, 0], [-0.32, 0], [-0.46, 0.46], [-0.28, 0.46]], 0.04), BLUE, { p: [-0.8, 0.44, 0] }),
    P(extrudeGeometry([[0.1, 0], [-0.1, 0], [-0.22, 0.42], [-0.12, 0.42]], 0.03), c, { p: [-0.92, 0.32, 0.1], r: [90, 0, 0] }),
    P(extrudeGeometry([[0.1, 0], [-0.1, 0], [-0.22, 0.42], [-0.12, 0.42]], 0.03), c, { p: [-0.92, 0.32, -0.1], r: [-90, 0, 0] }),
    P(pill(0.07, 0.2), STEEL, { p: [-0.05, 0.14, 0.5], r: [0, 0, 90], k: 'metal' }),
    P(pill(0.07, 0.2), STEEL, { p: [-0.05, 0.14, -0.5], r: [0, 0, 90], k: 'metal' }),
    P(pill(0.08, 0.12), '#26323f', { p: [0.92, 0.38, 0], r: [0, 0, 70] }),
  ],
  rocket: (c = '#eef1f4') => [
    P(latheGeometry([[0, 0.3], [0.26, 0.34], [0.36, 0.9], [0.32, 1.5], [0.18, 1.95], [0, 2.3]]), c),
    P(latheGeometry([[0.24, 1.82], [0.14, 2.02], [0, 2.3]]), RED),
    P(ring(0.13, 0.025), STEEL, { p: [0, 1.32, 0.34], k: 'metal' }),
    P(cyl(0.12, 0.12, 0.02), GLASS, { p: [0, 1.32, 0.33], r: [90, 0, 0] }),
    ...[0, 120, 240].map((ry) => {
      const pivot = new THREE.Group();
      pivot.rotation.y = ry * DEG;
      pivot.add(P(extrudeGeometry([[0.24, 0.3], [0.62, 0], [0.62, 0.2], [0.3, 0.9]], 0.04), RED));
      return pivot;
    }),
    P(cyl(0.16, 0.22, 0.14), DARK, { p: [0, 0.26, 0], k: 'metal' }),
    P(latheGeometry([[0, 0.22], [0.14, 0.14], [0.08, -0.12], [0, -0.42]]), FIRE, { k: 'glow' }),
  ],
  satellite: (c = GOLD) => [
    P(box(0.6, 0.6, 0.6), c, { k: 'metal' }),
    P(box(1, 0.5, 0.03), '#274a8c', { p: [-0.92, 0, 0], k: 'metal' }),
    P(box(1, 0.5, 0.03), '#274a8c', { p: [0.92, 0, 0], k: 'metal' }),
    P(cyl(0.02, 0.02, 0.2), STEEL, { p: [-0.36, 0, 0], r: [0, 0, 90], k: 'metal' }),
    P(cyl(0.02, 0.02, 0.2), STEEL, { p: [0.36, 0, 0], r: [0, 0, 90], k: 'metal' }),
    P(latheGeometry([[0, 0], [0.18, 0.03], [0.32, 0.14]]), WHITE, { p: [0, 0.34, 0] }),
    P(cyl(0.012, 0.012, 0.2), STEEL, { p: [0, 0.46, 0], k: 'metal' }),
  ],

  // technology
  laptop: (c = '#aeb4bc') => [
    P(box(1.5, 0.05, 1, 0.02), c, { p: [0, 0.025, 0], k: 'metal' }),
    P(box(1.3, 0.012, 0.52, 0.004), DARK, { p: [0, 0.055, -0.12] }),
    P(box(0.4, 0.008, 0.24, 0.003), '#8d939b', { p: [0, 0.054, 0.3] }),
    P(box(1.5, 0.96, 0.04, 0.02), c, { p: [0, 0.52, -0.6], r: [-12, 0, 0], k: 'metal' }),
    P(box(1.38, 0.84, 0.01, 0.003), SCREEN, { p: [0, 0.52, -0.575], r: [-12, 0, 0], k: 'glow' }),
  ],
  phone: (c = '#26262a') => [
    P(box(0.72, 1.46, 0.08, 0.035), c, { p: [0, 0.73, 0], k: 'metal' }),
    P(box(0.65, 1.36, 0.01, 0.004), SCREEN, { p: [0, 0.73, 0.042], k: 'glow' }),
    P(cyl(0.022, 0.022, 0.01), '#15151a', { p: [0, 1.36, 0.05], r: [90, 0, 0] }),
  ],
  server: (c = '#3f4249') => {
    const parts: THREE.Object3D[] = [P(box(0.9, 1.9, 0.8), c, { p: [0, 0.95, 0], k: 'metal' })];
    for (let i = 0; i < 6; i++) {
      const y = 0.25 + i * 0.29;
      parts.push(P(box(0.78, 0.22, 0.03, 0.01), '#26282d', { p: [0, y, 0.405] }));
      parts.push(P(ball(0.022), i % 3 === 2 ? '#ffb340' : '#54e07d', { p: [0.3, y, 0.425], k: 'glow' }));
      parts.push(P(ball(0.022), SCREEN, { p: [0.22, y, 0.425], k: 'glow' }));
      for (let j = 0; j < 5; j++) parts.push(P(box(0.05, 0.13, 0.01, 0.003), '#55585f', { p: [-0.32 + j * 0.08, y, 0.425] }));
    }
    return parts;
  },
  database: (c = '#4f86df') =>
    [0, 1, 2].flatMap((i) => [
      P(cyl(0.7, 0.7, 0.44), c, { p: [0, 0.24 + i * 0.5, 0] }),
      P(ring(0.7, 0.012), '#dce7fa', { p: [0, 0.46 + i * 0.5, 0], r: [90, 0, 0], k: 'glow' }),
    ]),
  chip: (c = '#26362c') => {
    const parts: THREE.Object3D[] = [
      P(box(1.2, 0.08, 1.2, 0.02), c, { p: [0, 0.1, 0] }),
      P(box(0.62, 0.1, 0.62, 0.02), '#a9afb7', { p: [0, 0.18, 0], k: 'metal' }),
    ];
    for (let i = 0; i < 7; i++) {
      const t = -0.45 + i * 0.15;
      for (const s of [-1, 1]) {
        parts.push(P(box(0.3, 0.02, 0.05, 0.005), GOLD, { p: [s * 0.68, 0.06, t], k: 'metal' }));
        parts.push(P(box(0.05, 0.02, 0.3, 0.005), GOLD, { p: [t, 0.06, s * 0.68], k: 'metal' }));
      }
    }
    return parts;
  },
  gear: (c = STEEL) => [P(extrudeGeometry(gearShape(), 0.26), c, { k: 'metal' }), P(ring(0.22, 0.035), DARK, { k: 'metal', p: [0, 0, 0.13] })],
  battery: (c = '#54c06e') => [
    P(cyl(0.34, 0.34, 1.3), DARK, { p: [0, 0.65, 0], k: 'metal' }),
    P(cyl(0.345, 0.345, 0.75), c, { p: [0, 0.42, 0] }),
    P(cyl(0.13, 0.13, 0.1), STEEL, { p: [0, 1.35, 0], k: 'metal' }),
  ],
  lightbulb: (c = '#ffd95a') => [
    P(latheGeometry([[0.16, 0.4], [0.2, 0.62], [0.42, 0.95], [0.42, 1.25], [0.24, 1.53], [0, 1.6]]), c, { k: 'glass' }),
    P(ball(0.12), c, { p: [0, 1.08, 0], k: 'glow' }),
    P(cyl(0.012, 0.012, 0.5), DARK, { p: [-0.05, 0.75, 0] }),
    P(cyl(0.012, 0.012, 0.5), DARK, { p: [0.05, 0.75, 0] }),
    ...[0.1, 0.18, 0.26, 0.34].map((y) => P(ring(0.16, 0.022), '#a9afb7', { p: [0, y, 0], r: [90, 0, 0], k: 'metal' })),
    P(cyl(0.16, 0.08, 0.36), '#a9afb7', { p: [0, 0.2, 0], k: 'metal' }),
  ],
  atom: (c = RED) => [
    ...[[0.1, 0.05, 0, c], [-0.08, 0.08, 0.05, BLUE], [0, -0.1, 0.08, c], [0.05, 0, -0.11, BLUE], [-0.08, -0.06, -0.06, c]].map(([x, y, z, col]) =>
      P(ball(0.13), col as string, { p: [x as number, y as number, z as number] })
    ),
    ...[[90, 0, 0], [90, 60, 0], [90, -60, 0]].map((r) => P(ring(0.95, 0.012), '#8d939b', { r: r as V3, k: 'metal' })),
    P(ball(0.07), '#ffd95a', { p: [0.95, 0, 0], k: 'glow' }),
    P(ball(0.07), '#ffd95a', { p: [-0.475, 0, 0.823], k: 'glow' }),
    P(ball(0.07), '#ffd95a', { p: [-0.475, 0, -0.823], k: 'glow' }),
  ],
  dna: (c = BLUE) => {
    const a: number[][] = [];
    const b: number[][] = [];
    const parts: THREE.Object3D[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const angle = t * Math.PI * 4;
      const y = t * 2.6;
      const pa: V3 = [Math.cos(angle) * 0.45, y, Math.sin(angle) * 0.45];
      const pb: V3 = [-pa[0], y, -pa[2]];
      a.push(pa);
      b.push(pb);
      if (i % 2 === 1) parts.push(rod(pa, pb, 0.022, i % 4 === 1 ? '#f08a24' : '#54c06e'));
    }
    parts.push(P(tubeGeometry(a, 0.05), c), P(tubeGeometry(b, 0.05), RED));
    return parts;
  },
  molecule: (c = RED) => {
    const atoms: [V3, number, string][] = [
      [[0, 0.8, 0], 0.32, DARK], [[0.75, 0.3, 0.1], 0.26, c], [[-0.75, 0.3, -0.1], 0.26, c],
      [[0.1, 1.5, 0.45], 0.2, WHITE], [[-0.25, 1.35, -0.55], 0.2, WHITE], [[1.25, 0.65, -0.3], 0.18, WHITE],
    ];
    const bonds: [number, number][] = [[0, 1], [0, 2], [0, 3], [0, 4], [1, 5]];
    return [
      ...bonds.map(([i, j]) => rod(atoms[i][0], atoms[j][0], 0.05, '#c9c5bb')),
      ...atoms.map(([p, r, col]) => P(ball(r), col, { p })),
    ];
  },
  telescope: (c = '#eef1f4') => [
    P(cyl(0.16, 0.11, 1.5), c, { p: [0, 1.25, 0], r: [0, 0, -52] }),
    P(cyl(0.18, 0.18, 0.08), DARK, { p: [0.6, 1.72, 0], r: [0, 0, -52], k: 'metal' }),
    P(cyl(0.06, 0.06, 0.2), DARK, { p: [-0.65, 0.74, 0], r: [0, 0, -52], k: 'metal' }),
    P(ball(0.09), DARK, { p: [0, 1.2, 0], k: 'metal' }),
    rod([0, 1.2, 0], [0.55, 0, 0.3], 0.025, DARK, 'metal'),
    rod([0, 1.2, 0], [-0.55, 0, 0.3], 0.025, DARK, 'metal'),
    rod([0, 1.2, 0], [0, 0, -0.6], 0.025, DARK, 'metal'),
  ],
  microphone: (c = STEEL) => [
    P(ball(0.28), c, { p: [0, 1.5, 0], k: 'metal' }),
    P(cyl(0.285, 0.285, 0.05), DARK, { p: [0, 1.36, 0], k: 'metal' }),
    P(cyl(0.13, 0.09, 0.7), DARK, { p: [0, 1, 0] }),
    P(cyl(0.03, 0.03, 0.5), STEEL, { p: [0, 0.4, 0], k: 'metal' }),
    P(cyl(0.34, 0.38, 0.1), DARK, { p: [0, 0.05, 0], k: 'metal' }),
  ],
  camera: (c = '#34353a') => [
    P(box(1.2, 0.74, 0.46, 0.06), c, { p: [0, 0.37, 0] }),
    P(box(0.34, 0.14, 0.3, 0.03), c, { p: [-0.26, 0.8, 0] }),
    P(cyl(0.3, 0.32, 0.36), '#1d1d21', { p: [0.06, 0.37, 0.4], r: [90, 0, 0], k: 'metal' }),
    P(cyl(0.21, 0.21, 0.02), '#5a7fa8', { p: [0.06, 0.37, 0.59], r: [90, 0, 0] }),
    P(ball(0.05), RED, { p: [0.45, 0.67, 0.2], k: 'glow' }),
  ],

  // everyday things and symbols
  book: (c = '#b5533c') => [
    P(box(1.05, 0.24, 1.42, 0.015), c, { p: [0, 0.12, 0] }),
    P(box(1.0, 0.19, 1.36, 0.005), WHITE, { p: [0.04, 0.12, 0], k: 'matte' }),
    P(box(0.08, 0.24, 1.42, 0.03), c, { p: [-0.5, 0.12, 0] }),
  ],
  open_book: (c = '#b5533c') => [
    P(box(1.05, 0.1, 1.4, 0.015), WHITE, { p: [-0.53, 0.12, 0], r: [0, 0, -7], k: 'matte' }),
    P(box(1.05, 0.1, 1.4, 0.015), WHITE, { p: [0.53, 0.12, 0], r: [0, 0, 7], k: 'matte' }),
    P(box(2.2, 0.03, 1.48, 0.01), c, { p: [0, 0.03, 0] }),
    ...[-0.4, -0.2, 0, 0.2, 0.4].flatMap((z) => [
      P(box(0.72, 0.004, 0.05, 0.001), '#8d897e', { p: [-0.53, 0.178, z], r: [0, 0, -7] }),
      P(box(0.72, 0.004, 0.05, 0.001), '#8d897e', { p: [0.53, 0.178, z], r: [0, 0, 7] }),
    ]),
  ],
  document: (c = '#f6f4ee') => [
    P(box(0.9, 1.2, 0.025, 0.005), c, { p: [0, 0.6, 0], k: 'matte' }),
    P(box(0.5, 0.06, 0.006, 0.002), BLUE, { p: [-0.1, 1.04, 0.015] }),
    ...[0.86, 0.72, 0.58, 0.44, 0.3].map((y, i) => P(box(i === 4 ? 0.4 : 0.68, 0.035, 0.005, 0.002), '#8d897e', { p: [i === 4 ? -0.14 : 0, y, 0.015] })),
  ],
  pencil: (c = '#e8b63e') => [
    P(cyl(0.07, 0.07, 1.3, 6), c, { p: [0, 0.65, 0] }),
    P(cone(0.07, 0.2, 6), '#e6c9a0', { p: [0, 1.4, 0], k: 'wood' }),
    P(cone(0.024, 0.07, 12), DARK, { p: [0, 1.47, 0] }),
    P(cyl(0.074, 0.074, 0.08), STEEL, { p: [0, 0, 0], k: 'metal' }),
    P(cyl(0.07, 0.07, 0.13), '#e58a97', { p: [0, -0.1, 0], k: 'rubber' }),
  ],
  coin: (c = GOLD) => [
    P(cyl(0.6, 0.6, 0.1, 48), c, { p: [0, 0.6, 0], r: [90, 0, 0], k: 'metal' }),
    P(ring(0.5, 0.025), c, { p: [0, 0.6, 0.05], k: 'metal' }),
    P(ring(0.5, 0.025), c, { p: [0, 0.6, -0.05], k: 'metal' }),
    P(box(0.09, 0.42, 0.02, 0.01), '#c9982a', { p: [0, 0.6, 0.055], k: 'metal' }),
  ],
  coins: (c = GOLD) => {
    const stacks: [number, number, number][] = [[0, 0, 8], [0.75, 0.15, 5], [-0.2, 0.75, 3]];
    return stacks.flatMap(([x, z, n]) =>
      Array.from({ length: n }, (_, i) => P(cyl(0.35, 0.35, 0.09, 40), c, { p: [x + Math.sin(i * 2) * 0.02, 0.05 + i * 0.095, z + Math.cos(i * 3) * 0.02], k: 'metal' }))
    );
  },
  key: (c = GOLD) => [
    P(ring(0.26, 0.07), c, { p: [0, 1.25, 0], k: 'metal' }),
    P(cyl(0.05, 0.05, 1), c, { p: [0, 0.5, 0], k: 'metal' }),
    P(box(0.24, 0.08, 0.05, 0.01), c, { p: [0.14, 0.1, 0], k: 'metal' }),
    P(box(0.18, 0.08, 0.05, 0.01), c, { p: [0.11, 0.28, 0], k: 'metal' }),
  ],
  lock: (c = GOLD) => [
    P(new THREE.TorusGeometry(0.27, 0.055, 14, 32, Math.PI), STEEL, { p: [0, 0.82, 0], k: 'metal' }),
    P(cyl(0.055, 0.055, 0.2), STEEL, { p: [-0.27, 0.74, 0], k: 'metal' }),
    P(cyl(0.055, 0.055, 0.2), STEEL, { p: [0.27, 0.74, 0], k: 'metal' }),
    P(box(0.9, 0.72, 0.32, 0.07), c, { p: [0, 0.36, 0], k: 'metal' }),
    P(cyl(0.07, 0.07, 0.02), '#2a2415', { p: [0, 0.42, 0.165], r: [90, 0, 0] }),
    P(box(0.05, 0.16, 0.02, 0.005), '#2a2415', { p: [0, 0.31, 0.165] }),
  ],
  shield: (c = '#3f6fb5') => [
    P(extrudeGeometry(shieldShape(), 0.14), STEEL, { k: 'metal' }),
    P(extrudeGeometry(shieldShape(0.82), 0.04), c, { p: [0, 0, 0.1] }),
    P(box(0.16, 1.2, 0.03, 0.01), GOLD, { p: [0, -0.04, 0.14], k: 'metal' }),
    P(box(0.92, 0.16, 0.03, 0.01), GOLD, { p: [0, 0.22, 0.14], k: 'metal' }),
  ],
  sword: (c = '#d5dae0') => [
    P(extrudeGeometry([[-0.07, 0], [0.07, 0], [0.07, 1.5], [0, 1.72], [-0.07, 1.5]], 0.02), c, { p: [0, 0.42, 0], k: 'metal' }),
    P(box(0.56, 0.07, 0.1, 0.03), GOLD, { p: [0, 0.4, 0], k: 'metal' }),
    P(cyl(0.04, 0.04, 0.32), '#5c3b22', { p: [0, 0.22, 0], k: 'rubber' }),
    P(ball(0.07), GOLD, { p: [0, 0.04, 0], k: 'metal' }),
  ],
  crown: (c = GOLD) => {
    const parts: THREE.Object3D[] = [
      P(new THREE.CylinderGeometry(0.72, 0.62, 0.36, 48, 1, true), c, { p: [0, 0.18, 0], k: 'metal' }),
      P(ring(0.62, 0.035), c, { p: [0, 0.01, 0], r: [90, 0, 0], k: 'metal' }),
    ];
    (parts[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material.side = THREE.DoubleSide;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const x = Math.cos(a);
      const z = Math.sin(a);
      parts.push(P(cone(0.13, 0.4), c, { p: [x * 0.72, 0.52, z * 0.72], r: [z * 8, 0, -x * 8], k: 'metal' }));
      parts.push(P(ball(0.05), i % 2 ? RED : BLUE, { p: [x * 0.73, 0.75, z * 0.73] }));
      parts.push(P(ball(0.045), i % 2 ? BLUE : RED, { p: [Math.cos(a + 0.39) * 0.68, 0.18, Math.sin(a + 0.39) * 0.68] }));
    }
    return parts;
  },
  trophy: (c = GOLD) => [
    P(box(0.7, 0.14, 0.7, 0.02), '#4a3323', { p: [0, 0.07, 0], k: 'wood' }),
    P(latheGeometry([[0.26, 0.14], [0.06, 0.26], [0.06, 0.62], [0.1, 0.72], [0.38, 1.02], [0.42, 1.5]]), c, { k: 'metal' }),
    P(ring(0.2, 0.035), c, { p: [-0.42, 1.2, 0], s: [0.8, 1, 1], k: 'metal' }),
    P(ring(0.2, 0.035), c, { p: [0.42, 1.2, 0], s: [0.8, 1, 1], k: 'metal' }),
  ],
  medal: (c = GOLD) => [
    P(extrudeGeometry([[-0.2, 1.7], [-0.03, 1.7], [0.08, 0.92], [-0.08, 0.92]], 0.02), RED),
    P(extrudeGeometry([[0.2, 1.7], [0.03, 1.7], [-0.08, 0.92], [0.08, 0.92]], 0.02), BLUE, { p: [0, 0, 0.02] }),
    P(cyl(0.45, 0.45, 0.08, 48), c, { p: [0, 0.5, 0], r: [90, 0, 0], k: 'metal' }),
    P(ring(0.36, 0.02), '#c9982a', { p: [0, 0.5, 0.05], k: 'metal' }),
  ],
  target: (c = RED) => [
    P(cyl(0.8, 0.8, 0.06, 48), c, { p: [0, 1.1, 0], r: [90, 0, 0] }),
    P(cyl(0.6, 0.6, 0.02, 48), WHITE, { p: [0, 1.1, 0.04], r: [90, 0, 0] }),
    P(cyl(0.4, 0.4, 0.02, 48), c, { p: [0, 1.1, 0.055], r: [90, 0, 0] }),
    P(cyl(0.2, 0.2, 0.02, 48), '#f6c343', { p: [0, 1.1, 0.07], r: [90, 0, 0] }),
    rod([0, 1.1, 0.05], [0.28, 1.28, 0.75], 0.018, WOODY),
    P(cone(0.08, 0.16), '#eef1f4', { p: [0.3, 1.29, 0.8], r: [62, 0, -20] }),
    rod([-0.25, 1, -0.05], [-0.55, 0, 0.1], 0.03, WOODY, 'wood'),
    rod([0.25, 1, -0.05], [0.55, 0, 0.1], 0.03, WOODY, 'wood'),
    rod([0, 1, -0.05], [0, 0, -0.5], 0.03, WOODY, 'wood'),
  ],
  clock: (c = '#3f4249') => [
    P(cyl(0.8, 0.8, 0.14, 64), c, { r: [90, 0, 0], k: 'metal' }),
    P(cyl(0.72, 0.72, 0.02, 64), WHITE, { p: [0, 0, 0.07], r: [90, 0, 0], k: 'matte' }),
    ...Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2;
      return P(box(0.03, i % 3 ? 0.06 : 0.12, 0.01, 0.003), DARK, { p: [Math.sin(a) * 0.62, Math.cos(a) * 0.62, 0.09], r: [0, 0, (-a * 180) / Math.PI] });
    }),
    P(box(0.045, 0.36, 0.015, 0.005), DARK, { p: [-0.12, 0.13, 0.095], r: [0, 0, 42] }),
    P(box(0.03, 0.52, 0.015, 0.005), RED, { p: [0.17, 0.17, 0.11], r: [0, 0, -45] }),
    P(cyl(0.05, 0.05, 0.03), DARK, { p: [0, 0, 0.11], r: [90, 0, 0] }),
  ],
  hourglass: (c = '#e3b341') => [
    P(cyl(0.5, 0.5, 0.08), WOODY, { p: [0, 0.04, 0], k: 'wood' }),
    P(cyl(0.5, 0.5, 0.08), WOODY, { p: [0, 1.76, 0], k: 'wood' }),
    P(latheGeometry([[0, 0.08], [0.4, 0.1], [0.42, 0.42], [0.06, 0.9], [0.42, 1.38], [0.4, 1.7], [0, 1.72]]), GLASS, { k: 'glass' }),
    P(cone(0.32, 0.36), c, { p: [0, 0.27, 0], k: 'matte' }),
    P(cone(0.26, 0.34), c, { p: [0, 1.08, 0], r: [180, 0, 0], k: 'matte' }),
    ...[[-0.44, 0.44], [0.44, 0.44], [0, -0.44]].map(([x, z]) => P(cyl(0.025, 0.025, 1.68), WOODY, { p: [x, 0.9, z], k: 'wood' })),
  ],
  calendar: (c = RED) => {
    const parts: THREE.Object3D[] = [
      P(box(1.2, 1.2, 0.08, 0.02), WHITE, { p: [0, 0.6, 0], k: 'matte' }),
      P(box(1.2, 0.3, 0.1, 0.02), c, { p: [0, 1.05, 0] }),
      P(ring(0.06, 0.012), STEEL, { p: [-0.32, 1.22, 0], r: [0, 90, 0], k: 'metal' }),
      P(ring(0.06, 0.012), STEEL, { p: [0.32, 1.22, 0], r: [0, 90, 0], k: 'metal' }),
    ];
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 5; col++) {
        const today = row === 1 && col === 3;
        parts.push(P(box(0.14, 0.13, 0.01, 0.003), today ? c : '#c9c5bb', { p: [-0.4 + col * 0.2, 0.74 - row * 0.19, 0.045] }));
      }
    }
    return parts;
  },
  magnifier: (c = '#3f4249') => [
    P(ring(0.5, 0.05), c, { p: [0, 1.1, 0], k: 'metal' }),
    P(cyl(0.48, 0.48, 0.02, 48), GLASS, { p: [0, 1.1, 0], r: [90, 0, 0], k: 'glass' }),
    P(cyl(0.05, 0.065, 0.7), WOODY, { p: [0.55, 0.3, 0], r: [0, 0, 39], k: 'wood' }),
  ],
  envelope: (c = '#f3ecd9') => [
    P(box(1.5, 1, 0.08, 0.02), c, { p: [0, 0.5, 0], k: 'matte' }),
    P(extrudeGeometry([[-0.72, 0.98], [0.72, 0.98], [0, 0.4]], 0.01), '#e3d9bf', { p: [0, 0, 0.05], k: 'matte' }),
    P(cyl(0.09, 0.09, 0.02), RED, { p: [0, 0.46, 0.07], r: [90, 0, 0] }),
  ],
  chair: (c = WOODY) => [
    P(box(0.8, 0.08, 0.8, 0.02), c, { p: [0, 0.7, 0], k: 'wood' }),
    P(box(0.8, 0.72, 0.07, 0.02), c, { p: [0, 1.1, -0.37], k: 'wood' }),
    ...[[-0.33, -0.33], [0.33, -0.33], [-0.33, 0.33], [0.33, 0.33]].map(([x, z]) => P(cyl(0.035, 0.03, 0.7), c, { p: [x, 0.35, z], k: 'wood' })),
  ],
  table: (c = WOODY) => [
    P(box(2, 0.08, 1.1, 0.02), c, { p: [0, 0.82, 0], k: 'wood' }),
    ...[[-0.88, -0.45], [0.88, -0.45], [-0.88, 0.45], [0.88, 0.45]].map(([x, z]) => P(cyl(0.04, 0.03, 0.8), c, { p: [x, 0.4, z], k: 'wood' })),
  ],
  scales: (c = GOLD) => [
    P(cyl(0.4, 0.46, 0.1), c, { p: [0, 0.05, 0], k: 'metal' }),
    P(cyl(0.035, 0.05, 1.6), c, { p: [0, 0.9, 0], k: 'metal' }),
    P(ball(0.07), c, { p: [0, 1.7, 0], k: 'metal' }),
    rod([-0.9, 1.6, 0], [0.9, 1.6, 0], 0.024, c, 'metal'),
    ...[-0.9, 0.9].flatMap((x) => [
      rod([x, 1.6, 0], [x - 0.26, 0.9, 0], 0.006, DARK),
      rod([x, 1.6, 0], [x + 0.26, 0.9, 0], 0.006, DARK),
      P(new THREE.SphereGeometry(0.32, 32, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), c, { p: [x, 0.92, 0], s: [1, 0.35, 1], k: 'metal' }),
    ]),
  ],
  hammer: (c = STEEL) => [
    P(cyl(0.05, 0.06, 1.5), WOODY, { p: [0, 0.75, 0], k: 'wood' }),
    P(box(0.72, 0.24, 0.24, 0.03), c, { p: [0, 1.5, 0], k: 'metal' }),
  ],
  compass: (c = GOLD) => [
    P(cyl(0.8, 0.8, 0.14, 64), c, { r: [90, 0, 0], k: 'metal' }),
    P(cyl(0.7, 0.7, 0.02, 64), WHITE, { p: [0, 0, 0.07], r: [90, 0, 0], k: 'matte' }),
    P(extrudeGeometry([[-0.08, 0], [0.08, 0], [0, 0.58]], 0.015), RED, { p: [0, 0, 0.1], r: [0, 0, -28] }),
    P(extrudeGeometry([[-0.08, 0], [0.08, 0], [0, -0.58]], 0.015), STEEL, { p: [0, 0, 0.1], r: [0, 0, -28] }),
    P(cyl(0.05, 0.05, 0.03), DARK, { p: [0, 0, 0.12], r: [90, 0, 0] }),
    P(ring(0.11, 0.025), c, { p: [0, 0.92, 0], k: 'metal' }),
  ],
  gift: (c = '#d9504a') => [
    P(box(1.1, 0.8, 1.1, 0.03), c, { p: [0, 0.4, 0] }),
    P(box(1.2, 0.2, 1.2, 0.03), c, { p: [0, 0.9, 0] }),
    P(box(0.2, 1.01, 1.13, 0.01), GOLD, { p: [0, 0.5, 0] }),
    P(box(1.13, 1.01, 0.2, 0.01), GOLD, { p: [0, 0.5, 0] }),
    P(ring(0.17, 0.045), GOLD, { p: [-0.17, 1.14, 0], r: [0, 0, 20] }),
    P(ring(0.17, 0.045), GOLD, { p: [0.17, 1.14, 0], r: [0, 0, -20] }),
  ],
  speech_bubble: (c = '#f4f6f8') => [
    P(extrudeGeometry(bubbleShape(), 0.16), c),
    ...[-0.4, 0, 0.4].map((x) => P(ball(0.095), '#5b6068', { p: [x, 0, 0.14], s: [1, 1, 0.4] })),
  ],
  chart_bars: (c = BLUE) => [
    P(box(2, 0.05, 0.7, 0.01), DARK, { p: [0, 0.025, 0] }),
    ...[0.4, 0.75, 1.15, 1.7].map((h, i) => P(box(0.34, h, 0.4, 0.03), c, { p: [-0.66 + i * 0.44, 0.05 + h / 2, 0] })),
  ],
  big_arrow: (c = '#54c06e') => [
    P(extrudeGeometry([[-0.22, 0], [0.22, 0], [0.22, 0.9], [0.55, 0.9], [0, 1.6], [-0.55, 0.9], [-0.22, 0.9]], 0.2), c),
  ],
};

export const MODEL_NAMES = Object.keys(KIT);

/**
 * A ready-made object whose largest side is `size` units, standing on y = 0 and centred on x and z.
 * Unknown names give a plain crate, so one odd name doesn't lose the whole scene.
 */
export function buildModel(name: string | undefined, size: number, color?: string): THREE.Group {
  const key = (name ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const make = KIT[key] ?? (() => [P(box(1, 1, 1), color ?? '#c9b79c', { k: 'wood' })]);
  const inner = new THREE.Group();
  inner.add(...make(color));
  inner.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(inner);
  const dims = bounds.getSize(new THREE.Vector3());
  const scale = size / Math.max(dims.x, dims.y, dims.z, 1e-3);
  const center = bounds.getCenter(new THREE.Vector3());
  inner.scale.setScalar(scale);
  inner.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
  const outer = new THREE.Group();
  outer.add(inner);
  return outer;
}
