"""Geometry helpers: transform, overlap, contain, fully-tiled detection."""

from __future__ import annotations

import math
from dataclasses import dataclass

from shapely.affinity import rotate, scale, translate
from shapely.geometry import Polygon
from shapely.ops import unary_union

from .config import EPSILON_OVERLAP, EPSILON_TILED


@dataclass(frozen=True)
class Placement:
    name: str
    anchor: tuple[float, float]
    rotation: float = 0.0
    reflected: bool = False


def transform_polygon(
    base: Polygon,
    *,
    anchor: tuple[float, float],
    rotation_deg: float,
    reflected: bool,
    scale_factor: float = 1.0,
) -> Polygon:
    """Apply reflect → scale → rotate → translate (in that order).

    Reflect: mirror across local x-axis (negate y).
    Scale: shrink linearly by 1/sqrt(scale_factor), so AREA shrinks by 1/scale_factor
        (i.e., scale_factor=N means "test rep-N" — N pieces of area frame.area/N).
    Rotate: CCW around origin.
    Translate: move first vertex (after transforms) to `anchor`.
    """
    poly = base
    if reflected:
        poly = scale(poly, xfact=1.0, yfact=-1.0, origin=(0, 0))
    if scale_factor != 1.0:
        s = 1.0 / math.sqrt(scale_factor)
        poly = scale(poly, xfact=s, yfact=s, origin=(0, 0))
    if rotation_deg:
        poly = rotate(poly, rotation_deg, origin=(0, 0), use_radians=False)
    coords = list(poly.exterior.coords)
    if not coords:
        return poly
    fx, fy = coords[0]
    ax, ay = anchor
    poly = translate(poly, xoff=ax - fx, yoff=ay - fy)
    return poly


def piece_polygons(
    placements: list[Placement],
    base_lookup,
    scale_factor: float,
) -> list[Polygon]:
    out = []
    for p in placements:
        base = base_lookup(p.name)
        out.append(
            transform_polygon(
                base,
                anchor=p.anchor,
                rotation_deg=p.rotation,
                reflected=p.reflected,
                scale_factor=scale_factor,
            )
        )
    return out


def any_overlap(pieces: list[Polygon], eps: float = EPSILON_OVERLAP) -> tuple[int, int] | None:
    """Return (i, j) of first overlapping pair, or None."""
    for i in range(len(pieces)):
        for j in range(i + 1, len(pieces)):
            inter = pieces[i].intersection(pieces[j])
            if not inter.is_empty and inter.area > eps:
                return (i, j)
    return None


def out_of_frame(pieces: list[Polygon], frame: Polygon, eps: float = EPSILON_OVERLAP) -> int | None:
    """Return index of first piece not contained in frame, or None."""
    for i, p in enumerate(pieces):
        diff = p.difference(frame)
        if not diff.is_empty and diff.area > eps:
            return i
    return None


def fully_tiled(pieces: list[Polygon], frame: Polygon, eps: float = EPSILON_TILED) -> bool:
    if not pieces:
        return False
    union = unary_union(pieces)
    sd = frame.symmetric_difference(union)
    return sd.area < eps


def infer_n(pieces: list[Polygon], frame: Polygon) -> int | None:
    if not pieces:
        return None
    avg = sum(p.area for p in pieces) / len(pieces)
    if avg <= 0:
        return None
    return round(frame.area / avg)
