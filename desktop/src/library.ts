// Library window: add books, see their parts, and read them as narrated walkthroughs with drawings.
// Runs inside the desktop app, or in a plain browser (?proxy=http://localhost:8787) for testing.
import {
  createOverlay,
  ProxyClient,
  SpeechQueue,
  type Beat,
  type Book,
  type BookSummary,
  type Genre,
  type Turn,
} from '@rtg';
import { native, isTauri, openUrl, type Settings } from './native';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  file: $<HTMLInputElement>('file'),
  paste: $<HTMLButtonElement>('paste'),
  link: $<HTMLButtonElement>('link'),
  linkDialog: $<HTMLDialogElement>('link-dialog'),
  linkUrl: $<HTMLInputElement>('link-url'),
  openSource: $<HTMLButtonElement>('open-source'),
  watch: $<HTMLButtonElement>('watch'),
  drop: $<HTMLDivElement>('drop'),
  adding: $<HTMLUListElement>('adding'),
  books: $<HTMLUListElement>('books'),
  empty: $<HTMLElement>('empty'),
  book: $<HTMLElement>('book'),
  bookTitle: $<HTMLHeadingElement>('book-title'),
  bookMeta: $<HTMLDivElement>('book-meta'),
  genre: $<HTMLSelectElement>('genre'),
  read: $<HTMLButtonElement>('read'),
  remove: $<HTMLButtonElement>('remove'),
  parts: $<HTMLOListElement>('parts'),
  reader: $<HTMLElement>('reader'),
  back: $<HTMLButtonElement>('back'),
  chapter: $<HTMLDivElement>('r-chapter'),
  part: $<HTMLDivElement>('r-part'),
  speak: $<HTMLInputElement>('speak'),
  textToggle: $<HTMLButtonElement>('text-toggle'),
  stage: $<HTMLDivElement>('stage'),
  stageStatus: $<HTMLDivElement>('stage-status'),
  textPane: $<HTMLElement>('text-pane'),
  caption: $<HTMLParagraphElement>('caption'),
  prevPart: $<HTMLButtonElement>('prev-part'),
  prev: $<HTMLButtonElement>('prev'),
  play: $<HTMLButtonElement>('play'),
  next: $<HTMLButtonElement>('next'),
  nextPart: $<HTMLButtonElement>('next-part'),
  beats: $<HTMLDivElement>('beats'),
  ask: $<HTMLFormElement>('ask'),
  askInput: $<HTMLInputElement>('ask-input'),
  mic: $<HTMLButtonElement>('mic'),
  pasteDialog: $<HTMLDialogElement>('paste-dialog'),
  pasteForm: $<HTMLFormElement>('paste-form'),
  pasteTitle: $<HTMLInputElement>('paste-title'),
  pasteText: $<HTMLTextAreaElement>('paste-text'),
  toast: $<HTMLDivElement>('toast'),
};

const GENRE_LABEL: Record<Genre, string> = { technical: 'Technical', selfhelp: 'Self-help', fiction: 'Fiction', nonfiction: 'Non-fiction', meeting: 'Meeting' };

let settings: Pick<Settings, 'proxyUrl' | 'token' | 'voice' | 'speak'> = { proxyUrl: 'http://localhost:8787', token: '', voice: '', speak: true };
const client = new ProxyClient(settings.proxyUrl);
const speech = new SpeechQueue();
const overlay = createOverlay(els.stage, { layout: 'center' });

let books: BookSummary[] = [];
let book: Book | null = null;

// ---------- small helpers ----------

let toastTimer = 0;
function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  clearTimeout(toastTimer);
  els.toast.textContent = text;
  els.toast.dataset.kind = kind;
  els.toast.hidden = false;
  toastTimer = window.setTimeout(() => (els.toast.hidden = true), kind === 'error' ? 9000 : 4000);
}

function describe(err: unknown): string {
  if (err instanceof TypeError) return `Can't reach the proxy at ${client.baseUrl}. Is it running?`;
  return (err as Error)?.message ?? String(err);
}

function li(className: string, ...children: (Node | string)[]): HTMLLIElement {
  const node = document.createElement('li');
  node.className = className;
  node.append(...children);
  return node;
}

function span(className: string, text: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

// ---------- shelf ----------

async function loadBooks(): Promise<void> {
  try {
    books = await client.listBooks();
  } catch (err) {
    toast(describe(err), 'error');
    books = [];
  }
  renderShelf();
}

function renderShelf(): void {
  els.books.replaceChildren(
    ...books.map((b) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `shelf-book${book?.id === b.id ? ' is-open' : ''}`;
      const done = b.partCount > 1 ? Math.round((b.progress / (b.partCount - 1)) * 100) : 0;
      const bar = document.createElement('span');
      bar.className = 'bar';
      bar.style.setProperty('--done', `${done}%`);
      button.append(
        span('shelf-title', b.title),
        span('shelf-meta', [b.author, GENRE_LABEL[b.genre], b.format.toUpperCase()].filter(Boolean).join(' · ')),
        bar,
      );
      button.addEventListener('click', () => void openBook(b.id));
      return li('', button);
    }),
  );
}

async function addSources(sources: (File | { text: string; title?: string } | { url: string })[]): Promise<void> {
  for (const source of sources) {
    const name = source instanceof File ? source.name : 'url' in source ? source.url : source.title || 'Pasted text';
    const row = li('adding-row', span('spinner', ''), span('', `Reading “${name}”…`));
    els.adding.appendChild(row);
    try {
      const added = await client.addBook(source);
      await loadBooks();
      await openBook(added.id);
      toast(`Added “${added.title}” · ${added.parts.length} parts · ${GENRE_LABEL[added.genre]}`);
    } catch (err) {
      toast(`${name}: ${describe(err)}`, 'error');
    } finally {
      row.remove();
    }
  }
}

els.file.addEventListener('change', () => {
  const files = [...(els.file.files ?? [])];
  els.file.value = '';
  if (files.length) void addSources(files);
});

// Dropping anywhere in the window adds the files.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) void addSources(files);
});

els.paste.addEventListener('click', () => {
  els.pasteTitle.value = '';
  els.pasteText.value = '';
  els.pasteDialog.showModal();
  els.pasteText.focus();
});
els.link.addEventListener('click', () => {
  els.linkUrl.value = '';
  els.linkDialog.showModal();
  els.linkUrl.focus();
});
els.linkDialog.addEventListener('close', () => {
  const url = els.linkUrl.value.trim();
  if (els.linkDialog.returnValue === 'ok' && url) void addSources([{ url }]);
});
// Pasting a link anywhere outside a text field adds it too.
window.addEventListener('paste', (e) => {
  if ((e.target as HTMLElement).closest('input, textarea') || els.pasteDialog.open || els.linkDialog.open) return;
  const text = e.clipboardData?.getData('text')?.trim() ?? '';
  if (/^https?:\/\/\S+$/.test(text)) void addSources([{ url: text }]);
});

els.pasteDialog.addEventListener('close', () => {
  const text = els.pasteText.value.trim();
  if (els.pasteDialog.returnValue === 'ok' && text) void addSources([{ text, title: els.pasteTitle.value.trim() }]);
});

// ---------- book contents ----------

function show(view: 'empty' | 'book' | 'reader'): void {
  els.empty.hidden = view !== 'empty';
  els.book.hidden = view !== 'book';
  els.reader.hidden = view !== 'reader';
}

async function openBook(id: string): Promise<void> {
  stopReading();
  try {
    book = await client.getBook(id);
  } catch (err) {
    toast(describe(err), 'error');
    return;
  }
  renderBook();
  renderShelf();
  show('book');
}

function renderBook(): void {
  if (!book) return;
  els.bookTitle.textContent = book.title;
  const chapters = new Set(book.parts.map((p) => p.chapter)).size;
  els.bookMeta.textContent = [book.author, `${book.format.toUpperCase()}`, `${chapters} chapter${chapters === 1 ? '' : 's'}`, `${book.parts.length} parts`]
    .filter(Boolean)
    .join(' · ');
  els.genre.value = book.genre;
  els.openSource.hidden = !book.link;
  els.read.textContent = book.progress > 0 ? `Continue · part ${book.progress + 1}` : 'Start reading';

  const items: HTMLLIElement[] = [];
  let lastChapter = -1;
  for (const part of book.parts) {
    if (part.chapter !== lastChapter && part.title !== part.chapterTitle) {
      items.push(li('chapter', part.chapterTitle));
    }
    lastChapter = part.chapter;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'part';
    if (part.index === book.progress) button.classList.add('is-current');
    const label = part.title === part.chapterTitle ? part.title : part.title.replace(part.chapterTitle, '').trim() || part.title;
    button.append(
      span('part-n', String(part.index + 1)),
      span('part-title', label),
      span('part-state', part.toured ? 'explained' : part.pages?.length ? 'pages' : ''),
    );
    button.addEventListener('click', () => void startReading(part.index));
    items.push(li('', button));
  }
  els.parts.replaceChildren(...items);
}

els.genre.addEventListener('change', async () => {
  if (!book) return;
  try {
    book = await client.updateBook(book.id, { genre: els.genre.value as Genre });
    await loadBooks();
    toast('Kind changed. Parts explained from now on use it; use “Explain again” for earlier ones.');
  } catch (err) {
    toast(describe(err), 'error');
  }
});
els.read.addEventListener('click', () => book && void startReading(book.progress));
els.openSource.addEventListener('click', () => book?.link && void openUrl(book.link));
els.remove.addEventListener('click', async () => {
  if (!book || !confirm(`Remove “${book.title}” from the library?`)) return;
  try {
    await client.deleteBook(book.id);
    book = null;
    await loadBooks();
    show('empty');
  } catch (err) {
    toast(describe(err), 'error');
  }
});

// ---------- reading ----------

interface Reading {
  part: number;
  beats: Beat[];
  index: number; // beat on screen, -1 before the first arrives
  streaming: boolean;
  waiting: boolean; // finished speaking and the next beat hasn't arrived yet
  controller: AbortController;
}
let reading: Reading | null = null;
let playing = true;
let advanceTimer = 0;
let prefetching: AbortController | null = null;
let history: Turn[] = [];

function stopReading(): void {
  reading?.controller.abort();
  reading = null;
  clearTimeout(advanceTimer);
  speech.stop();
  overlay.clear();
}

function setStatus(text: string | null): void {
  els.stageStatus.hidden = !text;
  els.stageStatus.textContent = text ?? '';
}

function setPlaying(value: boolean): void {
  playing = value;
  els.play.textContent = value ? '❚❚' : '▶';
  els.play.setAttribute('aria-label', value ? 'Pause' : 'Play');
}

function renderDots(): void {
  if (!reading) return;
  const r = reading;
  const dots = r.beats.map((_, i) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `beat-dot${i === r.index ? ' is-on' : ''}${i < r.index ? ' is-past' : ''}`;
    dot.setAttribute('aria-label', `Step ${i + 1}`);
    dot.addEventListener('click', () => showBeat(i));
    return dot;
  });
  if (r.streaming) dots.push(span('beat-more', '…') as unknown as HTMLButtonElement);
  els.beats.replaceChildren(...dots);
  els.prev.disabled = r.index <= 0;
  els.next.disabled = r.index >= r.beats.length - 1 && !r.streaming;
}

function speak(text: string, done: () => void): void {
  if (!els.speak.checked) {
    // No voice: give the reader time to read the caption.
    advanceTimer = window.setTimeout(done, Math.max(4000, text.split(/\s+/).length * 330));
    return;
  }
  speech.enqueue(client.ttsUrl(text, settings.voice || undefined), done);
}

function showBeat(i: number): void {
  const r = reading;
  if (!r || i < 0 || i >= r.beats.length) return;
  clearTimeout(advanceTimer);
  speech.stop();
  r.index = i;
  r.waiting = false;
  const beat = r.beats[i];
  overlay.render(beat.scene);
  els.caption.textContent = beat.say;
  setStatus(null);
  renderDots();
  if (playing) speak(beat.say, () => afterBeat(r, i));
}

function afterBeat(r: Reading, i: number): void {
  if (reading !== r || r.index !== i || !playing) return;
  advanceTimer = window.setTimeout(() => {
    if (reading !== r || r.index !== i || !playing) return;
    if (i + 1 < r.beats.length) return showBeat(i + 1);
    if (r.streaming) {
      r.waiting = true;
      setStatus('Preparing the next step…');
      return;
    }
    // End of this part: carry on with the next one, like turning the page.
    if (book && r.part + 1 < book.parts.length) {
      setStatus(`Next: ${book.parts[r.part + 1].title}`);
      advanceTimer = window.setTimeout(() => reading === r && playing && void startReading(r.part + 1), 1500);
    } else {
      setStatus('The end of the book.');
      setPlaying(false);
    }
  }, 900);
}

async function startReading(n: number, fresh = false): Promise<void> {
  if (!book) return;
  stopReading();
  history = [];
  const part = book.parts[n];
  const r: Reading = { part: n, beats: [], index: -1, streaming: true, waiting: false, controller: new AbortController() };
  reading = r;
  setPlaying(true);
  show('reader');
  els.chapter.textContent = part.chapterTitle;
  els.part.textContent = `Part ${n + 1} of ${book.parts.length}${part.title !== part.chapterTitle ? ` · ${part.title}` : ''}`;
  els.caption.textContent = '';
  els.watch.hidden = !(book.link && part.start !== undefined);
  els.watch.textContent = `Watch from ${clock(part.start ?? 0)} ↗`;
  els.prevPart.disabled = n === 0;
  els.nextPart.disabled = n >= book.parts.length - 1;
  setStatus(part.toured ? 'Opening…' : part.pages?.length ? 'Reading the pages…' : 'Reading this part…');
  renderDots();
  if (!els.textPane.hidden) void loadText();
  if (book.progress !== n) {
    book.progress = n;
    client.updateBook(book.id, { progress: n }).then(() => loadBooks()).catch(() => {});
  }

  try {
    for await (const ev of client.tour(book.id, n, { fresh, signal: r.controller.signal })) {
      if (reading !== r) return;
      if (ev.type === 'beat') {
        r.beats.push({ say: ev.say, scene: ev.scene });
        if (r.index === -1 || r.waiting) showBeat(r.beats.length - 1);
        else renderDots();
      } else if (ev.type === 'error') {
        setStatus(ev.message);
      }
    }
  } catch (err) {
    if (r.controller.signal.aborted) return;
    setStatus(describe(err));
  }
  if (reading !== r) return;
  r.streaming = false;
  part.toured = r.beats.length > 0;
  renderDots();
  if (r.waiting) afterBeat(r, r.index);
  prefetch(n + 1);
}

/** Prepare the next part in the background so it starts instantly. */
function prefetch(n: number): void {
  if (!book || n >= book.parts.length || book.parts[n].toured) return;
  prefetching?.abort();
  const controller = new AbortController();
  prefetching = controller;
  const target = book;
  void (async () => {
    try {
      for await (const _ of client.tour(target.id, n, { signal: controller.signal })) {
        /* the proxy caches it */
      }
      target.parts[n].toured = true;
    } catch {
      /* it will be generated when opened instead */
    }
  })();
}

/** 754 -> "12:34" */
function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(s >= 3600 ? 2 : 1, '0');
  return `${s >= 3600 ? `${Math.floor(s / 3600)}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
}

/** The video link at a given time (YouTube and Vimeo understand t=). */
function linkAt(link: string, seconds: number): string {
  const url = new URL(link);
  if (/youtu\.?be/.test(url.hostname)) url.searchParams.set('t', `${Math.floor(seconds)}s`);
  else if (/vimeo\.com/.test(url.hostname)) url.hash = `t=${Math.floor(seconds)}s`;
  return url.toString();
}

els.watch.addEventListener('click', () => {
  if (!book?.link || !reading) return;
  setPlaying(false);
  clearTimeout(advanceTimer);
  speech.stop();
  void openUrl(linkAt(book.link, book.parts[reading.part].start ?? 0));
});

els.play.addEventListener('click', () => {
  if (!reading) return;
  setPlaying(!playing);
  if (!playing) {
    clearTimeout(advanceTimer);
    speech.stop();
  } else if (reading.index >= 0) {
    showBeat(reading.index);
  }
});
els.prev.addEventListener('click', () => reading && showBeat(reading.index - 1));
els.next.addEventListener('click', () => reading && showBeat(reading.index + 1));
els.prevPart.addEventListener('click', () => reading && void startReading(reading.part - 1));
els.nextPart.addEventListener('click', () => reading && void startReading(reading.part + 1));
els.back.addEventListener('click', () => {
  stopReading();
  renderBook();
  show('book');
});
window.addEventListener('keydown', (e) => {
  if (els.reader.hidden || (e.target as HTMLElement).closest('input, textarea, select')) return;
  if (e.key === ' ') {
    e.preventDefault();
    els.play.click();
  } else if (e.key === 'ArrowRight') els.next.click();
  else if (e.key === 'ArrowLeft') els.prev.click();
});
els.speak.addEventListener('change', () => {
  speech.muted = !els.speak.checked;
  if (!els.speak.checked) speech.stop();
  if (reading && playing && reading.index >= 0) showBeat(reading.index);
});

// Original text beside the drawings.
async function loadText(): Promise<void> {
  if (!book || !reading) return;
  const part = book.parts[reading.part];
  if (part.pages?.length) {
    els.textPane.replaceChildren(span('muted', 'This part is scanned pages; the text is read from the images.'));
    return;
  }
  try {
    const text = await client.partText(book.id, reading.part);
    els.textPane.replaceChildren(
      ...text.split(/\n{2,}/).map((para) => {
        const p = document.createElement('p');
        p.textContent = para;
        return p;
      }),
    );
    els.textPane.scrollTop = 0;
  } catch (err) {
    els.textPane.textContent = describe(err);
  }
}
els.textToggle.addEventListener('click', () => {
  els.textPane.hidden = !els.textPane.hidden;
  els.textToggle.setAttribute('aria-pressed', String(!els.textPane.hidden));
  els.textToggle.textContent = els.textPane.hidden ? 'Show text' : 'Hide text';
  if (!els.textPane.hidden) void loadText();
});

// ---------- questions ----------

async function askBook(q: { question?: string; audio?: Blob }): Promise<void> {
  if (!book || !reading) return;
  const r = reading;
  setPlaying(false);
  clearTimeout(advanceTimer);
  speech.stop();
  let question = q.question ?? '';
  let say = '';
  setStatus(question ? `“${question}”` : 'Listening to your question…');
  try {
    for await (const ev of client.askBook(book.id, { ...q, position: r.part, history, currentScene: overlay.current })) {
      if (reading !== r) return;
      if (ev.type === 'transcript') {
        question = ev.text;
        setStatus(`“${ev.text}”`);
      } else if (ev.type === 'say') {
        say = ev.text;
        els.caption.textContent = ev.text;
        if (els.speak.checked) speech.enqueue(client.ttsUrl(ev.text, settings.voice || undefined));
      } else if (ev.type === 'scene') {
        if (ev.scene) overlay.render(ev.scene);
        setStatus('Press ▶ to carry on reading.');
      } else if (ev.type === 'error') {
        setStatus(ev.message);
      }
    }
    if (question && say) history = [...history, { question, say }].slice(-6);
  } catch (err) {
    setStatus(describe(err));
  }
}

els.ask.addEventListener('submit', (e) => {
  e.preventDefault();
  const question = els.askInput.value.trim();
  if (!question) return;
  els.askInput.value = '';
  void askBook({ question });
});

let recorder: MediaRecorder | null = null;
let recordStart = 0;
els.mic.addEventListener('pointerdown', async () => {
  if (recorder || !reading) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (performance.now() - recordStart < 400 || !chunks.length) return toast('Hold the button while you speak.');
      void askBook({ audio: new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) });
    };
    recorder = rec;
    recordStart = performance.now();
    speech.stop();
    rec.start();
    els.mic.classList.add('is-recording');
    els.mic.textContent = 'Listening…';
  } catch (err) {
    toast(`Microphone unavailable: ${describe(err)}`, 'error');
  }
});
const stopMic = () => {
  if (!recorder) return;
  recorder.stop();
  recorder = null;
  els.mic.classList.remove('is-recording');
  els.mic.textContent = 'Hold to talk';
};
els.mic.addEventListener('pointerup', stopMic);
els.mic.addEventListener('pointerleave', stopMic);

// ---------- start ----------

async function main(): Promise<void> {
  if (isTauri) {
    settings = await native.getSettings();
  } else {
    const params = new URLSearchParams(location.search);
    settings = { ...settings, proxyUrl: params.get('proxy') ?? settings.proxyUrl, token: params.get('token') ?? '' };
  }
  client.baseUrl = settings.proxyUrl;
  client.token = settings.token;
  els.speak.checked = settings.speak;
  speech.muted = !settings.speak;
  await loadBooks();
  show('empty');
  // Opened for a recording's recap (?book=…), or asked to show one while already open.
  const wanted = new URLSearchParams(location.search).get('book');
  if (wanted) await openBook(wanted);
  if (isTauri) {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<string>('open-book', async (e) => {
      await loadBooks();
      await openBook(e.payload);
    });
  }
}

void main();
