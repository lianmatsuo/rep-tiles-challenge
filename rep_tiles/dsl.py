"""Path DSL — turtle-style builder for defining shapes by walking the boundary."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .config import EPSILON_CLOSURE


class ShapeNotClosedError(ValueError):
    """Raised when a Path does not return to its origin within EPSILON_CLOSURE."""


class ShapeNotSimpleError(ValueError):
    """Raised when a Path self-intersects (polygon is not simple)."""


def _cross2d(ox: float, oy: float, ax: float, ay: float, bx: float, by: float) -> float:
    """2-D cross product of vectors OA and OB."""
    return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox)


def _segments_cross(
    p1: tuple[float, float],
    p2: tuple[float, float],
    p3: tuple[float, float],
    p4: tuple[float, float],
) -> bool:
    """Return True if segment p1-p2 properly crosses segment p3-p4 (no shared endpoints)."""
    d1 = _cross2d(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1])
    d2 = _cross2d(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1])
    d3 = _cross2d(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1])
    d4 = _cross2d(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1])
    if ((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and (
        (d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0)
    ):
        return True
    return False


def _make_not_simple_error(verts: list[tuple[float, float]]) -> ShapeNotSimpleError:
    """Brute-force O(n²) search for the first crossing pair; only called on error path."""
    n = len(verts)
    # Build closed ring: segments are (verts[i], verts[(i+1) % n])
    for i in range(n):
        p1, p2 = verts[i], verts[(i + 1) % n]
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                # Adjacent in the closed ring — share vertex verts[0]; skip.
                continue
            p3, p4 = verts[j], verts[(j + 1) % n]
            if _segments_cross(p1, p2, p3, p4):
                return ShapeNotSimpleError(
                    f"Path self-intersects: "
                    f"edge {i} ({p1}→{p2}) crosses edge {j} ({p3}→{p4}). "
                    f"Adjust those edge lengths or the angles between them."
                )
    # Shapely said not simple but we couldn't find a proper crossing — collinear overlap.
    return ShapeNotSimpleError(
        "Path self-intersects: edges overlap or touch in a degenerate way. "
        "Check for zero-length edges or duplicate vertices."
    )


@dataclass
class Path:
    """Build a polygon by walking edges and turning. Turtle-graphics style.

    Start at origin (0,0), heading east (+x).
    `.edge(length)` walks forward.
    `.turn(degrees)` turns LEFT by `degrees`. Negative = right turn.
    The path must close (final vertex within 1e-6 of origin).
    """

    _vertices: list[tuple[float, float]] = field(default_factory=lambda: [(0.0, 0.0)])
    _heading_deg: float = 0.0

    def edge(self, length: float) -> "Path":
        if length <= 0:
            raise ValueError(f"edge length must be positive, got {length}")
        x, y = self._vertices[-1]
        rad = math.radians(self._heading_deg)
        nx = x + length * math.cos(rad)
        ny = y + length * math.sin(rad)
        self._vertices.append((nx, ny))
        return self

    def turn(self, degrees: float) -> "Path":
        self._heading_deg = (self._heading_deg + degrees) % 360
        return self

    @classmethod
    def from_vertices(cls, vertices: list[tuple[float, float]]) -> "Path":
        if len(vertices) < 3:
            raise ValueError("need at least 3 vertices")
        p = cls()
        verts = [(float(x), float(y)) for x, y in vertices]
        # Only append closing vertex if not already closed (avoid double-close).
        x0, y0 = verts[0]
        xN, yN = verts[-1]
        if math.hypot(xN - x0, yN - y0) > EPSILON_CLOSURE:
            verts.append(verts[0])
        p._vertices = verts
        return p

    def vertices(self) -> list[tuple[float, float]]:
        """Return canonical vertex list (first == last dropped)."""
        verts = list(self._vertices)
        if len(verts) >= 2:
            x0, y0 = verts[0]
            xN, yN = verts[-1]
            if math.hypot(xN - x0, yN - y0) <= EPSILON_CLOSURE:
                verts = verts[:-1]
            else:
                raise ShapeNotClosedError(
                    f"Path does not close: gap = ({xN - x0:.6f}, {yN - y0:.6f}). "
                    f"Last vertex {verts[-1]} != origin {verts[0]}."
                )
        from shapely.geometry import Polygon as _Polygon

        poly = _Polygon(verts)
        if not poly.is_simple:
            raise _make_not_simple_error(verts)
        return verts

    def polygon(self):
        """Return shapely Polygon. Imports shapely lazily."""
        from shapely.geometry import Polygon

        return Polygon(self.vertices())
