"""The /ask flow: speech-to-text -> vision model (streamed) -> spoken line + validated scene."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field

from .config import EXAMPLES_DIR, Settings
from .prompt import build_messages, build_repair_messages
from .scene import to_client, validate_scene
from .services import DeepSeekLLM, GroqSTT, prepare_image

log = logging.getLogger("rtg.pipeline")

SAY_RE = re.compile(r'"say"\s*:\s*"((?:[^"\\]|\\.)*)"', re.S)


@dataclass
class AskInput:
    question: str = ""
    audio: bytes | None = None
    audio_name: str = "speech.webm"
    audio_type: str = "audio/webm"
    image: bytes | None = None
    history: list[dict] = field(default_factory=list)
    current_scene: dict | None = None
    context: str | None = None  # e.g. excerpts of the book being read
    context_builder: Callable[[str], str] | None = None  # builds context from the transcribed question


def extract_say(buffer: str) -> str | None:
    """Pull the finished "say" string out of a partially streamed JSON object."""
    match = SAY_RE.search(buffer)
    if not match:
        return None
    try:
        return json.loads(f'"{match.group(1)}"')
    except json.JSONDecodeError:
        return None


TRAILING_COMMA_RE = re.compile(r",(\s*[}\]])")
LINE_COMMENT_RE = re.compile(r'("(?:[^"\\]|\\.)*")|//[^\n]*')


def _lenient(text: str) -> str:
    """Undo the usual model slips: // comments and trailing commas (string contents are left alone)."""
    text = LINE_COMMENT_RE.sub(lambda m: m.group(1) or "", text)
    return TRAILING_COMMA_RE.sub(r"\1", text)


def _balance(text: str) -> str:
    """Fix mis-nested or missing closing brackets, the most common way long model JSON breaks."""
    out: list[str] = []
    stack: list[str] = []
    in_string = escaped = False
    for ch in text:
        if in_string:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]":
            if ch not in stack:
                continue  # stray closer: drop it
            while stack[-1] != ch:  # closers the model skipped
                out.append(stack.pop())
            stack.pop()
        out.append(ch)
        if not stack and out and out[0] == "{" and ch == "}":
            break  # root object closed; ignore trailing text
    if in_string:
        out.append('"')
    out.extend(reversed(stack))
    return "".join(out)


# LaTeX commands whose first letter is also a JSON escape (\b \f \n \r \t \u). Written with one backslash,
# json would silently turn "\frac" into a form feed + "rac"; these are kept as literal backslashes.
LATEX_WORD_RE = re.compile(
    r"(?:frac|dfrac|tfrac|beta|bar|binom|big|Big|bigg|begin|bmatrix|boxed|bf|bot|bullet|"
    r"times|theta|tan|tanh|text|textbf|textit|tfrac|to|tau|top|triangle|therefore|tilde|"
    r"nu|neq|ne|nabla|not|neg|ni|nmid|newline|rho|right|rightarrow|rangle|rfloor|rceil|rm|"
    r"underline|uparrow|upsilon|cup|cap|forall|flat)(?![A-Za-z])"
)
HEX4_RE = re.compile(r"[0-9a-fA-F]{4}")


def fix_latex_escapes(text: str) -> str:
    """Double the backslashes of LaTeX the model forgot to escape, leaving real JSON escapes alone."""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch != "\\" or i + 1 >= n:
            out.append(ch)
            i += 1
            continue
        nxt = text[i + 1]
        if nxt in '"\\/':
            out.append(text[i : i + 2])
            i += 2
            continue
        latex = LATEX_WORD_RE.match(text, i + 1)
        if nxt == "u" and not latex and HEX4_RE.fullmatch(text, i + 2, i + 6):
            out.append(text[i : i + 6])
            i += 6
            continue
        if nxt in "bfnrt" and not latex:
            out.append(text[i : i + 2])
            i += 2
            continue
        out.append("\\\\")  # \sqrt, \pi, \frac ...: a literal backslash
        i += 1
    return "".join(out)


def parse_json_object(text: str) -> dict | None:
    text = fix_latex_escapes(text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    candidate = text[start : end + 1]
    for attempt in (candidate, _lenient(candidate), _balance(_lenient(text[start:]))):
        try:
            value = json.loads(attempt)
            return value if isinstance(value, dict) else None
        except json.JSONDecodeError as e:
            error = e
    log.warning("Unparseable model JSON (%s): ...%s...", error, candidate[max(0, error.pos - 120) : error.pos + 80])
    return None


def scene_to_pixels(scene: dict, image_w: int | None, image_h: int | None) -> dict:
    """The client keeps screen positions as 0..1 fractions; the model works in screenshot pixels."""
    if not image_w or not image_h:
        return scene
    out = dict(scene)
    if isinstance(out.get("placement"), dict):
        p = out["placement"]
        out["placement"] = {"x": round(p.get("x", 0) * image_w), "y": round(p.get("y", 0) * image_h)}
    pointers = []
    for p in out.get("pointers") or []:
        q = dict(p, x=round(p.get("x", 0) * image_w), y=round(p.get("y", 0) * image_h))
        if "w" in p:
            q["w"] = round(p["w"] * image_w)
        if "h" in p:
            q["h"] = round(p["h"] * image_h)
        pointers.append(q)
    out["pointers"] = pointers
    return out


def _ms(since: float) -> int:
    return round((time.perf_counter() - since) * 1000)


class AskPipeline:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.stt = GroqSTT(settings)
        self.llm = DeepSeekLLM(settings)
        self.examples = _load_examples()

    async def run(self, req: AskInput) -> AsyncIterator[dict]:
        t0 = time.perf_counter()
        timings: dict[str, int] = {}
        try:
            question = req.question.strip()
            if req.audio:
                question = await self.stt.transcribe(req.audio, req.audio_name, req.audio_type)
                timings["stt"] = _ms(t0)
                yield {"type": "transcript", "text": question}
            if not question:
                yield {"type": "error", "message": "No question heard. Try again or type it."}
                return

            if req.context_builder:
                req.context = await asyncio.to_thread(req.context_builder, question)

            if self.settings.mock:
                async for event in self._mock(question):
                    yield event
                timings["total"] = _ms(t0)
                yield {"type": "done", "timings": timings, "mock": True}
                return

            image_b64 = image_w = image_h = None
            if req.image:
                image_b64, image_w, image_h = await asyncio.to_thread(
                    prepare_image, req.image, self.settings.max_image_width
                )
            current = scene_to_pixels(req.current_scene, image_w, image_h) if req.current_scene else None
            messages = build_messages(question, image_b64, image_w, image_h, req.history, current, req.context)

            buffer, said = "", False
            t_llm = time.perf_counter()
            async for piece in self.llm.stream(messages):
                if not buffer:
                    timings["first_token"] = _ms(t_llm)
                buffer += piece
                if not said:
                    say = extract_say(buffer)
                    if say:
                        said = True
                        timings["say"] = _ms(t0)
                        yield {"type": "say", "text": say}
            timings["llm"] = _ms(t_llm)

            reply = parse_json_object(buffer)
            if not said and reply and isinstance(reply.get("say"), str) and reply["say"].strip():
                yield {"type": "say", "text": reply["say"].strip()}

            raw_scene = reply.get("scene") if reply else buffer
            scene, errors = validate_scene(raw_scene) if reply else (None, "Reply was not valid JSON.")
            if errors:
                log.warning("Scene failed validation, asking for a repair:\n%s", errors)
                t_fix = time.perf_counter()
                fixed = parse_json_object(await self.llm.complete(build_repair_messages(raw_scene, errors)))
                if fixed and "scene" in fixed and "panel" not in fixed:
                    fixed = fixed["scene"]
                scene, errors2 = validate_scene(fixed)
                timings["repair"] = _ms(t_fix)
                if errors2:
                    yield {"type": "warning", "message": f"Scene was invalid and could not be repaired:\n{errors2}"}

            yield {"type": "scene", "scene": to_client(scene, image_w, image_h) if scene else None}
            timings["total"] = _ms(t0)
            yield {"type": "done", "timings": timings}
        except Exception as e:  # surfaced to the client instead of a broken stream
            log.exception("ask failed")
            yield {"type": "error", "message": f"{type(e).__name__}: {e}"}

    async def _mock(self, question: str) -> AsyncIterator[dict]:
        """Canned answers from shared/examples so clients can be built without API keys."""
        q = question.lower()
        example = next(
            (
                ex
                for ex in self.examples
                if any(re.search(rf"\b{re.escape(word)}\b", q) for word in ex.get("match", []))
            ),
            self.examples[0] if self.examples else None,
        )
        if example is None:
            yield {"type": "say", "text": "Mock mode is on but no examples were found."}
            yield {"type": "scene", "scene": None}
            return
        await asyncio.sleep(0.35)
        yield {"type": "say", "text": example["say"]}
        await asyncio.sleep(0.6)
        yield {"type": "scene", "scene": example["scene"]}


def _load_examples() -> list[dict]:
    examples = []
    for path in sorted(EXAMPLES_DIR.glob("*.json")):
        try:
            examples.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            log.exception("Could not load example %s", path)
    return examples
