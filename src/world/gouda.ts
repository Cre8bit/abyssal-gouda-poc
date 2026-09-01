// gouda.js — the procedural abyssal gouda labyrinth, v5 (layer bodies).
//
// SHAPE GRAMMAR — every chunk is an analytic SDF built from:
//   · a squashed ellipsoid base ("wheel": flattened round; "hunk": rounder)
//   · optional flat plane cuts ("block": cut slabs/wedges; "slab": thin
//     plates riddled with big through-holes, like the concept art)
//   · low crust noise (faces stay flat, holes stay round, surfaces waxy)
//   · minus perfectly spherical eyes (caverns/chambers) and pores
//   · minus winding tunnel capsules (bent polylines)
//   · minus PLAYER DIGS (runtime sphere carves — see digAt)
//
// LAYER BODIES (M2 map) — "fused" and "hull" biomes swap the ellipsoid base
// for ONE analytic body shared by the whole biome: a radial band of solid
// cheese, or the Great Wheel's rounded-cylinder husk. The body is meshed by
// lattice-aligned cube tiles (spacing 2s(res-3)/res, the marched extent of
// three's MarchingCubes) so adjacent tiles sample identical world points and
// abut seamlessly. Carves are generated in WORLD space per layer — per-tile
// eye clusters, an inter-tile spanning tree, side exits, and the world SPINE
// (the seeded descent route) — then distributed into every tile they touch.
// Layer radii live in the world FRAME (vertical squash + tilt), which is how
// the whole onion lies flat inside a squat tilted wheel.
//
// NUMBERS LIVE IN world/recipes.ts (M2) — this file owns the shape-family
// IMPLEMENTATIONS: makeChunkData() turns a PartRecipe into SDF params,
// placeChunks() turns BiomeRecipe placements into a chunk layout, and
// createGoudaMaterial() turns a BiomeMaterial into the two-tone wax shader.
// buildGoudaWorld() takes an optional WorldRecipe override; the worldgen
// bench (/worldgen.html) uses that plus the exported generator pieces
// (makeChunkData/meshChunk/planWorldLayout) to preview edits live.
//
// DIGGING — after generation each chunk keeps its voxel field cached. A dig
// edits only the voxels around the carve sphere and re-runs marching cubes
// on that single chunk. Collision stays exact because the same dig list is
// part of the chunk's SDF. The world is fully destructible.
//
// ROTATION (WG-12) — band biomes may tumble: each chunk gets a seeded axis +
// rate from a SIDE rng stream (the main stream, and so the fingerprint,
// never moves). Orientation = rate × the clock fed to updateGouda; queries
// un-rotate the probe point, meshes get the forward rotation, digs are
// stored chunk-local — collision == render by construction. Digs on
// rotating chunks replicate as chunk id + local coords (digAtChunkLocal).
//
// SEEDED PROPS (WG-11) — air pockets, melt hazards and the wreck are drawn
// at the TAIL of the rng stream and exposed via WorldPlan.props /
// getSeededProps(); game systems consume them in M5/M6.
//
// THE MAP (cheese-parts.md §3) — six biomes, two seals, outside → in:
//   the drift      (240–300)  emmental debris clustered against the Wheel
//   the Great Wheel (R 233)   SEAL #1 — hull husk, drilled at a soft spot
//   the dark veins (100–226)  sightline-chained roquefort floats; the
//                             edge-glow trail IS the navigation
//   the melt shell (R 91)     SEAL #2 — undrillable sphere husk with ONE
//                             generated hidden entrance at the trail's end
//   the melt        (46–88)   fused fondue cathedral, rhythm hazards
//   the galleries    (8–46)   fused mite-bored sponge, 1 u squeezes
//   the heart          (0)    one fresh-curd room, the gold
//
// Dead-end chambers sealed by deliberately thin walls are marked with a
// crack-glow (getBlastPoints()) — dig or (future) blast through them.
// Generation is seeded per game; the host's seed rides the invite link and
// the handshake, so peers share the exact same maze.

import * as THREE from "three";
import { toonMaterial } from "../render/toon.ts";
import type { DigTool, Vec3 } from "../state.ts";
import type { MeshJob, MeshResult } from "./meshWorker.ts";
import {
  bodySdfWorld,
  chunkSdf,
  fbm3,
  frameRadius,
  hullSolidSdf,
  makeFrame,
  meshChunkBuffers,
  R0,
  SMOOTH_K,
  smoothCut,
  type ChunkMeshBuffers,
  type ChunkShape,
  type LayerBody,
  type SoftSpot,
  type SphereCarve,
  type Tunnel,
  type WorldFrame,
} from "./sdf.ts";
import {
  WHEEL_WORLD,
  pickPart,
  validateWorld,
  type BiomeMaterial,
  type BiomePlacement,
  type BiomeRecipe,
  type PartRecipe,
  type WorldRecipe,
  type ZoneName,
} from "./recipes.ts";

// Module-scope radii read the shipped tables — the game always plays
// WHEEL_WORLD; WorldRecipe overrides exist for the worldgen bench only.
export const WORLD_R = WHEEL_WORLD.worldR; // outer edge of the drift
export const BOUNDARY_R = WHEEL_WORLD.boundaryR; // visible map boundary veil
export const HEART_POS = { x: 0, y: 0, z: 0 }; // map center — a DECOY.
// The Golden Gouda hides in a random cavern inside one of the mid-radius
// wheels (goldBand) and is NOT shown on the compass. Search, listen for
// its glow leaking out of tunnel mouths, dig. getGoldPos() is only the SEED
// position — once the run starts the wheel is an item and it moves.

// --- Types (erased at runtime) ---------------------------------------------------

type Rng = () => number;

// Generation context threaded through makeChunkData so the worldgen bench
// can generate isolated chunks without touching this module's world state.
export interface GenCtx {
  difficulty: number; // 1..3 — scales tunnel width down, dead-ends up
  blastPoints: Vec3[]; // sink for thin-wall marker positions
}

// Seeded tumble of a scatter chunk (WG-12): unit axis + signed rad/s. The
// orientation is angle = rate × clock — a pure function of time; cos/sin are
// the runtime cache updateGouda refreshes each frame (identity until then,
// so the verifier and node tests see the t = 0 world).
export interface ChunkSpin {
  ax: number;
  ay: number;
  az: number;
  rate: number;
}

interface SpinState extends ChunkSpin {
  cos: number;
  sin: number;
}

// The SDF core (sdf.ts) reads the ChunkShape view; the runtime fields live
// here: hardness gates digging, field caches the dug voxels, mesh is live.
export interface Chunk extends ChunkShape {
  center: THREE.Vector3;
  hardness: number; // 0 hands · 1 driller · 2 driller-slow · 3 no-dig
  field: Float32Array | null;
  mesh: THREE.Mesh | null;
  biggestEye?: SphereCarve | null; // set by makeChunkData
  zone?: ZoneName; // set by buildGoudaWorld
  sealed?: boolean; // seal tiles never receive foreign carves (noCarveWithin)
  spin?: SpinState; // rotating scatter chunk (WG-12); queries un-rotate probes
}

export interface ChunkSpec {
  center: THREE.Vector3;
  s: number;
  res: number;
  label: string;
  zone: ZoneName;
  part: PartRecipe;
  body?: LayerBody; // layer-body tile (fused/hull placements)
  spin?: ChunkSpin; // seeded tumble (band rotate, WG-12)
}

// One point of the seeded descent route: a through-point per layer boundary.
export interface SpinePoint {
  x: number;
  y: number;
  z: number;
  r: number; // frame radius of the boundary it sits on
}

// The melt shell's hidden entrance (WG-08): a single generator-carved bore,
// angled off radial and recessed. `surface` is the point on the husk,
// `mouth`/`inner` the bore capsule's endpoints (outside/inside).
export interface EntranceSpec {
  surface: Vec3;
  mouth: Vec3;
  inner: Vec3;
  r: number;
}

// One deterministic world-space prop seed (WG-11): air pockets at eye
// ceilings, melt hazards at cavern ceilings/floors, the wreck. Positions are
// consumed by M5/M6 game systems; replicated for free (same seed, same list).
export type SeededPropKind =
  "airPocket" | "wreck" | "melt_fall" | "melt_pool" | "thermal_vent";

export interface SeededProp {
  kind: SeededPropKind;
  zone: ZoneName;
  pos: Vec3;
  dir?: Vec3; // surface normal into open water (hazards)
  phase?: number; // seeded cycle offset 0–1 (hazards; timing itself is M5)
}

export interface WorldPlan {
  specs: ChunkSpec[];
  spine: SpinePoint[];
  softSpots: SoftSpot[];
  entrance: EntranceSpec | null;
  wreckPos: Vec3 | null; // the drowned bathyscaphe + driller (WG-05/WG-11)
  props: SeededProp[]; // filled by buildWorldData (needs the carved eyes)
}

interface Debris {
  center: THREE.Vector3;
  r: number;
  mesh: THREE.Mesh;
}

// --- Generation parameters (set per game) --------------------------------------

let worldSeed = 1337;
let difficulty = 1;

const chunks: Chunk[] = []; // each: SDF params + cached voxel field + live mesh
const debris: Debris[] = []; // { center, r, mesh }
const blastPoints: Vec3[] = [];
let worldGroup: THREE.Group | null = null;
let extrasGroup: THREE.Group | null = null;
let goldPos: Vec3 | null = null; // where the Gouda is seeded (M1.2)
let markerMaterial: THREE.SpriteMaterial | null = null;
let spawnPoint: THREE.Vector3 | null = null;
let lastCull = -1;
let worldSpine: SpinePoint[] = [];
let worldSoftSpots: SoftSpot[] = [];
let worldProps: SeededProp[] = [];
let hasSpin = false; // any rotating chunk in the built world (skip the frame loop otherwise)
let wireframeOn = false; // debug overlay (M key, main.ts) — superposed, not a material swap
let wireMaterial: THREE.LineBasicMaterial | null = null;
let softSpotsOn = false; // debug soft-spot markers (L key, main.ts)
let softSpotGroup: THREE.Group | null = null;

const uGoudaTime = { value: 0 };

// --- Seeded RNG ------------------------------------------------------------------

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randDir(rng: Rng, out: THREE.Vector3): THREE.Vector3 {
  let x, y, z, l;
  do {
    x = rng() * 2 - 1;
    y = rng() * 2 - 1;
    z = rng() * 2 - 1;
    l = x * x + y * y + z * z;
  } while (l > 1 || l < 1e-6);
  l = 1 / Math.sqrt(l);
  out.x = x * l;
  out.y = y * l;
  out.z = z * l;
  return out;
}

// Rodrigues rotation of a chunk-relative vector about the spin axis. Pass
// -sp.sin to un-rotate a world probe into the chunk's frame, +sp.sin to push
// chunk-local data back out to world.
const _sv: Vec3 = { x: 0, y: 0, z: 0 };
function spinRotate(
  sp: SpinState,
  x: number,
  y: number,
  z: number,
  sin: number,
  out: Vec3,
): void {
  const cos = sp.cos;
  if (cos === 1 && sin === 0) {
    out.x = x;
    out.y = y;
    out.z = z;
    return;
  }
  const kx = sp.ax,
    ky = sp.ay,
    kz = sp.az;
  const dot = (kx * x + ky * y + kz * z) * (1 - cos);
  out.x = x * cos + (ky * z - kz * y) * sin + kx * dot;
  out.y = y * cos + (kz * x - kx * z) * sin + ky * dot;
  out.z = z * cos + (kx * y - ky * x) * sin + kz * dot;
}

// Frame-space direction+radius → world point.
function frameToWorld(f: WorldFrame | null, v: THREE.Vector3): THREE.Vector3 {
  if (!f) return v;
  const y = v.y * f.squash;
  const z = v.z;
  v.y = f.cos * y + f.sin * z;
  v.z = -f.sin * y + f.cos * z;
  return v;
}

// --- Chunk data generation -------------------------------------------------------------

const _dir = new THREE.Vector3();
const _dir2 = new THREE.Vector3();

// Bent polyline tunnel. bends=0 straight, 1 winding, 2+ snaking (speleology).
function addTunnel(
  c: Chunk,
  rng: Rng,
  a: Vec3,
  b: Vec3,
  r: number,
  bends: number,
): void {
  if (!bends) {
    c.tunnels.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, r });
    return;
  }
  const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const pts: Vec3[] = [a];
  for (let i = 1; i <= bends; i++) {
    const t = i / (bends + 1);
    randDir(rng, _dir2);
    const bend = len * (0.12 + rng() * 0.16);
    pts.push({
      x: a.x + (b.x - a.x) * t + _dir2.x * bend,
      y: a.y + (b.y - a.y) * t + _dir2.y * bend,
      z: a.z + (b.z - a.z) * t + _dir2.z * bend,
    });
  }
  pts.push(b);
  for (let i = 0; i < pts.length - 1; i++) {
    c.tunnels.push({
      ax: pts[i].x,
      ay: pts[i].y,
      az: pts[i].z,
      bx: pts[i + 1].x,
      by: pts[i + 1].y,
      bz: pts[i + 1].z,
      r,
    });
  }
}

// The tunnel radius the generator ACTUALLY carves (world u): the lattice
// floor max'd against the difficulty-scaled base. Quote this — never raw
// rBase — in any UI (WG-03); both generator paths implement this formula.
export function effectiveTunnelRadius(
  part: PartRecipe,
  s: number,
  res: number,
  difficulty: number,
  base: number = part.tunnels.rBase,
): number {
  const tunnelScale = [1.15, 1.0, 0.85][difficulty - 1] ?? 1.0;
  return Math.max(
    (part.narrow ? 2.2 : 2.6) * ((2 * s) / res),
    base * tunnelScale * s,
  );
}

// One PartRecipe → one chunk's SDF params. `ctx` carries difficulty + the
// blast-marker sink.
export function makeChunkData(
  rng: Rng,
  center: THREE.Vector3,
  s: number,
  res: number,
  part: PartRecipe,
  ctx: GenCtx,
): Chunk {
  const cell = 2 / res;
  const minTunnelR = (part.narrow ? 2.2 : 2.6) * cell;
  const tunnelScale = [1.15, 1.0, 0.85][ctx.difficulty - 1] ?? 1.0;
  const tr = (base: number) => Math.max(minTunnelR, base * tunnelScale);
  const bends = part.tunnels.bends;
  const { rBase: trBase, rVar: trVar } = part.tunnels;

  let sx, sy, sz;
  if (part.kind === "wheel") {
    sx = 0.95 + rng() * 0.2;
    sy = 0.5 + rng() * 0.2;
    sz = 0.95 + rng() * 0.2;
  } else if (part.kind === "column") {
    // Tall chimney: narrow footprint, full grid height.
    sx = 0.38 + rng() * 0.14;
    sy = 1.1 + rng() * 0.15;
    sz = 0.38 + rng() * 0.14;
  } else {
    sx = 0.85 + rng() * 0.35;
    sy = 0.85 + rng() * 0.35;
    sz = 0.85 + rng() * 0.35;
  }

  const c: Chunk = {
    center,
    s,
    res,
    ix: 1 / sx,
    iy: 1 / sy,
    iz: 1 / sz,
    minAxis: Math.min(sx, sy, sz),
    nOff: rng() * 100,
    amp: part.crust.amp,
    freq: part.crust.freq,
    crustDepth: part.crust.depth,
    planes: [],
    holes: [],
    tunnels: [],
    digs: [],
    hardness: part.hardness,
    field: null, // cached voxel field (filled at meshing, edited by digs)
    mesh: null,
  };

  // Plane cuts.
  if (part.kind === "block" || part.kind === "slab") {
    randDir(rng, _dir);
    const half =
      part.kind === "slab" ? 0.13 + rng() * 0.07 : 0.22 + rng() * 0.14;
    c.planes.push({ nx: _dir.x, ny: _dir.y, nz: _dir.z, off: half });
    c.planes.push({ nx: -_dir.x, ny: -_dir.y, nz: -_dir.z, off: half });
    const nCuts = part.kind === "slab" ? 1 : 1 + Math.floor(rng() * 3);
    for (let i = 0; i < nCuts; i++) {
      randDir(rng, _dir);
      c.planes.push({
        nx: _dir.x,
        ny: _dir.y,
        nz: _dir.z,
        off: 0.3 + rng() * 0.22,
      });
    }
  }

  const eyes: SphereCarve[] = [];

  if (part.coreEye > 0) {
    const core = { x: 0, y: 0, z: 0, r: part.coreEye };
    eyes.push(core);
    c.holes.push(core);
  }

  // Rare oversized rooms (mite-bore's authored exception).
  if (part.chambers && rng() < part.chambers.chance) {
    randDir(rng, _dir);
    const t = R0 * (0.1 + 0.4 * rng());
    const room = {
      x: _dir.x * t * sx,
      y: _dir.y * t * sy,
      z: _dir.z * t * sz,
      r: part.chambers.rBase + part.chambers.rVar * rng(),
    };
    eyes.push(room);
    c.holes.push(room);
  }

  const nEyes =
    part.eyes.min + Math.floor(rng() * (part.eyes.max - part.eyes.min + 1));
  for (let i = 0; i < nEyes; i++) {
    randDir(rng, _dir);
    const t = R0 * (0.12 + 0.58 * rng());
    const x = _dir.x * t * sx,
      y = _dir.y * t * sy,
      z = _dir.z * t * sz;
    const centerBias = 1.25 - (t / R0) * 0.55;
    const r = (part.eyes.rBase + part.eyes.rVar * rng()) * centerBias;
    const eye = { x, y, z, r };
    eyes.push(eye);
    c.holes.push(eye);
  }

  // Pores: many for slabs, few otherwise.
  const nPores =
    part.pores.min + Math.floor(rng() * (part.pores.max - part.pores.min + 1));
  for (let i = 0; i < nPores; i++) {
    randDir(rng, _dir);
    const t =
      R0 * (part.kind === "slab" ? 0.5 + 0.6 * rng() : 0.85 + 0.3 * rng());
    c.holes.push({
      x: _dir.x * t * sx,
      y: _dir.y * t * sy,
      z: _dir.z * t * sz,
      r: Math.max(1.6 * cell, part.pores.rBase + part.pores.rVar * rng()),
    });
  }

  // Spanning tree with optional tangle (random earlier chamber).
  for (let i = 1; i < eyes.length; i++) {
    let best = 0,
      second = 0,
      bestD = Infinity,
      secondD = Infinity;
    for (let j = 0; j < i; j++) {
      const dx = eyes[i].x - eyes[j].x,
        dy = eyes[i].y - eyes[j].y,
        dz = eyes[i].z - eyes[j].z;
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd < bestD) {
        secondD = bestD;
        second = best;
        bestD = dd;
        best = j;
      } else if (dd < secondD) {
        secondD = dd;
        second = j;
      }
    }
    const j = part.tangle
      ? i > 1 && rng() < 0.5
        ? Math.floor(rng() * i)
        : best
      : i > 2 && rng() < 0.3
        ? second
        : best;
    addTunnel(c, rng, eyes[i], eyes[j], tr(trBase + trVar * rng()), bends);
  }
  const loops = 2 + Math.floor(eyes.length / 6);
  for (let i = 0; i < loops; i++) {
    const a = eyes[Math.floor(rng() * eyes.length)];
    const b = eyes[Math.floor(rng() * eyes.length)];
    if (a === b) continue;
    addTunnel(c, rng, a, b, tr(trBase * 0.9 + trVar * rng()), bends);
  }

  // Exits to open water.
  const sorted = [...eyes].sort(
    (a, b) =>
      b.x * b.x + b.y * b.y + b.z * b.z - (a.x * a.x + a.y * a.y + a.z * a.z),
  );
  const nExits = part.exits + Math.floor(rng() * 2);
  for (let i = 0; i < Math.min(nExits, sorted.length); i++) {
    const e = sorted[i];
    const len = Math.sqrt(e.x * e.x + e.y * e.y + e.z * e.z) || 1;
    const out = (R0 + 0.24) / len;
    addTunnel(
      c,
      rng,
      e,
      { x: e.x * out, y: e.y * out, z: e.z * out },
      tr(0.07 + 0.03 * rng()),
      0,
    );
  }

  // Dead-end chambers behind thin marked walls (dig/blast through).
  const nDead = part.deadEnds + (ctx.difficulty - 1);
  for (let k = 0; k < nDead && eyes.length >= 2; k++) {
    const start = eyes[Math.floor(rng() * eyes.length)];
    let target = eyes[Math.floor(rng() * eyes.length)];
    if (target === start)
      target = eyes[(eyes.indexOf(target) + 1) % eyes.length];
    randDir(rng, _dir);
    const chR = 0.06 + 0.05 * rng();
    const wall = 0.045 + 0.02 * rng();
    const ch = {
      x: target.x + _dir.x * (target.r + chR + wall),
      y: target.y + _dir.y * (target.r + chR + wall),
      z: target.z + _dir.z * (target.r + chR + wall),
      r: chR,
    };
    const el = Math.sqrt(
      (ch.x / sx) ** 2 + (ch.y / sy) ** 2 + (ch.z / sz) ** 2,
    );
    if (el > R0 - chR * 0.8) continue;
    c.holes.push(ch);
    addTunnel(c, rng, start, ch, tr(0.045 + 0.03 * rng()), bends);
    ctx.blastPoints.push({
      x: center.x + (target.x + _dir.x * (target.r + wall / 2)) * s,
      y: center.y + (target.y + _dir.y * (target.r + wall / 2)) * s,
      z: center.z + (target.z + _dir.z * (target.r + wall / 2)) * s,
    });
  }

  // Track largest cavern (gold spawn candidate).
  let biggest = eyes[0] ?? null;
  for (const e of eyes) if (e.r > (biggest?.r ?? 0)) biggest = e;
  c.biggestEye = biggest;

  if (part.tags.includes("edge-veins")) c.veinEdges = true;

  return c;
}

// --- Meshing -------------------------------------------------------------------------

// The MC scratch, field fill and buffer extraction live in sdf.ts (WG-19) —
// shared verbatim by this sync path and the mesh worker. Here the buffers
// only get wrapped into THREE geometry.
function buffersToGeometry(
  b: Omit<ChunkMeshBuffers, "field">,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(b.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(b.normals, 3));
  geometry.setAttribute("aCrust", new THREE.BufferAttribute(b.crust, 1));
  if (b.vein)
    geometry.setAttribute("aVein", new THREE.BufferAttribute(b.vein, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

// Debug wireframe overlay (M key, main.ts): a LineSegments child riding
// each chunk mesh, so it inherits position/rotation/culling for free and
// never drifts from the surface it traces. Superposed on the solid render
// rather than swapped in, since `wireframe: true` on the shared toon
// material would flip every chunk of that biome, not just this one.
function ensureWireMaterial(): THREE.LineBasicMaterial {
  wireMaterial ??= new THREE.LineBasicMaterial({
    color: 0x39ffe0,
    transparent: true,
    opacity: 0.55,
  });
  return wireMaterial;
}

function buildWireOverlay(mesh: THREE.Mesh): void {
  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(mesh.geometry),
    ensureWireMaterial(),
  );
  wire.visible = wireframeOn;
  wire.raycast = () => {}; // debug-only, never picked
  mesh.add(wire);
  mesh.userData.wire = wire;
}

// Called after a dig swaps a chunk's geometry — keeps the overlay in sync
// with the newly carved surface (no-op if the overlay was never built).
function refreshWireOverlay(mesh: THREE.Mesh): void {
  const wire = mesh.userData.wire as THREE.LineSegments | undefined;
  if (!wire) return;
  wire.geometry.dispose();
  wire.geometry = new THREE.WireframeGeometry(mesh.geometry);
}

// Toggle the overlay for every currently-mounted chunk, and flag future
// (streamed-in) chunks to build theirs on mount.
export function setWireframeOverlay(on: boolean): void {
  wireframeOn = on;
  if (!worldGroup) return;
  for (const child of worldGroup.children) {
    const mesh = child as THREE.Mesh;
    const wire = mesh.userData.wire as THREE.LineSegments | undefined;
    if (on && !wire) buildWireOverlay(mesh);
    else if (wire) wire.visible = on;
  }
}

// Wrap ready buffers into the chunk's live mesh (build + worker upload path).
function mountChunkMesh(
  c: Chunk,
  b: Omit<ChunkMeshBuffers, "field">,
  material: THREE.Material,
): THREE.Mesh {
  const mesh = new THREE.Mesh(buffersToGeometry(b), material);
  mesh.position.copy(c.center);
  mesh.scale.setScalar(c.s);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  c.mesh = mesh;
  if (wireframeOn) buildWireOverlay(mesh);
  return mesh;
}

export function meshChunk(c: Chunk, material: THREE.Material): THREE.Mesh {
  const buffers = meshChunkBuffers(c);
  // Cache field; digs edit incrementally.
  c.field = buffers.field;
  return mountChunkMesh(c, buffers, material);
}

// Re-runs marching cubes for one chunk from its cached (dug) field.
function remeshChunk(c: Chunk): void {
  if (!c.mesh || !c.field) return; // chunk never finished building
  const geometry = buffersToGeometry(meshChunkBuffers(c, c.field));
  c.mesh.geometry.dispose();
  c.mesh.geometry = geometry;
  refreshWireOverlay(c.mesh);
}

// --- Mesh worker pool (WG-19) ---------------------------------------------------------

// The exact ChunkShape fields, hand-picked: a Chunk also carries a live
// THREE.Mesh, which structured clone rejects. digs are snapshotted by the
// clone at dispatch time — the coalescing rule "latest field wins" rides
// on that (WG-20).
function serializeChunk(c: Chunk): ChunkShape {
  return {
    center: { x: c.center.x, y: c.center.y, z: c.center.z },
    s: c.s,
    res: c.res,
    ix: c.ix,
    iy: c.iy,
    iz: c.iz,
    minAxis: c.minAxis,
    nOff: c.nOff,
    amp: c.amp,
    freq: c.freq,
    crustDepth: c.crustDepth,
    planes: c.planes,
    holes: c.holes,
    tunnels: c.tunnels,
    digs: c.digs,
    body: c.body,
    veinEdges: c.veinEdges,
  };
}

interface PoolJob {
  chunk: Chunk;
  field: Float32Array | null; // buffer ownership transfers at dispatch
  wantField: boolean;
  onDispatch?: () => void; // fires when the chunk is actually serialized
  resolve: (r: MeshResult) => void;
  reject: (err: unknown) => void;
}

// One job per worker at a time; excess jobs queue. The pool outlives world
// rebuilds (workers are expensive to spin up, idle ones are free).
let meshPool: Worker[] | null = null;
const poolIdle: Worker[] = [];
const poolQueue: PoolJob[] = [];
const poolInFlight = new Map<Worker, PoolJob>();
let jobSeq = 0;

function getMeshPool(): Worker[] | null {
  if (typeof Worker === "undefined") return null; // node: sync path only
  if (meshPool) return meshPool;
  const size = Math.max(
    1,
    Math.min((navigator.hardwareConcurrency || 4) - 1, 8),
  );
  meshPool = [];
  for (let i = 0; i < size; i++) {
    const w = new Worker(new URL("./meshWorker.ts", import.meta.url), {
      type: "module",
    });
    const settle = (finish: (job: PoolJob) => void) => {
      const job = poolInFlight.get(w);
      poolInFlight.delete(w);
      poolIdle.push(w);
      pumpPool();
      if (job) finish(job);
    };
    w.onmessage = (e: MessageEvent<MeshResult>) =>
      settle((job) => job.resolve(e.data));
    w.onerror = (err) => settle((job) => job.reject(err));
    meshPool.push(w);
    poolIdle.push(w);
  }
  return meshPool;
}

function pumpPool(): void {
  while (poolIdle.length && poolQueue.length) {
    const w = poolIdle.pop()!;
    const job = poolQueue.shift()!;
    poolInFlight.set(w, job);
    job.onDispatch?.();
    const msg: MeshJob = {
      id: ++jobSeq,
      chunk: serializeChunk(job.chunk),
      field: job.field ?? undefined,
      wantField: job.wantField,
    };
    w.postMessage(msg, job.field ? [job.field.buffer] : []);
  }
}

function submitMeshJob(
  chunk: Chunk,
  field: Float32Array | null,
  wantField: boolean,
  onDispatch?: () => void,
): Promise<MeshResult> {
  return new Promise((resolve, reject) => {
    poolQueue.push({ chunk, field, wantField, onDispatch, resolve, reject });
    pumpPool();
  });
}

// --- Async dig remesh (WG-20) + streamed first meshing (WG-22) --------------------------

// One in-flight remesh per chunk; the latest field wins. Collision is
// already correct the moment digAt edits the field/dig list (chunkSdf is
// the collider) — only the visual swap is deferred.
const remeshInFlight = new Set<Chunk>();
const remeshDirty = new Set<Chunk>();

function scheduleRemesh(c: Chunk): void {
  if (!c.mesh || !c.field) return; // never meshed yet: WG-22 bakes on arrival
  if (!getMeshPool()) {
    remeshChunk(c);
    return;
  }
  if (remeshInFlight.has(c)) {
    remeshDirty.add(c);
    return;
  }
  remeshInFlight.add(c);
  submitMeshJob(c, c.field.slice(), false)
    .then((r) => {
      if (!c.mesh) return;
      c.mesh.geometry.dispose();
      c.mesh.geometry = buffersToGeometry(r);
      refreshWireOverlay(c.mesh);
    })
    .catch((err) => {
      console.warn("gouda: remesh worker failed, remeshing on main", err);
      remeshChunk(c);
    })
    .finally(() => {
      remeshInFlight.delete(c);
      if (remeshDirty.delete(c)) scheduleRemesh(c);
    });
}

// WG-22 — lazy meshing: at build time only chunks near the spawn mesh
// eagerly; the rest stream through the pool nearest-first as players move
// (distance-SCHEDULING, never distance-resolution — tile seams depend on
// uniform res). Collision needs no mesh: chunkSdf is the collider, so
// unmeshed cheese is solid — and diggable — from frame one.
const MESH_AHEAD = 120;
let unmeshed: Chunk[] = [];
let zoneMaterialsLive: Partial<Record<ZoneName, THREE.MeshToonMaterial>> = {};
let streamBusy = 0;

function chunkReach(c: Chunk): number {
  return c.body ? c.s * 1.75 : c.s * 1.4;
}

function streamChunk(c: Chunk): void {
  const group = worldGroup; // guards against a rebuild landing mid-flight
  streamBusy++;
  let digsAtDispatch = 0;
  submitMeshJob(c, null, true, () => (digsAtDispatch = c.digs.length))
    .then((r) => {
      if (worldGroup !== group || !group || c.mesh) return;
      c.field = r.field;
      const mesh = mountChunkMesh(c, r, zoneMaterialsLive[c.zone!]!);
      mesh.userData.reach = chunkReach(c);
      mesh.userData.zone = c.zone;
      group.add(mesh);
      // Digs that landed after dispatch aren't in this field — bake + swap.
      if (c.digs.length > digsAtDispatch) {
        for (let i = digsAtDispatch; i < c.digs.length; i++)
          applyDigToField(c, c.digs[i]);
        scheduleRemesh(c);
      }
    })
    .catch((err) => console.warn("gouda: streamed meshing failed", err))
    .finally(() => {
      streamBusy--;
    });
}

// 4 Hz (piggybacks on the cull tick): submit the nearest unmeshed chunks in
// reach, keeping the pool about twice-covered so results keep landing.
function pumpStreaming(cameraPos: THREE.Vector3): void {
  if (!unmeshed.length || !worldGroup) return;
  const pool = getMeshPool();
  if (!pool) return;
  const maxBusy = pool.length * 2;
  if (streamBusy >= maxBusy) return;
  unmeshed.sort(
    (a, b) =>
      a.center.distanceToSquared(cameraPos) -
      b.center.distanceToSquared(cameraPos),
  );
  while (streamBusy < maxBusy && unmeshed.length) {
    const c = unmeshed[0];
    if (c.center.distanceTo(cameraPos) - chunkReach(c) > MESH_AHEAD) break;
    unmeshed.shift();
    streamChunk(c);
  }
}

// --- DIGGING ---------------------------------------------------------------------------

// Hardness ceiling per tool (cheese-parts §1): hands open 0, the driller ≤ 2,
// 3 yields to nothing.
const TOOL_MAX_HARDNESS: Record<DigTool, number> = { hands: 0, driller: 2 };

// Great Wheel exception: a dig point inside a soft spot digs as hardness 1 —
// the geometric hook the M3 breach timer attaches to. Hulls without soft
// spots (the melt shell, WG-08) get no exception by construction.
const SOFT_SPOT_PAD = 0.3; // × spot radius
export function softSpotDigRadius(r: number): number {
  return r * (1 + SOFT_SPOT_PAD);
}

function digHardness(c: Chunk, x: number, y: number, z: number): number {
  const spots = c.body?.softSpots;
  if (c.hardness > 1 && spots) {
    for (const s of spots) {
      const dx = x - s.x,
        dy = y - s.y,
        dz = z - s.z;
      const rr = softSpotDigRadius(s.r);
      if (dx * dx + dy * dy + dz * dz < rr * rr) return 1;
    }
  }
  return c.hardness;
}

// Edit only the voxels one (chunk-local) dig can touch.
function applyDigToField(c: Chunk, g: SphereCarve): void {
  const field = c.field;
  if (!field) return;
  const res = c.res;
  const half = res / 2;
  const cell = 1 / half;
  const reach = g.r + SMOOTH_K + 2 * cell;
  const min = (v: number) => Math.max(0, Math.floor((v - reach + 1) * half));
  const max = (v: number) =>
    Math.min(res - 1, Math.ceil((v + reach + 1) * half));
  for (let zi = min(g.z); zi <= max(g.z); zi++) {
    const vz = (zi - half) / half;
    for (let yi = min(g.y); yi <= max(g.y); yi++) {
      const vy = (yi - half) / half;
      const rowBase = zi * res * res + yi * res;
      for (let xi = min(g.x); xi <= max(g.x); xi++) {
        const vx = (xi - half) / half;
        const ddx = vx - g.x,
          ddy = vy - g.y,
          ddz = vz - g.z;
        const dd = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) - g.r;
        const idx = rowBase + xi;
        const d = -field[idx];
        field[idx] = -smoothCut(d, dd, SMOOTH_K);
      }
    }
  }
}

export interface DigResult {
  changed: boolean; // some chunk/debris took the carve
  rejected: boolean; // some chunk in range bounced the tool (feedback hook)
  // The nearest ROTATING chunk that took the carve (WG-12): digs on spinning
  // cheese replicate as chunk id + these local (unit) coords, because a
  // world-space point replayed at a different clock lands elsewhere.
  spinLocal?: { chunk: number; x: number; y: number; z: number };
}

// Carve sphere through chunks; update fields, re-mesh, destroy small debris.
// Chunks harder than the tool are skipped (no field edit, no dig entry) and
// the loop continues — one sphere can straddle soft crumb and a seal.
export function digAt(
  x: number,
  y: number,
  z: number,
  r: number,
  tool: DigTool,
): DigResult {
  let changed = false;
  let rejected = false;
  let spinLocal: DigResult["spinLocal"];
  let spinDc = Infinity;
  const maxHardness = TOOL_MAX_HARDNESS[tool];

  // The grid cell covers dig spheres up to DIG_PAD (WG-21); anything larger
  // (a future blast?) falls back to the full sweep.
  const bucket =
    chunkGrid && r <= DIG_PAD ? (gridBucketAt(x, y, z) ?? []) : null;
  const nCandidates = bucket ? bucket.length : chunks.length;
  for (let k = 0; k < nCandidates; k++) {
    const ci = bucket ? bucket[k] : k;
    const c = chunks[ci];
    const dx = x - c.center.x,
      dy = y - c.center.y,
      dz = z - c.center.z;
    const dc = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Same predicate the collider uses: anything that can block here is dug.
    if (!chunkCovers(c, x, y, z, r)) continue;
    if (digHardness(c, x, y, z) > maxHardness) {
      rejected = true;
      continue;
    }

    let ldx = dx,
      ldy = dy,
      ldz = dz;
    if (c.spin) {
      spinRotate(c.spin, dx, dy, dz, -c.spin.sin, _sv);
      ldx = _sv.x;
      ldy = _sv.y;
      ldz = _sv.z;
    }
    const lx = ldx / c.s,
      ly = ldy / c.s,
      lz = ldz / c.s;
    const lr = r / c.s;
    // WG-23b: a dig fully contained in an existing one is skipped entirely
    // (no dig entry, no field edit) — re-digging a hole can't grow the list,
    // and field and dig list stay in step because BOTH skip. Same rule
    // replays on every peer: same world, same verdict.
    let contained = false;
    for (const e of c.digs) {
      const ex = lx - e.x,
        ey = ly - e.y,
        ez = lz - e.z;
      if (Math.sqrt(ex * ex + ey * ey + ez * ez) + lr <= e.r) {
        contained = true;
        break;
      }
    }
    if (contained) continue;
    const dig = { x: lx, y: ly, z: lz, r: lr };
    c.digs.push(dig);
    if (c.spin && dc < spinDc) {
      spinDc = dc;
      spinLocal = { chunk: ci, x: lx, y: ly, z: lz };
    }

    // Collision is correct from here (chunkSdf includes the dig). A chunk
    // not yet meshed (WG-22) has no field to edit — its eventual first
    // meshing includes the dig via chunkSdf.
    if (c.field) {
      applyDigToField(c, dig);
      scheduleRemesh(c);
    }
    changed = true;
  }

  // Destroy debris in dig radius.
  for (let i = debris.length - 1; i >= 0; i--) {
    const b = debris[i];
    const dx = x - b.center.x,
      dy = y - b.center.y,
      dz = z - b.center.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) < b.r + r * 0.7) {
      if (b.mesh) worldGroup?.remove(b.mesh);
      debris.splice(i, 1);
      changed = true;
    }
  }

  return { changed, rejected, spinLocal };
}

// Chunk-local (unit) coords → world, through the chunk's CURRENT orientation.
export function chunkLocalToWorld(index: number, p: Vec3): Vec3 | null {
  const c = chunks[index];
  if (!c) return null;
  let x = p.x * c.s,
    y = p.y * c.s,
    z = p.z * c.s;
  if (c.spin) {
    spinRotate(c.spin, x, y, z, c.spin.sin, _sv);
    x = _sv.x;
    y = _sv.y;
    z = _sv.z;
  }
  return { x: c.center.x + x, y: c.center.y + y, z: c.center.z + z };
}

// Replay a chunk-local dig (the wire shape rotating chunks replicate as,
// WG-12): resolve to world through the chunk's current orientation, then run
// the normal dig — the round trip lands on the same spot of the cheese.
export function digAtChunkLocal(
  index: number,
  lx: number,
  ly: number,
  lz: number,
  r: number,
  tool: DigTool,
): DigResult {
  const w = chunkLocalToWorld(index, { x: lx, y: ly, z: lz });
  if (!w) return { changed: false, rejected: false };
  return digAt(w.x, w.y, w.z, r, tool);
}

// Sphere-trace along ray; return hit point or null.
export function raycastSolid(
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
): Vec3 | null {
  let t = 0;
  let x = origin.x,
    y = origin.y,
    z = origin.z;
  for (let i = 0; i < 80 && t < maxDist; i++) {
    const d = worldDistance(x, y, z);
    if (d < 0.4) return { x, y, z };
    const step = Math.max(0.15, d * 0.85);
    t += step;
    x = origin.x + dir.x * t;
    y = origin.y + dir.y * t;
    z = origin.z + dir.z * t;
  }
  return null;
}

// --- Biome materials ---------------------------------------------------------------------

// The per-material tuning knobs — plain uniforms (WG-24), so every biome
// shares ONE compiled program and a skin edit is a uniform write.
interface GoudaUniforms {
  uPaste: { value: THREE.Color };
  uRind: { value: THREE.Color };
  uVein: { value: THREE.Vector3 };
  uVeinStrength: { value: number };
  uEdgeVeins: { value: number };
}

// Two-tone cheese material via aCrust: paste (carved), rind (outer crust).
// Exported for the worldgen bench (skin previews from BiomeMaterial edits).
// The shader source is CONSTANT: colors, vein strength and the glow variant
// (interior noise patches vs the WG-13 baked edge glow) all ride uniforms.
export function createGoudaMaterial(m: BiomeMaterial): THREE.MeshToonMaterial {
  const uniforms: GoudaUniforms = {
    uPaste: { value: new THREE.Color(m.paste) },
    uRind: { value: new THREE.Color(m.rind) },
    uVein: { value: new THREE.Vector3(m.vein[0], m.vein[1], m.vein[2]) },
    uVeinStrength: { value: m.veinStrength },
    uEdgeVeins: { value: m.edgeVeins ? 1 : 0 },
  };

  const injectCheese = (
    shader: THREE.WebGLProgramParametersWithUniforms,
  ): void => {
    shader.uniforms.uGoudaTime = uGoudaTime;
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader =
      "attribute float aCrust;\nattribute float aVein;\nvarying float vCrust;\nvarying float vVein;\nvarying vec3 vGoudaWorld;\nvarying vec3 vGoudaNormal;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vCrust = aCrust;
        vVein = aVein;
        vGoudaWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vGoudaNormal = mat3(modelMatrix) * objectNormal;`,
      );

    shader.fragmentShader =
      "uniform float uGoudaTime;\nuniform vec3 uPaste;\nuniform vec3 uRind;\nuniform vec3 uVein;\nuniform float uVeinStrength;\nuniform float uEdgeVeins;\nvarying float vCrust;\nvarying float vVein;\nvarying vec3 vGoudaWorld;\nvarying vec3 vGoudaNormal;\n" +
      shader.fragmentShader
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
        {
          // Slight albedo mottling so big waxy surfaces aren't flat.
          float mottle = 0.92 + 0.08 * sin(vGoudaWorld.x * 0.9 + vGoudaWorld.y * 1.3)
                                     * sin(vGoudaWorld.z * 1.1 - vGoudaWorld.y * 0.7);
          diffuseColor.rgb = mix(uPaste, uRind, vCrust) * mottle;
        }`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
        {
          vec3 gp = vGoudaWorld;
          float g1 = sin(gp.x * 0.21 + 1.3) * sin(gp.y * 0.19 + 3.1) * sin(gp.z * 0.23 + 5.2);
          float g2 = sin(gp.x * 0.083 + 2.1) * sin(gp.y * 0.077) * sin(gp.z * 0.09 + 4.0);
          vec3 gv = normalize(cameraPosition - gp);
          vec3 gn = normalize(vGoudaNormal + vec3(1e-5));
          float inPaste = 1.0 - vCrust * 0.85; // the glow lives in the paste
          if (uEdgeVeins > 0.5) {
            // WG-13 edge glow: aVein marks convex rims/carve mouths,
            // filaments break the rim light into strands, and it never
            // pulses — occlusion (rotation) is what makes the trail light
            // vanish and return. Interior faces carry no aVein: near-black.
            float fil = sin(gp.x * 5.3 + 1.7) * sin(gp.y * 4.7 + 0.6) * sin(gp.z * 5.9 + 3.9);
            fil = 0.35 + 0.65 * smoothstep(0.15, 0.85, fil * 0.5 + 0.5);
            totalEmissiveRadiance += uPaste * inPaste * 0.015;
            totalEmissiveRadiance += uVein * vVein * fil * uVeinStrength;
          } else {
            float patches = smoothstep(0.12, 0.72, g1 * 0.5 + 0.5)
                          * smoothstep(0.25, 0.9, g2 * 0.5 + 0.5);
            float pulse = 0.5 + 0.5 * sin(uGoudaTime * 0.55 + g2 * 6.0);
            pulse *= 0.7 + 0.3 * sin(uGoudaTime * 0.173 + gp.y * 0.05);
            // Faint constant self-glow so the paste reads yellow even unlit.
            totalEmissiveRadiance += uPaste * inPaste * 0.04;
            totalEmissiveRadiance += uVein * patches * (0.25 + 0.75 * pulse) * uVeinStrength * inPaste;
          }

          // WATER SHIMMER — drifting interference ripples playing over
          // up-facing surfaces, as if the glow of the veins refracts through
          // moving water above. Reads as caustics without any sun.
          vec2 cuv = gp.xz * 0.32;
          float cw = sin(cuv.x * 1.9 + uGoudaTime * 0.65)
                   + sin(cuv.y * 2.4 - uGoudaTime * 0.5)
                   + sin((cuv.x + cuv.y) * 1.4 + uGoudaTime * 0.9);
          float caust = pow(clamp(cw * 0.3333 * 0.5 + 0.5, 0.0, 1.0), 3.0);
          float upFace = clamp(gn.y * 0.8 + 0.2, 0.0, 1.0);
          totalEmissiveRadiance += vec3(0.16, 0.30, 0.34) * caust * upFace * 0.06;

          // WET SHEEN — a cold glassy film catching grazing angles, kept
          // very faint so walls never light up on their own.
          float wet = pow(clamp(1.0 - abs(dot(gn, gv)), 0.0, 1.0), 3.5);
          totalEmissiveRadiance += vec3(0.10, 0.20, 0.24) * wet
            * (0.35 + 0.65 * caust) * 0.2;
        }`,
        );
  };

  const material = toonMaterial(
    { color: 0xffffff }, // overridden per-fragment by the paste/rind mix
    { shader: injectCheese, key: "gouda" }, // one program for every biome
  );
  material.userData.gouda = uniforms;
  return material;
}

// Retune a gouda material in place (WG-24) — the bench's skin sliders write
// uniforms instead of minting materials. Returns false for non-gouda mats.
export function updateGoudaMaterial(
  mat: THREE.Material,
  m: BiomeMaterial,
): boolean {
  const u = mat.userData.gouda as GoudaUniforms | undefined;
  if (!u) return false;
  u.uPaste.value.set(m.paste);
  u.uRind.value.set(m.rind);
  u.uVein.value.set(m.vein[0], m.vein[1], m.vein[2]);
  u.uVeinStrength.value = m.veinStrength;
  u.uEdgeVeins.value = m.edgeVeins ? 1 : 0;
  return true;
}

// One wax material per biome, from the recipe tables.
function createZoneMaterials(
  world: WorldRecipe,
): Partial<Record<ZoneName, THREE.MeshToonMaterial>> {
  const materials: Partial<Record<ZoneName, THREE.MeshToonMaterial>> = {};
  for (const biome of world.biomes)
    materials[biome.id] = createGoudaMaterial(biome.material);
  return materials;
}

// --- Boundary veil, blast markers ------------------------------------------------------------

function createBoundarySphere(parent: THREE.Group, radius: number): void {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: uGoudaTime },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vW;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vW = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vN;
      varying vec3 vW;
      void main() {
        vec3 v = normalize(cameraPosition - vW);
        float f = pow(clamp(1.0 - abs(dot(normalize(vN), v)), 0.0, 1.0), 2.0);
        float bands = 0.75 + 0.25 * sin(vW.y * 0.05 + uTime * 0.2);
        gl_FragColor = vec4(vec3(0.1, 0.35, 0.3) * f * bands, f * 0.16);
      }
    `,
  });
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 48, 32),
    material,
  );
  mesh.frustumCulled = false;
  parent.add(mesh);
}

let markerTexture: THREE.CanvasTexture | null = null;
function getMarkerTexture(): THREE.CanvasTexture | null {
  if (markerTexture || typeof document === "undefined") return markerTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,140,60,0.9)");
  grad.addColorStop(0.35, "rgba(255,100,40,0.25)");
  grad.addColorStop(1, "rgba(255,80,30,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(255,190,120,0.85)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.35;
    ctx.beginPath();
    ctx.moveTo(64 + Math.cos(a) * 6, 64 + Math.sin(a) * 6);
    ctx.lineTo(
      64 + Math.cos(a + 0.25) * (26 + (i % 3) * 9),
      64 + Math.sin(a + 0.25) * (26 + (i % 3) * 9),
    );
    ctx.stroke();
  }
  markerTexture = new THREE.CanvasTexture(canvas);
  return markerTexture;
}

function createBlastMarkers(parent: THREE.Group): void {
  const tex = getMarkerTexture();
  if (!tex) return; // headless (tests)
  markerMaterial = new THREE.SpriteMaterial({
    map: tex,
    color: 0xff9c55,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  for (const bp of blastPoints) {
    const sprite = new THREE.Sprite(markerMaterial);
    sprite.position.set(bp.x, bp.y, bp.z);
    sprite.scale.setScalar(2.6);
    parent.add(sprite);
  }
}

// DEBUG soft-spot markers (L key, main.ts): a wire ball at each drillable
// hull bulge, plus a depth-test-free beacon sprite so the target is findable
// from across the map, through the cheese.
function createSoftSpotMarkers(parent: THREE.Group): void {
  const group = new THREE.Group();
  group.visible = softSpotsOn;
  const shell = new THREE.MeshBasicMaterial({
    color: 0x7cff5a,
    wireframe: true,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
  const tex = getMarkerTexture();
  const beacon = tex
    ? new THREE.SpriteMaterial({
        map: tex,
        color: 0x7cff5a,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      })
    : null;
  for (const s of worldSoftSpots) {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(s.r, 20, 14), shell);
    ball.position.set(s.x, s.y, s.z);
    ball.raycast = () => {};
    group.add(ball);
    if (beacon) {
      const sprite = new THREE.Sprite(beacon);
      sprite.position.set(s.x, s.y, s.z);
      sprite.scale.setScalar(s.r * 0.9);
      sprite.renderOrder = 999;
      group.add(sprite);
    }
  }
  softSpotGroup = group;
  parent.add(group);
}

export function setSoftSpotMarkers(on: boolean): void {
  softSpotsOn = on;
  if (softSpotGroup) softSpotGroup.visible = on;
}

// Nearest open water outside a soft spot — where a debug teleport should
// land, since the spot itself sits in the hull's solid crust.
export function softSpotApproach(s: SoftSpot): Vec3 {
  const len = Math.hypot(s.x, s.y, s.z) || 1;
  const nx = s.x / len,
    ny = s.y / len,
    nz = s.z / len;
  let d = s.r * 0.5;
  for (; d < s.r * 3 + 40; d += 1.5) {
    const p = { x: s.x + nx * d, y: s.y + ny * d, z: s.z + nz * d };
    if (worldDistance(p.x, p.y, p.z) > 2) return p;
  }
  return { x: s.x + nx * d, y: s.y + ny * d, z: s.z + nz * d };
}

// --- Per-frame updates ------------------------------------------------------------------------

const _spinAxis = new THREE.Vector3();

export function updateGouda(
  elapsed: number,
  cameraPos: THREE.Vector3 | null = null,
  visibility = 90,
): void {
  uGoudaTime.value = elapsed;

  // WG-12: orientation = rate × clock, refreshed once per frame — queries
  // un-rotate probes through the same cos/sin, so collision == render holds
  // per frame (surfaces are static within a frame; no drag is imparted).
  if (hasSpin) {
    for (const c of chunks) {
      const sp = c.spin;
      if (!sp) continue;
      const a = sp.rate * elapsed;
      sp.cos = Math.cos(a);
      sp.sin = Math.sin(a);
      if (c.mesh) {
        _spinAxis.set(sp.ax, sp.ay, sp.az);
        c.mesh.quaternion.setFromAxisAngle(_spinAxis, a);
      }
    }
  }

  if (markerMaterial) {
    markerMaterial.opacity = 0.35 + 0.22 * Math.sin(elapsed * 2.6);
  }

  // `elapsed` may step backwards once when the shared clock locks to a
  // younger host — resync the cull timer instead of stalling until it
  // catches back up.
  if (elapsed < lastCull) lastCull = elapsed - 1;
  if (cameraPos && worldGroup && elapsed - lastCull > 0.25) {
    lastCull = elapsed;
    pumpStreaming(cameraPos); // WG-22: mesh what the player is approaching
    const cullDist = Math.min(Math.max(visibility * 1.25, 80), 720);
    for (const child of worldGroup.children) {
      const reach =
        (child.userData.reach as number | undefined) ?? child.scale.x * 1.4;
      child.visible = child.position.distanceTo(cameraPos) - reach < cullDist;
    }
  }
}

// --- World assembly -----------------------------------------------------------------------------

// Direction (frame space) of a world point; out = unit vector.
function frameDirOf(
  f: WorldFrame | null,
  x: number,
  y: number,
  z: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  if (!f) out.set(x, y, z);
  else out.set(x, (f.cos * y - f.sin * z) / f.squash, f.sin * y + f.cos * z);
  const l = out.length() || 1;
  return out.multiplyScalar(1 / l);
}

// The descent route: one through-point per layer boundary, stepping 40–80°
// around and drifting downward. Boundaries come from fused bands + hulls,
// merged when nearly coincident so adjacent layers chain through one door.
function computeSpine(
  rng: Rng,
  world: WorldRecipe,
  frame: WorldFrame | null,
): SpinePoint[] {
  const sp = world.spine;
  if (!sp) return [];
  const radii: number[] = [];
  for (const b of world.biomes) {
    const pl = b.placement;
    if (pl.mode === "hull") radii.push(pl.radius);
    else if (pl.mode === "fused") radii.push(pl.rMax, pl.rMin);
  }
  radii.sort((a, b) => b - a);
  const merged: number[] = [];
  for (const r of radii) {
    if (merged.length && merged[merged.length - 1] - r < 12)
      merged[merged.length - 1] = (merged[merged.length - 1] + r) / 2;
    else merged.push(r);
  }

  const dir = new THREE.Vector3(
    (rng() - 0.5) * 0.7,
    -0.15 - sp.drift * 0.3,
    1,
  ).normalize();
  const pts: SpinePoint[] = [];
  for (const r of merged) {
    const w = frameToWorld(frame, dir.clone().multiplyScalar(r));
    pts.push({ x: w.x, y: w.y, z: w.z, r });
    const step =
      ((sp.stepDeg.min + rng() * (sp.stepDeg.max - sp.stepDeg.min)) * Math.PI) /
      180;
    randDir(rng, _dir2);
    _dir2.addScaledVector(dir, -_dir2.dot(dir));
    if (_dir2.lengthSq() < 1e-4) _dir2.set(1, 0, 0);
    _dir2.normalize();
    dir.multiplyScalar(Math.cos(step)).addScaledVector(_dir2, Math.sin(step));
    dir.y -= sp.drift * 0.4;
    dir.normalize();
  }
  return pts;
}

// How far (u) one vein chunk reads from the last — the sightline placement
// budget AND the trail-validation radius (WG-07).
export const SIGHT_RANGE = 40;

// Hull LayerBody skeleton from a recipe — pure data, NO rng (the caller
// fills nOff). Also used rng-free for placement guards and occlusion.
function makeHullBody(
  pl: Extract<BiomePlacement, { mode: "hull" }>,
  frame: WorldFrame | null,
): LayerBody {
  const squash = frame?.squash ?? 1;
  return {
    kind: "hull",
    frame,
    nOff: 0,
    rMin: 0,
    rMax: pl.radius,
    warpAmp: 0,
    warpFreq: 0,
    surface: pl.surface,
    R: pl.radius,
    halfH:
      pl.surface === "sphere"
        ? pl.radius
        : Math.max(pl.radius * squash, pl.rim + pl.thickness + 6),
    rim: pl.rim,
    thickness: pl.thickness,
    ridgeAmp: pl.ridgeAmp,
    ridgeFreq: pl.ridgeFreq,
    softSpots: [],
  };
}

// BiomeRecipe placements → chunk layout, in table order. The rng stream is a
// pure function of the tables — draw order is part of the world format.
// Spin (WG-12) draws from its own side stream keyed off the seed, so adding
// or tuning rotation never moves the main stream (fingerprints hold).
function placeChunks(
  rng: Rng,
  world: WorldRecipe,
  _diff: number,
  seed: number,
): WorldPlan {
  const spinRng = mulberry32((seed ^ 0x51f15e5) >>> 0);
  const frame = makeFrame(world.frame);
  const specs: ChunkSpec[] = [];
  const softSpots: SoftSpot[] = [];
  const spine = computeSpine(rng, world, frame);
  let entrance: EntranceSpec | null = null;
  const size = (b: BiomeRecipe) =>
    b.sizeVar > 0 ? b.sizeBase + rng() * b.sizeVar : b.sizeBase;

  // Every hull in the recipe, rng-free (hullSolidSdf never reads nOff):
  // scattered chunks must not embed in a husk, and a sphere hull excludes
  // its whole ball (it seals an inner sanctum). Also the occlusion targets.
  const hullGuards = world.biomes.flatMap((b) =>
    b.placement.mode === "hull"
      ? [
          {
            body: makeHullBody(b.placement, frame),
            sphere: b.placement.surface === "sphere",
          },
        ]
      : [],
  );
  const guardDist = (x: number, y: number, z: number): number => {
    let best = Infinity;
    for (const g of hullGuards) {
      const solid = hullSolidSdf(g.body, x, y, z);
      const d = g.sphere ? solid : Math.max(solid, -solid - g.body.thickness);
      if (d < best) best = d;
    }
    return best;
  };
  // Does the segment a→b cross a husk? Sphere-trace on the husk SDFs.
  const huskBlocked = (a: Vec3, b: Vec3): boolean => {
    if (!hullGuards.length) return false;
    const dx = b.x - a.x,
      dy = b.y - a.y,
      dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return false;
    const ux = dx / len,
      uy = dy / len,
      uz = dz / len;
    for (let t = 0; t < len;) {
      const px = a.x + ux * t,
        py = a.y + uy * t,
        pz = a.z + uz * t;
      let d = Infinity;
      for (const g of hullGuards) {
        const solid = hullSolidSdf(g.body, px, py, pz);
        const husk = Math.max(solid, -solid - g.body.thickness);
        if (husk < d) d = husk;
      }
      if (d < 0.4) return true;
      t += Math.max(0.8, d * 0.8);
    }
    return false;
  };

  // Scattered band: rejection-sample against same-zone spacing (guard), the
  // heart, and the hull guards; shrink the chunk when a band is too crowded.
  // sizeGrade (WG-06): size tracks band position, one jitter draw per chunk
  // in the old size() slot keeps the draw order fixed. sightline (WG-07): a
  // candidate is accepted only if an already-placed same-zone chunk (or, for
  // the first, a hull soft spot) reads within SIGHT_RANGE, hull-occlusion
  // checked; odd attempts sample anchor-centred instead of band-uniform so
  // the chain can grow from a sparse anchor set — both go through the SAME
  // acceptance checks.
  const tryBand = (
    biome: BiomeRecipe,
    pl: Extract<BiomePlacement, { mode: "band" }>,
  ) => {
    const jitter = biome.sizeVar > 0 ? rng() : 0;
    const part = pickPart(world, biome, rng);
    const span = pl.rMax - pl.rMin;
    const anchors: { x: number; y: number; z: number; pad: number }[] = [];
    if (pl.sightline) {
      for (const sp of specs)
        if (sp.zone === biome.id)
          anchors.push({
            x: sp.center.x,
            y: sp.center.y,
            z: sp.center.z,
            pad: sp.s * R0,
          });
      for (const sp of softSpots)
        anchors.push({ x: sp.x, y: sp.y, z: sp.z, pad: sp.r });
    }
    for (let shrink = 0; shrink < 4; shrink++) {
      const shrinkMul = 0.9 ** shrink;
      for (let attempt = 0; attempt < 500; attempt++) {
        let p: THREE.Vector3;
        let rad: number;
        if (pl.sightline && anchors.length && attempt % 2 === 1) {
          const a = anchors[Math.floor(rng() * anchors.length)];
          randDir(rng, _dir);
          const reach = a.pad + rng() * SIGHT_RANGE;
          p = new THREE.Vector3(
            a.x + _dir.x * reach,
            a.y + _dir.y * reach,
            a.z + _dir.z * reach,
          );
          rad = frameRadius(frame, p.x, p.y, p.z);
          if (rad < pl.rMin || rad > pl.rMax) continue;
        } else {
          randDir(rng, _dir);
          let u = rng();
          if (pl.densityGrade === "outward") u = Math.sqrt(u);
          else if (pl.densityGrade === "inward") u = 1 - Math.sqrt(1 - u);
          rad = pl.rMin + u * span;
          p = frameToWorld(
            frame,
            new THREE.Vector3(_dir.x * rad, _dir.y * rad, _dir.z * rad),
          );
        }
        let s: number;
        if (pl.sizeGrade) {
          const t = (rad - pl.rMin) / span;
          const g = pl.sizeGrade === "inward" ? 1 - t : t;
          s =
            (biome.sizeBase + biome.sizeVar * g) *
            (0.9 + 0.2 * jitter) *
            shrinkMul;
        } else {
          s = (biome.sizeBase + jitter * biome.sizeVar) * shrinkMul;
        }
        if (guardDist(p.x, p.y, p.z) < s * R0 + 2) continue;
        let ok = true;
        for (const other of specs) {
          const g =
            other.zone === "heart"
              ? world.heartGuard
              : other.zone === biome.id
                ? pl.guard
                : null;
          if (g !== null && p.distanceTo(other.center) < (s + other.s) * g) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (pl.sightline) {
          let seen = false;
          for (const a of anchors) {
            const ax = a.x - p.x,
              ay = a.y - p.y,
              az = a.z - p.z;
            const dist = Math.hypot(ax, ay, az);
            if (dist - s * R0 - a.pad > SIGHT_RANGE) continue;
            // Trace short of the anchor's own surface — a soft spot SITS on
            // the husk, tracing into it would occlude every candidate.
            const cut = Math.min(dist, a.pad + 1.5) / (dist || 1);
            const b = {
              x: a.x - ax * cut,
              y: a.y - ay * cut,
              z: a.z - az * cut,
            };
            if (!huskBlocked({ x: p.x, y: p.y, z: p.z }, b)) {
              seen = true;
              break;
            }
          }
          if (!seen) continue;
        }
        // Seeded tumble (WG-12): axis + varied signed rate off the side
        // stream, drawn per ACCEPTED chunk in placement order.
        let spin: ChunkSpin | undefined;
        if (pl.rotate) {
          randDir(spinRng, _dir2);
          const rate =
            ((pl.rotate.degPerSec * (0.5 + spinRng()) * Math.PI) / 180) *
            (spinRng() < 0.5 ? -1 : 1);
          spin = { ax: _dir2.x, ay: _dir2.y, az: _dir2.z, rate };
        }
        specs.push({
          center: p,
          s,
          res: biome.res,
          label: biome.label,
          zone: biome.id,
          part,
          spin,
        });
        return;
      }
    }
  };

  // Layer bodies: lattice-aligned tiles over one shared analytic body.
  // Spacing equals the marched extent, so tiles abut with identical samples.
  const tileLayer = (biome: BiomeRecipe, body: LayerBody): void => {
    const s = biome.sizeBase;
    const res = biome.res;
    const spacing = (2 * s * (res - 3)) / res;
    const halfW = s * (1 - 3 / res);
    const boxOff = s / res;
    const bound =
      body.kind === "band"
        ? body.rMax + body.warpAmp + s
        : Math.max(body.R, body.halfH) + body.thickness + s;
    const n = Math.ceil(bound / spacing);
    // A cell is kept unless its 9-sample probe (marched-box center + corners,
    // coverage radius = halfW) proves the whole box lies in open water.
    const isVoid = (bx: number, by: number, bz: number): boolean => {
      let minD = bodySdfWorld(body, bx, by, bz);
      if (minD <= halfW + 2) return false;
      for (let ci = -1; ci <= 1; ci += 2)
        for (let cj = -1; cj <= 1; cj += 2)
          for (let ck = -1; ck <= 1; ck += 2) {
            minD = Math.min(
              minD,
              bodySdfWorld(
                body,
                bx + ci * halfW,
                by + cj * halfW,
                bz + ck * halfW,
              ),
            );
            if (minD <= halfW + 2) return false;
          }
      return true;
    };
    for (let i = -n; i <= n; i++)
      for (let j = -n; j <= n; j++)
        for (let k = -n; k <= n; k++) {
          const cx = i * spacing,
            cy = j * spacing,
            cz = k * spacing;
          if (isVoid(cx - boxOff, cy - boxOff, cz - boxOff)) continue;
          specs.push({
            center: new THREE.Vector3(cx, cy, cz),
            s,
            res,
            label: biome.label,
            zone: biome.id,
            part: pickPart(world, biome, rng),
            body,
          });
        }
  };

  // Bisect along a frame ray to the hull's outer solid surface.
  const projectToHull = (
    body: LayerBody,
    dir: THREE.Vector3,
  ): THREE.Vector3 => {
    let lo = body.R * 0.05,
      hi = body.R * 2;
    const probe = new THREE.Vector3();
    const at = (t: number) => {
      probe.copy(dir).multiplyScalar(t);
      frameToWorld(body.frame, probe);
      return hullSolidSdf(body, probe.x, probe.y, probe.z);
    };
    for (let it = 0; it < 24; it++) {
      const mid = (lo + hi) / 2;
      if (at(mid) > 0) hi = mid;
      else lo = mid;
    }
    probe.copy(dir).multiplyScalar((lo + hi) / 2);
    return frameToWorld(body.frame, probe);
  };

  for (const biome of world.biomes) {
    const pl = biome.placement;
    if (pl.mode === "center") {
      specs.push({
        center: new THREE.Vector3(0, 0, 0),
        s: size(biome),
        res: biome.res,
        label: biome.label,
        zone: biome.id,
        part: pickPart(world, biome, rng),
      });
    } else if (pl.mode === "band") {
      for (let i = 0; i < pl.count; i++) tryBand(biome, pl);
    } else if (pl.mode === "fused") {
      const body: LayerBody = {
        kind: "band",
        frame,
        nOff: rng() * 100,
        rMin: pl.rMin,
        rMax: pl.rMax,
        warpAmp: pl.warpAmp,
        warpFreq: pl.warpFreq,
        surface: "sphere",
        R: 0,
        halfH: 0,
        rim: 0,
        thickness: 0,
        ridgeAmp: 0,
        ridgeFreq: 0,
        softSpots: [],
      };
      tileLayer(biome, body);
    } else {
      const body = makeHullBody(pl, frame);
      body.nOff = rng() * 100;
      // Soft spot #1 rides the spine; the rest are seeded on the surface.
      for (let i = 0; i < pl.softSpots; i++) {
        let near: SpinePoint | null = null;
        if (i === 0)
          for (const p of spine)
            if (
              !near ||
              Math.abs(p.r - pl.radius) < Math.abs(near.r - pl.radius)
            )
              near = p;
        if (near && Math.abs(near.r - pl.radius) < 20) {
          frameDirOf(frame, near.x, near.y, near.z, _dir);
        } else {
          randDir(rng, _dir);
        }
        const w = projectToHull(body, _dir);
        const spot = { x: w.x, y: w.y, z: w.z, r: pl.softSpotR };
        body.softSpots.push(spot);
        softSpots.push(spot);
      }
      // WG-08: the ONE hidden entrance — bored at the terminus of the
      // sightline trail (fallback: the spine crossing), angled 55° off
      // radial and recessed behind a rim pocket so it never reads as a
      // silhouette. Draws: one randDir for the bore tangent (re-drawn
      // while degenerate against the normal).
      if (pl.entrance) {
        let tx = 1,
          ty = 0,
          tz = 0;
        let bestD = Infinity;
        for (const sp of specs) {
          const b = world.biomes.find((w) => w.id === sp.zone);
          const bpl = b?.placement;
          if (!bpl || bpl.mode !== "band" || !bpl.sightline) continue;
          const d = Math.abs(
            hullSolidSdf(body, sp.center.x, sp.center.y, sp.center.z),
          );
          if (d < bestD) {
            bestD = d;
            tx = sp.center.x;
            ty = sp.center.y;
            tz = sp.center.z;
          }
        }
        if (!Number.isFinite(bestD) || bestD === Infinity) {
          let near: SpinePoint | null = null;
          for (const p of spine)
            if (
              !near ||
              Math.abs(p.r - pl.radius) < Math.abs(near.r - pl.radius)
            )
              near = p;
          if (near) {
            tx = near.x;
            ty = near.y;
            tz = near.z;
          }
        }
        const fdir = frameDirOf(frame, tx, ty, tz, new THREE.Vector3());
        const E = projectToHull(body, fdir);
        const EPS = 0.5;
        const n = new THREE.Vector3(
          hullSolidSdf(body, E.x + EPS, E.y, E.z) -
            hullSolidSdf(body, E.x - EPS, E.y, E.z),
          hullSolidSdf(body, E.x, E.y + EPS, E.z) -
            hullSolidSdf(body, E.x, E.y - EPS, E.z),
          hullSolidSdf(body, E.x, E.y, E.z + EPS) -
            hullSolidSdf(body, E.x, E.y, E.z - EPS),
        ).normalize();
        const tan = new THREE.Vector3();
        do {
          randDir(rng, tan);
          tan.addScaledVector(n, -tan.dot(n));
        } while (tan.lengthSq() < 0.05);
        tan.normalize();
        const OBLIQUE = (55 * Math.PI) / 180;
        const axis = n
          .clone()
          .multiplyScalar(Math.cos(OBLIQUE))
          .addScaledVector(tan, Math.sin(OBLIQUE))
          .normalize();
        const inLen = (pl.thickness + 8) / Math.cos(OBLIQUE);
        const mouth = E.clone().addScaledVector(axis, 6);
        const inner = E.clone().addScaledVector(axis, -inLen);
        const r = pl.entrance.r;
        body.entranceCarves = {
          holes: [{ x: E.x - n.x, y: E.y - n.y, z: E.z - n.z, r: r + 0.6 }],
          tunnels: [
            {
              ax: mouth.x,
              ay: mouth.y,
              az: mouth.z,
              bx: inner.x,
              by: inner.y,
              bz: inner.z,
              r,
            },
          ],
        };
        entrance = {
          surface: { x: E.x, y: E.y, z: E.z },
          mouth: { x: mouth.x, y: mouth.y, z: mouth.z },
          inner: { x: inner.x, y: inner.y, z: inner.z },
          r,
        };
      }
      tileLayer(biome, body);
    }
  }

  // WG-05: the wreck (bathyscaphe + driller) sits on the spine, mid-drift.
  // Pure function of spine + tables — no rng.
  let wreckPos: Vec3 | null = null;
  const driftBiome = world.biomes.find((b) => b.id === "drift");
  if (spine.length && driftBiome && driftBiome.placement.mode === "band") {
    const dp = driftBiome.placement;
    const dir = frameDirOf(
      frame,
      spine[0].x,
      spine[0].y,
      spine[0].z,
      new THREE.Vector3(),
    );
    const w = frameToWorld(frame, dir.multiplyScalar((dp.rMin + dp.rMax) / 2));
    wreckPos = { x: w.x, y: w.y, z: w.z };
  }

  return { specs, spine, softSpots, entrance, wreckPos, props: [] };
}

// The spine through-point serving a layer boundary at frame radius r, if one
// sits close enough to belong to it. Shared by buildWorldData and the bench's
// fused/hull wedge preview (WG-16) so both pick the same door.
export function nearestSpinePoint(
  spine: SpinePoint[],
  r: number,
): SpinePoint | null {
  let best: SpinePoint | null = null;
  for (const p of spine)
    if (!best || Math.abs(p.r - r) < Math.abs(best.r - r)) best = p;
  return best && Math.abs(best.r - r) < 15 ? best : null;
}

// Layout-only pass for the worldgen bench's map view: the chunk placement a
// build would use (plus spine + soft spots), no meshing, no module state.
export function planWorldLayout(
  seed: number,
  difficulty: number,
  world: WorldRecipe,
): WorldPlan {
  const errors = validateWorld(world);
  if (errors.length) throw new Error(`worldgen: ${errors.join("; ")}`);
  return placeChunks(mulberry32(seed >>> 0), world, difficulty, seed >>> 0);
}

// --- Layer carve networks ---------------------------------------------------------------------

export interface LayerGenOpts {
  loopFrac: number;
  sideExits: number;
  spineIn: SpinePoint | null;
  spineOut: SpinePoint | null;
  eyesOut?: SphereCarve[]; // sink for the layer's world-space eyes (WG-11 hazard hosts)
}

// World-space bent tunnel polyline (addTunnel's world-unit twin).
function addWorldTunnel(
  rng: Rng,
  a: Vec3,
  b: Vec3,
  r: number,
  bends: number,
  sink: Tunnel[],
): void {
  if (!bends) {
    sink.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, r });
    return;
  }
  const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const pts: Vec3[] = [a];
  for (let i = 1; i <= bends; i++) {
    const t = i / (bends + 1);
    randDir(rng, _dir2);
    const bend = len * (0.12 + rng() * 0.16);
    pts.push({
      x: a.x + (b.x - a.x) * t + _dir2.x * bend,
      y: a.y + (b.y - a.y) * t + _dir2.y * bend,
      z: a.z + (b.z - a.z) * t + _dir2.z * bend,
    });
  }
  pts.push(b);
  for (let i = 0; i < pts.length - 1; i++)
    sink.push({
      ax: pts[i].x,
      ay: pts[i].y,
      az: pts[i].z,
      bx: pts[i + 1].x,
      by: pts[i + 1].y,
      bz: pts[i + 1].z,
      r,
    });
}

// One layer-body biome → tile chunks. Carves are generated in WORLD units:
// per-tile eye clusters + trees, an inter-tile spanning tree + loops, side
// exits, and the spine doors, then distributed into every tile they touch.
// Exported for the worldgen bench's fused/hull wedge preview.
export function buildLayerChunks(
  rng: Rng,
  specs: ChunkSpec[],
  ctx: GenCtx,
  opts: LayerGenOpts,
): Chunk[] {
  const body = specs[0].body!;
  const frame = body.frame;
  const holesW: SphereCarve[] = [];
  const tunnelsW: Tunnel[] = [];
  const tileEyes: SphereCarve[][] = [];
  const tunnelScale = [1.15, 1.0, 0.85][ctx.difficulty - 1] ?? 1.0;
  const minR = (spec: ChunkSpec) =>
    (spec.part.narrow ? 2.2 : 2.6) * ((2 * spec.s) / spec.res);
  const treeR = (spec: ChunkSpec, base: number) =>
    Math.max(minR(spec), base * tunnelScale * spec.s);

  const _p = { x: 0, y: 0, z: 0 };

  for (const spec of specs) {
    const part = spec.part;
    const s = spec.s;
    const inner = s * (1 - 6 / spec.res);
    const eyes: SphereCarve[] = [];
    const sampleAt = (): void => {
      _p.x = spec.center.x + (rng() * 2 - 1) * inner;
      _p.y = spec.center.y + (rng() * 2 - 1) * inner;
      _p.z = spec.center.z + (rng() * 2 - 1) * inner;
    };

    const nEyes =
      part.eyes.min + Math.floor(rng() * (part.eyes.max - part.eyes.min + 1));
    for (let i = 0; i < nEyes; i++) {
      const r = (part.eyes.rBase + part.eyes.rVar * rng()) * s;
      if (r <= 0) continue;
      for (let attempt = 0; attempt < 10; attempt++) {
        sampleAt();
        if (bodySdfWorld(body, _p.x, _p.y, _p.z) < -r * 0.5) {
          const eye = { x: _p.x, y: _p.y, z: _p.z, r };
          eyes.push(eye);
          holesW.push(eye);
          break;
        }
      }
    }
    if (part.chambers && rng() < part.chambers.chance) {
      const r = (part.chambers.rBase + part.chambers.rVar * rng()) * s;
      for (let attempt = 0; attempt < 10; attempt++) {
        sampleAt();
        if (bodySdfWorld(body, _p.x, _p.y, _p.z) < -r * 0.35) {
          const room = { x: _p.x, y: _p.y, z: _p.z, r };
          eyes.push(room);
          holesW.push(room);
          break;
        }
      }
    }
    const nPores =
      part.pores.min +
      Math.floor(rng() * (part.pores.max - part.pores.min + 1));
    for (let i = 0; i < nPores; i++) {
      const r = Math.max(
        1.6 * ((2 * s) / spec.res),
        (part.pores.rBase + part.pores.rVar * rng()) * s,
      );
      for (let attempt = 0; attempt < 8; attempt++) {
        sampleAt();
        if (Math.abs(bodySdfWorld(body, _p.x, _p.y, _p.z)) < r * 0.9) {
          holesW.push({ x: _p.x, y: _p.y, z: _p.z, r });
          break;
        }
      }
    }

    const bends = part.tunnels.bends;
    for (let i = 1; i < eyes.length; i++) {
      let best = 0,
        second = 0,
        bestD = Infinity,
        secondD = Infinity;
      for (let j = 0; j < i; j++) {
        const dx = eyes[i].x - eyes[j].x,
          dy = eyes[i].y - eyes[j].y,
          dz = eyes[i].z - eyes[j].z;
        const dd = dx * dx + dy * dy + dz * dz;
        if (dd < bestD) {
          secondD = bestD;
          second = best;
          bestD = dd;
          best = j;
        } else if (dd < secondD) {
          secondD = dd;
          second = j;
        }
      }
      const j = part.tangle
        ? i > 1 && rng() < 0.5
          ? Math.floor(rng() * i)
          : best
        : i > 2 && rng() < 0.3
          ? second
          : best;
      addWorldTunnel(
        rng,
        eyes[i],
        eyes[j],
        treeR(spec, part.tunnels.rBase + part.tunnels.rVar * rng()),
        bends,
        tunnelsW,
      );
    }
    if (eyes.length >= 2) {
      const loops = 1 + Math.floor(eyes.length / 6);
      for (let i = 0; i < loops; i++) {
        const a = eyes[Math.floor(rng() * eyes.length)];
        const b = eyes[Math.floor(rng() * eyes.length)];
        if (a === b) continue;
        addWorldTunnel(
          rng,
          a,
          b,
          treeR(spec, part.tunnels.rBase * 0.9 + part.tunnels.rVar * rng()),
          bends,
          tunnelsW,
        );
      }
    }

    const nDead = part.deadEnds + (ctx.difficulty - 1);
    for (let k = 0; k < nDead && eyes.length >= 2; k++) {
      const start = eyes[Math.floor(rng() * eyes.length)];
      let target = eyes[Math.floor(rng() * eyes.length)];
      if (target === start)
        target = eyes[(eyes.indexOf(target) + 1) % eyes.length];
      randDir(rng, _dir);
      const chR = (0.06 + 0.05 * rng()) * s;
      const wall = (0.045 + 0.02 * rng()) * s;
      const ch = {
        x: target.x + _dir.x * (target.r + chR + wall),
        y: target.y + _dir.y * (target.r + chR + wall),
        z: target.z + _dir.z * (target.r + chR + wall),
        r: chR,
      };
      if (bodySdfWorld(body, ch.x, ch.y, ch.z) > -chR * 0.8) continue;
      holesW.push(ch);
      addWorldTunnel(
        rng,
        start,
        ch,
        treeR(spec, 0.045 + 0.03 * rng()),
        bends,
        tunnelsW,
      );
      ctx.blastPoints.push({
        x: target.x + _dir.x * (target.r + wall / 2),
        y: target.y + _dir.y * (target.r + wall / 2),
        z: target.z + _dir.z * (target.r + wall / 2),
      });
    }
    tileEyes.push(eyes);
  }

  // Nearest eye pair between two tiles → one connecting tunnel.
  const linkTiles = (i: number, j: number): void => {
    let ea: SphereCarve | null = null,
      eb: SphereCarve | null = null,
      bd = Infinity;
    for (const a of tileEyes[i])
      for (const b of tileEyes[j]) {
        const dx = a.x - b.x,
          dy = a.y - b.y,
          dz = a.z - b.z;
        const dd = dx * dx + dy * dy + dz * dz;
        if (dd < bd) {
          bd = dd;
          ea = a;
          eb = b;
        }
      }
    if (!ea || !eb) return;
    const part = specs[i].part;
    addWorldTunnel(
      rng,
      ea,
      eb,
      treeR(specs[i], part.tunnels.rBase + part.tunnels.rVar * rng()),
      Math.min(part.tunnels.bends, 2),
      tunnelsW,
    );
  };

  // Inter-tile spanning tree keeps the whole layer one connected network.
  for (let i = 1; i < specs.length; i++) {
    if (!tileEyes[i].length) continue;
    let best = -1,
      bestD = Infinity;
    for (let j = 0; j < i; j++) {
      if (!tileEyes[j].length) continue;
      const dd = specs[i].center.distanceToSquared(specs[j].center);
      if (dd < bestD) {
        bestD = dd;
        best = j;
      }
    }
    if (best >= 0) linkTiles(i, best);
  }

  if (opts.loopFrac > 0 && specs.length > 1) {
    const spacing = (2 * specs[0].s * (specs[0].res - 3)) / specs[0].res;
    for (let i = 0; i < specs.length; i++)
      for (let j = i + 1; j < specs.length; j++) {
        if (!tileEyes[i].length || !tileEyes[j].length) continue;
        if (specs[i].center.distanceTo(specs[j].center) > spacing * 1.2)
          continue;
        if (rng() < opts.loopFrac) linkTiles(i, j);
      }
  }

  // Nearest eye to a world point, across every tile.
  const nearestEye = (
    x: number,
    y: number,
    z: number,
  ): { eye: SphereCarve; tile: number } | null => {
    let eye: SphereCarve | null = null,
      tile = -1,
      bd = Infinity;
    for (let i = 0; i < specs.length; i++)
      for (const e of tileEyes[i]) {
        const dx = e.x - x,
          dy = e.y - y,
          dz = e.z - z;
        const dd = dx * dx + dy * dy + dz * dz;
        if (dd < bd) {
          bd = dd;
          eye = e;
          tile = i;
        }
      }
    return eye ? { eye, tile } : null;
  };

  // Side exits: bores from the network out to the outer medium.
  for (let k = 0; k < opts.sideExits; k++) {
    randDir(rng, _dir);
    const mouth = frameToWorld(
      frame,
      _dir.clone().multiplyScalar(body.rMax + 6),
    );
    const found = nearestEye(mouth.x, mouth.y, mouth.z);
    if (!found) break;
    const part = specs[found.tile].part;
    addWorldTunnel(
      rng,
      { x: mouth.x, y: mouth.y, z: mouth.z },
      found.eye,
      treeR(specs[found.tile], part.tunnels.rBase + part.tunnels.rVar * 0.5),
      1,
      tunnelsW,
    );
  }

  // Spine doors: thread the layer between its two boundary through-points.
  // Both adjacent layers bore to the SAME spine point, so the two half-doors
  // are guaranteed to meet there — a mouth→eye tunnel that merely passes
  // near p can miss its counterpart and seal the descent shut. The straight
  // skin-crossing bore draws no rng; radius floors at 2 u so boundary crust
  // noise cannot pinch the one critical corridor.
  const spineLink = (p: SpinePoint | null, outward: boolean): void => {
    if (!p) return;
    frameDirOf(frame, p.x, p.y, p.z, _dir);
    const rTarget = outward ? p.r + 6 : Math.max(p.r - 6, 2);
    const mouth = frameToWorld(frame, _dir.clone().multiplyScalar(rTarget));
    const found = nearestEye(p.x, p.y, p.z);
    if (!found) return;
    const part = specs[found.tile].part;
    const r = Math.max(
      treeR(specs[found.tile], part.tunnels.rBase + part.tunnels.rVar * 0.5),
      2.0,
    );
    tunnelsW.push({
      ax: mouth.x,
      ay: mouth.y,
      az: mouth.z,
      bx: p.x,
      by: p.y,
      bz: p.z,
      r,
    });
    addWorldTunnel(rng, { x: p.x, y: p.y, z: p.z }, found.eye, r, 1, tunnelsW);
  };
  spineLink(opts.spineIn, true);
  spineLink(opts.spineOut, false);

  if (opts.eyesOut) for (const eyes of tileEyes) opts.eyesOut.push(...eyes);

  // WG-08: the hull's own hidden-entrance carves. Sealed tiles refuse only
  // FOREIGN carves — the door belongs to this layer; shareCarves later
  // spreads it into the interpenetrating neighbours as usual.
  if (body.entranceCarves) {
    holesW.push(...body.entranceCarves.holes);
    tunnelsW.push(...body.entranceCarves.tunnels);
  }

  // Distribute the world carves into every tile whose marched box they touch.
  const out: Chunk[] = [];
  for (let t = 0; t < specs.length; t++) {
    const spec = specs[t];
    const s = spec.s;
    const cellW = (2 * s) / spec.res;
    const pad = SMOOTH_K * s + 2 * cellW;
    const lox = spec.center.x - (s - cellW),
      hix = spec.center.x + (s - 2 * cellW),
      loy = spec.center.y - (s - cellW),
      hiy = spec.center.y + (s - 2 * cellW),
      loz = spec.center.z - (s - cellW),
      hiz = spec.center.z + (s - 2 * cellW);

    const holes: SphereCarve[] = [];
    for (const h of holesW) {
      const p2 = h.r + pad;
      if (
        h.x + p2 < lox ||
        h.x - p2 > hix ||
        h.y + p2 < loy ||
        h.y - p2 > hiy ||
        h.z + p2 < loz ||
        h.z - p2 > hiz
      )
        continue;
      holes.push({
        x: (h.x - spec.center.x) / s,
        y: (h.y - spec.center.y) / s,
        z: (h.z - spec.center.z) / s,
        r: h.r / s,
      });
    }
    const tunnels: Tunnel[] = [];
    for (const tn of tunnelsW) {
      const p2 = tn.r + pad;
      if (
        Math.max(tn.ax, tn.bx) + p2 < lox ||
        Math.min(tn.ax, tn.bx) - p2 > hix ||
        Math.max(tn.ay, tn.by) + p2 < loy ||
        Math.min(tn.ay, tn.by) - p2 > hiy ||
        Math.max(tn.az, tn.bz) + p2 < loz ||
        Math.min(tn.az, tn.bz) - p2 > hiz
      )
        continue;
      tunnels.push({
        ax: (tn.ax - spec.center.x) / s,
        ay: (tn.ay - spec.center.y) / s,
        az: (tn.az - spec.center.z) / s,
        bx: (tn.bx - spec.center.x) / s,
        by: (tn.by - spec.center.y) / s,
        bz: (tn.bz - spec.center.z) / s,
        r: tn.r / s,
      });
    }

    const part = spec.part;
    const c: Chunk = {
      center: spec.center,
      s,
      res: spec.res,
      ix: 1,
      iy: 1,
      iz: 1,
      minAxis: 1,
      nOff: body.nOff,
      amp: part.crust.amp,
      freq: part.crust.freq,
      crustDepth: part.crust.depth,
      planes: [],
      holes,
      tunnels,
      digs: [],
      hardness: part.hardness,
      field: null,
      mesh: null,
      body,
    };
    if (part.noCarveWithin != null) c.sealed = true;
    let biggest: SphereCarve | null = null;
    for (const e of tileEyes[t]) if (!biggest || e.r > biggest.r) biggest = e;
    c.biggestEye = biggest
      ? {
          x: (biggest.x - spec.center.x) / s,
          y: (biggest.y - spec.center.y) / s,
          z: (biggest.z - spec.center.z) / s,
          r: biggest.r / s,
        }
      : null;
    out.push(c);
  }
  return out;
}

// Carves must compose across interpenetrating meshes: a tunnel that crosses
// from a layer tile into an ellipsoid chunk (or into the next layer) has to
// cut both. Sealed tiles (noCarveWithin) never receive foreign carves.
// Pairs of plain ellipsoid chunks never share — scatter chunks are
// independent bodies by design.
function shareCarves(list: Chunk[]): void {
  const addH: SphereCarve[][] = list.map(() => []);
  const addT: Tunnel[][] = list.map(() => []);

  const collect = (
    src: Chunk,
    dst: Chunk,
    hSink: SphereCarve[],
    tSink: Tunnel[],
  ) => {
    if (dst.sealed) return;
    const s = dst.s;
    const cellW = (2 * s) / dst.res;
    const pad = SMOOTH_K * s + 2 * cellW;
    const lox = dst.center.x - (s - cellW),
      hix = dst.center.x + (s - 2 * cellW),
      loy = dst.center.y - (s - cellW),
      hiy = dst.center.y + (s - 2 * cellW),
      loz = dst.center.z - (s - cellW),
      hiz = dst.center.z + (s - 2 * cellW);
    for (const h of src.holes) {
      const wx = src.center.x + h.x * src.s,
        wy = src.center.y + h.y * src.s,
        wz = src.center.z + h.z * src.s,
        wr = h.r * src.s;
      const p2 = wr + pad;
      if (
        wx + p2 < lox ||
        wx - p2 > hix ||
        wy + p2 < loy ||
        wy - p2 > hiy ||
        wz + p2 < loz ||
        wz - p2 > hiz
      )
        continue;
      hSink.push({
        x: (wx - dst.center.x) / s,
        y: (wy - dst.center.y) / s,
        z: (wz - dst.center.z) / s,
        r: wr / s,
      });
    }
    for (const tn of src.tunnels) {
      const ax = src.center.x + tn.ax * src.s,
        ay = src.center.y + tn.ay * src.s,
        az = src.center.z + tn.az * src.s,
        bx = src.center.x + tn.bx * src.s,
        by = src.center.y + tn.by * src.s,
        bz = src.center.z + tn.bz * src.s,
        wr = tn.r * src.s;
      const p2 = wr + pad;
      if (
        Math.max(ax, bx) + p2 < lox ||
        Math.min(ax, bx) - p2 > hix ||
        Math.max(ay, by) + p2 < loy ||
        Math.min(ay, by) - p2 > hiy ||
        Math.max(az, bz) + p2 < loz ||
        Math.min(az, bz) - p2 > hiz
      )
        continue;
      tSink.push({
        ax: (ax - dst.center.x) / s,
        ay: (ay - dst.center.y) / s,
        az: (az - dst.center.z) / s,
        bx: (bx - dst.center.x) / s,
        by: (by - dst.center.y) / s,
        bz: (bz - dst.center.z) / s,
        r: wr / s,
      });
    }
  };

  // Candidate pairs off a coarse grid over the chunks' influence balls
  // (WG-21): two chunks within (sa+sb)·1.74 of each other always share a
  // cell, so the cells yield a superset of the O(n²) sweep's hits. The
  // original predicate then runs in ascending (a, b) order — the collected
  // carve order, and so the geometry, is unchanged.
  const CELL = 48;
  const cellGrid = new Map<number, number[]>();
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const reach = c.s * 1.74;
    const lo = (v: number) => Math.floor((v - reach) / CELL);
    const hi = (v: number) => Math.floor((v + reach) / CELL);
    for (let x = lo(c.center.x); x <= hi(c.center.x); x++)
      for (let y = lo(c.center.y); y <= hi(c.center.y); y++)
        for (let z = lo(c.center.z); z <= hi(c.center.z); z++) {
          const key = ((x + 512) << 20) | ((y + 512) << 10) | (z + 512);
          let bucket = cellGrid.get(key);
          if (!bucket) cellGrid.set(key, (bucket = []));
          bucket.push(i);
        }
  }
  const pairKeys = new Set<number>();
  const n = list.length;
  for (const bucket of cellGrid.values())
    for (let i = 0; i < bucket.length; i++)
      for (let j = i + 1; j < bucket.length; j++)
        pairKeys.add(bucket[i] * n + bucket[j]); // buckets are ascending
  for (const key of [...pairKeys].sort((p, q) => p - q)) {
    const a = Math.floor(key / n);
    const b = key % n;
    const ca = list[a];
    const cb = list[b];
    if (!ca.body && !cb.body) continue;
    if (ca.body && ca.body === cb.body) continue;
    if (ca.center.distanceTo(cb.center) > (ca.s + cb.s) * 1.74) continue;
    collect(ca, cb, addH[b], addT[b]);
    collect(cb, ca, addH[a], addT[a]);
  }
  for (let i = 0; i < list.length; i++) {
    if (addH[i].length) list[i].holes.push(...addH[i]);
    if (addT[i].length) list[i].tunnels.push(...addT[i]);
  }
}

function makeDebrisGeometry(off: number): THREE.IcosahedronGeometry {
  const geo = new THREE.IcosahedronGeometry(1, 3);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = fbm3(
      v.x * 1.4 + off,
      v.y * 1.4 + off * 2.1,
      v.z * 1.4 + off * 0.7,
    );
    v.multiplyScalar(1 + 0.26 * n);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// One free-floating crumb, fully determined at the data phase.
export interface DebrisSpec {
  center: THREE.Vector3;
  r: number; // collision radius (0.8 × scale)
  s: number; // visual scale
  rot: Vec3;
  geoIndex: number; // which of the seeded crumb geometries
}

// Everything the generator decides before any triangle exists. This is the
// WHOLE seeded stream — plan, carved chunks, debris, gold, spawn — shared by
// the game (buildGoudaWorld), the bench, and the route verifier (WG-02).
export interface WorldData {
  world: WorldRecipe;
  plan: WorldPlan;
  chunks: Chunk[];
  debris: DebrisSpec[];
  debrisNoiseOffsets: number[]; // crust-noise offsets of the crumb geometries
  goldPos: Vec3;
  spawnPoint: Vec3;
  blastPoints: Vec3[];
}

// WG-11 — seeded props. Drawn at the TAIL of the rng stream (strictly after
// every chunk/debris/gold/spawn draw), so the world fingerprint is untouched.
// Draw order: biomes in table order — air-pocket picks, then hazards as
// melt_fall → melt_pool → thermal_vent — then the wreck (no rng). A prop is
// marched along ±y from its host eye and bisected to PROP_SNAP u of water
// between it and the surface, so it hugs a real ceiling/floor of the carved
// geometry (spot-checkable via distanceToWorld).
const PROP_SNAP = 0.38;
const HAZARD_MIN_EYE_R = 5; // hazards live in the big caverns only
const HAZARD_SPACING = 4; // min gap between same-kind hazards

function seedProps(
  rng: Rng,
  world: WorldRecipe,
  plan: WorldPlan,
  chunkList: Chunk[],
  layerEyes: Map<ZoneName, SphereCarve[]>,
): SeededProp[] {
  const props: SeededProp[] = [];
  const dist = (x: number, y: number, z: number) =>
    distanceToWorld(chunkList, [], x, y, z);

  const snapToSurface = (
    from: Vec3,
    dirY: 1 | -1,
    maxT: number,
  ): Vec3 | null => {
    if (dist(from.x, from.y, from.z) < PROP_SNAP) return null;
    let lo = 0;
    for (let t = 0.25; t <= maxT; t += 0.25) {
      if (dist(from.x, from.y + dirY * t, from.z) < PROP_SNAP) {
        let hi = t;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          if (dist(from.x, from.y + dirY * mid, from.z) < PROP_SNAP) hi = mid;
          else lo = mid;
        }
        return { x: from.x, y: from.y + dirY * lo, z: from.z };
      }
      lo = t;
    }
    return null;
  };
  const normalAt = (p: Vec3): Vec3 => {
    const E = 0.2;
    const nx = dist(p.x + E, p.y, p.z) - dist(p.x - E, p.y, p.z);
    const ny = dist(p.x, p.y + E, p.z) - dist(p.x, p.y - E, p.z);
    const nz = dist(p.x, p.y, p.z + E) - dist(p.x, p.y, p.z - E);
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-6) return { x: 0, y: 1, z: 0 };
    return { x: nx / len, y: ny / len, z: nz / len };
  };

  for (const biome of world.biomes) {
    const budget = biome.budgets;
    if (!budget) continue;

    if (budget.airPockets > 0) {
      // Candidate hosts: this zone's chunks with a roomy interior eye. Picks
      // draw without replacement; a failed march discards the candidate.
      const cands: { x: number; y: number; z: number; r: number }[] = [];
      for (const c of chunkList) {
        if (c.zone !== biome.id || !c.biggestEye) continue;
        const e = c.biggestEye;
        if (e.r * c.s < 1.2) continue;
        cands.push({
          x: c.center.x + e.x * c.s,
          y: c.center.y + e.y * c.s,
          z: c.center.z + e.z * c.s,
          r: e.r * c.s,
        });
      }
      for (let n = 0; n < budget.airPockets && cands.length; n++) {
        for (let attempt = 0; attempt < 20 && cands.length; attempt++) {
          const eye = cands.splice(Math.floor(rng() * cands.length), 1)[0];
          const pos = snapToSurface(eye, 1, eye.r * 1.3 + 1);
          if (pos) {
            props.push({ kind: "airPocket", zone: biome.id, pos });
            break;
          }
        }
      }
    }

    const haz = budget.hazards;
    if (haz) {
      const eyes = (layerEyes.get(biome.id) ?? []).filter(
        (e) => e.r >= HAZARD_MIN_EYE_R,
      );
      const place = (kind: SeededPropKind, count: number, dirY: 1 | -1) => {
        const placed: Vec3[] = [];
        for (let n = 0; n < count && eyes.length; n++) {
          for (let attempt = 0; attempt < 12; attempt++) {
            const e = eyes[Math.floor(rng() * eyes.length)];
            const ang = rng() * Math.PI * 2;
            const f = Math.sqrt(rng()) * 0.5;
            const from = {
              x: e.x + Math.cos(ang) * e.r * f,
              y: e.y,
              z: e.z + Math.sin(ang) * e.r * f,
            };
            const pos = snapToSurface(from, dirY, e.r * 1.4);
            if (!pos) continue;
            let clear = true;
            for (const q of placed)
              if (
                Math.hypot(pos.x - q.x, pos.y - q.y, pos.z - q.z) <
                HAZARD_SPACING
              ) {
                clear = false;
                break;
              }
            if (!clear) continue;
            placed.push(pos);
            props.push({
              kind,
              zone: biome.id,
              pos,
              dir: normalAt(pos),
              phase: rng(),
            });
            break;
          }
        }
      };
      place("melt_fall", haz.meltFalls, 1);
      place("melt_pool", haz.meltPools, -1);
      place("thermal_vent", haz.vents, -1);
    }
  }

  if (plan.wreckPos)
    props.push({ kind: "wreck", zone: "drift", pos: { ...plan.wreckPos } });
  return props;
}

// The data phase of buildGoudaWorld: plan + chunks + carves, no meshing, no
// module state. Draw order IS the world format — any reordering here changes
// every seed's world.
export function buildWorldData(opts: {
  seed: number;
  difficulty: number;
  world?: WorldRecipe;
}): WorldData {
  const world = opts.world ?? WHEEL_WORLD;
  const diff = Math.min(3, Math.max(1, opts.difficulty));

  const errors = validateWorld(world);
  if (errors.length) throw new Error(`worldgen: ${errors.join("; ")}`);

  const rng = mulberry32(opts.seed >>> 0);
  const plan = placeChunks(rng, world, diff, opts.seed >>> 0);
  const specs = plan.specs;
  const frame = makeFrame(world.frame);
  const blast: Vec3[] = [];
  const ctx: GenCtx = { difficulty: diff, blastPoints: blast };

  // Phase 1 — chunk data. Layer-body biomes generate as whole layers (their
  // tiles are contiguous in spec order); everything else is per-chunk.
  const pending: Chunk[] = [];
  const layerEyes = new Map<ZoneName, SphereCarve[]>(); // WG-11 hazard hosts
  for (let i = 0; i < specs.length;) {
    const spec = specs[i];
    if (spec.body) {
      let j = i;
      while (j < specs.length && specs[j].body === spec.body) j++;
      const biome = world.biomes.find((b) => b.id === spec.zone)!;
      const pl = biome.placement;
      const eyeSink: SphereCarve[] = [];
      const layerOpts: LayerGenOpts =
        pl.mode === "fused"
          ? {
              loopFrac: pl.loopFrac,
              sideExits: pl.sideExits,
              spineIn: nearestSpinePoint(plan.spine, pl.rMax),
              spineOut: nearestSpinePoint(plan.spine, pl.rMin),
              eyesOut: eyeSink,
            }
          : {
              loopFrac: 0,
              sideExits: 0,
              spineIn: null,
              spineOut: null,
              eyesOut: eyeSink,
            };
      for (const c of buildLayerChunks(
        rng,
        specs.slice(i, j),
        ctx,
        layerOpts,
      )) {
        c.zone = spec.zone;
        pending.push(c);
      }
      layerEyes.set(spec.zone, eyeSink);
      i = j;
    } else {
      const chunk = makeChunkData(
        rng,
        spec.center,
        spec.s,
        spec.res,
        spec.part,
        ctx,
      );
      chunk.zone = spec.zone;
      if (spec.spin) chunk.spin = { ...spec.spin, cos: 1, sin: 0 };
      pending.push(chunk);
      i++;
    }
  }

  // Entrance connector (WG-08): the hidden bore must open into the inner
  // network, not dead-end in paste — one straight corridor from the bore's
  // inner end to the nearest big eye deeper inside the seal. Owned by that
  // eye's chunk so shareCarves distributes it; draws no rng.
  if (plan.entrance) {
    const inn = plan.entrance.inner;
    const innR = Math.hypot(inn.x, inn.y, inn.z);
    let host: Chunk | null = null;
    let hd = Infinity;
    for (const c of pending) {
      if (c.sealed || !c.biggestEye) continue;
      const ex = c.center.x + c.biggestEye.x * c.s,
        ey = c.center.y + c.biggestEye.y * c.s,
        ez = c.center.z + c.biggestEye.z * c.s;
      if (Math.hypot(ex, ey, ez) > innR + 2) continue;
      const d = Math.hypot(ex - inn.x, ey - inn.y, ez - inn.z);
      if (d < hd) {
        hd = d;
        host = c;
      }
    }
    if (host) {
      const e = host.biggestEye!;
      const bx = host.center.x + e.x * host.s,
        by = host.center.y + e.y * host.s,
        bz = host.center.z + e.z * host.s;
      const r = plan.entrance.r;
      // Distribute into every non-sealed tile the corridor touches — same-
      // layer tiles never exchange carves in shareCarves, so this must be
      // spread by hand (same box + pad rule as the layer distribution).
      for (const c of pending) {
        if (c.sealed) continue;
        const s = c.s;
        const cellW = (2 * s) / c.res;
        const pad = SMOOTH_K * s + 2 * cellW + r;
        if (
          Math.max(inn.x, bx) + pad < c.center.x - (s - cellW) ||
          Math.min(inn.x, bx) - pad > c.center.x + (s - 2 * cellW) ||
          Math.max(inn.y, by) + pad < c.center.y - (s - cellW) ||
          Math.min(inn.y, by) - pad > c.center.y + (s - 2 * cellW) ||
          Math.max(inn.z, bz) + pad < c.center.z - (s - cellW) ||
          Math.min(inn.z, bz) - pad > c.center.z + (s - 2 * cellW)
        )
          continue;
        c.tunnels.push({
          ax: (inn.x - c.center.x) / s,
          ay: (inn.y - c.center.y) / s,
          az: (inn.z - c.center.z) / s,
          bx: (bx - c.center.x) / s,
          by: (by - c.center.y) / s,
          bz: (bz - c.center.z) / s,
          r: r / s,
        });
      }
    }
  }

  // Phase 2 — compose carves across interpenetrating meshes.
  shareCarves(pending);

  // Debris crumbs: geometry noise offsets first, then placements — the exact
  // draw order the mesher used when this lived inline.
  const debrisNoiseOffsets = [rng() * 50, rng() * 50, rng() * 50];
  const debrisSpecs: DebrisSpec[] = [];
  for (let i = 0; i < world.debrisCount; i++) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const host = pending[Math.floor(rng() * pending.length)];
      randDir(rng, _dir);
      const dist = host.s * (0.75 + rng() * 0.65);
      const p = new THREE.Vector3(
        host.center.x + _dir.x * dist,
        host.center.y + _dir.y * dist,
        host.center.z + _dir.z * dist,
      );
      const s = 0.7 + rng() * 2.4;
      if (distanceToWorld(pending, debrisSpecs, p.x, p.y, p.z) < s + 1.2)
        continue;
      const rot = {
        x: rng() * Math.PI * 2,
        y: rng() * Math.PI * 2,
        z: rng() * Math.PI * 2,
      };
      debrisSpecs.push({ center: p, r: s * 0.8, s, rot, geoIndex: i % 3 });
      break;
    }
  }

  // Hide gold in random mid-radius wheel cavern (seeded, off-compass).
  const candidates = pending.filter((c) => {
    const r = frameRadius(frame, c.center.x, c.center.y, c.center.z);
    return (
      c.biggestEye &&
      r >= world.goldBand.min &&
      r <= world.goldBand.max &&
      c.biggestEye.r * c.s > world.goldMinCavernR
    );
  });
  const host = candidates.length
    ? candidates[Math.floor(rng() * candidates.length)]
    : pending[0];
  const eye = host.biggestEye!;
  const goldPos = {
    x: host.center.x + eye.x * host.s,
    y: host.center.y + eye.y * host.s,
    z: host.center.z + eye.z * host.s,
  };

  // Spawn at drift edge; keep bathyscaphe exit corridor clear.
  const p = new THREE.Vector3(0, 18, world.worldR + 14);
  while (
    (distanceToWorld(pending, debrisSpecs, p.x, p.y, p.z) < 6 ||
      distanceToWorld(pending, debrisSpecs, p.x, p.y, p.z - 9) < 4) &&
    p.z < world.boundaryR - 6
  )
    p.z += 3;

  // WG-11 — the tail of the stream: prop seeding draws only after everything
  // above, so the chunk/debris/gold/spawn fingerprint never moves.
  plan.props = seedProps(rng, world, plan, pending, layerEyes);

  return {
    world,
    plan,
    chunks: pending,
    debris: debrisSpecs,
    debrisNoiseOffsets,
    goldPos,
    spawnPoint: { x: p.x, y: p.y, z: p.z },
    blastPoints: blast,
  };
}

export async function buildGoudaWorld(
  scene: THREE.Scene,
  onProgress: (done: number, total: number, label: string) => void = () => {},
  opts: {
    seed?: number;
    difficulty?: number;
    world?: WorldRecipe;
    workers?: boolean; // false forces the sync path (node, tests, verifier)
    stream?: boolean; // WG-22: mesh near spawn now, the rest by distance
  } = {},
): Promise<THREE.Group> {
  worldSeed = (opts.seed ?? worldSeed) >>> 0;
  difficulty = Math.min(3, Math.max(1, opts.difficulty ?? difficulty));
  // The game always builds the shipped tables; the worldgen bench passes
  // its live-edited WorldRecipe here to preview a layout for real.
  const world = opts.world ?? WHEEL_WORLD;

  const t0 = performance.now();
  const data = buildWorldData({ seed: worldSeed, difficulty, world });
  const materials = createZoneMaterials(world);
  const group = new THREE.Group();
  worldGroup = group;
  extrasGroup = new THREE.Group();

  const specs = data.plan.specs;
  worldSpine = data.plan.spine;
  worldSoftSpots = data.plan.softSpots;
  worldProps = data.plan.props;
  hasSpin = data.chunks.some((c) => c.spin);
  blastPoints.push(...data.blastPoints);
  const total = specs.length + 1;
  let triangles = 0;

  // Chunk indices are the wire ids for chunk-local digs (WG-12): register
  // every chunk in data order BEFORE meshing, so ids never depend on worker
  // arrival order.
  for (const chunk of data.chunks) chunks.push(chunk);

  let built = 0;
  const finishChunk = (chunk: Chunk, i: number, mesh: THREE.Mesh): void => {
    mesh.userData.reach = chunkReach(chunk);
    mesh.userData.zone = chunk.zone; // bench perf HUD groups triangles by this
    triangles += mesh.geometry.attributes.position.count / 3;
    group.add(mesh);
    onProgress(++built, total, specs[i].label);
  };

  // Mesh phase (consumes no rng — the stream completed in buildWorldData).
  // WG-19: fan out to the worker pool when one exists; buffers come back
  // bit-identical to the sync path (same sdf.ts code, same inputs) and
  // upload as results land. The sync path stays for node and as fallback.
  // WG-22: with `stream`, chunks out of MESH_AHEAD of the spawn defer to
  // the distance-driven pump in updateGouda.
  const useWorkers = (opts.workers ?? true) && getMeshPool() !== null;
  const streaming = (opts.stream ?? false) && useWorkers;
  zoneMaterialsLive = materials;
  const spawn = data.spawnPoint;
  if (useWorkers) {
    await Promise.all(
      data.chunks.map(async (chunk, i) => {
        if (
          streaming &&
          Math.hypot(
            chunk.center.x - spawn.x,
            chunk.center.y - spawn.y,
            chunk.center.z - spawn.z,
          ) -
            chunkReach(chunk) >
            MESH_AHEAD
        ) {
          unmeshed.push(chunk);
          onProgress(++built, total, specs[i].label);
          return;
        }
        try {
          const r = await submitMeshJob(chunk, null, true);
          chunk.field = r.field;
          finishChunk(
            chunk,
            i,
            mountChunkMesh(chunk, r, materials[chunk.zone!]!),
          );
        } catch (err) {
          console.warn("gouda: mesh worker failed, meshing on main", err);
          finishChunk(chunk, i, meshChunk(chunk, materials[chunk.zone!]!));
        }
      }),
    );
  } else {
    for (let i = 0; i < data.chunks.length; i++) {
      const chunk = data.chunks[i];
      finishChunk(chunk, i, meshChunk(chunk, materials[chunk.zone!]!));
      await nextTick();
    }
  }
  // NOTE: the MC scratch instances are deliberately KEPT — digging reuses
  // them to re-mesh chunks at runtime.

  const crumbGeos = data.debrisNoiseOffsets.map(makeDebrisGeometry);
  const crumbMaterial = materials.drift ?? materials[world.biomes[0].id]!;
  for (const spec of data.debris) {
    const crumb = new THREE.Mesh(crumbGeos[spec.geoIndex], crumbMaterial);
    crumb.userData.zone = "debris";
    crumb.position.copy(spec.center);
    crumb.scale.setScalar(spec.s);
    crumb.rotation.set(spec.rot.x, spec.rot.y, spec.rot.z);
    crumb.castShadow = true;
    crumb.receiveShadow = true;
    group.add(crumb);
    debris.push({ center: spec.center, r: spec.r, mesh: crumb });
  }

  scene.add(group);

  buildChunkGrid(); // WG-21 — the runtime queries' spatial index

  goldPos = data.goldPos;
  // Wheel is an item (game/items.ts), world only seeds position.
  createBoundarySphere(extrasGroup, world.boundaryR);
  createBlastMarkers(extrasGroup);
  createSoftSpotMarkers(extrasGroup);
  scene.add(extrasGroup);

  spawnPoint = new THREE.Vector3(
    data.spawnPoint.x,
    data.spawnPoint.y,
    data.spawnPoint.z,
  );

  onProgress(total, total, "gold");
  console.log(
    `gouda: seed ${worldSeed} d${difficulty} — ${chunks.length} wheels, ` +
      `${debris.length} crumbs, ${blastPoints.length} blast walls, ` +
      `${Math.round(triangles / 1000)}k tris in ${Math.round(performance.now() - t0)}ms`,
  );
  return group;
}

export function disposeWorld(scene: THREE.Scene): void {
  for (const g of [worldGroup, extrasGroup]) {
    if (!g) continue;
    scene.remove(g);
    g.traverse((child: THREE.Object3D) => {
      // Not every child is a Mesh — probe the properties structurally.
      (child as { geometry?: THREE.BufferGeometry }).geometry?.dispose();
      if ((child as { material?: THREE.Material }).material?.dispose)
        (child as { material?: THREE.Material }).material!.dispose();
    });
  }
  worldGroup = null;
  extrasGroup = null;
  goldPos = null;
  markerMaterial = null;
  chunks.length = 0;
  debris.length = 0;
  blastPoints.length = 0;
  spawnPoint = null;
  worldSpine = [];
  worldSoftSpots = [];
  worldProps = [];
  hasSpin = false;
  chunkGrid = null;
  unmeshed = [];
  zoneMaterialsLive = {};
  remeshInFlight.clear();
  remeshDirty.clear();
  wireframeOn = false;
  wireMaterial = null;
  softSpotGroup = null;
}

// Seeded gold position; read once at world build.
export function getGoldPos(): Vec3 | null {
  return goldPos;
}

export function getWorldSeed(): number {
  return worldSeed;
}

export function getBlastPoints(): Vec3[] {
  return blastPoints;
}

// Seeded descent route + hull soft spots of the built world (empty for
// worlds without a spine/hull).
export function getSpinePoints(): SpinePoint[] {
  return worldSpine;
}

export function getSoftSpots(): SoftSpot[] {
  return worldSoftSpots;
}

// Seeded prop positions of the built world (WG-11) — air pockets, melt
// hazards, the wreck. Game systems consume these in M5/M6.
export function getSeededProps(): SeededProp[] {
  return worldProps;
}

// --- Runtime queries -----------------------------------------------------------------------

// A layer tile's field (body + its distributed carves) is authoritative only
// inside its marched box plus the carve-distribution pad — beyond that the
// uncarved body SDF reports phantom solid where a neighbouring tile carries
// the carve. Every world point near the body lies in some tile's box, so
// queries skip tiles that don't cover the point. Exported for the verifier
// and the bench (their query loops must apply the same ownership rule).
// `extra` inflates the box by a dig radius (see chunkCovers).
export function tileFieldCovers(
  c: Chunk,
  x: number,
  y: number,
  z: number,
  extra = 0,
): boolean {
  const cellW = (2 * c.s) / c.res;
  const pad = SMOOTH_K * c.s + 2 * cellW + extra;
  const lo = -(c.s - cellW) - pad;
  const hi = c.s - 2 * cellW + pad;
  const dx = x - c.center.x;
  if (dx < lo || dx > hi) return false;
  const dy = y - c.center.y;
  if (dy < lo || dy > hi) return false;
  const dz = z - c.center.z;
  return dz >= lo && dz <= hi;
}

// THE authority predicate: a chunk that may report solid at a point must be
// diggable at that point. Collision (chunkContribution), digging (digAt) and
// the spatial hash (gridReach) all read this one shape — a tile's field box,
// an ellipsoid chunk's near-field ball — so "I carved it and still can't get
// through" cannot come back. `extra` inflates it by a dig sphere radius.
export function chunkCovers(
  c: Chunk,
  x: number,
  y: number,
  z: number,
  extra = 0,
): boolean {
  if (c.body) return tileFieldCovers(c, x, y, z, extra);
  const dx = x - c.center.x,
    dy = y - c.center.y,
    dz = z - c.center.z;
  const reach = c.s * 1.4 + extra;
  return dx * dx + dy * dy + dz * dz <= reach * reach;
}

// --- Chunk spatial hash (WG-21) ------------------------------------------------

// Uniform grid over chunk influence balls, built once per world build. A
// point query reads ONE cell; a chunk missing from that cell is guaranteed
// either > GRID_SAT of open water away (distance queries saturate there —
// every caller compares against ≤ 2 u) or out of reach of the largest dig
// sphere (≤ DIG_PAD). Rotating chunks index by their bounding sphere, so
// the cell set is rotation-invariant.
const GRID_CELL = 24;
const GRID_SAT = 8;
const DIG_PAD = 3; // covers the driller (2.4 u) with margin

let chunkGrid: Map<number, number[]> | null = null;

function gridKey(cx: number, cy: number, cz: number): number {
  return ((cx + 512) << 20) | ((cy + 512) << 10) | (cz + 512);
}

// Everything a chunk can influence: its near-field (chunkSdf reach), its
// far-field estimate dropping below GRID_SAT, or a dig sphere touching it.
// Buckets are per-axis boxes, so a body tile needs the worst-axis half-extent
// of chunkCovers' box (|lo| = 1.05·s + cellW) plus the dig ball — derived, so
// a new res cannot silently outgrow it.
function gridReach(c: Chunk): number {
  if (c.body) return 1.05 * c.s + (2 * c.s) / c.res + DIG_PAD;
  return Math.max(c.s * 0.85 + GRID_SAT, c.s * 1.4 + DIG_PAD);
}

function buildChunkGrid(): void {
  const grid = new Map<number, number[]>();
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const reach = gridReach(c);
    const lo = (v: number) => Math.floor((v - reach) / GRID_CELL);
    const hi = (v: number) => Math.floor((v + reach) / GRID_CELL);
    for (let x = lo(c.center.x); x <= hi(c.center.x); x++)
      for (let y = lo(c.center.y); y <= hi(c.center.y); y++)
        for (let z = lo(c.center.z); z <= hi(c.center.z); z++) {
          const key = gridKey(x, y, z);
          let bucket = grid.get(key);
          if (!bucket) grid.set(key, (bucket = []));
          bucket.push(i);
        }
  }
  chunkGrid = grid;
}

function gridBucketAt(x: number, y: number, z: number): number[] | null {
  return (
    chunkGrid?.get(
      gridKey(
        Math.floor(x / GRID_CELL),
        Math.floor(y / GRID_CELL),
        Math.floor(z / GRID_CELL),
      ),
    ) ?? null
  );
}

// World distance to ONE chunk's solid (world units) — exported for the
// worldgen bench, whose part/biome previews keep their own chunk lists.
export function chunkDistance(
  c: Chunk,
  x: number,
  y: number,
  z: number,
): number {
  let dx = x - c.center.x,
    dy = y - c.center.y,
    dz = z - c.center.z;
  if (c.spin) {
    spinRotate(c.spin, dx, dy, dz, -c.spin.sin, _sv);
    dx = _sv.x;
    dy = _sv.y;
    dz = _sv.z;
  }
  return chunkSdf(c, dx / c.s, dy / c.s, dz / c.s) * c.s;
}

// One chunk's contribution to the world distance at a point — returns the
// (possibly lowered) running best. The per-chunk bounds mirror gridReach.
function chunkContribution(
  c: Chunk,
  x: number,
  y: number,
  z: number,
  best: number,
): number {
  const dx = x - c.center.x,
    dy = y - c.center.y,
    dz = z - c.center.z;
  const dc = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (c.body) {
    // Tile of a layer body: the tile's box owns its region (see
    // tileFieldCovers) — outside it the tile must not contribute. No cheaper
    // sphere pre-reject: one that clips the box corners would report solid
    // where digAt (same predicate) cannot reach.
    if (!chunkCovers(c, x, y, z)) return best;
    const d = chunkSdf(c, dx / c.s, dy / c.s, dz / c.s) * c.s;
    return d < best ? d : best;
  }
  if (dc - c.s > best) return best;
  if (!chunkCovers(c, x, y, z)) {
    const d = dc - c.s * (R0 + 0.25);
    return d < best ? d : best;
  }
  // Rotating chunks (WG-12): un-rotate the probe — the SDF stays static in
  // local space, so collision matches the rotated mesh by construction.
  let lx = dx,
    ly = dy,
    lz = dz;
  if (c.spin) {
    spinRotate(c.spin, dx, dy, dz, -c.spin.sin, _sv);
    lx = _sv.x;
    ly = _sv.y;
    lz = _sv.z;
  }
  const d = chunkSdf(c, lx / c.s, ly / c.s, lz / c.s) * c.s;
  return d < best ? d : best;
}

// Distance over explicit lists — the one implementation behind the module
// query AND the data phase (debris seeding probes chunks before any mesh
// exists). Exported for the verifier (src/world/verify.ts).
export function distanceToWorld(
  chunkList: Chunk[],
  debrisList: { center: Vec3; r: number }[],
  x: number,
  y: number,
  z: number,
): number {
  let best = 1e9;
  for (let i = 0; i < chunkList.length; i++)
    best = chunkContribution(chunkList[i], x, y, z, best);
  for (let i = 0; i < debrisList.length; i++) {
    const b = debrisList[i];
    const dx = x - b.center.x,
      dy = y - b.center.y,
      dz = z - b.center.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - b.r;
    if (d < best) best = d;
  }
  return best;
}

// The module query rides the spatial hash (WG-21): one cell, ~2–8 chunks,
// saturating at GRID_SAT open water — every caller compares against ≤ 2 u.
export function worldDistance(x: number, y: number, z: number): number {
  if (!chunkGrid) return distanceToWorld(chunks, debris, x, y, z);
  let best = GRID_SAT;
  const bucket = gridBucketAt(x, y, z);
  if (bucket)
    for (let i = 0; i < bucket.length; i++)
      best = chunkContribution(chunks[bucket[i]], x, y, z, best);
  for (let i = 0; i < debris.length; i++) {
    const b = debris[i];
    const dx = x - b.center.x,
      dy = y - b.center.y,
      dz = z - b.center.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - b.r;
    if (d < best) best = d;
  }
  return best;
}

const GRAD_EPS = 0.25;
export function resolveCollision(pos: Vec3, radius: number): Vec3 | null {
  let normal: Vec3 | null = null;
  for (let iter = 0; iter < 2; iter++) {
    const d = worldDistance(pos.x, pos.y, pos.z);
    // NaN from degenerate SDF would trap player; bail if non-finite.
    if (!Number.isFinite(d)) break;
    if (d >= radius) break;
    let nx =
      worldDistance(pos.x + GRAD_EPS, pos.y, pos.z) -
      worldDistance(pos.x - GRAD_EPS, pos.y, pos.z);
    let ny =
      worldDistance(pos.x, pos.y + GRAD_EPS, pos.z) -
      worldDistance(pos.x, pos.y - GRAD_EPS, pos.z);
    let nz =
      worldDistance(pos.x, pos.y, pos.z + GRAD_EPS) -
      worldDistance(pos.x, pos.y, pos.z - GRAD_EPS);
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-5) {
      nx = 0;
      ny = 1;
      nz = 0;
    } else {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    pos.x += nx * (radius - d + 0.001);
    pos.y += ny * (radius - d + 0.001);
    pos.z += nz * (radius - d + 0.001);
    normal = { x: nx, y: ny, z: nz };
  }
  return normal;
}

export function findOpenSpot(
  near: Vec3 | null = null,
  minD = 0,
  maxD = 0,
): Vec3 {
  for (let i = 0; i < 300; i++) {
    let x, y, z;
    if (near) {
      const a = Math.random() * Math.PI * 2;
      const b = Math.acos(Math.random() * 2 - 1);
      const r = minD + Math.random() * (maxD - minD);
      x = near.x + Math.sin(b) * Math.cos(a) * r;
      y = near.y + Math.cos(b) * r;
      z = near.z + Math.sin(b) * Math.sin(a) * r;
    } else {
      x = (Math.random() * 2 - 1) * WORLD_R;
      y = (Math.random() * 2 - 1) * WORLD_R * 0.7;
      z = (Math.random() * 2 - 1) * WORLD_R;
    }
    if (worldDistance(x, y, z) > 1.8) return { x, y, z };
  }
  return { x: 0, y: WORLD_R + 20, z: 0 };
}

export function getSpawnPoint(): Vec3 {
  return spawnPoint ?? { x: 0, y: 18, z: WORLD_R + 14 };
}
