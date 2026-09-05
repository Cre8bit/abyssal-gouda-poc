// diverRig.js — the rat-diver skinned rig: one-time template prep (cached
// axes + rest pose) and a per-instance PROCEDURAL swim animation.
//
// The GLB ships a baked "NlaTrack" swim clip — it is deliberately ignored.
// No AnimationMixer runs: every frame is cheap absolute-pose math (one
// setFromAxisAngle + one quaternion multiply per driven bone), so poses
// never drift and never accumulate.
//
// Skeleton (Tripo rig, 41 joints) — we drive only 16 of them:
//   legs   L/R_Thigh → L/R_Calf → L/R_Foot        (flutter kick)
//   spine  Waist → Spine01 → Spine02              (undulation)
//   neck   NeckTwist01/02 → Head                  (camera-synced look)
//   arms   L/R_Upperarm → L/R_Forearm → L/R_Hand  (stroke; FP shows arms only)
// The 14 *Twist* helper bones are identity passthroughs and are never
// touched; Root/Hip/Pelvis/Clavicles/ToeBases stay at rest. Whole-body
// motion (prone lean, bank into strafes, nose-toward-travel) lives on the
// rig's `root` group instead of on bones.
//
// Conventions:
//  - The template model faces +Z, stands ~0.95 units tall, and has
//    unit-scale bones (unlike the old diver's ×100 armature). Lights still
//    live at scene level so beam/halo sizes stay world-true.
//  - Procedural angles are expressed about TEMPLATE-space axes (aX = side,
//    aY = up, aZ = facing), mapped once per bone into its local frame at
//    prep time — so "rotate the thigh about aX" kicks the leg no matter how
//    the bone's local frame happens to be oriented.
//  - The rig is EYE-ANCHORED: the mount point (the player's camera /
//    broadcast position) coincides with the head, so yaw/pitch swing the
//    body under the head like a real swimmer, and the helmet torch sits
//    exactly at the reported view position.
//  - Head convention happens to match the camera's (forward = local -Z,
//    up = +Y); `headFix` absorbs the tiny residual offset so the head — and
//    therefore the helmet torch — aims EXACTLY where the camera points.
import * as THREE from "three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { toonify, toonMaterial } from "../render/toon.ts";

export const DIVER_SCALE = 1.4; // template ~0.95 tall → ~1.33 world units
// FP body scales down to keep arms readable without dominating frame
// (true scale = arms loom huge across the view from shoulder-mounted camera).
let FP_SCALE = 2.24;
const LEAN = 1.0; // prone swimming lean (rad) — body pitches under the head
// FP leans minimally (shoulders stay below eye, arms hang forward).
// Third-person: shoulder rotation swings under head; FP: shoulders stay upright.
const FP_LEAN = 0.22;
const REF_SPEED = 10; // world speed that maps to a full-effort kick

// Body positioned below and behind eye anchor (shoulder cut stays off-screen
// at all look angles; see FP_VIEW for rigid camera lock).
const FP_OFFSET = new THREE.Vector3(0, -0.16, 0.1);

// Base arm poses (template-space angles), numerically solved per view.
export interface ArmPose {
  uy: number; // upper arm: swing out/back (mirrored L/R)
  ux: number; // upper arm: raise/lower
  fy: number; // elbow fold (mirrored L/R)
  fx: number; // elbow: lift the forearm
  fz: number; // forearm ROLL — pronation, i.e. which way the palm faces
  hx: number; // wrist: bend the hand up/down
  hy: number; // wrist turn: palms roll inward to close around a load
  hz: number; // wrist roll — the last of the palm's aim
}
const ARM_POSE_THIRD: ArmPose = {
  uy: 1.45,
  ux: -0.45,
  fy: 0.25,
  fx: -0.15,
  fz: 0,
  hx: 0.18,
  hy: 0,
  hz: 0,
};
// Level view: arms hang forward/down, glove backs at frame edge.
// Solved numerically via bench. Values prevent idle sway from bobbing knuckles
// into frame (hidden means hidden).
const ARM_POSE_FP: ArmPose = {
  uy: 1.43,
  ux: -1.44,
  fy: 0.57,
  fx: 0.42,
  fz: 0.3,
  hx: 0.28,
  hy: 0,
  hz: 0.45,
};
// Down look: pose-driven reveal (arms draw in/up as you look down).
// Paws land in lower third angled inward—neutral "ready to hold" shape
// for future held items. Rigid camera lock keeps shoulder cut off-screen.
const ARM_POSE_FP_DOWN: ArmPose = {
  uy: 1.43,
  ux: -1.44,
  fy: 1.2,
  fx: 0.85,
  fz: 0.32,
  hx: 0.38,
  hy: 0.3,
  hz: 0.75,
};
// Look pitch (rad, negative = down) at which the down pose is fully in…
const FP_LOOK_DOWN = 1.0;
// …and the pitch at which the reveal STARTS. Below this the hands are fully
// out of frame — the level pose parks them under the bottom edge, and this
// dead zone is what keeps them there through ordinary small look-downs
// (swimming along a floor, glancing at the compass). The hands are a
// deliberate reveal, not standing furniture.
let FP_REVEAL_START = 0.25;

// Carry poses crossfade over ~0.2s (carrySm); strokes damped away.
// Hands on wheel FLANKS (not front face). Solved to match cargo.HOLD_* offsets.
// Retune poses together—move/resize wheel and hand position must follow.
const ARM_POSE_CARRY_THIRD: ArmPose = {
  uy: 0.95,
  ux: -0.15,
  fy: 1.05,
  fx: 0.15,
  fz: -0.5,
  hx: 0.25,
  hy: 0.55,
  hz: -0.6,
};
// (ux/fx lift the paws up onto the wheel's equator — at the old values the
// wheel read as RESTING on the forearms; hy turns the palms hard onto the
// flanks so the grip reads as holding, not supporting.)
const ARM_POSE_CARRY_FP: ArmPose = {
  uy: 1.35,
  ux: 0.5,
  fy: 0.69,
  fx: 0.4,
  fz: -0.2,
  hx: 0.6,
  hy: 0.5,
  hz: -0.02,
};
// FP body slides forward/down during carry (shoulder cut buried in cheese).
const FP_OFFSET_CARRY = new THREE.Vector3(0, -0.19, -0.21);
// …and drops down/right while drilling, so the tool rides the lower corner
// instead of sitting on the crosshair.
const FP_OFFSET_DRILLER = new THREE.Vector3(0.1, -0.3, 0.1);

// Driller grip — authored in the bench pose editor (preview.ts, "driller hold
// pose") and asymmetric, unlike the Gouda's two-handed hug: the left paw
// steadies the barrel, the right sits back on the grip. The same pose serves
// first person, so the tool sits in the paw the camera can actually see.
const ARM_POSE_DRILLER_L: ArmPose = {
  uy: 1.3198565821023656,
  ux: -0.415358708308355,
  fy: 1.302265700985218,
  fx: 0.6579266744367341,
  fz: -0.6772623830737345,
  hx: -0.6036618994241535,
  hy: -0.2518724893837019,
  hz: 0.3547426396190361,
};
const ARM_POSE_DRILLER_R: ArmPose = {
  uy: 0.9704390268508847,
  ux: -0.11836488532226327,
  fy: 1.5259339280412691,
  fx: -0.0260704506934891,
  fz: -0.31900848911504565,
  hx: -1.258815879760726,
  hy: -0.3527417713840886,
  hz: 0.7129024863996127,
};
// The other half of that export: where the tool itself sits in the rig-root
// frame once the arms are in the grip above. holdAnchor() turns this into a
// node under the right hand bone, so the prop rides the arm instead of the body.
const DRILLER_TOOL = new THREE.Matrix4().compose(
  new THREE.Vector3(
    -0.06804448617029013,
    1.2413661952630088,
    -0.9445430500185676,
  ),
  new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      -1.0304698079267598,
      -0.03442524227649817,
      -3.002240982155287,
    ),
  ),
  new THREE.Vector3(1, 1, 1),
);

// --- The light stick's three states ----------------------------------------
// A throw is an animation, not a pose. The paw drops to the belt and closes
// on a baton (grab), brings it up in front of the chest (hold), then whips
// forward and lets go (throw) — three authored placements the rig blends
// between on `carryPhase`. Authored in the bench pose editor (preview.ts,
// "light stick poses"), which exports exactly the block below.
export type StickPhase = "grab" | "hold" | "throw";

// The paw at the belt, closing on a stick in its holster.
const ARM_POSE_STICK_GRAB_L: ArmPose = {
  uy: 1.45,
  ux: -0.45,
  fy: 0.25,
  fx: -0.15,
  fz: 0.0,
  hx: 0.18,
  hy: 0.0,
  hz: 0.0,
};
const ARM_POSE_STICK_GRAB_R: ArmPose = {
  uy: -0.36570375385087167,
  ux: 0.7479197500760427,
  fy: 0.9261985256430342,
  fx: -0.9021669548500408,
  fz: 0.5831561776265449,
  hx: -0.2614268547362653,
  hy: 0.272135132202188,
  hz: 0.8786530093364617,
};
// Carried: the baton up in front of the chest, left paw free to swim.
const ARM_POSE_STICK_HOLD_L: ArmPose = {
  uy: 1.45,
  ux: -0.45,
  fy: 0.25,
  fx: -0.15,
  fz: 0.0,
  hx: 0.18,
  hy: 0.0,
  hz: 0.0,
};
const ARM_POSE_STICK_HOLD_R: ArmPose = {
  uy: 0.458407346410207,
  ux: -0.901592653589793,
  fy: 0.6484073308355277,
  fx: -0.7715926356074155,
  fz: 0.9494347583217078,
  hx: -0.3049746926773733,
  hy: 0.208407346410207,
  hz: 0.318407346410207,
};
// The release: arm swung through, paw open, baton on its way.
const ARM_POSE_STICK_THROW_L: ArmPose = {
  uy: 1.45,
  ux: -0.45,
  fy: 0.25,
  fx: -0.15,
  fz: 0.0,
  hx: 0.18,
  hy: 0.0,
  hz: 0.0,
};

// First person walks the same three states with its own RIGHT arm, for the
// same reason the Gouda does (ARM_POSE_CARRY_FP): the third-person poses are
// authored against a body seen from outside, and replayed at the eye they put
// the wrist 0.16 u from the lens with the shoulder cut about to swing into
// frame. These are screenshot-tuned in the gloves bench instead
// (?m=gloves&hold=lightStick, eye cam) and land the baton in the lower right.
// The LEFT arm is the free swimming paw and is shared with the poses above.
const FP_STICK_GRAB_R: ArmPose = {
  uy: 0.3,
  ux: 0.35,
  fy: 0.95,
  fx: -0.25,
  fz: -0.3,
  hx: -0.55,
  hy: -0.35,
  hz: 0.45,
};
const FP_STICK_HOLD_R: ArmPose = {
  uy: 1.15,
  ux: -0.75,
  fy: 1.0,
  fx: 0.35,
  fz: -0.4,
  hx: -0.9,
  hy: -0.35,
  hz: 0.55,
};
const FP_STICK_THROW_R: ArmPose = {
  uy: 1.5,
  ux: -1.0,
  fy: 0.2,
  fx: 0.1,
  fz: -0.2,
  hx: -0.25,
  hy: -0.2,
  hz: 0.3,
};
const ARM_POSE_STICK_THROW_R: ArmPose = {
  uy: 1.1759057045160608,
  ux: -1.235221559985197,
  fy: 1.4452891491851174,
  fx: 0.22142460889629614,
  fz: -0.40919898632021373,
  hx: -1.4374342631488266,
  hy: -0.35309413056574546,
  hz: -0.06552954586439433,
};

// …and where the baton itself sits in the rig-root frame in each of them.
// Authored in the pose bench (?m=stick-pose) and pasted back verbatim — the
// baton lies STRAIGHT across the fingers with the clip toward the wrist, which
// is the read the arm poses were built around. Solved against a frozen torso
// (see restHandChain) so the same numbers land the same way every time; the
// bench freezes the same chain, so what is dragged there is what ships.
const STICK_TOOL_GRAB = new THREE.Matrix4().compose(
  new THREE.Vector3(
    0.308974817981264,
    0.5694464239990582,
    0.002128771133767186,
  ),
  new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      -1.3556254399439494,
      0.384366004657115,
      0.15719926464091727,
    ),
  ),
  new THREE.Vector3(1, 1, 1),
);
const STICK_TOOL_HOLD = new THREE.Matrix4().compose(
  new THREE.Vector3(
    0.20817406447687387,
    0.8430764552076017,
    -0.41180161157247763,
  ),
  new THREE.Quaternion().setFromEuler(
    new THREE.Euler(0.238407346410207, -1.41159265358979, 0.008407346410207),
  ),
  new THREE.Vector3(1, 1, 1),
);
const STICK_TOOL_THROW = new THREE.Matrix4().compose(
  new THREE.Vector3(
    0.16802244957205234,
    1.0437887690177587,
    -0.25832327926947396,
  ),
  new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      0.31551138735845585,
      -0.08041295509532478,
      -0.21711791582697723,
    ),
  ),
  new THREE.Vector3(1, 1, 1),
);

// The stick is small and one-handed: the FP body drops less than the driller
// makes it, and the arms stay near true length — a 0.4 u baton at a paw's
// reach already fills a corner of a 72° lens without help. Screenshot-tuned
// in the gloves bench (?m=gloves&hold=lightStick, eye cam).
const FP_OFFSET_STICK = new THREE.Vector3(0.12, -0.2, 0.06);

// What the diver has in its paws. "none" is the idle/swim blend; every other
// kind is a grip in GRIPS below.
export type GripKind = "gouda" | "driller" | "lightStick";
export type CarryKind = "none" | GripKind;

// One authored placement: both arms, plus where the prop sits while they are
// in it. A grip is a default placement; grips that animate list more of them
// in `states` and name them (see StickPhase).
interface GripPose {
  left: ArmPose;
  right: ArmPose;
  fpLeft: ArmPose;
  fpRight: ArmPose;
  /** Prop transform in the rig-root frame; null = placed by game/cargo.ts. */
  tool: THREE.Matrix4 | null;
}

interface Grip extends GripPose {
  /** Where the FP body parks while gripping (see FP_OFFSET_CARRY). */
  fpOffset: THREE.Vector3;
  /** How long the FP arms are while gripping (see FP_SCALE). */
  fpScale: number;
  /** Named states this grip animates through, blended on `carryPhase`. */
  states?: Record<string, GripPose>;
  /** Which of `states` the grip rests in when no phase is asked for. */
  base?: string;
}

const GRIPS: Record<GripKind, Grip> = {
  gouda: {
    left: ARM_POSE_CARRY_THIRD,
    right: ARM_POSE_CARRY_THIRD,
    fpLeft: ARM_POSE_CARRY_FP,
    fpRight: ARM_POSE_CARRY_FP,
    fpOffset: FP_OFFSET_CARRY,
    fpScale: 0, // 0 = keep FP_SCALE, whatever it's been tuned to
    tool: null,
  },
  driller: {
    left: ARM_POSE_DRILLER_L,
    right: ARM_POSE_DRILLER_R,
    fpLeft: ARM_POSE_DRILLER_L,
    fpRight: ARM_POSE_DRILLER_R,
    // No wheel to bury the shoulder cut in — the FP body drops down and right
    // instead, and the arms come most of the way down to true scale: the grip
    // was authored around a tool of a fixed real size, so full FP_SCALE arms
    // hold a driller that fills the lens. This leaves the usual mild viewmodel
    // exaggeration and nothing more.
    fpOffset: FP_OFFSET_DRILLER,
    fpScale: 1.7,
    tool: DRILLER_TOOL,
  },
  // Three states, blended on `carryPhase`; the grip itself mirrors "hold" so
  // callers that never name a phase still get a diver carrying a light stick.
  lightStick: {
    left: ARM_POSE_STICK_HOLD_L,
    right: ARM_POSE_STICK_HOLD_R,
    fpLeft: ARM_POSE_STICK_HOLD_L,
    fpRight: FP_STICK_HOLD_R,
    fpOffset: FP_OFFSET_STICK,
    fpScale: 1.45,
    tool: STICK_TOOL_HOLD,
    base: "hold",
    states: {
      grab: {
        left: ARM_POSE_STICK_GRAB_L,
        right: ARM_POSE_STICK_GRAB_R,
        fpLeft: ARM_POSE_STICK_GRAB_L,
        fpRight: FP_STICK_GRAB_R,
        tool: STICK_TOOL_GRAB,
      },
      hold: {
        left: ARM_POSE_STICK_HOLD_L,
        right: ARM_POSE_STICK_HOLD_R,
        fpLeft: ARM_POSE_STICK_HOLD_L,
        fpRight: FP_STICK_HOLD_R,
        tool: STICK_TOOL_HOLD,
      },
      throw: {
        left: ARM_POSE_STICK_THROW_L,
        right: ARM_POSE_STICK_THROW_R,
        fpLeft: ARM_POSE_STICK_THROW_L,
        fpRight: FP_STICK_THROW_R,
        tool: STICK_TOOL_THROW,
      },
    },
  },
};

// How fast each named state takes over once it becomes the target (1/s).
// A throw snaps; reaching down to the belt is a movement you can read.
export const PHASE_EASE: Record<string, number> = {
  grab: 7,
  hold: 6,
  throw: 16,
};
export const PHASE_EASE_DEFAULT = 6;

// How long a light stick's throw dwells in each state (seconds). The rig
// blends at PHASE_EASE; these are how long the timeline SITS in a state
// before naming the next one. Exported because two callers walk it and they
// must agree: systems/lightStickSystem.ts (the game) and the bench's "throw
// stick" preview — so what plays in the bench is the timing that ships.
export const STICK_DWELL = {
  /** Reaching down to the belt and back — the draw AND the stow. */
  grab: 0.34,
  /** How far into that reach the paw actually closes on the baton — before
   *  this the holster is still empty, so the stick is not drawn at all. In
   *  first person the paw crosses the bottom of the lens on its way down and
   *  a baton already in it reads as conjured out of the air. */
  clasp: 0.24,
  /** The swing, from the paw opening to the arm finishing through. */
  throw: 0.34,
  /** …and where in that swing the baton actually leaves the paw. */
  release: 0.13,
} as const;

// One authored placement, handed out by value. The bench pose editor opens
// on these — a pose editor that started from a T-pose would show none of the
// work already shipped — and the export it prints replaces them in the block
// above. Single-state grips come back as one entry with an empty key.
export interface GripPlacement {
  key: string;
  label: string;
  left: ArmPose;
  right: ArmPose;
  tool: THREE.Matrix4 | null;
}
export function gripPlacements(kind: GripKind): GripPlacement[] {
  const grip = GRIPS[kind];
  const one = (key: string, p: GripPose): GripPlacement => ({
    key,
    label: key || kind,
    left: { ...p.left },
    right: { ...p.right },
    tool: p.tool ? p.tool.clone() : null,
  });
  const states = grip.states;
  if (!states) return [one("", grip)];
  return Object.entries(states).map(([key, p]) => one(key, p));
}

// FP body RIGIDLY follows camera (yaw + pitch 1:1). Shoulder cut stays fixed
// in camera space—behind lens at all angles/banks. Reveal job belongs to pose
// (ARM_POSE_FP_DOWN), not body movement, or cut sweeps up as dark wedge.
export const FP_VIEW = { base: 0, follow: 1 };

// The FP pivot's pitch. Callers own the pivot, so they need this before
// updateDiverRig runs.
export function fpBodyPitch(lookPitch: number): number {
  return FP_VIEW.base + lookPitch * FP_VIEW.follow;
}

// Shot-harness tuning hook (shots.js): override the FP pose/offset straight
// from URL params, so arm placement can be swept from the screenshot runner
// without touching code. Mutates the live objects — rigs read them by
// reference every frame.
export interface FpBodyOverrides {
  uy?: number;
  ux?: number;
  fy?: number;
  fx?: number;
  fz?: number;
  hx?: number;
  hy?: number;
  hz?: number;
  ox?: number;
  oy?: number;
  oz?: number;
  sc?: number; // FP_SCALE — how long the arms are relative to the FOV
  pb?: number;
  pf?: number;
  rs?: number; // FP_REVEAL_START — look-down pitch where the hands start in
  // …the same knobs for the LOOK-DOWN pose (`d` prefix)…
  duy?: number;
  dux?: number;
  dfy?: number;
  dfx?: number;
  dfz?: number;
  dhx?: number;
  dhy?: number;
  dhz?: number;
  // …and for the CARRY pose (`c` prefix), so the grip on the Golden Gouda can
  // be swept from the runner exactly like the idle pose.
  cuy?: number;
  cux?: number;
  cfy?: number;
  cfx?: number;
  cfz?: number;
  chx?: number;
  chy?: number;
  chz?: number;
  coy?: number;
  coz?: number;
}
export function configureFpBody(o: FpBodyOverrides = {}) {
  const set = <K extends keyof ArmPose>(
    pose: ArmPose,
    key: K,
    v: number | undefined,
  ) => {
    if (v !== undefined) pose[key] = v;
  };
  const setAll = (pose: ArmPose, p: string) => {
    const src = o as Record<string, number | undefined>;
    for (const k of ["uy", "ux", "fy", "fx", "fz", "hx", "hy", "hz"] as const) {
      set(pose, k, src[p ? p + k : k]);
    }
  };
  setAll(ARM_POSE_FP, "");
  setAll(ARM_POSE_FP_DOWN, "d");
  setAll(ARM_POSE_CARRY_FP, "c");
  if (o.sc !== undefined) FP_SCALE = o.sc;
  if (o.ox !== undefined) FP_OFFSET.x = o.ox;
  if (o.oy !== undefined) FP_OFFSET.y = o.oy;
  if (o.oz !== undefined) FP_OFFSET.z = o.oz;
  if (o.coy !== undefined) FP_OFFSET_CARRY.y = o.coy;
  if (o.coz !== undefined) FP_OFFSET_CARRY.z = o.coz;
  if (o.pb !== undefined) FP_VIEW.base = o.pb;
  if (o.pf !== undefined) FP_VIEW.follow = o.pf;
  if (o.rs !== undefined) FP_REVEAL_START = o.rs;
}

// Only these bones are ever posed (twist helpers excluded = simplified rig).
const ANIMATED = [
  "L_Thigh",
  "R_Thigh",
  "L_Calf",
  "R_Calf",
  "L_Foot",
  "R_Foot",
  "Waist",
  "Spine01",
  "Spine02",
  "NeckTwist01",
  "NeckTwist02",
  "Head",
  "L_Upperarm",
  "R_Upperarm",
  "L_Forearm",
  "R_Forearm",
  "L_Hand",
  "R_Hand",
];

// Parent chain of the head (rig-side), used to solve the head's local
// quaternion from a desired WORLD orientation without touching matrices.
const HEAD_CHAIN = [
  "Root",
  "Hip",
  "Waist",
  "Spine01",
  "Spine02",
  "NeckTwist01",
  "NeckTwist02",
];

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _e1 = new THREE.Euler();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _qa = new THREE.Quaternion();

// Per-bone prep data: rest pose + template-space axes in the bone's local frame.
interface BoneAxes {
  rest: THREE.Quaternion;
  aX: THREE.Vector3;
  aY: THREE.Vector3;
  aZ: THREE.Vector3;
}
type AxisName = "aX" | "aY" | "aZ";

// Shared template prep (see prepareDiverTemplate).
export interface DiverTemplate {
  scene: THREE.Group;
  data: Map<string, BoneAxes>;
  headFix: THREE.Quaternion;
  headRest: THREE.Vector3;
  fpGeometry: { hands: THREE.BufferGeometry };
}

// One rig instance (see createDiverRig).
export interface DiverRig {
  root: THREE.Group;
  model: THREE.Object3D;
  bones: Map<string, THREE.Object3D>;
  data: Map<string, BoneAxes>;
  headFix: THREE.Quaternion;
  /** Head rest position in rig space at unit scale — anchor = this × scale. */
  anchorUnit: THREE.Vector3;
  anchor: THREE.Vector3;
  firstPerson: boolean;
  /** The idle pose for this view and the look-down reveal. */
  armPose: ArmPose;
  downPose: ArmPose;
  /** Last grip asked for — sticky, so releasing eases back out of the same one. */
  carryKind: GripKind;
  /** Scratch the blends land in each frame — never allocated here. */
  poseL: ArmPose;
  poseR: ArmPose;
  poseTmp: ArmPose;
  /** 0 = idle, 1 = carrying. Eased, so a hand-off reads as a movement. */
  carrySm: number;
  /** Named state of a phased grip (see StickPhase): where it is heading… */
  gripPhase: string;
  /** …where it came from, and how far through (0…1, unsmoothed). */
  gripFrom: string;
  gripU: number;
  /** Scratch the phase blend lands in — never allocated per frame. */
  gripPoseL: ArmPose;
  gripPoseR: ArmPose;
  /** Solved lazily by holdAnchor(), one paw node per grip. */
  anchors: Map<GripKind, THREE.Object3D>;
  /** …plus one solved placement per "<grip>:<state>" for phased grips. */
  anchorStates: Map<string, THREE.Object3D>;
  head: THREE.Object3D | null;
  chain: THREE.Object3D[];
  cycle: number;
  speedSm: number;
  leanAdj: number;
  roll: number;
  strafeSm: number;
  headPos: THREE.Vector3;
  headQuat: THREE.Quaternion;
  lookQuat: THREE.Quaternion;
}

// One-time prep on the freshly loaded GLTF. Everything computed here is
// shared by ALL rig instances (local body + every remote diver): per-bone
// rest quaternions and template-space axes mapped into bone-local frames.
export function prepareDiverTemplate(gltf: GLTF): DiverTemplate {
  const scene = gltf.scene;
  // The cel pass belongs to the model, not to whoever mounts it: the diver
  // has three mount sites (local FP body, remote clones, the bench) and one
  // prep, so doing it here is the only version that cannot be forgotten.
  toonify(scene);
  scene.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      obj.castShadow = true;
      obj.frustumCulled = false; // skinned verts move; bounds don't
    }
  });
  scene.updateMatrixWorld(true);

  const data = new Map<string, BoneAxes>();
  const q = new THREE.Quaternion();
  const inv = new THREE.Quaternion();
  for (const name of ANIMATED) {
    const bone = scene.getObjectByName(name);
    if (!bone) continue;
    bone.getWorldQuaternion(q);
    inv.copy(q).invert();
    data.set(name, {
      rest: bone.quaternion.clone(),
      aX: new THREE.Vector3(1, 0, 0).applyQuaternion(inv), // template side
      aY: new THREE.Vector3(0, 1, 0).applyQuaternion(inv), // template up
      aZ: new THREE.Vector3(0, 0, 1).applyQuaternion(inv), // template facing
    });
  }

  // headFix: desiredHeadWorld = qLook * headFix. rotY(π) is "a camera
  // looking at +Z" (the template's facing); the offset from it to the head's
  // rest world orientation makes the sync exact, not just approximate.
  // (the rig is known to have a Head bone — assume it, as the code always has)
  const head = scene.getObjectByName("Head")!;
  const headFix = head.getWorldQuaternion(new THREE.Quaternion());
  headFix.premultiply(
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI).invert(),
  );
  const headRest = head.getWorldPosition(new THREE.Vector3());

  return { scene, data, headFix, headRest, fpGeometry: buildFpGeometry(scene) };
}

// Keep arms (shoulder→fingertip), delete rest. Classic FPS proprioception cheat.
// Arms at frame edge, nothing near lens to clip/slice. Cut at shoulder (was elbow bug).
// Capped (capOpenLoops) so sleeve closes from every angle. One draw call, shared by FP rigs.
const FP_ARM_BONES = /Hand|Forearm|Upperarm/;
// The cut's own colour: the suit's shadowed lining. Near-black reads as a
// HOLE punched in the arm wherever the cap does show; a dark suit tone reads
// as the shoulder of a body you cannot see, which is what it is standing in for.
const FP_CUT_COLOR = 0x6b5a3c;
function buildFpGeometry(scene: THREE.Object3D) {
  let mesh: THREE.SkinnedMesh | undefined;
  scene.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh ??= o as THREE.SkinnedMesh;
  });
  // (a skinned mesh is always present — assume it, as the code always has)
  const geo = mesh!.geometry;
  const sj = geo.attributes.skinIndex;
  const sw = geo.attributes.skinWeight;
  const handSet = new Set<number>();
  mesh!.skeleton.bones.forEach((b, i) => {
    if (FP_ARM_BONES.test(b.name)) handSet.add(i);
  });
  const handW = (i: number) => {
    let w = 0;
    for (let k = 0; k < 4; k++) {
      if (handSet.has(sj.getComponent(i, k))) w += sw.getComponent(i, k);
    }
    return w;
  };
  const index = geo.index!.array;
  const keep: number[] = [];
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t];
    const b = index[t + 1];
    const c = index[t + 2];
    if (handW(a) > 0.5 && handW(b) > 0.5 && handW(c) > 0.5) {
      keep.push(a, b, c);
    }
  }
  const hands = geo.clone();
  hands.setIndex(keep);
  capOpenLoops(hands);
  return { hands };
}

// Cap open loops: delete torso → open arm tubes. Camera sees hollow ring
// (severed sleeve). Fan from ring's CENTROID, not ring vertex (non-planar→long blades).
// WELD verts by position first (export splits on UV seams), so one ring = one loop.
// Every attribute grows by centroid count; position gets centroid coords. Double-sided.
const WELD = 1e4; // position quantum for the weld: 0.1 mm on a 1 u model
function capOpenLoops(geo: THREE.BufferGeometry): void {
  const index = Array.from(geo.index!.array);
  const armTris = index.length; // everything after this is cap (see groups below)
  const pos = geo.attributes.position;

  // Weld: every vertex maps to the first index seen at its position.
  const rep = new Int32Array(pos.count);
  const byPos = new Map<string, number>();
  for (let v = 0; v < pos.count; v++) {
    const k = `${Math.round(pos.getX(v) * WELD)}_${Math.round(pos.getY(v) * WELD)}_${Math.round(pos.getZ(v) * WELD)}`;
    const first = byPos.get(k);
    if (first === undefined) {
      byPos.set(k, v);
      rep[v] = v;
    } else rep[v] = first;
  }

  // Boundary = an edge carried by exactly one triangle, in welded space.
  const edges = new Map<string, number>();
  for (let t = 0; t < index.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = rep[index[t + e]];
      const b = rep[index[t + ((e + 1) % 3)]];
      if (a === b) continue; // degenerate after welding
      edges.set(
        a < b ? `${a}_${b}` : `${b}_${a}`,
        (edges.get(a < b ? `${a}_${b}` : `${b}_${a}`) ?? 0) + 1,
      );
    }
  }
  const link = new Map<number, number[]>();
  for (const [k, count] of edges) {
    if (count !== 1) continue;
    const [a, b] = k.split("_").map(Number);
    (link.get(a) ?? link.set(a, []).get(a)!).push(b);
    (link.get(b) ?? link.set(b, []).get(b)!).push(a);
  }

  // Walk each ring, then fan it from a fresh centroid vertex. Rings shorter
  // than a triangle are noise from a stray unshared edge, not a cut.
  const centroids: { p: THREE.Vector3; src: number }[] = [];
  const seen = new Set<number>();
  for (const start of link.keys()) {
    if (seen.has(start)) continue;
    const loop = [start];
    seen.add(start);
    for (let cur = start; ;) {
      const next = (link.get(cur) ?? []).find((v) => !seen.has(v));
      if (next === undefined) break;
      loop.push(next);
      seen.add(next);
      cur = next;
    }
    if (loop.length < 3) continue;
    const centre = new THREE.Vector3();
    for (const v of loop) centre.add(_v1.fromBufferAttribute(pos, v));
    centre.multiplyScalar(1 / loop.length);
    const c = pos.count + centroids.length;
    centroids.push({ p: centre, src: loop[0] });
    for (let i = 0; i < loop.length; i++) {
      index.push(c, loop[i], loop[(i + 1) % loop.length]);
    }
  }
  if (!centroids.length) {
    geo.clearGroups();
    geo.addGroup(0, armTris, 0); // no cut to cap: one group, one material
    return;
  }

  // Append centroids to all attributes; inherit skinning from ring's bone,
  // then overwrite position with centroid coords.
  for (const name of Object.keys(geo.attributes)) {
    const attr = geo.attributes[name] as THREE.BufferAttribute;
    const size = attr.itemSize;
    const grown = new (attr.array.constructor as Float32ArrayConstructor)(
      (attr.count + centroids.length) * size,
    );
    grown.set(attr.array as ArrayLike<number>);
    centroids.forEach((c, i) => {
      for (let k = 0; k < size; k++) {
        grown[(attr.count + i) * size + k] = attr.array[c.src * size + k];
      }
    });
    const next = new THREE.BufferAttribute(grown, size, attr.normalized);
    if (name === "position") {
      centroids.forEach((c, i) =>
        next.setXYZ(attr.count + i, c.p.x, c.p.y, c.p.z),
      );
    }
    geo.setAttribute(name, next);
  }
  geo.setIndex(index);
  // Two groups: cuts (tail of index) carry own material, avoiding atlas smear
  // through centroid UV (caps were pushed after kept triangles).
  geo.clearGroups();
  geo.addGroup(0, armTris, 0);
  geo.addGroup(armTris, index.length - armTris, 1);
}

// Build one rig instance. Returns { root, ... } — mount `root` under a
// caller-owned yaw group + pitch pivot (the same structure remote players
// already use). firstPerson collapses the neck so the local player's own
// helmet never clips through the camera, and skips the head-look solve.
export function createDiverRig(
  template: DiverTemplate,
  { firstPerson = false }: { firstPerson?: boolean } = {},
): DiverRig {
  const model = SkeletonUtils.clone(template.scene);
  const scale = firstPerson ? FP_SCALE : DIVER_SCALE;
  model.scale.setScalar(scale);
  model.rotation.y = Math.PI; // template faces +Z; game forward is -Z

  const root = new THREE.Group(); // carries lean/roll + the eye anchor
  root.add(model);

  const bones = new Map<string, THREE.Object3D>();
  model.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) bones.set(obj.name, obj);
  });

  if (firstPerson) {
    // FP renders arms only; invisible torso bones pose them. Placement via
    // ARM_POSE_FP; they keep subtle swim drift.
    let fpMesh: THREE.SkinnedMesh | null = null;
    model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh)
        fpMesh ??= o as THREE.SkinnedMesh;
    });
    // (skinned mesh always present — same assumption as buildFpGeometry)
    const skin = fpMesh!;
    // Group 1 = shoulder cut (capOpenLoops): own material to avoid atlas smear
    // from borrowed UV. Off-screen normally; visible on hard banks.
    const skinMat = skin.material;
    skin.geometry = template.fpGeometry.hands;
    skin.material = [
      Array.isArray(skinMat) ? skinMat[0] : skinMat,
      toonMaterial({ color: FP_CUT_COLOR, side: THREE.DoubleSide }),
    ];
    skin.castShadow = false; // two floating arms cast a nonsense shadow
  }

  // Head rest position, template space → rig space (rotY(π) flips x/z). Kept
  // at unit scale as well, because a first-person rig rescales itself while
  // carrying and the anchor has to follow or the head slides off the camera.
  const anchorUnit = new THREE.Vector3(
    -template.headRest.x,
    template.headRest.y,
    -template.headRest.z,
  );
  const anchor = anchorUnit.clone().multiplyScalar(scale);

  const rig: DiverRig = {
    root,
    model,
    bones,
    data: template.data,
    headFix: template.headFix,
    anchorUnit,
    anchor,
    firstPerson,
    armPose: firstPerson ? ARM_POSE_FP : ARM_POSE_THIRD,
    // Third person has no reveal to do — its "look down" pose IS its pose,
    // so the blend below is a no-op there rather than a special case.
    downPose: firstPerson ? ARM_POSE_FP_DOWN : ARM_POSE_THIRD,
    carryKind: "gouda",
    poseL: { uy: 0, ux: 0, fy: 0, fx: 0, fz: 0, hx: 0, hy: 0, hz: 0 },
    poseR: { uy: 0, ux: 0, fy: 0, fx: 0, fz: 0, hx: 0, hy: 0, hz: 0 },
    poseTmp: { uy: 0, ux: 0, fy: 0, fx: 0, fz: 0, hx: 0, hy: 0, hz: 0 },
    carrySm: 0,
    gripPhase: "",
    gripFrom: "",
    gripU: 1,
    gripPoseL: { uy: 0, ux: 0, fy: 0, fx: 0, fz: 0, hx: 0, hy: 0, hz: 0 },
    gripPoseR: { uy: 0, ux: 0, fy: 0, fx: 0, fz: 0, hx: 0, hy: 0, hz: 0 },
    anchors: new Map(),
    anchorStates: new Map(),
    head: bones.get("Head") ?? null,
    chain: HEAD_CHAIN.map((n) => bones.get(n)).filter(
      Boolean,
    ) as THREE.Object3D[],
    // Per-instance smoothed state (all cached, zero per-frame allocation).
    cycle: Math.random() * 10, // desync swim cycles between divers
    speedSm: 0,
    leanAdj: 0,
    roll: 0,
    strafeSm: 0,
    // Outputs (world space) — the helmet torch + glow follow these.
    headPos: new THREE.Vector3(),
    headQuat: new THREE.Quaternion(),
    lookQuat: new THREE.Quaternion(),
  };
  applyRootPose(rig);
  return rig;
}

// Lean/roll (+ a slow idle water-sway) on the wrapper group, then re-pin the
// head onto the rig origin (the anchor is rotated by the same pose, so the
// head never drifts off the camera/broadcast position however the body
// swings beneath it). First-person bodies also get the FP_OFFSET cheat.
function applyRootPose(rig: DiverRig, swayX = 0, swayZ = 0) {
  if (rig.firstPerson) {
    // Re-read FP_SCALE (live tuning knob), then blend toward the grip's own
    // arm length. Anchor derives from it; head stays pinned to camera.
    const grip = GRIPS[rig.carryKind];
    const scale =
      FP_SCALE + ((grip.fpScale || FP_SCALE) - FP_SCALE) * rig.carrySm;
    rig.model.scale.setScalar(scale);
    rig.anchor.copy(rig.anchorUnit).multiplyScalar(scale);
  }
  rig.root.rotation.set(
    -(rig.firstPerson ? FP_LEAN : LEAN) + rig.leanAdj + swayX,
    0,
    rig.roll + swayZ,
  );
  rig.root.position.copy(rig.anchor).applyEuler(rig.root.rotation).negate();
  if (rig.firstPerson) {
    rig.root.position.add(
      _v3.lerpVectors(FP_OFFSET, GRIPS[rig.carryKind].fpOffset, rig.carrySm),
    );
  }
}

// How fast the carry blend closes (1/s). Fast enough that pressing E feels
// like the hands answering, slow enough that it is a movement and not a cut.
const CARRY_EASE = 5;

// Blend two arm poses into `out` (a per-rig scratch, never allocated here).
// Exported as blendArmPose: the bench's pose editor plays its states through
// the very same blend, so a preview there is the animation that ships.
function blendPose(a: ArmPose, b: ArmPose, k: number, out: ArmPose): ArmPose {
  out.uy = a.uy + (b.uy - a.uy) * k;
  out.ux = a.ux + (b.ux - a.ux) * k;
  out.fy = a.fy + (b.fy - a.fy) * k;
  out.fx = a.fx + (b.fx - a.fx) * k;
  out.fz = a.fz + (b.fz - a.fz) * k;
  out.hx = a.hx + (b.hx - a.hx) * k;
  out.hy = a.hy + (b.hy - a.hy) * k;
  out.hz = a.hz + (b.hz - a.hz) * k;
  return out;
}

// Absolute pose: rest ∘ rotation about a template axis. Never accumulates.
function pose(rig: DiverRig, name: string, axis: AxisName, angle: number) {
  const b = rig.bones.get(name);
  const d = rig.data.get(name);
  if (!b || !d) return;
  b.quaternion.copy(d.rest).multiply(_qa.setFromAxisAngle(d[axis], angle));
}

// Compose a second axis on top of the pose() set this frame.
function poseAdd(rig: DiverRig, name: string, axis: AxisName, angle: number) {
  const b = rig.bones.get(name);
  const d = rig.data.get(name);
  if (!b || !d) return;
  b.quaternion.multiply(_qa.setFromAxisAngle(d[axis], angle));
}

// This frame's grip poses, for grips with named states: advance the phase
// machine, blend the two states either side of it, and slide the prop's paw
// anchor the same way — so a held prop is always exactly where the arms that
// hold it put it. Single-state grips return their authored pair unchanged.
function gripPoses(
  rig: DiverRig,
  grip: Grip,
  phase: string | undefined,
  dt: number,
): [ArmPose, ArmPose] {
  const fp = rig.firstPerson;
  const states = grip.states;
  if (!states) return [fp ? grip.fpLeft : grip.left, fp ? grip.fpRight : grip.right]; // prettier-ignore
  const want = (phase && states[phase] ? phase : grip.base) ?? "";
  if (want !== rig.gripPhase) {
    rig.gripFrom = rig.gripPhase || want;
    rig.gripPhase = want;
    rig.gripU = 0;
  }
  rig.gripU = Math.min(
    1,
    rig.gripU + dt * (PHASE_EASE[rig.gripPhase] ?? PHASE_EASE_DEFAULT),
  );
  const to = states[rig.gripPhase] ?? grip;
  const from = states[rig.gripFrom] ?? to;
  const u = rig.gripU;
  const k = u * u * (3 - 2 * u); // smoothstep: no corner at either end
  const a = rig.anchorStates.get(`${rig.carryKind}:${rig.gripFrom}`);
  const b = rig.anchorStates.get(`${rig.carryKind}:${rig.gripPhase}`);
  const live = rig.anchors.get(rig.carryKind);
  if (live && a && b) {
    live.position.lerpVectors(a.position, b.position, k);
    live.quaternion.slerpQuaternions(a.quaternion, b.quaternion, k);
    live.scale.lerpVectors(a.scale, b.scale, k);
  }
  return [
    blendPose(fp ? from.fpLeft : from.left, fp ? to.fpLeft : to.left, k, rig.gripPoseL), // prettier-ignore
    blendPose(fp ? from.fpRight : from.right, fp ? to.fpRight : to.right, k, rig.gripPoseR), // prettier-ignore
  ];
}

// Per-frame procedural swim. Caller has already set its yaw group /
// pitch pivot; bodyYaw/bodyPitch must mirror those values.
//  - vel drives effort (kick rate/amplitude) AND direction adaptation:
//    the body noses toward where it's actually travelling and banks into
//    strafes, so the animation reads correctly swimming in any direction.
//  - lookYaw/lookPitch aim the head (and thus the helmet torch) exactly.
export function updateDiverRig(
  rig: DiverRig,
  dt: number,
  {
    bodyYaw,
    bodyPitch,
    lookYaw,
    lookPitch,
    vel,
    carry = "none",
    carryPhase,
  }: {
    bodyYaw: number;
    bodyPitch: number;
    lookYaw: number;
    lookPitch: number;
    vel: { x: number; y: number; z: number };
    // What's in the paws: hold that grip, stop stroking. Driven by the local
    // carry systems and, for remotes, by the replicated status mask.
    carry?: CarryKind;
    // Which named state of that grip (see StickPhase) — ignored by grips
    // that only have one. Unset rests in the grip's `base`.
    carryPhase?: string;
  },
) {
  // --- Carry blend --------------------------------------------------------
  // Eased first, because applyRootPose (below) reads it: the FP body slides
  // toward its grip offset over the same ~0.2 s the arms take to close.
  if (carry !== "none") rig.carryKind = carry;
  const grip = GRIPS[rig.carryKind];
  rig.carrySm +=
    ((carry === "none" ? 0 : 1) - rig.carrySm) * Math.min(1, dt * CARRY_EASE);
  // Level pose → look-down reveal → grip, in that order. The reveal is
  // driven straight off the look (no easing: it IS the look, and the camera
  // is already smoothed), the grip off the carry ease. Grips are per-side:
  // a tool is held asymmetrically, a wheel is hugged.
  const down = Math.min(
    1,
    Math.max(
      0,
      (-lookPitch - FP_REVEAL_START) / (FP_LOOK_DOWN - FP_REVEAL_START),
    ),
  );
  blendPose(rig.armPose, rig.downPose, down, rig.poseTmp);
  const [gripL, gripR] = gripPoses(rig, grip, carryPhase, dt);
  blendPose(rig.poseTmp, gripL, rig.carrySm, rig.poseL);
  blendPose(rig.poseTmp, gripR, rig.carrySm, rig.poseR);

  // --- Movement analysis --------------------------------------------------
  _q1.setFromEuler(_e1.set(bodyPitch, bodyYaw, 0, "YXZ")); // body world quat
  _v1.set(vel.x, vel.y, vel.z);
  const speed = _v1.length();
  rig.speedSm +=
    (Math.min(1, speed / REF_SPEED) - rig.speedSm) * Math.min(1, dt * 4);
  const effort = rig.speedSm;

  let leanTarget = 0;
  let rollTarget = 0;
  let strafeTarget = 0;
  if (speed > 0.25) {
    _v2.copy(_v1).applyQuaternion(_q2.copy(_q1).invert()); // body-local dir
    const strafe = _v2.x / speed;
    const travelPitch = Math.asin(Math.max(-1, Math.min(1, _v1.y / speed)));
    const w = Math.min(1, speed / 3);
    // Nose toward the actual travel direction (residual vs body pitch).
    // Heavily damped in first person: big body rotations while swimming
    // up/down would sweep the arm shells across the camera.
    const fp = rig.firstPerson ? 0.3 : 1;
    leanTarget =
      Math.max(-0.6, Math.min(0.6, travelPitch - bodyPitch)) * w * fp;
    // Bank into strafes, like the camera does.
    rollTarget = -strafe * 0.35 * w * fp;
    strafeTarget = strafe * w;
  }
  // Slow easing — direction changes (especially strafes) read as the body
  // lazily rolling through the water, never snapping.
  rig.leanAdj += (leanTarget - rig.leanAdj) * Math.min(1, dt * 1.5);
  rig.roll += (rollTarget - rig.roll) * Math.min(1, dt * 1.5);
  rig.strafeSm += (strafeTarget - rig.strafeSm) * Math.min(1, dt * 2);

  // --- Swim cycle: rate and amplitude scale hard with effort ---------------
  // Idle is a languid ~0.25 Hz wallow; full sprint kicks ~1.8 Hz — the
  // contrast between resting and swimming reads immediately.
  rig.cycle += dt * (1.6 + 9.5 * effort);
  const c = rig.cycle;
  const s = Math.sin;
  const kick = 0.15 + 0.75 * effort;

  // Idle sway: slow wallow fading with speed. Damped in FP (prevents hand bob).
  const sway = (1 - 0.6 * effort) * (rig.firstPerson ? 0.12 : 1);
  applyRootPose(
    rig,
    0.05 * s(c * 0.33 + 1.2) * sway,
    0.06 * s(c * 0.41) * sway,
  );

  // Legs and spine drive nothing visible in first person (only gloves +
  // forearms render there) — skip their posing entirely, it's pure waste.
  if (!rig.firstPerson) {
    // Flutter kick: thighs anti-phase, knees lag, feet trail like fins.
    pose(rig, "L_Thigh", "aX", kick * s(c));
    pose(rig, "R_Thigh", "aX", kick * s(c + Math.PI));
    const knee = 0.2 + 0.35 * effort;
    pose(rig, "L_Calf", "aX", knee + kick * 0.7 * s(c - 0.9));
    pose(rig, "R_Calf", "aX", knee + kick * 0.7 * s(c - 0.9 + Math.PI));
    pose(rig, "L_Foot", "aX", 0.55 - kick * 0.5 * s(c - 1.3));
    pose(rig, "R_Foot", "aX", 0.55 - kick * 0.5 * s(c - 1.3 + Math.PI));

    // Undulation rippling up the spine — grows strongly with speed so the
    // whole body works while sprinting.
    const und = 0.04 + 0.12 * effort;
    pose(rig, "Waist", "aX", und * s(c * 0.5));
    pose(rig, "Spine01", "aX", und * s(c * 0.5 - 0.6));
    pose(rig, "Spine02", "aX", und * 0.8 * s(c * 0.5 - 1.2));
  }

  // Arms: held forward, stroking breaststroke at half kick rate. Always moving (tread).
  // FP: nearly static (faint drift, stable anchor for future tools).
  // Carrying: barely move (settle against load keeps pose from freezing).
  const free = 1 - 0.92 * rig.carrySm;
  const arm = (0.25 + 0.85 * effort) * (rig.firstPerson ? 0.06 : 1) * free;
  const sw = s(c * 0.5);
  const sw2 = s(c * 0.5 - 0.9);
  const apL = rig.poseL; // idle pose blended toward this side's grip (above)
  const apR = rig.poseR;
  // Strafing: both arms sweep toward the travel side — the diver visibly
  // pulls itself sideways with its arms (third person only, and not with its
  // hands full).
  const sOff = rig.firstPerson ? 0 : rig.strafeSm * 0.5 * free;
  pose(rig, "L_Upperarm", "aY", -apL.uy + arm * 0.7 * sw + sOff);
  poseAdd(rig, "L_Upperarm", "aX", apL.ux + arm * 0.4 * sw2);
  pose(rig, "R_Upperarm", "aY", apR.uy - arm * 0.7 * sw + sOff);
  poseAdd(rig, "R_Upperarm", "aX", apR.ux + arm * 0.4 * sw2);
  pose(
    rig,
    "L_Forearm",
    "aY",
    -apL.fy - arm * 0.6 * Math.max(0, sw2) + sOff * 0.6,
  );
  poseAdd(rig, "L_Forearm", "aX", apL.fx);
  poseAdd(rig, "L_Forearm", "aZ", -apL.fz);
  pose(
    rig,
    "R_Forearm",
    "aY",
    apR.fy + arm * 0.6 * Math.max(0, sw2) + sOff * 0.6,
  );
  poseAdd(rig, "R_Forearm", "aX", apR.fx);
  poseAdd(rig, "R_Forearm", "aZ", apR.fz);
  const handWiggle = (rig.firstPerson ? 0.04 : 0.16) * free;
  // Three axes (mirrored L/R like uy/fy): hx (wrist bend), hy (palms inward—
  // read as holding vs. flat), hz (palm roll + forearm pronation). Without hz
  // paws meet wheel back-first, fingers splayed. Zero for flat hand, all three
  // for grip.
  pose(rig, "L_Hand", "aX", apL.hx + handWiggle * sw);
  poseAdd(rig, "L_Hand", "aY", -apL.hy);
  poseAdd(rig, "L_Hand", "aZ", -apL.hz);
  pose(rig, "R_Hand", "aX", apR.hx + handWiggle * sw);
  poseAdd(rig, "R_Hand", "aY", apR.hy);
  poseAdd(rig, "R_Hand", "aZ", apR.hz);

  // First person: the head is collapsed/invisible and the local torch is
  // camera-mounted — skip the whole look solve.
  if (rig.firstPerson) return;

  // --- Head look: EXACT camera sync (the helmet torch mounts here) --------
  // Head turns on shoulders toward true look (body may face elsewhere).
  // Relative yaw clamped to prevent owl-crane. Neck absorbs soft share;
  // head bone solved exactly so torch beam leaves on clamped look direction.
  let relYaw = Math.atan2(
    Math.sin(lookYaw - bodyYaw),
    Math.cos(lookYaw - bodyYaw),
  );
  relYaw = Math.max(-1.2, Math.min(1.2, relYaw));
  const yawEff = bodyYaw + relYaw;
  const diff = lookPitch - bodyPitch + LEAN * 0.85 - rig.leanAdj;
  const neck = -Math.max(-0.7, Math.min(0.7, diff * 0.3));
  const neckYaw = relYaw * 0.28;
  pose(rig, "NeckTwist01", "aX", neck);
  poseAdd(rig, "NeckTwist01", "aY", neckYaw);
  pose(rig, "NeckTwist02", "aX", neck);
  poseAdd(rig, "NeckTwist02", "aY", neckYaw);

  rig.lookQuat.setFromEuler(_e1.set(lookPitch, yawEff, 0, "YXZ"));
  rig.headQuat.copy(rig.lookQuat).multiply(rig.headFix);

  if (rig.head) {
    // Accumulate head's parent world quat via products (no matrix updates,
    // unit/uniform scales = exact quaternion math).
    _q3.copy(_q1).multiply(rig.root.quaternion).multiply(rig.model.quaternion);
    for (const b of rig.chain) _q3.multiply(b.quaternion);
    rig.head.quaternion.copy(_q3.invert()).multiply(rig.headQuat);
    rig.head.getWorldPosition(rig.headPos);
  }
}

// Set the arm bones directly from explicit L/R poses — same mirrored
// convention updateDiverRig's arm section uses (L negates uy/fy/hy/fz/hz
// relative to R) but with no swim oscillation on top and each side free to
// differ. Bone state from updateDiverRig is overwritten synchronously —
// callers that want a locked custom pose must call this AFTER
// updateDiverRig, not instead of mutating rig.pose (which updateDiverRig
// already consumed by the time it returns). This is also the primitive a
// pose editor exports: an ArmPose authored here is exactly what a new
// ARM_POSE_* constant would hold.
export function applyArmPoseSides(
  rig: DiverRig,
  left: ArmPose,
  right: ArmPose,
): void {
  pose(rig, "L_Upperarm", "aY", -left.uy);
  poseAdd(rig, "L_Upperarm", "aX", left.ux);
  pose(rig, "R_Upperarm", "aY", right.uy);
  poseAdd(rig, "R_Upperarm", "aX", right.ux);
  pose(rig, "L_Forearm", "aY", -left.fy);
  poseAdd(rig, "L_Forearm", "aX", left.fx);
  poseAdd(rig, "L_Forearm", "aZ", -left.fz);
  pose(rig, "R_Forearm", "aY", right.fy);
  poseAdd(rig, "R_Forearm", "aX", right.fx);
  poseAdd(rig, "R_Forearm", "aZ", right.fz);
  pose(rig, "L_Hand", "aX", left.hx);
  poseAdd(rig, "L_Hand", "aY", -left.hy);
  poseAdd(rig, "L_Hand", "aZ", -left.hz);
  pose(rig, "R_Hand", "aX", right.hx);
  poseAdd(rig, "R_Hand", "aY", right.hy);
  poseAdd(rig, "R_Hand", "aZ", right.hz);
}

export { blendPose as blendArmPose };

// Symmetric case: both arms mirror the same authored pose.
export function applyArmPose(rig: DiverRig, p: ArmPose): void {
  applyArmPoseSides(rig, p, p);
}

const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _restSave: THREE.Quaternion[] = [];

// Put every bone BETWEEN the right paw and the model back on its rest
// rotation — the clavicle, the spine, the waist, the arm twists. A held
// prop's placement is authored in the rig-root frame, so the solve below
// reads `root⁻¹ · hand`: with a breathing, swimming torso in between, that
// matrix is different every frame and the same authored numbers land the prop
// somewhere else depending on WHEN it was solved (~0.03 u of wander at idle,
// more mid-stroke — enough to sink a light stick into the palm it was posed
// on). Freezing the chain makes the solve a pure function of the pose.
// Returns how many bones were parked, so restoreHandChain can put them back.
function restHandChain(rig: DiverRig): number {
  let n = 0;
  for (
    let b: THREE.Object3D | null = rig.bones.get("R_Hand") ?? null;
    b && b !== rig.model;
    b = b.parent
  ) {
    const rest = rig.data.get(b.name)?.rest;
    if (!rest) continue;
    (_restSave[n++] ??= new THREE.Quaternion()).copy(b.quaternion);
    b.quaternion.copy(rest);
  }
  return n;
}

function restoreHandChain(rig: DiverRig, n: number): void {
  let i = 0;
  for (
    let b: THREE.Object3D | null = rig.bones.get("R_Hand") ?? null;
    b && b !== rig.model;
    b = b.parent
  ) {
    if (!rig.data.get(b.name)?.rest) continue;
    if (i < n) b.quaternion.copy(_restSave[i++]);
  }
}

// The pose bench's half of the same deal: the editor draws the prop at its
// authored rig-root placement, so the body it draws it against has to be the
// one solveHeldAnchor reads, or what you drag is not what ships.
export function freezeHandChain(rig: DiverRig): void {
  restHandChain(rig);
}

// Solve where a prop sits in the RIGHT HAND bone's frame, given the arm pose
// it was authored with and its placement in the rig-root frame:
//   anchorLocal = boneChain⁻¹ · modelMatrix⁻¹ · tool
// measured at DIVER_SCALE whatever the rig's own scale is — so a first-person
// body (scaled up so the arms read) carries a proportionally scaled prop.
// Solved against a FROZEN torso (see restHandChain) and restored afterwards,
// so the answer is the authored pose and nothing else. Exported because the
// bench pose editor solves the same thing for poses that are still being
// dragged around and have no constant yet.
export function solveHeldAnchor(
  rig: DiverRig,
  left: ArmPose,
  right: ArmPose,
  tool: THREE.Matrix4,
  out: THREE.Object3D,
): boolean {
  const hand = rig.bones.get("R_Hand");
  if (!hand) return false;
  const parked = restHandChain(rig);
  applyArmPoseSides(rig, left, right);
  rig.root.updateMatrixWorld(true);
  _m1.copy(rig.model.matrixWorld).invert().multiply(hand.matrixWorld);
  _m2.makeRotationY(-Math.PI).multiply(tool); // model node's own flip
  const inv = 1 / DIVER_SCALE;
  _m2.premultiply(_m3.makeScale(inv, inv, inv));
  _m2.premultiply(_m1.invert());
  _m2.decompose(out.position, out.quaternion, out.scale);
  restoreHandChain(rig, parked);
  rig.root.updateMatrixWorld(true);
  return true;
}

// The node a held prop hangs from: a child of the right hand BONE, so the
// prop inherits the paw's every stroke, sway and lean for free instead of
// being re-placed from the diver's position each frame. Solved once per rig
// from the grip's authored placement (see solveHeldAnchor) — and once more
// per named state for a phased grip, which updateDiverRig then slides the
// live node between. Returns null for grips whose prop is placed by
// game/cargo.ts instead.
export function holdAnchor(
  rig: DiverRig,
  kind: GripKind,
): THREE.Object3D | null {
  const cached = rig.anchors.get(kind);
  if (cached) return cached;
  const grip = GRIPS[kind];
  const rest = grip.states?.[grip.base ?? ""] ?? grip;
  if (!rest.tool || !rig.bones.get("R_Hand")) return null;

  const anchor = new THREE.Object3D();
  if (!solveHeldAnchor(rig, rest.left, rest.right, rest.tool, anchor)) {
    return null;
  }
  rig.bones.get("R_Hand")!.add(anchor);
  rig.anchors.set(kind, anchor);

  for (const [name, st] of Object.entries(grip.states ?? {})) {
    if (!st.tool) continue;
    const solved = new THREE.Object3D();
    if (solveHeldAnchor(rig, st.left, st.right, st.tool, solved)) {
      rig.anchorStates.set(`${kind}:${name}`, solved);
    }
  }
  return anchor;
}
