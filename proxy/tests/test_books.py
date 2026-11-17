"""Book parsing, the library, and streamed walkthrough extraction. Sample files are generated here."""
import io
import json
import struct
import zipfile

import pytest
from PIL import Image

from app.books.formats import BookError, parse_book, parse_pasted
from app.books.library import Library, _split_text
from app.books.reader import BeatStream


# ---------- sample file builders ----------

def make_pdf(pages: list[str]) -> bytes:
    """A tiny text PDF (Helvetica, one line per text line). Lines must not contain parentheses."""
    objects = {1: b"<< /Type /Catalog /Pages 2 0 R >>"}
    kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(len(pages)))
    objects[2] = f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode()
    objects[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    for i, text in enumerate(pages):
        stream = ("BT /F1 12 Tf 72 720 Td 14 TL " + " ".join(f"({line}) Tj T*" for line in text.split("\n")) + " ET").encode()
        objects[4 + 2 * i] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> "
            f"/Contents {5 + 2 * i} 0 R >>"
        ).encode()
        objects[5 + 2 * i] = b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"
    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for k in sorted(objects):
        offsets[k] = len(out)
        out += f"{k} 0 obj\n".encode() + objects[k] + b"\nendobj\n"
    xref = len(out)
    size = max(objects) + 1
    out += f"xref\n0 {size}\n0000000000 65535 f \n".encode()
    for k in range(1, size):
        out += f"{offsets[k]:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def make_mobi(html: str, title: str = "Sea Story", author: str = "A. Writer", encryption: int = 0) -> bytes:
    """A PalmDOC-compressed MOBI with an EXTH author record."""
    raw = html.encode("utf-8")

    def compress(chunk: bytes) -> bytes:  # literal-only PalmDOC: valid, just not small
        out = bytearray()
        for b in chunk:
            if b == 0 or 0x09 <= b <= 0x7F:
                out.append(b)
            else:
                out += bytes([1, b])
        return bytes(out)

    text_records = [compress(raw[i : i + 4096]) for i in range(0, len(raw), 4096)]
    header = bytearray(16 + 0xE8)
    struct.pack_into(">HHLHHHH", header, 0, 2, 0, len(raw), len(text_records), 4096, encryption, 0)
    header[16:20] = b"MOBI"
    struct.pack_into(">LLL", header, 20, 0xE8, 2, 65001)
    struct.pack_into(">L", header, 128, 0x40)
    exth_rec = struct.pack(">LL", 100, 8 + len(author.encode())) + author.encode()
    exth = b"EXTH" + struct.pack(">LL", 12 + len(exth_rec), 1) + exth_rec
    name = title.encode()
    struct.pack_into(">LL", header, 84, len(header) + len(exth), len(name))
    rec0 = bytes(header) + exth + name + b"\x00\x00"
    records = [rec0, *text_records]
    pdb = bytearray(78)
    pdb[:len(name)] = name
    pdb[60:68] = b"BOOKMOBI"
    struct.pack_into(">H", pdb, 76, len(records))
    offset = 78 + 8 * len(records) + 2
    table = bytearray()
    for i, rec in enumerate(records):
        table += struct.pack(">LL", offset, i)
        offset += len(rec)
    return bytes(pdb) + bytes(table) + b"\x00\x00" + b"".join(records)


def make_zip(files: dict[str, bytes | str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


def png(color: str) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (40, 60), color).save(out, format="PNG")
    return out.getvalue()


STORY = "<html><body><h1>Chapter 1: The Harbour</h1><p>Mara waits by the lighthouse.</p>" \
        "<h1>Chapter 2: The Boat</h1><p>Tomas says the boat was sold to Elric.</p></body></html>"


# ---------- formats ----------

def test_plain_text_finds_chapters():
    book = parse_book(b"CHAPTER ONE\n\nIt was dark.\n\nCHAPTER TWO\n\nMorning came.", "story.txt")
    assert [c.title for c in book.chapters] == ["CHAPTER ONE", "CHAPTER TWO"]
    assert book.title == "story"


def test_markdown_and_pasted_text():
    book = parse_book(b"# Intro\n\nHello.\n\n# Method\n\nDo this.", "notes.md")
    assert [c.title for c in book.chapters] == ["Intro", "Method"]
    pasted = parse_pasted("My notes\n\nSome text here.")
    assert pasted.title == "My notes" and pasted.format == "pasted text"


def test_html_rtf_and_encodings():
    assert [c.title for c in parse_book(STORY.encode(), "s.html").chapters] == ["Chapter 1: The Harbour", "Chapter 2: The Boat"]
    rtf = parse_book(rb"{\rtf1\ansi{\fonttbl{\f0 Arial;}}Caf\'e9 one\par Two}", "d.rtf")
    assert rtf.chapters[0].text == "Café one\n\nTwo"
    latin1 = parse_book("Déjà vu.".encode("cp1252"), "old.txt")
    assert "Déjà" in latin1.chapters[0].text


def test_epub_uses_spine_and_toc():
    opf = (
        '<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
        "<dc:title>Sea Story</dc:title><dc:creator>A. Writer</dc:creator></metadata><manifest>"
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
        '<item id="a" href="text/a.xhtml" media-type="application/xhtml+xml"/>'
        '<item id="b" href="text/b.xhtml" media-type="application/xhtml+xml"/></manifest>'
        '<spine><itemref idref="a"/><itemref idref="b"/></spine></package>'
    )
    nav = '<html><body><nav><a href="text/a.xhtml">The Harbour</a><a href="text/b.xhtml#x">The Boat</a></nav></body></html>'
    data = make_zip({
        "mimetype": "application/epub+zip",
        "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OEBPS/c.opf"/></rootfiles></container>',
        "OEBPS/c.opf": opf,
        "OEBPS/nav.xhtml": nav,
        "OEBPS/text/a.xhtml": "<html><body><p>Mara waits.</p></body></html>",
        "OEBPS/text/b.xhtml": "<html><body><p>The boat is sold.</p></body></html>",
    })
    book = parse_book(data, "x.epub")
    assert (book.title, book.author) == ("Sea Story", "A. Writer")
    assert [c.title for c in book.chapters] == ["The Harbour", "The Boat"]


def test_epub_with_drm_is_refused():
    data = make_zip({
        "mimetype": "application/epub+zip",
        "META-INF/container.xml": '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>',
        "META-INF/encryption.xml": "<encryption><EncryptedData><EncryptionMethod Algorithm='adept'/></EncryptedData></encryption>",
        "c.opf": "<package/>",
    })
    with pytest.raises(BookError, match="DRM"):
        parse_book(data, "locked.epub")


def test_kindle_mobi_and_drm():
    book = parse_book(make_mobi(STORY.replace("Mara", "Mára")), "sea.azw3")
    assert (book.title, book.author, book.format) == ("Sea Story", "A. Writer", "azw3")
    assert [c.title for c in book.chapters] == ["Chapter 1: The Harbour", "Chapter 2: The Boat"]
    assert "Mára" in book.chapters[0].text
    with pytest.raises(BookError, match="DRM"):
        parse_book(make_mobi(STORY, encryption=2), "locked.azw")


def test_text_pdf_and_scanned_pdf():
    book = parse_book(make_pdf(["Chapter one", "The harbour at dawn.\nMara waits."]), "doc.pdf")
    assert book.format == "pdf"
    assert "Mara waits" in book.chapters[0].text

    pages = [Image.new("RGB", (200, 300), c) for c in ("white", "gray", "white", "gray")]
    out = io.BytesIO()
    pages[0].save(out, format="PDF", save_all=True, append_images=pages[1:])
    scanned = parse_book(out.getvalue(), "scan.pdf")
    assert scanned.image_source == "pdf"
    assert [c.pages for c in scanned.chapters] == [[0, 1, 2], [3]]


def test_docx_fb2_odt_cbz():
    w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    doc = (
        f'<w:document xmlns:w="{w}"><w:body>'
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Habits</w:t></w:r></w:p>'
        "<w:p><w:r><w:t>Start small.</w:t></w:r></w:p>"
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Systems</w:t></w:r></w:p>'
        "<w:p><w:r><w:t>Design the environment.</w:t></w:r></w:p></w:body></w:document>"
    )
    assert [c.title for c in parse_book(make_zip({"word/document.xml": doc}), "h.docx").chapters] == ["Habits", "Systems"]

    fb2 = (
        '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info>'
        "<author><first-name>Anna</first-name><last-name>K</last-name></author><book-title>Tale</book-title>"
        "</title-info></description><body><section><title><p>One</p></title><p>First.</p></section>"
        "<section><title><p>Two</p></title><p>Second.</p></section></body></FictionBook>"
    )
    book = parse_book(fb2.encode(), "tale.fb2")
    assert (book.title, book.author, [c.title for c in book.chapters]) == ("Tale", "Anna K", ["One", "Two"])

    odt = (
        '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
        'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>'
        '<text:h text:outline-level="1">A</text:h><text:p>x</text:p><text:h text:outline-level="1">B</text:h>'
        "<text:p>y</text:p></office:text></office:body></office:document-content>"
    )
    assert [c.title for c in parse_book(make_zip({"mimetype": "application/vnd.oasis.opendocument.text", "content.xml": odt}), "a.odt").chapters] == ["A", "B"]

    comic = parse_book(make_zip({f"p{i}.png": png("red") for i in (10, 2, 1, 3)}), "c.cbz")
    assert comic.image_source == "cbz" and [c.pages for c in comic.chapters] == [[0, 1, 2], [3]]


@pytest.mark.parametrize(
    "data,name,message",
    [
        (b"\xeaDRMION" + b"0" * 100, "k.kfx", "KFX"),
        (b"AT&TFORM" + b"0" * 100, "a.djvu", "DjVu"),
        (b"Rar!" + b"0" * 100, "a.cbr", "RAR"),
        (b"anything", "app.azw2", "AZW2"),
        (b"\x00\x01\x02" * 50, "x.bin", "can't read"),
        (b"", "empty.txt", "empty"),
    ],
)
def test_unsupported_files_say_why(data, name, message):
    with pytest.raises(BookError, match=message):
        parse_book(data, name)


# ---------- library ----------

def test_split_text_respects_limit():
    text = "\n\n".join(f"Paragraph {i} " + "word " * 300 for i in range(40))
    pieces = _split_text(text, 16_000)
    assert len(pieces) > 1 and all(len(p) <= 16_000 for p in pieces)
    assert "".join(pieces).replace("\n", "") == text.replace("\n", "")


def test_library_add_search_progress(tmp_path):
    lib = Library(tmp_path)
    book = parse_book(STORY.encode(), "sea.html")
    meta = lib.add(book, STORY.encode(), "sea.html")
    assert meta.pop("new") is True
    assert len(meta["parts"]) == 2 and lib.add(book, STORY.encode(), "sea.html")["id"] == meta["id"]  # same file: same book
    assert lib.search(meta["id"], "who bought the boat Elric")[0][0] == 1
    assert lib.search(meta["id"], "Elric", upto=0) == []  # spoiler guard
    assert lib.update(meta["id"], progress=5, genre="fiction")["progress"] == 1
    lib.save_tour(meta["id"], 0, {"beats": [{"say": "hi", "scene": None}], "recap": "Mara waits."})
    assert lib.recaps(meta["id"], 1) == [(0, "Mara waits.")]
    assert lib.get(meta["id"])["parts"][0]["toured"] is True
    assert [b["id"] for b in lib.list()] == [meta["id"]]
    lib.delete(meta["id"])
    assert lib.list() == []


def test_library_renders_scanned_pages(tmp_path):
    pages = [Image.new("RGB", (200, 300), "white") for _ in range(4)]
    out = io.BytesIO()
    pages[0].save(out, format="PDF", save_all=True, append_images=pages[1:])
    lib = Library(tmp_path)
    meta = lib.add(parse_book(out.getvalue(), "scan.pdf"), out.getvalue(), "scan.pdf")
    images = lib.part_images(meta["id"], 1)
    assert len(images) == 1 and images[0][:2] == b"\xff\xd8"  # one JPEG page


# ---------- streamed walkthrough ----------

def test_beat_stream_emits_each_beat_once_complete():
    reply = json.dumps({"beats": [{"say": "One {brace} \"q\"", "scene": {"title": "a]"}}, {"say": "Two", "scene": None}], "recap": "r"})
    stream = BeatStream()
    found = []
    for i in range(0, len(reply), 7):
        found += stream.feed(reply[i : i + 7])
    assert [json.loads(b)["say"] for b in found] == ['One {brace} "q"', "Two"]
    assert stream.done


def test_beat_stream_recovers_from_a_missing_brace():
    # Seen live: the first beat's scene is missing one closing brace before the next beat starts.
    reply = (
        '{"beats": [{"say": "One", "scene": {"title": "a", "panel": {"type": "diagram", "elements": []}}, '
        '{"say": "Two", "scene": null}], "recap": "Covered one and two."}'
    )
    stream = BeatStream()
    found = []
    for i in range(0, len(reply), 5):
        found += stream.feed(reply[i : i + 5])
    found += stream.finish()
    from app.pipeline import parse_json_object

    beats = [parse_json_object(b) for b in found]
    assert [b["say"] for b in beats] == ["One", "Two"]
    assert beats[0]["scene"]["panel"]["type"] == "diagram"


# ---------- lessons from real Project Gutenberg files ----------

def test_epub_toc_links_into_one_big_file_and_gutenberg_is_stripped():
    body = "".join(
        f'<h2 id="c{i}"><img alt="A caption {i}."/>CHAPTER {r}.</h2><p>{"Words of chapter %d. " % i * 40}</p>'
        for i, r in enumerate(["I", "II", "III"], start=1)
    )
    html = (
        "<html><body><p>*** START OF THE PROJECT GUTENBERG EBOOK SEA ***</p>" + body
        + "<p>*** END OF THE PROJECT GUTENBERG EBOOK SEA ***</p><p>Project Gutenberg licence text.</p></body></html>"
    )
    nav = '<html><body><nav epub:type="toc"><ol>' + "".join(
        f'<li><a href="book.xhtml#c{i}">A caption {i}. CHAPTER {r}.</a></li>' for i, r in enumerate(["I", "II", "III"], start=1)
    ) + '</ol></nav><nav epub:type="landmarks"><ol><li><a href="book.xhtml">Start</a></li></ol></nav></body></html>'
    opf = (
        '<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
        "<dc:title>Sea</dc:title></metadata><manifest>"
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
        '<item id="b" href="book.xhtml" media-type="application/xhtml+xml"/></manifest>'
        '<spine><itemref idref="b"/></spine></package>'
    )
    data = make_zip({
        "mimetype": "application/epub+zip",
        "META-INF/container.xml": '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>',
        "c.opf": opf, "nav.xhtml": nav, "book.xhtml": html,
    })
    book = parse_book(data, "sea.epub")
    assert [c.title for c in book.chapters] == ["CHAPTER I.", "CHAPTER II.", "CHAPTER III."]
    assert all("licence" not in c.text for c in book.chapters)


def test_page_break_sections_find_headings_under_captions():
    filler = "<p>" + "Plain sentence here. " * 30 + "</p>"
    html = (
        "<p>Preface words.</p>" + filler + "<mbp:pagebreak/>"
        "<p>“A caption under a picture”</p><p>CHAPTER I.</p>" + filler + "<mbp:pagebreak/>"
        "<p>“Another caption”</p>" + filler + "<mbp:pagebreak/>"
        "<p>CHAPTER II.</p>" + filler
    )
    book = parse_book(make_mobi("<html><body>" + html + "</body></html>"), "x.mobi")
    assert [c.title for c in book.chapters][-2:] == ["CHAPTER I.", "CHAPTER II."]


def test_gutenberg_plain_text_header_and_caps_headings():
    text = (
        "The Project Gutenberg eBook of Calm\n\nTitle: Calm Mind\n\nAuthor: J. Writer\n\n"
        "*** START OF THE PROJECT GUTENBERG EBOOK CALM MIND ***\n\n"
        "THOUGHT AND CHARACTER\n\nThe mind shapes the life.\n\n"
        "SERENITY\n\nCalmness is wisdom.\n\n"
        "*** END OF THE PROJECT GUTENBERG EBOOK CALM MIND ***\n\nSection 1. Licence terms."
    )
    book = parse_book(text.encode(), "pg123.txt")
    assert (book.title, book.author) == ("Calm Mind", "J. Writer")
    assert [c.title for c in book.chapters] == ["THOUGHT AND CHARACTER", "SERENITY"]
