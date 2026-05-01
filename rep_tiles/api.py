"""FastAPI application — /api/shapes, /api/validate, static file serving."""

from __future__ import annotations

import logging
from pathlib import Path as FSPath
from typing import Optional

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, conlist, confloat
from shapely.ops import unary_union

from .geometry import Placement, any_overlap, out_of_frame, fully_tiled, piece_polygons
from .registry import all_shapes, get_shape

logger = logging.getLogger(__name__)

app = FastAPI(title="rep-tiles")

# ── Pydantic models ────────────────────────────────────────────────────────────

class ShapeInfo(BaseModel):
    name: str
    vertices: list[list[float]]


class ShapesResponse(BaseModel):
    shapes: list[ShapeInfo]
    frame: str


class PlacementIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    anchor: conlist(float, min_length=2, max_length=2)  # [x, y] in grid units
    rotation: float = Field(0.0, ge=-3600.0, le=3600.0)  # degrees, CCW
    reflected: bool = False


class ValidateRequest(BaseModel):
    frame: str = Field(..., min_length=1, max_length=64)
    scale: confloat(gt=0.0, le=64.0)
    placements: conlist(PlacementIn, max_length=512)


class ValidateResponse(BaseModel):
    ok: bool
    overlap_pair: Optional[list[int]] = None       # [i, j] or null
    out_of_frame_index: Optional[int] = None
    fully_tiled: bool
    n: Optional[int] = None
    coverage: float


# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.get("/api/shapes", response_model=ShapesResponse)
def get_shapes() -> ShapesResponse:
    """Return all registered shapes and the default frame name."""
    shapes = all_shapes()
    shape_list = [
        ShapeInfo(
            name=name,
            vertices=[[x, y] for x, y in path.vertices()],
        )
        for name, path in shapes.items()
    ]
    frame_name = next(iter(shapes)) if shapes else ""
    return ShapesResponse(shapes=shape_list, frame=frame_name)


@app.post("/api/validate", response_model=ValidateResponse)
def validate(body: ValidateRequest) -> ValidateResponse:
    """Check piece placements: overlap, containment, tiling coverage."""
    try:
        frame_path = get_shape(body.frame)
    except KeyError:
        return ValidateResponse(
            ok=False,
            fully_tiled=False,
            coverage=0.0,
        )

    registered = all_shapes()
    for p in body.placements:
        if p.name not in registered:
            return ValidateResponse(
                ok=False,
                fully_tiled=False,
                coverage=0.0,
            )

    frame_poly = frame_path.polygon()

    def base_lookup(name: str):
        return get_shape(name).polygon()

    placements = [
        Placement(
            name=p.name,
            anchor=(p.anchor[0], p.anchor[1]),
            rotation=p.rotation,
            reflected=p.reflected,
        )
        for p in body.placements
    ]

    if not placements:
        return ValidateResponse(
            ok=True,
            fully_tiled=False,
            n=None,
            coverage=0.0,
        )

    pieces = piece_polygons(placements, base_lookup, body.scale)

    overlap = any_overlap(pieces)
    if overlap is not None:
        return ValidateResponse(
            ok=False,
            overlap_pair=list(overlap),
            fully_tiled=False,
            coverage=_coverage(pieces, frame_poly),
        )

    oof = out_of_frame(pieces, frame_poly)
    if oof is not None:
        return ValidateResponse(
            ok=False,
            out_of_frame_index=oof,
            fully_tiled=False,
            coverage=_coverage(pieces, frame_poly),
        )

    tiled = fully_tiled(pieces, frame_poly)
    n = len(pieces) if tiled else None
    return ValidateResponse(
        ok=True,
        fully_tiled=tiled,
        n=n,
        coverage=_coverage(pieces, frame_poly),
    )


def _coverage(pieces: list, frame_poly) -> float:
    if not pieces or frame_poly.area == 0:
        return 0.0
    union = unary_union(pieces)
    clipped = union.intersection(frame_poly)
    raw = clipped.area / frame_poly.area
    return max(0.0, min(1.0, raw))


# ── Static files ───────────────────────────────────────────────────────────────

_static_dir = FSPath(__file__).parent / "static"

if _static_dir.exists() and any(_static_dir.iterdir()):
    app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(str(_static_dir / "index.html"))
else:
    logger.warning(
        "rep_tiles/static/ is empty or missing — frontend not yet deployed. "
        "Run swe-2 to add the frontend."
    )

    @app.get("/", include_in_schema=False)
    def index_placeholder():
        from fastapi.responses import HTMLResponse
        return HTMLResponse(
            "<h1>rep-tiles backend is running</h1>"
            "<p>Frontend not yet deployed. See /docs for the API.</p>"
        )
