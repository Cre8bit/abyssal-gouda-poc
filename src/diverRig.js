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
//   arms   L/R_Upperarm → L/R_Forearm → L/R_Hand  (stroke, visible in FP)
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

export const DIVER_SCALE = 1.4; // template ~0.95 tall → ~1.33 world units
const LEAN = 1.0; // prone swimming lean (rad) — body pitches under the head
const REF_SPEED = 10; // world speed that maps to a full-effort kick

// First-person body cheat: shift the body slightly forward of the true eye
// anchor so the idle hands PEEK at the bottom edge of the screen (~0.75-0.8
// of the half-FOV; edge is 0.727) without the shoulders crowding the view —
// strokes and a small look-down bring them fully into frame.
const FP_OFFSET = new THREE.Vector3(0, 0.02, -0.21);

// Base arm poses (template-space angles), numerically solved per view:
// the FP pose reaches further forward-down so your own hands stay in frame.
const ARM_POSE_THIRD = { uy: 1.45, ux: -0.45, fy: 0.25, fx: -0.15 };
const ARM_POSE_FP = { uy: 1.5, ux: -0.6, fy: 0.5, fx: -0.15 };

// Only these bones are ever posed (twist helpers excluded = simplified rig).
const ANIMATED = [
  "L_Thigh", "R_Thigh", "L_Calf", "R_Calf", "L_Foot", "R_Foot",
  "Waist", "Spine01", "Spine02",
  "NeckTwist01", "NeckTwist02", "Head",
  "L_Upperarm", "R_Upperarm", "L_Forearm", "R_Forearm", "L_Hand", "R_Hand",
];

// Parent chain of the head (rig-side), used to solve the head's local
// quaternion from a desired WORLD orientation without touching matrices.
const HEAD_CHAIN = [
  "Root", "Hip", "Waist", "Spine01", "Spine02", "NeckTwist01", "NeckTwist02",
];

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _e1 = new THREE.Euler();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _qa = new THREE.Quaternion();

// One-time prep on the freshly loaded GLTF. Everything computed here is
// shared by ALL rig instances (local body + every remote diver): per-bone
// rest quaternions and template-space axes mapped into bone-local frames.
export function prepareDiverTemplate(gltf) {
  const scene = gltf.scene;
  scene.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.frustumCulled = false; // skinned verts move; bounds don't
    }
  });
  scene.updateMatrixWorld(true);

  const data = new Map();
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
  const head = scene.getObjectByName("Head");
  const headFix = head.getWorldQuaternion(new THREE.Quaternion());
  headFix.premultiply(
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI).invert(),
  );
  const headRest = head.getWorldPosition(new THREE.Vector3());

  return { scene, data, headFix, headRest, fpGeometry: buildFpGeometry(scene) };
}

// First-person geometry: the head/helmet/collar TRIANGLES are deleted
// outright. (Collapsing the neck bone doesn't work: helmet verts partially
// weighted to spine/clavicles only collapse halfway, leaving huge stretched
// shells floating in front of the camera.) A triangle goes if any of its
// verts is majority-weighted to the head/neck chain, or sits high on the
// torso in the rest pose (template y > 0.54 — helmet 0.616..0.945, collar
// rim 0.54..0.60) WITHOUT being arm-weighted, so shoulders/deltoids keep
// their geometry. Built once, shared by FP rigs.
function buildFpGeometry(scene) {
  let mesh;
  scene.traverse((o) => {
    if (o.isSkinnedMesh) mesh ??= o;
  });
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const sj = geo.attributes.skinIndex;
  const sw = geo.attributes.skinWeight;
  const headSet = new Set();
  const armSet = new Set();
  mesh.skeleton.bones.forEach((b, i) => {
    if (/Head|NeckTwist/.test(b.name)) headSet.add(i);
    else if (/Hand|Forearm|Upperarm/.test(b.name)) armSet.add(i);
  });
  const bad = (i) => {
    let headW = 0;
    let armW = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      const j = sj.getComponent(i, k);
      if (headSet.has(j)) headW += w;
      else if (armSet.has(j)) armW += w;
    }
    return headW > 0.5 || (pos.getY(i) > 0.54 && armW < 0.4);
  };
  const index = geo.index.array;
  const keep = [];
  for (let t = 0; t < index.length; t += 3) {
    if (!(bad(index[t]) || bad(index[t + 1]) || bad(index[t + 2]))) {
      keep.push(index[t], index[t + 1], index[t + 2]);
    }
  }
  const fp = geo.clone();
  fp.setIndex(keep);
  return fp;
}

// Build one rig instance. Returns { root, ... } — mount `root` under a
// caller-owned yaw group + pitch pivot (the same structure remote players
// already use). firstPerson collapses the neck so the local player's own
// helmet never clips through the camera, and skips the head-look solve.
export function createDiverRig(template, { firstPerson = false } = {}) {
  const model = SkeletonUtils.clone(template.scene);
  model.scale.setScalar(DIVER_SCALE);
  model.rotation.y = Math.PI; // template faces +Z; game forward is -Z

  const root = new THREE.Group(); // carries lean/roll + the eye anchor
  root.add(model);

  const bones = new Map();
  model.traverse((obj) => {
    if (obj.isBone) bones.set(obj.name, obj);
  });

  if (firstPerson) {
    // Swap in the head-less geometry (see buildFpGeometry) so your own
    // helmet simply doesn't exist — nothing to clip, collapse, or clone.
    model.traverse((o) => {
      if (o.isSkinnedMesh) o.geometry = template.fpGeometry;
    });
  }

  // Head rest position, template space → rig space (rotY(π) flips x/z).
  const anchor = new THREE.Vector3(
    -template.headRest.x,
    template.headRest.y,
    -template.headRest.z,
  ).multiplyScalar(DIVER_SCALE);

  const rig = {
    root,
    model,
    bones,
    data: template.data,
    headFix: template.headFix,
    anchor,
    firstPerson,
    armPose: firstPerson ? ARM_POSE_FP : ARM_POSE_THIRD,
    head: bones.get("Head") ?? null,
    chain: HEAD_CHAIN.map((n) => bones.get(n)).filter(Boolean),
    // Per-instance smoothed state (all cached, zero per-frame allocation).
    cycle: Math.random() * 10, // desync swim cycles between divers
    speedSm: 0,
    leanAdj: 0,
    roll: 0,
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
function applyRootPose(rig, swayX = 0, swayZ = 0) {
  rig.root.rotation.set(-LEAN + rig.leanAdj + swayX, 0, rig.roll + swayZ);
  rig.root.position.copy(rig.anchor).applyEuler(rig.root.rotation).negate();
  if (rig.firstPerson) rig.root.position.add(FP_OFFSET);
}

// Absolute pose: rest ∘ rotation about a template axis. Never accumulates.
function pose(rig, name, axis, angle) {
  const b = rig.bones.get(name);
  const d = rig.data.get(name);
  if (!b || !d) return;
  b.quaternion.copy(d.rest).multiply(_qa.setFromAxisAngle(d[axis], angle));
}

// Compose a second axis on top of the pose() set this frame.
function poseAdd(rig, name, axis, angle) {
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
  rig,
  dt,
  { bodyYaw, bodyPitch, lookYaw, lookPitch, vel },
) {
  // --- Movement analysis --------------------------------------------------
  _q1.setFromEuler(_e1.set(bodyPitch, bodyYaw, 0, "YXZ")); // body world quat
  _v1.set(vel.x, vel.y, vel.z);
  const speed = _v1.length();
  rig.speedSm +=
    (Math.min(1, speed / REF_SPEED) - rig.speedSm) * Math.min(1, dt * 4);
  const effort = rig.speedSm;

  let leanTarget = 0;
  let rollTarget = 0;
  if (speed > 0.25) {
    _v2.copy(_v1).applyQuaternion(_q2.copy(_q1).invert()); // body-local dir
    const strafe = _v2.x / speed;
    const travelPitch = Math.asin(
      Math.max(-1, Math.min(1, _v1.y / speed)),
    );
    const w = Math.min(1, speed / 3);
    // Nose toward the actual travel direction (residual vs body pitch).
    leanTarget = Math.max(-0.6, Math.min(0.6, travelPitch - bodyPitch)) * w;
    // Bank into strafes, like the camera does.
    rollTarget = -strafe * 0.3 * w;
  }
  // Slow easing — direction changes (especially strafes) read as the body
  // lazily rolling through the water, never snapping.
  rig.leanAdj += (leanTarget - rig.leanAdj) * Math.min(1, dt * 1.5);
  rig.roll += (rollTarget - rig.roll) * Math.min(1, dt * 1.5);

  // --- Swim cycle: rate and amplitude scale with effort --------------------
  rig.cycle += dt * (2.0 + 7.0 * effort);
  const c = rig.cycle;
  const s = Math.sin;
  const kick = 0.17 + 0.5 * effort;

  // Idle water-sway: the body never sits dead still — a slow two-axis
  // wallow that fades as real swimming takes over.
  const sway = 1 - 0.6 * effort;
  applyRootPose(
    rig,
    0.035 * s(c * 0.33 + 1.2) * sway,
    0.04 * s(c * 0.41) * sway,
  );

  // Flutter kick: thighs anti-phase, knees lag, feet trail like fins.
  pose(rig, "L_Thigh", "aX", kick * s(c));
  pose(rig, "R_Thigh", "aX", kick * s(c + Math.PI));
  const knee = 0.25 + 0.15 * effort;
  pose(rig, "L_Calf", "aX", knee + kick * 0.7 * s(c - 0.9));
  pose(rig, "R_Calf", "aX", knee + kick * 0.7 * s(c - 0.9 + Math.PI));
  pose(rig, "L_Foot", "aX", 0.55 - kick * 0.5 * s(c - 1.3));
  pose(rig, "R_Foot", "aX", 0.55 - kick * 0.5 * s(c - 1.3 + Math.PI));

  // Gentle undulation rippling up the spine toward the head.
  const und = 0.05 + 0.05 * effort;
  pose(rig, "Waist", "aX", und * s(c * 0.5));
  pose(rig, "Spine01", "aX", und * s(c * 0.5 - 0.6));
  pose(rig, "Spine02", "aX", und * 0.8 * s(c * 0.5 - 1.2));

  // Arms: held forward (this is what the local player sees looking down),
  // stroking breaststroke-style at half the kick rate. Never fully still:
  // even at idle they slowly tread the water.
  const arm = 0.28 + 0.5 * effort;
  const sw = s(c * 0.5);
  const sw2 = s(c * 0.5 - 0.9);
  const ap = rig.armPose; // numerically solved base pose (FP reaches further)
  // (Signs validated numerically: hands settle below-forward of the eyes,
  // elbows slightly out — a relaxed prone glide.)
  pose(rig, "L_Upperarm", "aY", -ap.uy + arm * 0.7 * sw);
  poseAdd(rig, "L_Upperarm", "aX", ap.ux + arm * 0.4 * sw2);
  pose(rig, "R_Upperarm", "aY", ap.uy - arm * 0.7 * sw);
  poseAdd(rig, "R_Upperarm", "aX", ap.ux + arm * 0.4 * sw2);
  pose(rig, "L_Forearm", "aY", -ap.fy - arm * 0.6 * Math.max(0, sw2));
  poseAdd(rig, "L_Forearm", "aX", ap.fx);
  pose(rig, "R_Forearm", "aY", ap.fy + arm * 0.6 * Math.max(0, sw2));
  poseAdd(rig, "R_Forearm", "aX", ap.fx);
  pose(rig, "L_Hand", "aX", 0.18 + 0.16 * sw);
  pose(rig, "R_Hand", "aX", 0.18 + 0.16 * sw);

  // First person: the head is collapsed/invisible and the local torch is
  // camera-mounted — skip the whole look solve.
  if (rig.firstPerson) return;

  // --- Head look: EXACT camera sync (the helmet torch mounts here) --------
  // Necks take a soft share of the pitch difference so the head doesn't
  // owl-crane on its own; the head bone then gets solved exactly, so the
  // torch beam always leaves along the true look direction.
  const diff = lookPitch - bodyPitch + LEAN * 0.85 - rig.leanAdj;
  const neck = -Math.max(-0.7, Math.min(0.7, diff * 0.3));
  pose(rig, "NeckTwist01", "aX", neck);
  pose(rig, "NeckTwist02", "aX", neck);

  rig.lookQuat.setFromEuler(_e1.set(lookPitch, lookYaw, 0, "YXZ"));
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
