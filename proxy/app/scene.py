"""Scene format the model must produce and the renderer draws.

Keep in sync with renderer/src/types.ts. Validation is lenient (unknown keys are
dropped, numbers are coerced) so small model slips don't throw away a good scene.
"""
from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

Vec2 = tuple[float, float]
Vec3 = tuple[float, float, float]


def _ordered(r: tuple[float, float]) -> tuple[float, float]:
    if r[0] == r[1]:
        raise ValueError("range needs two different numbers")
    return (r[0], r[1]) if r[0] < r[1] else (r[1], r[0])


Range = Annotated[tuple[float, float], AfterValidator(_ordered)]
Formula = Annotated[str, Field(min_length=1, max_length=300)]


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


# ---- 2D diagram elements (panel coordinate space, y grows downward) ----

class Box(_Model):
    kind: Literal["box"]
    id: str | None = None
    x: float
    y: float
    w: float
    h: float
    label: str | None = None
    color: str | None = None


class Circle(_Model):
    kind: Literal["circle"]
    id: str | None = None
    x: float
    y: float
    r: float
    label: str | None = None
    color: str | None = None


class Text(_Model):
    kind: Literal["text"]
    x: float
    y: float
    text: str
    size: float | None = None
    color: str | None = None
    align: Literal["start", "middle", "end"] | None = None


class Arrow(_Model):
    kind: Literal["arrow"]
    from_: str | Vec2 = Field(alias="from")
    to: str | Vec2
    label: str | None = None
    color: str | None = None
    dashed: bool | None = None
    bend: float | None = None
    both: bool | None = None


class Line(_Model):
    kind: Literal["line"]
    points: list[Vec2] = Field(min_length=2)
    color: str | None = None
    dashed: bool | None = None
    closed: bool | None = None
    fill: bool | None = None


Element = Annotated[Union[Box, Circle, Text, Arrow, Line], Field(discriminator="kind")]


# ---- panels ----

class DiagramPanel(_Model):
    type: Literal["diagram"]
    width: float = 400
    height: float = 280
    elements: list[Element] = Field(max_length=80)


# ---- 2D math plots (math coordinates, y grows up; formulas are evaluated by the renderer) ----

class _PlotStyle(_Model):
    color: str | None = None
    label: str | None = None
    dashed: bool | None = None


class PFunction(_PlotStyle):
    kind: Literal["function"]
    id: str | None = None
    fn: Formula
    domain: Range | None = None


class PParametric(_PlotStyle):
    kind: Literal["parametric"]
    x: Formula
    y: Formula
    t: Range | None = None


class PImplicit(_PlotStyle):
    kind: Literal["implicit"]
    eq: Formula


class PPoint(_PlotStyle):
    kind: Literal["point"]
    at: Vec2 | None = None
    on: str | None = None
    x: float | None = None
    hollow: bool | None = None

    @model_validator(mode="after")
    def _placed(self):
        if self.at is None and (self.on is None or self.x is None):
            raise ValueError('a point needs "at": [x, y], or "on" (a function id) and "x"')
        return self


class PTangent(_PlotStyle):
    kind: Literal["tangent"]
    of: str
    at: float


class PArea(_PlotStyle):
    kind: Literal["area"]
    fn: Formula
    fn2: str | None = None
    from_: float = Field(alias="from")
    to: float


class PSegment(_PlotStyle):
    kind: Literal["segment"]
    from_: Vec2 = Field(alias="from")
    to: Vec2
    arrow: bool | None = None


class PVLine(_PlotStyle):
    kind: Literal["vline"]
    x: float


class PHLine(_PlotStyle):
    kind: Literal["hline"]
    y: float


class PPolygon(_PlotStyle):
    kind: Literal["polygon"]
    points: list[Vec2] = Field(min_length=2, max_length=40)
    fill: bool | None = None


class PCircle(_PlotStyle):
    kind: Literal["circle"]
    center: Vec2
    r: float = Field(gt=0)
    fill: bool | None = None


class PAngle(_PlotStyle):
    kind: Literal["angle"]
    at: Vec2
    from_: Vec2 = Field(alias="from")
    to: Vec2
    right: bool | None = None


class PText(_Model):
    kind: Literal["text"]
    at: Vec2
    text: str
    color: str | None = None


PlotItem = Annotated[
    Union[PFunction, PParametric, PImplicit, PPoint, PTangent, PArea, PSegment, PVLine, PHLine, PPolygon, PCircle, PAngle, PText],
    Field(discriminator="kind"),
]


class PlotSpec(_Model):
    x: Range | None = None
    y: Range | None = None
    equal: bool | None = None
    grid: bool | None = None
    xLabel: str | None = None
    yLabel: str | None = None
    width: float | None = None
    height: float | None = None
    items: list[PlotItem] = Field(min_length=1, max_length=40)


class PlotPanel(PlotSpec):
    type: Literal["plot"]


# ---- 3D math plots (math coordinates, z grows up) ----

class _Plot3DStyle(_Model):
    color: str | None = None
    label: str | None = None


class P3Surface(_Plot3DStyle):
    kind: Literal["surface"]
    fn: Formula
    opacity: float | None = Field(default=None, ge=0, le=1)


class P3PSurface(_Plot3DStyle):
    kind: Literal["psurface"]
    x: Formula
    y: Formula
    z: Formula
    u: Range | None = None
    v: Range | None = None
    opacity: float | None = Field(default=None, ge=0, le=1)


class P3Curve(_Plot3DStyle):
    kind: Literal["curve"]
    x: Formula
    y: Formula
    z: Formula
    t: Range | None = None


class P3Point(_Plot3DStyle):
    kind: Literal["point"]
    at: Vec3


class P3Vector(_Plot3DStyle):
    kind: Literal["vector"]
    from_: Vec3 | None = Field(default=None, alias="from")
    to: Vec3


Plot3DItem = Annotated[Union[P3Surface, P3PSurface, P3Curve, P3Point, P3Vector], Field(discriminator="kind")]


class Plot3DSpec(_Model):
    x: Range | None = None
    y: Range | None = None
    z: Range | None = None
    equal: bool | None = None
    xLabel: str | None = None
    yLabel: str | None = None
    zLabel: str | None = None
    autoRotate: bool | None = None
    items: list[Plot3DItem] = Field(min_length=1, max_length=20)


class Plot3DPanel(Plot3DSpec):
    type: Literal["plot3d"]


class Step(_Model):
    title: str
    text: str | None = None
    width: float | None = None
    height: float | None = None
    elements: list[Element] = Field(default_factory=list, max_length=60)
    plot: PlotSpec | None = None
    plot3d: Plot3DSpec | None = None


class StepsPanel(_Model):
    type: Literal["steps"]
    steps: list[Step] = Field(min_length=1, max_length=12)


class Spin(_Model):
    axis: Literal["x", "y", "z"] = "y"
    speed: float = 1.0


# Ready-made 3D objects. Must match KIT in renderer/src/models.ts (a test checks this).
MODELS = (
    "person", "robot", "heart", "brain", "eye",
    "tree", "plant", "mountain", "sun", "cloud", "globe", "planet", "flame", "drop", "rock",
    "house", "office", "factory", "castle", "bridge", "wall", "stairs", "road", "door", "ladder", "signpost", "flag",
    "car", "ship", "plane", "rocket", "satellite",
    "laptop", "phone", "server", "database", "chip", "gear", "battery", "lightbulb", "atom", "dna", "molecule",
    "telescope", "microphone", "camera",
    "book", "open_book", "document", "pencil", "coin", "coins", "key", "lock", "shield", "sword", "crown", "trophy",
    "medal", "target", "clock", "hourglass", "calendar", "magnifier", "envelope", "chair", "table", "scales", "hammer",
    "compass", "gift", "speech_bubble", "chart_bars", "big_arrow",
)


class Obj3D(_Model):
    id: str | None = None
    parent: str | None = None
    shape: Literal["box", "sphere", "cylinder", "cone", "torus", "capsule", "plane", "lathe", "extrude", "tube", "model"]
    size: list[float] = Field(default_factory=lambda: [1.0])
    model: str | None = None
    points: list[list[float]] | None = None
    material: str | None = None
    position: Vec3 | None = None
    rotation: Vec3 | None = None
    scale: Vec3 | None = None
    color: str | None = None
    opacity: float | None = Field(default=None, ge=0, le=1)
    spin: Spin | None = None

    @field_validator("size", mode="before")
    @classmethod
    def _size_as_list(cls, v):
        return [v] if isinstance(v, (int, float)) else v


class Label3D(_Model):
    text: str
    at: str | Vec3
    offset: Vec3 | None = None


class Arrow3D(_Model):
    from_: Vec3 = Field(alias="from")
    to: Vec3
    color: str | None = None
    label: str | None = None


class Camera(_Model):
    position: Vec3
    target: Vec3 | None = None


class ThreePanel(_Model):
    type: Literal["3d"]
    objects: list[Obj3D] = Field(min_length=1, max_length=120)
    labels: list[Label3D] = Field(default_factory=list)
    arrows: list[Arrow3D] = Field(default_factory=list)
    camera: Camera | None = None
    autoRotate: bool | None = None


Panel = Annotated[Union[DiagramPanel, StepsPanel, ThreePanel, PlotPanel, Plot3DPanel], Field(discriminator="type")]


# ---- scene ----

class Point(_Model):
    x: float
    y: float


class Pointer(_Model):
    x: float
    y: float
    w: float | None = None
    h: float | None = None
    label: str | None = None
    style: Literal["circle", "box", "arrow", "underline"] | None = None


class Scene(_Model):
    title: str | None = None
    subtitle: str | None = None
    placement: Point | None = None
    pointers: list[Pointer] = Field(default_factory=list)
    panel: Panel | None = None


SCENE_KEYS = {"title", "subtitle", "placement", "pointers"}
# A field that gives away the panel type when the model leaves out "type".
PANEL_HINTS = {"objects": "3d", "steps": "steps", "elements": "diagram"}


def _lift_panel(raw: object) -> object:
    """The model sometimes writes the panel's fields directly on the scene; unknown fields would be dropped silently."""
    if not isinstance(raw, dict) or raw.get("panel"):
        return raw
    kind = raw.get("type") or next((v for k, v in PANEL_HINTS.items() if k in raw), None)
    if kind not in ("diagram", "steps", "3d", "plot", "plot3d"):
        return raw
    panel = {k: v for k, v in raw.items() if k not in SCENE_KEYS}
    return {**{k: v for k, v in raw.items() if k in SCENE_KEYS}, "panel": {**panel, "type": kind}}


def validate_scene(raw: object) -> tuple[Scene | None, str | None]:
    """Return (scene, None) on success or (None, short error text) on failure."""
    if raw is None:
        return None, None
    try:
        return Scene.model_validate(_lift_panel(raw)), None
    except ValidationError as e:
        lines = [f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}" for err in e.errors()[:10]]
        return None, "\n".join(lines)


def _clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def to_client(scene: Scene, image_w: int | None, image_h: int | None) -> dict:
    """Serialise for the renderer, converting screenshot pixels to 0..1 screen fractions."""
    data = scene.model_dump(by_alias=True, exclude_none=True)
    if not image_w or not image_h:
        # No screenshot: screen positions are meaningless.
        data.pop("placement", None)
        data.pop("pointers", None)
        return data
    if "placement" in data:
        p = data["placement"]
        data["placement"] = {"x": _clamp01(p["x"] / image_w), "y": _clamp01(p["y"] / image_h)}
    pointers = []
    for p in data.get("pointers", []):
        q = dict(p, x=_clamp01(p["x"] / image_w), y=_clamp01(p["y"] / image_h))
        if "w" in p:
            q["w"] = _clamp01(p["w"] / image_w)
        if "h" in p:
            q["h"] = _clamp01(p["h"] / image_h)
        pointers.append(q)
    data["pointers"] = pointers
    return data
