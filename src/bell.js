// bell.js — the diving bell's descent state machine (pure state, no rendering).
// Depth is negative Y: the bell starts at 0 and falls LEVEL_DROP per level.

export const LEVEL_DROP = 100; // metres between levels
export const DROP_DURATION = 2.2;
export const ATTACH_RADIUS = 7;
export const EJECT_MIN = 18;
export const EJECT_MAX = 34;
export const SETTLE_DELAY = 0.4;

const SLOT_COUNT = 8;
const SLOT_RADIUS = 2.8;
const SLOT_HEIGHT = 1.6;
const HOLD_BEFORE_DROP = 1.5;

const bell = { level: 0, y: 0, dropping: false, from: 0, to: 0, t: 0 };
let holdTimer = 0;

export function getBell() {
  return bell;
}

export function resetBell() {
  bell.level = 0;
  bell.y = 0;
  bell.dropping = false;
  bell.t = 0;
  holdTimer = 0;
}

// `level` is absolute, not a delta, so a joiner that missed a drop re-syncs.
export function startDrop(level) {
  bell.level = level;
  bell.from = bell.y;
  bell.to = -level * LEVEL_DROP;
  bell.t = 0;
  bell.dropping = true;
  holdTimer = 0;
}

// Jump straight to a level with no animation — used to sync a late joiner.
export function snapToLevel(level) {
  bell.level = level;
  bell.y = -level * LEVEL_DROP;
  bell.dropping = false;
  bell.t = 0;
  holdTimer = 0;
}

// Returns true on the single frame the bell hits the bottom of its drop.
export function updateBell(delta) {
  if (!bell.dropping) return false;
  bell.t = Math.min(bell.t + delta / DROP_DURATION, 1);
  // Accelerating fall cut dead at the end — the stop has to feel abrupt.
  bell.y = bell.from + (bell.to - bell.from) * Math.pow(bell.t, 1.6);
  if (bell.t < 1) return false;
  bell.dropping = false;
  bell.y = bell.to;
  return true;
}

// Host-side trigger: every diver hooked on, held for a beat before the fall.
export function readyToDrop(delta, hooked, total) {
  if (bell.dropping || hooked < total) {
    holdTimer = 0;
    return false;
  }
  holdTimer += delta;
  if (holdTimer < HOLD_BEFORE_DROP) return false;
  holdTimer = 0;
  return true;
}

// Deterministic ring slot per peer id, so nobody has to negotiate a place.
export function slotOffset(peerId) {
  let h = 0;
  for (let i = 0; i < peerId.length; i++) {
    h = (h * 31 + peerId.charCodeAt(i)) | 0;
  }
  const angle = ((Math.abs(h) % SLOT_COUNT) / SLOT_COUNT) * Math.PI * 2;
  return {
    x: Math.cos(angle) * SLOT_RADIUS,
    y: SLOT_HEIGHT,
    z: Math.sin(angle) * SLOT_RADIUS,
  };
}

// Where a diver lands when the bell shakes them off: same depth, random bearing.
export function ejectPosition(bellY) {
  const angle = Math.random() * Math.PI * 2;
  const dist = EJECT_MIN + Math.random() * (EJECT_MAX - EJECT_MIN);
  return {
    x: Math.cos(angle) * dist,
    y: bellY,
    z: Math.sin(angle) * dist,
  };
}

export function distanceToBell(pos) {
  return Math.hypot(pos.x, pos.y - bell.y, pos.z);
}
