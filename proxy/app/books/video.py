"""Video links: the transcript (YouTube captions, or Groq Whisper on the audio when there are none),
split into timestamped parts that the book reader walks through like chapters."""
from __future__ import annotations

import asyncio
import logging
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

import httpx

from .formats import BookError, Chapter, ParsedBook

log = logging.getLogger("rtg.video")

YOUTUBE_RE = re.compile(r"(?:youtube\.com/(?:watch\?(?:[^#]*&)?v=|shorts/|live/|embed/)|youtu\.be/)([\w-]{11})", re.I)
# Other sites yt-dlp can read (audio is transcribed); kept short on purpose: common video hosts.
VIDEO_HOSTS = re.compile(r"(?:vimeo\.com|dailymotion\.com|twitch\.tv/videos|ted\.com/talks|loom\.com/share|x\.com/.+/status|twitter\.com/.+/status)", re.I)
GROQ_LIMIT = 24 * 1024 * 1024  # Groq accepts uploads up to 25 MB
PART_SECONDS = 9 * 60
PART_CHARS = 14_000


@dataclass
class Segment:
    start: float
    text: str


def youtube_id(url: str) -> str | None:
    m = YOUTUBE_RE.search(url)
    return m.group(1) if m else None


def is_video_url(url: str) -> bool:
    return bool(youtube_id(url) or VIDEO_HOSTS.search(url))


def clock(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def _youtube_captions(video_id: str) -> tuple[list[Segment], str]:
    """Manual captions first, then auto-generated, English preferred, otherwise the original language."""
    from youtube_transcript_api import YouTubeTranscriptApi

    api = YouTubeTranscriptApi()
    try:
        listing = list(api.list(video_id))
    except Exception as e:  # no captions, private video, or blocked
        log.info("no captions for %s: %s", video_id, type(e).__name__)
        return [], ""
    if not listing:
        return [], ""
    listing.sort(key=lambda t: (not t.language_code.startswith("en"), t.is_generated))
    chosen = listing[0]
    fetched = chosen.fetch()
    segments = [Segment(s.start, " ".join(s.text.split())) for s in fetched.snippets if s.text.strip()]
    return segments, f"{'auto-generated' if chosen.is_generated else 'captions'} ({chosen.language_code})"


async def _oembed(url: str) -> tuple[str, str]:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get("https://www.youtube.com/oembed", params={"url": url, "format": "json"})
            if r.status_code == 200:
                data = r.json()
                return data.get("title", ""), data.get("author_name", "")
    except httpx.HTTPError:
        pass
    return "", ""


def _download_audio(url: str, folder: Path) -> tuple[Path, str, str, float]:
    """Smallest reasonable audio track via yt-dlp (no ffmpeg needed). Returns (file, title, uploader, duration)."""
    try:
        import yt_dlp
    except ImportError as e:
        raise BookError("This video has no captions, and yt-dlp isn't installed to fetch its audio.") from e
    options = {
        "format": "bestaudio[abr<=72]/worstaudio/bestaudio",
        "outtmpl": str(folder / "audio.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "max_filesize": GROQ_LIMIT,
    }
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as e:
        raise BookError(f"Couldn't fetch this video ({str(e).splitlines()[0][:160]}).") from e
    files = list(folder.glob("audio.*"))
    if not files:
        raise BookError("This video's audio is too long to transcribe in one go (over 25 MB). Videos with captions work at any length.")
    return files[0], info.get("title") or "", info.get("uploader") or "", float(info.get("duration") or 0)


async def video_transcript(url: str, stt) -> ParsedBook:
    video_id = youtube_id(url)
    title = author = source = ""
    segments: list[Segment] = []
    if video_id:
        title, author = await _oembed(f"https://www.youtube.com/watch?v={video_id}")
        segments, source = await asyncio.to_thread(_youtube_captions, video_id)
    if not segments:
        if stt.client is None:
            raise BookError("This video has no captions, and voice transcription needs GROQ_API_KEY.")
        with tempfile.TemporaryDirectory() as tmp:
            path, dl_title, uploader, _ = await asyncio.to_thread(_download_audio, url, Path(tmp))
            title, author = title or dl_title, author or uploader
            data = path.read_bytes()
            raw = await stt.transcribe_segments(data, path.name, "audio/" + path.suffix.lstrip("."))
            segments = [Segment(start, text) for start, text in raw if text.strip()]
            source = "transcribed from the audio"
    if not segments:
        raise BookError("No speech found in this video.")
    return transcript_book(title or "Video", author, url, segments, source)


def transcript_book(title: str, author: str, url: str, segments: list[Segment], source: str) -> ParsedBook:
    """Group the transcript into parts of about nine minutes, with a [m:ss] mark every half minute."""
    chapters: list[Chapter] = []
    lines: list[str] = []
    part_start = segments[0].start
    last_mark = -999.0
    size = 0
    for seg in segments:
        if lines and (seg.start - part_start >= PART_SECONDS or size >= PART_CHARS):
            chapters.append(Chapter(title=f"{clock(part_start)}–{clock(seg.start)}", text=" ".join(lines), start=part_start))
            lines, part_start, size, last_mark = [], seg.start, 0, -999.0
        if seg.start - last_mark >= 30:
            lines.append(f"\n\n[{clock(seg.start)}]")
            last_mark = seg.start
        lines.append(seg.text)
        size += len(seg.text) + 1
    end = segments[-1].start
    chapters.append(Chapter(title=f"{clock(part_start)}–{clock(end)}", text=" ".join(lines), start=part_start))
    for c in chapters:
        c.text = re.sub(r"\s*\n\n\s*", "\n\n", c.text).strip()
    fmt = f"video transcript, {source}" if source else "video transcript"
    return ParsedBook(title=title, author=author, format=fmt, chapters=chapters, link=url)
