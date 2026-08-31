// entities/driller.ts — the driller: the one tool that opens hardness 1-2
// rind fast and loud (M3.1). The shipped GLB has no rig and no clips, so
// prepareDrillerTemplate() MEASURES it: the bounding box scales the longest
// dimension to DRILLER_LENGTH, and that same long axis is the axis the bit
// turns about. The bit — the shortest of the model's meshes along that axis,
// i.e. the business end — is re-parented under a pivot group centred on it,
// which is the one node this file animates.
//
// Standalone body mounted by item registry (game/items.ts kind "driller").
// Presentation only — pick/drop/carry logic lives in systems/drillerSystem.ts.
import * as THREE from "three";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import { toonify } from "../render/toon.ts";

// Longest dimension, world units — a two-handed tool, well inside arm reach.
export const DRILLER_LENGTH = 0.8;

const MODEL_URL = `${import.meta.env.BASE_URL}models/drill_tool.glb`;

const IDLE_BOB = 0.03; // world u, resting-in-the-world bob
const IDLE_RATE = 0.9; // rad/s

// The bit's spin, driven by strike(): one bite of cheese holds the throttle
// open for STRIKE_S, then the bit coasts down. Under the dig cooldown
// (400 ms) held fire reads as one continuous run.
const SPIN_MAX = 24; // rad/s at full chew
const SPIN_UP = 90; // rad/s², throttle open
const SPIN_DOWN = 18; // rad/s², coasting down
const STRIKE_S = 0.5; // s the throttle stays open per bite

const BIT_PIVOT = "DrillBitPivot";
const _size = new THREE.Vector3();

// --- The template: the shipped model, measured -----------------------------

export interface DrillerTemplate {
  /** The GLB scene, cloned per instance. */
  root: THREE.Object3D;
  /** Template units → world units, so the model matches DRILLER_LENGTH. */
  scale: number;
  /** Bounding-box centre, template space — instances hang from this. */
  centre: THREE.Vector3;
  /** Template-space axis the bit turns about (the tool's long axis). */
  spinAxis: THREE.Vector3;
}

// Measure the shipped model. Exported for bench/preview.ts. Idempotent.
export function prepareDrillerTemplate(gltf: GLTF): DrillerTemplate {
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  const scale = longest > 1e-6 ? DRILLER_LENGTH / longest : 1;
  const spinAxis = new THREE.Vector3(
    size.x === longest ? 1 : 0,
    size.x !== longest && size.y === longest ? 1 : 0,
    size.x !== longest && size.y !== longest ? 1 : 0,
  );
  isolateBit(root, spinAxis);
  return { root, scale, centre, spinAxis };
}

// Re-parent the tool's business end under a pivot centred on it, so an
// instance can turn the bit without moving the body. Idempotent.
function isolateBit(root: THREE.Object3D, axis: THREE.Vector3): void {
  if (root.getObjectByName(BIT_PIVOT)) return;
  const meshes: THREE.Object3D[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o);
  });
  if (meshes.length < 2) return;
  // The bit is the piece with the shortest reach along the tool's length.
  const span = (o: THREE.Object3D) =>
    new THREE.Box3().setFromObject(o).getSize(_size).dot(axis);
  const bit = meshes.reduce((a, b) => (span(b) < span(a) ? b : a));
  const parent = bit.parent ?? root;

  const pivot = new THREE.Group();
  pivot.name = BIT_PIVOT;
  pivot.position.copy(
    parent.worldToLocal(
      new THREE.Box3().setFromObject(bit).getCenter(new THREE.Vector3()),
    ),
  );
  parent.add(pivot);
  bit.position.sub(pivot.position); // pivot is unrotated: same composite pose
  pivot.add(bit);
  root.updateMatrixWorld(true);
}

// --- The visual --------------------------------------------------------------

export interface DrillerVisual {
  group: THREE.Group;
  /** The model, once loaded. Null until the GLB lands. */
  model: THREE.Object3D | null;
  /** The bit's pivot, once the model has landed. */
  bit: THREE.Object3D | null;
  update(t: number, held?: boolean): void;
  /** One bite of cheese: hold the bit's throttle open for a moment. */
  strike(): void;
  /** Bit speed, rad/s — 0 when idle. */
  spinRate(): number;
  dispose(): void;
}

// Build one driller. Group origin = model's own bounding-box centre.
// Sync contract: drillerSystem mounts same frame. With template: instant
// build; without: group now, model on fetch (same pattern as goldenGouda.ts).
export function createDrillerVisual(
  template?: DrillerTemplate | null,
): DrillerVisual {
  const group = new THREE.Group();
  let disposed = false;
  const axis = new THREE.Vector3(0, 1, 0);
  let lastT: number | null = null;
  let strikeTimer = 0;
  let spin = 0;
  let angle = 0;

  const visual: DrillerVisual = {
    group,
    model: null,
    bit: null,

    update(t: number, held = false) {
      const dt = lastT === null ? 0 : Math.min(Math.max(t - lastT, 0), 0.1);
      lastT = t;
      if (!visual.model) return;
      // Idle bob when resting in the world; steady while carried.
      visual.model.position.y = held ? 0 : Math.sin(t * IDLE_RATE) * IDLE_BOB;

      if (strikeTimer > 0) {
        strikeTimer -= dt;
        spin = Math.min(SPIN_MAX, spin + SPIN_UP * dt);
      } else if (spin > 0) {
        spin = Math.max(0, spin - SPIN_DOWN * dt);
      }
      if (visual.bit && spin > 0) {
        angle = (angle + spin * dt) % (Math.PI * 2);
        visual.bit.setRotationFromAxisAngle(axis, angle);
      }
    },

    strike() {
      strikeTimer = STRIKE_S;
    },

    spinRate: () => spin,

    dispose() {
      disposed = true; // an in-flight load must not mount into a dead group
      group.clear();
      visual.model = null;
      visual.bit = null;
    },
  };

  const attach = (tpl: DrillerTemplate): void => {
    if (disposed) return;
    const model = tpl.root.clone(true);
    toonify(model); // same cel bands + ink rim as every other model
    model.scale.setScalar(tpl.scale);
    model.position.copy(tpl.centre).multiplyScalar(-tpl.scale);
    group.add(model);
    visual.model = model;
    visual.bit = model.getObjectByName(BIT_PIVOT) ?? null;
    axis.copy(tpl.spinAxis);
  };

  const ready = template ?? loadedTemplate;
  if (ready) attach(ready);
  else
    void loadDrillerTemplate().then((tpl) => {
      if (tpl) attach(tpl);
    });

  return visual;
}

// --- Asset load ----------------------------------------------------------
// Shared across instances (same pattern as goldenGouda.ts). Warmed at boot.

let loadedTemplate: DrillerTemplate | null = null;
let templatePromise: Promise<DrillerTemplate | null> | null = null;

export function loadDrillerTemplate(): Promise<DrillerTemplate | null> {
  templatePromise ??= new GLTFLoader()
    .loadAsync(MODEL_URL)
    .then((gltf) => {
      loadedTemplate = prepareDrillerTemplate(gltf);
      return loadedTemplate;
    })
    .catch((err) => {
      console.warn("driller: model failed to load", err);
      return null;
    });
  return templatePromise;
}

// --- Game-side single instance ------------------------------------------------
// graphics.ts hands us the scene at boot (same contract as goldenGouda.ts);
// the item kind mounts and unmounts through these.

let gameScene: THREE.Scene | null = null;
let mounted: DrillerVisual | null = null;

export function setDrillerScene(scene: THREE.Scene): void {
  gameScene = scene;
  void loadDrillerTemplate(); // warm it long before the wreck is found
}

export function mountDriller(): DrillerVisual | null {
  if (!gameScene) return null;
  if (!mounted) {
    mounted = createDrillerVisual();
    gameScene.add(mounted.group);
  }
  return mounted;
}

export function unmountDriller(): void {
  if (!mounted) return;
  mounted.group.removeFromParent(); // may be hanging off a carrier's paw
  mounted.dispose();
  mounted = null;
}

export function getMountedDriller(): DrillerVisual | null {
  return mounted;
}
