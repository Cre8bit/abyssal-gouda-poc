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
// ONION MAP (~R 330) — nine biomes, outside → in. A run to the gold should
// take 10–20 minutes through two sealed walls and three maze biomes:
//   the drift     (285–330)  sparse pale blocks, first silhouettes
//   the reef      (240–290)  fields of thin slabs with big through-holes —
//                            weave between and through the plates
//   the scree     (205–245)  dense belt of small cut blocks
//   the warrens   (175–205)  speleology: long tangled narrow tunnels
//   the crust     (~150)     SEALED WALL #1 — many giant fused hunks,
//                            passable only through their tunnel complexes
//   the galleries (95–130)   cathedral wheels: huge chambers, wide tunnels
//   the bulwark   (~78)      SEALED WALL #2 — tighter, meaner
//   the hollows   (38–58)    cramped approach wheels
//   the heart     (0)        colossal hunk, a grand cavern — and a DECOY
//
// Dead-end chambers sealed by deliberately thin walls are marked with a
// crack-glow (getBlastPoints()) — dig or (future) blast through them.
// Generation is seeded per game; the host's seed rides the invite link and
// the handshake, so peers share the exact same maze.

import * as THREE from "three";
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { toonMaterial } from "../render/toon.ts";
import type { DigTool, Vec3 } from "../state.ts";
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

// Module-scope radii read the DEFAULT tables — the game always plays the
// shipped recipes; WorldRecipe overrides exist for the worldgen bench only.
export const WORLD_R = WHEEL_WORLD.worldR; // outer edge of the drift
export const BOUNDARY_R = WHEEL_WORLD.boundaryR; // visible map boundary veil
export const HEART_POS = { x: 0, y: 0, z: 0 }; // map center — a DECOY.
// The Golden Gouda hides in a random cavern inside one of the mid-radius
// wheels (goldBand) and is NOT shown on the compass. Search, listen for
// its glow leaking out of tunnel mouths, dig. getGoldPos() is only the SEED
// position — once the run starts the wheel is an item and it moves.

const MAX_POLYS: Record<number, number> = {
  96: 220000,
  72: 140000,
  64: 110000,
  56: 90000,
  48: 70000,
  32: 24000,
};

// Local-space (unit-sphere) shape parameters. Surface ~ |p| = R0, grid [-1,1].
// Exported for the worldgen bench (proxy sphere radius ≈ chunk s · R0).
export const R0 = 0.6;
const CARVE_SKIP = 0.3;
const SMOOTH_K = 0.05;
const PLANE_K = 0.025;

const noise = new ImprovedNoise();

// --- Types (erased at runtime) ---------------------------------------------------

type Rng = () => number;

interface PlaneCut {
  nx: number;
  ny: number;
  nz: number;
  off: number;
}

// Eyes (caverns/chambers), pores AND player digs all share this shape.
interface SphereCarve {
  x: number;
  y: number;
  z: number;
  r: number;
}

interface Tunnel {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  r: number;
}

// Generation context threaded through makeChunkData so the worldgen bench
// can generate isolated chunks without touching this module's world state.
export interface GenCtx {
  difficulty: number; // 1..3 — scales tunnel width down, dead-ends up
  blastPoints: Vec3[]; // sink for thin-wall marker positions
}

export interface Chunk {
  center: THREE.Vector3;
  s: number;
  res: number;
  ix: number;
  iy: number;
  iz: number;
  minAxis: number;
  nOff: number;
  amp: number;
  freq: number;
  crustDepth: number;
  planes: PlaneCut[];
  holes: SphereCarve[];
  tunnels: Tunnel[];
  digs: SphereCarve[];
  hardness: number; // 0 hands · 1 driller · 2 driller-slow · 3 no-dig
  field: Float32Array | null;
  mesh: THREE.Mesh | null;
  biggestEye?: SphereCarve | null; // set by makeChunkData
  zone?: ZoneName; // set by buildGoudaWorld
  body?: LayerBody; // layer-body tile: base SDF comes from the layer, not the ellipsoid
  sealed?: boolean; // seal tiles never receive foreign carves (noCarveWithin)
}

export interface ChunkSpec {
  center: THREE.Vector3;
  s: number;
  res: number;
  label: string;
  zone: ZoneName;
  part: PartRecipe;
  axis?: Vec3; // radial through-route direction (shell placements)
  body?: LayerBody; // layer-body tile (fused/hull placements)
}

// One point of the seeded descent route: a through-point per layer boundary.
export interface SpinePoint {
  x: number;
  y: number;
  z: number;
  r: number; // frame radius of the boundary it sits on
}

export interface WorldPlan {
  specs: ChunkSpec[];
  spine: SpinePoint[];
  softSpots: SoftSpot[];
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

// --- SDF primitives -----------------------------------------------------------------

function fbm3(x: number, y: number, z: number): number {
  return (
    noise.noise(x, y, z) +
    0.5 * noise.noise(x * 2.13 + 7.7, y * 2.13 + 3.1, z * 2.13 + 11.6)
  );
}

function smoothCut(d: number, cut: number, k: number): number {
  const b = -cut;
  const h = Math.max(k - Math.abs(d - b), 0) / k;
  return Math.max(d, b) + h * h * k * 0.25;
}

function smoothMax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

function segDist(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const abx = bx - ax,
    aby = by - ay,
    abz = bz - az;
  const apx = px - ax,
    apy = py - ay,
    apz = pz - az;
  let t =
    (apx * abx + apy * aby + apz * abz) / (abx * abx + aby * aby + abz * abz);
  t = Math.max(0, Math.min(1, t));
  const dx = apx - abx * t,
    dy = apy - aby * t,
    dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// --- World frame (squash + tilt) — layer-body radii are measured here ------------

// Precomputed rotation (tilt about X) + vertical squash. null = identity,
// and the identity path must not touch the numbers (classic-onion compat).
export interface WorldFrame {
  cos: number;
  sin: number;
  squash: number;
}

export function makeFrame(
  recipe: { squash: number; tiltDeg: number } | undefined,
): WorldFrame | null {
  if (!recipe) return null;
  const rad = (recipe.tiltDeg * Math.PI) / 180;
  return { cos: Math.cos(rad), sin: Math.sin(rad), squash: recipe.squash };
}

// Frame radius of a world point (identity: plain length).
export function frameRadius(
  f: WorldFrame | null,
  x: number,
  y: number,
  z: number,
): number {
  if (!f) return Math.sqrt(x * x + y * y + z * z);
  const fy = (f.cos * y - f.sin * z) / f.squash;
  const fz = f.sin * y + f.cos * z;
  return Math.sqrt(x * x + fy * fy + fz * fz);
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

// --- Layer bodies (fused bands, hulls) --------------------------------------------

export interface SoftSpot {
  x: number;
  y: number;
  z: number;
  r: number;
}

export interface LayerBody {
  kind: "band" | "hull";
  frame: WorldFrame | null;
  nOff: number; // layer-level crust noise offset (tile continuity)
  // band
  rMin: number;
  rMax: number;
  warpAmp: number;
  warpFreq: number;
  // hull ("wheel" = squat rounded cylinder in the tilted frame; "sphere")
  surface: "wheel" | "sphere";
  R: number;
  halfH: number;
  rim: number;
  thickness: number;
  ridgeAmp: number;
  ridgeFreq: number;
  softSpots: SoftSpot[];
}

// The hull's FULL solid (wheel/sphere before hollowing) — the husk is
// max(solid, -solid - thickness), and soft-spot projection bisects this.
function hullSolidSdf(b: LayerBody, x: number, y: number, z: number): number {
  // Untilt only (no squash): the wheel has its own height.
  const f = b.frame;
  let qy = y,
    qz = z;
  if (f) {
    qy = f.cos * y - f.sin * z;
    qz = f.sin * y + f.cos * z;
  }
  if (b.surface === "sphere") return Math.sqrt(x * x + qy * qy + qz * qz) - b.R;
  const rxz = Math.sqrt(x * x + qz * qz);
  const d2 = rxz - (b.R - b.rim);
  const dy = Math.abs(qy) - (b.halfH - b.rim);
  const mx = Math.max(d2, 0);
  const my = Math.max(dy, 0);
  let solid =
    Math.min(Math.max(d2, dy), 0) + Math.sqrt(mx * mx + my * my) - b.rim;
  if (b.ridgeAmp > 0 && dy > d2)
    solid += b.ridgeAmp * Math.sin(rxz * b.ridgeFreq);
  return solid;
}

// World-unit distance to the layer's solid. Approximate SDF (anisotropic
// squash + warp break exactness) but sign-correct, which is all marching
// cubes and sphere-tracing with conservative steps need.
function bodySdfWorld(b: LayerBody, x: number, y: number, z: number): number {
  const f = b.frame;
  let d: number;
  if (b.kind === "band") {
    let rr = frameRadius(f, x, y, z);
    if (b.warpAmp > 0)
      rr +=
        b.warpAmp *
        fbm3(
          x * b.warpFreq + b.nOff,
          y * b.warpFreq + b.nOff * 1.7,
          z * b.warpFreq + b.nOff * 0.6,
        );
    d = Math.max(rr - b.rMax, b.rMin - rr);
    if (f) d *= Math.min(1, f.squash);
  } else {
    const solid = hullSolidSdf(b, x, y, z);
    d = Math.max(solid, -solid - b.thickness);
    for (const s of b.softSpots) {
      const dx = x - s.x,
        dyy = y - s.y,
        dz = z - s.z;
      d = smoothMin(
        d,
        Math.sqrt(dx * dx + dyy * dyy + dz * dz) - s.r,
        s.r * 0.8,
      );
    }
  }
  return d;
}

// Uncarved body SDF: rind (outer) vs. paste (carved interior).
function baseSdf(c: Chunk, x: number, y: number, z: number): number {
  if (c.body) {
    // Layer tile: world-space body + world-continuous crust, back to local.
    const wx = c.center.x + x * c.s,
      wy = c.center.y + y * c.s,
      wz = c.center.z + z * c.s;
    let dw = bodySdfWorld(c.body, wx, wy, wz);
    const depthW = c.crustDepth * c.s;
    const adw = Math.abs(dw);
    if (adw < depthW && c.amp > 0) {
      let fade = 1 - adw / depthW;
      fade = fade * fade * (3 - 2 * fade);
      const wf = c.freq / c.s;
      dw +=
        fbm3(wx * wf + c.nOff, wy * wf + c.nOff * 1.7, wz * wf + c.nOff * 0.6) *
        c.amp *
        c.s *
        fade;
    }
    return dw / c.s;
  }

  const ex = x * c.ix,
    ey = y * c.iy,
    ez = z * c.iz;
  let d = (Math.sqrt(ex * ex + ey * ey + ez * ez) - R0) * c.minAxis;

  const ad = Math.abs(d);
  if (ad < c.crustDepth) {
    let fade = 1 - ad / c.crustDepth;
    fade = fade * fade * (3 - 2 * fade);
    d +=
      fbm3(
        x * c.freq + c.nOff,
        y * c.freq + c.nOff * 1.7,
        z * c.freq + c.nOff * 0.6,
      ) *
      c.amp *
      fade;
  }

  const planes = c.planes;
  for (let i = 0; i < planes.length; i++) {
    const pl = planes[i];
    d = smoothMax(d, x * pl.nx + y * pl.ny + z * pl.nz - pl.off, PLANE_K);
  }
  return d;
}

// Full chunk SDF, local [-1,1]. Used for meshing, collision, digging.
function chunkSdf(c: Chunk, x: number, y: number, z: number): number {
  let d = baseSdf(c, x, y, z);

  if (d > CARVE_SKIP) return d;

  // Per-axis carve rejection. A carve is a no-op when its cut distance stays
  // above d + k; below -0.25 the exact value can be distorted safely — those
  // samples are never adjacent to a sign change, so the isosurface (and the
  // extracted mesh) is bit-identical.
  const holes = c.holes;
  for (let i = 0; i < holes.length; i++) {
    const h = holes[i];
    const lim = d < -0.25 ? h.r + 0.31 : h.r - d + 0.06;
    const dx = x - h.x;
    if (dx > lim || dx < -lim) continue;
    const dy = y - h.y;
    if (dy > lim || dy < -lim) continue;
    const dz = z - h.z;
    if (dz > lim || dz < -lim) continue;
    d = smoothCut(d, Math.sqrt(dx * dx + dy * dy + dz * dz) - h.r, SMOOTH_K);
    if (d > 0.45) return d; // deep in a cavern: no surface near, bail out
  }

  const tunnels = c.tunnels;
  for (let i = 0; i < tunnels.length; i++) {
    const t = tunnels[i];
    const lim = d < -0.25 ? t.r + 0.31 : t.r - d + 0.06;
    if (x > Math.max(t.ax, t.bx) + lim || x < Math.min(t.ax, t.bx) - lim)
      continue;
    if (y > Math.max(t.ay, t.by) + lim || y < Math.min(t.ay, t.by) - lim)
      continue;
    if (z > Math.max(t.az, t.bz) + lim || z < Math.min(t.az, t.bz) - lim)
      continue;
    d = smoothCut(
      d,
      segDist(x, y, z, t.ax, t.ay, t.az, t.bx, t.by, t.bz) - t.r,
      SMOOTH_K,
    );
    if (d > 0.45) return d;
  }

  // Player digs (runtime carves) — kept in the SDF so collision matches the
  // re-meshed geometry exactly.
  const digs = c.digs;
  for (let i = 0; i < digs.length; i++) {
    const g = digs[i];
    const dx = x - g.x,
      dy = y - g.y,
      dz = z - g.z;
    d = smoothCut(d, Math.sqrt(dx * dx + dy * dy + dz * dz) - g.r, SMOOTH_K);
  }

  return d;
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

// One PartRecipe → one chunk's SDF params. `axis` (from shell placements)
// forces a radial through-route; `ctx` carries difficulty + blast-marker sink.
export function makeChunkData(
  rng: Rng,
  center: THREE.Vector3,
  s: number,
  res: number,
  part: PartRecipe,
  ctx: GenCtx,
  axis: Vec3 | null = null,
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

  // Radial through-route for wall chunks.
  if (axis) {
    const a = axis;
    for (const sign of [1, -1]) {
      let best = eyes[0],
        bestDot = -Infinity;
      for (const e of eyes) {
        const dot = sign * (e.x * a.x + e.y * a.y + e.z * a.z);
        if (dot > bestDot) {
          bestDot = dot;
          best = e;
        }
      }
      addTunnel(
        c,
        rng,
        best,
        {
          x: sign * a.x * (R0 + 0.28) * sx,
          y: sign * a.y * (R0 + 0.28) * sy,
          z: sign * a.z * (R0 + 0.28) * sz,
        },
        tr(0.09 + 0.03 * rng()),
        0,
      );
    }
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

  return c;
}

// --- Meshing -------------------------------------------------------------------------

// MC instances stay live; digging reuses them for chunk re-meshing.
const mcCache = new Map<number, MarchingCubes>();

function getMC(res: number): MarchingCubes {
  let mc = mcCache.get(res);
  if (!mc) {
    mc = new MarchingCubes(
      res,
      new THREE.MeshBasicMaterial(),
      false,
      false,
      MAX_POLYS[res] ?? 100000,
    );
    mcCache.set(res, mc);
  }
  return mc;
}

// Extract compact geometry with sanitized normals; compute rind factor (1=crust, 0=carved).
function extractGeometry(mc: MarchingCubes, c: Chunk): THREE.BufferGeometry {
  const count = mc.count;
  const positions = mc.geometry.attributes.position.array.slice(0, count * 3);
  const normals = mc.geometry.attributes.normal.array.slice(0, count * 3);
  const crust = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const nx = normals[i3],
      ny = normals[i3 + 1],
      nz = normals[i3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-6) {
      normals[i3] = nx / len;
      normals[i3 + 1] = ny / len;
      normals[i3 + 2] = nz / len;
    } else {
      normals[i3] = 0;
      normals[i3 + 1] = 1;
      normals[i3 + 2] = 0;
    }
    // Rind factor: ~0 (outer/rind) to -0.055 (carved paste).
    const bd = baseSdf(c, positions[i3], positions[i3 + 1], positions[i3 + 2]);
    const t = (bd + 0.055) / 0.04; // -0.055 → 0 (paste), -0.015 → 1 (rind)
    crust[i] = Math.max(0, Math.min(1, t));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("aCrust", new THREE.BufferAttribute(crust, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

export function meshChunk(
  c: Chunk,
  res: number,
  material: THREE.Material,
): THREE.Mesh {
  const mc = getMC(res);
  mc.reset();
  mc.isolation = 0;

  const field = mc.field;
  const half = res / 2;
  let idx = 0;
  for (let zi = 0; zi < res; zi++) {
    const z = (zi - half) / half;
    for (let yi = 0; yi < res; yi++) {
      const y = (yi - half) / half;
      for (let xi = 0; xi < res; xi++) {
        field[idx++] = -chunkSdf(c, (xi - half) / half, y, z);
      }
    }
  }
  // Cache field; digs edit incrementally.
  c.field = field.slice();

  mc.update();
  if (mc.count / 3 > (MAX_POLYS[res] ?? 100000)) {
    console.warn("gouda: chunk exceeded poly budget, geometry truncated");
  }

  const mesh = new THREE.Mesh(extractGeometry(mc, c), material);
  mesh.position.copy(c.center);
  mesh.scale.setScalar(c.s);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  c.mesh = mesh;
  return mesh;
}

// Re-runs marching cubes for one chunk from its cached (dug) field.
function remeshChunk(c: Chunk): void {
  if (!c.mesh || !c.field) return; // chunk never finished building
  const mc = getMC(c.res);
  mc.reset();
  mc.isolation = 0;
  mc.field.set(c.field);
  mc.update();
  const geometry = extractGeometry(mc, c);
  c.mesh.geometry.dispose();
  c.mesh.geometry = geometry;
}

// --- DIGGING ---------------------------------------------------------------------------

// Hardness ceiling per tool (cheese-parts §1): hands open 0, the driller ≤ 2,
// 3 yields to nothing.
const TOOL_MAX_HARDNESS: Record<DigTool, number> = { hands: 0, driller: 2 };

// Great Wheel exception: a dig point inside a soft spot digs as hardness 1 —
// the geometric hook the M3 breach timer attaches to. Hulls without soft
// spots (the melt shell, WG-08) get no exception by construction.
function digHardness(c: Chunk, x: number, y: number, z: number): number {
  const spots = c.body?.softSpots;
  if (c.hardness > 1 && spots) {
    for (const s of spots) {
      const dx = x - s.x,
        dy = y - s.y,
        dz = z - s.z;
      if (dx * dx + dy * dy + dz * dz < s.r * s.r) return 1;
    }
  }
  return c.hardness;
}

export interface DigResult {
  changed: boolean; // some chunk/debris took the carve
  rejected: boolean; // some chunk in range bounced the tool (feedback hook)
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
  const maxHardness = TOOL_MAX_HARDNESS[tool];

  for (const c of chunks) {
    const dx = x - c.center.x,
      dy = y - c.center.y,
      dz = z - c.center.z;
    const dc = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dc > (c.body ? c.s * 1.74 : c.s * 1.35) + r) continue;
    if (digHardness(c, x, y, z) > maxHardness) {
      rejected = true;
      continue;
    }

    const lx = dx / c.s,
      ly = dy / c.s,
      lz = dz / c.s;
    const lr = r / c.s;
    c.digs.push({ x: lx, y: ly, z: lz, r: lr });

    // Edit only voxels the dig can touch.
    const res = c.res;
    const half = res / 2;
    const cell = 1 / half;
    const reach = lr + SMOOTH_K + 2 * cell;
    const min = (v: number) => Math.max(0, Math.floor((v - reach + 1) * half));
    const max = (v: number) =>
      Math.min(res - 1, Math.ceil((v + reach + 1) * half));
    const field = c.field!;
    for (let zi = min(lz); zi <= max(lz); zi++) {
      const vz = (zi - half) / half;
      for (let yi = min(ly); yi <= max(ly); yi++) {
        const vy = (yi - half) / half;
        const rowBase = zi * res * res + yi * res;
        for (let xi = min(lx); xi <= max(lx); xi++) {
          const vx = (xi - half) / half;
          const ddx = vx - lx,
            ddy = vy - ly,
            ddz = vz - lz;
          const dd = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) - lr;
          const idx = rowBase + xi;
          const d = -field[idx];
          field[idx] = -smoothCut(d, dd, SMOOTH_K);
        }
      }
    }

    remeshChunk(c);
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

  return { changed, rejected };
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

function vec3str(hex: number): string {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
}

// Two-tone cheese material via aCrust: paste (carved), rind (outer crust).
// Exported for the worldgen bench (skin previews from BiomeMaterial edits).
export function createGoudaMaterial({
  paste,
  rind,
  vein,
  veinStrength,
}: BiomeMaterial): THREE.MeshToonMaterial {
  const pasteVec = vec3str(paste);
  const rindVec = vec3str(rind);
  const veinVec = `vec3(${vein[0].toFixed(3)}, ${vein[1].toFixed(3)}, ${vein[2].toFixed(3)})`;
  const vs = veinStrength.toFixed(3);

  const injectCheese = (
    shader: THREE.WebGLProgramParametersWithUniforms,
  ): void => {
    shader.uniforms.uGoudaTime = uGoudaTime;

    shader.vertexShader =
      "attribute float aCrust;\nvarying float vCrust;\nvarying vec3 vGoudaWorld;\nvarying vec3 vGoudaNormal;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vCrust = aCrust;
        vGoudaWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vGoudaNormal = mat3(modelMatrix) * objectNormal;`,
      );

    shader.fragmentShader =
      "uniform float uGoudaTime;\nvarying float vCrust;\nvarying vec3 vGoudaWorld;\nvarying vec3 vGoudaNormal;\n" +
      shader.fragmentShader
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
        {
          // Slight albedo mottling so big waxy surfaces aren't flat.
          float mottle = 0.92 + 0.08 * sin(vGoudaWorld.x * 0.9 + vGoudaWorld.y * 1.3)
                                     * sin(vGoudaWorld.z * 1.1 - vGoudaWorld.y * 0.7);
          diffuseColor.rgb = mix(${pasteVec}, ${rindVec}, vCrust) * mottle;
        }`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
        {
          vec3 gp = vGoudaWorld;
          float g1 = sin(gp.x * 0.21 + 1.3) * sin(gp.y * 0.19 + 3.1) * sin(gp.z * 0.23 + 5.2);
          float g2 = sin(gp.x * 0.083 + 2.1) * sin(gp.y * 0.077) * sin(gp.z * 0.09 + 4.0);
          float patches = smoothstep(0.12, 0.72, g1 * 0.5 + 0.5)
                        * smoothstep(0.25, 0.9, g2 * 0.5 + 0.5);
          float pulse = 0.5 + 0.5 * sin(uGoudaTime * 0.55 + g2 * 6.0);
          pulse *= 0.7 + 0.3 * sin(uGoudaTime * 0.173 + gp.y * 0.05);
          vec3 gv = normalize(cameraPosition - gp);
          vec3 gn = normalize(vGoudaNormal + vec3(1e-5));
          float inPaste = 1.0 - vCrust * 0.85; // the glow lives in the paste
          // Faint constant self-glow so the paste reads yellow even unlit.
          totalEmissiveRadiance += ${pasteVec} * inPaste * 0.04;
          totalEmissiveRadiance += ${veinVec} * patches * (0.25 + 0.75 * pulse) * ${vs} * inPaste;

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

  // Cache key includes constants to prevent zone-merge.
  return toonMaterial(
    { color: 0xffffff }, // overridden per-fragment by the paste/rind mix
    {
      shader: injectCheese,
      key: `gouda${pasteVec}${rindVec}${veinVec}${vs}`,
    },
  );
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

// --- Per-frame updates ------------------------------------------------------------------------

export function updateGouda(
  elapsed: number,
  cameraPos: THREE.Vector3 | null = null,
  visibility = 90,
): void {
  uGoudaTime.value = elapsed;

  if (markerMaterial) {
    markerMaterial.opacity = 0.35 + 0.22 * Math.sin(elapsed * 2.6);
  }

  if (cameraPos && worldGroup && elapsed - lastCull > 0.25) {
    lastCull = elapsed;
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

// BiomeRecipe placements → chunk layout, in table order (inside → out).
// The rng stream is a pure function of the tables: sizeVar 0 and single-part
// biomes consume no rng, so the default tables reproduce the v3 worlds.
function placeChunks(rng: Rng, world: WorldRecipe, diff: number): WorldPlan {
  const frame = makeFrame(world.frame);
  const specs: ChunkSpec[] = [];
  const softSpots: SoftSpot[] = [];
  const spine = computeSpine(rng, world, frame);
  const size = (b: BiomeRecipe) =>
    b.sizeVar > 0 ? b.sizeBase + rng() * b.sizeVar : b.sizeBase;

  // Scattered band: rejection-sample against same-zone spacing (guard) and
  // the heart; shrink the chunk when a band is too crowded to fit it.
  const tryBand = (
    biome: BiomeRecipe,
    pl: Extract<BiomePlacement, { mode: "band" }>,
  ) => {
    let s = size(biome);
    const part = pickPart(world, biome, rng);
    for (let shrink = 0; shrink < 4; shrink++, s *= 0.9) {
      for (let attempt = 0; attempt < 500; attempt++) {
        randDir(rng, _dir);
        let u = rng();
        if (pl.densityGrade === "outward") u = Math.sqrt(u);
        else if (pl.densityGrade === "inward") u = 1 - Math.sqrt(1 - u);
        const rad = pl.rMin + u * (pl.rMax - pl.rMin);
        const p = frameToWorld(
          frame,
          new THREE.Vector3(_dir.x * rad, _dir.y * rad, _dir.z * rad),
        );
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
        if (ok) {
          specs.push({
            center: p,
            s,
            res: biome.res,
            label: biome.label,
            zone: biome.id,
            part,
          });
          return;
        }
      }
    }
  };

  // A fibonacci shell of fused wall chunks with radial through-routes.
  const shell = (
    biome: BiomeRecipe,
    pl: Extract<BiomePlacement, { mode: "shell" }>,
  ) => {
    const GOLDEN = 2.399963229728653;
    const n = pl.count + (diff - 1) * pl.perDifficulty;
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = i * GOLDEN;
      const axis = new THREE.Vector3(
        Math.cos(th) * r + (rng() - 0.5) * 0.08,
        y + (rng() - 0.5) * 0.08,
        Math.sin(th) * r + (rng() - 0.5) * 0.08,
      ).normalize();
      const rad = pl.radius + (rng() - 0.5) * 4;
      const colossal = pl.colossalEvery > 0 && i % pl.colossalEvery === 0;
      const s = colossal
        ? biome.sizeBase +
          biome.sizeVar +
          pl.colossalBonus +
          rng() * pl.colossalVar
        : size(biome);
      specs.push({
        center: axis.clone().multiplyScalar(rad),
        s,
        res: colossal ? pl.colossalRes : biome.res,
        label: colossal ? `a colossal wheel` : biome.label,
        zone: biome.id,
        part: pickPart(world, biome, rng),
        axis: { x: axis.x, y: axis.y, z: axis.z },
      });
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
    } else if (pl.mode === "shell") {
      shell(biome, pl);
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
      const squash = frame?.squash ?? 1;
      const body: LayerBody = {
        kind: "hull",
        frame,
        nOff: rng() * 100,
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
      tileLayer(biome, body);
    }
  }

  return { specs, spine, softSpots };
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
  return placeChunks(mulberry32(seed >>> 0), world, difficulty);
}

// --- Layer carve networks ---------------------------------------------------------------------

export interface LayerGenOpts {
  loopFrac: number;
  sideExits: number;
  spineIn: SpinePoint | null;
  spineOut: SpinePoint | null;
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
// Pairs of plain ellipsoid chunks never share — classic-onion compat.
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

  for (let a = 0; a < list.length; a++) {
    const ca = list[a];
    for (let b = a + 1; b < list.length; b++) {
      const cb = list[b];
      if (!ca.body && !cb.body) continue;
      if (ca.body && ca.body === cb.body) continue;
      if (ca.center.distanceTo(cb.center) > (ca.s + cb.s) * 1.74) continue;
      collect(ca, cb, addH[b], addT[b]);
      collect(cb, ca, addH[a], addT[a]);
    }
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
  const plan = placeChunks(rng, world, diff);
  const specs = plan.specs;
  const frame = makeFrame(world.frame);
  const blast: Vec3[] = [];
  const ctx: GenCtx = { difficulty: diff, blastPoints: blast };

  // Phase 1 — chunk data. Layer-body biomes generate as whole layers (their
  // tiles are contiguous in spec order); everything else is per-chunk.
  const pending: Chunk[] = [];
  for (let i = 0; i < specs.length;) {
    const spec = specs[i];
    if (spec.body) {
      let j = i;
      while (j < specs.length && specs[j].body === spec.body) j++;
      const biome = world.biomes.find((b) => b.id === spec.zone)!;
      const pl = biome.placement;
      const near = (r: number): SpinePoint | null => {
        let best: SpinePoint | null = null;
        for (const p of plan.spine)
          if (!best || Math.abs(p.r - r) < Math.abs(best.r - r)) best = p;
        return best && Math.abs(best.r - r) < 15 ? best : null;
      };
      const layerOpts: LayerGenOpts =
        pl.mode === "fused"
          ? {
              loopFrac: pl.loopFrac,
              sideExits: pl.sideExits,
              spineIn: near(pl.rMax),
              spineOut: near(pl.rMin),
            }
          : { loopFrac: 0, sideExits: 0, spineIn: null, spineOut: null };
      for (const c of buildLayerChunks(
        rng,
        specs.slice(i, j),
        ctx,
        layerOpts,
      )) {
        c.zone = spec.zone;
        pending.push(c);
      }
      i = j;
    } else {
      const chunk = makeChunkData(
        rng,
        spec.center,
        spec.s,
        spec.res,
        spec.part,
        ctx,
        spec.axis ?? null,
      );
      chunk.zone = spec.zone;
      pending.push(chunk);
      i++;
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
  opts: { seed?: number; difficulty?: number; world?: WorldRecipe } = {},
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
  blastPoints.push(...data.blastPoints);
  const total = specs.length + 1;
  let triangles = 0;

  // Mesh phase (consumes no rng — the stream completed in buildWorldData).
  for (let i = 0; i < data.chunks.length; i++) {
    const chunk = data.chunks[i];
    chunks.push(chunk);
    const mesh = meshChunk(chunk, chunk.res, materials[chunk.zone!]!);
    mesh.userData.reach = chunk.body ? chunk.s * 1.75 : chunk.s * 1.4;
    triangles += mesh.geometry.attributes.position.count / 3;
    group.add(mesh);
    onProgress(i + 1, total, specs[i].label);
    await nextTick();
  }
  // NOTE: the MC scratch instances are deliberately KEPT — digging reuses
  // them to re-mesh chunks at runtime.

  const crumbGeos = data.debrisNoiseOffsets.map(makeDebrisGeometry);
  const crumbMaterial =
    materials.scree ?? materials.drift ?? materials[world.biomes[0].id]!;
  for (const spec of data.debris) {
    const crumb = new THREE.Mesh(crumbGeos[spec.geoIndex], crumbMaterial);
    crumb.position.copy(spec.center);
    crumb.scale.setScalar(spec.s);
    crumb.rotation.set(spec.rot.x, spec.rot.y, spec.rot.z);
    crumb.castShadow = true;
    crumb.receiveShadow = true;
    group.add(crumb);
    debris.push({ center: spec.center, r: spec.r, mesh: crumb });
  }

  scene.add(group);

  goldPos = data.goldPos;
  // Wheel is an item (game/items.ts), world only seeds position.
  createBoundarySphere(extrasGroup, world.boundaryR);
  createBlastMarkers(extrasGroup);
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

// --- Runtime queries -----------------------------------------------------------------------

// A layer tile's field (body + its distributed carves) is authoritative only
// inside its marched box plus the carve-distribution pad — beyond that the
// uncarved body SDF reports phantom solid where a neighbouring tile carries
// the carve. Every world point near the body lies in some tile's box, so
// queries skip tiles that don't cover the point. Exported for the verifier
// and the bench (their query loops must apply the same ownership rule).
export function tileFieldCovers(
  c: Chunk,
  x: number,
  y: number,
  z: number,
): boolean {
  const cellW = (2 * c.s) / c.res;
  const pad = SMOOTH_K * c.s + 2 * cellW;
  const lo = -(c.s - cellW) - pad;
  const hi = c.s - 2 * cellW + pad;
  const dx = x - c.center.x;
  if (dx < lo || dx > hi) return false;
  const dy = y - c.center.y;
  if (dy < lo || dy > hi) return false;
  const dz = z - c.center.z;
  return dz >= lo && dz <= hi;
}

// World distance to ONE chunk's solid (world units) — exported for the
// worldgen bench, whose part/biome previews keep their own chunk lists.
export function chunkDistance(
  c: Chunk,
  x: number,
  y: number,
  z: number,
): number {
  return (
    chunkSdf(
      c,
      (x - c.center.x) / c.s,
      (y - c.center.y) / c.s,
      (z - c.center.z) / c.s,
    ) * c.s
  );
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
  for (let i = 0; i < chunkList.length; i++) {
    const c = chunkList[i];
    const dx = x - c.center.x,
      dy = y - c.center.y,
      dz = z - c.center.z;
    const dc = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (c.body) {
      // Tile of a layer body: the tile's box owns its region (see
      // tileFieldCovers) — outside it the tile must not contribute.
      if (dc - c.s * 1.74 > best) continue;
      if (!tileFieldCovers(c, x, y, z)) continue;
      const d = chunkSdf(c, dx / c.s, dy / c.s, dz / c.s) * c.s;
      if (d < best) best = d;
      continue;
    }
    if (dc - c.s > best) continue;
    if (dc > c.s * 1.4) {
      if (dc - c.s * (R0 + 0.25) < best) best = dc - c.s * (R0 + 0.25);
      continue;
    }
    const d = chunkSdf(c, dx / c.s, dy / c.s, dz / c.s) * c.s;
    if (d < best) best = d;
  }
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

export function worldDistance(x: number, y: number, z: number): number {
  return distanceToWorld(chunks, debris, x, y, z);
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
