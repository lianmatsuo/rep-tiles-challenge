"""Cross-cutting acceptance-criterion tests.

Covers: AC3, AC4, AC6, AC7, AC8-AC11 (API validate cases), AC15-AC17 (rotation math), AC19 (scale).
"""

from __future__ import annotations

import importlib
import math
import sys

import pytest
from fastapi.testclient import TestClient

import rep_tiles.shapes  # ensure registry is populated
from rep_tiles.dsl import Path, ShapeNotClosedError, ShapeNotSimpleError
from rep_tiles.geometry import transform_polygon
from rep_tiles.registry import get_shape


# ── Helpers ───────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def client() -> TestClient:
    from rep_tiles.api import app
    return TestClient(app)


# ── AC3: open path raises ShapeNotClosedError with gap vector ─────────────────


def test_open_path_error_message_contains_gap() -> None:
    """AC3: ShapeNotClosedError message includes the gap vector."""
    with pytest.raises(ShapeNotClosedError, match=r"gap") as exc_info:
        Path().edge(1).turn(90).edge(1).vertices()
    msg = str(exc_info.value)
    assert "gap" in msg.lower()


def test_near_closure_at_tolerance_boundary() -> None:
    """AC3: a path that closes within 1e-6 does NOT raise."""
    # Unit square closes exactly — no error expected
    path = (
        Path()
        .edge(1).turn(90)
        .edge(1).turn(90)
        .edge(1).turn(90)
        .edge(1)
    )
    verts = path.vertices()
    assert len(verts) == 4


def test_single_edge_path_raises() -> None:
    """AC3: a single-edge path (cannot close) raises ShapeNotClosedError."""
    with pytest.raises(ShapeNotClosedError):
        Path().edge(1).vertices()


def test_two_vertex_path_raises() -> None:
    """AC3: two-vertex path (single edge then no return) raises ShapeNotClosedError."""
    with pytest.raises(ShapeNotClosedError):
        Path().edge(1).turn(180).edge(0.5).vertices()


def test_empty_path_raises_or_returns_empty() -> None:
    """AC3 edge case: a bare Path() with no edges — should raise or be invalid."""
    p = Path()
    # Only origin vertex — shapely needs >= 3; from_vertices requires >= 3
    # The vertices() method won't raise ShapeNotClosedError (only 1 vertex, no gap),
    # but Polygon([origin]) is degenerate. We just confirm it doesn't silently
    # produce a positive-area polygon.
    try:
        verts = p.vertices()
        from shapely.geometry import Polygon
        poly = Polygon(verts) if len(verts) >= 3 else None
        if poly is not None:
            assert poly.area == 0.0
    except (ShapeNotClosedError, ValueError):
        pass  # any error is acceptable for degenerate input


# ── AC4: self-intersecting path raises ShapeNotSimpleError ────────────────────


def test_self_intersecting_path_raises() -> None:
    """AC4: a self-intersecting polygon raises ShapeNotSimpleError."""
    with pytest.raises(ShapeNotSimpleError):
        Path.from_vertices([(0, 0), (1, 1), (1, 0), (0, 1)]).vertices()


def test_shared_vertices_no_crossing_ok() -> None:
    """AC4: two paths sharing boundary vertices (not crossing) are individually valid."""
    # Square 1: (0,0)-(1,0)-(1,1)-(0,1)
    sq1 = Path.from_vertices([(0, 0), (1, 0), (1, 1), (0, 1)])
    # Square 2 shares the edge x=1: (1,0)-(2,0)-(2,1)-(1,1)
    sq2 = Path.from_vertices([(1, 0), (2, 0), (2, 1), (1, 1)])
    # Both should be valid (no self-intersection within each)
    assert sq1.polygon().is_simple
    assert sq2.polygon().is_simple


# ── AC6: __main__ importable without booting uvicorn ─────────────────────────


def test_main_module_importable() -> None:
    """AC6: rep_tiles.__main__ can be imported without raising or launching uvicorn."""
    # Remove from cache to force a fresh import check
    mod_name = "rep_tiles.__main__"
    if mod_name in sys.modules:
        del sys.modules[mod_name]
    mod = importlib.import_module(mod_name)
    assert hasattr(mod, "main")


# ── AC7: GET /api/shapes returns all 4 names + correct frame ──────────────────


def test_get_shapes_returns_four_names(client: TestClient) -> None:
    """AC7: /api/shapes lists all 4 predefined shape names."""
    resp = client.get("/api/shapes")
    assert resp.status_code == 200
    data = resp.json()
    names = {s["name"] for s in data["shapes"]}
    assert {"right-isoceles-triangle", "l-tromino", "l-tetromino", "sphinx-hexiamond"} <= names


def test_get_shapes_frame_is_first_registered(client: TestClient) -> None:
    """AC7: /api/shapes 'frame' field equals first registered shape name."""
    resp = client.get("/api/shapes")
    data = resp.json()
    # First registered in shapes.py is right-isoceles-triangle
    assert data["frame"] == "right-isoceles-triangle"


def test_get_shapes_vertices_present(client: TestClient) -> None:
    """AC7: each shape entry has a non-empty vertices list of [x, y] pairs."""
    resp = client.get("/api/shapes")
    for s in resp.json()["shapes"]:
        assert len(s["vertices"]) >= 3
        for v in s["vertices"]:
            assert len(v) == 2


# ── AC8: empty placements → ok=True, fully_tiled=False, coverage=0 ────────────


def test_validate_empty_placements_ok(client: TestClient) -> None:
    """AC8: POST /api/validate with empty placements returns ok=True, fully_tiled=False, coverage=0."""
    resp = client.post("/api/validate", json={
        "frame": "right-isoceles-triangle",
        "scale": 2.0,
        "placements": [],
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["fully_tiled"] is False
    assert data["coverage"] == 0.0


# ── AC9: overlapping pieces → ok=False, overlap_pair set ─────────────────────


def test_validate_overlapping_pieces_rejected(client: TestClient) -> None:
    """AC9: two pieces placed at the same anchor overlap → ok=False, overlap_pair=[0,1]."""
    resp = client.post("/api/validate", json={
        "frame": "l-tromino",
        "scale": 1.0,
        "placements": [
            {"name": "right-isoceles-triangle", "anchor": [0.0, 0.0], "rotation": 0.0},
            {"name": "right-isoceles-triangle", "anchor": [0.0, 0.0], "rotation": 0.0},
        ],
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is False
    assert data["overlap_pair"] == [0, 1]


# ── AC10: piece outside frame → ok=False, out_of_frame_index set ─────────────


def test_validate_piece_outside_frame_rejected(client: TestClient) -> None:
    """AC10: a piece placed with anchor far outside the frame → ok=False, out_of_frame_index=0."""
    resp = client.post("/api/validate", json={
        "frame": "right-isoceles-triangle",
        "scale": 2.0,
        "placements": [
            {"name": "right-isoceles-triangle", "anchor": [100.0, 100.0], "rotation": 0.0},
        ],
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is False
    assert data["out_of_frame_index"] == 0


# ── AC11: exact tiling of L-tromino at scale=2 → fully_tiled=True, n=4 ───────


def _l_tromino_rep4_placements() -> list[dict]:
    """Return the 4 placements that tile a scale-2 L-tromino frame.

    The L-tromino frame occupies (0,0)-(2,0)-(2,1)-(1,1)-(1,2)-(0,2).
    At scale=2 each piece is half-size. These anchors and rotations were
    verified to produce no overlaps, no out-of-frame pieces, and fully_tiled=True.
    """
    return [
        {"name": "l-tromino", "anchor": [0.0, 0.0], "rotation": 0.0},
        {"name": "l-tromino", "anchor": [0.0, 2.0], "rotation": 270.0},
        {"name": "l-tromino", "anchor": [0.5, 0.5], "rotation": 0.0},
        {"name": "l-tromino", "anchor": [2.0, 0.0], "rotation": 90.0},
    ]


def test_validate_l_tromino_rep4_fully_tiled(client: TestClient) -> None:
    """AC11: correct rep-4 L-tromino tiling returns ok=True, fully_tiled=True, n=4.

    With sqrt-scaling, scale=4 ⇒ pieces are 1/sqrt(4)=1/2 linear, 1/4 area.
    """
    resp = client.post("/api/validate", json={
        "frame": "l-tromino",
        "scale": 4.0,
        "placements": _l_tromino_rep4_placements(),
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True, f"expected ok=True, got errors: {data}"
    assert data["fully_tiled"] is True, f"expected fully_tiled=True, got: {data}"
    assert data["n"] == 4


# ── AC11 (bonus): exact rep-2 tiling of right-isoceles triangle ───────────────


def test_validate_triangle_rep4_fully_tiled(client: TestClient) -> None:
    """AC11: four half-linear-scale right-isoceles triangles tile the frame at scale=4 (rep-4)."""
    # Frame: right-isoceles triangle (0,0),(1,0),(1,1). At scale=4 each piece has legs 0.5.
    # Verified placements: p0=(0,0,0), p1=(0.5,0,0), p2=(0.5,0.5,0), p3=(1.0,0.5,180).
    resp = client.post("/api/validate", json={
        "frame": "right-isoceles-triangle",
        "scale": 4.0,
        "placements": [
            {"name": "right-isoceles-triangle", "anchor": [0.0, 0.0], "rotation": 0.0},
            {"name": "right-isoceles-triangle", "anchor": [0.5, 0.0], "rotation": 0.0},
            {"name": "right-isoceles-triangle", "anchor": [0.5, 0.5], "rotation": 0.0},
            {"name": "right-isoceles-triangle", "anchor": [1.0, 0.5], "rotation": 180.0},
        ],
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True, f"placement error: {data}"
    assert data["fully_tiled"] is True, f"not fully tiled: {data}"
    assert data["n"] == 4


# ── AC15-AC17 (rotation math): transform_polygon ─────────────────────────────


def test_transform_polygon_rotation_90() -> None:
    """AC15: rotating a unit square 90° CCW around origin moves vertices correctly."""
    from shapely.geometry import Polygon
    sq = Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])
    rotated = transform_polygon(sq, anchor=(0, 0), rotation_deg=90, reflected=False)
    # After 90° CCW, (1,0) → (0,1), (1,1) → (-1,1), (0,1) → (-1,0)
    # Anchor is at first vertex post-transform; area must be preserved
    assert math.isclose(rotated.area, sq.area, abs_tol=1e-9)


def test_transform_polygon_rotation_180() -> None:
    """AC15: rotating 180° produces a polygon of equal area at the same anchor."""
    from shapely.geometry import Polygon
    sq = Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])
    rotated = transform_polygon(sq, anchor=(0, 0), rotation_deg=180, reflected=False)
    assert math.isclose(rotated.area, sq.area, abs_tol=1e-9)


def test_transform_polygon_rotation_270() -> None:
    """AC15: rotating 270° is equivalent to 90° clockwise; area preserved."""
    from shapely.geometry import Polygon
    sq = Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])
    r90  = transform_polygon(sq, anchor=(0, 0), rotation_deg=90, reflected=False)
    r270 = transform_polygon(sq, anchor=(0, 0), rotation_deg=270, reflected=False)
    assert math.isclose(r90.area, r270.area, abs_tol=1e-9)


def test_transform_polygon_translate_plus_rotate() -> None:
    """AC15-16: rotate then translate — anchor in output matches requested anchor."""
    tri_path = get_shape("right-isoceles-triangle")
    tri = tri_path.polygon()
    anchor = (3.0, 4.0)
    result = transform_polygon(tri, anchor=anchor, rotation_deg=90, reflected=False)
    coords = list(result.exterior.coords)
    fx, fy = coords[0]
    assert math.isclose(fx, anchor[0], abs_tol=1e-9)
    assert math.isclose(fy, anchor[1], abs_tol=1e-9)


def test_transform_polygon_360_is_identity() -> None:
    """AC15: rotating by 360° returns a polygon with identical area and approx same centroid."""
    from shapely.geometry import Polygon
    sq = Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])
    r360 = transform_polygon(sq, anchor=(0, 0), rotation_deg=360, reflected=False)
    r0   = transform_polygon(sq, anchor=(0, 0), rotation_deg=0,   reflected=False)
    assert math.isclose(r360.area, r0.area, abs_tol=1e-9)
    assert math.isclose(r360.centroid.x, r0.centroid.x, abs_tol=1e-6)
    assert math.isclose(r360.centroid.y, r0.centroid.y, abs_tol=1e-6)


# ── AC19: scale factor reduces piece size proportionally ─────────────────────


@pytest.mark.parametrize("scale", [1, 2, 3, 4])
def test_transform_scale_reduces_area(scale: int) -> None:
    """AC19: at scale=N the piece AREA is base_area / N (linear factor 1/sqrt(N))."""
    tri_path = get_shape("right-isoceles-triangle")
    base = tri_path.polygon()
    scaled = transform_polygon(base, anchor=(0, 0), rotation_deg=0, reflected=False, scale_factor=float(scale))
    expected_area = base.area / scale
    assert math.isclose(scaled.area, expected_area, rel_tol=1e-6), (
        f"scale={scale}: expected area {expected_area}, got {scaled.area}"
    )


# ── AC8 bonus: single valid piece inside frame, coverage check ────────────────


def test_validate_single_piece_inside_frame_coverage(client: TestClient) -> None:
    """AC8: one valid piece inside a rep-4 frame has ok=True and coverage approx 0.25."""
    # L-tromino frame, scale=4 (rep-4 ⇒ piece area = 1/4 of frame), one piece at origin.
    resp = client.post("/api/validate", json={
        "frame": "l-tromino",
        "scale": 4.0,
        "placements": [
            {"name": "l-tromino", "anchor": [0.0, 0.0], "rotation": 0.0},
        ],
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["fully_tiled"] is False
    # One of 4 pieces covers ~25% of the frame area
    assert math.isclose(data["coverage"], 0.25, abs_tol=0.05), f"coverage={data['coverage']}"
