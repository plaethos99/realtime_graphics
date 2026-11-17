"""HTML / XHTML to a flat list of blocks (headings, paragraphs, page breaks), shared by EPUB, MOBI and HTML."""
from __future__ import annotations

import re
from html.parser import HTMLParser

Block = tuple[str, str]  # ("h1".."h6" | "p" | "break" | "anchor", text or element id)

_BLOCK_TAGS = {
    "p", "div", "br", "li", "tr", "blockquote", "section", "article", "pre", "dd", "dt", "table",
    "ul", "ol", "hr", "figure", "figcaption", "aside", "header", "footer", "nav", "td", "th", "body",
}
_HEADINGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}
_SKIP = {"script", "style", "head", "svg", "noscript", "math"}
_BREAKS = {"mbp:pagebreak", "pagebreak"}


class _Extractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[Block] = []
        self._text: list[str] = []
        self._heading = 0
        self._skip = 0

    def _flush(self) -> None:
        text = " ".join("".join(self._text).split())
        self._text = []
        if text:
            self.blocks.append((f"h{self._heading}" if self._heading else "p", text))

    def _anchor(self, attrs) -> None:
        # Element ids mark where table-of-contents links land ("chapter.xhtml#ch11").
        for key, value in attrs:
            if key in ("id", "name") and value and not self._skip:
                self.blocks.append(("anchor", value))

    def _image(self, attrs) -> None:
        # Alt text carries formulas in many ebooks (math drawn as images); skip it in headings.
        alt = dict(attrs).get("alt") or ""
        if alt.strip() and not self._skip and not self._heading and not re.fullmatch(r"\[?(illustration|image|figure)\]?", alt.strip(), re.I):
            self._text.append(f" {alt.strip()} ")

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in _BLOCK_TAGS or tag in _HEADINGS:
            self._flush()
        self._anchor(attrs)
        if tag == "img":
            self._image(attrs)
        if tag in _SKIP:
            self._skip += 1
        elif tag in _HEADINGS:
            self._flush()
            self._heading = _HEADINGS[tag]
        elif tag in _BREAKS:
            self._flush()
            self.blocks.append(("break", ""))
        elif tag in _BLOCK_TAGS:
            self._flush()
            if tag == "li":
                self._text.append("• ")

    def handle_startendtag(self, tag: str, attrs) -> None:
        self._anchor(attrs)
        if tag == "img":
            self._image(attrs)
        if tag in _BREAKS:
            self._flush()
            self.blocks.append(("break", ""))
        elif tag in ("br", "hr"):
            self._flush()

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP:
            self._skip = max(0, self._skip - 1)
        elif tag in _HEADINGS:
            self._flush()
            self._heading = 0
        elif tag in _BLOCK_TAGS:
            self._flush()

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self._text.append(data)

    def close(self) -> None:
        super().close()
        self._flush()


def html_to_blocks(html: str) -> list[Block]:
    parser = _Extractor()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # malformed markup: keep what was read
        parser._flush()
    return parser.blocks


def html_title(html: str) -> str:
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    return " ".join(re.sub(r"<[^>]+>", "", m.group(1)).split()) if m else ""
