// angler.js — the Lanternmaw: a very large anglerfish that hangs in the dark
// with only its lure lit, on the same slow rhythm as the diving bell's alarm.
// Swim toward what you think is the objective and the lure retracts, the face
// floods with its own light, and the maw takes whoever is still in front of it.
//
// --- The rig -------------------------------------------------------------
// headmonster_skeletton.glb carries a repurposed Rigify *metarig*: the artist
// posed the face bones onto a creature that has nothing to do with a face, so
// the names lie and the only trustworthy signal is which vertices each bone
// actually moves. Skin-weight centroids (computed offline from the GLB) say:
//
//   spine.004        w2854  the whole head-ball — the body itself, root bone
//   spine.005/.006   w573   upper/back of the skull
//   jaw→chin→chin.001       the LOWER jaw, hinging forward at +Z
//   lip.T.L/R (+.001/.002)  the upper lip and snout front, around the maw
//   forehead.L.004…L.014    the ILLICIUM — an 11-bone stalk arcing up over the
//                           skull and forward; .014 (w229) is the esca bulb
//   forehead.L/R → temple → jaw.L/R → cheek.B → brow.T (13 each)
//                           the two long trailing tentacle chains
//
// Metarig bones point along their own local +Y, so bending one means rotating
// about its local X (pitch) or Z (yaw). GLTFLoader strips the dots from node
// names, so "forehead.L.004" arrives as "foreheadL004".
//
// Nothing here is keyframed — the GLB ships with zero animations. Every pose
// is written each frame from the rest quaternion plus an offset, never
// accumulated, so a dropped frame can't drift the skeleton out of shape.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";

const MODEL_URL = `${import.meta.env.BASE_URL}models/headmonster_skeletton.glb`;

// The model is 1 unit nose-to-tail, so the scale IS the length in metres.
export const ANGLER_LENGTH = 46;

// Ranges, all metres. The bell's own alarm carries ~260 m, so the lure has to
// be readable from further out than the fish ever is.
export const NOTICE_RANGE = 72; // it stops drifting and starts closing
export const REVEAL_RANGE = 27; // the face lights up — the moment you know
export const LUNGE_RANGE = 16; // committed; nothing stops it now
const MAW_RADIUS = ANGLER_LENGTH * 0.17; // ~7.8 m of open mouth
const PATROL_RADIUS = 200; // how far from the bell it will hold station

// Beat sheet for one attack, in seconds.
const T_REVEAL = 1.15; // wind-up: jaw unhinges, tentacles flare, it rears back
const T_LUNGE = 0.85; // the surge
const T_SNAP = 0.5; // jaw slams shut
const T_SOUND = 18; // it sinks away and the water is quiet again

const DRIFT_SPEED = 1.1;
const STALK_SPEED = 2.6;
const LUNGE_SPEED = 27; // divers sprint at 9 — you cannot outswim this
const REAR_BACK = 5; // metres it pulls back during the wind-up

// Bone chains, in root→tip order, under GLTFLoader's dot-stripped names.
const LURE_CHAIN = [
  "foreheadL004", "foreheadL005", "foreheadL006", "foreheadL007",
  "foreheadL008", "foreheadL009", "foreheadL010", "foreheadL011",
  "foreheadL012", "foreheadL013", "foreheadL014",
];
const TENTACLE_L = [
  "foreheadL", "foreheadL001", "foreheadL002", "templeL", "jawL", "jawL001",
  "chinL", "cheekBL", "cheekBL001", "browTL", "browTL001", "browTL002",
  "browTL003",
];
const TENTACLE_R = [
  "foreheadR", "foreheadR001", "foreheadR002", "templeR", "jawR", "jawR001",
  "chinR", "cheekBR", "cheekBR001", "browTR", "browTR001", "browTR002",
  "browTR003",
];
const JAW_CHAIN = ["jaw", "chin", "chin001"];
const LIP_L = ["lipTL", "lipTL001", "lipTL002"];
const LIP_R = ["lipTR", "lipTR001", "lipTR002"];
const SPINE = ["spine005", "spine006"];
const ESCA_BONE = "foreheadL014";
const MAW_FLOOR = "chin001"; // front of the lower jaw
const MAW_ROOF_L = "lipTL002";
const MAW_ROOF_R = "lipTR002";

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

let modelPromise = null;
function loadModel() {
  modelPromise ??= new GLTFLoader().loadAsync(MODEL_URL).catch((err) => {
    console.warn("[angler] model failed to load", err);
    return null;
  });
  return modelPromise;
}

// Soft radial sprite for the lure's bloom, so it reads as light in water
// rather than as a lit ball of geometry.
let haloTexture = null;
function getHalo() {
  if (haloTexture) return haloTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.22, "rgba(255,235,190,0.7)");
  g.addColorStop(0.55, "rgba(255,190,110,0.2)");
  g.addColorStop(1, "rgba(255,170,80,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  haloTexture = new THREE.CanvasTexture(canvas);
  haloTexture.colorSpace = THREE.SRGBColorSpace;
  return haloTexture;
}

export function createAngler(scene) {
  // --- Scene graph ---------------------------------------------------------
  // The body sits under a group whose +Z is the direction the maw faces, so
  // yaw/pitch can be written straight onto the group.
  const group = new THREE.Group();
  group.rotation.order = "YXZ";
  group.visible = false;
  scene.add(group);

  // The lure lives at scene level, NOT parented into the skeleton: the bones
  // would hand it the group's ×46 scale (the same trap the diver's torch has
  // to dodge in graphics.js). Its world position is copied off the esca bone
  // every frame instead.
  const lure = new THREE.Group();
  lure.visible = false;
  scene.add(lure);

  // Fog-exempt, so the lantern carries across water that has already swallowed
  // the animal holding it. This is the whole trick.
  const escaHalo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: getHalo(),
      color: 0xffc978,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
  );
  escaHalo.scale.setScalar(9);
  lure.add(escaHalo);

  const escaCore = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xffe6b4, fog: false }),
  );
  lure.add(escaCore);

  const escaLight = new THREE.PointLight(0xffc070, 0, 190, 1.6);
  lure.add(escaLight);

  // Two eyes that only ever catch light once it has decided about you.
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x120400, fog: true });
  const eyes = [];
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), eyeMat.clone());
    // Model space: the socket ridges sit just above and behind the lip line.
    eye.position.set(side * 0.135, 0.352, 0.285);
    eyes.push(eye);
  }

  const state = {
    phase: "dormant", // dormant | lurk | stalk | reveal | lunge | snap | sound
    t: 0,
    heading: Math.random() * Math.PI * 2,
    pitch: 0,
    seed: Math.random() * 100,
    centre: new THREE.Vector3(),
    gape: 0, // 0..1 how far the maw is open
    glow: 0, // 0..1 how lit the face is
    lureOut: 1, // 1 = dangled far ahead, 0 = reeled back to the teeth
    pulse: 0, // the alarm-mimicking flash, 0..1
    speed: 0,
    target: null, // the diver it has chosen
    rig: null,
    fired: false, // this lunge has already had its bite resolved
  };

  const surge = new THREE.Vector3(); // lunge direction, locked at commit
  let alarmPeriod = 5; // kept in step with the bell's own ALARM_PERIOD

  // The alarm mimic: a 0..1 flash envelope on the bell's own period, offset by
  // a fraction of a second so the two are never quite in step.
  function pulseAt(elapsed) {
    const phase = ((elapsed + 1.7) % alarmPeriod) / alarmPeriod;
    return phase < 0.16 ? Math.pow(1 - phase / 0.16, 1.7) : 0;
  }

  loadModel().then((gltf) => {
    if (!gltf) return;
    // The GLTF is cached and shared, so every angler needs its own skeleton:
    // handing two instances the same bones would have them fighting over one
    // pose, and whichever loaded second would capture the other's animated
    // orientation as its "rest". Same reason the diver rig clones in
    // graphics.js.
    const model = SkeletonUtils.clone(gltf.scene);
    model.scale.setScalar(ANGLER_LENGTH);

    const bones = new Map();
    model.traverse((obj) => {
      if (obj.isBone) bones.set(obj.name, obj);
      if (obj.isMesh) {
        obj.frustumCulled = false; // the skeleton throws it well past its bounds
        obj.castShadow = false;
        // Drown the albedo: at depth it should be a shape, not a texture, and
        // the emissive term is what "the face gets revealed" actually means.
        const mat = obj.material.clone();
        mat.color = new THREE.Color(0x2f3d46);
        mat.roughness = 1;
        mat.metalness = 0;
        mat.emissive = new THREE.Color(0x000000);
        mat.emissiveIntensity = 1;
        obj.material = mat;
        state.skin = mat;
      }
    });
    group.add(model);
    for (const eye of eyes) model.add(eye);

    const chain = (names) => names.map((n) => bones.get(n)).filter(Boolean);
    const rig = {
      lure: chain(LURE_CHAIN),
      tentacles: [chain(TENTACLE_L), chain(TENTACLE_R)],
      jaw: chain(JAW_CHAIN),
      lips: [chain(LIP_L), chain(LIP_R)],
      spine: chain(SPINE),
      esca: bones.get(ESCA_BONE),
      mawFloor: bones.get(MAW_FLOOR),
      mawRoof: [bones.get(MAW_ROOF_L), bones.get(MAW_ROOF_R)].filter(Boolean),
      rest: new Map(),
    };
    for (const bone of bones.values()) rig.rest.set(bone, bone.quaternion.clone());

    const missing = [
      ...LURE_CHAIN, ...TENTACLE_L, ...TENTACLE_R, ...JAW_CHAIN,
      ...LIP_L, ...LIP_R, ...SPINE,
    ].filter((n) => !bones.has(n));
    if (missing.length) console.warn("[angler] bones not found:", missing);

    // Which way is "open"? Rotating about the bone's own local X is a coin
    // flip on a metarig — the roll is whatever the artist left it at, and the
    // jaw here swings mostly sideways if you trust it. So solve the hinge
    // instead: the axis that swings this bone toward straight down is
    // perpendicular to both the bone and to down, and that is a cross product.
    model.updateMatrixWorld(true);
    rig.jawAxis = rig.jaw.map((b) => hingeAxis(b, DOWN));
    rig.lipAxis = rig.lips.map((chain) => chain.map((b) => hingeAxis(b, UP)));
    state.rig = rig;
  });

  // The local-space axis to rotate `bone` about so its tip travels toward
  // `worldDir`. Bones point along their own +Y, so it is +Y × (worldDir in
  // bone space). Computed once at rest, while the group is still unrotated.
  function hingeAxis(bone, worldDir) {
    const axis = new THREE.Vector3(1, 0, 0);
    if (!bone) return axis;
    const basis = new THREE.Matrix3().setFromMatrix4(bone.matrixWorld).invert();
    const local = worldDir.clone().applyMatrix3(basis).normalize();
    const hinge = new THREE.Vector3(0, 1, 0).cross(local);
    return hinge.lengthSq() < 1e-6 ? axis : hinge.normalize();
  }

  // --- Placement -----------------------------------------------------------

  // Called when the bell settles at a new depth: hang it far enough out that
  // the lure is the only thing that reaches you.
  function spawn(centre) {
    state.centre.copy(centre);
    const a = Math.random() * Math.PI * 2;
    const d = PATROL_RADIUS * (0.55 + Math.random() * 0.35);
    group.position.set(
      centre.x + Math.cos(a) * d,
      centre.y + (Math.random() - 0.5) * 40,
      centre.z + Math.sin(a) * d,
    );
    state.heading = a + Math.PI + (Math.random() - 0.5);
    state.pitch = 0;
    state.phase = "lurk";
    state.t = 0;
    state.gape = 0;
    state.glow = 0;
    state.lureOut = 1;
    state.target = null;
    state.fired = false;
    group.visible = true;
    lure.visible = true;
  }

  function despawn() {
    state.phase = "dormant";
    group.visible = false;
    lure.visible = false;
  }

  // Screenshot hook, mirroring placeCreature: park it dead ahead in a chosen
  // phase so a vantage point renders the same pose every run.
  function place(pos, bearing, dist, phase = "lurk") {
    spawn(_v1.set(pos.x, pos.y, pos.z));
    group.position.set(
      pos.x + Math.cos(bearing) * dist,
      pos.y - 2,
      pos.z + Math.sin(bearing) * dist,
    );
    state.heading = Math.atan2(pos.x - group.position.x, pos.z - group.position.z);
    state.phase = phase;
    state.t = phase === "reveal" ? T_REVEAL * 0.8 : 0;
    if (phase !== "lurk") {
      state.glow = 1;
      state.gape = 1;
      state.lureOut = 0.15;
      state.pulse = 1;
    }
  }

  // --- The attack ----------------------------------------------------------
  //
  // lurk  → a light on the same 5 s beat as the bell, and nothing else
  // stalk → it has picked someone; it closes, and the lure starts reeling in
  // reveal→ the wind-up: it rears back, unhinges, and lights its own face
  // lunge → 27 m/s straight down your sightline
  // snap  → the maw shuts; whoever was inside is inside
  // sound → it sinks away, dark, and you get to think about it for 18 s

  function update(delta, elapsed, noise, ctx = {}) {
    if (state.phase === "dormant") return;
    state.seen = ctx.seen ?? 1; // how much of the lantern this depth lets through
    // A client doesn't run the hunt: a mob that decides on its own whether it
    // ate you would reach different verdicts in different windows. The host
    // simulates, everyone else is handed the pose and plays it back.
    // Screenshot mode holds a chosen phase: pose and light it, but never let
    // the state machine run on, or the same vantage point would render a
    // different beat of the attack every time.
    if (remote || ctx.frozen) {
      if (remote) followHost(delta);
      group.rotation.y = state.heading;
      group.rotation.x = state.pitch;
      pose(delta, elapsed, noise);
      paint(delta);
      return;
    }
    const divers = ctx.divers ?? [];

    // Whoever is nearest is who it is thinking about.
    let near = null;
    let nearDist = Infinity;
    for (const d of divers) {
      if (d.out) continue;
      const dist = Math.hypot(d.x - group.position.x, d.y - group.position.y, d.z - group.position.z);
      if (dist < nearDist) {
        nearDist = dist;
        near = d;
      }
    }

    state.t += delta;
    switch (state.phase) {
      case "lurk":
        drift(delta, elapsed, noise);
        // The mimicry: flash on the bell's own cadence, so on the instruments
        // it is indistinguishable from the thing you are swimming back to.
        state.pulse = pulseAt(elapsed);
        state.glow = approach(state.glow, 0, delta * 1.5);
        state.gape = approach(state.gape, 0, delta * 1.2);
        state.lureOut = approach(state.lureOut, 1, delta * 0.5);
        if (near && nearDist < NOTICE_RANGE) {
          state.target = near.id;
          state.phase = "stalk";
          state.t = 0;
          ctx.onEvent?.("notice", near, nearDist);
        }
        break;

      case "stalk": {
        const mark = pick(divers, state.target) ?? near;
        if (!mark || nearDist > NOTICE_RANGE * 1.35) {
          state.phase = "lurk";
          state.t = 0;
          break;
        }
        // It swims at you slowly and steadily, lure first, and the lure stops
        // blinking — by the time you notice it went steady you are too close.
        aimAt(mark, delta, 1.4);
        advance(STALK_SPEED, delta);
        state.pulse = approach(state.pulse, 1, delta * 1.2);
        state.lureOut = approach(state.lureOut, 0.45, delta * 0.6);
        state.glow = approach(state.glow, 0.12, delta);
        if (nearDist < REVEAL_RANGE) {
          state.phase = "reveal";
          state.t = 0;
          ctx.onEvent?.("reveal", mark, nearDist);
        }
        break;
      }

      case "reveal": {
        const mark = pick(divers, state.target) ?? near;
        const k = Math.min(state.t / T_REVEAL, 1);
        if (mark) aimAt(mark, delta, 3.2);
        // Anticipation: it pulls BACK while opening, which is what sells the
        // size of the thing before it ever moves forward.
        advance(-REAR_BACK * (1 - k) * 2, delta);
        state.gape = ease(k);
        state.glow = Math.min(1, k * 1.6);
        state.lureOut = approach(state.lureOut, 0.1, delta * 3);
        state.pulse = 1;
        if (k >= 1) {
          state.phase = "lunge";
          state.t = 0;
          state.fired = false;
          forward(surge); // direction locked here — after this it is ballistic
          ctx.onEvent?.("lunge", mark, nearDist);
        }
        break;
      }

      case "lunge": {
        const k = state.t / T_LUNGE;
        const speed = LUNGE_SPEED * Math.sin(Math.min(k, 1) * Math.PI) * 1.15;
        group.position.addScaledVector(surge, speed * delta);
        state.speed = speed / LUNGE_SPEED;
        state.gape = 1;
        state.glow = 1;
        state.lureOut = 0.08;
        bite(divers, ctx);
        if (state.t >= T_LUNGE) {
          state.phase = "snap";
          state.t = 0;
          ctx.onEvent?.("snap", null, 0);
        }
        break;
      }

      case "snap": {
        const k = Math.min(state.t / T_SNAP, 1);
        group.position.addScaledVector(surge, LUNGE_SPEED * 0.18 * (1 - k) * delta);
        // The last half of the closing mouth still catches you.
        if (k < 0.45) bite(divers, ctx);
        state.gape = 1 - ease(k);
        state.glow = 1 - k * 0.5;
        state.speed = 0;
        if (k >= 1) {
          state.phase = "sound";
          state.t = 0;
        }
        break;
      }

      case "sound": {
        // Down and away, lure out, as if none of it happened.
        state.pitch = approach(state.pitch, 0.35, delta);
        advance(6, delta);
        state.gape = approach(state.gape, 0, delta * 1.5);
        state.glow = approach(state.glow, 0, delta * 0.7);
        state.pulse = approach(state.pulse, 0, delta * 0.6);
        if (state.t >= T_SOUND) {
          spawn(state.centre); // resurfaces somewhere else entirely
        }
        break;
      }
    }

    group.rotation.y = state.heading;
    group.rotation.x = state.pitch;
    pose(delta, elapsed, noise);
    paint(delta);
  }

  // --- Movement ------------------------------------------------------------

  function drift(delta, elapsed, noise) {
    state.heading += noise.noise(elapsed * 0.05, state.seed, 0) * 0.35 * delta;
    const away = group.position.distanceTo(state.centre);
    if (away > PATROL_RADIUS) {
      const home = Math.atan2(
        state.centre.x - group.position.x,
        state.centre.z - group.position.z,
      );
      state.heading += shortestTurn(state.heading, home) * 0.5 * delta;
    }
    state.pitch = approach(state.pitch, noise.noise(0, elapsed * 0.04, state.seed) * 0.12, delta);
    advance(DRIFT_SPEED, delta);
    state.speed = 0.12;
  }

  function aimAt(mark, delta, rate) {
    const dx = mark.x - group.position.x;
    const dy = mark.y - group.position.y;
    const dz = mark.z - group.position.z;
    const flat = Math.hypot(dx, dz) || 0.001;
    const wantYaw = Math.atan2(dx, dz);
    const wantPitch = Math.atan2(-dy, flat);
    const k = 1 - Math.exp(-rate * delta);
    state.heading += shortestTurn(state.heading, wantYaw) * k;
    state.pitch += (wantPitch - state.pitch) * k;
    state.speed = 0.4;
  }

  function forward(out) {
    const cp = Math.cos(state.pitch);
    return out.set(
      Math.sin(state.heading) * cp,
      -Math.sin(state.pitch),
      Math.cos(state.heading) * cp,
    );
  }

  function advance(speed, delta) {
    group.position.addScaledVector(forward(_v3), speed * delta);
  }

  // --- The bite ------------------------------------------------------------
  // The maw volume is read off the rig, not guessed: the midpoint between the
  // front of the lower jaw and the two lip tips IS where the mouth is, however
  // far the animation has swung it open.
  function mawCentre(out) {
    const rig = state.rig;
    if (!rig?.mawFloor) return forward(out).multiplyScalar(ANGLER_LENGTH * 0.34).add(group.position);
    rig.mawFloor.getWorldPosition(out);
    if (rig.mawRoof.length) {
      _v2.set(0, 0, 0);
      for (const b of rig.mawRoof) _v2.add(b.getWorldPosition(_v1));
      _v2.divideScalar(rig.mawRoof.length);
      out.lerp(_v2, 0.5);
    }
    return out;
  }

  function bite(divers, ctx) {
    mawCentre(_v2);
    const reach = MAW_RADIUS * (0.75 + state.gape * 0.45);
    for (const d of divers) {
      if (d.out) continue;
      if (Math.hypot(d.x - _v2.x, d.y - _v2.y, d.z - _v2.z) <= reach) {
        d.out = true;
        ctx.onSwallow?.(d.id);
      }
    }
  }

  // --- Pose ----------------------------------------------------------------

  function pose(delta, elapsed, noise) {
    const rig = state.rig;
    if (!rig) return;
    const t = elapsed;
    const effort = 0.35 + state.speed * 1.4;

    // Body: a slow lateral working of the mass, faster when it commits.
    bend(rig, rig.spine[0], Math.sin(t * 0.8) * 0.05 * effort, 0, Math.sin(t * 0.6 + 1) * 0.04);
    bend(rig, rig.spine[1], Math.sin(t * 0.8 - 0.4) * 0.05 * effort, 0, Math.sin(t * 0.6 + 0.5) * 0.05);

    // Tentacles: a wave travelling root→tip, mirrored per side and pushed
    // outward as the maw opens so the silhouette blooms on the reveal.
    for (let s = 0; s < rig.tentacles.length; s++) {
      const chain = rig.tentacles[s];
      const mirror = s === 0 ? 1 : -1;
      for (let i = 0; i < chain.length; i++) {
        const along = i / Math.max(1, chain.length - 1);
        const swim = Math.sin(t * (1.1 + effort * 0.5) - i * 0.55 + s * 1.7);
        const curl = Math.sin(t * 0.42 + i * 0.3 + state.seed);
        const amp = (0.035 + along * 0.075) * effort;
        const flare = state.gape * 0.09 * along * mirror;
        bend(rig, chain[i], swim * amp, curl * amp * 0.5, swim * amp * 0.7 * mirror + flare);
      }
    }

    // Illicium: hangs the esca out front and bobs it like something alive and
    // small. `lureOut` reels the whole stalk back to the teeth as it closes in.
    const reel = 1 - state.lureOut;
    for (let i = 0; i < rig.lure.length; i++) {
      const along = i / Math.max(1, rig.lure.length - 1);
      const bob = Math.sin(t * 0.9 - i * 0.42 + state.seed) * (0.02 + along * 0.045);
      const sway = Math.sin(t * 0.6 - i * 0.3) * 0.03 * along;
      // Reeling in is a curl of the whole stalk back over the skull.
      bend(rig, rig.lure[i], bob - reel * 0.13, 0, sway + reel * 0.02);
    }

    // Jaw: swing it down its solved hinge. The chain shares the load so the
    // whole lower jaw curves open rather than snapping at one joint.
    const gape = ease(state.gape);
    const jawAngles = [0.78, 0.34, 0.16];
    for (let i = 0; i < rig.jaw.length; i++) {
      const shudder = state.gape > 0.5 ? Math.sin(t * 26 + i) * 0.014 * state.gape : 0;
      hinge(rig, rig.jaw[i], rig.jawAxis?.[i], gape * jawAngles[i] + shudder);
    }

    // Upper lip peels back the other way — a jaw alone only ever looks like a
    // drawer opening; the maw has to widen from both sides.
    for (let s = 0; s < rig.lips.length; s++) {
      const mirror = s === 0 ? 1 : -1;
      const chain = rig.lips[s];
      for (let i = 0; i < chain.length; i++) {
        hinge(
          rig,
          chain[i],
          rig.lipAxis?.[s]?.[i],
          gape * (0.34 - i * 0.08),
          gape * 0.12 * mirror, // and splayed outward, so the maw is round
        );
      }
    }
  }

  // Write bone = rest * swing-about-hinge * optional lateral splay.
  function hinge(rig, bone, axis, angle, splay = 0) {
    if (!bone || !axis) return;
    const rest = rig.rest.get(bone);
    if (!rest) return;
    bone.quaternion.copy(rest).multiply(_q.setFromAxisAngle(axis, angle));
    if (splay) bone.quaternion.multiply(_q.setFromEuler(_e.set(0, 0, splay, "XYZ")));
  }

  // Write bone = rest * offset. Absolute every frame; never accumulates.
  function bend(rig, bone, x, y, z) {
    if (!bone) return;
    const rest = rig.rest.get(bone);
    if (!rest) return;
    bone.quaternion.copy(rest).multiply(_q.setFromEuler(_e.set(x, y, z, "XYZ")));
  }

  // --- Light ---------------------------------------------------------------

  function paint(delta) {
    const rig = state.rig;
    if (rig?.esca) rig.esca.getWorldPosition(lure.position);
    else lure.position.copy(group.position);

    // While lurking the lure is a slow beacon; once it has chosen you it burns
    // steady and hot, and floods the face from a foot in front of the teeth.
    const lit = 0.28 + state.pulse * 0.72;
    // `seen` is the depth's sight range, handed in by graphics.js. Past it the
    // lantern is gone — the same rule the bell's lamp obeys, so neither of them
    // can be picked out of the dark from further than the other.
    const seen = state.seen ?? 1;
    const scale = 7 + lit * 6 + state.glow * 5;
    escaHalo.scale.setScalar(scale);
    escaHalo.material.opacity = (0.55 + lit * 0.45) * seen;
    escaHalo.material.color.setHSL(0.09 - state.glow * 0.03, 0.85 - state.glow * 0.4, 0.55 + lit * 0.25);
    escaCore.scale.setScalar(0.6 + lit * 0.7);
    escaCore.visible = seen > 0.01;
    escaLight.intensity = 220 + lit * 380 + state.glow * 900;
    escaLight.distance = 150 + state.glow * 130;

    // The reveal: the animal's own skin comes up out of black.
    if (state.skin) {
      state.skin.emissive.setRGB(0.10 * state.glow, 0.075 * state.glow, 0.055 * state.glow);
      state.skin.emissiveIntensity = 0.4 + state.glow * 1.5;
    }
    const eyeGlow = Math.max(0, state.glow * 1.2 - 0.15);
    for (const eye of eyes) {
      eye.material.color.setRGB(0.07 + eyeGlow * 1.5, 0.02 + eyeGlow * 0.55, 0.01 + eyeGlow * 0.1);
    }
  }

  function setAlarmPeriod(seconds) {
    alarmPeriod = seconds;
  }

  // Scrubbing hook for preview.html: drive the four animation values by hand
  // with `frozen: true`, so a pose can be held and inspected instead of only
  // ever flashing past inside a 0.85 s lunge. Not used by the game.
  function setPose({ phase, gape, glow, lureOut, pulse, speed, heading, pitch } = {}) {
    if (phase !== undefined) state.phase = phase;
    if (gape !== undefined) state.gape = gape;
    if (glow !== undefined) state.glow = glow;
    if (lureOut !== undefined) state.lureOut = lureOut;
    if (pulse !== undefined) state.pulse = pulse;
    if (speed !== undefined) state.speed = speed;
    if (heading !== undefined) state.heading = heading;
    if (pitch !== undefined) state.pitch = pitch;
  }

  // --- Network -------------------------------------------------------------
  // Nine numbers at the same 30 Hz the divers already use. Position and facing
  // are eased toward the host's; the mood values (gape, glow, lure, pulse) are
  // applied straight, because a lagging jaw is worse than a snapping one.

  let remote = false;
  const wire = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };

  function netState() {
    return [
      round(group.position.x), round(group.position.y), round(group.position.z),
      round(state.heading), round(state.pitch),
      round(state.gape), round(state.glow), round(state.lureOut), round(state.pulse),
    ];
  }

  function applyNet(s) {
    if (!Array.isArray(s) || s.length < 9) return;
    remote = true;
    if (state.phase === "dormant") {
      state.phase = "net";
      group.visible = true;
      lure.visible = true;
      group.position.set(s[0], s[1], s[2]);
      state.heading = s[3];
    }
    wire.x = s[0];
    wire.y = s[1];
    wire.z = s[2];
    wire.heading = s[3];
    wire.pitch = s[4];
    state.gape = s[5];
    state.glow = s[6];
    state.lureOut = s[7];
    state.pulse = s[8];
    state.speed = state.gape > 0.6 ? 1 : 0.2;
  }

  function followHost(delta) {
    const k = 1 - Math.exp(-14 * delta);
    group.position.x += (wire.x - group.position.x) * k;
    group.position.y += (wire.y - group.position.y) * k;
    group.position.z += (wire.z - group.position.z) * k;
    state.heading += shortestTurn(state.heading, wire.heading) * k;
    state.pitch += (wire.pitch - state.pitch) * k;
    group.rotation.y = state.heading;
    group.rotation.x = state.pitch;
  }

  return {
    group,
    spawn,
    despawn,
    place,
    update,
    setAlarmPeriod,
    get phase() {
      return state.phase;
    },
    get glow() {
      return state.glow;
    },
    get pulse() {
      return state.pulse;
    },
    get position() {
      return group.position;
    },
    // Where the light appears to be — this is what the HUD gets fooled by.
    lurePosition() {
      return lure.position;
    },
    mawPosition(out = new THREE.Vector3()) {
      return mawCentre(out);
    },
    // True while the lure is still pretending to be the bell. Read off `glow`
    // rather than the phase name so it also holds for a client playing back a
    // pose it never simulated.
    isDecoy() {
      return state.phase !== "dormant" && state.phase !== "sound" && state.glow < 0.25;
    },
    isHunting() {
      return state.glow >= 0.25 && state.gape > 0.05;
    },
    netState,
    applyNet,
    isRemote() {
      return remote;
    },
    setPose,
    // Read-only view of the four values the whole animation hangs off, for
    // the preview's readout.
    values() {
      return {
        phase: state.phase,
        gape: state.gape,
        glow: state.glow,
        lureOut: state.lureOut,
        pulse: state.pulse,
        speed: state.speed,
        t: state.t,
      };
    },
  };
}

// --- helpers ---------------------------------------------------------------

function pick(divers, id) {
  return divers.find((d) => d.id === id && !d.out) ?? null;
}

function approach(value, goal, step) {
  return value < goal ? Math.min(goal, value + step) : Math.max(goal, value - step);
}

function ease(k) {
  return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
}

function shortestTurn(a, b) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

// Three decimals is well under a centimetre at this scale and keeps the 30 Hz
// pose stream small on an unreliable channel.
function round(v) {
  return Math.round(v * 1000) / 1000;
}
