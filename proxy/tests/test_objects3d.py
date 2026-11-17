"""3D presentations: the ready-made object kit, the new shapes, and regenerating old 2D walkthroughs."""
import asyncio
import re
from dataclasses import replace
from pathlib import Path

from app.books.formats import Chapter, ParsedBook
from app.books.library import Library
from app.books.reader import TOUR_STYLE, BookReader, tour_prompt
from app.config import load_settings
from app.prompt import SYSTEM_PROMPT
from app.scene import MODELS, to_client, validate_scene

KIT_SOURCE = Path(__file__).resolve().parents[2] / "renderer" / "src" / "models.ts"


def test_model_names_match_the_renderer():
    source = KIT_SOURCE.read_text(encoding="utf-8")
    kit = source[source.index("const KIT:") : source.index("export const MODEL_NAMES")]
    assert set(re.findall(r"^  (\w+): \(", kit, re.M)) == set(MODELS)


def test_prompts_list_every_model():
    for prompt in (SYSTEM_PROMPT, tour_prompt("selfhelp")):
        assert all(name in prompt for name in MODELS)
        assert "{MODELS}" not in prompt


def test_new_shapes_survive_validation():
    raw = {
        "title": "Objects",
        "panel": {
            "type": "3d",
            "objects": [
                {"id": "car", "shape": "model", "model": "car", "size": [3], "position": [0, 0, 0], "material": "metal"},
                {"shape": "lathe", "points": [[0, 0], [0.4, 0.5], [0, 1]], "material": "glass"},
                {"shape": "extrude", "size": [0.2], "points": [[0, 0], [1, 0], [0, 1]]},
                {"shape": "tube", "size": [0.1], "points": [[0, 0, 0], [1, 1, 1]]},
            ],
        },
    }
    scene, errors = validate_scene(raw)
    assert errors is None, errors
    objects = to_client(scene, None, None)["panel"]["objects"]
    assert objects[0]["model"] == "car"
    assert objects[0]["material"] == "metal"
    assert objects[1]["points"] == [[0, 0], [0.4, 0.5], [0, 1]]


def test_panel_written_directly_on_the_scene_is_kept():
    for flat in (
        {"title": "T", "type": "3d", "objects": [{"shape": "model", "model": "car"}]},
        {"title": "T", "objects": [{"shape": "model", "model": "car"}]},
    ):
        scene, errors = validate_scene(flat)
        assert errors is None, errors
        assert scene.title == "T"
        assert scene.panel.type == "3d"
        assert scene.panel.objects[0].model == "car"


def test_beat_without_a_visual_goes_to_repair(tmp_path):
    class FakeLLM:
        calls = 0

        async def complete(self, messages, max_tokens=None):
            FakeLLM.calls += 1
            return '{"title": "T", "panel": {"type": "3d", "objects": [{"shape": "model", "model": "tree"}]}}'

    reader = BookReader(load_settings(), FakeLLM(), Library(tmp_path))
    beat = asyncio.run(reader._beat({"say": "Hello.", "scene": {"title": "T"}}))
    assert FakeLLM.calls == 1
    assert beat["scene"]["panel"]["objects"][0]["model"] == "tree"


def _beats(reader: BookReader, book_id: str) -> list[dict]:
    async def run():
        return [event async for event in reader.tour(book_id, 0)]

    return asyncio.run(run())


def test_old_walkthroughs_are_made_again(tmp_path):
    settings = replace(load_settings(), force_mock=True)
    library = Library(tmp_path)
    book = ParsedBook(title="T", author="", format="text", chapters=[Chapter(title="One", text="Some words. " * 50)])
    book_id = library.add(book, None, "t")["id"]
    reader = BookReader(settings, None, library)

    old = {"beats": [{"say": "old flat one", "scene": None}], "recap": "r"}
    library.save_tour(book_id, 0, old)
    events = _beats(reader, book_id)
    assert not any(e.get("cached") for e in events)
    assert all(e.get("say") != "old flat one" for e in events)

    library.save_tour(book_id, 0, {**old, "style": TOUR_STYLE})
    events = _beats(reader, book_id)
    assert any(e.get("cached") for e in events)
    assert any(e.get("say") == "old flat one" for e in events)
