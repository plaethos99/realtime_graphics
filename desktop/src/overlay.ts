// The full-screen transparent overlay. Hold the talk shortcut → screenshot + recording → proxy →
// spoken answer + drawing. Clicks pass through to the apps underneath except over the card.
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createOverlay, ProxyClient, SpeechQueue, type Scene, type Turn } from '@rtg';
import { native, prettyShortcut, type Settings } from './native';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const host = $<HTMLDivElement>('host');
const statusEl = $<HTMLDivElement>('status');
const statusText = $<HTMLSpanElement>('status-text');
const askForm = $<HTMLFormElement>('ask');
const askInput = $<HTMLInputElement>('ask-input');
const caption = $<HTMLDivElement>('caption');
const rec = $<HTMLDivElement>('rec');
const recTitle = $<HTMLDivElement>('rec-title');
const recLine = $<HTMLDivElement>('rec-line');
const recButton = $<HTMLButtonElement>('rec-button');

const win = getCurrentWindow();
const client = new ProxyClient('http://localhost:8787');
const speech = new SpeechQueue();
const overlay = createOverlay(host, { onClose: () => endTopic() });

let settings: Settings;
let history: Turn[] = [];
let busy = false;
let askOpen = false;
let askShot: Promise<Blob | null> | null = null;

function applySettings(next: Settings): void {
  settings = next;
  client.baseUrl = next.proxyUrl;
  client.token = next.token;
  speech.muted = !next.speak;
  if (!next.speak) speech.stop();
}

// ---------- status pill and caption ----------

let statusTimer = 0;
function status(state: 'listening' | 'thinking' | 'error' | 'info' | null, text = '', hideAfterMs = 0): void {
  clearTimeout(statusTimer);
  if (!state) {
    statusEl.hidden = true;
    return;
  }
  statusEl.dataset.state = state;
  statusText.textContent = text;
  statusEl.hidden = false;
  if (hideAfterMs) statusTimer = window.setTimeout(() => (statusEl.hidden = true), hideAfterMs);
}

let captionTimer = 0;
function showCaption(text: string): void {
  clearTimeout(captionTimer);
  caption.textContent = text;
  caption.hidden = false;
  captionTimer = window.setTimeout(() => (caption.hidden = true), Math.max(5000, text.length * 75));
}

// ---------- scene ----------

function show(scene: Scene | null): void {
  overlay.render(scene);
  native.setEscape(!!overlay.current).catch(() => {});
}

/** Closing the card ends the conversation; the next question starts fresh. */
function endTopic(): void {
  history = [];
  speech.stop();
  caption.hidden = true;
  native.setEscape(false).catch(() => {});
}

function dismiss(): void {
  overlay.clear();
  closeAsk();
  status(null);
  endTopic();
}

// ---------- screenshot ----------

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Screenshot of this monitor, with our own drawings hidden so the model sees only the user's screen. */
async function capture(): Promise<Blob | null> {
  document.body.style.visibility = 'hidden';
  await nextFrame();
  await nextFrame();
  try {
    return await native.captureScreen();
  } catch (err) {
    status('error', String(err), 7000);
    return null;
  } finally {
    document.body.style.visibility = '';
  }
}

// ---------- microphone ----------

// The mic stays open for a minute after use so the next question doesn't lose its first words.
let micStream: MediaStream | null = null;
let micTimer = 0;

async function getMic(): Promise<MediaStream> {
  clearTimeout(micTimer);
  if (micStream?.getAudioTracks().some((t) => t.readyState === 'live')) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  return micStream;
}

function releaseMicSoon(): void {
  clearTimeout(micTimer);
  micTimer = window.setTimeout(() => {
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
  }, 60_000);
}

function pickMime(): string {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return options.find((m) => window.MediaRecorder?.isTypeSupported(m)) ?? '';
}

interface Recording {
  recorder: MediaRecorder | null;
  chunks: Blob[];
  started: number;
  shot: Promise<Blob | null>;
  stopRequested: boolean;
}
let recording: Recording | null = null;

async function startTalk(): Promise<void> {
  if (recording || busy) return; // key repeat while holding, or still answering
  speech.stop();
  closeAsk();
  const rec: Recording = { recorder: null, chunks: [], started: performance.now(), shot: capture(), stopRequested: false };
  recording = rec;
  try {
    const stream = await getMic();
    const mimeType = pickMime();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => {
      if (e.data.size) rec.chunks.push(e.data);
    };
    recorder.onstop = () => void finishTalk(rec, recorder.mimeType || mimeType || 'audio/webm');
    rec.recorder = recorder;
    rec.started = performance.now();
    recorder.start();
    await rec.shot; // show the pill only after the screenshot, so it isn't in it
    if (rec.stopRequested) {
      if (recorder.state === 'recording') recorder.stop();
    } else {
      status('listening', 'Listening… release to ask');
    }
  } catch (err) {
    recording = null;
    status('error', `Microphone unavailable: ${(err as Error).message}`, 7000);
  }
}

function stopTalk(): void {
  if (!recording) return;
  recording.stopRequested = true;
  if (recording.recorder?.state === 'recording') recording.recorder.stop();
}

async function finishTalk(rec: Recording, type: string): Promise<void> {
  recording = null;
  releaseMicSoon();
  const heldMs = performance.now() - rec.started;
  if (heldMs < 400 || !rec.chunks.length) {
    status('info', `Hold ${prettyShortcut(settings.talkShortcut)} while you speak`, 3000);
    return;
  }
  await ask({ audio: new Blob(rec.chunks, { type }), shot: await rec.shot });
}

// ---------- typed questions ----------

async function openAsk(): Promise<void> {
  if (busy || recording) return;
  speech.stop();
  askShot = capture();
  await askShot;
  askOpen = true;
  askForm.hidden = false;
  askInput.value = '';
  // Keyboard focus only; mouse clicks outside the box still reach the apps below.
  await win.setFocus().catch(() => {});
  askInput.focus();
  status('info', 'Type your question · Enter to ask · Esc or click away to cancel', 4000);
}

function closeAsk(): void {
  askOpen = false;
  askForm.hidden = true;
  askShot = null;
}

askForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = askInput.value.trim();
  if (!question) return;
  const shot = await (askShot ?? capture());
  closeAsk();
  await ask({ question, shot });
});
askInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAsk();
});

// ---------- asking the proxy ----------

function describeError(err: unknown): string {
  const message = (err as Error)?.message ?? String(err);
  if (err instanceof TypeError) return `Can't reach the proxy at ${client.baseUrl}. Is it running? (Tray → Settings)`;
  return message;
}

async function ask(q: { question?: string; audio?: Blob; shot: Blob | null }): Promise<void> {
  busy = true;
  let question = q.question ?? '';
  let say = '';
  let failed = false;
  status('thinking', question ? `“${question}”` : 'Thinking…');
  try {
    for await (const ev of client.ask({
      question,
      audio: q.audio,
      screenshot: q.shot ?? undefined,
      history,
      currentScene: overlay.current,
      sessionId: session?.id,
    })) {
      switch (ev.type) {
        case 'transcript':
          question = ev.text;
          status('thinking', `“${ev.text}”`);
          break;
        case 'say':
          say = ev.text;
          showCaption(ev.text);
          if (settings.speak) speech.enqueue(client.ttsUrl(ev.text, settings.voice || undefined));
          break;
        case 'scene':
          show(ev.scene);
          break;
        case 'warning':
          console.warn(ev.message);
          break;
        case 'error':
          failed = true;
          status('error', ev.message, 8000);
          break;
        case 'done':
          if (question && say) history = [...history, { question, say }].slice(-6);
          break;
      }
    }
    if (!failed) status(null);
  } catch (err) {
    status('error', describeError(err), 8000);
  } finally {
    busy = false;
  }
}

// ---------- recording sessions (watch mode, meeting mode) ----------

interface Session {
  id: string;
  mode: 'watch' | 'meeting';
  started: number;
  uploads: Set<Promise<unknown>>;
  frameTimer: number;
  clockTimer: number;
  lines: number;
}
let session: Session | null = null;
let recapBook: string | null = null;
let recHideTimer = 0;

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function showRec(state: 'recording' | 'busy' | 'done', title: string, line = '', button = 'Stop'): void {
  clearTimeout(recHideTimer);
  rec.dataset.state = state;
  recTitle.textContent = title;
  recLine.textContent = line;
  recButton.textContent = button;
  recButton.hidden = !button;
  rec.hidden = false;
}

function recClock(): string {
  const s = session ? Math.floor((performance.now() - session.started) / 1000) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function recLabel(): string {
  return `${session?.mode === 'meeting' ? 'Recording meeting' : 'Watch mode · listening'} · ${recClock()}`;
}

async function startSession(mode: 'watch' | 'meeting'): Promise<void> {
  if (session) return;
  recapBook = null;
  showRec('busy', mode === 'meeting' ? 'Starting meeting mode…' : 'Starting watch mode…', '', '');
  try {
    const { id } = await client.startSession(mode);
    const s: Session = { id, mode, started: performance.now(), uploads: new Set(), frameTimer: 0, clockTimer: 0, lines: 0 };
    session = s;
    const warnings = await Promise.race([
      native.startRecording(mode),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The recorder did not start within 15 seconds.')), 15_000)),
    ]);
    if (warnings.length) status('info', warnings.join(' '), 9000);
    s.clockTimer = window.setInterval(() => {
      if (session === s) recTitle.textContent = recLabel();
    }, 1000);
    if (mode === 'watch') {
      // A frame every 12 s: the summary can mention what was on screen.
      const grab = async () => {
        if (session !== s) return;
        const offset = (performance.now() - s.started) / 1000;
        try {
          const frame = await native.captureScreen();
          track(s, client.sessionFrame(s.id, frame, offset));
        } catch {
          /* a missed frame is fine */
        }
      };
      s.frameTimer = window.setInterval(() => void grab(), 12_000);
      void grab();
    }
    showRec('recording', recLabel(), mode === 'meeting' ? 'Tell everyone you are recording.' : 'Ask about the video any time with the hotkey.');
  } catch (err) {
    session = null;
    await native.stopRecording().catch(() => {});
    showRec('done', "Couldn't start recording", describeError(err), 'Close');
    rec.dataset.state = 'busy';
  }
}

function track(s: Session, p: Promise<unknown>): void {
  s.uploads.add(p);
  p.catch(() => {}).finally(() => s.uploads.delete(p));
}

async function onChunk(chunk: { source: 'mic' | 'system'; offset: number; seconds: number; wav: string }): Promise<void> {
  const s = session;
  if (!s) return;
  const upload = client.sessionAudio(s.id, base64ToBlob(chunk.wav, 'audio/wav'), chunk.source, chunk.offset);
  track(s, upload);
  try {
    const lines = await upload;
    s.lines += lines.length;
    const last = lines[lines.length - 1];
    if (last && session === s) recLine.textContent = `${last.speaker ? `${last.speaker}: ` : ''}${last.text}`;
  } catch (err) {
    if (session === s) recLine.textContent = `Transcription problem: ${describeError(err)}`;
  }
}

async function stopSession(): Promise<void> {
  const s = session;
  if (!s) return;
  session = null;
  clearInterval(s.frameTimer);
  clearInterval(s.clockTimer);
  showRec('busy', 'Finishing…', 'Sending the last of the audio', '');
  await native.stopRecording().catch(() => {});
  // Chunks emitted while stopping are still uploading under the old session id.
  session = s;
  await new Promise((r) => setTimeout(r, 300));
  while (s.uploads.size) await Promise.allSettled([...s.uploads]);
  session = null;
  showRec('busy', s.mode === 'meeting' ? 'Summarising the meeting…' : 'Summarising what you watched…', '', '');
  try {
    const result = await client.finishSession(s.id);
    recapBook = result.book;
    if (result.scene) show(result.scene);
    if (result.say) {
      showCaption(result.say);
      if (settings.speak) speech.enqueue(client.ttsUrl(result.say, settings.voice || undefined));
    }
    if (recapBook) {
      showRec('done', `Saved: ${result.title}`, 'Animated recap and transcript are in the Library', 'Open recap');
      recHideTimer = window.setTimeout(() => (rec.hidden = true), 60_000);
    } else {
      showRec('done', result.title, '', 'Close');
    }
  } catch (err) {
    showRec('done', "Couldn't summarise", describeError(err), 'Close');
  }
}

recButton.addEventListener('click', () => {
  if (session) return void stopSession();
  if (recapBook) void native.openLibrary(recapBook);
  rec.hidden = true;
  recapBook = null;
});

// ---------- click-through ----------

// The window ignores the mouse (clicks reach the apps below) except while the pointer is over the card
// or the ask box. The webview can't see the mouse while ignoring it, so Rust reports its position.
let ignoring = true;
let polling = false;

async function setIgnore(value: boolean): Promise<void> {
  if (value === ignoring) return;
  ignoring = value;
  await win.setIgnoreCursorEvents(value).catch(() => {});
}

async function pollCursor(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    // Never take clicks for the whole screen: only the card and the ask box are interactive.
    const rects = overlay.interactiveRects();
    if (askOpen) rects.push(askForm.getBoundingClientRect());
    if (!rec.hidden) rects.push(rec.getBoundingClientRect());
    if (!rects.length) return await setIgnore(true);
    const pos = await native.cursorPosition().catch(() => null);
    if (!pos) return;
    const [x, y] = pos;
    const over = rects.some((r) => x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6);
    await setIgnore(!over);
  } finally {
    polling = false;
  }
}

// ---------- start ----------

async function main(): Promise<void> {
  applySettings(await native.getSettings());
  await listen('talk-start', () => void startTalk());
  await listen('talk-stop', stopTalk);
  await listen('type-open', () => void openAsk());
  await listen('dismiss', dismiss);
  await listen<Settings>('settings-changed', (e) => applySettings(e.payload));
  await listen<'watch' | 'meeting'>('session-start', (e) => void startSession(e.payload));
  await listen('session-stop', () => void stopSession());
  await listen<{ source: 'mic' | 'system'; offset: number; seconds: number; wav: string }>('audio-chunk', (e) => void onChunk(e.payload));
  // Clicking another app while the ask box is open cancels it.
  await win.onFocusChanged(({ payload: focused }) => {
    if (!focused && askOpen) closeAsk();
  });
  window.setInterval(() => void pollCursor(), 50);
  status('info', `Ready. Hold ${prettyShortcut(settings.talkShortcut)} and ask about your screen.`, 5000);
}

main().catch((err) => status('error', `Startup failed: ${describeError(err)}`));
