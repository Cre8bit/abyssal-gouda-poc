// kelp.js — a kelp field, not a clump: several overlapping lobes with wavy
// outlines, thinning toward the edges and growing taller and heavier toward
// the interior. Strands run far past the top and bottom of any view.
import { LEVEL_DROP } from "./bell.js";

export const FOREST_RADIUS = 70;
const STRANDS = 3400;
const SEGMENTS = 22;
const LOBES = 3;

// Six archetypes. `width` is a HALF-width in metres — real kelp is 10-30 cm
// across, and anything near a metre reads as a wall.
const KINDS = [
  // Broad frilly blade — the silhouette that says "kelp" at a glance.
  { width: 0.18, height: 96, wander: 9, frillFreq: 3.2, frillAmp: 0.4, twist: 5.5, tint: 0x24210f },
  // Thin whip, the tallest thing out here.
  { width: 0.07, height: 118, wander: 14, frillFreq: 1.1, frillAmp: 0.12, twist: 2.4, tint: 0x1a1c0e },
  // Narrow strap on a long stipe.
  { width: 0.11, height: 104, wander: 12, frillFreq: 1.6, frillAmp: 0.22, twist: 3.0, tint: 0x1d1f10 },
  // Bulbous stalk: one heavy swelling partway up.
  { width: 0.22, height: 82, wander: 7, frillFreq: 0.85, frillAmp: 0.85, twist: 1.6, tint: 0x2b2612 },
  // Feathery frond, finely serrated along its whole length.
  { width: 0.14, height: 88, wander: 8, frillFreq: 12.0, frillAmp: 0.5, twist: 4.2, tint: 0x222812 },
  // Heavy dark corkscrew ribbon, shorter and wider.
  { width: 0.3, height: 70, wander: 6, frillFreq: 2.1, frillAmp: 0.3, twist: 9.0, tint: 0x16140a },
];

function rng(seed) {
  let s = (seed | 0) || 1;
  return () => {
    s = Math.imul(s ^ (s >>> 15), 2246822519);
    s = Math.imul(s ^ (s >>> 13), 3266489917);
    return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
  };
}

// One field per level, always in the same place for a given level.
export function forestFor(level) {
  const r = rng(level * 7919 + 13);
  const bearing = r() * Math.PI * 2;
  const dist = 55 + r() * 45;
  return {
    x: Math.cos(bearing) * dist,
    y: -level * LEVEL_DROP,
    z: Math.sin(bearing) * dist,
    seed: level * 7919 + 13,
  };
}

// A main lobe plus smaller offset ones, each with a wavy rim.
function makeLobes(rand) {
  const lobes = [];
  for (let i = 0; i < LOBES; i++) {
    const a = rand() * Math.PI * 2;
    const away = i === 0 ? 0 : FOREST_RADIUS * (0.3 + rand() * 0.45);
    lobes.push({
      x: Math.cos(a) * away,
      z: Math.sin(a) * away,
      r: FOREST_RADIUS * (i === 0 ? 1 : 0.4 + rand() * 0.3),
      w1: rand() * 6.283,
      w2: rand() * 6.283,
      w3: rand() * 6.283,
    });
  }
  return lobes;
}

// 0 outside the field, 1 deep in its heart. Drives both how likely a strand is
// to grow here and how big it gets.
function density(lobes, x, z) {
  let best = 0;
  for (const l of lobes) {
    const dx = x - l.x;
    const dz = z - l.z;
    const r = Math.hypot(dx, dz);
    const a = Math.atan2(dz, dx);
    const edge =
      l.r *
      (0.72 +
        0.17 * Math.sin(a * 3 + l.w1) +
        0.1 * Math.sin(a * 5 - l.w2) +
        0.06 * Math.sin(a * 8 + l.w3));
    if (r >= edge) continue;
    best = Math.max(best, 1 - r / edge);
  }
  return best;
}

export function buildForest(seed, colorOf) {
  const rand = rng(seed);
  const lobes = makeLobes(rand);
  const position = [];
  const normal = [];
  const color = [];
  const sway = [];
  const phase = [];
  const index = [];
  let base = 0;
  let placed = 0;
  let guard = 0;

  while (placed < STRANDS && guard < STRANDS * 40) {
    guard++;
    const a = rand() * Math.PI * 2;
    const spread = FOREST_RADIUS * 1.6 * Math.sqrt(rand());
    const bx = Math.cos(a) * spread;
    const bz = Math.sin(a) * spread;

    const d = density(lobes, bx, bz);
    if (d <= 0) continue;
    // Rejection sampling on the density: sparse at the rim, thick inside.
    if (rand() > Math.pow(d, 0.8)) continue;
    placed++;

    const kind = KINDS[Math.floor(rand() * KINDS.length)];
    const grow = 0.45 + 1.1 * d; // taller and heavier toward the interior
    const height = kind.height * grow * (0.8 + rand() * 0.45);
    const drop = (rand() - 0.5) * 30;
    const wander = kind.wander * (0.5 + rand());
    const ph = rand() * Math.PI * 2;
    const girth = kind.width * grow * (0.7 + rand() * 0.6);
    const twist0 = rand() * Math.PI;

    const shade = 0.45 + rand() * 0.55;
    const tint = colorOf(kind.tint);
    const cr = tint.r * shade;
    const cg = tint.g * shade;
    const cb = tint.b * shade;

    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;
      // Tapered at both ends so a strand dissolves rather than stopping dead.
      const taper = Math.sin(Math.PI * t) ** 0.55;
      const frill = 1 + kind.frillAmp * Math.sin(t * kind.frillFreq * Math.PI * 2 + ph);
      const half = girth * taper * frill;

      const lean = t - 0.5;
      const y = drop + lean * height;
      // Two scales of bend: a slow lean over the whole strand, plus a ~20 m
      // ripple so a blade visibly curves inside a single view.
      const cx = bx + Math.sin(lean * 2.4 + ph) * wander + Math.sin(y * 0.3 + ph) * 1.5;
      const cz =
        bz +
        Math.cos(lean * 1.9 + ph) * wander * 0.75 +
        Math.cos(y * 0.26 + ph * 1.7) * 1.3;

      const tw = twist0 + t * kind.twist + Math.sin(t * 13 + ph) * 0.85;
      const ox = Math.cos(tw) * half;
      const oz = Math.sin(tw) * half;
      const nx = -Math.sin(tw);
      const nz = Math.cos(tw);
      const fade = 0.3 + 0.7 * taper;

      position.push(cx - ox, y, cz - oz, cx + ox, y, cz + oz);
      normal.push(nx, 0, nz, nx, 0, nz);
      color.push(cr * fade, cg * fade, cb * fade, cr * fade, cg * fade, cb * fade);
      sway.push(t, t);
      phase.push(ph, ph);

      if (i < SEGMENTS) {
        const b = base + i * 2;
        index.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    base += (SEGMENTS + 1) * 2;
  }

  return { position, normal, color, sway, phase, index };
}
