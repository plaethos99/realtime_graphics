# Realtime Graphics: what has been built

A desktop app that explains things visually. You ask a question out loud about what's on your screen, or open a
book, web page, video or meeting recording, and it speaks a short explanation while drawing a diagram, a graph or
a 3D scene beside it.

**Status:** Windows desktop app working end to end with live services. 57 automated tests pass.
**Not started yet:** voice analysis, a mode switcher, the folder/codebase explainer, and the Android app.

---

## How it works

| Part | What it does |
|---|---|
| `desktop/` | Windows/macOS app (Tauri 2). A transparent overlay over the whole screen, a tray menu, the Library window, screen capture, and microphone and system-sound recording. |
| `proxy/` | Python server (FastAPI) that holds the API keys and talks to the AI services. |
| `renderer/` | TypeScript library that draws the answers: hand-drawn diagrams, step cards, graphs and 3D scenes. |
| `shared/examples/` | Sample scenes, used by the test bench and offline mode. |

**Services:**
- **Groq Whisper** (`whisper-large-v3-turbo`) turns speech into text.
- **DeepSeek** (`deepseek-flash`) reads the screenshot and question, and writes the spoken answer plus the scene to draw.
- **edge-tts** speaks the answer (default voice `en-US-AriaNeural`; any edge-tts voice or language can be chosen in Settings).

The answer is streamed: speech starts as soon as the first sentence arrives, before the drawing is finished.

---

## Features

### 1. Ask about anything on screen
Hold **Ctrl + Shift + Space**, ask, let go. The app takes a screenshot under the mouse and answers aloud, with a
card drawn next to what you were looking at, and circles or arrows on the real screen content.
**Ctrl + Shift + K** lets you type instead. Follow-up questions update the scene already on screen.

### 2. Math in 2D and 3D
- **Graphs:** functions, curves like `x^2 + y^2 = 9`, tangents, shaded areas for integrals, vectors, triangles, angles and labelled points.
- **3D graphs:** surfaces `z = f(x, y)`, solids of revolution, space curves and vectors.
- **Formulas** are typeset with KaTeX. Graphs are computed by the app from the formula, so they're exact even when
  the model's arithmetic isn't. The formula parser is our own and doesn't use `eval`.
- **Problems** are solved as worked steps, one move per step, with a graph where it helps.

### 3. 3D presentations with real objects
- **Object kit:** 74 ready-made objects (people, vehicles, buildings, devices, nature, everyday things and symbols), built in code with no downloads.
- **Look:** realistic lighting, reflections and soft shadows. Materials: plastic, matte, metal, glass, rubber, wood and glow.
- **Custom shapes:** the model can also build its own from basic shapes, spun profiles, solid outlines and pipes.
- **Book walkthroughs** are presented mostly as 3D scenes. For example, a person climbing stairs towards a trophy
  for "small habits add up", or characters placed in their setting for a novel.

### 4. Library: books in any format
- **Formats:** EPUB, MOBI, AZW, AZW3, AZW4, PRC, PDF, DOCX, ODT, FB2, RTF, HTML, TXT, Markdown, CBZ, and pasted text.
- **Scanned PDFs and comics** are read from the page images.
- **Splitting:** each book is split into parts of a chapter or less, using its table of contents. Project Gutenberg
  licence text, running headers and front matter are removed.
- **Kind of book:** detected on upload (technical, self-help, fiction, non-fiction, meeting), and it sets the style
  of explanation. You can change it per book.
- **Start reading** narrates each part in 3–6 steps, each with a visual, then moves on by itself. Walkthroughs are
  saved, so re-reading is instant.
- **Questions:** ask by typing or holding **Hold to talk**. Fiction has a spoiler guard: answers only use the parts read so far.
- **DRM:** DRM-protected books are refused, not unlocked.

### 5. Web pages
- Paste a link (or use **Add link**). Menus, sidebars, footers and reference lists are removed, then the article is read like a book.
- Links to PDFs and ebooks are downloaded and read as books.
- Private and local network addresses are refused.

### 6. Video links
- YouTube, Vimeo, TED, Loom, X and others are read from their captions. Videos without captions are transcribed
  from the audio (up to about 25 MB of audio).
- The transcript is split into ~9-minute parts with timestamps. Answers say when things were said, and
  **Watch from m:ss** opens the video at that point.

### 7. Watch mode (live video)
- Tray → **Start watch mode** records the computer's sound and a screen frame every 12 s while a video plays.
- Questions asked during playback use the last ten minutes of speech plus the current screen.
- **Stop** saves a summary and the timed transcript to the Library.

### 8. Meeting mode
- Tray → **Start meeting mode** records your microphone ("You") and the computer's sound ("Others"), so Zoom,
  Meet and Teams work without plugins. A red indicator stays on screen the whole time.
- **When you stop:** a spoken summary card with decisions, action items (owner and deadline) and open questions.
- **Open recap** plays an animated replay of the meeting in the Library.
- **Clean-up:** the microphone's echo of the speakers and Whisper's invented phrases are filtered out.

---

## Test results (live services)

| Check | Result |
|---|---|
| Spoken answer starts | 1.0–1.4 s after the question |
| Full drawing arrives | 1.8–2.7 s |
| Book walkthrough, first step | 2.7–5.1 s (instant once saved) |
| Self-help book walkthrough | 6 of 7 steps as 3D object scenes |
| Novel walkthrough | 5 of 6 steps as 3D scenes |
| Meeting replay | 4 of 5 steps as 3D scenes, plus the action items as steps |
| Scripted meeting | Both decisions and "Marco: fix the payment crash by Friday" caught |
| Web pages | Wikipedia, a Paul Graham essay and an arXiv PDF read correctly in about 3–4 s |
| Automated tests | 57 proxy tests pass; renderer and desktop typecheck clean |

---

## Known limits

- **System sound** is recorded on Windows only. On macOS, watch and meeting modes only hear the microphone.
- **Remote speakers aren't told apart:** everyone heard through the computer is "Others".
- **Headphones help in meetings.** On laptop speakers a garbled echo can still reach "You".
- **Not yet tested in a real Zoom or Meet call**, only with scripted audio.
- **First 3D scene is slower:** about 1.2 s to draw after the app opens, then about 0.2 s each.
- **Objects aren't to scale:** the main object in a 3D scene is drawn larger on purpose.
- **Large books:** some take several seconds to parse (for example, an 8 s AZW3).

---

## Run it

```bash
# 1. Proxy (needs DEEPSEEK_API_KEY and GROQ_API_KEY in proxy/.env; see proxy/.env.example)
cd proxy
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app.main:app --port 8787

# 2. Desktop app (needs Rust and, on Windows, the Visual Studio C++ build tools)
cd renderer && npm install
cd ../desktop && npm install
npm run tauri dev
```

Without a DeepSeek key the proxy runs in mock mode with sample answers. Full details are in `README.md`.

---

## Next on the list

1. **Voice analysis:** still needs a decision on what it should cover (tone, pace, filler words, or something else).
2. **Mode switcher:** one place to switch between ask, read, watch and meeting.
3. **Folder and codebase explainer:** upload a folder and get a guided, visual walkthrough of the code.
4. **Android app:** reusing the same renderer and proxy.
