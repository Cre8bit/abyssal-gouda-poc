// entities/driller.ts — the driller: the one tool that opens hardness 1-2
// rind fast and loud (M3.1). A static prop — no skin, no animation —
// prepareDrillerTemplate() only measures its bounding box, scaling the
// longest dimension to DRILLER_LENGTH so it fits a rat diver's paws.
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

// --- The template: the shipped model, measured -----------------------------

export interface DrillerTemplate {
  /** The GLB scene, cloned per instance. */
  root: THREE.Object3D;
  /** Template units → world units, so the model matches DRILLER_LENGTH. */
  scale: number;
  /** Bounding-box centre, template space — instances hang from this. */
  centre: THREE.Vector3;
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
  return { root, scale, centre };
}

// --- The visual --------------------------------------------------------------

export interface DrillerVisual {
  group: THREE.Group;
  /** The model, once loaded. Null until the GLB lands. */
  model: THREE.Object3D | null;
  update(t: number, held?: boolean): void;
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

  const visual: DrillerVisual = {
    group,
    model: null,

    update(t: number, held = false) {
      if (!visual.model) return;
      // Idle bob when resting in the world; steady while carried.
      visual.model.position.y = held ? 0 : Math.sin(t * IDLE_RATE) * IDLE_BOB;
    },

    dispose() {
      disposed = true; // an in-flight load must not mount into a dead group
      group.clear();
      visual.model = null;
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
