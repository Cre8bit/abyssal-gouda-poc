// input.js — ZQSD keyboard + pointer-lock mouse-look controller.
const keys = new Set();

const KEY_MAP = {
  z: "forward",
  s: "backward",
  q: "left",
  d: "right",
};

let yaw = 0;
let pitch = 0;

export function initInput() {
  window.addEventListener("keydown", (e) => {
    const dir = KEY_MAP[e.key.toLowerCase()];
    if (dir) keys.add(dir);
  });
  window.addEventListener("keyup", (e) => {
    const dir = KEY_MAP[e.key.toLowerCase()];
    if (dir) keys.delete(dir);
  });
}

export function initMouseLook(canvas) {
  canvas.addEventListener("click", () => canvas.requestPointerLock());
  document.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== canvas) return;
    yaw -= e.movementX * 0.002;
    pitch = Math.max(-0.5, Math.min(1.0, pitch - e.movementY * 0.002));
  });
}

export function getYaw() {
  return yaw;
}
export function getPitch() {
  return pitch;
}

// Returns a normalized movement vector for this frame: { x, z } in [-1, 1].
export function getMovement() {
  let x = 0;
  let z = 0;

  if (keys.has("forward")) z -= 1;
  if (keys.has("backward")) z += 1;
  if (keys.has("left")) x -= 1;
  if (keys.has("right")) x += 1;

  // Normalize diagonals so they aren't faster.
  if (x !== 0 && z !== 0) {
    const inv = 1 / Math.SQRT2;
    x *= inv;
    z *= inv;
  }

  return { x, z };
}
