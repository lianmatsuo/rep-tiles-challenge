"""rep-tiles — interactive rep-tile sandbox."""

__version__ = "0.1.0"

from .dsl import Path, ShapeNotClosedError, ShapeNotSimpleError
from .registry import shape

__all__ = ["Path", "ShapeNotClosedError", "ShapeNotSimpleError", "shape"]
