import asyncio
import json
from dataclasses import replace

import pytest

from app.config import EXAMPLES_DIR, load_settings
from app.pipeline import AskInput, AskPipeline, extract_say, fix_latex_escapes, parse_json_object, scene_to_pixels
from app.scene import to_client, validate_scene


def run(pipeline, req):
    async def collect():
        return [event async for event in pipeline.run(req)]

    return asyncio.run(collect())


def test_extract_say_waits_for_closing_quote():
    assert extract_say('{"say": "Hello, wor') is None
    assert extract_say('{"say": "Hello \\"there\\".", "sce') == 'Hello "there".'


def test_parse_json_object_tolerates_code_fences():
    assert parse_json_object('```json\n{"say": "x", "scene": null}\n```') == {"say": "x", "scene": None}
    assert parse_json_object("not json") is None


def test_parse_json_object_fixes_bracket_mistakes():
    # Missing final brace (seen live from deepseek-flash) and a skipped "]".
    assert parse_json_object('{"say": "hi", "scene": {"panel": {"steps": [{"t": "}"}]}}') == {
        "say": "hi", "scene": {"panel": {"steps": [{"t": "}"}]}}}
    assert parse_json_object('{"a": [1, {"b": 2}}') == {"a": [1, {"b": 2}]}


def test_parse_json_object_fixes_trailing_commas_and_comments():
    text = '{"say": "a // not a comment", "scene": {"pointers": [1, 2,], }, // done\n}'
    assert parse_json_object(text) == {"say": "a // not a comment", "scene": {"pointers": [1, 2]}}


@pytest.mark.parametrize("path", sorted(EXAMPLES_DIR.glob("*.json")), ids=lambda p: p.stem)
def test_examples_are_valid_scenes(path):
    example = json.loads(path.read_text(encoding="utf-8"))
    scene, errors = validate_scene(example["scene"])
    assert errors is None, errors
    assert scene.panel is not None


def test_pixels_become_fractions_and_back():
    scene, _ = validate_scene(
        {"title": "t", "placement": {"x": 640, "y": 200}, "pointers": [{"x": 320, "y": 400, "w": 64, "h": 40}]}
    )
    data = to_client(scene, 1280, 800)
    assert data["placement"] == {"x": 0.5, "y": 0.25}
    assert data["pointers"][0] == {"x": 0.25, "y": 0.5, "w": 0.05, "h": 0.05}
    assert scene_to_pixels(data, 1280, 800)["placement"] == {"x": 640, "y": 200}


def test_arrow_from_alias_round_trips():
    scene, errors = validate_scene(
        {"panel": {"type": "diagram", "elements": [{"kind": "arrow", "from": [0, 0], "to": [10, 10]}]}}
    )
    assert errors is None
    assert to_client(scene, None, None)["panel"]["elements"][0]["from"] == (0.0, 0.0)


class FakeLLM:
    def __init__(self, streamed: str, repaired: str = ""):
        self.streamed, self.repaired, self.repair_calls = streamed, repaired, 0

    async def stream(self, messages):
        for i in range(0, len(self.streamed), 7):
            yield self.streamed[i : i + 7]

    async def complete(self, messages):
        self.repair_calls += 1
        return self.repaired


def make_pipeline(llm):
    settings = replace(load_settings(), deepseek_api_key="test", force_mock=False)
    pipeline = AskPipeline(settings)
    pipeline.llm = llm
    return pipeline


def test_live_flow_streams_say_then_scene():
    reply = {"say": "It hovers.", "scene": {"title": "Hover", "panel": {"type": "diagram", "elements": [
        {"kind": "box", "x": 0, "y": 0, "w": 10, "h": 10, "label": "fan"}]}}}
    events = run(make_pipeline(FakeLLM(json.dumps(reply))), AskInput(question="does it hover?"))
    types = [e["type"] for e in events]
    assert types == ["say", "scene", "done"]
    assert events[0]["text"] == "It hovers."
    assert events[1]["scene"]["panel"]["elements"][0]["label"] == "fan"


def test_invalid_scene_is_repaired_once():
    bad = {"say": "Hi.", "scene": {"title": "x", "panel": {"type": "diagram", "elements": [{"kind": "box", "x": 1}]}}}
    good = {"title": "x", "panel": {"type": "diagram", "elements": [{"kind": "box", "x": 1, "y": 1, "w": 5, "h": 5}]}}
    llm = FakeLLM(json.dumps(bad), json.dumps(good))
    events = run(make_pipeline(llm), AskInput(question="q"))
    assert llm.repair_calls == 1
    scene_event = next(e for e in events if e["type"] == "scene")
    assert scene_event["scene"]["panel"]["elements"][0]["w"] == 5


def test_mock_mode_matches_keywords():
    settings = replace(load_settings(), force_mock=True)
    events = run(AskPipeline(settings), AskInput(question="How do I attach a camera to a Raspberry Pi?"))
    scene = next(e for e in events if e["type"] == "scene")["scene"]
    assert scene["panel"]["type"] == "steps"


def test_unescaped_latex_survives_json():
    # The model often writes LaTeX with single backslashes; real JSON escapes must still work.
    raw = r'{"say": "a\nb \"q\" é", "scene": {"title": "$\frac{1}{2} + \sqrt{x} + \theta + \nabla \to \int$"}}'
    data = parse_json_object(raw)
    assert data["say"] == 'a\nb "q" é'
    assert data["scene"]["title"] == r"$\frac{1}{2} + \sqrt{x} + \theta + \nabla \to \int$"
    already_escaped = r'{"t": "$\\frac{1}{2}$"}'
    assert fix_latex_escapes(already_escaped) == already_escaped


def test_plot_panels_validate():
    scene, errors = validate_scene({
        "title": "t",
        "panel": {"type": "plot", "x": [5, -5], "items": [
            {"kind": "function", "id": "f", "fn": "x^2"},
            {"kind": "point", "on": "f", "x": 2},
            {"kind": "area", "fn": "f", "from": 0, "to": 1},
            {"kind": "angle", "at": [0, 0], "from": [1, 0], "to": [0, 1], "right": True},
        ]},
    })
    assert errors is None, errors
    assert scene.panel.x == (-5, 5)  # reversed range is put in order
    data = to_client(scene, None, None)
    assert data["panel"]["items"][2]["from"] == 0  # alias kept for the renderer

    _, errors = validate_scene({"panel": {"type": "plot", "items": [{"kind": "point", "label": "lost"}]}})
    assert errors and "point needs" in errors

    scene, errors = validate_scene({"panel": {"type": "plot3d", "items": [
        {"kind": "surface", "fn": "x^2 - y^2"},
        {"kind": "vector", "to": [1, 2, 3]},
    ]}})
    assert errors is None, errors


def test_steps_can_hold_a_plot():
    scene, errors = validate_scene({"panel": {"type": "steps", "steps": [
        {"title": "Graph it", "plot": {"items": [{"kind": "function", "fn": "sin(x)"}]}},
    ]}})
    assert errors is None, errors
    assert scene.panel.steps[0].plot.items[0].fn == "sin(x)"
