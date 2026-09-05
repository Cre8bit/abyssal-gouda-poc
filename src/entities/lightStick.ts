// entities/lightStick.ts — the light stick: the throwable chem vial a diver
// wears clipped to its belt and lobs into the dark ahead (M3.2). Like the
// driller the shipped GLB has no rig and no clips, so
// prepareLightStickTemplate() only MEASURES it: the bounding box scales the
// longest dimension to LIGHT_STICK_LENGTH, and of the model's two meshes the
// BIGGER one is the vial — the part that burns. It is re-materialled UNLIT
// and handed the point light (a light source, not a surface — see the
// lighting note in AGENTS.md: a cel-shaded body with a lamp 0 u inside it
// clips to white and blooms over the screen), while the carabiner that clips
// it to the belt stays cel-shaded hardware.
//
// Presentation only. The three arm poses a diver moves through around it
// (belt grab → hold → throw) live in entities/diverRig.ts as the "lightStick"
// grip's states, and are authored in the bench pose editor.
import * as THREE from "three";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import { toonify } from "../render/toon.ts";

// Longest dimension, world units — a one-paw baton, half the driller's reach
// (a rat diver is ~1.33 u tall).
export const LIGHT_STICK_LENGTH = 0.2;

const MODEL_URL = `${import.meta.env.BASE_URL}models/light_stick.glb`;

const IDLE_BOB = 0.02; // world u, resting-in-the-world bob
const IDLE_RATE = 1.1; // rad/s

// The chemical burn: cold green-cyan, so it never reads as a diver's torch.
const GLOW_COLOR = 0x66ffd1;
const LIGHT_INTENSITY = 130; // lights a pocket, not a chamber
const LIGHT_RANGE = 40;
const LIGHT_DECAY = 1.6;
// Two orders of magnitude apart on purpose: loose in the water the burn has
// to reach across a gallery, but in a paw it is 0.3 u from a cel-shaded body,
// where anything above ~1 puts the whole diver on the top band and the rat
// turns into a green lamp (same reason the Golden Gouda's lamp has LAMP_HELD).
const LIGHT_HELD = 0.6; // absolute intensity while carried
const IGNITE_RATE = 3; // 1/s — how fast the burn comes up when lit
const FLICKER = 0.08; // fraction of intensity the burn wanders by
// The clip sits ~0.05 u from the burn, so it arrives at hundreds of times its
// own albedo: cap it or the cel ramp lands it on white and blooms. Measured in
// ALBEDO MULTIPLES — 1 is "fully lit", and the clip's texture is dark anodised
// metal, so it takes a few of them to read as hardware standing in a green
// glow rather than as a silhouette.
const CLIP_LIGHT_CAP = 3;
// How dark the vial reads when the burn is out — a spent stick is still a
// green tube, just an inert one.
const VIAL_DARK = 0.18;

const VIAL_NAME = "LightStickVial";
const _box = new THREE.Box3();
const _v = new THREE.Vector3();
const _spinAxis = new THREE.Vector3();
const _spinQ = new THREE.Quaternion();
const _bob = new THREE.Vector3();

// --- The template: the shipped model, measured -----------------------------

export interface LightStickTemplate {
  /** The GLB scene, cloned per instance. */
  root: THREE.Object3D;
  /** Template units → world units, so the model matches LIGHT_STICK_LENGTH. */
  scale: number;
  /** Bounding-box centre, template space — instances hang from this. */
  centre: THREE.Vector3;
  /** Template-space long axis of the baton. */
  axis: THREE.Vector3;
  /** Vial centre in template space, where the light hangs. */
  glowAt: THREE.Vector3;
}

// Measure the shipped model. Exported for bench/preview.ts. Idempotent.
export function prepareLightStickTemplate(gltf: GLTF): LightStickTemplate {
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  const scale = longest > 1e-6 ? LIGHT_STICK_LENGTH / longest : 1;
  const axis = new THREE.Vector3(
    size.x === longest ? 1 : 0,
    size.x !== longest && size.y === longest ? 1 : 0,
    size.x !== longest && size.y !== longest ? 1 : 0,
  );
  const glow = markGlow(root);
  const glowAt = glow
    ? _box.setFromObject(glow).getCenter(new THREE.Vector3())
    : centre.clone();
  return { root, scale, centre, axis, glowAt };
}

// Name the vial so instances can find it after a clone: of the model's
// meshes, the one that fills the most space. Idempotent.
function markGlow(root: THREE.Object3D): THREE.Object3D | null {
  const found = root.getObjectByName(VIAL_NAME);
  if (found) return found;
  const meshes: THREE.Object3D[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o);
  });
  if (!meshes.length) return null;
  const bulk = (o: THREE.Object3D) => {
    _box.setFromObject(o).getSize(_v);
    return _v.x * _v.y * _v.z;
  };
  const glow = meshes.reduce((a, b) => (bulk(b) > bulk(a) ? b : a));
  glow.name = VIAL_NAME;
  return glow;
}

// Keep the carabiner off the top band however close the burn is — by capping
// the IRRADIANCE it receives, not the shaded result. A flat min() on
// reflectedLight pins every channel at the cap, which is the same value on
// every texel: the clip goes uniformly white and its texture disappears (it
// has one — dark metal, painted into the same atlas as the vial). So divide
// the surface's own albedo back out, clamp what is left, and put the albedo
// back. The clamp scales the whole triple by its peak channel rather than
// clamping each one, so the burn's green still tints the hardware standing
// in it instead of washing out to neutral.
function capClipLight(shader: THREE.WebGLProgramParametersWithUniforms): void {
  const cap = CLIP_LIGHT_CAP.toFixed(3);
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <lights_fragment_end>",
    /* glsl */ `#include <lights_fragment_end>
    {
      vec3 albedo = max(material.diffuseColor, vec3(1e-4));
      vec3 direct = reflectedLight.directDiffuse / albedo;
      vec3 indirect = reflectedLight.indirectDiffuse / albedo;
      float dPeak = max(direct.r, max(direct.g, direct.b));
      float iPeak = max(indirect.r, max(indirect.g, indirect.b));
      reflectedLight.directDiffuse =
        direct * min(1.0, ${cap} / max(dPeak, 1e-4)) * albedo;
      reflectedLight.indirectDiffuse =
        indirect * min(1.0, ${cap} / max(iPeak, 1e-4)) * albedo;
    }`,
  );
}

// --- The burn's light: a fixed pool, never added, removed or hidden ----------
// three bakes the scene's light COUNT into every lit material's program, and
// `visible = false` takes a light out of that count — so mounting, hiding or
// unmounting one baton's lamp relinks every material in the scene. That is the
// stall the OTHER divers eat when somebody draws or throws a stick; the
// thrower is spared because their paw light dies in the same frame the thrown
// one is born, so their count never moves. The game therefore gets a fixed set
// of point lights that live in the scene forever: each frame the brightest few
// burns are written into them and every other burn is written to intensity 0,
// which costs a few ALU and no compile. A bench that never installs a scene
// keeps one light per visual — nothing to stall there.
const STICK_LIGHT_SLOTS = 6;
// A baton in a paw is a hand's width from its holder and lights the paw
// itself, so it outranks the gallery it is standing in whatever the raw
// candela say.
const HELD_PRIORITY = 30;
// How much better a challenger must score to take an occupied slot: without a
// margin two batons at the same range trade the slot every frame.
const SLOT_HOLD = 1.25;

// One burning stick's claim on the pool, refreshed by its own update().
interface Burn {
  at: THREE.Vector3;
  want: number;
  priority: number;
  score: number;
  slot: number;
}

const burns = new Set<Burn>();
const pool: THREE.PointLight[] = [];
const slotOwner: (Burn | null)[] = [];

// Hand the pool to the brightest burns, nearest first. Once per frame from
// the render loop, after every stick has posed itself.
export function updateLightStickLights(cameraPos: THREE.Vector3): void {
  if (!pool.length) return;
  const ranked: Burn[] = [];
  for (const b of burns) {
    b.score =
      b.want <= 0
        ? 0
        : (b.want * b.priority * (b.slot >= 0 ? SLOT_HOLD : 1)) /
          (1 + cameraPos.distanceToSquared(b.at));
    if (b.score > 0) ranked.push(b);
  }
  ranked.sort((a, z) => z.score - a.score);
  ranked.length = Math.min(ranked.length, pool.length);
  // Losers let go first, so every winner finds a free slot.
  for (let i = 0; i < pool.length; i++) {
    const owner = slotOwner[i];
    if (!owner || ranked.includes(owner)) continue;
    owner.slot = -1;
    slotOwner[i] = null;
    pool[i].intensity = 0;
  }
  for (const b of ranked) {
    if (b.slot < 0) b.slot = slotOwner.indexOf(null);
    slotOwner[b.slot] = b;
    pool[b.slot].position.copy(b.at);
    pool[b.slot].intensity = b.want;
  }
}

// --- The visual --------------------------------------------------------------

export interface LightStickVisual {
  group: THREE.Group;
  /** The model, once loaded. Null until the GLB lands. */
  model: THREE.Object3D | null;
  /** The vial mesh, once the model has landed. */
  vial: THREE.Object3D | null;
  /** Its own light — null in the game, where the pool above owns them. */
  light: THREE.PointLight | null;
  update(t: number, held?: boolean): void;
  /** The baton's resting attitude (euler radians), set once when it lands in
   *  the world: a chem stick loose in the water is never axis-aligned. */
  setTilt(x: number, y: number, z: number): void;
  /** Turn it by an angular velocity (rad/s about world axes) for dt — the
   *  tumble a thrown baton keeps until the water has taken it out. */
  spin(x: number, y: number, z: number, dt: number): void;
  /** Strike or snuff the burn — ramps over ~a third of a second. */
  setLit(on: boolean): void;
  isLit(): boolean;
  /** Burn level, 0…1 — 0 when dark. */
  burn(): number;
  /** Hide the burn's own light, keeping the lit vial (the pose bench). */
  setLightOn(on: boolean): void;
  /** Override the shipped length (bench sizing knob). */
  setLength(u: number): void;
  dispose(): void;
}

// Build one light stick. Group origin = model's own bounding-box centre, so
// the baton spins about its middle and a grip offset means the same thing at
// any length. With template: instant build; without: group now, model on
// fetch (same pattern as driller.ts).
export function createLightStickVisual(
  template?: LightStickTemplate | null,
): LightStickVisual {
  const group = new THREE.Group();
  let disposed = false;
  let tpl: LightStickTemplate | null = null;
  let length = LIGHT_STICK_LENGTH;
  let lit = true;
  let level = 1;
  let lastT: number | null = null;
  let lightOn = true;
  let vialMat: THREE.MeshBasicMaterial | null = null;

  // Unlit vial + a light: a body lit from 0 u inside itself clips to white
  // through the shared cel ramp (see AGENTS.md). In the game the light comes
  // from the pool above; standalone (the benches) the visual carries one.
  const glowOffset = new THREE.Vector3();
  // Where fit() parks the model so the GROUP's origin is the baton's middle.
  // Kept because the idle bob rides on top of it: writing the bob straight
  // into model.position.y threw the y half of the centring away, which put
  // the group origin at the baton's BASE — half a baton off the paw the pose
  // editor placed it in, and an off-centre axis for the throw's tumble.
  const centred = new THREE.Vector3();
  const burn: Burn | null = pool.length
    ? { at: new THREE.Vector3(), want: 0, priority: 1, score: 0, slot: -1 }
    : null;
  const light = burn
    ? null
    : new THREE.PointLight(
        GLOW_COLOR,
        LIGHT_INTENSITY,
        LIGHT_RANGE,
        LIGHT_DECAY,
      );
  if (light) group.add(light);
  if (burn) burns.add(burn);

  const visual: LightStickVisual = {
    group,
    model: null,
    vial: null,
    light,

    update(t: number, held = false) {
      const dt = lastT === null ? 0 : Math.min(Math.max(t - lastT, 0), 0.1);
      lastT = t;
      level += ((lit ? 1 : 0) - level) * Math.min(1, IGNITE_RATE * dt);
      const flicker = 1 + FLICKER * Math.sin(t * 7.3) * Math.sin(t * 2.9);
      const want =
        lightOn && level > 0.01
          ? (held ? LIGHT_HELD : LIGHT_INTENSITY) * level * flicker
          : 0;
      if (light) light.intensity = want;
      if (burn) {
        burn.want = want;
        burn.priority = held ? HELD_PRIORITY : 1;
        if (want > 0) {
          group.updateWorldMatrix(true, false);
          burn.at.copy(glowOffset).applyMatrix4(group.matrixWorld);
        }
      }
      if (vialMat) vialMat.color.setHex(GLOW_COLOR).multiplyScalar(VIAL_DARK + (1 - VIAL_DARK) * level); // prettier-ignore
      if (!visual.model) return;
      // Idle bob when resting in the world; steady while carried. The group
      // itself is tilted (a baton at rest lies at whatever angle it stopped
      // at), so the bob is un-rotated back into the world before it is
      // applied — otherwise a stick drifts along its own length, not upward.
      visual.model.position.copy(centred);
      if (held) return;
      _bob
        .set(0, Math.sin(t * IDLE_RATE) * IDLE_BOB, 0)
        .applyQuaternion(_spinQ.copy(group.quaternion).invert());
      visual.model.position.add(_bob);
    },

    setTilt(x: number, y: number, z: number) {
      group.rotation.set(x, y, z);
    },

    spin(x: number, y: number, z: number, dt: number) {
      const rate = Math.hypot(x, y, z);
      if (rate < 1e-5 || dt <= 0) return;
      _spinAxis.set(x / rate, y / rate, z / rate);
      _spinQ.setFromAxisAngle(_spinAxis, rate * dt);
      // premultiply: the axis is the WORLD's, not the tumbling baton's own.
      group.quaternion.premultiply(_spinQ).normalize();
    },

    setLit(on: boolean) {
      lit = on;
    },
    isLit: () => lit,
    burn: () => level,

    setLightOn(on: boolean) {
      lightOn = on;
    },

    setLength(u: number) {
      length = u;
      if (tpl && visual.model) fit(visual.model, tpl);
    },

    dispose() {
      disposed = true; // an in-flight load must not mount into a dead group
      if (light) {
        group.remove(light);
        light.dispose();
      }
      if (burn) {
        if (burn.slot >= 0) {
          pool[burn.slot].intensity = 0;
          slotOwner[burn.slot] = null;
        }
        burns.delete(burn);
      }
      group.clear();
      vialMat?.dispose();
      vialMat = null;
      visual.model = null;
      visual.vial = null;
    },
  };

  // Scale + centre the clone so the group's origin is the baton's middle.
  const fit = (model: THREE.Object3D, t: LightStickTemplate): void => {
    const s = t.scale * (length / LIGHT_STICK_LENGTH);
    model.scale.setScalar(s);
    centred.copy(t.centre).multiplyScalar(-s);
    model.position.copy(centred);
    glowOffset.copy(t.glowAt).sub(t.centre).multiplyScalar(s);
    light?.position.copy(glowOffset);
  };

  const attach = (t: LightStickTemplate): void => {
    if (disposed) return;
    tpl = t;
    const model = t.root.clone(true);
    // Same cel bands + ink rim as every other model, black-floored and
    // light-capped: the hardware is a hand's width from its own lamp.
    toonify(model, {
      floor: 0,
      shader: capClipLight,
      key: "light-stick-clip",
    });
    fit(model, t);
    group.add(model);
    visual.model = model;
    const vial = model.getObjectByName(VIAL_NAME) as THREE.Mesh | undefined;
    if (vial) {
      const lit = vial.material as THREE.MeshStandardMaterial | undefined;
      vialMat = new THREE.MeshBasicMaterial({ map: lit?.map ?? null });
      vial.material = vialMat;
      visual.vial = vial;
    }
  };

  const ready = template ?? loadedTemplate;
  if (ready) attach(ready);
  else
    void loadLightStickTemplate().then((t) => {
      if (t) attach(t);
    });

  return visual;
}

// --- Asset load ----------------------------------------------------------
// Shared across instances (same pattern as driller.ts). Warmed at boot.

let loadedTemplate: LightStickTemplate | null = null;
let templatePromise: Promise<LightStickTemplate | null> | null = null;

export function loadLightStickTemplate(): Promise<LightStickTemplate | null> {
  templatePromise ??= new GLTFLoader()
    .loadAsync(MODEL_URL)
    .then((gltf) => {
      loadedTemplate = prepareLightStickTemplate(gltf);
      return loadedTemplate;
    })
    .catch((err) => {
      console.warn("lightStick: model failed to load", err);
      return null;
    });
  return templatePromise;
}

// --- Game-side world instances -----------------------------------------------
// graphics.ts hands us the scene at boot (same contract as driller.ts). Unlike
// the driller there is no single stick: every thrown baton is its own item, so
// the registry is keyed by item id. Sticks held IN A PAW are not here — those
// belong to the diver's rig and graphics.ts owns them.

let gameScene: THREE.Scene | null = null;
const mounted = new Map<string, LightStickVisual>();

export function setLightStickScene(scene: THREE.Scene): void {
  gameScene = scene;
  // Built once, never touched again — see the note on the pool.
  while (pool.length < STICK_LIGHT_SLOTS) {
    const light = new THREE.PointLight(GLOW_COLOR, 0, LIGHT_RANGE, LIGHT_DECAY);
    scene.add(light);
    pool.push(light);
    slotOwner.push(null);
  }
  void loadLightStickTemplate(); // warm it before the first throw
}

export function mountLightStick(id: string): LightStickVisual | null {
  if (!gameScene) return null;
  let visual = mounted.get(id);
  if (!visual) {
    visual = createLightStickVisual();
    gameScene.add(visual.group);
    mounted.set(id, visual);
  }
  return visual;
}

export function unmountLightStick(id: string): void {
  const visual = mounted.get(id);
  if (!visual) return;
  mounted.delete(id);
  visual.group.removeFromParent();
  visual.dispose();
}

export function getMountedLightStick(id: string): LightStickVisual | null {
  return mounted.get(id) ?? null;
}
