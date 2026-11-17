"""Web pages and video links (no network: HTML and transcripts are given directly)."""
import pytest

from app.books.formats import BookError
from app.books.video import Segment, clock, is_video_url, transcript_book, youtube_id
from app.books.web import _check_address, article_from_html, parse_download

SENTENCE = "This sentence is part of the article and long enough to count as real text. "


def test_article_keeps_the_story_and_drops_page_furniture():
    html = (
        "<html><head><title>Ohm&#039;s law - Wikipedia</title><meta name='author' content='Wikipedia'></head><body>"
        "<nav><p>Main menu with many links that should never be read aloud to anyone.</p></nav>"
        "<header><p>Site header text that is long enough to look like a sentence.</p></header>"
        f"<main><p>Share</p><p>{SENTENCE * 6}</p><h2>Scope</h2><p>{SENTENCE * 6}</p>"
        "<h2>References</h2><p>A citation that is long enough to be kept if references were kept.</p></main>"
        "<footer><p>Footer text that is long enough to look like a sentence too.</p></footer></body></html>"
    )
    book = article_from_html(html, "https://en.wikipedia.org/wiki/Ohm%27s_law")
    assert (book.title, book.author, book.link) == ("Ohm's law", "", "https://en.wikipedia.org/wiki/Ohm%27s_law")
    text = book.chapters[0].text
    assert "Main menu" not in text and "Site header" not in text and "Footer" not in text
    assert "citation" not in text and "Share" not in text
    assert "Scope" in text


def test_pages_without_text_explain_what_to_do():
    with pytest.raises(BookError, match="Paste text"):
        article_from_html("<html><body><div id='app'></div><script>render()</script></body></html>", "https://app.example")


def test_downloaded_book_files_are_parsed_as_books():
    book = parse_download(b"CHAPTER ONE\n\nIt was dark.\n\nCHAPTER TWO\n\nMorning came.", "text/plain", "https://example.org/files/story.txt")
    assert [c.title for c in book.chapters] == ["CHAPTER ONE", "CHAPTER TWO"] and book.link.endswith("story.txt")


def test_private_addresses_are_refused():
    for url in ("http://127.0.0.1:8787/health", "http://169.254.169.254/latest", "http://10.0.0.5/", "ftp://example.org/x"):
        with pytest.raises(BookError):
            _check_address(url)


def test_video_links_are_recognised():
    assert youtube_id("https://www.youtube.com/watch?v=YlW_-hdw7hs&t=30s") == "YlW_-hdw7hs"
    assert youtube_id("https://youtu.be/YlW_-hdw7hs") == "YlW_-hdw7hs"
    assert youtube_id("https://www.youtube.com/shorts/2gP0vqBo7ks") == "2gP0vqBo7ks"
    assert is_video_url("https://vimeo.com/76979871") and not is_video_url("https://example.org/watch")
    assert clock(754) == "12:34" and clock(3725) == "1:02:05"


def test_transcript_parts_are_timed():
    segments = [Segment(t, f"words at {t} seconds.") for t in range(0, 1500, 10)]
    book = transcript_book("Talk", "Speaker", "https://youtu.be/YlW_-hdw7hs", segments, "captions (en)")
    assert [c.title for c in book.chapters] == ["0:00–9:00", "9:00–18:00", "18:00–24:50"]
    assert [c.start for c in book.chapters] == [0, 540, 1080]
    assert book.chapters[0].text.startswith("[0:00] words at 0 seconds.")
    assert "[0:30]" in book.chapters[0].text and book.format == "video transcript, captions (en)"
