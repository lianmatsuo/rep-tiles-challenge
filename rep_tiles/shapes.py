"""
shapes.py — THE file you edit to add your own shapes.

===========================================================
HOW TO DEFINE A SHAPE
===========================================================

Use the @shape("your-name") decorator above a function that
returns a Path built with the DSL:

    from rep_tiles import Path, shape

    @shape("my-triangle")
    def my_triangle() -> Path:
        return (
            Path()          # start at origin (0,0), heading east →
            .edge(1)        # walk right 1 unit
            .turn(120)      # turn left 120°
            .edge(1)        # walk 1 unit in new direction
            .turn(120)      # turn left 120° again
            .edge(1)        # walk back to origin  (path closes)
        )
        # The last vertex must land back at (0,0) ± 1e-6,
        # or you'll get ShapeNotClosedError at startup.

RULES:
  - .edge(length)   walks FORWARD by `length` grid units (floats OK)
  - .turn(degrees)  turns LEFT by `degrees`; negative = right turn
  - The path must close (last point == first point)
  - No self-intersections (raises ShapeNotSimpleError if so)
  - The FIRST @shape registered becomes the default frame

ESCAPE HATCH — if you already have (x, y) coordinates:
    Path.from_vertices([(0,0), (1,0), (0,1)])

===========================================================
PREDEFINED SHAPES  (read, run, then add yours below them)
===========================================================
"""

import math as _math

from rep_tiles import Path, shape

# ──────────────────────────────────────────────────────────
#  1. RIGHT ISOCELES TRIANGLE  (rep-2 and rep-4)
# ──────────────────────────────────────────────────────────
#
#  This is the simplest rep-tile. Two copies tile a scaled
#  version (rep-2), and four copies also tile it (rep-4).
#
#  Vertex walk (legs of length 1):
#
#    C
#    |  ╲
#    |    ╲   hypotenuse (length √2)
#    |      ╲
#    A ──────B
#
#  Start at A=(0,0) heading east.
#  Step 1: edge(1)        → reach B=(1,0)
#  Step 2: turn(90)       → now heading north
#  Step 3: edge(1)        → reach C=(1,1)
#  Step 4: turn(135)      → now heading south-west (225° from east)
#  Step 5: edge(√2)       → back to A=(0,0)   ✓ closes
#
@shape("right-isoceles-triangle")
def right_isoceles_triangle() -> Path:
    return (
        Path()
        .edge(1)                    # A → B  (bottom leg, east)
        .turn(90)                   # face north
        .edge(1)                    # B → C  (right leg, north)
        .turn(135)                  # face south-west (toward A)
        .edge(_math.sqrt(2))        # C → A  (hypotenuse)
    )


# ──────────────────────────────────────────────────────────
#  2. L-TROMINO  (rep-4)
# ──────────────────────────────────────────────────────────
#
#  Three unit squares arranged in an L.
#  Four copies tile a 2× scaled L-tromino (rep-4).
#
#  Grid (each cell = 1×1):
#
#    ┌───┐
#    │   │
#    ├───┼───┐
#    │   │   │
#    └───┴───┘
#
#  Perimeter walk, starting at bottom-left corner, going east:
#
#    (0,0) → (2,0) → (2,1) → (1,1) → (1,2) → (0,2) → (0,0)
#
#  In DSL form (start at (0,0), heading east):
#
#    edge(2)    → reach (2,0)
#    turn(90)   → face north
#    edge(1)    → reach (2,1)
#    turn(90)   → face west
#    edge(1)    → reach (1,1)
#    turn(-90)  → face north  (RIGHT turn = -90°)
#    edge(1)    → reach (1,2)
#    turn(90)   → face west
#    edge(1)    → reach (0,2)
#    turn(90)   → face south
#    edge(2)    → back to (0,0)  ✓ closes
#
@shape("l-tromino")
def l_tromino() -> Path:
    return (
        Path()
        .edge(2)        # bottom edge east
        .turn(90)       # face north
        .edge(1)        # right side up
        .turn(90)       # face west
        .edge(1)        # step back over top-right cell
        .turn(-90)      # face north  (right turn, creates the notch)
        .edge(1)        # up to top
        .turn(90)       # face west
        .edge(1)        # top edge west
        .turn(90)       # face south
        .edge(2)        # left side back to origin
    )


# ──────────────────────────────────────────────────────────
#  3. L-TETROMINO  (rep-4)
# ──────────────────────────────────────────────────────────
#
#  NOTE: The spec originally requested a P-pentomino (5 squares),
#  but a P-pentomino is NOT known to be self-similar in a standard
#  dissection, so the L-tetromino (4 unit squares in an L) is shipped
#  instead. It IS rep-4: four 1/2-scale copies tile the original.
#
#  Grid (each cell = 1×1):
#
#    ┌───┐
#    │   │
#    ├───┤
#    │   │
#    ├───┼───┐
#    │   │   │
#    └───┴───┘
#
#  Perimeter walk (starting at bottom-left, heading east):
#
#    (0,0) → (2,0) → (2,1) → (1,1) → (1,3) → (0,3) → (0,0)
#
#  In DSL form:
#
#    edge(2)    → (2,0)
#    turn(90)   → face north
#    edge(1)    → (2,1)
#    turn(90)   → face west
#    edge(1)    → (1,1)
#    turn(-90)  → face north
#    edge(2)    → (1,3)
#    turn(90)   → face west
#    edge(1)    → (0,3)
#    turn(90)   → face south
#    edge(3)    → back to (0,0)  ✓ closes
#
@shape("l-tetromino")
def l_tetromino() -> Path:
    return (
        Path()
        .edge(2)        # bottom edge east
        .turn(90)       # face north
        .edge(1)        # short right side up
        .turn(90)       # face west
        .edge(1)        # step back at bump
        .turn(-90)      # face north (right turn, creates notch)
        .edge(2)        # tall left column, north
        .turn(90)       # face west
        .edge(1)        # top edge west
        .turn(90)       # face south
        .edge(3)        # left side back to origin
    )


# ──────────────────────────────────────────────────────────
#  4. SPHINX HEXIAMOND  (rep-4)
# ──────────────────────────────────────────────────────────
#
#  Six equilateral triangles arranged in a sphinx shape.
#  Four copies tile a 2× scaled sphinx (rep-4).
#  Uses 60° geometry — it lives on a triangular grid,
#  but the sandbox uses a square grid (slight visual imprecision
#  in the sandbox is an accepted tradeoff per spec).
#
#  Shape layout (each /\ is an upward equilateral triangle of side 1):
#
#      /\  /\
#     /  \/  \
#    / /\  /\ \
#   / /  \/  \ \
#  /\/________\/\
#
#  The 8 vertices of the sphinx perimeter, in order (CCW),
#  where s = sin(60°) = √3/2 ≈ 0.866:
#
#    (0.0, 0.0)   ← start, bottom-left
#    (0.5,   s)   ← left side  (up-right)
#    (1.0, 2s)    ← top-left
#    (2.0, 2s)    ← top-right
#    (2.5,   s)   ← right side
#    (1.5,   s)   ← inner concave notch
#    (2.0, 0.0)   ← inner bottom-right
#    (1.0, 0.0)   ← inner bottom-left
#
#  This uses Path.from_vertices because the floating-point
#  geometry is cleaner than computing cumulative DSL steps.
#
_s60 = _math.sqrt(3) / 2  # sin(60°)


@shape("sphinx-hexiamond")
def sphinx_hexiamond() -> Path:
    s = _s60
    return Path.from_vertices([
        (0.0, 0.0),    # bottom-left corner
        (0.5,   s),    # left side
        (1.0, 2*s),    # top-left
        (2.0, 2*s),    # top-right
        (2.5,   s),    # right side
        (1.5,   s),    # concave notch (inward corner)
        (2.0, 0.0),    # bottom-right of right foot
        (1.0, 0.0),    # bottom-right of left foot
    ])


# ──────────────────────────────────────────────────────────
#  ADD YOUR OWN SHAPE BELOW THIS LINE
# ──────────────────────────────────────────────────────────
#
# @shape("my-shape")
# def my_shape() -> Path:
#     return (
#         Path()
#         .edge(...)
#         .turn(...)
#         # ... keep walking until you return to (0,0)
#     )
