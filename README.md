# Realtime graphics

You ask a question out loud about what's on your screen. The app speaks a short answer and draws
a diagram, a set of steps or a 3D model on top of the screen.

| Folder | What it is |
|---|---|
| `desktop/` | The Windows/macOS app (Tauri 2). A transparent overlay covers the screen; hold a shortcut, ask, and the answer is drawn on top. |
| `proxy/` | Small Python server that holds the API keys. It sends speech to **Groq Whisper** for text, sends the screenshot and question to **DeepSeek** (`deepseek-flash`), and streams speech back from **edge-tts**. |
| `renderer/` | TypeScript library that draws the scenes DeepSeek returns on a transparent overlay: hand-drawn SVG diagrams, step-by-step cards, three.js 3D cutaways, and pointers on the screen. Also has a browser test bench. |
| `shared/examples/` | Sample scenes. Used by the test bench demo buttons and by the proxy's mock mode. |

```
mic ─► Groq whisper-large-v3-turbo ─► question ─┐
screenshot ─────────────────────────────────────┼─► DeepSeek deepseek-flash ─► {"say", "scene"}
                                                │        streamed, "say" comes first
          edge-tts ◄── say ◄────────────────────┘                         │
             │                                                            ▼
          speaker                                      renderer: card + pointers on screen
```

## Requirements

- Python 3.11+ (tested on 3.14) and Node.js 20+
- A **DeepSeek API key** for live answers. Without one, the proxy runs in mock mode with canned answers.
- A **Groq API key** for voice input. Without one, type the question.
- edge-tts needs no key, only internet access.

## Run it

**1. Proxy**

```bash
cd proxy
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # macOS/Linux: .venv/bin/python
cp .env.example .env                                       # add your keys (a .env in the repo root also works)
.venv/Scripts/python -m uvicorn app.main:app --port 8787
```

**2. Test bench**

```bash
cd renderer
npm install
npm run dev
```

Open http://localhost:5173. Then:

- **Capture screen** (or **Upload image**) to set what the model sees. **Sample page** is a fake Raspberry Pi article you can test pointers on.
- Type a question and press **Send**, or hold **Hold to talk**.
- The **Demo scenes** buttons draw the sample scenes with no proxy or keys needed.

**3. Desktop app (Windows / macOS)**

Needs Rust (rustup) plus, on Windows, Visual Studio Build Tools with the C++ workload, or on macOS, the Xcode
Command Line Tools. The proxy must be running.

```bash
cd renderer && npm install          # the overlay uses the shared renderer source
cd ../desktop && npm install
npm run tauri dev                   # run in development
npm run tauri build                 # installer in desktop/src-tauri/target/release/bundle/
```

How to use it:

- **Hold Ctrl + Shift + Space** (Cmd on macOS), ask your question, then let go. It takes a screenshot of
  the screen under your mouse when you press, so the answer is about what you were looking at.
- **Ctrl + Shift + K** opens a box to type the question instead.
- Close the card (×), or press **Esc**, to dismiss it. Closing the card also starts a new topic.
- The tray icon has **Ask by typing**, **Library…**, **Settings…** (proxy address, token, shortcuts, voice)
  and **Quit**. Settings opens by itself on first run. Running the app again with `--library` opens the Library.

**Library (books and documents).** Drop files on the Library window, pick them with **Add book**, or
**Paste text**. Each book is split into parts of a chapter or less. **Start reading** presents each part
aloud in 3–6 steps, mostly as 3D scenes of real objects (with graphs and worked steps where the content calls for
them), then moves on to the next part by itself. Use space / arrow keys or the buttons to pause and step; **Show text** puts the original beside it.
Ask questions by typing or holding **Hold to talk**.

- Formats: EPUB, MOBI, AZW, AZW3, AZW4, PRC, PDF, DOCX, ODT, FB2, RTF, HTML, TXT, Markdown, CBZ and pasted text.
  Scanned PDFs and comics are read from the page images by the vision model. KFX, DjVu, LIT and CBR files
  get a message saying how to convert them.
- **DRM-free books only.** Kindle purchases and DRM-protected EPUBs are refused, not unlocked. Project
  Gutenberg and Standard Ebooks work well.
- The kind of book (technical, self-help, fiction, non-fiction) is detected on upload and sets the style:
  mechanisms and formulas, usable methods and checklists, characters and timelines, or causes and comparisons.
  You can change it per book.
- Fiction has a spoiler guard: questions are answered only from the parts up to where you are.
- Walkthroughs are saved after the first time, so re-reading is instant, and the next part is prepared
  while you read the current one. Books are stored in `proxy/data/library/` (`LIBRARY_DIR`).

**Web pages and videos.** **Add link** (or paste a link anywhere in the Library window):

- A web page becomes an article: menus, sidebars, footers and reference lists are removed, then it reads like a
  book. Links to PDFs, EPUBs and other book files are downloaded and read as books. Pages that need a login or
  a browser to render say so; for those, ask about the page on screen with the hotkey or use **Paste text**.
- A video link (YouTube, Vimeo, TED, Loom, X…) uses the video's captions, or transcribes its audio with Groq
  Whisper when there are none (up to about 25 MB of audio). The transcript is split into ~9-minute parts with
  timestamps; answers mention when things are said, and **Watch from m:ss ↗** opens the video at that part.
- Private and local network addresses are refused.

**Watch mode (live video).** Tray → **Start watch mode**, then play the video. The app records the computer's
sound (Windows only for now) and a screen frame every 12 seconds, transcribing as it goes. Ask about the video
any time with the usual hotkey: the answer uses the last ten minutes of what was said plus the current screen.
**Stop** (in the indicator, bottom left, or the tray) saves a summary and the timed transcript to the Library.

**Meeting mode.** Tray → **Start meeting mode** records your microphone ("You") and the computer's sound
("Others": everyone in Zoom, Meet, Teams… with no plugins). A red indicator stays on screen for the whole
recording, with the latest words heard. **Tell everyone you are recording, and check the consent rules where
you are.** When you stop, you get a summary card (decisions, action items with owners and deadlines, open
questions) read aloud, and **Open recap** shows it in the Library, where **Start reading** plays an animated
recap of how the meeting went. Questions asked during the meeting use what was said so far.

- Use headphones if you can. The app removes the microphone's echo of your speakers, but a garbled echo can slip through.
- "Others" is everyone heard through the computer; people aren't told apart yet.
- Running the app again with `--watch`, `--meeting` or `--stop-recording` controls recording from scripts or shortcuts.

Clicks pass through the overlay to your apps, except over the card. The mic stays open for a minute after each
question so the next one doesn't lose its first words, then closes.

**macOS:** the first time, allow **Screen Recording** and **Microphone** for the app in System Settings →
Privacy & Security, then restart it. macOS builds have to be made on a Mac.

## Speed

DeepSeek V4.1 has "thinking" on by default, which adds about 10 s before the first word. The proxy turns
it off (`DEEPSEEK_THINKING=0`). In live tests with thinking off, speech started after 1.2–3.4 s and the
full graphic arrived after 2.9–5 s. Set `DEEPSEEK_THINKING=1` if you want more careful 3D models and can wait longer.

## API (proxy)

| Endpoint | Purpose |
|---|---|
| `POST /ask` | Multipart form: `payload` (JSON: `question`, `history`, `current_scene`), `screenshot` (image), `audio` (optional, any format Groq accepts). Returns NDJSON events: `transcript`, `say`, `scene`, `warning`, `error`, `done`. |
| `GET /tts?text=` | Streams MP3 from edge-tts. Optional `voice`, `rate`. |
| `GET /voices?locale=en` | Lists edge-tts voices. |
| `GET /health` | Shows whether mock mode, speech-to-text and auth are on. |
| `POST /books` | Multipart: `file`, or `text` + `title`. Parses the book, detects its kind, returns it with its parts. |
| `GET /books`, `GET /books/{id}` | The library, or one book with its parts and reading position. |
| `PATCH /books/{id}`, `DELETE /books/{id}` | Change `genre`, `progress`, `title`, `author`; or remove the book. |
| `GET /books/{id}/parts/{n}/tour` | NDJSON: `beat` (say + scene) as each one is written, then `recap`, `done`. Cached; `?fresh=true` regenerates. |
| `GET /books/{id}/parts/{n}/text` | The part's plain text. |
| `POST /books/{id}/ask` | Like `/ask` (typed or spoken), answered from the book; `payload.position` is the current part. |
| `POST /books` with `url` | A web page, a book file, or a video link (captions or transcribed audio). |
| `POST /sessions` | JSON `{mode: "watch" \| "meeting"}` → `{id}`. Starts a recording session. |
| `POST /sessions/{id}/audio` | Multipart `audio` (WAV chunk), `source` (`mic` / `system`), `offset` seconds. Returns the transcribed lines. |
| `POST /sessions/{id}/frame` | Multipart `image`, `offset`. Screen frames for the summary (watch mode). |
| `GET /sessions/{id}` | Transcript so far. |
| `POST /sessions/{id}/finish` | Summary, decisions, action items and a scene; saves the recording to the library. |
| `POST /ask` with `payload.session_id` | Adds the session's last ten minutes of transcript as context. |

Set `APP_TOKEN` in `.env` before exposing the proxy to the internet. Clients then send it as `X-App-Token`
(or `?token=` for audio URLs).

**Screen positions:** the model works in screenshot pixels. The proxy converts `placement` and `pointers`
to 0–1 fractions, so clients can draw on any screen size. `current_scene` is sent back in the same 0–1 form,
which lets follow-up questions edit the scene on screen.

## Scene format

The full spec is in `proxy/app/prompt.py` (what the model is told) and `proxy/app/scene.py`
(validation). The TypeScript types are in `renderer/src/types.ts`. In short:

- `title`, `subtitle`, `placement` (where the card goes), `pointers` (circles/arrows on real screen content)
- `panel`, one of:
  - `diagram`: boxes, circles, text, arrows (can snap to element ids), lines
  - `steps`: 2–6 steps, each with a small diagram, a graph (`plot`) or a 3D graph (`plot3d`)
  - `3d`: real 3D objects with lighting, reflections and soft shadows. `shape: "model"` places a ready-made
    object from `renderer/src/models.ts` (person, car, castle, brain, laptop, trophy… 74 in all, no downloads).
    Custom parts use box, sphere, cylinder, cone, torus, capsule, plane, `lathe` (a spun profile), `extrude`
    (a solid outline) and `tube` (a pipe along a path), with `material` (plastic, matte, metal, glass, rubber,
    wood, glow), parenting, opacity for cutaways, spin, labels with leader lines, and arrows
  - `plot`: a 2D graph in math coordinates. Functions, parametric and implicit curves (`x^2+y^2=9`),
    points (optionally placed exactly on a curve), tangents, shaded areas, segments and vectors, guide
    lines, polygons, circles, angle marks, text
  - `plot3d`: surfaces `z = f(x, y)`, parametric surfaces (solids of revolution), space curves, points
    and vectors in a labelled plot box

Curves are computed by the renderer from the formulas the model writes (`renderer/src/expr.ts`, a small
parser with no `eval`), so graphs are exact even when the model's arithmetic isn't. Any text field
can contain LaTeX between `$...$` or `$$...$$`, typeset with KaTeX. The model decides 2D or 3D itself:
math problems get worked steps plus graphs, solids and surfaces get a 3D view, and book pages get a
diagram of the page's idea (or, for fiction, of the scene, without spoilers).

If a scene fails validation, the proxy asks the model to fix it once. If that also fails, the spoken
answer is still sent but no scene is drawn.

## Using the renderer in an app

```ts
import { createOverlay, ProxyClient, SpeechQueue } from 'realtime-graphics-renderer';

const overlay = createOverlay(document.getElementById('overlay')!); // a full-screen transparent element
const client = new ProxyClient('https://your-proxy', 'app-token');
const speech = new SpeechQueue();

for await (const ev of client.ask({ audio, screenshot, currentScene: overlay.current })) {
  if (ev.type === 'say') speech.enqueue(client.ttsUrl(ev.text));
  if (ev.type === 'scene') overlay.render(ev.scene);
}
// Desktop shells: pass overlay.interactiveRects() to the window's click-through toggle.
```

`npm run build` writes the library to `renderer/dist/lib/`.

## Tests

```bash
cd proxy && .venv/Scripts/python -m pytest
cd renderer && npm run typecheck
```
