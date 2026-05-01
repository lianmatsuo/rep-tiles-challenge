"""Entry point: python -m rep_tiles"""

from __future__ import annotations

import sys
import threading
import webbrowser

from .config import DEFAULT_PORT
from .dsl import ShapeNotClosedError, ShapeNotSimpleError


def _import_shapes() -> None:
    """Import shapes.py, triggering all @shape decorators."""
    try:
        import rep_tiles.shapes  # noqa: F401
    except ShapeNotClosedError as exc:
        _die(
            "Shape definition error",
            str(exc),
            hint="Check your edges and turn angles — the path must return to (0,0).",
        )
    except ShapeNotSimpleError as exc:
        _die(
            "Shape definition error",
            str(exc),
            hint="Your polygon crosses itself. Adjust edge lengths or turn angles.",
        )
    except Exception as exc:
        _die("Failed to load shapes.py", str(exc))


def _die(title: str, detail: str, hint: str = "") -> None:
    print(f"\n[rep-tiles] ERROR — {title}")
    print(f"  {detail}")
    if hint:
        print(f"  Hint: {hint}")
    print()
    sys.exit(1)


def _open_browser(url: str, delay: float = 0.8) -> None:
    def _open():
        webbrowser.open(url)

    threading.Timer(delay, _open).start()


def main() -> None:
    _import_shapes()

    url = f"http://localhost:{DEFAULT_PORT}"

    print()
    print("┌─────────────────────────────────────┐")
    print("│           rep-tiles sandbox          │")
    print("├─────────────────────────────────────┤")
    print(f"│  URL:  {url:<29} │")
    print("│  Edit rep_tiles/shapes.py to add    │")
    print("│  your own shape, then restart.      │")
    print("│  Press Ctrl-C to stop.              │")
    print("└─────────────────────────────────────┘")
    print()

    _open_browser(url)

    import uvicorn

    uvicorn.run(
        "rep_tiles.api:app",
        host="127.0.0.1",
        port=DEFAULT_PORT,
        log_level="info",
    )


if __name__ == "__main__":
    main()
