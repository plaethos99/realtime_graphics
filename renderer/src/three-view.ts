import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { setRichText } from './math';
import { buildModel, extrudeGeometry, latheGeometry, materialFor, roundedBox, tubeGeometry } from './models';
import { colorOf } from './theme';
import type { Arrow3D, Obj3D, ThreePanel, Vec3 } from './types';

const DEG = Math.PI / 180;
const INK = 0x2b2a28;

export interface ThreeView {
  dispose(): void;
}

export function vec(v: Vec3 | undefined, fallback: Vec3 = [0, 0, 0]): THREE.Vector3 {
  const a = Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v : fallback;
  return new THREE.Vector3(a[0], a[1], a[2]);
}

function num(v: number | undefined, fallback: number, min = 0.001): number {
  return Number.isFinite(v) ? Math.max(min, v as number) : fallback;
}

function geometryFor(obj: Obj3D): THREE.BufferGeometry {
  const s = obj.size ?? [];
  const points = obj.points ?? [];
  switch (obj.shape) {
    case 'sphere':
      return new THREE.SphereGeometry(num(s[0], 0.5), 32, 20);
    case 'cylinder':
      // [rTop, rBottom, h] or [r, h]
      return s.length === 2
        ? new THREE.CylinderGeometry(num(s[0], 0.5), num(s[0], 0.5), num(s[1], 1), 32)
        : new THREE.CylinderGeometry(num(s[0], 0.5), num(s[1], num(s[0], 0.5)), num(s[2], 1), 32);
    case 'cone':
      return new THREE.ConeGeometry(num(s[0], 0.5), num(s[1], 1), 32);
    case 'torus':
      return new THREE.TorusGeometry(num(s[0], 0.5), num(s[1], 0.15), 16, 48);
    case 'capsule':
      return new THREE.CapsuleGeometry(num(s[0], 0.3), num(s[1], 1), 6, 20);
    case 'plane':
      return new THREE.PlaneGeometry(num(s[0], 1), num(s[1], 1));
    case 'lathe':
      return latheGeometry(points) ?? new THREE.SphereGeometry(0.5, 32, 20);
    case 'extrude':
      return extrudeGeometry(points, num(s[0], 0.2)) ?? roundedBox(1, 1, 0.2);
    case 'tube':
      return tubeGeometry(points, num(s[0], 0.1)) ?? new THREE.CapsuleGeometry(0.1, 1, 6, 20);
    case 'box':
    default:
      return roundedBox(num(s[0], 1), num(s[1], s[0] ?? 1), num(s[2], s[0] ?? 1));
  }
}

function objectFor(obj: Obj3D): THREE.Object3D {
  const opacity = Number.isFinite(obj.opacity) ? Math.min(1, Math.max(0.05, obj.opacity as number)) : 1;
  let node: THREE.Object3D;
  if (obj.shape === 'model') {
    node = buildModel(obj.model, num(obj.size?.[0], 2), obj.color ? colorOf(obj.color).solid : undefined);
    if (opacity < 0.99) {
      node.traverse((o) => {
        const material = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!material) return;
        material.transparent = true;
        material.opacity = Math.min(material.opacity, opacity);
        material.depthWrite = false;
      });
    }
  } else {
    const material = materialFor(colorOf(obj.color, 'gray').solid, obj.material, opacity);
    if (obj.shape === 'plane' || obj.shape === 'tube') material.side = THREE.DoubleSide;
    node = new THREE.Mesh(geometryFor(obj), material);
  }
  node.position.copy(vec(obj.position));
  const r = vec(obj.rotation);
  node.rotation.set(r.x * DEG, r.y * DEG, r.z * DEG);
  if (obj.scale) node.scale.copy(vec(obj.scale, [1, 1, 1]));
  if (opacity < 0.99) node.renderOrder = 1;
  return node;
}

export function arrowFor(a: Arrow3D): THREE.Group | null {
  const from = vec(a.from);
  const to = vec(a.to);
  const dir = to.clone().sub(from);
  const length = dir.length();
  if (length < 1e-3) return null;
  dir.normalize();
  const color = colorOf(a.color, 'red').solid;
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.4 });
  const head = Math.min(0.35, length * 0.35);
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, length - head, 12), material);
  shaft.position.copy(from.clone().addScaledVector(dir, (length - head) / 2));
  shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.11, head, 16), material);
  tip.position.copy(to.clone().addScaledVector(dir, -head / 2));
  tip.quaternion.copy(shaft.quaternion);
  group.add(shaft, tip);
  return group;
}

export function tag(text: string, kind: 'part' | 'arrow' | 'axis', color?: string): CSS2DObject {
  // CSS2DRenderer owns the outer element's transform; the inner one can be nudged to avoid overlaps.
  const anchor = document.createElement('div');
  const el = document.createElement('div');
  el.className = `rtg-tag3d rtg-tag3d-${kind}`;
  setRichText(el, text);
  if (color) el.style.setProperty('--tag', color);
  anchor.appendChild(el);
  return new CSS2DObject(anchor);
}

/** Keep labels inside the view and push overlapping ones apart vertically (screen space), top to bottom. */
function declutter(tags: HTMLElement[], host: HTMLElement): void {
  const frame = host.getBoundingClientRect();
  const scale = frame.width / Math.max(1, host.clientWidth) || 1;
  for (const t of tags) t.style.translate = '';
  const items = tags
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0)
    .sort((a, b) => a.r.top - b.r.top);
  const placed: { l: number; r: number; t: number; b: number }[] = [];
  for (const { el, r } of items) {
    const dx = r.right > frame.right - 4 ? frame.right - 4 - r.right : r.left < frame.left + 4 ? frame.left + 4 - r.left : 0;
    const left = r.left + dx;
    const right = r.right + dx;
    let dy = 0;
    for (let pass = 0; pass < items.length; pass++) {
      const hit = placed.find((p) => left < p.r && right > p.l && r.top + dy < p.b && r.bottom + dy > p.t);
      if (!hit) break;
      dy = hit.b - r.top + 2;
    }
    if (dx || dy) el.style.translate = `${dx / scale}px ${dy / scale}px`;
    placed.push({ l: left, r: right, t: r.top + dy, b: r.bottom + dy });
  }
}

function easeOutBack(t: number): number {
  const c = 1.5;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
}

export interface StageStart {
  camera?: { position?: Vec3; target?: Vec3 };
  autoRotate?: boolean;
  /** Below 1 moves the default camera closer than "fit everything" (default 0.95). */
  zoom?: number;
  /** Called every frame with the seconds since the last one. */
  onFrame?: (dt: number) => void;
  /** Soft shadows on an invisible floor under the content, for standalone objects. */
  floor?: boolean;
}

export interface Stage {
  /** Everything shown goes in here; the camera frames its bounds. */
  content: THREE.Group;
  start(options?: StageStart): ThreeView;
}

/** Renderer, lights, labels, orbit controls, pop-in animation and cleanup shared by the 3D panels. */
export function createStage(host: HTMLElement, animate: boolean, realistic = false): Stage | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    host.classList.add('rtg-3d-fallback');
    host.textContent = '3D view needs WebGL, which is not available here.';
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = 'rtg-3d-labels';
  host.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  let environment: THREE.WebGLRenderTarget | undefined;
  const sun = new THREE.DirectionalLight(0xffffff, realistic ? 2.1 : 1.9);
  sun.position.set(5, 8, 6);
  scene.add(sun);
  if (realistic) {
    // Image-based light gives metal and glass something to reflect; tone mapping keeps highlights from clipping.
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const pmrem = new THREE.PMREMGenerator(renderer);
    environment = pmrem.fromScene(new RoomEnvironment(), 0.04);
    pmrem.dispose();
    scene.environment = environment.texture;
    scene.environmentIntensity = 0.75;
  } else {
    scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d2c3, 1.7));
  }

  const content = new THREE.Group();
  scene.add(content);

  const start = (options: StageStart = {}): ThreeView => {
    // Camera: use the given one if any, otherwise frame everything.
    content.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(content);
    const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
    const radius = bounds.isEmpty() ? 3 : Math.max(0.5, bounds.getSize(new THREE.Vector3()).length() / 2);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.05, radius * 40);
    const target = options.camera?.target ? vec(options.camera.target) : center;
    if (options.camera?.position) {
      camera.position.copy(vec(options.camera.position));
    } else {
      const distance = radius / Math.sin((camera.fov / 2) * DEG);
      camera.position.copy(center).add(new THREE.Vector3(1, 0.55, 1.3).normalize().multiplyScalar(distance * (options.zoom ?? 0.95)));
    }
    camera.lookAt(target);

    if (options.floor && !bounds.isEmpty()) {
      const floor = new THREE.Mesh(new THREE.CircleGeometry(radius * 4, 48), new THREE.ShadowMaterial({ opacity: 0.26 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(center.x, bounds.min.y - 0.005, center.z);
      floor.receiveShadow = true;
      scene.add(floor);
      sun.castShadow = true;
      sun.position.copy(center).add(new THREE.Vector3(0.5, 1.1, 0.65).multiplyScalar(radius * 2.5));
      sun.target.position.copy(center);
      scene.add(sun.target);
      const shadow = sun.shadow.camera;
      shadow.left = shadow.bottom = -radius * 1.8;
      shadow.right = shadow.top = radius * 1.8;
      shadow.near = 0.1;
      shadow.far = radius * 8;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.02;
      sun.shadow.radius = 5;
      content.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const opaque = !(mesh.material as THREE.Material).transparent;
        mesh.castShadow = opaque;
        mesh.receiveShadow = opaque;
      });
    }

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.autoRotate = options.autoRotate ?? true;
    controls.autoRotateSpeed = 1.1;
    const stopAutoRotate = () => (controls.autoRotate = false);
    controls.addEventListener('start', stopAutoRotate);

    // Pop-in: top-level parts grow into place one after another.
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const pops = animate && !reduceMotion
      ? content.children
          .filter((o) => !(o instanceof CSS2DObject) && !o.userData.noPop)
          .map((obj, i) => ({ obj, target: obj.scale.clone(), delay: i * 45 }))
      : [];
    for (const p of pops) p.obj.scale.setScalar(1e-4);
    if (animate) host.classList.add('rtg-3d-animate');

    const resize = () => {
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      labelRenderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    let tags: HTMLElement[] = []; // filled after the first render, when CSS2DRenderer has inserted them
    const clock = new THREE.Clock();
    const started = performance.now();
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.1);
      const elapsed = performance.now() - started;
      for (const p of pops) {
        const t = Math.min(1, Math.max(0, (elapsed - p.delay) / 420));
        p.obj.scale.copy(p.target).multiplyScalar(Math.max(1e-4, easeOutBack(t)));
      }
      if (!reduceMotion) options.onFrame?.(dt);
      controls.update(dt);
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
      if (frame % 8 === 0) {
        if (!tags.length) tags = [...labelRenderer.domElement.querySelectorAll<HTMLElement>('.rtg-tag3d')];
        declutter(tags, host);
      }
    };
    tick();

    return {
      dispose() {
        cancelAnimationFrame(frame);
        observer.disconnect();
        controls.removeEventListener('start', stopAutoRotate);
        controls.dispose();
        scene.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose();
          const mat = m.material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined;
          (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => {
            x.map?.dispose();
            x.dispose();
          });
        });
        environment?.dispose();
        renderer.dispose();
        host.replaceChildren();
      },
    };
  };
  return { content, start };
}

export function createThreeView(host: HTMLElement, panel: ThreePanel, animate: boolean): ThreeView {
  const stage = createStage(host, animate, true);
  if (!stage) return { dispose: () => host.replaceChildren() };
  const { content } = stage;

  // Build meshes, then attach children to parents so ids can appear in any order.
  const byId = new Map<string, THREE.Object3D>();
  const spinners: { obj: THREE.Object3D; axis: 'x' | 'y' | 'z'; speed: number }[] = [];
  const meshes = (panel.objects ?? []).map((obj) => {
    const mesh = objectFor(obj);
    if (obj.id) byId.set(obj.id, mesh);
    if (obj.spin) spinners.push({ obj: mesh, axis: obj.spin.axis ?? 'y', speed: num(obj.spin.speed, 1, -50) });
    return { obj, mesh };
  });
  for (const { obj, mesh } of meshes) {
    const parent = obj.parent ? byId.get(obj.parent) : undefined;
    (parent && parent !== mesh ? parent : content).add(mesh);
  }
  for (const a of panel.arrows ?? []) {
    const arrow = arrowFor(a);
    if (!arrow) continue;
    content.add(arrow);
    if (a.label) {
      const label = tag(a.label, 'arrow', colorOf(a.color, 'red').stroke);
      const dir = vec(a.to).sub(vec(a.from)).normalize();
      label.position.copy(vec(a.to).addScaledVector(dir, 0.3));
      content.add(label);
    }
  }

  content.updateMatrixWorld(true);
  for (const l of panel.labels ?? []) {
    const target = typeof l.at === 'string' ? byId.get(l.at) : undefined;
    // Ready-made objects stand on their position, so aim a label at the middle of the thing.
    const anchor = target ? new THREE.Box3().setFromObject(target).getCenter(new THREE.Vector3()) : Array.isArray(l.at) ? vec(l.at) : undefined;
    if (!anchor) continue;
    content.add(...leaderLabel(l.text, anchor, anchor.clone().add(vec(l.offset, [0, 0.7, 0]))));
  }

  return stage.start({
    camera: panel.camera,
    autoRotate: panel.autoRotate,
    floor: true,
    zoom: 0.68,
    onFrame: (dt) => {
      for (const s of spinners) s.obj.rotation[s.axis] += s.speed * dt;
    },
  });
}

/** A tag at `pos` joined to `anchor` by a thin leader line with a dot on the anchor. */
export function leaderLabel(text: string, anchor: THREE.Vector3, pos: THREE.Vector3): THREE.Object3D[] {
  const leader = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([anchor, pos]),
    new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.7 }),
  );
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshBasicMaterial({ color: INK }));
  dot.position.copy(anchor);
  const label = tag(text, 'part');
  label.position.copy(pos);
  return [leader, dot, label];
}
