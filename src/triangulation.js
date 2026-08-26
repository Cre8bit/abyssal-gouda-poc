// triangulation.js — "The Chorus": locating the bell with planted beacons.
//
// The antenna cannot point at the bell and it will not tell you how far away it
// is. The one thing it does is chime the instant the bell is on your 100 m
// shell — a yes, never a number. Plant a beacon on that chime and you have
// pinned one hard fact: the bell is 100 m from this spot. One fact leaves the
// bell anywhere on a sphere; more facts, planted far enough apart, carve that
// sphere down:
//
//   1 beacon  → SHELL   the whole sphere around it
//   2 beacons → RING    two shells meet in a circle
//   3 beacons → TWINS   that circle pierces the third shell twice
//   4 beacons → LOCK    the fourth kills the ghost; one point is left
//
// The chime has a 10 m tolerance because the bell is a body, not a dot — that
// slop is there so a diver can find the shell without hunting for a pixel. It
// deliberately does NOT leak into the maths: the beacon records the range it
// measured at the moment it was planted, so the shapes below are exact. Feed
// the solver a nominal 100 instead and a 10 m misjudgement at the shell becomes
// a 100 m error at the fix — which is exactly how it used to go wrong.
//
// Pure state + maths — no rendering, no network. The beacons are YOURS alone;
// two divers each run their own chorus (sharing them is a later update).

// The antenna's one and only range: the bell must be this far off before a
// beacon will take.
export const BEACON_RANGE = 100;

// Half-thickness of the band that counts as "on the shell" — the bell's own
// body. Placement forgiveness only; never used as a radius.
export const BELL_RADIUS = 10;

// Two beacons on the same spot say the same thing twice. A new one has to stand
// this far from EVERY beacon already planted — the rule that forces a lone
// diver to swim the shell instead of standing still.
export const MIN_SEPARATION = 50;

// Four is the geometric answer. The spares exist for the flat layout below,
// where four beacons genuinely cannot tell the bell from its mirror image.
export const MAX_BEACONS = 6;

export const STAGE = {
  NONE: 0,
  SHELL: 1,
  RING: 2,
  TWINS: 3,
  LOCK: 4,
};

export const STAGE_NAME = {
  0: "NO FIX",
  1: "SHELL",
  2: "RING",
  3: "TWINS",
  4: "LOCK",
};

// { x, y, z, r } — where it stands and the range it heard.
const beacons = [];

export function clearBeacons() {
  beacons.length = 0;
}

export function getBeacons() {
  return beacons;
}

export function beaconCount() {
  return beacons.length;
}

// --- The gates -------------------------------------------------------------
//
// Two conditions, both testable every frame so the HUD can show a diver which
// one is holding them up before they press anything.

// Is the bell on my shell right now? The only question the antenna can answer.
export function onShell(distToBell) {
  return Math.abs(distToBell - BEACON_RANGE) <= BELL_RADIUS;
}

// Signed miss: negative means too close to the bell, positive means too far.
export function shellOffset(distToBell) {
  return distToBell - BEACON_RANGE;
}

export function distToNearest(pos) {
  let min = Infinity;
  for (const b of beacons) {
    min = Math.min(min, Math.hypot(pos.x - b.x, pos.y - b.y, pos.z - b.z));
  }
  return min;
}

export function separationOK(pos) {
  return distToNearest(pos) >= MIN_SEPARATION;
}

export function placeBeacon(pos, range) {
  if (beacons.length >= MAX_BEACONS) return false;
  beacons.push({ x: pos.x, y: pos.y, z: pos.z, r: range });
  return true;
}

// --- The fuse -------------------------------------------------------------
//
// Turns the beacon list into a geometric answer. The SHAPE of the answer is the
// granularity of what the diver knows; every consumer just draws what it gets.
// `uncertainty` is that shape's radius of doubt in metres, so one number
// compares a fat ring against a tight lock.

export function solve() {
  const n = beacons.length;
  if (n === 0) return { stage: STAGE.NONE, count: 0, uncertainty: 0, quality: 0 };
  if (n === 1) {
    const a = beacons[0];
    return finish({
      stage: STAGE.SHELL,
      center: { x: a.x, y: a.y, z: a.z },
      radius: a.r,
      uncertainty: a.r,
    });
  }
  if (n === 2) return finish(twoShellRing(beacons[0], beacons[1]));

  // Three or more: work off the triple spanning the most area, not simply the
  // first three planted. A near-collinear base is what makes the maths blow up.
  const base = widestTriple(beacons);
  if (!base) {
    return finish({ ...twoShellRing(...widestPair(beacons)), stage: STAGE.RING, collinear: true });
  }

  const twins = threeShellTwins(...base);
  if (!twins.points) return finish(twins);

  const [p1, p2] = twins.points;
  // The two candidates can sit close enough together that the choice stops
  // mattering — the bell's own body covers both. That is a fix, not a doubt,
  // and it is how three beacons alone can be enough.
  if (len(sub(p1, p2)) <= BELL_RADIUS) {
    return finish({
      stage: STAGE.LOCK,
      point: scale(add(p1, p2), 0.5),
      merged: true,
      residual: worstDisagreement(p1),
      uncertainty: Math.max(len(sub(p1, p2)) / 2, 0.5),
    });
  }
  if (n === 3) return finish(twins);

  // Four or more: the bell agrees with every range the antenna heard, so the
  // candidate whose WORST beacon still agrees is the bell and the other is the
  // ghost. Judge on the worst beacon, not the average: it only takes one beacon
  // off the plane of the others to tell the twins apart, and averaging washes
  // that one voice out among the rest.
  const e1 = worstDisagreement(p1);
  const e2 = worstDisagreement(p2);
  // Tied means every beacon sits in one plane and the ghost is their perfect
  // mirror — no arithmetic can separate them, so hold at TWINS rather than
  // point the diver confidently at empty water.
  if (Math.abs(e1 - e2) < 1) return finish({ ...twins, flat: true });
  return finish({
    stage: STAGE.LOCK,
    point: e1 <= e2 ? p1 : p2,
    residual: Math.min(e1, e2),
    uncertainty: Math.max(Math.min(e1, e2), 0.5),
  });
}

// Two shells meet in a circle on the plane between them.
function twoShellRing(a, b) {
  const d = sub(b, a);
  const D = len(d);
  if (D < 1e-4) {
    return { stage: STAGE.RING, ring: { center: { ...a }, normal: { x: 0, y: 1, z: 0 }, radius: a.r }, degenerate: true, uncertainty: a.r };
  }
  const u = scale(d, 1 / D);
  const t = (D * D + a.r * a.r - b.r * b.r) / (2 * D);
  const center = add(a, scale(u, t));
  const h2 = a.r * a.r - t * t;
  const radius = Math.sqrt(Math.max(h2, 0.25));
  return {
    stage: STAGE.RING,
    ring: { center, normal: u, radius },
    degenerate: h2 <= 0,
    uncertainty: radius,
  };
}

// Three shells: each pair agrees on a plane, the planes cross in a line, and
// that line pierces the shells twice. One hole is the bell, the other its mirror
// through the plane of the three beacons — a ghost that fits every fact so far.
//
// Solved with `a` as the origin. In world coordinates the same algebra squares
// numbers in the thousands and the answer drowns in the rounding, which used to
// show up as a valid three-beacon fix reporting itself as unsolvable.
function threeShellTwins(a, b, c) {
  const u = sub(b, a);
  const v = sub(c, a);
  const n = cross(u, v);
  const nn = dot(n, n);
  if (nn < 1e-6) {
    return { ...twoShellRing(a, b), stage: STAGE.TWINS, collinear: true, points: null };
  }
  // Each pair of shells pins one dot product; together they pin the whole
  // component of the answer perpendicular to the line.
  const k1 = (mag2(u) + a.r * a.r - b.r * b.r) / 2;
  const k2 = (mag2(v) + a.r * a.r - c.r * c.r) / 2;
  const p0 = scale(add(scale(cross(v, n), k1), scale(cross(n, u), k2)), 1 / nn);
  // p0 is perpendicular to the line, so the walk along it is a clean Pythagoras.
  // Zero walk means the bell lies in the plane of the three beacons: the two
  // holes merge into one and three beacons were already enough.
  const t = Math.sqrt(Math.max(a.r * a.r - mag2(p0), 0) / nn);
  const p1 = add(a, add(p0, scale(n, t)));
  const p2 = add(a, add(p0, scale(n, -t)));
  return {
    stage: STAGE.TWINS,
    points: [p1, p2],
    // Guess wrong and you are the full gap out; half of it is the honest doubt.
    uncertainty: len(sub(p1, p2)) / 2,
  };
}

// The loudest objection any beacon raises to a candidate: how far its own
// measured range is from where the candidate says it should be.
function worstDisagreement(p) {
  let worst = 0;
  for (const b of beacons) {
    worst = Math.max(worst, Math.abs(Math.hypot(p.x - b.x, p.y - b.y, p.z - b.z) - b.r));
  }
  return worst;
}

// The triple spanning the most area — the best-conditioned base for the twins.
// Null when every triple is a line, where a third beacon buys nothing.
function widestTriple(list) {
  let best = null;
  let bestArea = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      for (let k = j + 1; k < list.length; k++) {
        const area = len(cross(sub(list[j], list[i]), sub(list[k], list[i])));
        if (area > bestArea) {
          bestArea = area;
          best = [list[i], list[j], list[k]];
        }
      }
    }
  }
  return bestArea > 1 ? best : null;
}

function widestPair(list) {
  let best = [list[0], list[1]];
  let bestD = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const d = len(sub(list[j], list[i]));
      if (d > bestD) {
        bestD = d;
        best = [list[i], list[j]];
      }
    }
  }
  return best;
}

// Every solve() exit routes through here, so count, spread and the 0..1 bar are
// derived once from the shape's own radius of doubt.
function finish(sol) {
  const unc = Math.max(sol.uncertainty ?? BEACON_RANGE, 0);
  return {
    ...sol,
    count: beacons.length,
    spread: spread(),
    uncertainty: unc,
    quality: clamp(1 - unc / BEACON_RANGE, 0, 1),
  };
}

// The widest gap between any two beacons — the diver's baseline.
function spread() {
  let max = 0;
  for (let i = 0; i < beacons.length; i++) {
    for (let j = i + 1; j < beacons.length; j++) {
      max = Math.max(max, len(sub(beacons[i], beacons[j])));
    }
  }
  return max;
}

// --- tiny vec3 ------------------------------------------------------------
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

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
