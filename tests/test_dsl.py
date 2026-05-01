"""Smoke tests for the Path DSL."""

import math

import pytest

from rep_tiles.dsl import Path, ShapeNotClosedError, ShapeNotSimpleError


def test_triangle_closes() -> None:
    path = (
        Path()
        .edge(1).turn(90)
        .edge(1).turn(135)
        .edge(math.sqrt(2))
    )
    verts = path.vertices()
    assert len(verts) == 3
    assert math.isclose(verts[0][0], 0.0) and math.isclose(verts[0][1], 0.0)


def test_unit_square_area() -> None:
    path = (
        Path()
        .edge(1).turn(90)
        .edge(1).turn(90)
        .edge(1).turn(90)
        .edge(1)
    )
    poly = path.polygon()
    assert math.isclose(poly.area, 1.0, abs_tol=1e-9)


def test_open_path_raises() -> None:
    with pytest.raises(ShapeNotClosedError):
        Path().edge(1).turn(90).edge(1).vertices()


def test_self_crossing_raises() -> None:
    # A bowtie: two triangles connected at their tips cross each other.
    with pytest.raises(ShapeNotSimpleError, match=r"self-intersects: edge \d+.*crosses edge \d+"):
        Path.from_vertices([(0, 0), (2, 1), (2, 0), (0, 1)]).vertices()


def test_from_vertices_works() -> None:
    path = Path.from_vertices([(0, 0), (1, 0), (0, 1)])
    verts = path.vertices()
    assert len(verts) == 3
    assert verts[0] == (0.0, 0.0)
