// current.js — finite ocean currents. A current is a curving corridor of
// moving water about 50 m long: it appears, pushes anything inside it along its
// path, and fades. You can always swim against it, just not easily.
const NODES = 14; // polyline resolution along the flow
export const LENGTH = 50; // metres from mouth to tail
export const RADIUS = 9; // how wide the corridor is
const STRENGTH = 3.4; // metres per second of push at the core

const LIFE = 26; // seconds a current runs for
const FADE = 4; // ramp in and out, so nothing snaps on
const GAP_MIN = 18;
const GAP_MAX = 55;
const SPAWN_MIN = 25; // where its mouth opens, relative to the diver
const SPAWN_MAX = 70;

// Two flows run independently, so the water can have more than one mood.
const FLOWS = 2;
const states = [];
for (let i = 0; i < FLOWS; i++) {
  states.push({
    active: false,
    age: 0,
    gap: 6 + i * 21, // stagger them so they never appear together
    path: [],
    tangents: [],
  });
}

export function getCurrents() {
  return states;
}

export function strengthOf(state) {
  if (!state.active) return 0;
  const inRamp = Math.min(state.age / FADE, 1);
  const outRamp = Math.min((LIFE - state.age) / FADE, 1);
  return Math.max(0, Math.min(inRamp, outRamp));
}

function spawn(state, origin, noise, forcedBearing = null) {
  const a = forcedBearing ?? Math.random() * Math.PI * 2;
  const d = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
  let x = origin.x + Math.cos(a) * d;
  let y = origin.y + (Math.random() - 0.5) * 24;
  let z = origin.z + Math.sin(a) * d;

  // The flow curves as it goes: the heading turns on a noise track rather than
  // running straight, so a current reads as a river, not a pipe.
  let heading = forcedBearing !== null ? a + Math.PI * 0.5 : Math.random() * Math.PI * 2;
  let climb = (Math.random() - 0.5) * 0.5;
  const seed = Math.random() * 100;
  const step = LENGTH / (NODES - 1);

  state.path.length = 0;
  state.tangents.length = 0;
  for (let i = 0; i < NODES; i++) {
    state.path.push({ x, y, z });
    heading += noise.noise(i * 0.35, seed, 0) * 0.42;
    climb += noise.noise(0, i * 0.35, seed) * 0.1;
    const tx = Math.cos(heading);
    const ty = Math.max(-0.6, Math.min(0.6, climb));
    const tz = Math.sin(heading);
    const len = Math.hypot(tx, ty, tz) || 1;
    state.tangents.push({ x: tx / len, y: ty / len, z: tz / len });
    x += (tx / len) * step;
    y += (ty / len) * step;
    z += (tz / len) * step;
  }

  state.active = true;
  state.age = 0;
}

export function updateCurrent(delta, origin, noise) {
  for (const state of states) {
    if (state.active) {
      state.age += delta;
      if (state.age >= LIFE) {
        state.active = false;
        state.gap = GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN);
      }
      continue;
    }
    state.gap -= delta;
    if (state.gap <= 0) spawn(state, origin, noise);
  }
}

// Screenshot hook: put a current right in front of the camera, mid-life.
export function forceCurrent(origin, noise, bearing) {
  spawn(states[0], origin, noise, bearing);
  states[0].age = LIFE * 0.5;
}

// The combined push at a point, written into `out`. Zero outside every flow.
export function currentForceAt(x, y, z, out) {
  out.x = out.y = out.z = 0;
  for (const state of states) addFlowForce(state, x, y, z, out);
  return out;
}

function addFlowForce(state, x, y, z, out) {
  const power = strengthOf(state);
  if (power <= 0) return out;

  // Nearest node wins — at this resolution that is close enough to a true
  // distance-to-polyline, and far cheaper.
  let best = Infinity;
  let index = -1;
  for (let i = 0; i < state.path.length; i++) {
    const p = state.path[i];
    const d = (x - p.x) ** 2 + (y - p.y) ** 2 + (z - p.z) ** 2;
    if (d < best) {
      best = d;
      index = i;
    }
  }
  if (index < 0) return out;

  const dist = Math.sqrt(best);
  if (dist >= RADIUS) return out;

  // Strongest along the axis, easing to nothing at the wall.
  const t = 1 - dist / RADIUS;
  const falloff = t * t * (3 - 2 * t);
  const push = STRENGTH * falloff * power;
  const tan = state.tangents[index];
  out.x += tan.x * push;
  out.y += tan.y * push;
  out.z += tan.z * push;
  return out;
}
