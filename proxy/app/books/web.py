"""Reading from a URL: fetch the page (or a book file), and pull the readable article out of a web page.

Requests to private, loopback and link-local addresses are refused, so a proxy reachable from the
internet can't be used to probe the network it runs on.
"""
from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from html import unescape
from urllib.parse import unquote, urljoin, urlparse

import httpx

from .formats import BookError, Chapter, ParsedBook, blocks_to_chapters, blocks_to_text, parse_book
from .html_text import Block, html_title, html_to_blocks

MAX_BYTES = 80 * 1024 * 1024
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
SINGLE_PART_CHARS = 16_000

# Page furniture around the article: menus, headers, footers, sidebars, forms, embeds.
_FURNITURE = re.compile(
    r"<(nav|header|footer|aside|form|button|iframe|noscript|template|dialog|figure)\b[^>]*>.*?</\1\s*>",
    re.S | re.I,
)
_COMMENTS = re.compile(r"<!--.*?-->", re.S)


def _check_address(url: str) -> None:
    parts = urlparse(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise BookError("Use a full web address starting with http:// or https://.")
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
    except socket.gaierror as e:
        raise BookError(f"Couldn't find the site {parts.hostname}.") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise BookError("That address is on a private network, so it can't be fetched.")


async def fetch(url: str) -> tuple[bytes, str, str]:
    """Download `url` (following up to 5 redirects, each checked). Returns (body, content type, final URL)."""
    url = url.strip()
    if not re.match(r"(?i)https?://", url):
        url = "https://" + url
    async with httpx.AsyncClient(follow_redirects=False, timeout=25, headers={"User-Agent": USER_AGENT, "Accept-Language": "en"}) as client:
        for _ in range(6):
            await asyncio.to_thread(_check_address, url)
            try:
                async with client.stream("GET", url) as response:
                    if response.is_redirect and response.headers.get("location"):
                        url = urljoin(url, response.headers["location"])
                        continue
                    if response.status_code in (401, 403):
                        raise BookError("That page needs a login or blocks automated reading. Open it in your browser and ask with the hotkey, or copy the text and use Paste text.")
                    if response.status_code >= 400:
                        raise BookError(f"The site answered with an error ({response.status_code}).")
                    chunks, size = [], 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > MAX_BYTES:
                            raise BookError("That file is over 80 MB.")
                        chunks.append(chunk)
                    return b"".join(chunks), response.headers.get("content-type", ""), str(response.url)
            except httpx.HTTPError as e:
                raise BookError(f"Couldn't download the page ({type(e).__name__}).") from e
    raise BookError("The page redirects too many times.")


def _meta(html: str, *names: str) -> str:
    for name in names:
        m = re.search(rf'<meta[^>]+(?:name|property)=["\']{re.escape(name)}["\'][^>]*content=["\']([^"\']+)', html, re.I) or re.search(
            rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:name|property)=["\']{re.escape(name)}["\']', html, re.I
        )
        if m:
            return unescape(" ".join(m.group(1).split()))
    return ""


def _main_region(html: str) -> str:
    """The <article> or <main> element when the page has one with real text, else the whole page."""
    for tag in ("article", "main"):
        start = re.search(rf"<{tag}\b", html, re.I)
        end = html.lower().rfind(f"</{tag}>")
        if start and end > start.start():
            region = html[start.start() : end]
            if len(re.sub(r"<[^>]+>", "", region)) > 800:
                return region
    m = re.search(r'<[a-z]+[^>]+role=["\']main["\']', html, re.I)
    return html[m.start() :] if m else html


def _merge_small(chapters: list[Chapter], target: int = 8_000) -> list[Chapter]:
    """Articles have many short sections; join neighbours so each reading part has some substance."""
    merged: list[Chapter] = []
    for c in chapters:
        if merged and len(merged[-1].text) < target and len(merged[-1].text) + len(c.text) < SINGLE_PART_CHARS:
            prev = merged[-1]
            prev.text = f"{prev.text}\n\n{c.title}\n\n{c.text}"
            if "…" not in prev.title:
                prev.title = f"{prev.title} …"
        else:
            merged.append(Chapter(title=c.title, text=c.text))
    return merged


_BACK_MATTER = re.compile(r"^(references|external links|further reading|see also|notes|bibliography|sources|citations|footnotes|comments)\b", re.I)


def _drop_back_matter(blocks: list[Block]) -> list[Block]:
    """Cut reference lists, link lists and comment sections (a heading such as "References" and what follows it)."""
    out: list[Block] = []
    skipping_level = 0
    for kind, text in blocks:
        if kind.startswith("h") and kind != "h":
            level = int(kind[1])
            if skipping_level and level <= skipping_level:
                skipping_level = 0
            if not skipping_level and _BACK_MATTER.match(text.strip()):
                skipping_level = level
                continue
        if not skipping_level:
            out.append((kind, text))
    return out


def article_from_html(html: str, url: str) -> ParsedBook:
    site = _meta(html, "og:site_name")
    title = _meta(html, "og:title", "twitter:title") or unescape(html_title(html)) or urlparse(url).hostname or "Web page"
    if site and title.endswith((f" - {site}", f" | {site}", f" — {site}")):
        title = title[: -len(site) - 3].strip()
    # "Ohm's law - Wikipedia": a trailing site name that matches the domain.
    m = re.match(r"(.+?)\s+[-|—]\s+([^-|—]{2,40})$", title)
    host = (urlparse(url).hostname or "").lower().replace("www.", "")
    if m and re.sub(r"\W", "", m.group(2).lower()) in host.replace(".", ""):
        site = site or m.group(2)
        title = m.group(1)
    author = _meta(html, "author", "article:author", "parsely-author")
    if author == site:
        author = ""
    region = _FURNITURE.sub(" ", _COMMENTS.sub(" ", _main_region(html)))
    blocks = _drop_back_matter(html_to_blocks(region))
    # Drop interface crumbs ("Share", "Subscribe", "Read more") but keep headings and real sentences.
    blocks = [b for b in blocks if b[0] != "p" or len(b[1]) >= 40 or re.search(r"[.!?:”\"]$", b[1])]
    text = blocks_to_text(blocks)
    if len(text) < 300:
        raise BookError(
            "Couldn't find readable text on this page. It may need a browser to load it, or a login. "
            "Open it and ask with the hotkey, or copy the text and use Paste text."
        )
    if len(text) <= SINGLE_PART_CHARS:
        chapters = [Chapter(title=title, text=text)]
    else:
        chapters = _merge_small(blocks_to_chapters(blocks, title))
        # Sections without a heading of their own (the lead, an essay with no headings) take the page title.
        headings = {t for k, t in blocks if k.startswith("h")}
        for c in chapters:
            if not any(h.startswith(c.title.rstrip(" …")) for h in headings):
                c.title = title
    return ParsedBook(title=title, author=author, format="web page", chapters=chapters, link=url)


def parse_download(data: bytes, content_type: str, url: str) -> ParsedBook:
    """A fetched URL: web pages become articles; PDFs, EPUBs and other book files are parsed as books."""
    head = data[:1024].lstrip().lower()
    is_html = "html" in content_type.lower() or head.startswith((b"<!doctype html", b"<html")) or b"<html" in head
    if is_html and not head.startswith(b"%pdf"):
        charset = re.search(r"charset=([\w-]+)", content_type, re.I) or re.search(rb'<meta[^>]+charset=["\']?([\w-]+)', data[:4096], re.I)
        encoding = (charset.group(1).decode() if isinstance(charset.group(1), bytes) else charset.group(1)) if charset else "utf-8"
        try:
            html = data.decode(encoding, "replace")
        except LookupError:
            html = data.decode("utf-8", "replace")
        return article_from_html(html, url)
    name = unquote(urlparse(url).path.rsplit("/", 1)[-1]) or "download"
    book = parse_book(data, name)
    book.link = url
    return book
