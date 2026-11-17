"""Reading a book with the user: genre detection, narrated visual walkthroughs of each part, and the
context used to answer questions about the book."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import AsyncIterator

from ..config import Settings
from ..pipeline import parse_json_object
from ..prompt import SCENE_SPEC, STAGING_GUIDE, build_repair_messages
from ..scene import to_client, validate_scene
from ..services import DeepSeekLLM, prepare_image
from .library import GENRES, Library

log = logging.getLogger("rtg.books")

# Bump when walkthroughs change enough that saved ones should be made again.
TOUR_STYLE = 2

GENRE_GUIDE = {
    "technical": (
        "Technical book. Show the mechanism as real objects: \"3d\" for machines, devices, systems and how data or "
        "force moves through them (a laptop, a server, a database and arrows, say). \"plot\" for equations, functions "
        "and data, \"plot3d\" for surfaces and 3D math, \"steps\" with LaTeX for derivations, proofs and algorithms. "
        "Work the book's own formulas and examples through."
    ),
    "selfhelp": (
        "Self-help book. Turn each idea into a little physical scene the reader will remember: a person climbing stairs "
        "for steady progress, scales for a trade-off, a road and a signpost for a choice, a plant and an hourglass for "
        "patience. Use \"steps\" only for a method the reader can actually do. Label things with the book's own names "
        "for its ideas, and use its own examples."
    ),
    "fiction": (
        "Fiction. Stage the story: the characters as people (give each a different colour and label them with their "
        "names), placed in the setting (castle, house, ship, trees, mountains), with the objects that matter in the "
        "scene. Arrows show who goes where or who acts on whom. Use only what has happened up to the end of this part: "
        "never reveal, guess or hint at later events. Describe characters, don't judge them."
    ),
    "meeting": (
        "Meeting recording (a summary, then the timed transcript; \"You\" is the person who recorded it). Replay it as "
        "a scene: the people at a table with speech bubbles and the thing they discussed, the reasoning behind each "
        "decision with real objects, a calendar or clock for deadlines. Use \"steps\" for the action items with owners "
        "and deadlines. Use the names and numbers people actually said."
    ),
    "nonfiction": (
        "Non-fiction. Stage what happened or how it works: the people, places, buildings, vehicles and objects involved, "
        "with arrows for cause and movement. \"plot\" for data and trends."
    ),
}


def tour_prompt(genre: str) -> str:
    return f"""\
You are Clicky, a visual tutor reading a book with the user. You get one part of the book at a time and
turn it into a narrated visual walkthrough: a sequence of beats in the book's order. Each beat is a spoken
explanation plus one visual drawn on a card while it is spoken.

Reply with exactly one json object:
{{"recap": "...", "beats": [{{"say": "...", "scene": {{...}}}}, ...]}}

- "recap" first: 2-3 sentences of what this part covers, so later parts can build on it.
- 3 to 6 beats that together cover the part's important content, in order. Don't skip key points; don't pad.
- "say": 2-4 sentences, at most 70 words, read aloud: plain words, no markdown, no LaTeX, math in words.
  Explain rather than list: what it means, why it matters, how it works, what happens and why.
- "scene": one idea per beat, grounded in the book's own names, terms, numbers and formulas. Every scene has
  a short "title". There is no screen here, so no "placement" or "pointers".
- This is a 3D presentation. Most beats (at least 3 in every 4) use a "3d" panel with real objects. Use "plot",
  "plot3d" or "steps" only when the content truly is a graph, a formula or a list of actions. Use "diagram" only as
  a last resort: boxes and arrows are not a presentation.
- Each beat is a different scene; don't repeat the same objects in the same places.
- Limits per scene: 30 diagram elements, 5 steps, 40 3D objects, 20 plot items.

{GENRE_GUIDE.get(genre, GENRE_GUIDE["nonfiction"])}

{STAGING_GUIDE}

Scene format (TypeScript-like, ? = optional, defaults after the colon):
{SCENE_SPEC}"""


GENRE_PROMPT = """\
Classify a book from its opening. Reply with one json object:
{"genre": "technical" | "selfhelp" | "fiction" | "nonfiction", "title": "...", "author": "..."}
technical = textbooks, science, maths, engineering, programming, manuals.
selfhelp = self-improvement, habits, productivity, psychology for everyday life, business advice.
fiction = novels, short stories, plays, poetry.
nonfiction = history, biography, essays, journalism, everything else.
Give the real title and author if the text shows them, otherwise repeat the ones given."""


class BeatStream:
    """Pulls each complete object out of the "beats" array while the reply is still streaming."""

    def __init__(self) -> None:
        self.buf = ""
        self.pos: int | None = None
        self.depth = 0
        self.start: int | None = None
        self.in_str = self.escaped = self.done = False

    def feed(self, piece: str) -> list[str]:
        self.buf += piece
        found: list[str] = []
        if self.pos is None:
            m = re.search(r'"beats"\s*:\s*\[', self.buf)
            if not m:
                return found
            self.pos = m.end()
        i = self.pos
        while i < len(self.buf) and not self.done:
            ch = self.buf[i]
            if self.in_str:
                if self.escaped:
                    self.escaped = False
                elif ch == "\\":
                    self.escaped = True
                elif ch == '"':
                    self.in_str = False
            elif ch == '"':
                self.in_str = True
            elif ch == "{" and self.depth > 0:
                # A beat object ({"say": ...}) inside another beat means the model dropped a closing
                # bracket: end the broken beat here (its brackets are repaired when parsed) and resync.
                rest = self.buf[i + 1 :].lstrip()
                if len(rest) < 6 and not self.done:
                    break  # wait for enough text to tell
                if rest.startswith('"say"'):
                    if self.start is not None:
                        found.append(self.buf[self.start : i].rstrip().rstrip(","))
                    self.start = i
                    self.depth = 1
                else:
                    self.depth += 1
            elif ch in "{[":
                if self.depth == 0 and ch == "{":
                    self.start = i
                self.depth += 1
            elif ch in "}]":
                if self.depth == 0:
                    self.done = ch == "]"
                else:
                    self.depth -= 1
                    if self.depth == 0 and self.start is not None:
                        found.append(self.buf[self.start : i + 1])
                        self.start = None
            i += 1
        self.pos = i
        return found

    def finish(self) -> list[str]:
        """At the end of the reply: whatever beat is still open (missing its closing brackets)."""
        if self.start is None:
            return []
        tail = self.buf[self.start :]
        # Cut before the "recap" key if the beats array was never closed.
        cut = re.search(r'[\]}]\s*,\s*"recap"\s*:', tail)
        self.start = None
        return [tail[: cut.start() + 1] if cut else tail]


RECAP_RE = re.compile(r'"recap"\s*:\s*"((?:[^"\\]|\\.)*)"', re.S)


def _sample(library: Library, meta: dict, chars: int = 6000) -> str:
    text = ""
    for n in range(len(meta["parts"])):
        text += library.part_text(meta["id"], n) + "\n\n"
        if len(text) > chars:
            break
    return text[:chars]


class BookReader:
    def __init__(self, settings: Settings, llm: DeepSeekLLM, library: Library):
        self.settings = settings
        self.llm = llm
        self.library = library
        self._running: dict[tuple[str, int], asyncio.Lock] = {}

    async def detect_genre(self, meta: dict) -> dict:
        """Ask the model for genre (and a better title/author); keeps the old values if that fails."""
        sample = _sample(self.library, meta)
        if self.settings.mock or not sample.strip():
            return meta
        chapters = ", ".join(p["chapterTitle"] for p in meta["parts"][:30])
        messages = [
            {"role": "system", "content": GENRE_PROMPT},
            {"role": "user", "content": f'Title: {meta["title"]}\nAuthor: {meta["author"]}\nChapters: {chapters}\n\nOpening:\n{sample}'},
        ]
        try:
            reply = parse_json_object(await self.llm.complete(messages, max_tokens=200)) or {}
        except Exception:
            log.exception("genre detection failed")
            return meta
        genre = reply.get("genre") if reply.get("genre") in GENRES else meta["genre"]
        title = (reply.get("title") or "").strip()
        author = (reply.get("author") or "").strip()
        # Only replace a title that looks like a file name.
        # Replace titles that are really file names or URL pieces ("1706", "pg1342").
        current = meta["title"].strip()
        weak = not current or " " not in current or current.lower() in meta["filename"].lower().replace("_", " ")
        better_title = title if title and weak else None
        return self.library.update(meta["id"], genre=genre, title=better_title, author=author if author and not meta["author"] else None)

    def _messages(self, meta: dict, n: int) -> list[dict]:
        part = meta["parts"][n]
        position = f'Part {n + 1} of {len(meta["parts"])}: chapter "{part["chapterTitle"]}"'
        if part.get("start") is not None:
            position += ". This is a video transcript; [m:ss] marks give the time in the video"
        if part["title"] != part["chapterTitle"]:
            position += f' ({part["title"]})'
        lines = [f'Book: "{meta["title"]}"' + (f' by {meta["author"]}' if meta["author"] else "") + f'. Genre: {meta["genre"]}.', position]
        recaps = self.library.recaps(meta["id"], n)
        if recaps:
            lines.append("What earlier parts covered:\n" + "\n".join(f"- Part {i + 1}: {r}" for i, r in recaps))
        content: list[dict] = []
        if part.get("pages"):
            lines.append(f"This part is {len(part['pages'])} scanned page images, attached in order. Read them carefully.")
            content.append({"type": "text", "text": "\n\n".join(lines)})
            for image in self.library.part_images(meta["id"], n):
                b64, _, _ = prepare_image(image, 1600)
                content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
        else:
            lines.append("Text of this part:\n<<<\n" + self.library.part_text(meta["id"], n) + "\n>>>")
            content.append({"type": "text", "text": "\n\n".join(lines)})
        return [{"role": "system", "content": tour_prompt(meta["genre"])}, {"role": "user", "content": content}]

    async def _beat(self, raw: dict | None) -> dict | None:
        if not raw or not isinstance(raw.get("say"), str) or not raw["say"].strip():
            return None
        scene, errors = validate_scene(raw.get("scene"))
        if scene and scene.panel is None:
            scene, errors = None, "panel: every beat needs a panel; choose one that shows this beat's idea"
        if errors:
            log.warning("Tour beat scene invalid, repairing:\n%s", errors)
            try:
                fixed = parse_json_object(await self.llm.complete(build_repair_messages(raw.get("scene"), errors)))
                if fixed and "scene" in fixed and "panel" not in fixed:
                    fixed = fixed["scene"]
                scene, _ = validate_scene(fixed)
            except Exception:
                log.exception("repair failed")
                scene = None
        return {"say": raw["say"].strip(), "scene": to_client(scene, None, None) if scene else None}

    async def tour(self, book_id: str, n: int, fresh: bool = False) -> AsyncIterator[dict]:
        t0 = time.perf_counter()
        try:
            meta = self.library.get(book_id)
            if not 0 <= n < len(meta["parts"]):
                yield {"type": "error", "message": f"This book has no part {n + 1}."}
                return
            # One generation per part at a time; a second request waits and then reads the cache.
            lock = self._running.setdefault((book_id, n), asyncio.Lock())
            async with lock:
                cached = None if fresh else self.library.tour(book_id, n)
                if cached and cached.get("style") == TOUR_STYLE:
                    for i, beat in enumerate(cached["beats"]):
                        yield {"type": "beat", "index": i, **beat}
                    yield {"type": "recap", "text": cached.get("recap", "")}
                    yield {"type": "done", "cached": True}
                    return
                if self.settings.mock:
                    async for event in self._mock_tour(book_id, n):
                        yield event
                    return

                messages = await asyncio.to_thread(self._messages, meta, n)
                stream = BeatStream()
                beats: list[dict] = []
                first = None
                async for piece in self.llm.stream(messages, max_tokens=self.settings.book_max_tokens):
                    for raw in stream.feed(piece):
                        beat = await self._beat(parse_json_object(raw))
                        if beat:
                            first = first or round((time.perf_counter() - t0) * 1000)
                            yield {"type": "beat", "index": len(beats), **beat}
                            beats.append(beat)
                for raw in stream.finish():
                    beat = await self._beat(parse_json_object(raw))
                    if beat:
                        yield {"type": "beat", "index": len(beats), **beat}
                        beats.append(beat)
                reply = parse_json_object(stream.buf) or {}
                if not isinstance(reply.get("recap"), str):
                    m = RECAP_RE.search(stream.buf)
                    if m:
                        reply["recap"] = json.loads(f'"{m.group(1)}"')
                if not beats:  # stream extraction found nothing: fall back to the whole reply
                    for raw in reply.get("beats") or []:
                        beat = await self._beat(raw if isinstance(raw, dict) else None)
                        if beat:
                            yield {"type": "beat", "index": len(beats), **beat}
                            beats.append(beat)
                if not beats:
                    yield {"type": "error", "message": "The model didn't return a walkthrough for this part. Try again."}
                    return
                recap = reply.get("recap") if isinstance(reply.get("recap"), str) else " ".join(b["say"] for b in beats)[:600]
                self.library.save_tour(book_id, n, {"beats": beats, "recap": recap, "created": time.time(), "style": TOUR_STYLE})
                yield {"type": "recap", "text": recap}
                yield {"type": "done", "timings": {"first_beat": first, "total": round((time.perf_counter() - t0) * 1000)}}
        except Exception as e:
            log.exception("tour failed")
            yield {"type": "error", "message": f"{type(e).__name__}: {e}"}

    async def _mock_tour(self, book_id: str, n: int) -> AsyncIterator[dict]:
        """Without an API key: read the first sentences of the part aloud, no visuals."""
        text = self.library.part_text(book_id, n) or "This part is made of page images, which need the vision model."
        sentences = re.split(r"(?<=[.!?])\s+", " ".join(text.split()))
        beats = [{"say": " ".join(sentences[i : i + 2])[:400], "scene": None} for i in range(0, min(len(sentences), 6), 2)]
        for i, beat in enumerate(beats):
            await asyncio.sleep(0.2)
            yield {"type": "beat", "index": i, **beat}
        yield {"type": "recap", "text": beats[0]["say"] if beats else ""}
        yield {"type": "done", "mock": True}

    def question_context(self, book_id: str, question: str, position: int) -> str:
        """Book excerpts and recaps for answering a question; fiction is limited to what has been read."""
        meta = self.library.get(book_id)
        fiction = meta["genre"] == "fiction"
        upto = position if fiction else None
        hits = self.library.search(book_id, question, upto=upto, k=6)
        # The current part always counts, even when the words don't match.
        current = self.library.part_text(book_id, position)
        if current and not any(p == position for p, _ in hits):
            hits.insert(0, (position, current[:6000]))
        part = meta["parts"][position]
        lines = [
            f'The user is reading "{meta["title"]}"' + (f' by {meta["author"]}' if meta["author"] else "") + f' ({meta["genre"]}).',
            f'They are at part {position + 1} of {len(meta["parts"])}, chapter "{part["chapterTitle"]}". Answer about this book, '
            "using the excerpts below; say so if the book doesn't cover it.",
        ]
        if fiction:
            lines.append("Fiction: never reveal or hint at anything after their current position.")
        if part.get("start") is not None:
            lines.append("This is a video transcript: say at what time ([m:ss]) things are said when it helps.")
        recaps = self.library.recaps(book_id, position + 1, limit=10)
        if recaps:
            lines.append("What the parts read so far covered:\n" + "\n".join(f"- Part {i + 1}: {r}" for i, r in recaps))
        if hits:
            lines.append("Excerpts (most relevant first):\n" + "\n\n".join(f"[Part {p + 1}] {t[:2500]}" for p, t in hits))
        lines.append("There is no screenshot: omit placement and pointers.")
        return "\n\n".join(lines)


def tour_event_json(event: dict) -> str:
    return json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n"
