// goldenGouda.ts — the Golden Gouda: cheese duplicator, still warm (M1.2).
//
// Standalone body mounted by item registry (game/items.ts kind "gouda").
// Two lights: cavern lamp + long-range glow. Dim lamp when held (light in face
// at arm's length, body shadows most anyway); glow untouched for visibility.
//
// Presentation only — game logic in game/cargo.ts + systems/cargoSystem.ts.
//
// ── THE RIG ──────────────────────────────────────────────────────────────────
// GLB: SkinnedMesh + Armature of 8 joints (7 bit bones + neutral_bone = 1027/1238 verts).
// prepareGoudaTemplate() measures: static body joint, wheel centre, bit rest poses + axes.
// One-sided binding (1 influence/vert @ 1.0 weight) → clean material seam + rigid bits.
//
// ── Lighting gotcha ──────────────────────────────────────────────────────────
// Lights inside wheel body → body uses black-floored ramp + emissive; bits unlit.
import * as THREE from "three";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { toonMaterial } from "../render/toon.ts";

// Wheel radius vs diver: ~0.45 u (diver ~0.7 u arms). Bigger reads as boulder.
// Prize is lamp & bits, not size.
export const GOUDA_RADIUS = 0.45;

const MODEL_URL = `${import.meta.env.BASE_URL}models/golden_gouda.glb`;

const LAMP_INTENSITY = 620; // fills chamber
const LAMP_RANGE = 80;
const LAMP_HELD = 0.05; // dimmed when held
const GLOW_INTENSITY = 20; // far leak
const GLOW_RANGE = 170;
const BODY_LIGHT_CAP = 0.5; // cap concave crater at full lit gold (see attach())

// Levitation: bits breathe out of sockets. LIFT ~5cm peak travel (half a bit).
// All amplitudes in WORLD units, scaled with GOUDA_RADIUS.
const BIT_LIFT = 0.055; // world u, peak travel OUT of the socket (never in)
const BIT_RATE = 0.55; // rad/s, the breathe — slowed per bit by hash below
const BIT_SPIN = 0.3; // rad/s, slow roll about the bone axis
const BIT_WOBBLE = 0.12; // rad, tilt off the rest pose — just enough to live

// Orbit: bit revolves around wheel axis @ own rate/direction (30–90 s/rev).
// Drift: bit floats radially out & back; inward clamped to BIT_DRIFT_IN.
const BIT_ORBIT = 0.12; // rad/s about the wheel axis, scaled/signed per bit
const BIT_DRIFT = 0.115; // world u, peak float away from the centre
const BIT_DRIFT_IN = 0.3; // …of which this fraction is allowed inward
const BIT_DRIFT_RATE = 0.21; // rad/s of the in/out float — slower than the breathe

// Held: damp amplitudes (held @ chest). Rates unchanged; no snap.
const BIT_HELD = 0.45;

const BONE_UP = new THREE.Vector3(0, 1, 0); // +Y = out of wheel
const BONE_SIDE = new THREE.Vector3(1, 0, 0); // wobble axis

// Shared cel ramp (render/toon.ts) floors at 40/255 (16% min). Lights inside
// body → black floor + emissive-only (same bands, same ink rim).
const BODY_FLOOR = 0;

// Scratch vectors (reused per-frame).
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qOrbit = new THREE.Quaternion();
const _out = new THREE.Vector3();
const _rad = new THREE.Vector3();

// --- The template: the shipped rig, measured -------------------------------

// One levitating bit, as measured off the shipped skeleton. Everything is in
// the bone's PARENT space (the Armature), which is the space bone.position
// and bone.quaternion are written in — so the update loop needs no conversion.
export interface GoudaBitDef {
  name: string; // Blender's bone name, for the bench readout
  rest: THREE.Vector3; // bone rest translation
  restQuat: THREE.Quaternion; // bone rest rotation
  axis: THREE.Vector3; // bone +Y: out of the wheel
  /** Rest translation measured from the hub — the arm the orbit swings. */
  offset: THREE.Vector3;
  /** Unit radial at rest (hub → bit, flattened onto the wheel's plane). */
  radial: THREE.Vector3;
  phase: number; // deterministic per bit — see hash01
  rate: number;
  spin: number;
  orbit: number; // rad/s about the wheel axis, signed
  driftRate: number; // rad/s of the radial float
}

export interface GoudaTemplate {
  /** The GLB scene, cloned per instance (SkeletonUtils) so bones are private. */
  root: THREE.Object3D;
  bits: GoudaBitDef[];
  /** The wheel's centre, template space — the origin instances are hung from. */
  centre: THREE.Vector3;
  /**
   * The same centre, expressed in the BITS' PARENT space — the space
   * `bone.position` is written in, and therefore the pivot the orbit turns
   * about. (The shipped armature is flat, so all seven bits share one parent.)
   */
  hub: THREE.Vector3;
  /** The wheel's spin axis in that same space: model +Y, pulled back through
   * the armature's own transform rather than assumed. */
  spinAxis: THREE.Vector3;
  /** Template units → world units, so the model matches GOUDA_RADIUS. */
  scale: number;
  map: THREE.Texture | null; // the GLB's baked cheese texture
}

// Deterministic wobble per bit (no Math.random).
function hash01(i: number, k: number): number {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x); // fract() — a plain % 1 would go negative
}

// Find dominant joint (heaviest weight, robust to re-exports).
function dominantJoint(
  skinIndex: THREE.BufferAttribute,
  skinWeight: THREE.BufferAttribute,
  v: number,
): number {
  let best = 0;
  let bestWeight = -1;
  for (let k = 0; k < 4; k++) {
    const w = skinWeight.getComponent(v, k);
    if (w > bestWeight) {
      bestWeight = w;
      best = skinIndex.getComponent(v, k);
    }
  }
  return best;
}

// Measure the shipped rig. Exported for bench/preview.ts. Idempotent.
export function prepareGoudaTemplate(gltf: GLTF): GoudaTemplate {
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  const skinned: THREE.SkinnedMesh[] = [];
  root.traverse((o: THREE.Object3D) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh)
      skinned.push(o as THREE.SkinnedMesh);
  });
  const mesh = skinned[0];
  if (!mesh) throw new Error("golden gouda: GLB has no skinned mesh");
  if (skinned.length > 1)
    console.warn(
      `golden gouda: GLB has ${skinned.length} skinned meshes, using "${mesh.name}"`,
    );

  const geometry = mesh.geometry;
  const skinIndex = geometry.attributes.skinIndex as THREE.BufferAttribute;
  const skinWeight = geometry.attributes.skinWeight as THREE.BufferAttribute;
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const index = geometry.getIndex();
  if (!skinIndex || !skinWeight || !index)
    throw new Error(
      "golden gouda: skinned mesh is missing JOINTS/WEIGHTS/index",
    );

  // Body joint = most verts. Robust to re-export renames. Cache owner per vert.
  const jointVerts = new Int32Array(mesh.skeleton.bones.length);
  const owner = new Int32Array(position.count);
  for (let v = 0; v < position.count; v++) {
    const j = dominantJoint(skinIndex, skinWeight, v);
    owner[v] = j;
    // Broken export: skip invalid joints.
    if (j < jointVerts.length) jointVerts[j]++;
  }
  let bodyJoint = 0;
  for (let j = 1; j < jointVerts.length; j++)
    if (jointVerts[j] > jointVerts[bodyJoint]) bodyJoint = j;

  // Two materials → sort triangles (body first) into groups. Reordering safe.
  const src = index.array;
  const triCount = index.count / 3;
  const bodyTris: number[] = [];
  const bitTris: number[] = [];
  let mixed = 0;
  for (let t = 0; t < triCount; t++) {
    const a = owner[src[t * 3]];
    if (a !== owner[src[t * 3 + 1]] || a !== owner[src[t * 3 + 2]]) mixed++;
    (a === bodyJoint ? bodyTris : bitTris).push(t);
  }
  if (mixed)
    console.warn(
      `golden gouda: ${mixed} triangles span two joints — the body/bit material seam is approximate`,
    );
  const sorted = src.slice();
  let w = 0;
  for (const list of [bodyTris, bitTris])
    for (const t of list)
      for (let e = 0; e < 3; e++) sorted[w++] = src[t * 3 + e];
  index.set(sorted);
  index.needsUpdate = true;
  geometry.clearGroups();
  geometry.addGroup(0, bodyTris.length * 3, 0);
  geometry.addGroup(bodyTris.length * 3, bitTris.length * 3, 1);

  // Group origin = wheel centre. Scale derived from body ring width vs GOUDA_RADIUS.
  // Measured in template space; bits excluded.
  const bodyBox = new THREE.Box3();
  for (let v = 0; v < position.count; v++) {
    if (owner[v] !== bodyJoint) continue;
    bodyBox.expandByPoint(
      _v.fromBufferAttribute(position, v).applyMatrix4(mesh.matrixWorld),
    );
  }
  const centre = bodyBox.getCenter(new THREE.Vector3());
  let radius = 0;
  for (let v = 0; v < position.count; v++) {
    if (owner[v] !== bodyJoint) continue;
    _v.fromBufferAttribute(position, v).applyMatrix4(mesh.matrixWorld);
    radius = Math.max(radius, Math.hypot(_v.x - centre.x, _v.z - centre.z));
  }
  const scale = radius > 1e-6 ? GOUDA_RADIUS / radius : 1;

  // Skip spare bones (no geometry).
  // Orbit pivot: centre in template space → bone space via armature transform.
  const armature = mesh.skeleton.bones[0]?.parent;
  const toBoneSpace = new THREE.Matrix4();
  if (armature) toBoneSpace.copy(armature.matrixWorld).invert();
  const hub = centre.clone().applyMatrix4(toBoneSpace);
  const spinAxis = new THREE.Vector3(0, 1, 0)
    .transformDirection(toBoneSpace)
    .normalize();

  const bits: GoudaBitDef[] = [];
  mesh.skeleton.bones.forEach((bone, j) => {
    if (j === bodyJoint || jointVerts[j] === 0) return;
    const i = bits.length;
    // Rest arm off hub; flat radial perpendicular to spin axis.
    const offset = bone.position.clone().sub(hub);
    const radial = offset
      .clone()
      .addScaledVector(spinAxis, -offset.dot(spinAxis));
    if (radial.lengthSq() < 1e-8) radial.copy(spinAxis); // pole: float up
    radial.normalize();
    bits.push({
      name: bone.name,
      rest: bone.position.clone(),
      restQuat: bone.quaternion.clone(),
      // Bone +Y = out of wheel (artist-aimed).
      axis: BONE_UP.clone().applyQuaternion(bone.quaternion).normalize(),
      offset,
      radial,
      phase: hash01(i, 1) * Math.PI * 2,
      rate: BIT_RATE * (0.7 + hash01(i, 2) * 0.6),
      spin: BIT_SPIN * (0.5 + hash01(i, 3)) * (hash01(i, 4) < 0.5 ? -1 : 1),
      orbit: BIT_ORBIT * (0.4 + hash01(i, 5)) * (hash01(i, 6) < 0.5 ? -1 : 1),
      driftRate: BIT_DRIFT_RATE * (0.6 + hash01(i, 7) * 0.8),
    });
  });

  const material = (
    Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  ) as THREE.MeshStandardMaterial | undefined;

  return {
    root,
    bits,
    centre,
    hub,
    spinAxis,
    scale,
    map: material?.map ?? null,
  };
}

// --- The visual --------------------------------------------------------------

/** A bit and the bone that carries it — one per instance, since bones move. */
export interface GoudaBit {
  bone: THREE.Bone;
  def: GoudaBitDef;
}

export interface GoudaVisual {
  group: THREE.Group;
  lamp: THREE.PointLight;
  glow: THREE.PointLight;
  /** The turning assembly: the whole rig. Null until the GLB lands. */
  wheel: THREE.Group | null;
  bits: GoudaBit[];
  lift: number; // peak upward travel (world u, live-tunable)
  drift: number; // peak radial float (world u, live-tunable)
  orbit: number; // rate multiplier (1 = shipped)
  scale: number; // bone → world units (divide bone lengths by this)
  update(t: number, held?: boolean): void; // t in seconds; held damps motion
  dispose(): void;
}

// Build one Golden Gouda. Group origin = wheel centre.
// Sync contract: cargoSystem mounts same frame. With template: instant build;
// without: lights now, model on fetch.
export function createGoudaVisual(
  template?: GoudaTemplate | null,
): GoudaVisual {
  const group = new THREE.Group();

  const lamp = new THREE.PointLight(0xffb742, LAMP_INTENSITY, LAMP_RANGE, 1.8);
  group.add(lamp);
  const glow = new THREE.PointLight(0xff9c33, GLOW_INTENSITY, GLOW_RANGE, 1.3);
  group.add(glow);

  let goldMat: THREE.MeshToonMaterial | null = null;
  let bitMat: THREE.MeshBasicMaterial | null = null;
  let skeleton: THREE.Skeleton | null = null;
  // World u → bone u: lift compared to radius but written to bones (scaled).
  let boneLift = 1;
  // Orbit pivot & axis in bits' parent space (see template).
  const hub = new THREE.Vector3();
  const spinAxis = new THREE.Vector3(0, 1, 0);
  let disposed = false;

  const visual: GoudaVisual = {
    group,
    lamp,
    glow,
    wheel: null,
    bits: [],
    lift: BIT_LIFT,
    drift: BIT_DRIFT,
    orbit: 1,
    scale: 1,

    update(t: number, held = false) {
      const pulse = 0.75 + 0.25 * Math.sin(t * 0.8);
      lamp.intensity = LAMP_INTENSITY * pulse * (held ? LAMP_HELD : 1);
      glow.intensity = GLOW_INTENSITY * (0.85 + 0.15 * Math.sin(t * 0.31));
      if (goldMat) goldMat.emissiveIntensity = 0.42 + 0.18 * pulse;
      if (!visual.wheel) return;

      // Held: slow spin, no rock.
      const spin = held ? 0.35 : 1;
      visual.wheel.rotation.y = t * 0.5 * spin;
      visual.wheel.rotation.z = held ? 0 : Math.sin(t * 0.21) * 0.25;

      // Three deterministic motions per frame (pure function of t):
      // ORBIT: bit revolves @ own rate/direction. PRE-multiply (parent space).
      // BREATHE: 0…1 out of socket (artist's rest pose = bit in socket).
      // DRIFT: radial float; inward clamped.
      const damp = held ? BIT_HELD : 1;
      const lift = visual.lift * damp * boneLift;
      const drift = visual.drift * damp * boneLift;
      for (const bit of visual.bits) {
        const def = bit.def;
        const breathe = 0.5 - 0.5 * Math.cos(t * def.rate + def.phase);
        const float = Math.sin(t * def.driftRate + def.phase);
        _qOrbit.setFromAxisAngle(
          spinAxis,
          t * def.orbit * visual.orbit + def.phase,
        );
        _out.copy(def.axis).applyQuaternion(_qOrbit);
        _rad.copy(def.radial).applyQuaternion(_qOrbit);
        bit.bone.position
          .copy(def.offset)
          .applyQuaternion(_qOrbit)
          .add(hub)
          .addScaledVector(_out, lift * breathe)
          .addScaledVector(
            _rad,
            drift * (float >= 0 ? float : float * BIT_DRIFT_IN),
          );
        // Orbit: PRE-multiply (parent frame). Roll & wobble: POST-multiply (bone axes).
        bit.bone.quaternion
          .copy(def.restQuat)
          .premultiply(_qOrbit)
          .multiply(_q.setFromAxisAngle(BONE_UP, t * def.spin + def.phase))
          .multiply(
            _q.setFromAxisAngle(
              BONE_SIDE,
              BIT_WOBBLE * Math.sin(t * def.rate * 0.63 + def.phase),
            ),
          );
      }
    },

    dispose() {
      // Free materials & skeleton (per-instance). Keep geometry (shared template).
      disposed = true; // an in-flight load must not mount into a dead group
      goldMat?.dispose();
      bitMat?.dispose();
      skeleton?.dispose();
      skeleton = null;
      group.clear();
      visual.wheel = null;
      visual.bits.length = 0;
    },
  };

  const attach = (tpl: GoudaTemplate): void => {
    if (disposed) return;

    // Two nodes (rig → wheel): rig centers origin; wheel spins. Merged = offset swings.
    const wheel = new THREE.Group();
    const rig = new THREE.Group();
    rig.scale.setScalar(tpl.scale);
    rig.position.copy(tpl.centre).multiplyScalar(-tpl.scale);
    boneLift = 1 / tpl.scale;
    hub.copy(tpl.hub);
    spinAxis.copy(tpl.spinAxis);
    visual.scale = tpl.scale;

    // Clone = shared geometry + fresh skeleton.
    const model = cloneSkinned(tpl.root);
    let mesh: THREE.SkinnedMesh | null = null;
    model.traverse((o: THREE.Object3D) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh)
        mesh ??= o as THREE.SkinnedMesh;
    });
    if (!mesh) return;
    const skin: THREE.SkinnedMesh = mesh;

    // Body: emissive + black-floor ramp (baked texture = albedo + emissive mask).
    // Crater faces lamp @ 0.3 u → clamp diffuse to prevent white bloom.
    const clampBodyLight = (
      shader: THREE.WebGLProgramParametersWithUniforms,
    ): void => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <lights_fragment_end>",
        /* glsl */ `#include <lights_fragment_end>
        reflectedLight.directDiffuse =
          min(reflectedLight.directDiffuse, vec3(${BODY_LIGHT_CAP.toFixed(3)}));
        reflectedLight.indirectDiffuse =
          min(reflectedLight.indirectDiffuse, vec3(${BODY_LIGHT_CAP.toFixed(3)}));`,
      );
    };

    goldMat = toonMaterial(
      {
        color: 0xffc23d,
        map: tpl.map,
        emissive: 0xffa81c,
        emissiveMap: tpl.map,
        emissiveIntensity: 0.55,
      },
      { floor: BODY_FLOOR, shader: clampBodyLight, key: "gouda-body-clamp" },
    );

    // Bits: unlit (close to lamp). Geometry group 1 (sorted triangles).
    bitMat = new THREE.MeshBasicMaterial({ color: 0xffcf72, map: tpl.map });
    skin.material = [goldMat, bitMat];
    skin.castShadow = true;
    skin.frustumCulled = false; // skinned bounds don't follow the bones
    skeleton = skin.skeleton;

    const byName = new Map<string, THREE.Bone>();
    for (const bone of skin.skeleton.bones) byName.set(bone.name, bone);
    for (const def of tpl.bits) {
      const bone = byName.get(def.name);
      if (bone) visual.bits.push({ bone, def });
      else console.warn(`golden gouda: clone lost bone ${def.name}`);
    }

    rig.add(model);
    wheel.add(rig);
    group.add(wheel);
    visual.wheel = wheel;
  };

  const ready = template ?? loadedTemplate;
  if (ready) attach(ready);
  else
    void loadGoudaTemplate().then((tpl) => {
      if (tpl) attach(tpl);
    });

  return visual;
}

// --- Asset load --------------------------------------------------------------
// Shared across instances (same pattern as catfish.ts). Warmed at boot.

let loadedTemplate: GoudaTemplate | null = null;
let templatePromise: Promise<GoudaTemplate | null> | null = null;

export function loadGoudaTemplate(): Promise<GoudaTemplate | null> {
  templatePromise ??= new GLTFLoader()
    .loadAsync(MODEL_URL)
    .then((gltf) => {
      loadedTemplate = prepareGoudaTemplate(gltf);
      return loadedTemplate;
    })
    .catch((err) => {
      console.warn("golden gouda: model failed to load", err);
      return null;
    });
  return templatePromise;
}

// --- Game-side single instance ------------------------------------------------
// graphics.ts hands us the scene at boot (same contract as catfish.ts /
// bathyscaphe.ts); the item kind mounts and unmounts through these.

let gameScene: THREE.Scene | null = null;
let mounted: GoudaVisual | null = null;

export function setGoudaScene(scene: THREE.Scene): void {
  gameScene = scene;
  void loadGoudaTemplate(); // warm the wheel long before the cavern
}

export function mountGouda(): GoudaVisual | null {
  if (!gameScene) return null;
  if (!mounted) {
    mounted = createGoudaVisual();
    gameScene.add(mounted.group);
  }
  return mounted;
}

export function unmountGouda(): void {
  if (!mounted) return;
  gameScene?.remove(mounted.group);
  mounted.dispose();
  mounted = null;
}

export function getMountedGouda(): GoudaVisual | null {
  return mounted;
}
