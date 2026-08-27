// biolume.js — a bioluminescent bloom: the one biome whose whole purpose is
// particles. Seeded from the level like the kelp field, so every player sees
// the same bloom in the same place with nothing sent over the network.
import { LEVEL_DROP } from "./bell.js";

// A wide dense core with a shorter halo. Get this ratio wrong and the bloom
// scatters into separate points, which is exactly what reads as a starfield —
// a cloud needs many faint motes overlapping, not few bright ones spread thin.
export const HEART_RADIUS = 80;
export const FIELD_RADIUS = 220; // full reach — a region you swim into, not an object

// Out past the antenna's shell, so the bloom is somewhere you go rather than
// something draped over the bell.
const NEAR_MIN = 200;
const NEAR_MAX = 340;
const BAND_HALF = 40;

function hash(a, b) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

let cachedLevel = -1;
let cached = null;

export function biolumeFor(level) {
  if (level === cachedLevel) return cached;
  const r = (n) => hash(level * 613 + 29, n);

  // Stretched and leaning, never a ball.
  const flat = r(3) < 0.45;
  const ax = (flat ? 1.35 : 0.7) * (0.85 + r(4) * 0.3);
  const ay = (flat ? 0.45 : 1.5) * (0.85 + r(5) * 0.3);
  const az = (flat ? 1.2 : 0.8) * (0.85 + r(6) * 0.3);

  const bearing = r(1) * Math.PI * 2;
  const dist = NEAR_MIN + r(2) * (NEAR_MAX - NEAR_MIN);

  cachedLevel = level;
  cached = {
    x: Math.cos(bearing) * dist,
    y: -level * LEVEL_DROP + (r(7) - 0.5) * 2 * BAND_HALF,
    z: Math.sin(bearing) * dist,
    ax,
    ay,
    az,
    // Warped hard: at this strength the boundary grows lobes and inlets instead
    // of reading as a smoothly squashed ball.
    warp: 0.45 + r(8) * 0.35,
    seed: Math.floor(r(9) * 1e6),
  };
  return cached;
}

// How deep inside the bloom a point is: a hard heart with a long soft halo.
export function biolumeDensity(field, x, y, z) {
  const dx = (x - field.x) / field.ax;
  const dy = (y - field.y) / field.ay;
  const dz = (z - field.z) / field.az;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d >= FIELD_RADIUS) return 0;
  const heart = 1 - ease(d / HEART_RADIUS);
  const halo = 1 - ease(d / FIELD_RADIUS);
  return Math.min(1, heart * 0.6 + halo * 0.65);
}

function ease(t) {
  const u = Math.min(Math.max(t, 0), 1);
  return u * u * (3 - 2 * u);
}
