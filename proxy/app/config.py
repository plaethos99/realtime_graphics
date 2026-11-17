"""Settings from environment variables, plus proxy/.env or the repo-root .env if present."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

PROXY_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = PROXY_DIR.parent
EXAMPLES_DIR = REPO_DIR / "shared" / "examples"
DEFAULT_LIBRARY_DIR = PROXY_DIR / "data" / "library"


def _str(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    value = os.getenv(name)
    return int(value) if value and value.strip() else default


@dataclass(frozen=True)
class Settings:
    deepseek_api_key: str
    deepseek_base_url: str
    deepseek_model: str
    deepseek_thinking: bool
    deepseek_reasoning_effort: str
    deepseek_json_mode: bool
    max_tokens: int
    groq_api_key: str
    groq_base_url: str
    groq_stt_model: str
    stt_language: str
    tts_voice: str
    tts_rate: str
    app_token: str
    cors_origins: list[str]
    max_image_width: int
    force_mock: bool
    library_dir: Path
    book_max_tokens: int

    @property
    def mock(self) -> bool:
        return self.force_mock or not self.deepseek_api_key

    @property
    def stt_enabled(self) -> bool:
        return bool(self.groq_api_key)


def load_settings() -> Settings:
    # proxy/.env wins over the repo-root .env; real environment variables win over both.
    load_dotenv(PROXY_DIR / ".env")
    load_dotenv(REPO_DIR / ".env")
    return Settings(
        deepseek_api_key=_str("DEEPSEEK_API_KEY"),
        deepseek_base_url=_str("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        deepseek_model=_str("DEEPSEEK_MODEL", "deepseek-flash"),
        deepseek_thinking=_bool("DEEPSEEK_THINKING", False),
        deepseek_reasoning_effort=_str("DEEPSEEK_REASONING_EFFORT"),
        deepseek_json_mode=_bool("DEEPSEEK_JSON_MODE", True),
        max_tokens=_int("DEEPSEEK_MAX_TOKENS", 4000),
        groq_api_key=_str("GROQ_API_KEY"),
        groq_base_url=_str("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
        groq_stt_model=_str("GROQ_STT_MODEL", "whisper-large-v3-turbo"),
        stt_language=_str("STT_LANGUAGE"),
        tts_voice=_str("TTS_VOICE", "en-US-AriaNeural"),
        tts_rate=_str("TTS_RATE", "+8%"),
        app_token=_str("APP_TOKEN"),
        cors_origins=[o.strip() for o in _str("CORS_ORIGINS", "*").split(",") if o.strip()],
        max_image_width=_int("MAX_IMAGE_WIDTH", 1280),
        force_mock=_bool("MOCK"),
        library_dir=Path(_str("LIBRARY_DIR") or DEFAULT_LIBRARY_DIR),
        book_max_tokens=_int("BOOK_MAX_TOKENS", 8000),
    )
