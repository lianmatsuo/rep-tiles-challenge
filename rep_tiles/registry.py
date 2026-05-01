"""@shape decorator + module-level registry."""

from __future__ import annotations

from typing import Callable

from .dsl import Path

_REGISTRY: dict[str, Path] = {}


def shape(name: str) -> Callable[[Callable[[], Path]], Callable[[], Path]]:
    """Decorator: registers the function's returned Path under `name`.

    Closure validation happens here — a bad shape fails at import time.
    """

    def decorator(fn: Callable[[], Path]) -> Callable[[], Path]:
        path = fn()
        if not isinstance(path, Path):
            raise TypeError(f"@shape({name!r}) function must return a Path, got {type(path).__name__}")
        path.vertices()
        _REGISTRY[name] = path
        return fn

    return decorator


def all_shapes() -> dict[str, Path]:
    return dict(_REGISTRY)


def get_shape(name: str) -> Path:
    if name not in _REGISTRY:
        raise KeyError(f"unknown shape: {name!r}. Registered: {sorted(_REGISTRY)}")
    return _REGISTRY[name]


def clear_registry() -> None:
    _REGISTRY.clear()
