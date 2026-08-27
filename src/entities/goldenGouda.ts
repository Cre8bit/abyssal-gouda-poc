// goldenGouda.ts — the Golden Gouda itself: the kingdom's lost cheese
// duplicator, still running, still warm (M1.2).
//
// It used to be `goldCore` inside gouda.ts — a decorative centrepiece bolted
// to the world mesh, impossible to pick up because it was part of the map.
// The wheel now lives here as a standalone body, mounted by the item registry
// (game/items.ts kind "gouda") wherever the thing currently IS: hidden in its
// cavern, cradled in a diver's arms, or tumbling down a shaft after a fumble.
//
// Two lights, and they are the whole point of G4 (the light tradeoff): a
// cavern lamp that fills the room it sits in, and a long dim glow that leaks
// out of tunnel mouths from 170 u away. Carrying it means giving up your own
// torch and becoming the party's lamp — and its beacon.
//
// The lamp is DIMMED while the wheel is held, and that is not a cheat: at
// arm's length a light tuned to fill a cavern is a light in your face, and
// the diver's own body shadows most of it anyway. The long glow is untouched,
// so from the outside the carrier is exactly as visible as before — which is
// the half of G4 that matters to everyone else.
//
// Everything here is presentation. Who holds it, where it falls, and whether
// it made it home is game/cargo.ts + systems/cargoSystem.ts.
//
// ── THE RIG ──────────────────────────────────────────────────────────────────
// models/golden_gouda.glb ships a proper skin: one SkinnedMesh plus an
// `Armature` of 8 joints — 7 bones sitting one inside each of the little
// cheese bits that float around the wheel, and Blender's `neutral_bone`,
// which is where the automatic-weights pass parks every vertex no real bone
// claimed. That is the whole wheel: 1027 of the 1238 verts.
//
// So there is nothing to recover here. prepareGoudaTemplate() only MEASURES
// the shipped rig — it never rebuilds it:
//
//   * which joint is the static body (the one owning the most vertices) and
//     which are the bits, read off JOINTS_0/WEIGHTS_0;
//   * where the wheel's centre is and how big it is, so the model matches its
//     own collider (see the scale note below);
//   * each bit bone's rest pose and its +Y axis, which is the direction that
//     bit levitates along.
//
// The binding is exact and one-sided: every vertex has exactly ONE influence
// at weight 1.0, and no triangle spans two joints. That is what lets the
// single mesh carry two materials (below) on a clean triangle boundary — and
// it means the bits are rigid, so the levitation is honest bone motion rather
// than a deformation that has to be tuned.
//
// The bone's own +Y axis is the levitation direction: the bones were placed
// pointing out of the wheel (dot(boneY, radial) is 0.67–1.00 across all 7),
// so "out" is read off the rig rather than assumed to be radial.
//
// ── Lighting gotcha ──────────────────────────────────────────────────────────
// See getInnerGradient(): both lights are inside the wheel's own body, so the
// shared cel ramp's 40/255 floor would clip it to white in first person. The
// body uses a private ramp that floors at true black and gets its warmth from
// emissive; the bits, which orbit within a unit of the lamp, are unlit.
import * as THREE from "three";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { toonMaterial } from "../render/toon.ts";

export const GOUDA_RADIUS = 0.62; // the wheel — a two-armed load, not a boulder

const MODEL_URL = `${import.meta.env.BASE_URL}models/golden_gouda.glb`;

const LAMP_INTENSITY = 620; // cavern lamp: fills the chamber it sits in
const LAMP_RANGE = 80;
const LAMP_HELD = 0.05; // …and drops to a lantern once it is against your chest
const GLOW_INTENSITY = 20; // the leak that gives the hiding place away
const GLOW_RANGE = 170;
// Ceiling on the diffuse the wheel's own body may take from any light — see
// the injection in attach() for why a cel ramp alone cannot save a concave
// model with a lamp inside it.
const BODY_LIGHT_CAP = 0.5;

// Levitation. The bits breathe in and out of their own sockets along the bone
// axis, so the travel has to stay under the depth of the socket or they read
// as debris that fell off rather than as a field holding them up: LIFT is a
// peak-to-rest amplitude of ~7 cm on a 1.24 u wheel, i.e. about half a bit.
const BIT_LIFT = 0.075; // world u, peak travel OUT of the socket (never in)
const BIT_RATE = 0.55; // rad/s, the breathe — slowed per bit by hash below
const BIT_SPIN = 0.3; // rad/s, slow roll about the bone axis
const BIT_WOBBLE = 0.12; // rad, tilt off the rest pose — just enough to live
// Held, the wheel is clamped against a chest: pull the travel in so a bit at
// full extension cannot push through the carrier's body.
const BIT_HELD = 0.45;

// The two axes the bits ride, in BONE-LOCAL space — so they are the same two
// constants for every bit and the rest pose supplies the orientation. Bone +Y
// is "out of the wheel"; the wobble rides the perpendicular X.
const BONE_UP = new THREE.Vector3(0, 1, 0);
const BONE_SIDE = new THREE.Vector3(1, 0, 0);

// The shared cel ramp (render/toon.ts) floors at 40/255 — an "unlit" face
// still takes 16% of the light. That is right for cheese lit from outside,
// and catastrophic here: BOTH of the wheel's lights sit inside its own body,
// so its outward faces take 16% of a light that is 0.6 u away, which clips
// to white and blooms across the carrier's whole screen. So this material
// asks for a ramp floored at true black (`floor: 0`) and the wheel is lit by
// its emissive alone — exactly the way a thing that glows from within should
// be. Only the floor changes: same 4 bands, same ink rim as every model.
const BODY_FLOOR = 0;

// Scratch — reused rather than reallocated: the measuring pass below walks
// every vert once, and the per-frame bit update runs 7 times a frame.
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

// --- The template: the shipped rig, measured -------------------------------

// One levitating bit, as measured off the shipped skeleton. Everything is in
// the bone's PARENT space (the Armature), which is the space bone.position
// and bone.quaternion are written in — so the update loop needs no conversion.
export interface GoudaBitDef {
  name: string; // Blender's bone name, for the bench readout
  rest: THREE.Vector3; // bone rest translation
  restQuat: THREE.Quaternion; // bone rest rotation
  axis: THREE.Vector3; // bone +Y: out of the wheel
  phase: number; // deterministic per bit — see hash01
  rate: number;
  spin: number;
}

export interface GoudaTemplate {
  /** The GLB scene, cloned per instance (SkeletonUtils) so bones are private. */
  root: THREE.Object3D;
  bits: GoudaBitDef[];
  /** The wheel's centre, template space — the origin instances are hung from. */
  centre: THREE.Vector3;
  /** Template units → world units, so the model matches GOUDA_RADIUS. */
  scale: number;
  map: THREE.Texture | null; // the GLB's baked cheese texture
}

// Deterministic wobble per bit: the wheel must look identical on every client
// without spending a byte on it (no Math.random anywhere).
function hash01(i: number, k: number): number {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x); // fract() — a plain % 1 would go negative
}

// The one joint a vertex is bound to. The asset is one-influence-per-vertex at
// weight 1.0, but take the heaviest rather than trusting slot 0: a re-export
// that blends a little would still land every vertex on the right side.
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

// Measure the shipped rig. Exported so the preview bench runs this exact code
// on the exact same asset (see bench/preview.ts).
//
// Idempotent: the bench re-prepares the same GLTF every time you switch back
// to the wheel, and the only thing this mutates is the index ORDER, which is
// already sorted the second time round.
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

  // Which joint is the wheel? The one holding the most vertices. Blender calls
  // it `neutral_bone` on this export, but the rule is what matters: the static
  // body is the bulk of the mesh, the bits are a few dozen verts each. Reading
  // it off the weights means a renamed or re-parented armature still lands.
  // One slot per joint; `owner` is the joint each vertex belongs to, kept so
  // the triangle sort and the body measurement below don't re-derive it.
  const jointVerts = new Int32Array(mesh.skeleton.bones.length);
  const owner = new Int32Array(position.count);
  for (let v = 0; v < position.count; v++) {
    const j = dominantJoint(skinIndex, skinWeight, v);
    owner[v] = j;
    // A joint index past the end of the skeleton is a broken export, not
    // something to crash on: those verts simply belong to no bit.
    if (j < jointVerts.length) jointVerts[j]++;
  }
  let bodyJoint = 0;
  for (let j = 1; j < jointVerts.length; j++)
    if (jointVerts[j] > jointVerts[bodyJoint]) bodyJoint = j;

  // Two materials on one mesh: the wheel is cel-shaded and light-capped, the
  // bits are unlit (see attach()). A SkinnedMesh draws a material array
  // through geometry GROUPS, which have to be contiguous index ranges — so
  // sort the triangles, body first, and hand out two groups. Skinning is
  // per-vertex, so reordering the index buffer changes nothing about the rig.
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
  // Written element by element rather than through a spread: a denser
  // re-export would hand Function.prototype.apply more arguments than it takes.
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

  // The group origin is the wheel's CENTRE (cargoSystem positions the group
  // and collides it as a sphere of GOUDA_RADIUS), and the scale is derived
  // rather than hard-coded: fit the body's widest horizontal ring to
  // GOUDA_RADIUS so a re-export at a different scale still matches its own
  // collider instead of needing a magic number bumped here.
  //
  // Measured in TEMPLATE space — the mesh's own transform baked in, so verts
  // and bones share one space — and the bits are excluded so a levitating
  // speck can never grow the wheel it is orbiting.
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

  // Every joint that is not the body is a bit — as long as it actually owns
  // geometry. A spare bone the artist left behind owns nothing and would
  // otherwise become an invisible bit burning a slot in the update loop.
  const bits: GoudaBitDef[] = [];
  mesh.skeleton.bones.forEach((bone, j) => {
    if (j === bodyJoint || jointVerts[j] === 0) return;
    bits.push({
      name: bone.name,
      rest: bone.position.clone(),
      restQuat: bone.quaternion.clone(),
      // Bone +Y is "out of the wheel" (the artist aimed them that way), in
      // the parent space bone.position lives in.
      axis: BONE_UP.clone().applyQuaternion(bone.quaternion).normalize(),
      phase: hash01(bits.length, 1) * Math.PI * 2,
      rate: BIT_RATE * (0.7 + hash01(bits.length, 2) * 0.6),
      spin:
        BIT_SPIN *
        (0.5 + hash01(bits.length, 3)) *
        (hash01(bits.length, 4) < 0.5 ? -1 : 1),
    });
  });

  const material = (
    Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  ) as THREE.MeshStandardMaterial | undefined;

  return { root, bits, centre, scale, map: material?.map ?? null };
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
  /** Peak outward travel of a bit, world u — live-tunable from the bench. */
  lift: number;
  /**
   * Bone units → world units. Bones live in the model's own space, so anything
   * drawn as a child of one (the bench's axis arrows) is sized in bone units;
   * divide by this to quote a length in world u. 1 until the GLB lands.
   */
  scale: number;
  // t: seconds. `held` pulls the bits into their sockets and steadies the
  // spin — in someone's arms the duplicator is pinned, not floating free.
  update(t: number, held?: boolean): void;
  dispose(): void;
}

// Build one Golden Gouda. Group origin = the wheel's centre; the caller
// decides where that sits (cavern, arms, or mid-tumble).
//
// Synchronous by contract — cargoSystem mounts the wheel the instant the item
// spawns and starts positioning `group` the same frame. Pass `template` to
// build the meshes now (the bench already holds the GLB); pass nothing and the
// lights come up immediately while the model drops in when the fetch lands.
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
  // World u → bone-local u. `lift` is quoted in world units (it is compared
  // against the wheel's radius and a diver's chest), but it is written into
  // bone.position, which the rig group then scales.
  let boneLift = 1;
  let disposed = false;

  const visual: GoudaVisual = {
    group,
    lamp,
    glow,
    wheel: null,
    bits: [],
    lift: BIT_LIFT,
    scale: 1,

    update(t: number, held = false) {
      const pulse = 0.75 + 0.25 * Math.sin(t * 0.8);
      lamp.intensity = LAMP_INTENSITY * pulse * (held ? LAMP_HELD : 1);
      glow.intensity = GLOW_INTENSITY * (0.85 + 0.15 * Math.sin(t * 0.31));
      if (goldMat) goldMat.emissiveIntensity = 0.42 + 0.18 * pulse;
      if (!visual.wheel) return;

      // Held, the wheel is clamped under an arm: it keeps turning (it never
      // stops turning) but slowly, and it stops rocking.
      const spin = held ? 0.35 : 1;
      visual.wheel.rotation.y = t * 0.5 * spin;
      visual.wheel.rotation.z = held ? 0 : Math.sin(t * 0.21) * 0.25;

      // The bits are bones INSIDE the turning assembly, so they stay over
      // their own sockets while the wheel spins, and all they do here is
      // levitate: rise out along the bone's own +Y and settle back, roll
      // slowly about it, and tilt a little so nothing looks keyframed to the
      // same beat. Writing the rest pose back every frame (rather than
      // accumulating) keeps this stateless — the pose is a pure function of t.
      //
      // The breathe is 0…1, not −1…1, and that is the whole trick: the rest
      // pose the artist modelled IS the bit sitting in its socket, so travel
      // outward is levitation and travel inward is the bit disappearing into
      // the wheel it just came out of. One-sided, it reads as in→out→in.
      const lift = visual.lift * (held ? BIT_HELD : 1) * boneLift;
      for (const bit of visual.bits) {
        const def = bit.def;
        const breathe = 0.5 - 0.5 * Math.cos(t * def.rate + def.phase);
        bit.bone.position
          .copy(def.rest)
          .addScaledVector(def.axis, lift * breathe);
        // Post-multiplied, so both turns are about the BONE's own axes and
        // the rest pose stays the frame they are measured in.
        bit.bone.quaternion
          .copy(def.restQuat)
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
      // Materials are per-instance, so they are ours to free — and so is the
      // SKELETON: SkeletonUtils.clone() gives every instance its own bones and
      // its own bone texture. The GEOMETRY is not ours: it belongs to the
      // shared template, and the game unmounts/remounts the wheel every time
      // the cargo changes hands (cargoSystem's item kind), so disposing it
      // here would leave the next mount drawing from a released buffer.
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

    // Two nodes, and they cannot be merged: `rig` puts the wheel's centre on
    // the origin at world scale, and `wheel` spins about that origin. One node
    // carrying both would swing the offset around with the rotation.
    const wheel = new THREE.Group();
    const rig = new THREE.Group();
    rig.scale.setScalar(tpl.scale);
    rig.position.copy(tpl.centre).multiplyScalar(-tpl.scale);
    boneLift = 1 / tpl.scale;
    visual.scale = tpl.scale;

    // Private bones per instance. The clone shares the template's geometry
    // (and gets a fresh Skeleton, hence the dispose above).
    const model = cloneSkinned(tpl.root);
    let mesh: THREE.SkinnedMesh | null = null;
    model.traverse((o: THREE.Object3D) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh)
        mesh ??= o as THREE.SkinnedMesh;
    });
    if (!mesh) return;
    const skin: THREE.SkinnedMesh = mesh;

    // The warmth you see on the cheese is emissive, not lighting (see
    // BODY_FLOOR); the GLB's baked texture supplies the rind and the holes,
    // tinted gold, and doubles as the emissive mask so the holes glow darker
    // than the paste instead of the whole wheel flaring evenly.
    //
    // The black-floored ramp is not enough on its own for a SCULPT. It fixes
    // faces that point away from the wheel's own lights (the whole outer
    // shell — unlit, so emissive-only, which is the look we want), but this
    // model is concave: the bitten-out crater faces INWARD, straight at a
    // 620-intensity lamp 0.3 u away. The cel ramp quantizes the light's
    // ANGLE, never its magnitude, so that face arrives at ~5000× albedo and
    // clips to a white hole that blooms across the carrier's screen.
    //
    // So cap the diffuse the wheel can take. The crater lands on "fully lit
    // gold cheese" instead of "white", the outer shell is untouched (it takes
    // no diffuse at all), and a passing diver's torch — orders of magnitude
    // weaker than the lamp — stays under the cap and still shades normally.
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

    // The bits are the one part that must NOT be lit: they levitate within a
    // unit of the lamp, and any lit material there is a fistful of white
    // pixels blooming across the bottom of the carrier's screen. Unlit
    // texture reads as glowing debris and cannot blow out no matter how
    // bright the wheel is set. They ride the mesh's second geometry group
    // (prepareGoudaTemplate sorted the triangles to make that seam).
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
// One fetch per session, shared by every instance (same contract as
// catfish.ts / bathyscaphe.ts). Kicked off at boot by setGoudaScene(), so the
// template is long since warm by the time anyone reaches the cavern.

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
