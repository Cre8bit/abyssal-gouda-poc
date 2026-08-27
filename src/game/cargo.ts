// cargo.ts — the rules of hauling the Golden Gouda (M1.1/M1.3).
//
// Pure: numbers and maths, no three.js, no item registry, no network. The
// wiring lives in systems/cargoSystem.ts; this file is the part you argue
// with at Gate A ("is hauling it up through a tunnel interesting?"), so every
// lever the transport scheme has is a named constant right here.
//
// THE DEAL (register G2/G3/G4):
//   - you swim slower and you sink, and you must keep swimming to hold depth
//   - your pickaxe is stowed and your torch is off — the wheel is the light
//   - sprinting with it burns air fast AND risks your grip
//   - you can hand it to a teammate in one press, which is the whole co-op
//
// Nothing here reads or writes state: the holder of record is the `holder`
// field on the Gouda's ItemInstance (replicated), and "am I the carrier" is
// the STATUS.CARRYING bit every client already broadcasts.
import { getMyId } from "../net/mesh.ts";
import type { Vec3 } from "../state.ts";

export const CARGO = {
  // --- reach ---------------------------------------------------------------
  PICKUP_RANGE: 3.2, // how close you must be to grab the wheel
  HANDOFF_RANGE: 3.0, // "another player is close" — the prompt distance
  DELIVER_RANGE: 11, // the bell's hatch radius: inside it, the run is won

  // --- weight (G3) ---------------------------------------------------------
  SPEED_PENALTY: 4, // u/s off the base speed cap (10 → 6)
  MIN_SPEED: 2.5, // …but never fully pinned
  SINK_RATE: 4, // u/s of negative buoyancy, beatable by swim spam
  SINK_INERTIA: 2.5, // how fast the sink builds (1/s) — a lurch, not a step

  // --- losing it (G2) ------------------------------------------------------
  // The grip only fails for a REASON: a fish hit you, or you were sprinting
  // with both arms full. Never a random tick — an arbitrary drop reads as a
  // bug, and the whole verb dies with it.
  BITE_FUMBLE_CHANCE: 0.6, // per catfish hit
  SPRINT_FUMBLE_PER_S: 0.22, // hazard rate while sprinting with the wheel
  CATCH_MS: 3000, // grace window: it tumbles slowly, catch it
  REGRAB_MS: 500, // …but not in the same breath you dropped it
  TUMBLE_SINK: 1.6, // u/s during the catch window
  LOOSE_SINK: 7, // u/s once the window closes — now it's gone down a shaft
  LOOSE_INERTIA: 1.4,

  // --- where it rides ------------------------------------------------------
  // Framing, first-person: the camera's vertical FOV is 72°, so at 1.6 u the
  // visible half-height is ~1.17 u. Sitting the wheel 0.95 u below the axis
  // puts its top edge a clear third of the frame below the crosshair — you
  // always see what you are carrying, and it never covers what you aim at.
  HOLD_FORWARD: 1.6,
  HOLD_DOWN: 0.95,
} as const;

// Our id on the wire. Before the mesh is up (solo play, and every session's
// first minutes) there is no peer id — items.ts mints ids against the same
// "local" fallback, so the two conventions agree.
export const LOCAL_ID = "local";

export function selfId(): string {
  return getMyId() ?? LOCAL_ID;
}

// Is this holder id us? The pre-mesh "local" is still us after we host: a
// solo diver who picks the wheel up and only then opens the game to friends
// must not watch it teleport out of their arms.
export function isSelf(holder: string | null | undefined): boolean {
  if (!holder) return false;
  return holder === selfId() || (holder === LOCAL_ID && getMyId() === null);
}

// Speed cap while carrying — applied to the BASE cap, before the sprint
// multiplier, so sprinting with the wheel is still meaningfully faster than
// swimming with it. That's the trap: the fast option is the one that makes
// you drop it.
export function carrySpeedCap(baseCap: number): number {
  return Math.max(CARGO.MIN_SPEED, baseCap - CARGO.SPEED_PENALTY);
}

// Probability of losing your grip over `dt` seconds of sprinting. Expressed
// as a Poisson hazard so the odds don't change with framerate.
export function sprintFumbleChance(dt: number): number {
  return 1 - Math.exp(-CARGO.SPRINT_FUMBLE_PER_S * dt);
}

// How fast a loose wheel is falling, `ms` after it was let go. Inside the
// catch window it barely drifts; after it, the abyss takes over. D3 makes
// this hurt: the route in is also the route DOWN, so a dropped Gouda always
// falls away from home.
export function looseSinkRate(ms: number): number {
  return ms < CARGO.CATCH_MS ? CARGO.TUMBLE_SINK : CARGO.LOOSE_SINK;
}

// Where the wheel rides on a diver at (pos, yaw, pitch): in front of the
// chest, below the eyeline. Same maths for the local first-person carrier
// and for every remote diver, so what you see them holding is where it is.
export function holdPose(
  pos: Vec3,
  yaw: number,
  pitch: number,
  out: Vec3,
): Vec3 {
  const cosP = Math.cos(pitch);
  out.x = pos.x - Math.sin(yaw) * cosP * CARGO.HOLD_FORWARD;
  out.y = pos.y + Math.sin(pitch) * CARGO.HOLD_FORWARD - CARGO.HOLD_DOWN;
  out.z = pos.z - Math.cos(yaw) * cosP * CARGO.HOLD_FORWARD;
  return out;
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
