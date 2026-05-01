# rep-tiles

An interactive sandbox for discovering [rep-tiles](https://en.wikipedia.org/wiki/Rep-tile) — polygons that tile a scaled copy of themselves.

## Quick start

```bash
git clone https://github.com/lianmatsuo/rep-tiles-challenge.git
cd rep-tiles-challenge
pip install -r requirements.txt
python -m rep_tiles
```

Requires Python ≥ 3.11.

Your browser opens to `http://localhost:8000` automatically.

## Define your own shape

Edit `rep_tiles/shapes.py` — it is the only file you need to touch.
Copy an existing example and modify the `.edge()` / `.turn()` chain.
The **first** registered shape becomes the frame (the puzzle outline).

```python
from rep_tiles import Path, shape

@shape("my-shape")
def my_shape() -> Path:
    return (Path()
        .edge(1).turn(90)
        .edge(1).turn(90)
        .edge(1).turn(90)
        .edge(1))   # closing edge inferred automatically
```

Restart `python -m rep_tiles` after editing to reload shapes.

## Controls

```
Click bucket shape  — pick up a piece (ghost follows cursor)
Click canvas        — place piece at snapped grid position
Drag placed piece   — reposition; vertices magnet-snap to frame/other-piece vertices, falling back to grid
Shift-click bucket  — set that shape as the frame
R                   — rotate selected piece +45° CCW
Shift+R             — rotate selected piece -45°
D                   — duplicate selected piece
Delete/Backspace    — remove selected piece
Space               — cycle selection through placed pieces
Escape              — cancel pick-up or deselect
Arrow keys          — nudge selected piece 1 grid unit
Scale slider (1–8)  — pieces and grid shrink, frame stays. Default is 2 (every shape is trivially a 1-rep)
Check rep-tile      — manually verify if the frame is fully tiled
```

When the frame is perfectly tiled you will see: **You made a rep-N tile!**
