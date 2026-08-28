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
//   - sprinting with it burns air fast, and holding the sprint risks your grip
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
  // Heavy enough to feel, light enough to swim home with. The first pass was
  // 4 u/s off the cap and 4 u/s of sink, which together meant a carrier who
  // stopped kicking for a second dropped faster than they could climb — the
  // haul stopped being a journey and became a treadmill. Half the sink and a
  // smaller speed tax keep the WEIGHT (you are slower, you do sag, you must
  // keep swimming) without making up the only route unwinnable.
  SPEED_PENALTY: 2.5, // u/s off the base speed cap (10 → 7.5)
  MIN_SPEED: 3.5, // …but never fully pinned
  SINK_RATE: 1.8, // u/s of negative buoyancy, beatable by swim spam
  SINK_INERTIA: 2.5, // how fast the sink builds (1/s) — a lurch, not a step

  // --- losing it (G2) ------------------------------------------------------
  // The grip only fails for a REASON: a fish hit you, or you were sprinting
  // with both arms full. Never a random tick — an arbitrary drop reads as a
  // bug, and the whole verb dies with it.
  //
  // …and the reason has to be one the player can see coming. The sprint
  // hazard used to start the instant you touched the key at 0.22/s, so a
  // two-second burst to clear a gap was a coin flip and the honest reading
  // was "it slips off all the time". Now a short burst is FREE (the grace)
  // and the hazard only opens after it, at a third of the old rate: sprinting
  // is a decision with a tell, not a dice roll. Same for the bite — a fish
  // hit costs you the wheel one time in four, not two times in three.
  BITE_FUMBLE_CHANCE: 0.25, // per catfish hit
  SPRINT_GRACE_S: 2.5, // free burst before sprinting can cost you the grip
  SPRINT_FUMBLE_PER_S: 0.07, // hazard rate after that, while still sprinting
  CATCH_MS: 4500, // grace window: it tumbles slowly, catch it
  REGRAB_MS: 250, // …but not in the same breath you dropped it
  TUMBLE_SINK: 1.1, // u/s during the catch window
  LOOSE_SINK: 5, // u/s once the window closes — now it's gone down a shaft
  LOOSE_INERTIA: 1.4,

  // --- where it rides ------------------------------------------------------
  // TWO offsets, and they are not a mistake.
  //
  // HOLD_* is where the wheel actually IS: the replicated item position, and
  // therefore what every other diver sees in your arms. It has to be inside a
  // rat diver's reach — the arms are about 0.7 u — or the wheel floats a
  // body-length ahead of whoever is supposedly carrying it. That is the
  // number the third-person carry pose is solved against, and it is tucked in
  // close: with GOUDA_RADIUS at 0.45 the crust sits about a hand's width off
  // the chest, which is the only distance at which two short arms can wrap it.
  //
  // FP_HOLD_* is where the CARRIER'S OWN camera draws it, and it is a little
  // further out and lower for one reason: the camera's vertical FOV is 72°,
  // so at the true offset a 0.9 u wheel fills the middle of the frame. Pushed
  // out and down, its top edge sits below the aim point — you always see what
  // you are carrying and it never covers what you are looking at.
  //
  // The gap is a first-person cosmetic, exactly like diverRig's FP_OFFSET:
  // nobody else's view moves, and the only thing that shifts with it is the
  // wheel's own lamp, by a hand's width, in the dark.
  HOLD_FORWARD: 0.72,
  HOLD_DOWN: 0.34,
  FP_HOLD_FORWARD: 0.95,
  FP_HOLD_DOWN: 0.62,
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

// Probability of losing your grip over `dt` seconds of sprinting, `held`
// seconds into the current sprint. A Poisson hazard, so the odds don't change
// with framerate — and zero until the grace window closes, so a short burst
// to clear a gap or shake a fish never costs you the wheel.
export function sprintFumbleChance(dt: number, held: number): number {
  if (held < CARGO.SPRINT_GRACE_S) return 0;
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
// chest, below the eyeline. This is the position of record — the one that
// replicates and the one every other diver sees.
//
// The offset is RIGID IN THE VIEW FRAME: forward and down both rotate with
// the look, so the wheel holds one spot relative to the carrier however they
// tilt. It used to drop by a world-vertical HOLD_DOWN instead, which slid the
// wheel through their hands every time they pitched — and the arms are posed
// in the view frame (diverRig's FP pivot tracks the look exactly while
// carrying), so the load has to live in the same frame or no grip can hold at
// every angle. It also means a diver looking straight down is holding the
// wheel under them, which is what a diver looking straight down would do.
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
  // View-frame (0, -down, -forward), rotated by pitch about the side axis
  // then by yaw about up — the camera's own YXZ order.
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

// …and where the CARRIER'S OWN camera draws it (see FP_HOLD_* above). Used by
// systems/cargoSystem.ts for the local visual only — never for the item.
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
