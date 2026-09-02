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
// The clip sits ~0.05 u from the burn: cap its diffuse or the cel ramp lands
// it on white and blooms (same fix as the Gouda's crater).
const CLIP_LIGHT_CAP = 0.55;
// How dark the vial reads when the burn is out — a spent stick is still a
// green tube, just an inert one.
const VIAL_DARK = 0.18;

const VIAL_NAME = "LightStickVial";
const _box = new THREE.Box3();
const _v = new THREE.Vector3();

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

// Keep the carabiner off the top band however close the burn is.
function capClipLight(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <lights_fragment_end>",
    /* glsl */ `#include <lights_fragment_end>
    reflectedLight.directDiffuse =
      min(reflectedLight.directDiffuse, vec3(${CLIP_LIGHT_CAP.toFixed(3)}));
    reflectedLight.indirectDiffuse =
      min(reflectedLight.indirectDiffuse, vec3(${CLIP_LIGHT_CAP.toFixed(3)}));`,
  );
}

// --- The visual --------------------------------------------------------------

export interface LightStickVisual {
  group: THREE.Group;
  /** The model, once loaded. Null until the GLB lands. */
  model: THREE.Object3D | null;
  /** The vial mesh, once the model has landed. */
  vial: THREE.Object3D | null;
  light: THREE.PointLight;
  update(t: number, held?: boolean): void;
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

  // Unlit vial + its own light: a body lit from 0 u inside itself clips to
  // white through the shared cel ramp (see AGENTS.md).
  const light = new THREE.PointLight(
    GLOW_COLOR,
    LIGHT_INTENSITY,
    LIGHT_RANGE,
    LIGHT_DECAY,
  );
  group.add(light);

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
      light.intensity = (held ? LIGHT_HELD : LIGHT_INTENSITY) * level * flicker;
      light.visible = lightOn && level > 0.01;
      if (vialMat) vialMat.color.setHex(GLOW_COLOR).multiplyScalar(VIAL_DARK + (1 - VIAL_DARK) * level); // prettier-ignore
      if (!visual.model) return;
      // Idle bob when resting in the world; steady while carried.
      visual.model.position.y = held ? 0 : Math.sin(t * IDLE_RATE) * IDLE_BOB;
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
      group.remove(light);
      light.dispose();
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
    model.position.copy(t.centre).multiplyScalar(-s);
    light.position.copy(t.glowAt).sub(t.centre).multiplyScalar(s);
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
