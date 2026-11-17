"""HTTP API used by the desktop and Android clients.

POST /ask     multipart: payload (JSON), screenshot (image), audio (optional) -> NDJSON event stream
GET  /tts     ?text=&voice=&rate= -> audio/mpeg stream (edge-tts)
GET  /voices  edge-tts voice list
GET  /health  which services are configured

Books (see app/books):
POST   /books                         multipart: file, or text + title, or url (web page, book file, video) -> book
GET    /books                         library list
GET    /books/{id}                    book with its reading parts
PATCH  /books/{id}                    JSON {genre?, progress?, title?, author?}
DELETE /books/{id}
GET    /books/{id}/parts/{n}/text     plain text of a part
GET    /books/{id}/parts/{n}/tour     NDJSON: beat*, recap, done (cached after the first time)
POST   /books/{id}/ask                like /ask, answered from the book; payload adds "position"

Recording sessions (see app/sessions.py):
POST   /sessions                      JSON {mode: "watch" | "meeting"} -> {id}
POST   /sessions/{id}/audio           multipart: audio (WAV chunk), source (mic|system), offset (seconds)
POST   /sessions/{id}/frame           multipart: image, offset
GET    /sessions/{id}                 transcript so far
POST   /sessions/{id}/finish          summary + scene; the session is saved to the library
POST   /ask                           payload.session_id adds the session's recent transcript
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse

from .books.formats import BookError, parse_book, parse_pasted
from .books.library import Library
from .books.reader import BookReader, tour_event_json
from .books.video import is_video_url, video_transcript
from .books.web import fetch, parse_download
from .config import load_settings
from .pipeline import AskInput, AskPipeline
from .services import stream_tts
from .sessions import Sessions, lines_json

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

settings = load_settings()
pipeline = AskPipeline(settings)
library = Library(settings.library_dir)
reader = BookReader(settings, pipeline.llm, library)
sessions = Sessions(pipeline.stt, pipeline.llm, library)
MAX_BOOK_BYTES = 300 * 1024 * 1024
app = FastAPI(title="Realtime graphics proxy")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["*"],
)

_voices_cache: list[dict] | None = None


def require_token(request: Request) -> None:
    if not settings.app_token:
        return
    supplied = request.headers.get("x-app-token") or request.query_params.get("token")
    if supplied != settings.app_token:
        raise HTTPException(status_code=401, detail="Missing or wrong app token")


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "mock": settings.mock,
        "stt": settings.stt_enabled,
        "model": settings.deepseek_model,
        "voice": settings.tts_voice,
        "auth": bool(settings.app_token),
    }


@app.post("/ask", dependencies=[Depends(require_token)])
async def ask(
    payload: str = Form("{}"),
    screenshot: UploadFile | None = File(None),
    audio: UploadFile | None = File(None),
) -> StreamingResponse:
    try:
        body = json.loads(payload or "{}")
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"payload is not JSON: {e}") from e

    # Read uploads now: they are closed once this handler returns.
    req = AskInput(
        question=str(body.get("question") or ""),
        history=[t for t in body.get("history") or [] if isinstance(t, dict)],
        current_scene=body.get("current_scene") if isinstance(body.get("current_scene"), dict) else None,
        image=await screenshot.read() if screenshot else None,
    )
    session_id = str(body.get("session_id") or "")
    if session_id in sessions.active:
        req.context = sessions.context(session_id)
    if audio:
        req.audio = await audio.read()
        req.audio_name = audio.filename or "speech.webm"
        req.audio_type = audio.content_type or "audio/webm"

    async def events():
        async for event in pipeline.run(req):
            yield json.dumps(event, separators=(",", ":")) + "\n"

    return StreamingResponse(events(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


@app.get("/tts", dependencies=[Depends(require_token)])
async def tts(
    text: str = Query(..., min_length=1, max_length=800),
    voice: str | None = None,
    rate: str | None = None,
) -> StreamingResponse:
    return StreamingResponse(
        stream_tts(text, voice or settings.tts_voice, rate or settings.tts_rate),
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/voices", dependencies=[Depends(require_token)])
async def voices(locale: str | None = None) -> list[dict]:
    global _voices_cache
    if _voices_cache is None:
        import edge_tts

        _voices_cache = [
            {"name": v["ShortName"], "locale": v["Locale"], "gender": v["Gender"]}
            for v in await edge_tts.list_voices()
        ]
    if locale:
        return [v for v in _voices_cache if v["locale"].lower().startswith(locale.lower())]
    return _voices_cache


# ---------- books ----------

def _book_or_404(book_id: str) -> dict:
    try:
        return library.get(book_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="No such book") from None


@app.post("/books", dependencies=[Depends(require_token)])
async def add_book(
    file: UploadFile | None = File(None),
    text: str = Form(""),
    title: str = Form(""),
    url: str = Form(""),
) -> dict:
    try:
        if file is not None:
            data = await file.read()
            if len(data) > MAX_BOOK_BYTES:
                raise HTTPException(status_code=413, detail="That file is over 300 MB.")
            name = file.filename or "book"
            parsed = await asyncio.to_thread(parse_book, data, name)
            meta = await asyncio.to_thread(library.add, parsed, data, name)
        elif url.strip() and is_video_url(url):
            parsed = await video_transcript(url.strip(), pipeline.stt)
            meta = await asyncio.to_thread(library.add, parsed, None, url.strip())
        elif url.strip():
            data, content_type, final_url = await fetch(url)
            parsed = await asyncio.to_thread(parse_download, data, content_type, final_url)
            meta = await asyncio.to_thread(library.add, parsed, data if parsed.image_source else None, final_url)
        elif text.strip():
            parsed = parse_pasted(text, title)
            meta = await asyncio.to_thread(library.add, parsed, None, f"{parsed.title}.txt")
        else:
            raise HTTPException(status_code=400, detail="Send a file, a link or some text.")
    except BookError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if meta.pop("new", False):
        meta = await reader.detect_genre(meta)
    return meta


@app.get("/books", dependencies=[Depends(require_token)])
async def list_books() -> list[dict]:
    return library.list()


@app.get("/books/{book_id}", dependencies=[Depends(require_token)])
async def get_book(book_id: str) -> dict:
    return _book_or_404(book_id)


@app.patch("/books/{book_id}", dependencies=[Depends(require_token)])
async def update_book(book_id: str, request: Request) -> dict:
    _book_or_404(book_id)
    body = await request.json()
    return library.update(book_id, **{k: body.get(k) for k in ("genre", "progress", "title", "author")})


@app.delete("/books/{book_id}", dependencies=[Depends(require_token)])
async def delete_book(book_id: str) -> dict:
    _book_or_404(book_id)
    library.delete(book_id)
    return {"ok": True}


@app.get("/books/{book_id}/parts/{n}/text", dependencies=[Depends(require_token)])
async def part_text(book_id: str, n: int) -> PlainTextResponse:
    meta = _book_or_404(book_id)
    if not 0 <= n < len(meta["parts"]):
        raise HTTPException(status_code=404, detail="No such part")
    return PlainTextResponse(library.part_text(book_id, n))


@app.get("/books/{book_id}/parts/{n}/tour", dependencies=[Depends(require_token)])
async def part_tour(book_id: str, n: int, fresh: bool = False) -> StreamingResponse:
    _book_or_404(book_id)

    async def events():
        async for event in reader.tour(book_id, n, fresh):
            yield tour_event_json(event)

    return StreamingResponse(events(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


@app.post("/books/{book_id}/ask", dependencies=[Depends(require_token)])
async def ask_book(
    book_id: str,
    payload: str = Form("{}"),
    audio: UploadFile | None = File(None),
) -> StreamingResponse:
    meta = _book_or_404(book_id)
    try:
        body = json.loads(payload or "{}")
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"payload is not JSON: {e}") from e
    position = max(0, min(len(meta["parts"]) - 1, int(body.get("position") or meta.get("progress") or 0)))
    req = AskInput(
        question=str(body.get("question") or ""),
        history=[t for t in body.get("history") or [] if isinstance(t, dict)],
        current_scene=body.get("current_scene") if isinstance(body.get("current_scene"), dict) else None,
    )
    if audio:
        req.audio = await audio.read()
        req.audio_name = audio.filename or "speech.webm"
        req.audio_type = audio.content_type or "audio/webm"

    async def events():
        # The question may arrive as audio, so the book context is built once it's transcribed.
        req.context_builder = lambda q: reader.question_context(book_id, q, position)
        async for event in pipeline.run(req):
            yield json.dumps(event, separators=(",", ":")) + "\n"

    return StreamingResponse(events(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


# ---------- recording sessions ----------

def _session_or_404(session_id: str):
    try:
        return sessions.get(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="No such recording (it may have finished already).") from None


@app.post("/sessions", dependencies=[Depends(require_token)])
async def start_session(request: Request) -> dict:
    body = await request.json()
    if not settings.stt_enabled:
        raise HTTPException(status_code=400, detail="Recording needs GROQ_API_KEY for transcription.")
    session = sessions.create(str(body.get("mode") or "watch"))
    return {"id": session.id, "mode": session.mode}


@app.post("/sessions/{session_id}/audio", dependencies=[Depends(require_token)])
async def session_audio(
    session_id: str,
    audio: UploadFile = File(...),
    source: str = Form("system"),
    offset: float = Form(0.0),
) -> dict:
    session = _session_or_404(session_id)
    data = await audio.read()
    try:
        lines = await sessions.add_audio(session_id, data, source, offset)
    except Exception as e:
        logging.getLogger("rtg.sessions").warning("chunk transcription failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Transcription failed: {e}") from e
    return {"lines": lines_json(session, lines)}


@app.post("/sessions/{session_id}/frame", dependencies=[Depends(require_token)])
async def session_frame(session_id: str, image: UploadFile = File(...), offset: float = Form(0.0)) -> dict:
    _session_or_404(session_id)
    sessions.add_frame(session_id, await image.read(), offset)
    return {"ok": True}


@app.get("/sessions/{session_id}", dependencies=[Depends(require_token)])
async def get_session(session_id: str) -> dict:
    session = _session_or_404(session_id)
    return {"id": session.id, "mode": session.mode, "started": session.started, "lines": lines_json(session, session.lines)}


@app.post("/sessions/{session_id}/finish", dependencies=[Depends(require_token)])
async def finish_session(session_id: str) -> dict:
    _session_or_404(session_id)
    return await sessions.finish(session_id)
