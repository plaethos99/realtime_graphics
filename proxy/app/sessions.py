"""Recording sessions: watch mode (a video or talk playing on the computer) and meeting mode.

The desktop app sends ~15 s audio chunks (the computer's sound, plus the microphone in meetings) and, in watch
mode, a screen frame now and then. Chunks are transcribed as they arrive. Questions asked meanwhile get the
recent transcript as context. Finishing summarises the session and saves it to the library as a book: a
summary part followed by the timed transcript, so the reader can play it back as an animated recap.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from dataclasses import dataclass, field

from .books.formats import Chapter, ParsedBook
from .books.library import Library
from .books.video import clock
from .pipeline import parse_json_object
from .services import DeepSeekLLM, GroqSTT, prepare_image

log = logging.getLogger("rtg.sessions")

PART_SECONDS = 10 * 60
MAX_FRAMES = 40
# Whisper's usual inventions on music, noise or near-silence.
HALLUCINATIONS = re.compile(
    r"^(thank you\.?|thanks for watching!?|thank you for watching\.?|you|bye\.?|\[music\]|♪+|subtitles by .*|\.+)$", re.I
)


def _norm(text: str) -> str:
    return " ".join(re.findall(r"[a-z0-9']+", text.lower()))


def _similar(a: str, b: str) -> bool:
    """True when most of the shorter text's words appear in the longer one (echo of the same speech)."""
    wa, wb = a.split(), b.split()
    if not wa or not wb:
        return False
    short, long_ = (wa, set(wb)) if len(wa) <= len(wb) else (wb, set(wa))
    if len(short) < 3:
        return False  # "hi everyone", "okay": too short to tell an echo from a reply
    return sum(w in long_ for w in short) / len(short) >= 0.6


def _shared_words(a: str, b: str) -> int:
    """Distinct meaningful words (4+ letters) two lines have in common."""
    return len({w for w in a.split() if len(w) >= 4} & {w for w in b.split() if len(w) >= 4})


@dataclass
class Line:
    t: float  # seconds from the start of the session
    source: str  # "mic" or "system"
    text: str


@dataclass
class Session:
    id: str
    mode: str  # "watch" or "meeting"
    started: float = field(default_factory=time.time)
    lines: list[Line] = field(default_factory=list)
    frames: list[tuple[float, bytes]] = field(default_factory=list)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def speaker(self, source: str) -> str:
        if self.mode != "meeting":
            return ""
        return "You" if source == "mic" else "Others"

    def clean_lines(self) -> list[Line]:
        """Lines without repeats and without the mic's echo of what the computer was playing."""
        out: list[Line] = []
        last_by_source: dict[str, Line] = {}
        system = [line for line in self.lines if line.source == "system"]
        for line in self.lines:
            key = _norm(line.text)
            if not key:
                continue
            prev = last_by_source.get(line.source)
            if prev and _norm(prev.text) == key and line.t - prev.t < 60:
                continue  # Whisper repeating itself
            if line.source == "mic" and any(
                (abs(s.t - line.t) < 12 and _similar(key, _norm(s.text)))
                or (abs(s.t - line.t) < 3.5 and _shared_words(key, _norm(s.text)) >= 2)
                for s in system
            ):
                continue  # the microphone hearing the speakers (sometimes garbled)
            last_by_source[line.source] = line
            out.append(line)
        return out

    def transcript(self, since: float = 0.0, limit: int | None = None) -> str:
        rows = []
        for line in self.clean_lines():
            if line.t < since:
                continue
            who = self.speaker(line.source)
            rows.append(f"[{clock(line.t)}] {who + ': ' if who else ''}{line.text}")
        text = "\n".join(rows)
        if limit and len(text) > limit:
            # Keep the opening and the most recent part; the middle is the least useful for a question.
            text = text[: limit // 4] + "\n[…]\n" + text[-(limit * 3 // 4) :]
        return text


SUMMARY_PROMPT = {
    "meeting": """\
You summarise a meeting from its transcript ("You" is the person recording; "Others" is everyone heard through
the computer). Reply with one json object:
{"title": "short name for the meeting", "summary": "3-5 sentences: purpose, what was discussed, outcome",
 "key_points": ["..."], "decisions": ["..."],
 "actions": [{"who": "name or You/Others/unassigned", "what": "the task", "when": "deadline or empty"}],
 "open_questions": ["..."]}
Use the names people use. Only include what was actually said; empty lists are fine.""",
    "watch": """\
You summarise a video or talk from its transcript (and a few screen frames when given). Reply with one json object:
{"title": "short title for what was watched", "summary": "3-5 sentences", "key_points": ["..."],
 "decisions": [], "actions": [], "open_questions": []}""",
}


class Sessions:
    def __init__(self, stt: GroqSTT, llm: DeepSeekLLM, library: Library):
        self.stt = stt
        self.llm = llm
        self.library = library
        self.active: dict[str, Session] = {}

    def create(self, mode: str) -> Session:
        session = Session(id=uuid.uuid4().hex[:12], mode="meeting" if mode == "meeting" else "watch")
        self.active[session.id] = session
        return session

    def get(self, session_id: str) -> Session:
        session = self.active.get(session_id)
        if session is None:
            raise KeyError(session_id)
        return session

    async def add_audio(self, session_id: str, data: bytes, source: str, offset: float) -> list[Line]:
        session = self.get(session_id)
        source = "mic" if source == "mic" else "system"
        # Context for Whisper: recent clean words from the same source (other sources' noise derails it).
        prompt = " ".join(line.text for line in session.clean_lines() if line.source == source)[-500:]
        segments = await self.stt.transcribe_segments(data, "chunk.wav", "audio/wav", prompt=prompt)
        new = [Line(offset + start, source, text) for start, text in segments if text and not HALLUCINATIONS.match(text.strip())]
        async with session.lock:
            session.lines.extend(new)
            session.lines.sort(key=lambda line: line.t)
        return new

    def add_frame(self, session_id: str, image: bytes, offset: float) -> None:
        session = self.get(session_id)
        session.frames.append((offset, image))
        if len(session.frames) > MAX_FRAMES:
            # Thin out older frames, keeping the latest ones dense.
            session.frames = session.frames[:-10:2] + session.frames[-10:]

    def context(self, session_id: str) -> str:
        """For a question asked during the session: what was said in the last ten minutes (and the opening)."""
        session = self.get(session_id)
        elapsed = time.time() - session.started
        what = "a meeting" if session.mode == "meeting" else "a video or talk playing on their computer"
        transcript = session.transcript(since=max(0.0, elapsed - 600), limit=12_000)
        if not transcript:
            return f"The user is recording {what} ({clock(elapsed)} so far); nothing has been transcribed yet."
        return (
            f"The user is recording {what} ({clock(elapsed)} so far). Transcript of the last ten minutes, "
            f"[m:ss] from the start of the recording:\n{transcript}\n\n"
            "Answer using this transcript together with the screenshot. Say when things were said if it helps."
        )

    async def finish(self, session_id: str) -> dict:
        session = self.active.pop(session_id, None)
        if session is None:
            raise KeyError(session_id)
        elapsed = time.time() - session.started
        transcript = session.transcript(limit=150_000)
        if not session.lines:
            return {"title": "Nothing recorded", "say": "I didn't hear anything to summarise.", "scene": None, "book": None}

        content: list[dict] = [{"type": "text", "text": f"Length: {clock(elapsed)}.\n\nTranscript:\n{transcript}"}]
        if session.mode == "watch" and session.frames:
            step = max(1, len(session.frames) // 4)
            for t, image in session.frames[::step][:4]:
                b64, _, _ = await asyncio.to_thread(prepare_image, image, 1024)
                content.append({"type": "text", "text": f"Screen at {clock(t)}:"})
                content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
        messages = [{"role": "system", "content": SUMMARY_PROMPT[session.mode]}, {"role": "user", "content": content}]
        try:
            summary = parse_json_object(await self.llm.complete(messages, max_tokens=2500)) or {}
        except Exception:
            log.exception("summary failed")
            summary = {}
        title = str(summary.get("title") or ("Meeting" if session.mode == "meeting" else "Video notes")).strip()
        stamp = time.strftime("%d %b %Y, %H:%M", time.localtime(session.started))
        book = self._book(session, summary, title, stamp)
        meta = await asyncio.to_thread(self.library.add, book, None, f"{session.mode}-{session.id}")
        meta = self.library.update(meta["id"], genre="meeting" if session.mode == "meeting" else "nonfiction")
        return {
            "title": title,
            "say": str(summary.get("summary") or "").strip()[:600] or f"Recorded {clock(elapsed)}.",
            "scene": self._scene(summary, title, stamp),
            "book": meta["id"],
            "lines": len(session.lines),
        }

    def _book(self, session: Session, summary: dict, title: str, stamp: str) -> ParsedBook:
        def bullets(key: str) -> list[str]:
            return [str(x).strip() for x in summary.get(key) or [] if str(x).strip()]

        actions = [
            f"{a.get('who') or 'Unassigned'}: {a.get('what')}" + (f" (by {a['when']})" if a.get("when") else "")
            for a in summary.get("actions") or []
            if isinstance(a, dict) and a.get("what")
        ]
        sections = [str(summary.get("summary") or "").strip()]
        for heading, items in (("Key points", bullets("key_points")), ("Decisions", bullets("decisions")),
                               ("Action items", actions), ("Open questions", bullets("open_questions"))):
            if items:
                sections.append(heading + ":\n" + "\n".join(f"• {item}" for item in items))
        chapters = [Chapter(title="Summary", text="\n\n".join(s for s in sections if s))]

        # The transcript in ten-minute parts, timestamped, with speakers in meetings.
        lines = session.clean_lines() or session.lines
        part: list[str] = []
        part_start = lines[0].t
        for line in lines:
            if part and line.t - part_start >= PART_SECONDS:
                chapters.append(Chapter(title=f"Transcript {clock(part_start)}–{clock(line.t)}", text="\n\n".join(part), start=part_start))
                part, part_start = [], line.t
            who = session.speaker(line.source)
            part.append(f"[{clock(line.t)}] {who + ': ' if who else ''}{line.text}")
        chapters.append(Chapter(title=f"Transcript {clock(part_start)}–{clock(lines[-1].t)}", text="\n\n".join(part), start=part_start))
        kind = "meeting recording" if session.mode == "meeting" else "video recording"
        return ParsedBook(title=f"{title} ({stamp})", author="", format=kind, chapters=chapters)

    @staticmethod
    def _scene(summary: dict, title: str, stamp: str) -> dict:
        steps = [{"title": "Summary", "text": str(summary.get("summary") or "")}]
        for key, heading in (("key_points", "Key points"), ("decisions", "Decisions")):
            items = [str(x) for x in summary.get(key) or []]
            if items:
                steps.append({"title": heading, "text": "\n".join(f"• {x}" for x in items[:8])})
        actions = [a for a in summary.get("actions") or [] if isinstance(a, dict) and a.get("what")]
        if actions:
            steps.append({
                "title": "Action items",
                "text": "\n".join(f"• {a.get('who') or 'Unassigned'}: {a['what']}" + (f" ({a['when']})" if a.get("when") else "") for a in actions[:8]),
            })
        return {"title": title, "subtitle": f"{stamp} · open the Library for the animated recap", "panel": {"type": "steps", "steps": steps}}


def lines_json(session: Session, lines: list[Line]) -> list[dict]:
    return [{"t": line.t, "speaker": session.speaker(line.source), "text": line.text} for line in lines]
