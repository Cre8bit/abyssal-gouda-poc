// fixmap.js — the fix map: a small schematic window onto what the diver knows.
//
// The world outside the helmet gives no landmarks, so this is the only place the
// hunt can be *seen*: black water, the beacons planted so far, the diver moving
// live, and the shape the maths has carved out of the dark. That shape is the
// whole point — a whole sphere means "anywhere on this"; a circle, two dots or
// one dot each mean the same sentence said more sharply.
//
// Orthographic wireframe on a 2D canvas: no perspective, because this is an
// instrument and not a view. The camera turns with the diver's heading, so up on
// the map is always the way they are facing.

const AQUA = "98, 255, 208"; // knowledge — the same colour the hologram uses
const DIVER = "170, 215, 240";
const GRID = "90, 140, 165";

const ELEVATION = 0.52; // radians the camera looks down from the horizontal
const MARGIN = 13;

let canvas = null;
let ctx = null;

// Set per draw so the helpers below can stay argument-light.
let cam = null;
let origin = { x: 0, y: 0, z: 0 };
let metresToPx = 1;
let cx = 0;
let cy = 0;

export function initFixMap(el) {
  canvas = el;
  ctx = el.getContext("2d");
}

export function drawFixMap({ fix, beacons, player, yaw }) {
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  cx = w / 2;
  cy = h / 2;
  ctx.clearRect(0, 0, w, h);

  // The abyss: not quite black, so the frame reads as a window and not a hole.
  ctx.fillStyle = "rgba(0, 12, 19, 0.62)";
  ctx.fillRect(0, 0, w, h);

  cam = basis(yaw);
  const shape = shapeOf(fix);
  origin = shape ? shape.at : player;

  // Fit everything on screen at once: each item contributes its own offset from
  // the centre plus whatever radius it draws with.
  const limit = Math.min(w, h) / 2 - MARGIN;
  let reach = 1;
  for (const item of [...beacons, player, ...(shape ? [shape.at] : [])]) {
    reach = Math.max(reach, flatLen(item));
  }
  if (shape) reach = Math.max(reach, flatLen(shape.at) + shape.r);
  metresToPx = limit / reach;

  const step = gridStep(reach);
  grid(reach, step);
  for (const b of beacons) beacon(b);
  if (shape) drawShape(fix);
  diver(player);
  frame(w, h, step, fix);
}

// --- what the solver handed us, as one drawable thing ---------------------
function shapeOf(fix) {
  if (!fix || !fix.stage) return null;
  if (fix.stage === 1) return { at: fix.center, r: fix.radius };
  if (fix.stage === 2) return { at: fix.ring.center, r: fix.ring.radius };
  if (fix.points) {
    const [a, b] = fix.points;
    return { at: mid(a, b), r: dist(a, b) / 2 };
  }
  if (fix.point) return { at: fix.point, r: Math.max(fix.uncertainty ?? 0, 6) };
  return null;
}

function drawShape(fix) {
  if (fix.stage === 1) {
    // A whole sphere of maybe. The silhouette says how big, the three hoops
    // through it say it is a surface and not a disc.
    stem(fix.center);
    sphere(fix.center, fix.radius);
  } else if (fix.stage === 2) {
    stem(fix.ring.center);
    hoop(fix.ring.center, fix.ring.normal, fix.ring.radius, 0.75, 1.4);
  } else if (fix.points) {
    // Two candidates and no way yet to tell which. Draw them as equals — the
    // moment one is drawn bolder the diver will believe it. The dropped lines
    // are what show that the pair differ in depth and nothing else.
    dashed(fix.points[0], fix.points[1]);
    for (const p of fix.points) stem(p);
    for (const p of fix.points) candidate(p, false);
  } else if (fix.point) {
    stem(fix.point);
    candidate(fix.point, true);
  }
}

// --- primitives -----------------------------------------------------------

// Orthonormal screen axes for a camera orbiting at `az`, looking down.
function basis(az) {
  const ca = Math.cos(az), sa = Math.sin(az);
  const ce = Math.cos(ELEVATION), se = Math.sin(ELEVATION);
  return {
    right: { x: ca, y: 0, z: -sa },
    up: { x: -se * sa, y: ce, z: -se * ca },
  };
}

function flatLen(p) {
  const d = { x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z };
  return Math.hypot(dot(d, cam.right), dot(d, cam.up));
}

function screen(p) {
  const d = { x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z };
  return {
    x: cx + dot(d, cam.right) * metresToPx,
    y: cy - dot(d, cam.up) * metresToPx,
  };
}

// A circle in 3D, given its centre and two perpendicular radius vectors.
function circle3(c, a, b, alpha, width = 1) {
  ctx.beginPath();
  for (let i = 0; i <= 48; i++) {
    const t = (i / 48) * Math.PI * 2;
    const s = screen({
      x: c.x + a.x * Math.cos(t) + b.x * Math.sin(t),
      y: c.y + a.y * Math.cos(t) + b.y * Math.sin(t),
      z: c.z + a.z * Math.cos(t) + b.z * Math.sin(t),
    });
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  }
  ctx.strokeStyle = `rgba(${AQUA}, ${alpha})`;
  ctx.lineWidth = width;
  ctx.stroke();
}

function sphere(c, r) {
  // Under an orthographic camera a sphere's outline is exactly a circle.
  const s = screen(c);
  ctx.beginPath();
  ctx.arc(s.x, s.y, r * metresToPx, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${AQUA}, 0.5)`;
  ctx.lineWidth = 1.1;
  ctx.stroke();
  ctx.fillStyle = `rgba(${AQUA}, 0.05)`;
  ctx.fill();
  const X = { x: r, y: 0, z: 0 }, Y = { x: 0, y: r, z: 0 }, Z = { x: 0, y: 0, z: r };
  circle3(c, X, Z, 0.28);
  circle3(c, X, Y, 0.16);
  circle3(c, Z, Y, 0.16);
}

function hoop(c, n, r, alpha, width) {
  const [a, b] = perpBasis(n, r);
  circle3(c, a, b, alpha, width);
  // The hoop is as thick as the bell is wide; show that rather than imply a wire.
  circle3(c, scale(a, 1.06), scale(b, 1.06), 0.14);
  circle3(c, scale(a, 0.94), scale(b, 0.94), 0.14);
}

function candidate(p, locked) {
  const s = screen(p);
  const r = locked ? 4.5 : 3.4;
  const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 3);
  g.addColorStop(0, `rgba(${AQUA}, ${locked ? 0.95 : 0.55})`);
  g.addColorStop(1, `rgba(${AQUA}, 0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r * 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${AQUA}, ${locked ? 1 : 0.6})`;
  ctx.fill();
  if (!locked) return;
  ctx.strokeStyle = `rgba(${AQUA}, 0.8)`;
  ctx.lineWidth = 1;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.beginPath();
    ctx.moveTo(s.x + dx * 7, s.y + dy * 7);
    ctx.lineTo(s.x + dx * 11, s.y + dy * 11);
    ctx.stroke();
  }
}

function beacon(b) {
  const s = screen(b);
  stem(b);
  ctx.beginPath();
  ctx.arc(s.x, s.y, 2, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${AQUA}, 0.85)`;
  ctx.fill();
}

// The diver. The camera turns with them, so their nose always points up.
function diver(p) {
  const s = screen(p);
  stem(p);
  ctx.beginPath();
  ctx.moveTo(s.x, s.y - 4.5);
  ctx.lineTo(s.x - 3.2, s.y + 3.4);
  ctx.lineTo(s.x + 3.2, s.y + 3.4);
  ctx.closePath();
  ctx.fillStyle = `rgba(${DIVER}, 0.95)`;
  ctx.fill();
}

// A dropped line to the reference plane — without it nothing on a flat picture
// reads as being above or below anything else.
function stem(p) {
  const a = screen(p);
  const b = screen({ x: p.x, y: origin.y, z: p.z });
  if (Math.abs(a.y - b.y) < 1.5) return;
  ctx.setLineDash([1.5, 2.5]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = `rgba(${GRID}, 0.45)`;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(b.x, b.y, 1, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${GRID}, 0.5)`;
  ctx.fill();
}

function dashed(a, b) {
  const s1 = screen(a);
  const s2 = screen(b);
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(s1.x, s1.y);
  ctx.lineTo(s2.x, s2.y);
  ctx.strokeStyle = `rgba(${AQUA}, 0.3)`;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
}

// The horizontal plane through the centre of interest, so heights have a floor
// to be measured against.
function grid(reach, step) {
  const n = Math.ceil(reach / step);
  const span = n * step;
  ctx.lineWidth = 1;
  for (let i = -n; i <= n; i++) {
    const t = i * step;
    for (const seg of [
      [{ x: origin.x + t, z: origin.z - span }, { x: origin.x + t, z: origin.z + span }],
      [{ x: origin.x - span, z: origin.z + t }, { x: origin.x + span, z: origin.z + t }],
    ]) {
      const a = screen({ x: seg[0].x, y: origin.y, z: seg[0].z });
      const b = screen({ x: seg[1].x, y: origin.y, z: seg[1].z });
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(${GRID}, ${i === 0 ? 0.17 : 0.08})`;
      ctx.stroke();
    }
  }
}

function gridStep(reach) {
  for (const s of [10, 25, 50, 100, 250, 500]) if (reach / s <= 3.5) return s;
  return 1000;
}

function frame(w, h, step, fix) {
  ctx.strokeStyle = `rgba(${AQUA}, 0.2)`;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  ctx.font = "8px monospace";
  ctx.fillStyle = `rgba(${GRID}, 0.75)`;
  ctx.fillText(`◻ ${step} m`, 5, h - 5);
  if (fix?.stage === 3 && fix.flat) {
    ctx.fillStyle = "rgba(255, 224, 138, 0.9)";
    ctx.fillText("↕ CHANGE DEPTH", 5, 11);
  }
}

// --- tiny vec3 ------------------------------------------------------------
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function scale(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

// Two perpendicular vectors of length `r` spanning the plane normal to `n`.
function perpBasis(n, r) {
  const up = Math.abs(n.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  let a = {
    x: up.y * n.z - up.z * n.y,
    y: up.z * n.x - up.x * n.z,
    z: up.x * n.y - up.y * n.x,
  };
  const la = Math.hypot(a.x, a.y, a.z) || 1;
  a = scale(a, r / la);
  const b = {
    x: n.y * a.z - n.z * a.y,
    y: n.z * a.x - n.x * a.z,
    z: n.x * a.y - n.y * a.x,
  };
  const lb = Math.hypot(b.x, b.y, b.z) || 1;
  return [a, scale(b, r / lb)];
}
