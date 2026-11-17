"""The user's book library on disk: parsed books split into reading parts, tours, recaps and progress.

Layout (one folder per book, named by a hash of the file so re-uploads are recognised):
  <root>/<id>/meta.json        title, author, format, genre, parts, progress
  <root>/<id>/text/<n>.txt     text of reading part n
  <root>/<id>/tours/<n>.json   generated walkthrough of part n (beats + recap)
  <root>/<id>/source.<ext>     the original file, kept for scanned PDFs and comics (page images)
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import re
import shutil
import threading
import time
import zipfile
from collections import Counter
from pathlib import Path

from .formats import Chapter, ParsedBook, cbz_images, drop_front_matter

PART_CHARS = 16_000  # one walkthrough covers at most this much text
GENRES = ("technical", "selfhelp", "fiction", "nonfiction", "meeting")
_WORD = re.compile(r"[a-z0-9]+")
_STOP = set(
    "the a an and or of to in is it that this was for on with as be by at are from his her he she they "
    "you i we not but had have has were their them its which who what when where how all would there "
    "been one so if into no can will more about than then out up do did said".split()
)


def _split_text(text: str, limit: int = PART_CHARS) -> list[str]:
    """Split at paragraph boundaries into roughly equal pieces no longer than `limit`."""
    if len(text) <= limit:
        return [text]
    target = len(text) / math.ceil(len(text) / limit)
    pieces, current, size = [], [], 0
    for para in text.split("\n\n"):
        if current and size + len(para) > target:
            pieces.append("\n\n".join(current))
            current, size = [], 0
        while len(para) > limit:  # one enormous paragraph (bad extraction): cut it
            pieces.append(para[:limit])
            para = para[limit:]
        current.append(para)
        size += len(para) + 2
    if current:
        pieces.append("\n\n".join(current))
    return pieces


def _tokens(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in _STOP and len(w) > 1]


class Library:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._chunks: dict[str, list[tuple[int, str, Counter]]] = {}  # search index per book, built on demand

    # ---------- adding ----------

    def add(self, book: ParsedBook, source: bytes | None, filename: str) -> dict:
        digest = hashlib.sha1(source if source is not None else json.dumps([c.text for c in book.chapters]).encode()).hexdigest()[:12]
        folder = self.root / digest
        if (folder / "meta.json").exists():
            return self.get(digest)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "text").mkdir(exist_ok=True)
        (folder / "tours").mkdir(exist_ok=True)

        parts: list[dict] = []
        chapters: list[Chapter] = drop_front_matter(book.chapters)
        for ci, chapter in enumerate(chapters):
            if chapter.pages:
                parts.append({"chapter": ci, "chapterTitle": chapter.title, "title": chapter.title, "pages": chapter.pages, "chars": 0})
                continue
            pieces = _split_text(chapter.text)
            for pi, piece in enumerate(pieces):
                title = chapter.title if len(pieces) == 1 else f"{chapter.title} ({pi + 1}/{len(pieces)})"
                (folder / "text" / f"{len(parts)}.txt").write_text(piece, encoding="utf-8")
                part = {"chapter": ci, "chapterTitle": chapter.title, "title": title, "chars": len(piece)}
                if chapter.start is not None:
                    part["start"] = chapter.start
                parts.append(part)

        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
        if source is not None and book.image_source:
            (folder / f"source.{ext}").write_bytes(source)
        meta = {
            "id": digest,
            "title": book.title,
            "author": book.author,
            "format": book.format,
            "genre": "nonfiction",
            "filename": filename,
            "link": book.link,
            "source": f"source.{ext}" if source is not None and book.image_source else None,
            "imageSource": book.image_source,
            "added": time.time(),
            "progress": 0,
            "chapters": len(chapters),
            "parts": parts,
        }
        self._write_meta(digest, meta)
        return {**self.get(digest), "new": True}

    # ---------- reading ----------

    def _meta_path(self, book_id: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{12}", book_id):
            raise KeyError(book_id)
        return self.root / book_id / "meta.json"

    def _write_meta(self, book_id: str, meta: dict) -> None:
        path = self._meta_path(book_id)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(path)

    def get(self, book_id: str) -> dict:
        path = self._meta_path(book_id)
        if not path.exists():
            raise KeyError(book_id)
        meta = json.loads(path.read_text(encoding="utf-8"))
        tours = self.root / book_id / "tours"
        for n, part in enumerate(meta["parts"]):
            part["index"] = n
            part["toured"] = (tours / f"{n}.json").exists()
        return meta

    def list(self) -> list[dict]:
        books = []
        for path in self.root.glob("*/meta.json"):
            try:
                meta = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            meta["partCount"] = len(meta.pop("parts", []))
            books.append(meta)
        return sorted(books, key=lambda m: m.get("added", 0), reverse=True)

    def update(self, book_id: str, **changes) -> dict:
        with self._lock:
            meta = self.get(book_id)
            for key in ("genre", "progress", "title", "author"):
                if changes.get(key) is not None:
                    meta[key] = changes[key]
            if meta["genre"] not in GENRES:
                meta["genre"] = "nonfiction"
            meta["progress"] = max(0, min(len(meta["parts"]) - 1, int(meta["progress"])))
            for part in meta["parts"]:
                part.pop("index", None)
                part.pop("toured", None)
            self._write_meta(book_id, meta)
        return self.get(book_id)

    def delete(self, book_id: str) -> None:
        folder = self._meta_path(book_id).parent
        if folder.exists():
            shutil.rmtree(folder)
        self._chunks.pop(book_id, None)

    def part_text(self, book_id: str, n: int) -> str:
        path = self.root / book_id / "text" / f"{n}.txt"
        return path.read_text(encoding="utf-8") if path.exists() else ""

    def part_images(self, book_id: str, n: int) -> list[bytes]:
        """Page images (PNG/JPEG bytes) for a scanned-PDF or comic part."""
        meta = self.get(book_id)
        part = meta["parts"][n]
        if not part.get("pages") or not meta.get("source"):
            return []
        source = (self.root / book_id / meta["source"]).read_bytes()
        if meta["imageSource"] == "cbz":
            names = cbz_images(source)
            with zipfile.ZipFile(io.BytesIO(source)) as z:
                return [z.read(names[i]) for i in part["pages"] if i < len(names)]
        import pypdfium2 as pdfium

        images = []
        doc = pdfium.PdfDocument(source)
        try:
            for i in part["pages"]:
                page = doc[i]
                scale = 1600 / max(1.0, page.get_width())  # ~1600 px wide: small print stays legible
                pil = page.render(scale=scale).to_pil()
                out = io.BytesIO()
                pil.convert("RGB").save(out, format="JPEG", quality=85)
                images.append(out.getvalue())
                page.close()
        finally:
            doc.close()
        return images

    # ---------- tours and recaps ----------

    def tour(self, book_id: str, n: int) -> dict | None:
        path = self.root / book_id / "tours" / f"{n}.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None

    def save_tour(self, book_id: str, n: int, tour: dict) -> None:
        path = self.root / book_id / "tours" / f"{n}.json"
        path.write_text(json.dumps(tour, ensure_ascii=False), encoding="utf-8")

    def recaps(self, book_id: str, before: int, limit: int = 14) -> list[tuple[int, str]]:
        """Recaps of the parts before `before` that have been read, the latest ones last."""
        found = []
        for n in range(before):
            tour = self.tour(book_id, n)
            if tour and tour.get("recap"):
                found.append((n, tour["recap"]))
        return found[-limit:]

    # ---------- search ----------

    def _index(self, book_id: str) -> list[tuple[int, str, Counter]]:
        if book_id not in self._chunks:
            meta = self.get(book_id)
            chunks = []
            for n in range(len(meta["parts"])):
                text = self.part_text(book_id, n)
                buf: list[str] = []
                for para in text.split("\n\n"):
                    buf.append(para)
                    if sum(len(p) for p in buf) > 1100:
                        chunk = "\n\n".join(buf)
                        chunks.append((n, chunk, Counter(_tokens(chunk))))
                        buf = []
                if buf:
                    chunk = "\n\n".join(buf)
                    chunks.append((n, chunk, Counter(_tokens(chunk))))
            self._chunks[book_id] = chunks
        return self._chunks[book_id]

    def search(self, book_id: str, query: str, upto: int | None = None, k: int = 6) -> list[tuple[int, str]]:
        """BM25 over ~1000-character chunks; `upto` limits results to parts the reader has reached."""
        chunks = [c for c in self._index(book_id) if upto is None or c[0] <= upto]
        terms = set(_tokens(query))
        if not chunks or not terms:
            return []
        n = len(chunks)
        avg = sum(sum(c[2].values()) for c in chunks) / n or 1
        df = {t: sum(1 for c in chunks if t in c[2]) for t in terms}
        scored = []
        for part, text, tf in chunks:
            length = sum(tf.values()) or 1
            score = 0.0
            for t in terms:
                if tf[t]:
                    idf = math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5))
                    score += idf * tf[t] * 2.2 / (tf[t] + 1.2 * (0.25 + 0.75 * length / avg))
            if score > 0:
                scored.append((score, part, text))
        scored.sort(key=lambda s: -s[0])
        return [(part, text) for _, part, text in scored[:k]]
