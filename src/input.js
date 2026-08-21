// input.js — layout-agnostic swim controls + smoothed pointer-lock mouse look.
//
// Keys are matched by PHYSICAL position (e.code), so the same keys work as
// WASD on QWERTY and ZQSD on AZERTY automatically — no layout detection needed.
const keys = new Set();

const KEY_MAP = {
  KeyW: "forward", // Z on AZERTY
  KeyS: "backward",
  KeyA: "left", // Q on AZERTY
  KeyD: "right",
  Space: "up",
  ControlLeft: "down",
  ControlRight: "down",
  ShiftLeft: "sprint",
  ShiftRight: "sprint",
};

const MOUSE_SENSITIVITY = 0.0018;
const LOOK_SMOOTHING = 14; // higher = snappier
const PITCH_LIMIT = Math.PI / 2 - 0.08;

// Raw targets driven by the mouse; smoothed values exposed to the game.
let targetYaw = 0;
let targetPitch = 0;
let yaw = 0;
let pitch = 0;

export function initInput() {
  window.addEventListener("keydown", (e) => {
    const dir = KEY_MAP[e.code];
    if (dir) {
      keys.add(dir);
      e.preventDefault(); // stop Space from scrolling the page
    }
  });
  window.addEventListener("keyup", (e) => {
    const dir = KEY_MAP[e.code];
    if (dir) keys.delete(dir);
  });
  // Avoid stuck keys when the window loses focus.
  window.addEventListener("blur", () => keys.clear());
}

export function initMouseLook(canvas) {
  canvas.addEventListener("click", () => canvas.requestPointerLock());

  document.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== canvas) return;
    targetYaw -= e.movementX * MOUSE_SENSITIVITY;
    targetPitch = clamp(
      targetPitch - e.movementY * MOUSE_SENSITIVITY,
      -PITCH_LIMIT,
      PITCH_LIMIT,
    );
  });
}

// Call once per frame: eases the camera toward the mouse target
// (frame-rate independent exponential smoothing).
export function updateLook(delta) {
  const k = 1 - Math.exp(-LOOK_SMOOTHING * delta);
  yaw += (targetYaw - yaw) * k;
  pitch += (targetPitch - pitch) * k;
}

export function isSprinting() {
  return keys.has("sprint");
}

export function getYaw() {
  return yaw;
}

// Pin the view, for screenshot mode.
export function setLook(y, p) {
  yaw = targetYaw = y;
  pitch = targetPitch = p;
}

export function getPitch() {
  return pitch;
}

export function isPointerLocked(canvas) {
  return document.pointerLockElement === canvas;
}

// Normalized movement intent for this frame:
// { x: strafe right, y: up, z: forward }, each in [-1, 1].
export function getMovement() {
  let x = 0;
  let y = 0;
  let z = 0;

  if (keys.has("forward")) z += 1;
  if (keys.has("backward")) z -= 1;
  if (keys.has("left")) x -= 1;
  if (keys.has("right")) x += 1;
  if (keys.has("up")) y += 1;
  if (keys.has("down")) y -= 1;

  // Normalize so diagonals aren't faster.
  const len = Math.hypot(x, y, z);
  if (len > 1) {
    x /= len;
    y /= len;
    z /= len;
  }

  return { x, y, z };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
