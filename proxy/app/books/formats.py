"""Turn an uploaded book file (or pasted text) into chapters of plain text.

Text formats: EPUB, MOBI / AZW / AZW3 / PRC, PDF (text layer), DOCX, ODT, FB2 (and .fb2.zip), RTF,
HTML, TXT and Markdown. Image formats: scanned PDFs and CBZ comics become page images that the vision
model reads later. Formats that can't be read say why (DRM, KFX, DjVu, ...).
"""
from __future__ import annotations

import io
import posixpath
import re
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import PurePosixPath
from urllib.parse import unquote
from xml.etree import ElementTree as ET

from .html_text import Block, html_title, html_to_blocks
from .mobi import MobiError, read_mobi


class BookError(Exception):
    """A problem worth showing the user as-is."""


@dataclass
class Chapter:
    title: str
    text: str = ""
    pages: list[int] = field(default_factory=list)  # page images (scanned PDF pages / CBZ entries)
    start: float | None = None  # seconds into a video, for transcripts


@dataclass
class ParsedBook:
    title: str
    author: str
    format: str
    chapters: list[Chapter]
    image_source: str | None = None  # "pdf" or "cbz" when chapters hold page images
    link: str | None = None  # the web page or video it came from


IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp")
FRONT_MATTER = re.compile(
    r"^copyright|^cover$|^title page$|^dedication$|^also by|^about the publisher|^imprint$|^(list of )?illustrations\.?$",
    re.I,
)
# Dropped whatever their length.
ALWAYS_DROP = re.compile(r"^(table of )?contents\.?$|project gutenberg|^the full project gutenberg", re.I)
GUTENBERG_START = re.compile(r"\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG", re.I)
GUTENBERG_END = re.compile(r"\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG", re.I)


# ---------- helpers ----------

def decode_text(data: bytes) -> str:
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", "replace")
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", "replace")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("cp1252", "replace")


def _natural_key(name: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def _clean_title(text: str, limit: int = 90) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def blocks_to_text(blocks: list[Block]) -> str:
    return "\n\n".join(text for kind, text in blocks if kind not in ("break", "anchor") and text)


def strip_gutenberg(blocks: list[Block]) -> list[Block]:
    """Drop Project Gutenberg's header and licence (everything outside the START/END markers)."""
    start = next((i for i, (k, t) in enumerate(blocks) if k != "anchor" and GUTENBERG_START.search(t)), None)
    if start is not None:
        # Keep anchors from the dropped header so table-of-contents targets still resolve.
        blocks = [b for b in blocks[:start] if b[0] == "anchor"] + blocks[start + 1 :]
    end = next((i for i, (k, t) in enumerate(blocks) if k != "anchor" and GUTENBERG_END.search(t)), None)
    return blocks[:end] if end is not None else blocks


def _split_level(blocks: list[Block]) -> int | None:
    """The heading level that divides the book into chapters: the highest level used at least three times
    whose sections don't leave most of the book in one piece (title pages also use h1)."""
    total = sum(len(t) for k, t in blocks if k == "p") or 1
    best = None
    for level in range(1, 5):
        tag = f"h{level}"
        count = sum(1 for k, _ in blocks if k == tag)
        if count < 2:
            continue
        largest = current = 0
        for kind, text in blocks:
            if kind == tag:
                largest, current = max(largest, current), 0
            elif kind == "p":
                current += len(text)
        largest = max(largest, current)
        if count >= 3 and largest < total * 0.6:
            return level
        if best is None:
            best = level
    return best


def blocks_to_chapters(blocks: list[Block], fallback_title: str = "Text") -> list[Chapter]:
    """Split at the main heading level, else at page breaks (titled by a short first line)."""
    split_level = _split_level(blocks)
    chapters: list[Chapter] = []
    title, body = "", []

    def close() -> None:
        nonlocal title, body
        if not split_level and not title:
            # "CHAPTER XVIII." near the top of a page-break section, maybe under an illustration caption.
            at = next((i for i, line in enumerate(body[:4]) if _looks_like_heading(line)), None)
            if at is not None:
                if at and chapters:
                    chapters[-1].text += "\n\n" + "\n\n".join(body[:at])
                title, body = body[at], body[at + 1 :]
        text = "\n\n".join(body).strip()
        if text or title:
            # Page-break sections that don't start with a heading (illustration pages, page overflow)
            # continue the previous chapter.
            if not split_level and not title and chapters:
                chapters[-1].text += "\n\n" + text
            else:
                chapters.append(Chapter(title=_clean_title(tidy_title(title) or text[:60] or fallback_title), text=text))

    for kind, text in blocks:
        if kind == "anchor":
            continue
        is_split = (split_level and kind == f"h{split_level}") or (not split_level and kind == "break")
        if is_split:
            if body or title:
                close()
            title, body = (text if kind != "break" else ""), []
        elif kind != "break":
            if kind.startswith("h") and not title and not body:
                title = text
            else:
                body.append(text)
    close()
    chapters = [c for c in chapters if c.text]
    # In a book, tiny sections (a title page, an author line, "back") fold into the section after them.
    book_length = sum(len(c.text) for c in chapters) > 20_000
    merged: list[Chapter] = []
    for c in chapters:
        if merged and book_length and len(merged[-1].text) < 300:
            tiny = merged.pop()
            c = Chapter(title=c.title if len(c.title) <= 60 else tiny.title, text=f"{tiny.text}\n\n{c.text}")
        merged.append(c)
    return merged or [Chapter(title=fallback_title, text=blocks_to_text(blocks))]


_CHAPTER_IN_TITLE = re.compile(
    r"\b(chapter|part|book|letter|canto|act)\s+([ivxlc]+|\d+|one|two|three|four|five|six|seven|eight|nine|ten|"
    r"first|second|third|fourth|fifth|last)\b.*$",
    re.I,
)


def tidy_title(title: str) -> str:
    """'I hope Mr. Bingley will like it. CHAPTER II.' (an illustration caption in the heading) -> 'CHAPTER II.'"""
    m = _CHAPTER_IN_TITLE.search(title)
    return title[m.start() :] if m and m.start() > 0 else title


def _looks_like_heading(line: str) -> bool:
    return len(line) < 80 and (bool(_HEADING_LINE.match(line)) or _is_caps_heading(line))


_HEADING_LINE = re.compile(
    r"^(chapter|part|book|section|prologue|epilogue|introduction|preface|foreword|afterword|appendix|act|canto)\b.{0,70}$"
    r"|^[IVXLC]{1,7}\.?$|^\d{1,3}\.?$",
    re.I,
)


def _is_caps_heading(line: str) -> bool:
    """A short line in capitals ("THOUGHT AND CHARACTER"), not a shouted sentence."""
    letters = [c for c in line if c.isalpha()]
    return (
        4 <= len(letters) and len(line) <= 60
        and sum(c.isupper() for c in letters) >= len(letters) * 0.9
        and not line.rstrip().endswith(("!", "?", ","))
    )


def text_to_blocks(text: str, markdown: bool = False) -> list[Block]:
    """Paragraphs from blank-line separated text; chapter-looking lines become headings."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    blocks: list[Block] = []
    for para in re.split(r"\n\s*\n", text):
        lines = [ln.strip() for ln in para.strip().split("\n") if ln.strip()]
        if not lines:
            continue
        first = lines[0]
        md = re.match(r"^(#{1,6})\s+(.*)", first) if markdown else None
        if md:
            blocks.append((f"h{len(md.group(1))}", md.group(2).strip()))
            lines = lines[1:]
        elif len(lines) <= 2 and len(first) < 80 and _HEADING_LINE.match(first):
            blocks.append(("h2", " — ".join(lines)))
            continue
        elif len(lines) == 1 and _is_caps_heading(first):
            blocks.append(("h2", first))
            continue
        if lines:
            blocks.append(("p", " ".join(lines)))
    return blocks


# ---------- formats ----------

def _from_text(text: str, title: str, fmt: str, markdown: bool = False) -> ParsedBook:
    author = ""
    start = GUTENBERG_START.search(text)
    if start:
        # Project Gutenberg plain text: title and author are in the header; the licence follows the END line.
        header = text[: start.start()]
        m = re.search(r"^Title:\s*(.+)$", header, re.M)
        title = m.group(1).strip() if m else title
        m = re.search(r"^Author:\s*(.+)$", header, re.M)
        author = m.group(1).strip() if m else ""
        text = text[text.find("\n", start.end()) + 1 :]
    end = GUTENBERG_END.search(text)
    if end:
        text = text[: end.start()]
    blocks = text_to_blocks(text, markdown)
    if not blocks:
        raise BookError("The text is empty.")
    return ParsedBook(title=title, author=author, format=fmt, chapters=blocks_to_chapters(blocks, title))


def _epub(z: zipfile.ZipFile, title: str) -> ParsedBook:
    container = ET.fromstring(z.read("META-INF/container.xml"))
    rootfile = container.find(".//{*}rootfile")
    if rootfile is None:
        raise BookError("This EPUB has no package file.")
    opf_path = rootfile.get("full-path", "")
    opf = ET.fromstring(z.read(opf_path))
    base = posixpath.dirname(opf_path)
    if any(n.startswith("META-INF/encryption.xml") for n in z.namelist()):
        enc = z.read("META-INF/encryption.xml").decode("utf-8", "replace")
        # Font obfuscation is harmless; anything else is DRM.
        if "EncryptedData" in enc and not re.search(r"obfuscation|font", enc, re.I):
            raise BookError("This EPUB is DRM-protected, so it can't be read. Only DRM-free books work.")

    meta_title = opf.findtext(".//{*}metadata/{*}title") or title
    author = opf.findtext(".//{*}metadata/{*}creator") or ""
    manifest = {
        item.get("id"): (posixpath.normpath(posixpath.join(base, unquote(item.get("href", "")))), item.get("media-type", ""), item.get("properties", ""))
        for item in opf.iterfind(".//{*}item")
    }
    spine = [manifest[ref.get("idref")] for ref in opf.iterfind(".//{*}itemref") if ref.get("idref") in manifest]

    # The whole book as one block stream; each file and each element id leaves an anchor
    # ("text/ch1.xhtml", "text/ch1.xhtml#c11") where table-of-contents links can land.
    combined: list[Block] = []
    for href, media_type, _ in spine:
        if "html" not in media_type and not href.endswith((".html", ".xhtml", ".htm")):
            continue
        try:
            html = decode_text(z.read(href))
        except KeyError:
            continue
        combined.append(("anchor", href))
        for kind, text in html_to_blocks(html):
            combined.append(("anchor", f"{href}#{text}") if kind == "anchor" else (kind, text))
    combined = strip_gutenberg(combined)
    if not blocks_to_text(combined).strip():
        raise BookError("No readable text found in this EPUB.")

    positions: dict[str, int] = {}
    for i, (kind, value) in enumerate(combined):
        if kind == "anchor":
            positions.setdefault(value, i)
    toc = []
    for key, label, depth in _epub_toc(z, manifest):
        pos = positions.get(key, positions.get(key.split("#")[0]))  # unknown #fragment: start of its file
        if pos is not None:
            toc.append((pos, label, depth))

    chosen: list[tuple[int, str]] = []
    if toc:
        top = min(depth for _, _, depth in toc)
        top_count = sum(1 for _, _, depth in toc if depth == top)
        # A short top level ("Part One", "Part Two") also brings in the chapters under it.
        limit = top + (1 if top_count < 6 else 0)
        seen: set[int] = set()
        for pos, label, depth in sorted(toc, key=lambda t: t[0]):
            if depth <= limit and pos not in seen:
                seen.add(pos)
                chosen.append((pos, label))
    if len(chosen) < 2:
        return ParsedBook(title=meta_title.strip(), author=author.strip(), format="epub", chapters=blocks_to_chapters(combined, meta_title))

    chapters: list[Chapter] = []
    opening = blocks_to_text(combined[: chosen[0][0]])
    if len(opening) > 1500:
        chapters.append(Chapter(title="Opening", text=opening))
    for k, (pos, label) in enumerate(chosen):
        end = chosen[k + 1][0] if k + 1 < len(chosen) else len(combined)
        section = combined[pos:end]
        text = blocks_to_text(section)
        if len(text) < 80 and len(chosen) > 8:
            continue  # a part title page or a link to an image
        heading = next((t for kind, t in section if kind.startswith("h")), "")
        chapters.append(Chapter(title=_clean_title(tidy_title(label or heading) or f"Section {len(chapters) + 1}"), text=text))
    return ParsedBook(title=meta_title.strip(), author=author.strip(), format="epub", chapters=chapters or blocks_to_chapters(combined, meta_title))


class _NavParser(HTMLParser):
    """Links of the first table-of-contents <nav> in an EPUB 3 nav document, with their list depth."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.entries: list[tuple[str, str, int]] = []
        self.depth = 0
        self.nav = 0
        self.toc_nav = 0  # nesting level of the toc <nav> while inside it
        self.found = False
        self.href: str | None = None
        self.text: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        a = dict(attrs)
        if tag == "nav":
            self.nav += 1
            kind = (a.get("epub:type") or "") + " " + (a.get("role") or "")
            if not self.found and ("toc" in kind or not kind.strip()):
                self.found = True
                self.toc_nav = self.nav
        elif self.toc_nav and tag in ("ol", "ul"):
            self.depth += 1
        elif self.toc_nav and tag == "a" and a.get("href"):
            self.href, self.text = a["href"], []

    def handle_endtag(self, tag: str) -> None:
        if tag == "nav":
            if self.toc_nav == self.nav:
                self.toc_nav = 0
            self.nav -= 1
        elif self.toc_nav and tag in ("ol", "ul"):
            self.depth -= 1
        elif tag == "a" and self.href is not None:
            self.entries.append((self.href, " ".join("".join(self.text).split()), self.depth))
            self.href = None

    def handle_data(self, data: str) -> None:
        if self.href is not None:
            self.text.append(data)


def _epub_toc(z: zipfile.ZipFile, manifest: dict) -> list[tuple[str, str, int]]:
    """Table of contents as (anchor key, label, depth): EPUB 3 nav, else EPUB 2 NCX."""
    nav = next((href for href, _, props in manifest.values() if "nav" in props.split()), None)
    ncx = next((href for href, mt, _ in manifest.values() if mt == "application/x-dtbncx+xml"), None)

    def key(base_dir: str, link: str) -> str:
        path, _, frag = link.partition("#")
        full = posixpath.normpath(posixpath.join(base_dir, unquote(path)))
        return f"{full}#{unquote(frag)}" if frag else full

    try:
        if nav:
            parser = _NavParser()
            parser.feed(decode_text(z.read(nav)))
            if parser.entries:
                return [(key(posixpath.dirname(nav), href), label, depth) for href, label, depth in parser.entries]
        if ncx:
            entries: list[tuple[str, str, int]] = []

            def walk(node, depth: int) -> None:
                for point in node.findall("{*}navPoint"):
                    content = point.find("{*}content")
                    label = point.findtext("{*}navLabel/{*}text") or ""
                    if content is not None and content.get("src"):
                        entries.append((key(posixpath.dirname(ncx), content.get("src", "")), " ".join(label.split()), depth))
                    walk(point, depth + 1)

            nav_map = ET.fromstring(z.read(ncx)).find("{*}navMap")
            if nav_map is not None:
                walk(nav_map, 1)
            return entries
    except (KeyError, ET.ParseError):
        pass
    return []


def _docx(z: zipfile.ZipFile, title: str) -> ParsedBook:
    w = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    root = ET.fromstring(z.read("word/document.xml"))
    blocks: list[Block] = []
    for p in root.iter(f"{w}p"):
        style = p.find(f"{w}pPr/{w}pStyle")
        style_name = (style.get(f"{w}val") if style is not None else "") or ""
        parts = []
        for node in p.iter():
            if node.tag == f"{w}t" and node.text:
                parts.append(node.text)
            elif node.tag == f"{w}tab":
                parts.append(" ")
            elif node.tag in (f"{w}br", f"{w}cr"):
                parts.append("\n")
        text = " ".join("".join(parts).split())
        if not text:
            continue
        m = re.match(r"(?i)heading\s*(\d)", style_name)
        if m:
            blocks.append((f"h{min(6, int(m.group(1)))}", text))
        elif style_name.lower() == "title":
            title = title or text
            blocks.append(("h1", text))
        else:
            blocks.append(("p", text))
    author = ""
    try:
        core = ET.fromstring(z.read("docProps/core.xml"))
        title = core.findtext("{*}title") or title
        author = core.findtext("{*}creator") or ""
    except (KeyError, ET.ParseError):
        pass
    if not blocks:
        raise BookError("This Word document has no text.")
    return ParsedBook(title=title, author=author, format="docx", chapters=blocks_to_chapters(blocks, title))


def _odt(z: zipfile.ZipFile, title: str) -> ParsedBook:
    root = ET.fromstring(z.read("content.xml"))
    blocks: list[Block] = []
    for node in root.iter():
        tag = node.tag.split("}")[-1]
        if tag in ("h", "p"):
            text = " ".join("".join(node.itertext()).split())
            if not text:
                continue
            if tag == "h":
                level = next((v for k, v in node.attrib.items() if k.endswith("outline-level")), "1")
                blocks.append((f"h{min(6, int(level) if level.isdigit() else 1)}", text))
            else:
                blocks.append(("p", text))
    if not blocks:
        raise BookError("This document has no text.")
    return ParsedBook(title=title, author="", format="odt", chapters=blocks_to_chapters(blocks, title))


def _fb2(data: bytes, title: str) -> ParsedBook:
    root = ET.fromstring(data)
    info = root.find(".//{*}description/{*}title-info")
    if info is not None:
        title = info.findtext("{*}book-title") or title
        a = info.find("{*}author")
        if a is not None:
            author = " ".join(filter(None, (a.findtext("{*}first-name"), a.findtext("{*}middle-name"), a.findtext("{*}last-name"))))
        else:
            author = ""
    else:
        author = ""

    blocks: list[Block] = []

    def walk(section, depth: int) -> None:
        for child in section:
            tag = child.tag.split("}")[-1]
            if tag == "title":
                blocks.append((f"h{min(6, depth)}", " ".join(" ".join(child.itertext()).split())))
            elif tag == "section":
                walk(child, depth + 1)
            elif tag in ("p", "v", "subtitle", "text-author"):
                text = " ".join("".join(child.itertext()).split())
                if text:
                    blocks.append(("p", text))
            elif tag in ("poem", "stanza", "cite", "epigraph"):
                walk(child, depth)

    for body in root.findall("{*}body"):
        if body.get("name") == "notes":
            continue
        walk(body, 0)
    if not blocks:
        raise BookError("This FB2 book has no text.")
    return ParsedBook(title=title, author=author, format="fb2", chapters=blocks_to_chapters(blocks, title))


def _rtf_to_text(rtf: str) -> str:
    """Plain text from RTF: control words dropped, destinations like fonts and pictures skipped."""
    skip_dest = {"fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer", "footnote", "listtable", "listoverridetable", "themedata", "datastore", "xmlnstbl", "generator", "rsidtbl"}
    out: list[str] = []
    stack: list[tuple[bool, int]] = []
    ignorable = False
    uc_skip = 1
    skip_chars = 0
    i, n = 0, len(rtf)
    token = re.compile(r"\\([a-z]{1,32})(-?\d{1,10})? ?|\\'([0-9a-f]{2})|\\([^a-z])|([{}])|[\r\n]+|(.)", re.I | re.S)
    for m in token.finditer(rtf):
        word, arg, hexcode, symbol, brace, char = m.groups()
        if brace == "{":
            stack.append((ignorable, uc_skip))
        elif brace == "}":
            if stack:
                ignorable, uc_skip = stack.pop()
        elif symbol:
            if symbol == "*":
                ignorable = True
            elif not ignorable and symbol in "\\{}":
                out.append(symbol)
            elif not ignorable and symbol == "~":
                out.append(" ")
        elif word:
            word = word.lower()
            if word in skip_dest:
                ignorable = True
            elif ignorable:
                pass
            elif word in ("par", "line", "sect", "page"):
                out.append("\n\n" if word in ("par", "sect", "page") else "\n")
            elif word == "tab":
                out.append("\t")
            elif word == "uc":
                uc_skip = int(arg or 1)
            elif word == "u" and arg:
                code = int(arg)
                out.append(chr(code + 65536 if code < 0 else code))
                skip_chars = uc_skip
            elif word in ("emdash", "endash"):
                out.append("—" if word == "emdash" else "–")
            elif word in ("lquote", "rquote"):
                out.append("'")
            elif word in ("ldblquote", "rdblquote"):
                out.append('"')
        elif hexcode:
            if skip_chars:
                skip_chars -= 1
            elif not ignorable:
                out.append(bytes([int(hexcode, 16)]).decode("cp1252", "replace"))
        elif char:
            if skip_chars:
                skip_chars -= 1
            elif not ignorable:
                out.append(char)
    return "".join(out)


def _drop_running_heads(pages: list[str]) -> list[str]:
    """Remove headers and footers repeated on many pages ("CALCULUS MADE EASY 90", page numbers)."""
    if len(pages) < 6:
        return pages

    def norm(line: str) -> str:
        return re.sub(r"\d+", "#", line.strip().lower())

    def edges(lines: list[str]) -> set[int]:
        filled = [i for i, line in enumerate(lines) if line.strip()]
        return set(filled[:2] + filled[-2:])

    counts: Counter[str] = Counter()
    split = [page.split("\n") for page in pages]
    for lines in split:
        for key in {norm(lines[i]) for i in edges(lines)}:
            counts[key] += 1
    common = {k for k, n in counts.items() if n >= len(pages) * 0.3 and len(k) < 80}
    return ["\n".join(line for i, line in enumerate(lines) if not (i in edges(lines) and norm(line) in common)) for lines in split]


def _pdf(data: bytes, title: str) -> ParsedBook:
    import pypdfium2 as pdfium

    try:
        doc = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as e:
        if "password" in str(e).lower():
            raise BookError("This PDF is password-protected.") from e
        raise BookError(f"Couldn't open this PDF ({e}).") from e
    try:
        meta = doc.get_metadata_dict() or {}
        title = (meta.get("Title") or "").strip() or title
        author = (meta.get("Author") or "").strip()
        pages: list[str] = []
        for i in range(len(doc)):
            page = doc[i]
            textpage = page.get_textpage()
            text = textpage.get_text_range() or ""
            textpage.close()
            page.close()
            # Re-join hyphenated line breaks and single newlines inside paragraphs.
            text = text.replace("\r\n", "\n").replace("\r", "\n")
            text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
            pages.append(text.strip())
        pages = _drop_running_heads(pages)

        scanned = sum(1 for p in pages if len(p) < 20)
        if scanned > len(pages) * 0.5:
            # Image-only (scanned) PDF: the vision model reads the pages, three at a time.
            groups = [list(range(i, min(i + 3, len(pages)))) for i in range(0, len(pages), 3)]
            chapters = [Chapter(title=f"Pages {g[0] + 1}–{g[-1] + 1}", pages=g) for g in groups]
            return ParsedBook(title=title, author=author, format="pdf (scanned)", chapters=chapters, image_source="pdf")

        # Chapters from the outline (top level), otherwise ten-page sections.
        starts: list[tuple[int, str]] = []
        try:
            items = []
            for item in doc.get_toc():
                dest = item.get_dest()
                items.append((item.level, item.get_title(), dest.get_index() if dest is not None else None))
            top = min((lvl for lvl, _, pi in items if pi is not None), default=None)
            if top is not None:
                # "Front Matter / Main Matter / Back Matter" on top: use the chapters under them too.
                top_count = sum(1 for lvl, _, pi in items if lvl == top and pi is not None)
                limit = top + (1 if top_count < 6 else 0)
                starts = [(pi, tidy_title(t)) for lvl, t, pi in items if lvl <= limit and pi is not None and 0 <= pi < len(pages)]
        except Exception:
            starts = []
        starts = sorted({pi: t for pi, t in starts}.items())
        if len(starts) < 2:
            starts = [(i, f"Pages {i + 1}–{min(i + 10, len(pages))}") for i in range(0, len(pages), 10)]
        elif starts[0][0] > 0:
            starts.insert(0, (0, "Front matter"))
        chapters = []
        for k, (start, name) in enumerate(starts):
            end = starts[k + 1][0] if k + 1 < len(starts) else len(pages)
            text = "\n\n".join(p for p in pages[start:end] if p)
            text = re.sub(r"(?<![.!?:;”\"])\n(?!\n)", " ", text)  # unwrap lines, keep paragraph breaks
            if text.strip():
                chapters.append(Chapter(title=_clean_title(name or f"Pages {start + 1}–{end}"), text=text.strip()))
        if not chapters:
            raise BookError("No readable text found in this PDF.")
        return ParsedBook(title=title, author=author, format="pdf", chapters=chapters)
    finally:
        doc.close()


def _cbz(z: zipfile.ZipFile, title: str) -> ParsedBook:
    images = sorted((n for n in z.namelist() if n.lower().endswith(IMAGE_EXT) and not n.startswith("__MACOSX")), key=_natural_key)
    if not images:
        raise BookError("This comic archive has no images.")
    groups = [list(range(i, min(i + 3, len(images)))) for i in range(0, len(images), 3)]
    chapters = [Chapter(title=f"Pages {g[0] + 1}–{g[-1] + 1}", pages=g) for g in groups]
    return ParsedBook(title=title, author="", format="cbz", chapters=chapters, image_source="cbz")


def cbz_images(data: bytes) -> list[str]:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return sorted((n for n in z.namelist() if n.lower().endswith(IMAGE_EXT) and not n.startswith("__MACOSX")), key=_natural_key)


# ---------- entry points ----------

UNSUPPORTED = {
    b"AT&TFORM": "DjVu files aren't supported yet. Convert it to PDF first (for example with DjVuLibre or an online converter).",
    b"ITOLITLS": "Microsoft Reader (.lit) files aren't supported. Convert it to EPUB with Calibre first.",
    b"Rar!": "RAR archives (.cbr) aren't supported. Re-pack the comic as .cbz (a zip) first.",
    b"7z\xbc\xaf": "7-Zip archives (.cb7) aren't supported. Re-pack the comic as .cbz (a zip) first.",
}


def parse_book(data: bytes, filename: str) -> ParsedBook:
    book = _parse_book(data, filename)
    # "The Project Gutenberg eBook #33283: Calculus Made Easy" -> "Calculus Made Easy"
    book.title = re.sub(r"^the project gutenberg e-?book( #\d+)?\s*(:|of)\s*", "", book.title.strip(), flags=re.I) or book.title
    return book


def _parse_book(data: bytes, filename: str) -> ParsedBook:
    name = PurePosixPath(filename.replace("\\", "/")).name or "book"
    stem = re.sub(r"\.(fb2\.zip|[a-z0-9]+)$", "", name, flags=re.I)
    title = stem.replace("_", " ").strip() or "Untitled"
    ext = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    if not data:
        raise BookError("The file is empty.")

    for magic, message in UNSUPPORTED.items():
        if data.startswith(magic):
            raise BookError(message)
    if data.startswith(b"\xeaDRMION") or data.startswith(b"CONT\x02"):
        raise BookError(
            "This is a KFX Kindle file (the newer Amazon format), which can't be read directly. "
            "If it's DRM-free, convert it to EPUB or AZW3 with Calibre first."
        )
    if ext == "azw2":
        raise BookError("AZW2 files are Kindle apps (active content), not books, so there is nothing to read.")

    if data.startswith(b"%PDF"):
        return _pdf(data, title)
    if len(data) > 68 and data[60:68] in (b"BOOKMOBI", b"TEXtREAd"):
        try:
            book = read_mobi(data)
        except MobiError as e:
            raise BookError(str(e)) from e
        if book.pdf:
            parsed = _pdf(book.pdf, book.title or title)
            parsed.format = "azw4 (pdf)"
            return parsed
        fmt = {"azw3": "azw3", "azw": "azw", "prc": "prc"}.get(ext, "mobi")
        blocks = strip_gutenberg(html_to_blocks(book.html))
        if not blocks:
            raise BookError("No readable text found in this Kindle file.")
        return ParsedBook(title=book.title or title, author=book.author, format=fmt, chapters=blocks_to_chapters(blocks, book.title or title))
    if data.startswith(b"PK"):
        try:
            z = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as e:
            raise BookError("This zip file is damaged.") from e
        with z:
            names = set(z.namelist())
            mimetype = z.read("mimetype").decode("ascii", "replace").strip() if "mimetype" in names else ""
            if "META-INF/container.xml" in names and (mimetype == "application/epub+zip" or ext == "epub"):
                return _epub(z, title)
            if "word/document.xml" in names:
                return _docx(z, title)
            if "content.xml" in names and "opendocument" in mimetype:
                return _odt(z, title)
            fb2 = next((n for n in names if n.lower().endswith(".fb2")), None)
            if fb2:
                return _fb2(z.read(fb2), title)
            if any(n.lower().endswith(IMAGE_EXT) for n in names):
                return _cbz(z, title)
            texts = sorted(n for n in names if n.lower().endswith((".txt", ".md")))
            if texts:
                return _from_text("\n\n".join(decode_text(z.read(n)) for n in texts), title, "zip")
        raise BookError("This zip file doesn't contain a book format I can read.")

    head = data[:2048].lstrip()
    if head.startswith(b"{\\rtf"):
        return _from_text(_rtf_to_text(decode_text(data)), title, "rtf")
    text = decode_text(data)
    if b"<FictionBook" in head or ext == "fb2":
        try:
            return _fb2(data, title)
        except ET.ParseError as e:
            raise BookError(f"This FB2 file is malformed ({e}).") from e
    if ext in ("html", "htm", "xhtml") or re.match(rb"(?i)(<\?xml[^>]*>\s*)?(<!doctype html|<html)", head):
        blocks = strip_gutenberg(html_to_blocks(text))
        return ParsedBook(title=html_title(text) or title, author="", format="html", chapters=blocks_to_chapters(blocks, title))
    if b"\x00" in data[:4096] and not data.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise BookError(f"I can't read .{ext or 'this'} files. Supported: EPUB, MOBI, AZW, AZW3, PDF, DOCX, ODT, FB2, RTF, HTML, TXT, Markdown, CBZ.")
    return _from_text(text, title, "markdown" if ext in ("md", "markdown") else "text", markdown=ext in ("md", "markdown"))


def parse_pasted(text: str, title: str = "") -> ParsedBook:
    text = text.strip()
    if not text:
        raise BookError("The pasted text is empty.")
    first_line = text.split("\n", 1)[0].strip()
    return _from_text(text, title.strip() or _clean_title(first_line, 60), "pasted text", markdown=True)


def drop_front_matter(chapters: list[Chapter]) -> list[Chapter]:
    """Remove short contents/copyright/cover sections; keep everything if that would leave nothing."""
    kept = [
        c for c in chapters
        if c.pages or not (
            ALWAYS_DROP.search(c.title.strip())
            or (FRONT_MATTER.match(c.title.strip()) and len(c.text) < 4000)
            or len(re.findall(r"project gutenberg", c.text, re.I)) >= 3  # licence / boilerplate pages
        )
    ]
    return kept or chapters
