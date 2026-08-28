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
// The FIRST-PERSON body renders smaller than reality: at true scale the
// arms loom huge and wide across the whole view when looking down (a
// wide-FOV camera sitting right at the shoulders). A reduced visual scale
// keeps them readable as "my arms" without dominating the frame.
let FP_SCALE = 2.24;
const LEAN = 1.0; // prone swimming lean (rad) — body pitches under the head
// …but the FIRST-PERSON body barely leans at all. The prone lean is a
// third-person read (a swimmer seen from outside); applied to the FP body it
// swings the shoulders up and BEHIND the head, so the arms have to reach up
// and over to get in frame and the elbows fold backwards. That is the broken
// shoulder angle you see looking down. Nearly upright, the shoulders sit
// where a shoulder sits — below the eye and a little behind it — and the arms
// simply hang forward.
const FP_LEAN = 0.22;
const REF_SPEED = 10; // world speed that maps to a full-effort kick

// First-person body cheat: the (invisible) body sits below the true eye
// anchor and slightly BEHIND it. Behind is the important half — see
// FP_VIEW: the FP body is rigidly locked to the camera, so a shoulder placed
// behind the lens is behind it at every look angle, forever, and the one cut
// in the FP geometry can never be in frame.
const FP_OFFSET = new THREE.Vector3(0, -0.16, 0.1);

// Base arm poses (template-space angles), numerically solved per view.
interface ArmPose {
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
// FP pose, LEVEL VIEW: the arms hang forward and down from shoulders that sit
// just behind the lens, and only the backs of the gloves graze the bottom
// edge of the frame. Solved numerically (see the bench's `gloves` entry,
// which reads the hand and shoulder positions back in camera space).
// (fx/hx sit lower than the old graze so the idle water-sway and the swim
// drift can never bob a knuckle up into the frame: hidden means hidden.)
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
// …and LOOKING DOWN. The FP body is rigidly locked to the camera (FP_VIEW),
// which is what keeps the shoulder cut out of frame at every angle — but it
// also means that on its own you would see exactly the same sliver of glove
// however far you looked down. So the REVEAL is done in the pose instead:
// the arms draw in and up as you tip your head, blended by how far down you
// are looking, and what comes into frame is forearm and paw — never the whole
// arm, and never the shoulder. This is also what a swimmer looking at their
// own chest actually does with their arms.
// The reveal lands the paws in the lower third, angled IN toward each other
// (hy) — not parked in the corners. Two hands already turned toward a point
// between them is the neutral "ready to hold" shape, which is what lets a
// future held item sit at the natural spot without a new pose per item.
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

// CARRYING THE GOLDEN GOUDA. Both views get their own pose, and the rig
// cross-fades into it over ~0.2 s (rig.carrySm) so a hand-off is a movement,
// not a cut. The swim stroke is damped away at the same time: a diver with a
// wheel of cheese in both arms does not also do the breaststroke.
//
// The target is the wheel itself — game/cargo.ts's holdPose puts its centre
// CARGO.HOLD_FORWARD ahead and CARGO.HOLD_DOWN below the eye, with a radius
// of GOUDA_RADIUS. These poses are solved to put the paws on its FLANKS, not
// on the face nearest the camera: hands on the near face read as pushing a
// boulder, hands on the sides read as carrying. Retune them together — move
// the wheel or resize it and the hands stop touching it.
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
// The FP body is shoved FORWARD and DOWN while carrying, so the shoulders sit
// inside the wheel's upper crust and the arms come out of its flanks. This is
// the one moment the cut is in front of the lens — and it is buried in half a
// metre of cheese, which is exactly why it is allowed to be.
const FP_OFFSET_CARRY = new THREE.Vector3(0, -0.19, -0.21);

// FP hands are SCREEN-ANCHORED, FPS-style, and RIGIDLY so: the invisible body
// takes the camera's yaw and its pitch, one for one. That is not a stylistic
// choice, it is the whole safety property — the shoulder (and the only cut in
// the FP geometry) keeps one fixed spot in camera space, so once it is behind
// the lens it is behind the lens at every look angle, in every bank, forever.
// A follow of less than 1 lets the camera swing relative to the body, and the
// cut sweeps up into frame as a dark wedge on a hard look-down. That was the
// bug. The "you see more of your arms when you look down" job belongs to the
// pose (ARM_POSE_FP_DOWN), which can do it without moving the shoulder.
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
  /** The idle pose for this view, the look-down reveal, and the carry grip. */
  armPose: ArmPose;
  downPose: ArmPose;
  carryPose: ArmPose;
  /** Scratch the three are blended into each frame — never allocated here. */
  pose: ArmPose;
  poseTmp: ArmPose;
  /** 0 = idle, 1 = carrying. Eased, so a hand-off reads as a movement. */
  carrySm: number;
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

// First-person geometry: the two ARMS survive — shoulder to fingertip —
// and everything else (torso, head, legs) is deleted at prep time. Rendering
// a connected body from a camera parked at the head reads as "floating
// behind a mannequin"; arms riding the bottom of the frame is the classic
// FPS proprioception cheat, and there is nothing near the lens to clip,
// slice, or see through.
//
// The cut used to be at the ELBOW, and that was the bug: looking down showed
// two short sleeves ending in mid-water with their hollow interiors facing
// the camera (the FP material is double-sided). An arm has to come from
// somewhere. Keeping the upper arm moves the only cut up to the SHOULDER,
// which the FP body offset parks behind and below the lens — so the arms
// read as attached to a body you cannot see, and the cut is never in frame.
//
// A triangle survives if all three verts are majority-weighted to an arm
// bone; the shoulder cut is then capped (capOpenLoops) so the sleeve is a
// closed object from every angle — a glance up the arm while banking hard
// must not look into a hollow tube. This is also the cheap way to do it: one
// draw call on a reduced index buffer, so the GPU only skins/shades the
// verts that are actually visible. Built once, shared by FP rigs.
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

// Deleting the torso leaves the arms as OPEN TUBES — and in first person the
// camera sits just above and behind the shoulder cut, so a hollow ring there
// reads as a severed sleeve (the FP material is double-sided: you see the
// inside wall). Cap every boundary loop so the cut is solid shoulder mass.
//
// A triangle FAN from one loop vertex is not enough, and this is where the
// naive version failed: the cut ring is not convex and not planar, so a fan
// anchored on one of its own vertices throws long blades across the arm. Cap
// from the loop's CENTROID instead — a new vertex, appended to every
// attribute — so every triangle stays inside the ring.
//
// The ring also has to be found on WELDED positions. The export splits verts
// along UV seams, so by raw index a single cut ring is several disconnected
// arcs, each capped separately and none of them closed. Welding by quantized
// position merges the duplicates (and, as a bonus, makes seam edges count 2
// so they are correctly not boundary).
//
// Winding doesn't matter: the FP material is double-sided.
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

  // Append the centroids. Every attribute grows by the same count; the new
  // vertex inherits its ring's skinning (a cut ring sits inside one bone's
  // territory by construction — that is how the triangles were selected),
  // and position is overwritten with the centroid afterwards.
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
  // Two groups, so the cut can carry its own material. The caps are the tail
  // of the index buffer by construction (they were pushed after the kept
  // triangles), which is exactly the contiguous range a group needs. Without
  // this the cut inherits the suit texture through a centroid UV borrowed
  // from one ring vertex, and smears the atlas into stripes across the hole.
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
    // FP renders ONLY the two arms (see buildFpGeometry) — the invisible
    // torso bones still pose them, so placement is tuned via ARM_POSE_FP and
    // they keep the subtle swim drift.
    let fpMesh: THREE.SkinnedMesh | null = null;
    model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh)
        fpMesh ??= o as THREE.SkinnedMesh;
    });
    // (skinned mesh always present — same assumption as buildFpGeometry)
    const skin = fpMesh!;
    // Group 1 is the shoulder cut (capOpenLoops). It gets its own material —
    // flat, dark, untextured suit lining — because the cap vertices carry a
    // borrowed UV and would otherwise smear the atlas across the hole. It is
    // meant to be off screen at every look angle; this is what it looks like
    // in the frame or two where a hard bank swings it past the lens.
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
    carryPose: firstPerson ? ARM_POSE_CARRY_FP : ARM_POSE_CARRY_THIRD,
    pose: { uy: 0, ux: 0, fy: 0, fx: 0, fz: 0, hx: 0, hy: 0, hz: 0 },
    poseTmp: { uy: 0, ux: 0, fy: 0, fx: 0, fz: 0, hx: 0, hy: 0, hz: 0 },
    carrySm: 0,
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
    // Re-read every frame: FP_SCALE is a live tuning knob (configureFpBody),
    // and the anchor is derived from it — the head has to stay pinned to the
    // camera whatever the arms are scaled to. The arms are the SAME LENGTH
    // carrying as not: an arm that grows on pickup pops, and once the body
    // itself slides forward to meet the load there is nothing left for a
    // scale change to buy.
    rig.model.scale.setScalar(FP_SCALE);
    rig.anchor.copy(rig.anchorUnit).multiplyScalar(FP_SCALE);
  }
  rig.root.rotation.set(
    -(rig.firstPerson ? FP_LEAN : LEAN) + rig.leanAdj + swayX,
    0,
    rig.roll + swayZ,
  );
  rig.root.position.copy(rig.anchor).applyEuler(rig.root.rotation).negate();
  if (rig.firstPerson) {
    rig.root.position.add(
      _v3.lerpVectors(FP_OFFSET, FP_OFFSET_CARRY, rig.carrySm),
    );
  }
}

// How fast the carry blend closes (1/s). Fast enough that pressing E feels
// like the hands answering, slow enough that it is a movement and not a cut.
const CARRY_EASE = 5;

// Blend two arm poses into `out` (a per-rig scratch, never allocated here).
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
    carrying = false,
  }: {
    bodyYaw: number;
    bodyPitch: number;
    lookYaw: number;
    lookPitch: number;
    vel: { x: number; y: number; z: number };
    // Both arms are around the Golden Gouda: hold the carry pose and stop
    // stroking. True for the local carrier and for every remote diver whose
    // replicated status carries STATUS.CARRYING, so what you see someone
    // holding is where the wheel actually is.
    carrying?: boolean;
  },
) {
  // --- Carry blend --------------------------------------------------------
  // Eased first, because applyRootPose (below) reads it: the FP body slides
  // forward toward the wheel over the same ~0.2 s the arms take to close.
  rig.carrySm +=
    ((carrying ? 1 : 0) - rig.carrySm) * Math.min(1, dt * CARRY_EASE);
  // Level pose → look-down reveal → carry grip, in that order. The reveal is
  // driven straight off the look (no easing: it IS the look, and the camera
  // is already smoothed), the grip off the carry ease.
  const down = Math.min(
    1,
    Math.max(0, (-lookPitch - FP_REVEAL_START) / (FP_LOOK_DOWN - FP_REVEAL_START)),
  );
  blendPose(rig.armPose, rig.downPose, down, rig.poseTmp);
  blendPose(rig.poseTmp, rig.carryPose, rig.carrySm, rig.pose);

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

  // Idle water-sway: the body never sits dead still — a slow two-axis
  // wallow that fades as real swimming takes over. Mostly damped in first
  // person: it would translate straight into hands bobbing on screen.
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

  // Arms: held forward (this is what the local player sees looking down),
  // stroking breaststroke-style at half the kick rate. Never fully still:
  // even at idle they slowly tread the water.
  // First person keeps the arms NEARLY STATIC — just a faint drift so they
  // feel alive. They're a stable anchor (think: future tools, a wrist
  // watch), not an animation showcase; the full strokes are for the
  // third-person view only.
  // …and while carrying they barely move at all: a diver hugging a wheel of
  // cheese is not also swimming with its arms. What is left is a slow settle
  // against the load, which is what keeps the pose from looking frozen.
  const free = 1 - 0.92 * rig.carrySm;
  const arm = (0.25 + 0.85 * effort) * (rig.firstPerson ? 0.06 : 1) * free;
  const sw = s(c * 0.5);
  const sw2 = s(c * 0.5 - 0.9);
  const ap = rig.pose; // idle pose blended toward the carry pose (see above)
  // Strafing: both arms sweep toward the travel side — the diver visibly
  // pulls itself sideways with its arms (third person only, and not with its
  // hands full).
  const sOff = rig.firstPerson ? 0 : rig.strafeSm * 0.5 * free;
  // (Signs validated numerically: hands settle below-forward of the eyes,
  // elbows slightly out — a relaxed prone glide.)
  pose(rig, "L_Upperarm", "aY", -ap.uy + arm * 0.7 * sw + sOff);
  poseAdd(rig, "L_Upperarm", "aX", ap.ux + arm * 0.4 * sw2);
  pose(rig, "R_Upperarm", "aY", ap.uy - arm * 0.7 * sw + sOff);
  poseAdd(rig, "R_Upperarm", "aX", ap.ux + arm * 0.4 * sw2);
  pose(
    rig,
    "L_Forearm",
    "aY",
    -ap.fy - arm * 0.6 * Math.max(0, sw2) + sOff * 0.6,
  );
  poseAdd(rig, "L_Forearm", "aX", ap.fx);
  poseAdd(rig, "L_Forearm", "aZ", -ap.fz);
  pose(
    rig,
    "R_Forearm",
    "aY",
    ap.fy + arm * 0.6 * Math.max(0, sw2) + sOff * 0.6,
  );
  poseAdd(rig, "R_Forearm", "aX", ap.fx);
  poseAdd(rig, "R_Forearm", "aZ", ap.fz);
  const handWiggle = (rig.firstPerson ? 0.04 : 0.16) * free;
  // Three axes, because a hand that is going to CLOSE ON something needs all
  // three and a hand laid flat needs none of them:
  //   hx  bends the wrist up/down,
  //   hy  turns the palms IN toward each other — this is what makes a pair of
  //       hands read as closed around a load rather than pressed flat on it,
  //   hz  rolls the palm to face the load, together with the forearm's own
  //       pronation (fz). Without it the paws meet the wheel BACK-first, with
  //       the fingers splayed away from the thing they are supposed to hold.
  // All three are mirrored between the two hands, like uy and fy above.
  pose(rig, "L_Hand", "aX", ap.hx + handWiggle * sw);
  poseAdd(rig, "L_Hand", "aY", -ap.hy);
  poseAdd(rig, "L_Hand", "aZ", -ap.hz);
  pose(rig, "R_Hand", "aX", ap.hx + handWiggle * sw);
  poseAdd(rig, "R_Hand", "aY", ap.hy);
  poseAdd(rig, "R_Hand", "aZ", ap.hz);

  // First person: the head is collapsed/invisible and the local torch is
  // camera-mounted — skip the whole look solve.
  if (rig.firstPerson) return;

  // --- Head look: EXACT camera sync (the helmet torch mounts here) --------
  // The body may face somewhere else (lazy swim orientation), so the head
  // visibly TURNS on the shoulders toward the true look. Relative yaw is
  // clamped so a big transient look-vs-body gap never owl-cranes the neck;
  // necks take a soft share of both axes, then the head bone gets solved
  // exactly so the torch beam leaves along the (clamped) look direction.
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
    // Accumulate the head's parent world quaternion by hand (unit/uniform
    // scales throughout, so pure quaternion products are exact) — no
    // mid-frame matrix updates needed.
    _q3.copy(_q1).multiply(rig.root.quaternion).multiply(rig.model.quaternion);
    for (const b of rig.chain) _q3.multiply(b.quaternion);
    rig.head.quaternion.copy(_q3.invert()).multiply(rig.headQuat);
    rig.head.getWorldPosition(rig.headPos);
  }
}
