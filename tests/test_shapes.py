"""Tests for all 4 predefined shapes — areas, registration, vertex sanity.

Covers: AC1 (registration), AC2 (areas), AC5 (positive area, no import error).
"""

from __future__ import annotations

import math

import pytest

import rep_tiles.shapes  # AC1: importing registers all @shape decorators
from rep_tiles.registry import all_shapes, get_shape


# ── AC1 ───────────────────────────────────────────────────────────────────────


def test_all_four_shapes_registered() -> None:
    """AC1: importing rep_tiles.shapes registers all 4 predefined shapes."""
    names = set(all_shapes())
    assert "right-isoceles-triangle" in names
    assert "l-tromino" in names
    assert "l-tetromino" in names
    assert "sphinx-hexiamond" in names


def test_registry_returns_at_least_four() -> None:
    """AC1: all_shapes() returns at least 4 entries."""
    assert len(all_shapes()) >= 4


# ── AC2 / AC5 ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "name, expected_area, tol",
    [
        # right-isoceles triangle with legs 1,1: area = 0.5
        ("right-isoceles-triangle", 0.5, 1e-9),
        # L-tromino = 3 unit squares: area = 3.0 (vertices span 2x2 minus 1 corner)
        ("l-tromino", 3.0, 1e-9),
        # L-tetromino = 4 unit squares: area = 4.0
        ("l-tetromino", 4.0, 1e-9),
        # Sphinx hexiamond = 6 equilateral triangles of side 1;
        # each has area (√3/4); total = 6*(√3/4) = 3√3/2
        ("sphinx-hexiamond", 6 * (math.sqrt(3) / 4), 1e-6),
    ],
)
def test_shape_area(name: str, expected_area: float, tol: float) -> None:
    """AC2 / AC5: each shipped shape has the expected polygon area."""
    path = get_shape(name)
    poly = path.polygon()
    assert poly.area > 0, f"{name} area must be positive"
    assert math.isclose(poly.area, expected_area, abs_tol=tol), (
        f"{name}: got area {poly.area}, expected {expected_area}"
    )


# ── AC5 — additional shape sanity ─────────────────────────────────────────────


@pytest.mark.parametrize("name", ["right-isoceles-triangle", "l-tromino", "l-tetromino", "sphinx-hexiamond"])
def test_shape_polygon_is_valid(name: str) -> None:
    """AC5: all shipped shapes produce valid, simple polygons."""
    poly = get_shape(name).polygon()
    assert poly.is_valid
    assert poly.is_simple
    assert poly.area > 0
