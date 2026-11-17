import type { Scene } from './types';

export interface Turn {
  question: string;
  say: string;
}

export type AskEvent =
  | { type: 'transcript'; text: string }
  | { type: 'say'; text: string }
  | { type: 'scene'; scene: Scene | null }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done'; timings: Record<string, number>; mock?: boolean };

export interface AskRequest {
  question?: string;
  audio?: Blob;
  screenshot?: Blob;
  history?: Turn[];
  currentScene?: Scene | null;
  /** A recording session in progress: its recent transcript is added as context. */
  sessionId?: string;
  signal?: AbortSignal;
}

export interface SessionLine {
  t: number;
  speaker: string;
  text: string;
}

export interface SessionResult {
  title: string;
  say: string;
  scene: Scene | null;
  /** Library id of the saved recording (summary + transcript), for the animated recap. */
  book: string | null;
}

export interface Health {
  ok: boolean;
  mock: boolean;
  stt: boolean;
  model: string;
  voice: string;
  auth: boolean;
}

// ---- books ----

export type Genre = 'technical' | 'selfhelp' | 'fiction' | 'nonfiction' | 'meeting';

export interface BookPart {
  index: number;
  chapter: number;
  chapterTitle: string;
  title: string;
  chars: number;
  pages?: number[];
  /** Seconds into the video, for video transcripts. */
  start?: number;
  toured: boolean;
}

export interface BookSummary {
  id: string;
  title: string;
  author: string;
  format: string;
  genre: Genre;
  filename: string;
  /** The web page or video the book came from. */
  link?: string | null;
  progress: number;
  chapters: number;
  partCount: number;
  added: number;
}

export interface Book extends Omit<BookSummary, 'partCount'> {
  parts: BookPart[];
}

export interface Beat {
  say: string;
  scene: Scene | null;
}

export type TourEvent =
  | ({ type: 'beat'; index: number } & Beat)
  | { type: 'recap'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; cached?: boolean; mock?: boolean; timings?: Record<string, number> };

function audioFilename(type: string): string {
  if (type.includes('ogg')) return 'speech.ogg';
  if (type.includes('mp4') || type.includes('aac') || type.includes('m4a')) return 'speech.m4a';
  if (type.includes('wav')) return 'speech.wav';
  if (type.includes('mpeg')) return 'speech.mp3';
  return 'speech.webm';
}

/** One JSON value per line, yielded as each line arrives. */
async function* ndjson<T>(res: Response): AsyncGenerator<T> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as T;
    }
    if (done) break;
  }
  if (buffer.trim()) yield JSON.parse(buffer) as T;
}

/** Error from a failed response, using FastAPI's {"detail": "..."} message when there is one. */
async function failure(res: Response, what: string): Promise<Error> {
  const body = await res.text().catch(() => '');
  try {
    const detail = JSON.parse(body).detail;
    if (typeof detail === 'string') return new Error(detail);
  } catch {
    /* not JSON */
  }
  return new Error(`${what}: HTTP ${res.status} ${body.slice(0, 200)}`);
}

/** Talks to the proxy. Same API for the desktop shell, the Android WebView and the test bench. */
export class ProxyClient {
  constructor(public baseUrl: string, public token = '') {}

  private url(path: string, params: Record<string, string> = {}): string {
    const url = new URL(path, this.baseUrl.replace(/\/*$/, '/'));
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    return url.toString();
  }

  private headers(): Record<string, string> {
    return this.token ? { 'X-App-Token': this.token } : {};
  }

  async health(signal?: AbortSignal): Promise<Health> {
    const res = await fetch(this.url('health'), { headers: this.headers(), signal });
    if (!res.ok) throw new Error(`health: HTTP ${res.status}`);
    return res.json();
  }

  /** Streams events as they arrive: transcript, say (speak it now), scene (draw it), done. */
  async *ask(req: AskRequest): AsyncGenerator<AskEvent> {
    const form = new FormData();
    form.set(
      'payload',
      JSON.stringify({ question: req.question ?? '', history: req.history ?? [], current_scene: req.currentScene ?? null, session_id: req.sessionId ?? null }),
    );
    if (req.screenshot) form.set('screenshot', req.screenshot, 'screen.jpg');
    if (req.audio) form.set('audio', req.audio, audioFilename(req.audio.type));

    const res = await fetch(this.url('ask'), { method: 'POST', body: form, headers: this.headers(), signal: req.signal });
    if (!res.ok || !res.body) throw await failure(res, 'ask');
    yield* ndjson<AskEvent>(res);
  }

  /** URL of a streamed MP3 for `text`; usable directly as an <audio> src. */
  ttsUrl(text: string, voice?: string): string {
    return this.url('tts', { text, voice: voice ?? '', token: this.token });
  }

  // ---- recording sessions (watch mode, meeting mode) ----

  startSession(mode: 'watch' | 'meeting'): Promise<{ id: string; mode: string }> {
    return this.json('sessions', { method: 'POST', body: JSON.stringify({ mode }), headers: { 'Content-Type': 'application/json' } });
  }

  /** One audio chunk; returns the lines transcribed from it. */
  async sessionAudio(id: string, wav: Blob, source: 'mic' | 'system', offset: number): Promise<SessionLine[]> {
    const form = new FormData();
    form.set('audio', wav, 'chunk.wav');
    form.set('source', source);
    form.set('offset', String(offset));
    return (await this.json<{ lines: SessionLine[] }>(`sessions/${id}/audio`, { method: 'POST', body: form })).lines;
  }

  async sessionFrame(id: string, image: Blob, offset: number): Promise<void> {
    const form = new FormData();
    form.set('image', image, 'frame.jpg');
    form.set('offset', String(offset));
    await this.json(`sessions/${id}/frame`, { method: 'POST', body: form });
  }

  finishSession(id: string): Promise<SessionResult> {
    return this.json(`sessions/${id}/finish`, { method: 'POST' });
  }

  // ---- books ----

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(this.url(path), { ...init, headers: { ...this.headers(), ...((init.headers as Record<string, string>) ?? {}) } });
    if (!res.ok) throw await failure(res, path);
    return res.json();
  }

  listBooks(): Promise<BookSummary[]> {
    return this.json('books');
  }

  getBook(id: string): Promise<Book> {
    return this.json(`books/${id}`);
  }

  /** Upload a book file, pasted text, or a link (web page, book file, video). Parsing and genre detection happen on the proxy. */
  addBook(source: File | { text: string; title?: string } | { url: string }): Promise<Book> {
    const form = new FormData();
    if (source instanceof File) {
      form.set('file', source, source.name);
    } else if ('url' in source) {
      form.set('url', source.url);
    } else {
      form.set('text', source.text);
      form.set('title', source.title ?? '');
    }
    return this.json('books', { method: 'POST', body: form });
  }

  updateBook(id: string, changes: Partial<Pick<Book, 'genre' | 'progress' | 'title' | 'author'>>): Promise<Book> {
    return this.json(`books/${id}`, { method: 'PATCH', body: JSON.stringify(changes), headers: { 'Content-Type': 'application/json' } });
  }

  async deleteBook(id: string): Promise<void> {
    await this.json(`books/${id}`, { method: 'DELETE' });
  }

  async partText(id: string, part: number): Promise<string> {
    const res = await fetch(this.url(`books/${id}/parts/${part}/text`), { headers: this.headers() });
    if (!res.ok) throw await failure(res, 'text');
    return res.text();
  }

  /** The narrated walkthrough of one part: beats arrive one by one while the rest is still being written. */
  async *tour(id: string, part: number, opts: { fresh?: boolean; signal?: AbortSignal } = {}): AsyncGenerator<TourEvent> {
    const res = await fetch(this.url(`books/${id}/parts/${part}/tour`, { fresh: opts.fresh ? 'true' : '' }), {
      headers: this.headers(),
      signal: opts.signal,
    });
    if (!res.ok) throw await failure(res, 'tour');
    yield* ndjson<TourEvent>(res);
  }

  /** A question about the book (typed or spoken), answered from the parts read so far. */
  async *askBook(id: string, req: AskRequest & { position: number }): AsyncGenerator<AskEvent> {
    const form = new FormData();
    form.set(
      'payload',
      JSON.stringify({ question: req.question ?? '', history: req.history ?? [], current_scene: req.currentScene ?? null, position: req.position }),
    );
    if (req.audio) form.set('audio', req.audio, audioFilename(req.audio.type));
    const res = await fetch(this.url(`books/${id}/ask`), { method: 'POST', body: form, headers: this.headers(), signal: req.signal });
    if (!res.ok || !res.body) throw await failure(res, 'ask');
    yield* ndjson<AskEvent>(res);
  }
}

/** Plays spoken lines one after another. */
export class SpeechQueue {
  private queue: { url: string; done?: () => void }[] = [];
  private audio: HTMLAudioElement | null = null;
  muted = false;

  /** `done` runs when this line finishes (or fails, or speech is muted); not when stop() cuts it off. */
  enqueue(url: string, done?: () => void): void {
    if (this.muted) {
      if (done) setTimeout(done, 0);
      return;
    }
    this.queue.push({ url, done });
    if (!this.audio) this.next();
  }

  get speaking(): boolean {
    return !!this.audio;
  }

  stop(): void {
    this.queue = [];
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
    }
    this.audio = null;
  }

  private next(): void {
    const item = this.queue.shift();
    if (!item) {
      this.audio = null;
      return;
    }
    const audio = new Audio(item.url);
    this.audio = audio;
    const finish = () => {
      if (this.audio !== audio) return;
      item.done?.();
      this.next();
    };
    audio.onended = audio.onerror = finish;
    audio.play().catch(finish);
  }
}
