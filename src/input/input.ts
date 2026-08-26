// input.ts — layout-agnostic swim controls + smoothed pointer-lock mouse look.
//
// Keys are matched by PHYSICAL position (e.code), so the same keys work as
// WASD on QWERTY and ZQSD on AZERTY automatically — no layout detection needed.
type MoveAction =
  "forward" | "backward" | "left" | "right" | "up" | "down" | "sprint";

const keys = new Set<MoveAction>();

const KEY_MAP: Record<string, MoveAction> = {
  KeyW: "forward", // Z on AZERTY
  KeyS: "backward",
  KeyA: "left", // Q on AZERTY
  KeyD: "right",
  Space: "up",
  KeyC: "down",
  ShiftLeft: "sprint",
  ShiftRight: "sprint",
};

const MOUSE_SENSITIVITY = 0.0022;
const LOOK_SMOOTHING = 14; // higher = snappier
const SWIM_SMOOTHING = 5; // the BODY follows the head lazily (see below)
const PITCH_LIMIT = Math.PI / 2 - 0.09;
const PITCH_SOFT = 0.38; // cushion zone before the pitch limit (radians)

// Raw targets driven by the mouse; smoothed values exposed to the game.
let targetYaw = 0;
let targetPitch = 0;
let yaw = 0;
let pitch = 0;
// Swim orientation: a heavier, slower "body" trailing the look direction.
// Moving along THIS (not the raw look) means quick glances around don't
// zigzag your trajectory — you can check over your shoulder mid-swim.
let swimYaw = 0;
let swimPitch = 0;
let yawVelocity = 0; // smoothed, for camera banking into turns

// Idempotent: a second init (e.g. a future lobby → game → lobby flow) must
// not stack a second set of listeners — keys would register twice and mouse
// deltas would apply twice.
let inputInstalled = false;
let mouseLookInstalled = false;

export function initInput() {
  if (inputInstalled) return;
  inputInstalled = true;
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

export function initMouseLook(canvas: HTMLCanvasElement) {
  if (mouseLookInstalled) return;
  mouseLookInstalled = true;
  canvas.addEventListener("click", () => canvas.requestPointerLock());

  document.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== canvas) return;
    targetYaw -= e.movementX * MOUSE_SENSITIVITY;

    // Soft pitch: sensitivity fades as you approach straight up/down, so the
    // camera never slams into a hard stop — no more "locked rotation" feel.
    // Moving back toward the horizon is always full speed.
    const toward = -e.movementY * MOUSE_SENSITIVITY;
    let cushion = 1;
    if (toward * targetPitch > 0) {
      const headroom = PITCH_LIMIT - Math.abs(targetPitch);
      cushion = clamp(headroom / PITCH_SOFT, 0.15, 1);
    }
    targetPitch = clamp(
      targetPitch + toward * cushion,
      -PITCH_LIMIT,
      PITCH_LIMIT,
    );
  });
}

// Call once per frame: eases the camera toward the mouse target
// (frame-rate independent exponential smoothing), then trails the swim
// body behind the head and measures turn rate for camera banking.
export function updateLook(delta: number) {
  const k = 1 - Math.exp(-LOOK_SMOOTHING * delta);
  const prevYaw = yaw;
  yaw += (targetYaw - yaw) * k;
  pitch += (targetPitch - pitch) * k;

  const instantVel = (yaw - prevYaw) / Math.max(delta, 1e-4);
  yawVelocity += (instantVel - yawVelocity) * Math.min(1, delta * 10);

  const ks = 1 - Math.exp(-SWIM_SMOOTHING * delta);
  swimYaw += (yaw - swimYaw) * ks;
  swimPitch += (pitch - swimPitch) * ks;
}

// Shot harness (shots.js): snap the look — and the lazy swim body — to an
// exact pose, bypassing the mouse smoothing entirely.
export function setLook(newYaw: number, newPitch: number) {
  targetYaw = yaw = swimYaw = newYaw;
  targetPitch = pitch = swimPitch = clamp(newPitch, -PITCH_LIMIT, PITCH_LIMIT);
}

export function getYaw() {
  return yaw;
}

export function getPitch() {
  return pitch;
}

// The lazy body orientation — use for MOVEMENT, not for the camera.
export function getSwimYaw() {
  return swimYaw;
}

export function getSwimPitch() {
  return swimPitch;
}

// Smoothed yaw turn rate (rad/s) — drives the camera's bank into turns.
export function getYawVelocity() {
  return yawVelocity;
}

// Sprint: hold Shift for a burst of speed.
export function isSprinting() {
  return keys.has("sprint");
}

export function isPointerLocked(canvas: HTMLCanvasElement) {
  return document.pointerLockElement === canvas;
}

// Normalized movement intent for this frame:
// { x: strafe right, y: up, z: forward }, each in [-1, 1].
// Returns a REUSED scratch object (called every frame — don't keep it
// across frames, read it before the next call).
const _move = { x: 0, y: 0, z: 0 };
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

  _move.x = x;
  _move.y = y;
  _move.z = z;
  return _move;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
