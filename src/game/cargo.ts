// cargo.ts — hauling costs and mechanics: speed penalties, sink rates,
// grip loss conditions, hold offsets. Pure math; replication and authority
// logic live in systems/cargoSystem.ts.
import { getMyId } from "../net/mesh.ts";
import type { Vec3 } from "../state.ts";

export const CARGO = {
  // --- reach ---------------------------------------------------------------
  PICKUP_RANGE: 3.2,
  HANDOFF_RANGE: 3.0,
  DELIVER_RANGE: 11,

  // --- weight (G3) ---------------------------------------------------------
  SPEED_PENALTY: 2.5, // u/s off base speed cap (10 → 7.5)
  MIN_SPEED: 3.5,
  SINK_RATE: 1.8, // u/s negative buoyancy
  SINK_INERTIA: 2.5, // sink buildup rate (1/s)

  // --- losing it (G2) ------------------------------------------------------
  // Grip only fails to external reasons: fish hit or sprint hazard.
  BITE_FUMBLE_CHANCE: 0.25, // per catfish hit
  SPRINT_GRACE_S: 2.5, // free sprint window before hazard opens
  SPRINT_FUMBLE_PER_S: 0.07, // hazard rate while sprinting
  CATCH_MS: 4500, // catch window: slow tumble
  REGRAB_MS: 250, // grace period before re-grab allowed
  TUMBLE_SINK: 1.1, // u/s during catch window
  LOOSE_SINK: 5, // u/s after catch window closes
  LOOSE_INERTIA: 1.4,

  // --- where it rides ------------------------------------------------------
  // HOLD_*: replicated item position (what others see)
  // FP_HOLD_*: first-person camera offset (local visual only)
  HOLD_FORWARD: 0.72,
  HOLD_DOWN: 0.34,
  FP_HOLD_FORWARD: 0.95,
  FP_HOLD_DOWN: 0.62,
} as const;

// ID before mesh connection (solo play fallback)
export const LOCAL_ID = "local";

export function selfId(): string {
  return getMyId() ?? LOCAL_ID;
}

// Check if holder is self, accounting for local→host transition
export function isSelf(holder: string | null | undefined): boolean {
  if (!holder) return false;
  return holder === selfId() || (holder === LOCAL_ID && getMyId() === null);
}

// Speed cap while carrying (applied before sprint multiplier)
export function carrySpeedCap(baseCap: number): number {
  return Math.max(CARGO.MIN_SPEED, baseCap - CARGO.SPEED_PENALTY);
}

// Poisson hazard: no fumble chance during grace window
export function sprintFumbleChance(dt: number, held: number): number {
  if (held < CARGO.SPRINT_GRACE_S) return 0;
  return 1 - Math.exp(-CARGO.SPRINT_FUMBLE_PER_S * dt);
}

// Sink rate: slow tumble during catch window, then fast drop
export function looseSinkRate(ms: number): number {
  return ms < CARGO.CATCH_MS ? CARGO.TUMBLE_SINK : CARGO.LOOSE_SINK;
}

// Offset rigid in view frame: forward/down rotate with look (pitch & yaw)
function viewOffset(
  pos: Vec3,
  yaw: number,
  pitch: number,
  forward: number,
  down: number,
  out: Vec3,
): Vec3 {
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  // Camera YXZ order: pitch about side, yaw about up
  const fwd = forward * cosP + down * sinP;
  out.x = pos.x - Math.sin(yaw) * fwd;
  out.y = pos.y + forward * sinP - down * cosP;
  out.z = pos.z - Math.cos(yaw) * fwd;
  return out;
}

export function holdPose(
  pos: Vec3,
  yaw: number,
  pitch: number,
  out: Vec3,
): Vec3 {
  return viewOffset(pos, yaw, pitch, CARGO.HOLD_FORWARD, CARGO.HOLD_DOWN, out);
}

// First-person camera visual only (never replicated)
export function fpHoldPose(
  pos: Vec3,
  yaw: number,
  pitch: number,
  out: Vec3,
): Vec3 {
  return viewOffset(
    pos,
    yaw,
    pitch,
    CARGO.FP_HOLD_FORWARD,
    CARGO.FP_HOLD_DOWN,
    out,
  );
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
