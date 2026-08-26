// triangulation.js — "The Chorus": range-only trilateration of the bell.
//
// Your antenna hears the bell but cannot point at it — every reading is a
// distance, nothing more. A distance alone is a *sphere*: the bell is
// somewhere on its surface. The whole task is turning a fistful of anchored
// spheres into a single point, and the geometry gives you exactly four rungs:
//
//   1 reading  → SHELL   a whole sphere of maybe
//   2 readings → RING    the spheres kiss in a circle
//   3 readings → TWINS   two candidate points, one of them a ghost
//   4 readings → LOCK    the ambiguity collapses; the bell has an address
//
// This module is pure state + maths — no rendering, no network. It stores the
// anchored readings, fuses them every frame, and reports which rung the crew
// has climbed to and how much to trust it. Everything reads back through
// `solve()`; the rest of the game only ever draws what it returns.

// The antenna is honest but not precise, and it gets worse the further the
// bell is and the deeper the water — a far reading is a fat shell, not a line.
const NOISE_BASE = 1.4; // metres of slop at point-blank range
const NOISE_REL = 0.05; // + this fraction of the true distance
const NOISE_PER_LEVEL = 0.12; // the deep water muddies every reading

// You cannot stack readings on one spot and call it triangulation — two
// spheres from the same place tell you nothing new. A fresh reading has to be
// taken at least this far from your own last one, which is the whole reason a
// lone diver has to *swim the baseline* and a crew wants to fan out.
export const MIN_BASELINE = 14;
export const READING_COOLDOWN = 2.2; // seconds between your own readings
const MAX_READINGS = 8; // oldest falls off the back

// Geometry quality saturates once your anchors span this much water. Below it,
// the fix is real but soft; a cluster of readings can reach LOCK and still be
// a blurred guess — data is necessary, good geometry is what makes it sharp.
const GOOD_BASELINE = 90;

export const STAGE = {
  NONE: 0,
  SHELL: 1,
  RING: 2,
  TWINS: 3,
  LOCK: 4,
};

export const STAGE_NAME = {
  0: "NO SIGNAL",
  1: "SHELL",
  2: "RING",
  3: "TWINS",
  4: "LOCK",
};

// One reading = where you stood + how far the antenna said the bell was.
// `id` is the diver who took it (so peers can dedupe on relay); `seq` orders
// them for eviction without needing a shared clock.
const readings = [];
let seq = 0;

export function clearReadings() {
  readings.length = 0;
}

export function readingCount() {
  return readings.length;
}

export function getReadings() {
  return readings;
}

// The measured range for a reading, with the antenna's honest imprecision baked
// in once, at sample time. The sampler keeps this number and shares it, so every
// window fuses the identical shell — the error is real but not desynced.
export function measureRange(diver, bell, level = 0) {
  const trueDist = Math.hypot(diver.x - bell.x, diver.y - bell.y, diver.z - bell.z);
  const sigma = NOISE_BASE + NOISE_REL * trueDist + NOISE_PER_LEVEL * level;
  // Sum of two uniforms ≈ a soft bell curve, cheap and bounded.
  const g = (Math.random() + Math.random() - 1) * sigma;
  return Math.max(0.5, trueDist + g);
}

// Add an already-measured reading (yours or a peer's). Rejects one taken too
// close to the same diver's previous anchor — that's the "move to matter" rule.
// Returns true if it was accepted.
export function addReading({ id, x, y, z, r, seq: s }) {
  // Dedupe: a host relays every reading back to its author too, so the same
  // (diver, seq) can arrive twice. Key on both — seq counters are per-diver.
  if (s != null && readings.some((rd) => rd.id === id && rd.seq === s)) {
    return false;
  }
  const mine = readings.filter((rd) => rd.id === id);
  const last = mine[mine.length - 1];
  if (last && Math.hypot(x - last.x, y - last.y, z - last.z) < MIN_BASELINE) {
    return false;
  }
  readings.push({ id, x, y, z, r, seq: s ?? seq++ });
  while (readings.length > MAX_READINGS) readings.shift();
  return true;
}

// True if this diver could take a *useful* reading from here right now — used
// to colour the prompt before they waste the cooldown on a dead spot.
export function baselineOK(id, pos) {
  const mine = readings.filter((rd) => rd.id === id);
  const last = mine[mine.length - 1];
  if (!last) return true;
  return Math.hypot(pos.x - last.x, pos.y - last.y, pos.z - last.z) >= MIN_BASELINE;
}

export function nextSeq() {
  return seq++;
}

// --- The fuse -------------------------------------------------------------
//
// Everything below turns the reading list into a geometric answer. The shape
// of the answer IS the granularity of the crew's knowledge; the renderer just
// gives it a body.

export function solve() {
  const n = readings.length;
  const quality = geometryQuality();
  if (n === 0) return { stage: STAGE.NONE, quality, count: 0, spread: 0 };
  if (n === 1) {
    const a = readings[0];
    return {
      stage: STAGE.SHELL,
      center: { x: a.x, y: a.y, z: a.z },
      radius: a.r,
      quality,
      count: 1,
      spread: spread(),
    };
  }
  if (n === 2) {
    return { ...twoSphereCircle(readings[0], readings[1]), quality, count: 2, spread: spread() };
  }
  if (n === 3) {
    return { ...threeSphereTwins(readings[0], readings[1], readings[2]), quality, count: 3, spread: spread() };
  }
  return { ...leastSquaresPoint(readings), quality, count: n, spread: spread() };
}

// Two spheres meet in a circle lying on the radical plane between them. If they
// are too far apart or nested (no real intersection) we still hand back a soft
// ring at the midpoint so the crew sees "you're bracketing it, keep reading".
function twoSphereCircle(a, b) {
  const d = sub(b, a);
  const D = len(d);
  if (D < 1e-4) {
    return { stage: STAGE.RING, ring: { center: { ...a }, normal: { x: 0, y: 1, z: 0 }, radius: a.r }, degenerate: true };
  }
  const u = scale(d, 1 / D);
  const t = (D * D + a.r * a.r - b.r * b.r) / (2 * D);
  const center = add(a, scale(u, t));
  const h2 = a.r * a.r - t * t;
  const degenerate = h2 <= 0;
  const radius = Math.sqrt(Math.max(h2, 0.25));
  return { stage: STAGE.RING, ring: { center, normal: u, radius }, degenerate };
}

// Three spheres: two radical planes intersect in a line, and that line pierces
// the first sphere in (usually) two points — the twins. One is the bell; the
// other is its mirror, a plausible ghost the crew has to rule out. If the line
// misses (bad geometry), fall back to the best-fit point but flag it fuzzy.
function threeSphereTwins(a, b, c) {
  const A1 = scale(sub(b, a), 2);
  const A2 = scale(sub(c, a), 2);
  const b1 = mag2(b) - mag2(a) - (b.r * b.r - a.r * a.r);
  const b2 = mag2(c) - mag2(a) - (c.r * c.r - a.r * a.r);
  const nrm = cross(A1, A2);
  const denom = dot(nrm, nrm);
  if (denom < 1e-6) {
    // Anchors nearly collinear — no clean line. Best-fit and mark it soft.
    return { ...leastSquaresPoint([a, b, c]), stage: STAGE.TWINS, fuzzy: true, points: null };
  }
  // Point on the plane-intersection line that is closest to the origin.
  const x0 = scale(
    add(
      scale(A1, b1 * dot(A2, A2) - b2 * dot(A1, A2)),
      scale(A2, b2 * dot(A1, A1) - b1 * dot(A1, A2)),
    ),
    1 / denom,
  );
  // Intersect that line with the first sphere.
  const e = sub(x0, a);
  const en = dot(e, nrm);
  const disc = en * en - denom * (dot(e, e) - a.r * a.r);
  if (disc <= 0) {
    return { stage: STAGE.TWINS, point: x0, fuzzy: true, points: null };
  }
  const root = Math.sqrt(disc);
  const t1 = (-en + root) / denom;
  const t2 = (-en - root) / denom;
  const p1 = add(x0, scale(nrm, t1));
  const p2 = add(x0, scale(nrm, t2));
  return { stage: STAGE.TWINS, points: [p1, p2] };
}

// Four or more spheres over-determine the point; solve it in the least-squares
// sense. Each extra reading past the fourth just pins it down harder — this is
// the rung where more data = more certainty, not a new shape.
function leastSquaresPoint(rs) {
  const a = rs[0];
  // Normal equations (AᵀA)x = Aᵀb from the radical-plane rows.
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const rhs = [0, 0, 0];
  for (let i = 1; i < rs.length; i++) {
    const p = rs[i];
    const row = [2 * (p.x - a.x), 2 * (p.y - a.y), 2 * (p.z - a.z)];
    const rv = mag2(p) - mag2(a) - (p.r * p.r - a.r * a.r);
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) M[j * 3 + k] += row[j] * row[k];
      rhs[j] += row[j] * rv;
    }
  }
  const x = solve3x3(M, rhs);
  const point = x ? { x: x[0], y: x[1], z: x[2] } : { x: a.x, y: a.y, z: a.z };
  // Residual: how well the point honours every measured range. Small = crisp.
  let res = 0;
  for (const p of rs) {
    const d = Math.hypot(point.x - p.x, point.y - p.y, point.z - p.z);
    res += Math.abs(d - p.r);
  }
  return { stage: STAGE.LOCK, point, residual: res / rs.length };
}

// The largest gap between any two anchors — the crew's baseline. Big baseline,
// sharp fix; everyone huddled together, mush.
function spread() {
  let max = 0;
  for (let i = 0; i < readings.length; i++) {
    for (let j = i + 1; j < readings.length; j++) {
      const d = Math.hypot(
        readings[i].x - readings[j].x,
        readings[i].y - readings[j].y,
        readings[i].z - readings[j].z,
      );
      if (d > max) max = d;
    }
  }
  return max;
}

// 0..1 confidence in the *shape* of the readings (not the count). Blends the
// baseline with how three-dimensional the cloud is, so four readings strung
// out in a line still read as slightly soft.
function geometryQuality() {
  if (readings.length < 2) return 0;
  const base = Math.min(spread() / GOOD_BASELINE, 1);
  return clamp(base * dimensionality(), 0, 1);
}

// Cheap proxy for "do the anchors span volume or just a line": ratio of the
// spread perpendicular to the dominant axis vs. along it.
function dimensionality() {
  if (readings.length < 3) return 0.6;
  const c = centroid();
  let along = 0;
  // Dominant axis ≈ direction from centroid to the farthest anchor.
  let far = readings[0];
  let fd = -1;
  for (const r of readings) {
    const d = Math.hypot(r.x - c.x, r.y - c.y, r.z - c.z);
    if (d > fd) { fd = d; far = r; }
  }
  const axis = fd > 1e-4 ? scale({ x: far.x - c.x, y: far.y - c.y, z: far.z - c.z }, 1 / fd) : { x: 1, y: 0, z: 0 };
  let perp = 0;
  for (const r of readings) {
    const v = { x: r.x - c.x, y: r.y - c.y, z: r.z - c.z };
    const proj = dot(v, axis);
    along = Math.max(along, Math.abs(proj));
    const px = v.x - axis.x * proj;
    const py = v.y - axis.y * proj;
    const pz = v.z - axis.z * proj;
    perp = Math.max(perp, Math.hypot(px, py, pz));
  }
  if (along < 1e-4) return 0.6;
  return clamp(0.35 + (perp / along) * 0.9, 0, 1);
}

function centroid() {
  const c = { x: 0, y: 0, z: 0 };
  for (const r of readings) { c.x += r.x; c.y += r.y; c.z += r.z; }
  const n = readings.length || 1;
  return { x: c.x / n, y: c.y / n, z: c.z / n };
}

// --- tiny vec3 + linear algebra ------------------------------------------
function add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function scale(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function len(a) { return Math.hypot(a.x, a.y, a.z); }
function mag2(a) { return a.x * a.x + a.y * a.y + a.z * a.z; }
function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

// Solve a 3x3 system by Cramer's rule; null if (near-)singular.
function solve3x3(M, b) {
  const det =
    M[0] * (M[4] * M[8] - M[5] * M[7]) -
    M[1] * (M[3] * M[8] - M[5] * M[6]) +
    M[2] * (M[3] * M[7] - M[4] * M[6]);
  if (Math.abs(det) < 1e-6) return null;
  const dx =
    b[0] * (M[4] * M[8] - M[5] * M[7]) -
    M[1] * (b[1] * M[8] - M[5] * b[2]) +
    M[2] * (b[1] * M[7] - M[4] * b[2]);
  const dy =
    M[0] * (b[1] * M[8] - M[5] * b[2]) -
    b[0] * (M[3] * M[8] - M[5] * M[6]) +
    M[2] * (M[3] * b[2] - b[1] * M[6]);
  const dz =
    M[0] * (M[4] * b[2] - b[1] * M[7]) -
    M[1] * (M[3] * b[2] - b[1] * M[6]) +
    b[0] * (M[3] * M[7] - M[4] * M[6]);
  return [dx / det, dy / det, dz / det];
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
