"""Smoke tests for geometry helpers."""

from shapely.geometry import Polygon

from rep_tiles.geometry import any_overlap, fully_tiled


def _square(x: float, y: float, size: float = 1.0) -> Polygon:
    return Polygon([(x, y), (x + size, y), (x + size, y + size), (x, y + size)])


def test_non_overlapping_squares_returns_none() -> None:
    pieces = [_square(0, 0), _square(1, 0)]
    assert any_overlap(pieces) is None


def test_overlapping_squares_detected() -> None:
    pieces = [_square(0, 0), _square(0.5, 0)]
    result = any_overlap(pieces)
    assert result == (0, 1)


def test_fully_tiled_exact() -> None:
    frame = _square(0, 0, size=2.0)
    pieces = [_square(0, 0), _square(1, 0), _square(0, 1), _square(1, 1)]
    assert fully_tiled(pieces, frame) is True


def test_not_fully_tiled() -> None:
    frame = _square(0, 0, size=2.0)
    pieces = [_square(0, 0), _square(1, 0)]
    assert fully_tiled(pieces, frame) is False
