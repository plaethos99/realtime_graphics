import { createOverlay, ProxyClient, SpeechQueue, type Scene, type Turn } from '../src/index';
import f35 from '../../shared/examples/f35.json';
import habits from '../../shared/examples/habits_3d.json';
import integral from '../../shared/examples/integral.json';
import piCamera from '../../shared/examples/pi_camera.json';
import quadratic from '../../shared/examples/quadratic.json';
import surface from '../../shared/examples/surface.json';
import tensor from '../../shared/examples/tensor.json';
import triangle from '../../shared/examples/triangle.json';
import { drawSamplePage } from './sample-page';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  proxy: $<HTMLInputElement>('proxy'),
  token: $<HTMLInputElement>('token'),
  status: $<HTMLSpanElement>('status'),
  wrap: $<HTMLElement>('stage-wrap'),
  stage: $<HTMLDivElement>('stage'),
  shot: $<HTMLImageElement>('shot'),
  host: $<HTMLDivElement>('overlay-host'),
  question: $<HTMLTextAreaElement>('question'),
  send: $<HTMLButtonElement>('send'),
  mic: $<HTMLButtonElement>('mic'),
  reset: $<HTMLButtonElement>('reset'),
  speak: $<HTMLInputElement>('speak'),
  capture: $<HTMLButtonElement>('capture'),
  upload: $<HTMLInputElement>('upload'),
  sample: $<HTMLButtonElement>('sample'),
  demos: $<HTMLDivElement>('demos'),
  log: $<HTMLOListElement>('log'),
  sceneJson: $<HTMLPreElement>('scene-json'),
};

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: settings just won't persist */
    }
  },
};

els.proxy.value = store.get('rtg.proxy') ?? 'http://localhost:8787';
els.token.value = store.get('rtg.token') ?? '';

const client = new ProxyClient(els.proxy.value, els.token.value);
const speech = new SpeechQueue();
const overlay = createOverlay(els.host);
let history: Turn[] = [];
let screenshot: Blob | null = null; // JPEG sent to the proxy
let shotSize = { w: 1280, h: 800 };
let online = false;
let busy = false;
let t0 = performance.now();

// ---------- log ----------

function log(text: string, kind: 'info' | 'error' | 'warning' = 'info'): void {
  const li = document.createElement('li');
  li.className = kind;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = `${Math.round(performance.now() - t0)}ms`;
  li.append(t, text);
  els.log.prepend(li);
}

function showScene(scene: Scene | null): void {
  overlay.render(scene);
  els.sceneJson.textContent = scene ? JSON.stringify(scene, null, 2) : '(none)';
}

// ---------- proxy status ----------

async function checkHealth(): Promise<void> {
  client.baseUrl = els.proxy.value.trim();
  client.token = els.token.value.trim();
  store.set('rtg.proxy', client.baseUrl);
  store.set('rtg.token', client.token);
  els.status.className = 'pill';
  els.status.textContent = 'checking…';
  try {
    const h = await client.health(AbortSignal.timeout(4000));
    online = true;
    els.status.className = `pill ${h.mock ? 'warn' : 'ok'}`;
    els.status.textContent = h.mock ? `mock mode${h.stt ? '' : ' · no STT key'}` : `live · ${h.model}${h.stt ? '' : ' · no STT key'}`;
  } catch {
    online = false;
    els.status.className = 'pill bad';
    els.status.textContent = 'proxy offline';
  }
}
els.proxy.addEventListener('change', checkHealth);
els.token.addEventListener('change', checkHealth);

// ---------- screenshot ----------

function fitStage(): void {
  const pad = 32;
  const availW = Math.max(100, els.wrap.clientWidth - pad);
  const availH = Math.max(100, els.wrap.clientHeight - pad);
  const ratio = shotSize.w / shotSize.h;
  const w = Math.min(availW, availH * ratio);
  els.stage.style.width = `${Math.floor(w)}px`;
  els.stage.style.height = `${Math.floor(w / ratio)}px`;
}
new ResizeObserver(fitStage).observe(els.wrap);

async function setScreenshot(blob: Blob): Promise<void> {
  const bitmap = await createImageBitmap(blob);
  shotSize = { w: bitmap.width, h: bitmap.height };
  // Downscale once here so uploads stay small; the proxy downscales again if needed.
  const scale = Math.min(1, 1280 / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  screenshot = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (els.shot.src.startsWith('blob:')) URL.revokeObjectURL(els.shot.src);
  els.shot.src = URL.createObjectURL(blob);
  fitStage();
  overlay.clear();
}

async function captureScreen(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => requestAnimationFrame(r));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    stream.getTracks().forEach((t) => t.stop());
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob) await setScreenshot(blob);
    log(`captured ${canvas.width}×${canvas.height}`);
  } catch (err) {
    log(`screen capture unavailable: ${(err as Error).message}`, 'warning');
  }
}

els.capture.addEventListener('click', captureScreen);
els.sample.addEventListener('click', async () => setScreenshot(await drawSamplePage()));
els.upload.addEventListener('change', async () => {
  const file = els.upload.files?.[0];
  if (file) await setScreenshot(file);
  els.upload.value = '';
});

// ---------- ask ----------

async function ask(opts: { question?: string; audio?: Blob }): Promise<void> {
  if (busy) return;
  if (!online) await checkHealth();
  if (!online) {
    log('Proxy is offline. Start it, or use the demo scenes.', 'error');
    return;
  }
  busy = true;
  els.send.disabled = true;
  speech.stop();
  t0 = performance.now();
  let question = opts.question ?? '';
  let say = '';
  log(opts.audio ? `→ voice question (${Math.round(opts.audio.size / 1024)} KB)` : `→ ${question}`);
  try {
    for await (const ev of client.ask({
      question,
      audio: opts.audio,
      screenshot: screenshot ?? undefined,
      history,
      currentScene: overlay.current,
    })) {
      switch (ev.type) {
        case 'transcript':
          question = ev.text;
          els.question.value = ev.text;
          log(`heard: “${ev.text}”`);
          break;
        case 'say':
          say = ev.text;
          log(`say: ${ev.text}`);
          if (els.speak.checked) speech.enqueue(client.ttsUrl(ev.text));
          break;
        case 'scene':
          showScene(ev.scene);
          log(ev.scene ? `scene: ${ev.scene.panel?.type ?? 'pointers'} · ${ev.scene.title ?? ''}` : 'scene: none');
          break;
        case 'warning':
          log(ev.message, 'warning');
          break;
        case 'error':
          log(ev.message, 'error');
          break;
        case 'done':
          log(`done ${JSON.stringify(ev.timings)}${ev.mock ? ' (mock)' : ''}`);
          if (question && say) history = [...history, { question, say }].slice(-6);
          break;
      }
    }
  } catch (err) {
    log((err as Error).message, 'error');
  } finally {
    busy = false;
    els.send.disabled = false;
  }
}

els.send.addEventListener('click', () => {
  const q = els.question.value.trim();
  if (q) ask({ question: q });
});
els.question.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    els.send.click();
  }
});
els.reset.addEventListener('click', () => {
  history = [];
  speech.stop();
  showScene(null);
  log('context cleared');
});
els.speak.addEventListener('change', () => {
  speech.muted = !els.speak.checked;
  if (speech.muted) speech.stop();
});

// ---------- hold to talk ----------

let recorder: MediaRecorder | null = null;
let recordStart = 0;

function pickMime(): string {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return options.find((m) => window.MediaRecorder?.isTypeSupported(m)) ?? '';
}

async function startRecording(): Promise<void> {
  if (recorder || busy) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickMime();
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const duration = performance.now() - recordStart;
      if (duration < 350) return log('Too short. Hold the button while you speak.', 'warning');
      ask({ audio: new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) });
    };
    recorder = rec;
    recordStart = performance.now();
    rec.start();
    els.mic.classList.add('recording');
    els.mic.textContent = 'Listening… release to send';
    speech.stop();
  } catch (err) {
    log(`microphone unavailable: ${(err as Error).message}`, 'error');
  }
}

function stopRecording(): void {
  if (!recorder) return;
  recorder.stop();
  recorder = null;
  els.mic.classList.remove('recording');
  els.mic.textContent = 'Hold to talk';
}

els.mic.addEventListener('pointerdown', startRecording);
els.mic.addEventListener('pointerup', stopRecording);
els.mic.addEventListener('pointerleave', stopRecording);

// ---------- demos ----------

const demos: { label: string; example: { say: string; scene: unknown } }[] = [
  { label: 'Tensor diagram', example: tensor },
  { label: 'F-35 3D cutaway', example: f35 },
  { label: '3D objects scene', example: habits },
  { label: 'Pi camera steps', example: piCamera },
  { label: 'Quadratic (steps + graph)', example: quadratic },
  { label: 'Integral area', example: integral },
  { label: 'Triangle geometry', example: triangle },
  { label: '3D saddle surface', example: surface },
];
for (const { label, example } of demos) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', () => {
    t0 = performance.now();
    speech.stop();
    showScene(example.scene as Scene);
    log(`demo: ${label}`);
    if (els.speak.checked && online) speech.enqueue(client.ttsUrl(example.say));
  });
  els.demos.appendChild(button);
}

// ---------- start ----------

drawSamplePage().then(setScreenshot);
checkHealth();
