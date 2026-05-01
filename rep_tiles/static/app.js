// ── Design tokens mirrored from CSS ──
const TOKEN = {
  bgCanvas:    '#0e0f12',
  bgPanel:     '#16181d',
  gridLine:    'rgba(250,250,250,0.08)',
  frameStroke: '#fafafa',
  frameFill:   'rgba(250,250,250,0.04)',
  pieceFill:   'rgba(124,158,255,0.14)',
  pieceStroke: 'rgba(124,158,255,0.8)',
  accent:      '#7c9eff',
  success:     '#3ad17a',
  error:       '#ff6b6b',
  text:        '#e8eaed',
  textMuted:   '#8a8f98',
};

const BASE_PX = 40;

// ── State ──
let shapes = [];        // [{name, vertices}]
let frameName = null;   // name of the frame shape
let scale = 2;          // integer 1-8 (1-rep is trivial; default to 2)
let placements = [];    // [{id, name, anchor:[x,y], rotation:0|90|180|270, reflected:false}]
let nextId = 1;

// UI state machine: 'idle' | 'picked' | 'selected'
let uiState = 'idle';
let pickedShape = null;     // name of shape picked from bucket
let pickedRotation = 0;     // rotation applied to the ghost while picking
let selectedId = null;      // id of selected placed piece
let ghostPos = null;        // {gx, gy} grid coords of ghost cursor
let dragState = null;       // {id, startAnchor, startMouse}
let pendingRollback = null; // {id, anchor, rotation} — restored if validate returns ok=false
let validationTimer = null;
let lastCoverage = 0;
let gridPulseActive = false;
let gridPulseColor = TOKEN.gridLine;
let shakeIds = new Set();   // piece ids currently shaking (visual flash)
let hintShown = true;

// Canvas setup
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
let dpr = window.devicePixelRatio || 1;
let canvasW = 0, canvasH = 0;

// Display zoom for zoom-to-fit
let displayZoom = 1;
// Canvas offset (pan) so frame is centered
let panX = 0, panY = 0;

// ── Utility ──
// Grid units are FRAME units (1 unit = 1 frame edge of length 1).
// At displayZoom=1, 1 frame unit = BASE_PX px. Anchor sent to API is in this same space.
// Grid lines are drawn at every (1/scale) frame-units; snap rounds to that sub-grid.
function gridToPx(gx, gy) {
  const pxPerUnit = BASE_PX * displayZoom;
  return [panX + gx * pxPerUnit, panY + gy * pxPerUnit];
}

function pxToGrid(px, py) {
  const pxPerUnit = BASE_PX * displayZoom;
  return [(px - panX) / pxPerUnit, (py - panY) / pxPerUnit];
}

// Grid uses an integer subdivision of the frame so lines always meet frame
// corners. Divisor scales linearly with n so each step (5, 6, 7, 8) looks
// visibly different. drawGrid auto-skips lines below 4 px, so very dense
// grids thin themselves gracefully.
//   n=1 → 4    n=2 → 8     n=3 → 12   n=4 → 16
//   n=5 → 20   n=6 → 24    n=7 → 28   n=8 → 32
function gridDivisor() {
  return Math.max(4, scale * 4);
}

function snapGrid(gx, gy) {
  const step = 1 / gridDivisor();
  return [Math.round(gx / step) * step, Math.round(gy / step) * step];
}

// Bounding box of a shape after the current scale + given rotation, in the
// piece's local frame (i.e., relative to its anchor / vertex 0).
function pieceBBoxLocal(shapeName, rotDeg) {
  const shape = getShape(shapeName);
  if (!shape) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const linScale = 1 / Math.sqrt(scale);
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [vx, vy] of shape.vertices) {
    const x = (cos * vx - sin * vy) * linScale;
    const y = (sin * vx + cos * vy) * linScale;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

// Vertex-magnet snap. The geometry — frame vertices and every already-placed
// piece's vertices — defines the snap targets. When any vertex of the piece
// being placed comes within tolerance of any target vertex, we shift the
// anchor so those two vertices coincide exactly. This works for ANY shape
// regardless of irrational coordinates (60° sphinx, 45° right-iso, etc.) and
// makes adjacent tilings line up exactly.
//
// Fallback: if no vertex pair is within tolerance, snap the anchor to the
// rectangular 1/k grid as before.
function snapAnchorForPiece(rawX, rawY, shapeName, rotDeg, excludeId = null) {
  const shape = getShape(shapeName);
  if (!shape) {
    const step = 1 / gridDivisor();
    return [Math.round(rawX / step) * step, Math.round(rawY / step) * step];
  }

  // Piece vertices at the raw anchor.
  const liveVerts = pieceVerticesGrid(shape, [rawX, rawY], rotDeg, false);

  // Snap targets: every frame vertex + every vertex of every other piece.
  const targets = [];
  const frame = getFrameShape();
  if (frame) for (const v of frame.vertices) targets.push([v[0], v[1]]);
  for (const other of placements) {
    if (other.id === excludeId) continue;
    const oShape = getShape(other.name);
    if (!oShape) continue;
    const oVerts = pieceVerticesGrid(oShape, other.anchor, other.rotation, other.reflected);
    for (const v of oVerts) targets.push(v);
  }

  // Tolerance: ~1.5 grid cells, so the magnet pulls when you're "close enough".
  // Squared compare to avoid sqrt in the hot loop.
  const tol = (1 / gridDivisor()) * 1.5;
  const tol2 = tol * tol;
  let bestD2 = tol2;
  let bestOff = null;
  for (const pv of liveVerts) {
    for (const tv of targets) {
      const dx = tv[0] - pv[0];
      const dy = tv[1] - pv[1];
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestOff = [dx, dy];
      }
    }
  }

  if (bestOff) return [rawX + bestOff[0], rawY + bestOff[1]];

  // No vertex magnet in range — fall back to the rectangular grid.
  const step = 1 / gridDivisor();
  return [Math.round(rawX / step) * step, Math.round(rawY / step) * step];
}

function getShape(name) {
  return shapes.find(s => s.name === name);
}

function getFrameShape() {
  return shapes.find(s => s.name === frameName);
}

// Transform shape vertices: reflect → scale → rotate → translate to anchor
// Returns array of [px_x, px_y] in canvas pixels
function transformedVerticesPx(vertices, anchor, rotDeg, reflected, scaleFactor) {
  // Frame uses scaleFactor=1 → renders at full BASE_PX*displayZoom per unit.
  // Pieces use scaleFactor=scale → render at 1/sqrt(scale) of frame LINEAR size,
  //   so AREA is 1/scale (rep-N means N pieces of area frame.area/N).
  const pxPerUnit = (BASE_PX * displayZoom) / Math.sqrt(scaleFactor);
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  return vertices.map(([vx, vy]) => {
    let x = vx, y = vy;
    if (reflected) y = -y;
    // rotate CCW
    const rx = cos * x - sin * y;
    const ry = sin * x + cos * y;
    // translate anchor (in frame-units) → pixels
    const [ax, ay] = gridToPx(anchor[0], anchor[1]);
    return [ax + rx * pxPerUnit, ay + ry * pxPerUnit];
  });
}

// Get bounding box of a polygon (array of [x,y])
function polyBBox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// ── Zoom-to-fit ──
function computeZoomToFit() {
  const frame = getFrameShape();
  if (!frame) return;

  const availW = canvasW;
  const availH = canvasH;

  // Frame rendered at scale=1, displayZoom=1: vertices are in grid units, 1 unit = BASE_PX px
  const rawPts = frame.vertices.map(([x, y]) => [x * BASE_PX, y * BASE_PX]);
  const bb = polyBBox(rawPts);

  const padFactor = 0.70; // frame fills 70% of canvas
  const pad = 24;
  const zoomX = (availW - pad * 2) * padFactor / bb.w;
  const zoomY = (availH - pad * 2) * padFactor / bb.h;
  // No upper cap — the frame should always fill ~70% of whichever axis is tighter.
  displayZoom = Math.min(zoomX, zoomY);

  // Frame vertices are in shape-local grid units, 1 unit = BASE_PX px at displayZoom=1
  // Frame is drawn at scaleFactor=1, so pixel width = vertex_range * displayZoom
  const framePxW = (bb.maxX - bb.minX) * displayZoom;
  const framePxH = (bb.maxY - bb.minY) * displayZoom;

  panX = (canvasW - framePxW) / 2 - bb.minX * displayZoom;
  panY = (canvasH - framePxH) / 2 - bb.minY * displayZoom;
}

// ── Canvas resize ──
function resizeCanvas() {
  const wrapper = canvas.parentElement;
  canvasW = wrapper.clientWidth;
  canvasH = wrapper.clientHeight;
  dpr = window.devicePixelRatio || 1;
  canvas.width = canvasW * dpr;
  canvas.height = canvasH * dpr;
  canvas.style.width = canvasW + 'px';
  canvas.style.height = canvasH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  computeZoomToFit();
}

// ── Drawing ──
function drawGrid() {
  // Grid lines match the snap divisor so they always land on frame corners.
  const cellPx = (BASE_PX / gridDivisor()) * displayZoom;
  if (cellPx < 4) return; // too dense, skip
  ctx.save();
  ctx.strokeStyle = gridPulseColor;
  ctx.lineWidth = 1;
  for (let x = panX % cellPx - cellPx; x < canvasW + cellPx; x += cellPx) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvasH);
    ctx.stroke();
  }
  for (let y = panY % cellPx - cellPx; y < canvasH + cellPx; y += cellPx) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvasW, y);
    ctx.stroke();
  }
  ctx.restore();
}

function pathFromPts(pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

function drawFrame() {
  const frame = getFrameShape();
  if (!frame) return;

  // Frame always drawn at scale factor 1, anchor at origin, no rotation
  const pts = transformedVerticesPx(frame.vertices, [0, 0], 0, false, 1);

  ctx.save();
  // Dotted fill
  ctx.setLineDash([4, 6]);
  ctx.fillStyle = TOKEN.frameFill;
  pathFromPts(pts);
  ctx.fill();
  // Solid stroke
  ctx.setLineDash([]);
  ctx.strokeStyle = TOKEN.frameStroke;
  ctx.lineWidth = 2;
  pathFromPts(pts);
  ctx.stroke();
  ctx.restore();
}

function drawPiece(pl, opts = {}) {
  const shape = getShape(pl.name);
  if (!shape) return;

  const pts = transformedVerticesPx(shape.vertices, pl.anchor, pl.rotation, pl.reflected, scale);

  ctx.save();

  const isShaking = shakeIds.has(pl.id);
  const isSelected = (pl.id === selectedId);
  const isError = isShaking;

  let fillStyle = TOKEN.pieceFill;
  let strokeStyle = TOKEN.pieceStroke;
  let alpha = opts.alpha ?? 1;

  if (isError) {
    strokeStyle = TOKEN.error;
    fillStyle = 'rgba(255,107,107,0.15)';
  } else if (isSelected) {
    strokeStyle = TOKEN.accent;
  }

  ctx.globalAlpha = alpha;
  pathFromPts(pts);
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = isSelected ? 2 : 1.5;
  ctx.stroke();

  // Selection ring: outer ring + anchor dot
  if (isSelected && !isError) {
    ctx.globalAlpha = alpha * 0.6;
    ctx.strokeStyle = TOKEN.accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    pathFromPts(pts);
    ctx.stroke();

    // Anchor dot
    const [ax, ay] = gridToPx(pl.anchor[0], pl.anchor[1]);
    ctx.beginPath();
    ctx.arc(ax, ay, 3, 0, Math.PI * 2);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = TOKEN.accent;
    ctx.fill();
  }

  ctx.restore();
}

// Compute the anchor (vertex[0] post-rotation) that places the piece's
// centroid at (cursorGx, cursorGy). Used so the cursor sits in the middle
// of the ghost, not on the canonical first vertex.
function anchorForCentroidAt(shapeName, rotDeg, cursorGx, cursorGy) {
  const shape = getShape(shapeName);
  if (!shape) return [cursorGx, cursorGy];
  const [cxLocal, cyLocal] = polygonCentroidLocal(shape.vertices);
  const linScale = 1 / Math.sqrt(scale);
  const sx = cxLocal * linScale;
  const sy = cyLocal * linScale;
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return [cursorGx - (cos * sx - sin * sy), cursorGy - (sin * sx + cos * sy)];
}

function drawGhost() {
  if (!pickedShape || !ghostPos) return;
  const shape = getShape(pickedShape);
  if (!shape) return;

  // Cursor visually tracks the centroid, but we snap the ANCHOR (vertex 0) —
  // and prefer flush-with-frame / flush-with-piece alignments over the grid
  // when they're closer to the cursor.
  const [rawAx, rawAy] = anchorForCentroidAt(pickedShape, pickedRotation, ghostPos.gx, ghostPos.gy);
  const [ax, ay] = snapAnchorForPiece(rawAx, rawAy, pickedShape, pickedRotation);
  const pts = transformedVerticesPx(shape.vertices, [ax, ay], pickedRotation, false, scale);

  ctx.save();
  ctx.globalAlpha = 0.6;
  pathFromPts(pts);
  ctx.fillStyle = TOKEN.pieceFill;
  ctx.fill();
  ctx.strokeStyle = TOKEN.accent;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.stroke();

  // Snap cross — drawn at the snapped anchor (corner that lands on the grid).
  const [sx, sy] = gridToPx(ax, ay);
  ctx.setLineDash([]);
  ctx.strokeStyle = TOKEN.accent;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.8;
  const cs = 6;
  ctx.beginPath();
  ctx.moveTo(sx - cs, sy); ctx.lineTo(sx + cs, sy);
  ctx.moveTo(sx, sy - cs); ctx.lineTo(sx, sy + cs);
  ctx.stroke();
  ctx.restore();
}

function drawSnapIndicator() {
  if (!dragState || !ghostPos) return;
  const [sgx, sgy] = snapGrid(ghostPos.gx, ghostPos.gy);
  const [sx, sy] = gridToPx(sgx, sgy);
  ctx.save();
  ctx.strokeStyle = TOKEN.accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(sx, sy, 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function render() {
  ctx.clearRect(0, 0, canvasW, canvasH);
  ctx.fillStyle = TOKEN.bgCanvas;
  ctx.fillRect(0, 0, canvasW, canvasH);

  drawGrid();
  drawFrame();

  for (const pl of placements) {
    drawPiece(pl);
  }

  if (dragState) {
    drawSnapIndicator();
  }
  if (uiState === 'picked') {
    drawGhost();
  }
}

// ── Bucket rendering ──
function renderBucketCard(shape) {
  const card = document.createElement('div');
  const isFrame = (shape.name === frameName);
  card.className = 'bucket-card' + (isFrame ? ' is-frame' : '');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  const displayName = shape.name.length > 18 ? shape.name.slice(0, 17) + '…' : shape.name;
  card.setAttribute('aria-label',
    isFrame
      ? `${shape.name} (current frame). Pick up to place a copy. Shift+click to keep as frame.`
      : `Pick up ${shape.name}. Shift+click to set as frame.`);
  card.setAttribute('aria-pressed', 'false');
  card.setAttribute('title', shape.name);
  card.dataset.name = shape.name;

  const previewCanvas = document.createElement('canvas');
  const previewSize = 100;
  const previewDpr = window.devicePixelRatio || 1;
  previewCanvas.width = previewSize * previewDpr;
  previewCanvas.height = previewSize * previewDpr;
  previewCanvas.style.width = previewSize + 'px';
  previewCanvas.style.height = previewSize + 'px';
  drawBucketPreview(previewCanvas, shape);

  const nameEl = document.createElement('div');
  nameEl.className = 'shape-name';
  nameEl.textContent = displayName;

  card.appendChild(previewCanvas);
  card.appendChild(nameEl);

  if (isFrame) {
    const badge = document.createElement('div');
    badge.className = 'bucket-frame-badge';
    badge.textContent = 'frame';
    card.appendChild(badge);
  }

  // Mousedown picks up the shape (drag-and-drop from bucket). The piece is
  // placed on the canvas's mouseup. Click-without-drag still works because a
  // mousedown→mouseup pair on the same canvas spot is exactly what placement
  // expects. Keyboard (Enter/Space) keeps the click-to-pick fallback.
  card.addEventListener('mousedown', e => {
    e.preventDefault();
    if (e.shiftKey) {
      setFrame(shape.name);
    } else {
      onBucketCardPickup(shape.name);
    }
  });
  card.addEventListener('keydown', e => {
    if (e.shiftKey && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      setFrame(shape.name);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onBucketCardClick(shape.name, card);
    }
  });

  return card;
}

function drawBucketPreview(previewCanvas, shape) {
  const pctx = previewCanvas.getContext('2d');
  const pdpr = window.devicePixelRatio || 1;
  pctx.setTransform(pdpr, 0, 0, pdpr, 0, 0);
  const size = previewCanvas.width / pdpr;

  pctx.clearRect(0, 0, size, size);
  pctx.fillStyle = TOKEN.bgPanel;
  pctx.fillRect(0, 0, size, size);

  const vertices = shape.vertices;
  const pad = 10;

  // Bounding box in shape-local grid units
  const bb = polyBBox(vertices.map(([x, y]) => [x, y]));

  // Base fit factor: how many px per grid unit to fill the card at scale=1
  const baseUnitsPerPx = Math.min(
    (size - pad * 2) / (bb.w || 1),
    (size - pad * 2) / (bb.h || 1),
  );
  // Bucket previews always render at fit-to-card — they're a menu, not a
  // preview of post-placement size. Pieces shrink on the grid, not in the bucket.
  const unitsPerPx = baseUnitsPerPx;

  const renderedW = bb.w * unitsPerPx;
  const renderedH = bb.h * unitsPerPx;

  // Fall back to a dot when the shape would be too small to see
  if (renderedW < 8 || renderedH < 8) {
    pctx.beginPath();
    pctx.arc(size / 2, size / 2, 2, 0, Math.PI * 2);
    pctx.fillStyle = TOKEN.pieceStroke;
    pctx.fill();
    return;
  }

  const offX = (size - renderedW) / 2 - bb.minX * unitsPerPx;
  const offY = (size - renderedH) / 2 - bb.minY * unitsPerPx;

  pctx.save();
  pctx.beginPath();
  pctx.moveTo(offX + vertices[0][0] * unitsPerPx, offY + vertices[0][1] * unitsPerPx);
  for (let i = 1; i < vertices.length; i++) {
    pctx.lineTo(offX + vertices[i][0] * unitsPerPx, offY + vertices[i][1] * unitsPerPx);
  }
  pctx.closePath();
  pctx.fillStyle = TOKEN.pieceFill;
  pctx.fill();
  pctx.strokeStyle = TOKEN.pieceStroke;
  pctx.lineWidth = 1.5;
  pctx.stroke();
  pctx.restore();
}

function refreshBucket() {
  const list = document.getElementById('bucket-list');
  list.innerHTML = '';
  if (!shapes.length) {
    const empty = document.createElement('div');
    empty.className = 'bucket-empty';
    empty.textContent = 'No shapes registered. Edit rep_tiles/shapes.py.';
    list.appendChild(empty);
    return;
  }
  for (const shape of shapes) {
    list.appendChild(renderBucketCard(shape));
  }
}

function updateBucketPressedState() {
  const cards = document.querySelectorAll('.bucket-card');
  for (const card of cards) {
    const pressed = (uiState === 'picked' && card.dataset.name === pickedShape);
    card.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }
}

// ── Status bar ──
function updateStatus() {
  const pct = Math.floor(lastCoverage * 100);
  document.getElementById('status-text').textContent =
    `${placements.length} placed · ${pct}% filled`;
}

// ── Live region ──
function announce(msg) {
  const el = document.getElementById('live-region');
  el.textContent = '';
  requestAnimationFrame(() => { el.textContent = msg; });
}

// ── Toast ──
let toastTimeout = null;
function showToast(msg, type = 'info', duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast visible ' + type;
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    el.className = 'toast';
  }, duration);
}

// ── Grid pulse ──
function triggerGridPulse() {
  if (gridPulseActive) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    gridPulseColor = 'rgba(58,209,122,0.20)';
    setTimeout(() => { gridPulseColor = TOKEN.gridLine; render(); }, 600);
    return;
  }
  gridPulseActive = true;
  const start = performance.now();
  const duration = 800;
  function step(now) {
    const t = Math.min((now - start) / duration, 1);
    const alpha = 0.08 + 0.12 * Math.sin(t * Math.PI);
    gridPulseColor = `rgba(58,209,122,${alpha.toFixed(3)})`;
    render();
    if (t < 1) requestAnimationFrame(step);
    else {
      gridPulseColor = TOKEN.gridLine;
      gridPulseActive = false;
      render();
    }
  }
  requestAnimationFrame(step);
}

// ── Error flash ──
function flashError(id) {
  shakeIds.add(id);
  render();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const duration = reduced ? 600 : 400;
  setTimeout(() => {
    shakeIds.delete(id);
    render();
  }, duration);
}

// ── Right-rail buttons ──
function updateContextPanel() {
  const hasSelection = (uiState === 'selected' && selectedId !== null);
  ['btn-rotate-ccw', 'btn-rotate-cw', 'btn-duplicate', 'btn-delete'].forEach(id => {
    document.getElementById(id).disabled = !hasSelection;
  });
}

// ── Validation ──
async function validate(explicit = false) {
  if (!frameName) return;
  const body = {
    frame: frameName,
    scale: scale,
    placements: placements.map(p => ({
      name: p.name,
      anchor: p.anchor,
      rotation: p.rotation,
      reflected: p.reflected,
    })),
  };
  try {
    const resp = await fetch('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    lastCoverage = data.coverage ?? 0;
    updateStatus();

    if (!data.ok) {
      let reason = 'Invalid placement';
      let affectedId = null;
      if (data.overlap_pair !== null && data.overlap_pair !== undefined) {
        const idx = Array.isArray(data.overlap_pair) ? data.overlap_pair[0] : data.overlap_pair;
        affectedId = placements[idx]?.id ?? null;
        reason = 'Pieces overlap';
      } else if (data.out_of_frame_index !== null && data.out_of_frame_index !== undefined) {
        affectedId = placements[data.out_of_frame_index]?.id ?? null;
        reason = 'Piece is outside the frame';
      }
      // Roll back the piece that triggered this validation to its pre-move state
      if (pendingRollback) {
        const pl = placements.find(p => p.id === pendingRollback.id);
        if (pl) {
          pl.anchor = [...pendingRollback.anchor];
          pl.rotation = pendingRollback.rotation;
        }
        pendingRollback = null;
        render();
      }
      if (affectedId !== null) flashError(affectedId);
      announce(reason);
      if (explicit) showToast(reason, 'info');
    } else {
      pendingRollback = null;
      if (data.fully_tiled) {
        const n = data.n ?? placements.length;
        const msg = `You made a rep-${n} tile!`;
        showToast(msg, 'success', 4000);
        announce(msg);
        triggerGridPulse();
      } else if (explicit) {
        showToast('Not yet — keep going', 'info');
        announce('Not yet — keep going');
      }
    }
  } catch (_) {
    // Network error or server not up; silently skip
  }
}

function scheduleValidation() {
  if (validationTimer) clearTimeout(validationTimer);
  validationTimer = setTimeout(() => validate(false), 200);
}

// ── Placement operations ──
function addPlacement(name, anchor, rotation = 0) {
  const id = nextId++;
  placements.push({ id, name, anchor: [...anchor], rotation, reflected: false });
  if (hintShown) {
    hintShown = false;
    document.getElementById('hint').classList.add('hidden');
  }
  return id;
}

function removePlacement(id) {
  const idx = placements.findIndex(p => p.id === id);
  if (idx === -1) return;
  placements.splice(idx, 1);
  if (selectedId === id) {
    selectedId = null;
    uiState = 'idle';
  }
}

// Polygon centroid in shape-local coords (area-weighted, handles concave shapes).
function polygonCentroidLocal(vertices) {
  let cx = 0, cy = 0, areaSum = 0;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = vertices[i];
    const [x1, y1] = vertices[(i + 1) % n];
    const cross = x0 * y1 - x1 * y0;
    areaSum += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(areaSum) < 1e-12) return [0, 0];
  const a = areaSum / 2;
  return [cx / (6 * a), cy / (6 * a)];
}

// ── Local collision / containment (used to block invalid drags) ──
// All inputs are arrays of [gx, gy] in frame-units.

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// Distance² from (x,y) to segment AB.
function distSqToSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return (x - ax) * (x - ax) + (y - ay) * (y - ay);
  let t = ((x - ax) * dx + (y - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx, py = ay + t * dy;
  return (x - px) * (x - px) + (y - py) * (y - py);
}

// pointInPoly that also returns true for points on or very near the boundary.
// This lets pieces whose vertices touch the frame edge count as "inside".
function pointInPolyTolerant(x, y, poly, eps = 1e-6) {
  if (pointInPoly(x, y, poly)) return true;
  const eps2 = eps * eps;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (distSqToSegment(x, y, poly[i][0], poly[i][1], poly[j][0], poly[j][1]) <= eps2) {
      return true;
    }
  }
  return false;
}

// Segments AB and CD: do they cross strictly inside (ignore touching endpoints)?
function segmentsCrossStrict(a, b, c, d) {
  const d1 = (c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0]);
  const d2 = (d[0] - a[0]) * (b[1] - a[1]) - (d[1] - a[1]) * (b[0] - a[0]);
  const d3 = (a[0] - c[0]) * (d[1] - c[1]) - (a[1] - c[1]) * (d[0] - c[0]);
  const d4 = (b[0] - c[0]) * (d[1] - c[1]) - (b[1] - c[1]) * (d[0] - c[0]);
  const eps = 1e-9;
  return (
    ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
    ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
  );
}

// True if every vertex of `inner` is inside `outer` AND no edges of inner
// cross edges of outer. Approximate but conservative for our convex/simple cases.
function polyContainsPoly(outer, inner) {
  // Tolerant point-in-poly: vertices exactly on the frame boundary count as
  // contained. Without this, a piece whose corner sits on the frame's edge
  // would be rejected (the wall wouldn't let you push into the corner).
  for (const [x, y] of inner) if (!pointInPolyTolerant(x, y, outer)) return false;
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i], b = inner[(i + 1) % inner.length];
    for (let j = 0; j < outer.length; j++) {
      const c = outer[j], d = outer[(j + 1) % outer.length];
      if (segmentsCrossStrict(a, b, c, d)) return false;
    }
  }
  return true;
}

function pointStrictlyInPoly(x, y, poly, eps = 1e-6) {
  if (!pointInPoly(x, y, poly)) return false;
  const eps2 = eps * eps;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (distSqToSegment(x, y, poly[i][0], poly[i][1], poly[j][0], poly[j][1]) <= eps2) {
      return false; // on boundary — adjacent tiling, not overlap
    }
  }
  return true;
}

// True if polygons share INTERIOR area. Boundary-touching does not count.
function polysOverlap(p, q) {
  for (const [x, y] of p) if (pointStrictlyInPoly(x, y, q)) return true;
  for (const [x, y] of q) if (pointStrictlyInPoly(x, y, p)) return true;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    for (let j = 0; j < q.length; j++) {
      const c = q[j], d = q[(j + 1) % q.length];
      if (segmentsCrossStrict(a, b, c, d)) return true;
    }
  }
  return false;
}

// Get a piece's polygon in frame-units (no display-pixel transform).
function pieceVerticesGrid(shape, anchor, rotDeg, reflected) {
  const linScale = 1 / Math.sqrt(scale);
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return shape.vertices.map(([vx, vy]) => {
    let x = vx, y = vy;
    if (reflected) y = -y;
    const rx = (cos * x - sin * y) * linScale;
    const ry = (sin * x + cos * y) * linScale;
    return [anchor[0] + rx, anchor[1] + ry];
  });
}

function frameVerticesGrid() {
  const f = getFrameShape();
  if (!f) return null;
  return f.vertices.map(([x, y]) => [x, y]);
}

// Would dropping/dragging `placement` (with proposed anchor/rotation) be a
// valid placement? — fully inside frame and no overlap with other placements.
function isPlacementValid(placement, otherPlacements) {
  const shape = getShape(placement.name);
  const frame = frameVerticesGrid();
  if (!shape || !frame) return false;
  const verts = pieceVerticesGrid(shape, placement.anchor, placement.rotation, placement.reflected);
  if (!polyContainsPoly(frame, verts)) return false;
  for (const other of otherPlacements) {
    const oShape = getShape(other.name);
    if (!oShape) continue;
    const oVerts = pieceVerticesGrid(oShape, other.anchor, other.rotation, other.reflected);
    if (polysOverlap(verts, oVerts)) return false;
  }
  return true;
}

function rotatePlacement(id, delta) {
  const pl = placements.find(p => p.id === id);
  if (!pl) return;
  const shape = getShape(pl.name);
  if (!shape) return;

  const prevRotation = pl.rotation;
  const prevAnchor = [...pl.anchor];

  // Rotate about the piece's visual centroid so it pivots in place.
  // anchor = piece origin (vertex[0]) in frame-units.
  // centroid_world = anchor + R(rot) * (centroid_local / sqrt(scale))
  // new_anchor = centroid_world - R(rot+delta) * (centroid_local / sqrt(scale))
  const [cxLocal, cyLocal] = polygonCentroidLocal(shape.vertices);
  const linScale = 1 / Math.sqrt(scale);
  const sx = cxLocal * linScale;
  const sy = cyLocal * linScale;

  const oldRad = (prevRotation * Math.PI) / 180;
  const newRot = ((prevRotation + delta) % 360 + 360) % 360;
  const newRad = (newRot * Math.PI) / 180;

  const cosO = Math.cos(oldRad), sinO = Math.sin(oldRad);
  const cosN = Math.cos(newRad), sinN = Math.sin(newRad);

  // centroid in world = anchor + rotated scaled local centroid
  const cxWorld = prevAnchor[0] + (cosO * sx - sinO * sy);
  const cyWorld = prevAnchor[1] + (sinO * sx + cosO * sy);

  // new anchor pulls centroid back to same spot under the new rotation
  const newAnchorX = cxWorld - (cosN * sx - sinN * sy);
  const newAnchorY = cyWorld - (sinN * sx + cosN * sy);

  // Wall-collision: refuse the rotation if it would overlap another piece or
  // leave the frame. No flash, no rollback — the piece simply doesn't rotate.
  const others = placements.filter(p => p.id !== pl.id);
  const probe = { name: pl.name, anchor: [newAnchorX, newAnchorY], rotation: newRot, reflected: pl.reflected };
  if (!isPlacementValid(probe, others)) {
    announce('Cannot rotate — would overlap or exit frame');
    return;
  }

  pl.rotation = newRot;
  pl.anchor = [newAnchorX, newAnchorY];
  pendingRollback = null; // rotation accepted up-front; nothing to roll back
}

function getPlacementAt(gx, gy) {
  // Hit-test: check if grid point is inside any placed piece polygon (simple bbox check then polygon)
  const px = gridToPx(gx, gy);
  for (let i = placements.length - 1; i >= 0; i--) {
    const pl = placements[i];
    const shape = getShape(pl.name);
    if (!shape) continue;
    const pts = transformedVerticesPx(shape.vertices, pl.anchor, pl.rotation, pl.reflected, scale);
    if (pointInPolygon(px[0], px[1], pts)) return pl;
  }
  return null;
}

function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Mouse / keyboard event handlers ──
canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const [gx, gy] = pxToGrid(mx, my);

  if (dragState) {
    ghostPos = { gx, gy };
    // Smooth drag with wall-collision. Snap happens on mouseup.
    const pl = placements.find(p => p.id === dragState.id);
    if (pl) {
      const dx = gx - dragState.startGrid[0];
      const dy = gy - dragState.startGrid[1];
      const proposedAnchor = [
        dragState.startAnchor[0] + dx,
        dragState.startAnchor[1] + dy,
      ];
      const others = placements.filter(p => p.id !== pl.id);
      const probe = { name: pl.name, anchor: proposedAnchor, rotation: pl.rotation, reflected: pl.reflected };
      if (isPlacementValid(probe, others)) {
        pl.anchor = proposedAnchor;
      }
      // else: ignore this mousemove — piece stays at last valid anchor.
    }
    render();
    return;
  }

  if (uiState === 'picked') {
    ghostPos = { gx, gy };
    render();
  }
});

canvas.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const [gx, gy] = pxToGrid(mx, my);
  const [sgx, sgy] = snapGrid(gx, gy);

  if (uiState === 'picked') {
    // Cursor is at the centroid; snap the ANCHOR (vertex 0) so corners align.
    // We do NOT pre-reject invalid placements here — let the click land and
    // rely on the backend validate + rollback flash to show the rejection.
    // The wall-collision check still gates dragging; this restores the
    // click-to-place affordance the user expects.
    const [rawAx, rawAy] = anchorForCentroidAt(pickedShape, pickedRotation, gx, gy);
    const [ax, ay] = snapAnchorForPiece(rawAx, rawAy, pickedShape, pickedRotation);
    const id = addPlacement(pickedShape, [ax, ay], pickedRotation);
    selectedId = id;
    uiState = 'selected';
    pickedShape = null; pickedRotation = 0;
    updateBucketPressedState();
    updateContextPanel();
    scheduleValidation();
    announce('Piece placed');
    render();
    return;
  }

  // Check if clicking on a placed piece
  const hit = getPlacementAt(gx, gy);
  if (hit) {
    // Start drag
    dragState = {
      id: hit.id,
      startAnchor: [...hit.anchor],
      startGrid: [gx, gy],   // unsnapped cursor for smooth drag delta
    };
    selectedId = hit.id;
    uiState = 'selected';
    ghostPos = { gx, gy };
    updateContextPanel();
    render();
    return;
  }

  // Click on empty canvas: deselect
  if (uiState === 'selected') {
    selectedId = null;
    uiState = 'idle';
    updateContextPanel();
    render();
  }
});

canvas.addEventListener('mouseup', e => {
  // Drop a freshly-picked bucket shape: the user mousedown'd on a bucket card
  // and released over the canvas. Place at the snapped cursor position.
  if (uiState === 'picked' && pickedShape) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const [gx, gy] = pxToGrid(mx, my);
    const [rawAx, rawAy] = anchorForCentroidAt(pickedShape, pickedRotation, gx, gy);
    const [ax, ay] = snapAnchorForPiece(rawAx, rawAy, pickedShape, pickedRotation);
    // Wall-collision: don't drop a piece into an invalid position.
    const probe = { name: pickedShape, anchor: [ax, ay], rotation: pickedRotation, reflected: false };
    if (!isPlacementValid(probe, placements)) {
      announce('Cannot drop here — would overlap or exit frame');
      render();
      return;
    }
    const id = addPlacement(pickedShape, [ax, ay], pickedRotation);
    selectedId = id;
    uiState = 'selected';
    pickedShape = null; pickedRotation = 0;
    ghostPos = null;
    updateBucketPressedState();
    updateContextPanel();
    render();
    return;
  }

  if (!dragState) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const [gx, gy] = pxToGrid(mx, my);

  const pl = placements.find(p => p.id === dragState.id);
  if (pl) {
    // Vertex-magnet snap on release: prefer aligning piece vertices with
    // frame/other-piece vertices over the rectangular grid. Excludes the
    // dragged piece from its own snap targets.
    const live = pl.anchor;
    const [sax, say] = snapAnchorForPiece(live[0], live[1], pl.name, pl.rotation, pl.id);
    const others = placements.filter(p => p.id !== pl.id);
    const probe = { name: pl.name, anchor: [sax, say], rotation: pl.rotation, reflected: pl.reflected };
    if (isPlacementValid(probe, others)) {
      pl.anchor = [sax, say];
    }
    pendingRollback = null;
  }
  dragState = null;
  ghostPos = null;
  scheduleValidation();
  render();
});

canvas.addEventListener('mouseleave', () => {
  if (uiState === 'picked') {
    ghostPos = null;
    render();
  }
  if (dragState) {
    // Cancel drag, snap back to start
    const pl = placements.find(p => p.id === dragState.id);
    if (pl) pl.anchor = [...dragState.startAnchor];
    dragState = null;
    ghostPos = null;
    render();
  }
});

// Keyboard handling
window.addEventListener('keydown', e => {
  // Don't handle if focus is on an input element
  if (['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    // Allow canvas-related keys even for buttons only if canvas is involved
    if (document.activeElement !== canvas) return;
  }

  // Escape: cancel pick-up or clear selection
  if (e.key === 'Escape') {
    if (uiState === 'picked') {
      pickedShape = null; pickedRotation = 0;
      uiState = 'idle';
      ghostPos = null;
      updateBucketPressedState();
      render();
    } else if (uiState === 'selected') {
      selectedId = null;
      uiState = 'idle';
      updateContextPanel();
      render();
    }
    return;
  }

  // Space: cycle selection through placed pieces
  if (e.key === ' ' && document.activeElement === canvas) {
    e.preventDefault();
    if (!placements.length) return;
    if (uiState === 'picked') return;
    const idx = placements.findIndex(p => p.id === selectedId);
    const next = (idx + 1) % placements.length;
    selectedId = placements[next].id;
    uiState = 'selected';
    updateContextPanel();
    render();
    return;
  }

  // Arrow keys: move selected piece or ghost cursor
  const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (arrow) {
    e.preventDefault();
    if (uiState === 'selected' && selectedId !== null) {
      const pl = placements.find(p => p.id === selectedId);
      if (pl) {
        pl.anchor = [pl.anchor[0] + arrow[0], pl.anchor[1] + arrow[1]];
        scheduleValidation();
        render();
      }
    } else if (uiState === 'picked') {
      if (!ghostPos) ghostPos = { gx: 0, gy: 0 };
      ghostPos = { gx: ghostPos.gx + arrow[0], gy: ghostPos.gy + arrow[1] };
      render();
    }
    return;
  }

  // Enter: place ghost piece (keyboard flow)
  if (e.key === 'Enter' && uiState === 'picked' && ghostPos) {
    const [rawAx, rawAy] = anchorForCentroidAt(pickedShape, pickedRotation, ghostPos.gx, ghostPos.gy);
    const [ax, ay] = snapAnchorForPiece(rawAx, rawAy, pickedShape, pickedRotation);
    const id = addPlacement(pickedShape, [ax, ay], pickedRotation);
    selectedId = id;
    uiState = 'selected';
    pickedShape = null; pickedRotation = 0;
    ghostPos = null;
    updateBucketPressedState();
    updateContextPanel();
    scheduleValidation();
    announce('Piece placed');
    render();
    return;
  }

  // R while a bucket shape is picked: rotate the ghost.
  if ((e.key === 'r' || e.key === 'R') && uiState === 'picked' && pickedShape) {
    const delta = e.shiftKey ? -45 : 45;
    pickedRotation = ((pickedRotation + delta) % 360 + 360) % 360;
    announce(`Rotated ${delta > 0 ? '+' : ''}${delta}°`);
    render();
    return;
  }

  if (uiState !== 'selected' || selectedId === null) return;

  // R: rotate selected piece ±45°
  if (e.key === 'r' || e.key === 'R') {
    if (e.shiftKey) {
      rotatePlacement(selectedId, -45);
      announce('Rotated -45°');
    } else {
      rotatePlacement(selectedId, 45);
      announce('Rotated +45°');
    }
    // Immediate (not debounced) validate so a rotation that would leave the
    // piece out-of-frame snaps back without a visible 200 ms flash.
    if (validationTimer) { clearTimeout(validationTimer); validationTimer = null; }
    validate(false);
    render();
    return;
  }

  // D: duplicate
  if (e.key === 'd' || e.key === 'D') {
    duplicateSelected();
    return;
  }

  // Delete / Backspace
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    removePlacement(selectedId);
    selectedId = null;
    uiState = 'idle';
    updateContextPanel();
    updateStatus();
    scheduleValidation();
    render();
    return;
  }
});

function duplicateSelected() {
  if (selectedId === null) return;
  const src = placements.find(p => p.id === selectedId);
  if (!src) return;
  const id = addPlacement(src.name, [src.anchor[0] + 1, src.anchor[1]]);
  const newPl = placements.find(p => p.id === id);
  if (newPl) {
    newPl.rotation = src.rotation;
    newPl.reflected = src.reflected;
  }
  selectedId = id;
  uiState = 'selected';
  updateContextPanel();
  scheduleValidation();
  announce('Piece duplicated');
  render();
}

// Drag-from-bucket: enter picked state without toggling. Always picks (never
// un-picks); the canvas mouseup commits placement, or Escape cancels.
// Switch which shape acts as the frame/overlay. Clears placed pieces because
// existing anchors are in the prior frame's coordinate space.
function setFrame(name) {
  if (frameName === name) return;
  if (placements.length > 0) {
    const ok = window.confirm(`Switch frame to "${name}"? This clears placed pieces.`);
    if (!ok) return;
  }
  frameName = name;
  placements = [];
  selectedId = null;
  pickedShape = null; pickedRotation = 0;
  uiState = 'idle';
  ghostPos = null;
  hintShown = true;
  document.getElementById('hint')?.classList.remove('hidden');
  computeZoomToFit();
  refreshBucket();
  updateContextPanel();
  scheduleValidation();
  announce(`Frame is now ${name}`);
  render();
}

function onBucketCardPickup(name) {
  pickedShape = name;
  uiState = 'picked';
  selectedId = null;
  ghostPos = null;
  canvas.focus();
  updateBucketPressedState();
  updateContextPanel();
  render();
}

// ── Bucket click ──
function onBucketCardClick(name, card) {
  if (uiState === 'picked' && pickedShape === name) {
    // Toggle off
    pickedShape = null; pickedRotation = 0;
    uiState = 'idle';
    ghostPos = null;
  } else {
    pickedShape = name;
    uiState = 'picked';
    selectedId = null;
    ghostPos = null;
    canvas.focus();
  }
  updateBucketPressedState();
  updateContextPanel();
  render();
}

// ── Top bar controls ──
const scaleSlider = document.getElementById('scale-slider');
const scaleValue = document.getElementById('scale-value');

scaleSlider.addEventListener('input', () => {
  const newScale = parseInt(scaleSlider.value, 10);
  if (newScale === scale) return;

  if (placements.length > 0) {
    const ok = window.confirm('Changing scale will clear placed pieces. Continue?');
    if (!ok) {
      scaleSlider.value = scale;
      return;
    }
  }

  scale = newScale;
  scaleValue.textContent = scale;
  scaleSlider.setAttribute('aria-valuetext', `scale ${scale}`);
  placements = [];
  selectedId = null;
  uiState = 'idle';
  pickedShape = null; pickedRotation = 0;
  ghostPos = null;
  lastCoverage = 0;
  computeZoomToFit();
  refreshBucket();
  updateContextPanel();
  updateStatus();
  render();
});

// Clickable tick numbers under the slider — set scale directly.
document.querySelectorAll('.scale-tick').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = parseInt(btn.dataset.scale, 10);
    if (target === scale) return;
    scaleSlider.value = String(target);
    scaleSlider.dispatchEvent(new Event('input', { bubbles: true }));
  });
});

document.getElementById('btn-reset').addEventListener('click', () => {
  if (placements.length > 0) {
    const ok = window.confirm('Reset will clear all placed pieces. Continue?');
    if (!ok) return;
  }
  placements = [];
  selectedId = null;
  uiState = 'idle';
  pickedShape = null; pickedRotation = 0;
  ghostPos = null;
  lastCoverage = 0;
  pendingRollback = null;
  hintShown = true;
  document.getElementById('hint').classList.remove('hidden');
  updateBucketPressedState();
  updateContextPanel();
  updateStatus();
  render();
});

document.getElementById('btn-check').addEventListener('click', () => {
  validate(true);
});

// ── Right-rail buttons ──
document.getElementById('btn-rotate-cw').addEventListener('click', () => {
  if (selectedId === null) return;
  rotatePlacement(selectedId, 45);
  announce('Rotated +45°');
  if (validationTimer) { clearTimeout(validationTimer); validationTimer = null; }
  validate(false);
  render();
});

document.getElementById('btn-rotate-ccw').addEventListener('click', () => {
  if (selectedId === null) return;
  rotatePlacement(selectedId, -45);
  announce('Rotated -45°');
  if (validationTimer) { clearTimeout(validationTimer); validationTimer = null; }
  validate(false);
  render();
});

document.getElementById('btn-duplicate').addEventListener('click', () => {
  duplicateSelected();
});

document.getElementById('btn-delete').addEventListener('click', () => {
  if (selectedId === null) return;
  removePlacement(selectedId);
  selectedId = null;
  uiState = 'idle';
  updateContextPanel();
  updateStatus();
  scheduleValidation();
  render();
});

// ── Initial load ──
async function loadShapes() {
  try {
    const resp = await fetch('/api/shapes');
    if (!resp.ok) throw new Error('Failed to load shapes');
    const data = await resp.json();
    shapes = data.shapes ?? [];
    frameName = data.frame ?? (shapes[0]?.name ?? null);
  } catch (_) {
    // Use a mock for development when the server isn't up
    shapes = [
      {
        name: 'right-isoceles-triangle',
        vertices: [[0, 0], [2, 0], [0, 2]],
      },
    ];
    frameName = 'right-isoceles-triangle';
  }
}

async function init() {
  resizeCanvas();
  await loadShapes();
  computeZoomToFit();
  refreshBucket();
  updateStatus();
  updateContextPanel();
  render();
}

window.addEventListener('resize', () => {
  resizeCanvas();
  render();
});

init();
