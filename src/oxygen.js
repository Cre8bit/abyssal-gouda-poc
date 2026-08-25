// oxygen.js — the survival clock (T0.3).
//
// A full tank lasts ~10 minutes of calm swimming — matching the 10-20 min
// target run. Sprinting and distress statuses (trapped, gassed) burn it
// faster; the recharge zone at the spawn point (the future bathyscaphe)
// refills it. Hitting zero = blackout → main.js respawns the diver.

import { STATUS } from "./effects.js";

export const O2_MAX = 100;
const BASE_DRAIN = O2_MAX / 600; // 10 min of calm swimming
const SPRINT_MULT = 1.8;
const TRAPPED_MULT = 2.0; // panic breathing, pinned to the floor
const GASSED_MULT = 1.5; // coughing in fermentation gas
const REFILL_RATE = O2_MAX / 5; // full tank in 5 s at the bathyscaphe

const WARN_THRESHOLDS = [50, 25, 10]; // one-shot warnings, re-armed on refill

let o2 = O2_MAX;
let dead = false;
let warned = new Set();
let onDeath = null;
let onWarn = null; // (threshold) => void

export function initOxygen({ onDeath: d, onWarn: w } = {}) {
  onDeath = d ?? null;
  onWarn = w ?? null;
}

export function getO2() {
  return o2;
}

export function getO2Frac() {
  return o2 / O2_MAX;
}

export function isDead() {
  return dead;
}

export function refillOxygen() {
  o2 = O2_MAX;
  dead = false;
  warned.clear();
}

// Once per frame. `status` is the local effects mask; `inRefillZone` is true
// near the spawn/bathyscaphe. Returns the current O₂ fraction.
export function updateOxygen(delta, { sprinting = false, status = 0, inRefillZone = false } = {}) {
  if (dead) return 0;

  if (inRefillZone) {
    if (o2 < O2_MAX) {
      o2 = Math.min(O2_MAX, o2 + REFILL_RATE * delta);
      if (o2 >= O2_MAX) warned.clear();
    }
    return o2 / O2_MAX;
  }

  let drain = BASE_DRAIN;
  if (sprinting) drain *= SPRINT_MULT;
  if (status & STATUS.TRAPPED) drain *= TRAPPED_MULT;
  if (status & STATUS.GASSED) drain *= GASSED_MULT;

  o2 = Math.max(0, o2 - drain * delta);

  for (const t of WARN_THRESHOLDS) {
    if (o2 <= t && !warned.has(t)) {
      warned.add(t);
      onWarn?.(t);
    }
  }

  if (o2 <= 0) {
    dead = true;
    onDeath?.();
  }
  return o2 / O2_MAX;
}
