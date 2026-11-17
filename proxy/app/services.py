"""Thin clients for the three cloud services: Groq (speech-to-text), DeepSeek (vision + scene), edge-tts."""
from __future__ import annotations

import base64
import io
import logging
from collections.abc import AsyncIterator

import edge_tts
from openai import AsyncOpenAI, BadRequestError
from PIL import Image

from .config import Settings

log = logging.getLogger("rtg.services")


class GroqSTT:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.client = (
            AsyncOpenAI(api_key=settings.groq_api_key, base_url=settings.groq_base_url, timeout=30)
            if settings.groq_api_key
            else None
        )

    async def transcribe(self, data: bytes, filename: str, content_type: str) -> str:
        if self.client is None:
            raise RuntimeError("GROQ_API_KEY is not set, so voice input is unavailable. Type the question instead.")
        kwargs: dict = {
            "model": self.settings.groq_stt_model,
            "file": (filename, data, content_type),
            "response_format": "json",
            "temperature": 0,
        }
        if self.settings.stt_language:
            kwargs["language"] = self.settings.stt_language
        result = await self.client.audio.transcriptions.create(**kwargs)
        return result.text.strip()

    async def transcribe_segments(self, data: bytes, filename: str, content_type: str, prompt: str = "") -> list[tuple[float, str]]:
        """Timed transcript: [(start seconds, text), ...]."""
        if self.client is None:
            raise RuntimeError("GROQ_API_KEY is not set, so audio can't be transcribed.")
        kwargs: dict = {
            "model": self.settings.groq_stt_model,
            "file": (filename, data, content_type),
            "response_format": "verbose_json",
            "temperature": 0,
        }
        if self.settings.stt_language:
            kwargs["language"] = self.settings.stt_language
        if prompt:
            kwargs["prompt"] = prompt[-800:]  # recent words keep names and spelling consistent across chunks
        result = await self.client.audio.transcriptions.create(**kwargs)
        segments = getattr(result, "segments", None)
        if segments is None:
            return [(0.0, result.text.strip())]
        out = []
        for seg in segments:
            get = (lambda k, s=seg: s.get(k)) if isinstance(seg, dict) else (lambda k, s=seg: getattr(s, k, None))
            # Whisper's own reliability scores: likely silence or noise, very unsure, or looping text.
            no_speech = get("no_speech_prob") or 0.0
            logprob = get("avg_logprob") if get("avg_logprob") is not None else 0.0
            compression = get("compression_ratio") or 0.0
            if (no_speech > 0.6 and logprob < -0.5) or logprob < -1.1 or compression > 2.4:
                continue
            out.append((float(get("start") or 0.0), str(get("text") or "").strip()))
        return out


class DeepSeekLLM:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.json_mode = settings.deepseek_json_mode
        self.client = AsyncOpenAI(api_key=settings.deepseek_api_key or "missing", base_url=settings.deepseek_base_url, timeout=90)

    def _kwargs(self, messages: list[dict], stream: bool, max_tokens: int | None = None) -> dict:
        kwargs: dict = {
            "model": self.settings.deepseek_model,
            "messages": messages,
            "stream": stream,
            "max_tokens": max_tokens or self.settings.max_tokens,
            "temperature": 0.4,
        }
        if self.json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        # Thinking is on by default for V4.x; it adds ~10s before the first word, so it's opt-in here.
        extra: dict = {"thinking": {"type": "enabled" if self.settings.deepseek_thinking else "disabled"}}
        if self.settings.deepseek_thinking and self.settings.deepseek_reasoning_effort:
            extra["reasoning_effort"] = self.settings.deepseek_reasoning_effort
        kwargs["extra_body"] = extra
        return kwargs

    async def _create(self, messages: list[dict], stream: bool, max_tokens: int | None = None):
        try:
            return await self.client.chat.completions.create(**self._kwargs(messages, stream, max_tokens))
        except BadRequestError as e:
            if not self.json_mode:
                raise
            # Some model versions reject json mode with image input; fall back to prompt-only json.
            log.warning("DeepSeek rejected json mode (%s); retrying without response_format", e)
            self.json_mode = False
            return await self.client.chat.completions.create(**self._kwargs(messages, stream, max_tokens))

    async def stream(self, messages: list[dict], max_tokens: int | None = None) -> AsyncIterator[str]:
        response = await self._create(messages, stream=True, max_tokens=max_tokens)
        async for chunk in response:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta is not None and delta.content:
                yield delta.content

    async def complete(self, messages: list[dict], max_tokens: int | None = None) -> str:
        response = await self._create(messages, stream=False, max_tokens=max_tokens)
        return response.choices[0].message.content or ""


async def stream_tts(text: str, voice: str, rate: str) -> AsyncIterator[bytes]:
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            yield chunk["data"]


def prepare_image(data: bytes, max_width: int) -> tuple[str, int, int]:
    """Downscale to max_width and re-encode as JPEG. Returns (base64, width, height)."""
    with Image.open(io.BytesIO(data)) as img:
        img = img.convert("RGB")
        if img.width > max_width:
            height = round(img.height * max_width / img.width)
            img = img.resize((max_width, height), Image.LANCZOS)
        out = io.BytesIO()
        img.save(out, format="JPEG", quality=82)
        return base64.b64encode(out.getvalue()).decode("ascii"), img.width, img.height
