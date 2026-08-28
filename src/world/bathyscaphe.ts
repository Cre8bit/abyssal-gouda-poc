// bathyscaphe.js — the tin diving bells moored at the spawn point (T0.4).
//
// Purely presentational: the O₂ recharge / respawn zone around the spawn
// already exists (main.js RECHARGE_RADIUS + oxygen.js) — this module gives
// it a body. Divers wake up INSIDE the first bell, at the eye height of its
// hatch, facing out through the doorway toward the glowing gouda; the berth
// sinks so the hatch sill sits just below the spawn point. One extra bell is
// berthed alongside for every diver that joins (main.js setBellCount).
//
// Lights live on the model's real fixtures: a cabin lamp under the crown of
// the chamber, and an entry beacon on the porthole above the hatch. The
// beacon breathes a slow warm pulse (lights in the abyss are steady — the
// pulse is the one licensed exception, see graphics.js header): the
// lighthouse the divers navigate home by.
//
// createBellVisual() is the shared builder: graphics.js mounts it in game,
// preview.js drives the same code on the bench (standing rule — AGENTS.md).
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { toonify, toonMaterial } from "../render/toon.ts";
import type { Vec3 } from "../state.ts";

const MODEL_URL = `${import.meta.env.BASE_URL}models/tinBell.glb`;

const BELL_SCALE = 9; // the GLB is a unit-high bell → ~9 u tall, ~6.7 u wide
// The GLB's hatch doorway faces model +Z; in game the divers must look out
// of it toward the world center (-Z), so the mesh is flipped at build time.
const BELL_FLIP = Math.PI;
const DOOR_EYE = 3.9; // hatch center height above the bell base (group u)
const BERTH_SPACING = 10; // row of bells along +X, one per diver
const CABLE_LEN = 320; // fades into the murk above long before it ends

// Fixture anchor points (measured in group space, post-flip)
const CABIN_ANCHOR = new THREE.Vector3(0, 5.0, 0);
const BEACON_ANCHOR = new THREE.Vector3(0.21, 6.44, -2.95);
const SILL_ANCHOR = new THREE.Vector3(0.03, 1.5, -3.02);

const LAMP_COLOR = 0xffdfae;
const CABIN_INTENSITY = 14; // warm wake-up light filling the chamber
const CABIN_RANGE = 12; // dies out just past the tin walls
const BEACON_INTENSITY = 60; // washes the hatch front and the water outside
const BEACON_RANGE = 45;
const SILL_INTENSITY = 45; // marks the doorstep under the hatch
const SILL_RANGE = 35;
const PULSE_RATE = 0.7; // rad/s — the beacons' slow breathing

// Soft round glow sprite (same canvas halo recipe as the catfish lantern).
let glowMap: THREE.CanvasTexture | null = null;
function glowTexture() {
  if (glowMap) return glowMap;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,240,200,0.9)");
  g.addColorStop(0.4, "rgba(255,210,140,0.25)");
  g.addColorStop(1, "rgba(255,190,110,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  glowMap = new THREE.CanvasTexture(c);
  return glowMap;
}

// Shared bell visual for game and bench
export interface BellVisual {
  group: THREE.Group;
  lamp: THREE.PointLight;
  cabin: THREE.PointLight;
  cable: THREE.Mesh;
  dispose(): void;
  update(t: number): void;
  setLamp(on: boolean): void;
  isLampOn(): boolean;
}

// Build one bell out of a tinBell.glb scene (or a clone of it). Group origin
// = bell base center, hatch facing -Z; the caller decides where that sits.
export function createBellVisual(bellScene: THREE.Object3D): BellVisual {
  const group = new THREE.Group();

  toonify(bellScene); // same cel bands + ink rims as every other model
  // Divers wake up inside the shell: without backfaces the tin would be
  // invisible from within.
  bellScene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) (mesh.material as THREE.Material).side = THREE.DoubleSide;
  });
  bellScene.scale.setScalar(BELL_SCALE);
  bellScene.rotation.y = BELL_FLIP;
  group.add(bellScene);

  // Mooring cable (same material as bell)
  const cable = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.09, CABLE_LEN, 6),
    toonMaterial({ color: 0x2a2f33 }),
  );
  cable.position.y = BELL_SCALE + CABLE_LEN / 2;
  group.add(cable);

  // Cabin lamp under the chamber crown, with a small visible bulb.
  const cabin = new THREE.PointLight(
    LAMP_COLOR,
    CABIN_INTENSITY,
    CABIN_RANGE,
    2,
  );
  cabin.position.copy(CABIN_ANCHOR);
  group.add(cabin);

  const cabinBulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 10, 6),
    new THREE.MeshBasicMaterial({ color: 0xfff1cf }),
  );
  cabinBulb.position.copy(CABIN_ANCHOR).y += 0.15;
  group.add(cabinBulb);

  // Fixture beacons: light + bulb + halo (porthole top and bottom)
  const makeBeacon = (
    anchor: THREE.Vector3,
    intensity: number,
    range: number,
    haloScale: number,
  ) => {
    const light = new THREE.PointLight(LAMP_COLOR, intensity, range, 2);
    light.position.copy(anchor);
    group.add(light);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xfff1cf }),
    );
    bulb.position.copy(anchor);
    group.add(bulb);
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture(),
        color: 0xffe2b0,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    halo.scale.setScalar(haloScale);
    halo.position.copy(anchor);
    group.add(halo);
    return { light, bulb, halo, base: intensity };
  };
  const beacon = makeBeacon(BEACON_ANCHOR, BEACON_INTENSITY, BEACON_RANGE, 2.4);
  const sill = makeBeacon(SILL_ANCHOR, SILL_INTENSITY, SILL_RANGE, 2.0);

  let lampOn = true;

  return {
    group,
    lamp: beacon.light,
    cabin,
    cable,
    // Only dispose bell-specific resources; template and texture are shared
    dispose() {
      cable.geometry.dispose();
      cable.material.dispose();
      cabin.dispose();
      cabinBulb.geometry.dispose();
      cabinBulb.material.dispose();
      for (const b of [beacon, sill]) {
        b.light.dispose();
        b.bulb.geometry.dispose();
        b.bulb.material.dispose();
        b.halo.material.dispose();
      }
    },
    update(t: number) {
      const pulse = lampOn ? 0.82 + 0.18 * Math.sin(t * PULSE_RATE) : 0;
      for (const b of [beacon, sill]) {
        b.light.intensity = b.base * pulse;
        b.halo.material.opacity = 0.55 * pulse;
        b.bulb.material.color.setHex(lampOn ? 0xfff1cf : 0x3a3630);
      }
      cabin.intensity = lampOn ? CABIN_INTENSITY : 0;
      cabinBulb.material.color.setHex(lampOn ? 0xfff1cf : 0x3a3630);
    },
    setLamp(on: boolean) {
      lampOn = on;
    },
    isLampOn: () => lampOn,
  };
}

// --- Game-side mount ---------------------------------------------------------
let gameScene: THREE.Scene | null = null;
let template: THREE.Group | null = null; // loaded gltf.scene, cloned per bell
let loadPromise: Promise<void> | null = null;
const bells: BellVisual[] = []; // live visuals, berth order
let wantCount = 1;
const berth = new THREE.Vector3(); // bell 0 base; spawn sits at its hatch eye

function berthAll() {
  for (let i = 0; i < bells.length; i++) {
    bells[i].group.position.set(berth.x + i * BERTH_SPACING, berth.y, berth.z);
  }
}

function syncBells() {
  if (!gameScene || !template) return;
  while (bells.length < wantCount) {
    bells.push(createBellVisual(template.clone()));
    gameScene.add(bells[bells.length - 1].group);
  }
  while (bells.length > wantCount) {
    const bell = bells.pop()!;
    gameScene.remove(bell.group);
    bell.dispose();
  }
  berthAll();
}

// Idempotent loader. Divers spawn at hatch eye height (bell 0 base at spawn - DOOR_EYE)
export function mountBathyscaphe(scene: THREE.Scene, spawn: Vec3) {
  gameScene = scene;
  berth.set(spawn.x, spawn.y - DOOR_EYE, spawn.z);
  loadPromise ??= new GLTFLoader()
    .loadAsync(MODEL_URL)
    .then((gltf) => {
      template = gltf.scene;
      syncBells();
    })
    .catch((err) => console.warn("bathyscaphe: bell failed to load", err));
  syncBells();
}

// One berth per diver in the crew (main.js calls this on join/leave).
export function setBellCount(n: number) {
  wantCount = Math.max(1, n | 0);
  syncBells();
}

export function updateBathyscaphe(t: number) {
  for (const bell of bells) bell.update(t);
}

// --- Collision -----------------------------------------------------------
// Analytic cylinder collision: solid slab (floor + ceil), annular wall
// (with hatch aperture), bell-local space. WALL_RI must match inner liner
// or diver clips through visible tin into wall cavity.
const TIN_TOP = 9; // lid height
const FLOOR_Y = 2.34; // interior floor plate (solid from the base up to it)
const CEIL_Y = 5.4; // crown slab (dome narrows above this)
const WALL_RI = 1.15; // inner liner surface
const WALL_RO = 3.1; // outer hull + greebles
const DOOR_HALF_W = 1.3; // hatch aperture half-width

// Sphere vs solid cylinder slab: minimal axis push. Mutates lp, returns the
// push normal or null.
function pushSlab(lp: Vec3, pr: number, y0: number, y1: number): Vec3 | null {
  const r = Math.hypot(lp.x, lp.z) || 1e-6;
  if (r >= WALL_RO + pr || lp.y <= y0 - pr || lp.y >= y1 + pr) return null;
  const up = y1 + pr - lp.y;
  const down = lp.y - (y0 - pr);
  const out = WALL_RO + pr - r;
  if (up <= down && up <= out) {
    lp.y = y1 + pr;
    return { x: 0, y: 1, z: 0 };
  }
  if (down <= out) {
    lp.y = y0 - pr;
    return { x: 0, y: -1, z: 0 };
  }
  const nx = lp.x / r;
  const nz = lp.z / r;
  lp.x = nx * (WALL_RO + pr);
  lp.z = nz * (WALL_RO + pr);
  return { x: nx, y: 0, z: nz };
}

// Sphere vs wall annulus with hatch aperture. Jamb faces remain solid;
// sphere keeps full radius clearance. Sideways push into aperture keeps
// doorway forgiving to thread.
function pushWall(lp: Vec3, pr: number): Vec3 | null {
  if (lp.y <= FLOOR_Y - pr || lp.y >= CEIL_Y + pr) return null; // slabs' turf
  const r = Math.hypot(lp.x, lp.z) || 1e-6;
  if (r <= WALL_RI - pr || r >= WALL_RO + pr) return null;
  const clear = DOOR_HALF_W - pr; // aperture width the CENTER may use
  if (lp.z < 0 && Math.abs(lp.x) < DOOR_HALF_W) {
    if (Math.abs(lp.x) <= clear) return null; // through the hatch
    const s = lp.x < 0 ? -1 : 1; // brushing a jamb: slide along its face
    lp.x = s * clear;
    return { x: -s, y: 0, z: 0 };
  }
  const pushIn = r - (WALL_RI - pr);
  const pushOut = WALL_RO + pr - r;
  const lateral = lp.z < 0 ? Math.abs(lp.x) - clear : Infinity;
  if (lateral < pushIn && lateral < pushOut) {
    const s = lp.x < 0 ? -1 : 1;
    lp.x = s * clear;
    return { x: -s, y: 0, z: 0 };
  }
  const nx = lp.x / r;
  const nz = lp.z / r;
  if (pushIn <= pushOut) {
    lp.x = nx * (WALL_RI - pr);
    lp.z = nz * (WALL_RI - pr);
    return { x: -nx, y: 0, z: -nz };
  }
  lp.x = nx * (WALL_RO + pr);
  lp.z = nz * (WALL_RO + pr);
  return { x: nx, y: 0, z: nz };
}

// Push a diver sphere out of every berthed bell. Same contract as gouda's
// resolveCollision: mutates pos, returns the push normal (or null) so the
// caller can strip the into-wall velocity and slide. The returned normal is
// a reused scratch object — read it before the next call, don't keep it.
const _lp: Vec3 = { x: 0, y: 0, z: 0 };
const _normal: Vec3 = { x: 0, y: 0, z: 0 };

export function collideBathyscaphe(pos: Vec3, radius: number): Vec3 | null {
  let hitAny = false;
  for (const bell of bells) {
    const b = bell.group.position;
    _lp.x = pos.x - b.x;
    _lp.y = pos.y - b.y;
    _lp.z = pos.z - b.z;
    // Cheap reject: outside this bell's bounding box entirely.
    if (
      _lp.y < -radius ||
      _lp.y > TIN_TOP + radius ||
      Math.abs(_lp.x) > WALL_RO + radius ||
      Math.abs(_lp.z) > WALL_RO + radius
    )
      continue;
    // All three solids are resolved in sequence, each seeing the previous
    // push — a diver resting on the floor plate touches the bottom slab
    // every frame, and stopping at the first hit would starve the wall
    // check, letting a grounded diver walk straight through the tin.
    // Overlapping pushes (floor/wall corner) blend their normals.
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let hit = false;
    let n = pushSlab(_lp, radius, 0, FLOOR_Y);
    if (n) {
      nx += n.x;
      ny += n.y;
      nz += n.z;
      hit = true;
    }
    n = pushSlab(_lp, radius, CEIL_Y, TIN_TOP);
    if (n) {
      nx += n.x;
      ny += n.y;
      nz += n.z;
      hit = true;
    }
    n = pushWall(_lp, radius);
    if (n) {
      nx += n.x;
      ny += n.y;
      nz += n.z;
      hit = true;
    }
    if (hit) {
      pos.x = b.x + _lp.x;
      pos.y = b.y + _lp.y;
      pos.z = b.z + _lp.z;
      const len = Math.hypot(nx, ny, nz) || 1;
      _normal.x = nx / len;
      _normal.y = ny / len;
      _normal.z = nz / len;
      hitAny = true;
    }
  }
  return hitAny ? _normal : null;
}
