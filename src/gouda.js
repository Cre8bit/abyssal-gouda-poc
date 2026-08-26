// gouda.js — the procedural abyssal gouda labyrinth, v3.
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
//   the heart     (0)        colossal hunk, gold core in its grand cavern
//
// Dead-end chambers sealed by deliberately thin walls are marked with a
// crack-glow (getBlastPoints()) — dig or (future) blast through them.
// Generation is seeded per game; the host's seed rides the invite link and
// the handshake, so peers share the exact same maze.

import * as THREE from "three";
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { getToonGradient } from "./toon.js";

export const WORLD_R = 420; // outer edge of the drift
export const BOUNDARY_R = 470; // visible map boundary veil
export const HEART_POS = { x: 0, y: 0, z: 0 }; // map center — a DECOY.
// The gold hides in a random cavern inside one of the mid-radius wheels
// (see GOLD_BAND) and is NOT shown on the compass. Search, listen, dig.
const GOLD_BAND = [60, 175];

const HEART_S = 56;
const HEART_RES = 96;

const CRUST_R = 155; // sealed wall #1
const CRUST_N = 48;
const BULWARK_R = 80; // sealed wall #2
const BULWARK_N = 18;

const REEF_COUNT = 18;
const CHIMNEY_COUNT = 14;
const SCREE_COUNT = 44;
const WARREN_COUNT = 10;
const GALLERY_COUNT = 12;
const HOLLOW_COUNT = 8;
const DRIFT_COUNT = 12;
const DEBRIS_COUNT = 460;

const RES_HEART = HEART_RES;
const RES_WARREN = 64;
const RES_WALL = 48;
const RES_MED = 48;
const RES_SMALL = 32;
const MAX_POLYS = {
  96: 220000,
  72: 140000,
  64: 110000,
  56: 90000,
  48: 70000,
  32: 24000,
};

// Local-space (unit-sphere) shape parameters. Surface ~ |p| = R0, grid [-1,1].
const R0 = 0.6;
const NOISE_FREQ = 1.6;
const SHELL = 0.22;
const CARVE_SKIP = 0.3;
const SMOOTH_K = 0.05;
const PLANE_K = 0.025;

const noise = new ImprovedNoise();

// --- Generation parameters (set per game) --------------------------------------

let worldSeed = 1337;
let difficulty = 1;

const chunks = []; // each: SDF params + cached voxel field + live mesh
const debris = []; // { center, r, mesh }
const blastPoints = [];
let worldGroup = null;
let extrasGroup = null;
let goldCore = null;
let goldPos = null; // world position of the hidden gold
let markerMaterial = null;
let spawnPoint = null;
let lastCull = -1;

const uGoudaTime = { value: 0 };

// --- Seeded RNG ------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randDir(rng, out) {
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

function fbm3(x, y, z) {
  return (
    noise.noise(x, y, z) +
    0.5 * noise.noise(x * 2.13 + 7.7, y * 2.13 + 3.1, z * 2.13 + 11.6)
  );
}

function smoothCut(d, cut, k) {
  const b = -cut;
  const h = Math.max(k - Math.abs(d - b), 0) / k;
  return Math.max(d, b) + h * h * k * 0.25;
}

function smoothMax(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

function segDist(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax,
    aby = by - ay,
    abz = bz - az;
  const apx = px - ax,
    apy = py - ay,
    apz = pz - az;
  let t =
    (apx * abx + apy * aby + apz * abz) /
    (abx * abx + aby * aby + abz * abz);
  t = Math.max(0, Math.min(1, t));
  const dx = apx - abx * t,
    dy = apy - aby * t,
    dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// The UNCARVED chunk body: ellipsoid + crust noise + plane cuts. Besides
// meshing/collision, this is what tells rind from paste: a surface vertex
// whose base distance is near zero sits on the outer waxed rind; one that is
// DEEP INSIDE the base body (a hole, tunnel, cut face or dig) shows the
// bright interior paste — the cheese signature.
function baseSdf(c, x, y, z) {
  const ex = x * c.ix,
    ey = y * c.iy,
    ez = z * c.iz;
  let d = (Math.sqrt(ex * ex + ey * ey + ez * ez) - R0) * c.minAxis;

  const ad = Math.abs(d);
  if (ad < SHELL) {
    let fade = 1 - ad / SHELL;
    fade = fade * fade * (3 - 2 * fade);
    d +=
      fbm3(
        x * NOISE_FREQ + c.nOff,
        y * NOISE_FREQ + c.nOff * 1.7,
        z * NOISE_FREQ + c.nOff * 0.6,
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

// The full chunk SDF in LOCAL grid space [-1,1]. Meshing, collision AND
// digging all run through this — keep them in lockstep.
function chunkSdf(c, x, y, z) {
  let d = baseSdf(c, x, y, z);

  if (d > CARVE_SKIP) return d;

  const holes = c.holes;
  for (let i = 0; i < holes.length; i++) {
    const h = holes[i];
    const dx = x - h.x,
      dy = y - h.y,
      dz = z - h.z;
    d = smoothCut(d, Math.sqrt(dx * dx + dy * dy + dz * dz) - h.r, SMOOTH_K);
    if (d > 0.45) return d; // deep in a cavern: no surface near, bail out
  }

  const tunnels = c.tunnels;
  for (let i = 0; i < tunnels.length; i++) {
    const t = tunnels[i];
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
function addTunnel(c, rng, a, b, r, bends) {
  if (!bends) {
    c.tunnels.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, r });
    return;
  }
  const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const pts = [a];
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

// opts: kind ("wheel"|"hunk"|"block"|"slab"), eyesMin/Max, eyeRBase/Var,
// exits, coreEye, deadEnds, axis (radial through-route), narrow, tangle,
// pores [min,max], poreR [base,var], tunnelR [base,var]
function makeChunkData(rng, center, s, res, opts) {
  const cell = 2 / res;
  const minTunnelR = (opts.narrow ? 2.2 : 2.6) * cell;
  const tunnelScale = [1.15, 1.0, 0.85][difficulty - 1] ?? 1.0;
  const tr = (base) => Math.max(minTunnelR, base * tunnelScale);
  const bends =
    opts.narrow ? 2 : opts.kind === "block" || opts.kind === "slab" ? 0 : 1;
  const [trBase, trVar] = opts.tunnelR ?? [0.055, 0.04];

  let sx, sy, sz;
  if (opts.kind === "wheel") {
    sx = 0.95 + rng() * 0.2;
    sy = 0.5 + rng() * 0.2;
    sz = 0.95 + rng() * 0.2;
  } else if (opts.kind === "column") {
    // Tall chimney: narrow footprint, full grid height.
    sx = 0.38 + rng() * 0.14;
    sy = 1.1 + rng() * 0.15;
    sz = 0.38 + rng() * 0.14;
  } else {
    sx = 0.85 + rng() * 0.35;
    sy = 0.85 + rng() * 0.35;
    sz = 0.85 + rng() * 0.35;
  }

  const c = {
    center,
    s,
    res,
    ix: 1 / sx,
    iy: 1 / sy,
    iz: 1 / sz,
    minAxis: Math.min(sx, sy, sz),
    nOff: rng() * 100,
    // LOW noise: waxy smooth wheels, crisp flat cuts, round readable holes.
    amp: opts.kind === "block" || opts.kind === "slab" ? 0.04 : 0.08,
    planes: [],
    holes: [],
    tunnels: [],
    digs: [],
    field: null, // cached voxel field (filled at meshing, edited by digs)
    mesh: null,
  };

  // Plane cuts.
  if (opts.kind === "block" || opts.kind === "slab") {
    randDir(rng, _dir);
    const half =
      opts.kind === "slab" ? 0.13 + rng() * 0.07 : 0.22 + rng() * 0.14;
    c.planes.push({ nx: _dir.x, ny: _dir.y, nz: _dir.z, off: half });
    c.planes.push({ nx: -_dir.x, ny: -_dir.y, nz: -_dir.z, off: half });
    const nCuts = opts.kind === "slab" ? 1 : 1 + Math.floor(rng() * 3);
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

  const eyes = [];

  if (opts.coreEye) {
    const core = { x: 0, y: 0, z: 0, r: opts.coreEye };
    eyes.push(core);
    c.holes.push(core);
  }

  const nEyes =
    opts.eyesMin + Math.floor(rng() * (opts.eyesMax - opts.eyesMin + 1));
  for (let i = 0; i < nEyes; i++) {
    randDir(rng, _dir);
    const t = R0 * (0.12 + 0.58 * rng());
    const x = _dir.x * t * sx,
      y = _dir.y * t * sy,
      z = _dir.z * t * sz;
    const centerBias = 1.25 - (t / R0) * 0.55;
    const r = (opts.eyeRBase + opts.eyeRVar * rng()) * centerBias;
    const eye = { x, y, z, r };
    eyes.push(eye);
    c.holes.push(eye);
  }

  // Round pores. Slabs get many BIG ones — clean through-holes in the plate.
  const [pMin, pMax] = opts.pores ?? [10, 18];
  const [prBase, prVar] = opts.poreR ?? [0.055, 0.075];
  const nPores = pMin + Math.floor(rng() * (pMax - pMin + 1));
  for (let i = 0; i < nPores; i++) {
    randDir(rng, _dir);
    const t = R0 * (opts.kind === "slab" ? 0.5 + 0.6 * rng() : 0.85 + 0.3 * rng());
    c.holes.push({
      x: _dir.x * t * sx,
      y: _dir.y * t * sy,
      z: _dir.z * t * sz,
      r: Math.max(1.6 * cell, prBase + prVar * rng()),
    });
  }

  // Spanning tree (+tangle: attach to a random earlier chamber — long
  // intertwined passages, easy to descend, hard to retrace).
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
    const j = opts.tangle
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
  const nExits = opts.exits + Math.floor(rng() * 2);
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
  if (opts.axis) {
    const a = opts.axis;
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
  const nDead = (opts.deadEnds ?? 0) + (difficulty - 1);
  for (let k = 0; k < nDead && eyes.length >= 2; k++) {
    const start = eyes[Math.floor(rng() * eyes.length)];
    let target = eyes[Math.floor(rng() * eyes.length)];
    if (target === start) target = eyes[(eyes.indexOf(target) + 1) % eyes.length];
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
    blastPoints.push({
      x: center.x + (target.x + _dir.x * (target.r + wall / 2)) * s,
      y: center.y + (target.y + _dir.y * (target.r + wall / 2)) * s,
      z: center.z + (target.z + _dir.z * (target.r + wall / 2)) * s,
    });
  }

  // Remember the grandest cavern — a candidate hiding spot for the gold.
  let biggest = eyes[0] ?? null;
  for (const e of eyes) if (e.r > (biggest?.r ?? 0)) biggest = e;
  c.biggestEye = biggest;

  return c;
}

// --- Meshing -------------------------------------------------------------------------

// The scratch marching-cubes instances stay alive for the whole session:
// digging re-uses them to re-mesh single chunks on the fly.
const mcCache = new Map();

function getMC(res) {
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

// Turns the MC's current triangulation into a compact static geometry with
// sanitized normals (zero-length normals ⇒ NaN in GLSL ⇒ black bloom smears)
// and a per-vertex RIND factor: 1 on the outer waxed crust, 0 on any carved
// surface (holes, tunnels, cut faces, digs) — which the material renders as
// bright interior paste. This contrast is what makes it read as CHEESE.
function extractGeometry(mc, c) {
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
    // Rind factor from the UNCARVED body: ~0 at the outer surface ⇒ rind;
    // clearly negative (deep inside the body) ⇒ carved-open paste.
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

function meshChunk(c, res, material) {
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
  // Cache the field: digs edit it incrementally instead of re-evaluating
  // the whole analytic SDF.
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
function remeshChunk(c) {
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

// Carves a sphere of radius r (world units) at world point (x,y,z) out of
// every overlapping chunk, updates their cached fields, re-meshes them, and
// destroys small debris. Returns true if anything changed.
export function digAt(x, y, z, r) {
  let changed = false;

  for (const c of chunks) {
    const dx = x - c.center.x,
      dy = y - c.center.y,
      dz = z - c.center.z;
    const dc = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dc > c.s * 1.35 + r) continue;

    const lx = dx / c.s,
      ly = dy / c.s,
      lz = dz / c.s;
    const lr = r / c.s;
    c.digs.push({ x: lx, y: ly, z: lz, r: lr });

    // Edit only the voxels the dig can touch.
    const res = c.res;
    const half = res / 2;
    const cell = 1 / half;
    const reach = lr + SMOOTH_K + 2 * cell;
    const min = (v) => Math.max(0, Math.floor((v - reach + 1) * half));
    const max = (v) => Math.min(res - 1, Math.ceil((v + reach + 1) * half));
    const field = c.field;
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

  // Small crumbs shatter outright.
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

  return changed;
}

// Sphere-traces the world SDF along a ray. Returns the hit point (just
// outside the surface) or null. Used to aim the dig tool.
export function raycastSolid(origin, dir, maxDist) {
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

function vec3str(hex) {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
}

// The cheese material. Two-tone via the aCrust vertex attribute:
//   paste — bright pale-yellow interior, shown on every carved surface
//           (holes, tunnels, cut faces, player digs)
//   rind  — the zone's wax coating on the outer crust
// Bioluminescent veins live in the PASTE (glowing from within); the rind
// stays dead and dark. That contrast is the gouda signature.
function createGoudaMaterial({ paste, rind, rough, vein, veinStrength }) {
  // Cel-shaded cheese: MeshToonMaterial quantizes the lighting into hard
  // bands (shared gradient map, see toon.js); the custom paste/rind/vein
  // injection below rides on top unchanged. `rough` is kept for tuning
  // history but toon shading has no roughness.
  void rough;
  const material = new THREE.MeshToonMaterial({
    color: 0xffffff, // overridden per-fragment by the paste/rind mix
    gradientMap: getToonGradient(),
  });

  const pasteVec = vec3str(paste);
  const rindVec = vec3str(rind);
  const veinVec = `vec3(${vein[0].toFixed(3)}, ${vein[1].toFixed(3)}, ${vein[2].toFixed(3)})`;
  const vs = veinStrength.toFixed(3);

  material.onBeforeCompile = (shader) => {
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
          // Ink rim: darken grazing angles toward black — the toon outline.
          vec3 inkV = normalize(cameraPosition - vGoudaWorld);
          vec3 inkN = normalize(vGoudaNormal + vec3(1e-5));
          float ink = smoothstep(0.30, 0.10, abs(dot(inkN, inkV)));
          diffuseColor.rgb *= mix(1.0, 0.30, ink);
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
  // Zones share the same injection SOURCE but different baked constants —
  // force a distinct program per zone so three's shader cache can't merge
  // them into one look.
  material.customProgramCacheKey = () =>
    `gouda${pasteVec}${rindVec}${veinVec}${vs}`;

  return material;
}

function createZoneMaterials() {
  // Bright pale-yellow paste everywhere (that's the cheese), while each
  // biome wears its own WAX RIND — like a warehouse of differently-waxed
  // gouda wheels. Veins glow through the paste only.
  const PASTE = 0xecc76a;
  return {
    // bleached natural rind, ghost-pale
    drift: createGoudaMaterial({
      paste: 0xe3cc86,
      rind: 0xb3a06a,
      rough: 0.6,
      vein: [0.55, 0.52, 0.2],
      veinStrength: 0.4,
    }),
    // young yellow wax plates
    reef: createGoudaMaterial({
      paste: PASTE,
      rind: 0xc79a2f,
      rough: 0.5,
      vein: [0.6, 0.6, 0.18],
      veinStrength: 0.45,
    }),
    // tall smoked-rind chimneys
    chimneys: createGoudaMaterial({
      paste: 0xe0b955,
      rind: 0x6e4f28,
      rough: 0.52,
      vein: [0.7, 0.55, 0.15],
      veinStrength: 0.5,
    }),
    // classic yellow gouda blocks
    scree: createGoudaMaterial({
      paste: PASTE,
      rind: 0xbd8f2a,
      rough: 0.5,
      vein: [0.6, 0.62, 0.12],
      veinStrength: 0.5,
    }),
    // mouldy green-tinged burrow cheese
    warrens: createGoudaMaterial({
      paste: 0xd8c266,
      rind: 0x77692f,
      rough: 0.55,
      vein: [0.5, 0.72, 0.12],
      veinStrength: 0.55,
    }),
    // THE classic: red wax gouda wall
    crust: createGoudaMaterial({
      paste: PASTE,
      rind: 0x8e3c22,
      rough: 0.42,
      vein: [0.95, 0.62, 0.12],
      veinStrength: 0.6,
    }),
    // orange wax cathedrals
    galleries: createGoudaMaterial({
      paste: 0xeabf58,
      rind: 0xa85e20,
      rough: 0.44,
      vein: [1.0, 0.45, 0.1],
      veinStrength: 0.6,
    }),
    // dark burgundy wax — the inner wall
    bulwark: createGoudaMaterial({
      paste: 0xe5b64a,
      rind: 0x5e2a1c,
      rough: 0.42,
      vein: [0.95, 0.35, 0.1],
      veinStrength: 0.65,
    }),
    // black wax, aged — too close to the heart
    hollows: createGoudaMaterial({
      paste: 0xdca93e,
      rind: 0x2c251c,
      rough: 0.4,
      vein: [0.95, 0.22, 0.08],
      veinStrength: 0.7,
    }),
    // gold wax decoy centerpiece
    heart: createGoudaMaterial({
      paste: 0xf0c85a,
      rind: 0xa77b22,
      rough: 0.38,
      vein: [1.0, 0.8, 0.22],
      veinStrength: 0.85,
    }),
  };
}

// --- Gold core, boundary, blast markers ------------------------------------------------------

function createGoldCore(parent, rng, pos, scale = 1) {
  const group = new THREE.Group();
  group.position.set(pos.x, pos.y, pos.z);
  group.scale.setScalar(scale);

  const goldMat = new THREE.MeshToonMaterial({
    color: 0xffc23d,
    emissive: 0xffb020,
    emissiveIntensity: 2.4,
    gradientMap: getToonGradient(),
  });

  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(4.5, 1), goldMat);
  core.castShadow = true;
  group.add(core);

  const shardGeo = new THREE.IcosahedronGeometry(0.7, 0);
  const shards = [];
  for (let i = 0; i < 12; i++) {
    const shard = new THREE.Mesh(shardGeo, goldMat);
    const st = {
      mesh: shard,
      radius: 6.5 + rng() * 4,
      speed: 0.15 + rng() * 0.3,
      phase: rng() * Math.PI * 2,
      tilt: rng() * Math.PI,
    };
    shard.scale.setScalar(0.5 + rng() * 1.2);
    shards.push(st);
    group.add(shard);
  }

  // Cavern light + a soft glow that leaks through nearby tunnels — the only
  // hint of where the gold hides (it is NOT on the compass).
  const light = new THREE.PointLight(0xffb742, 900, 90, 1.8);
  group.add(light);
  const deepGlow = new THREE.PointLight(0xff9c33, 24, 160, 1.3);
  group.add(deepGlow);

  parent.add(group);
  goldCore = { group, core, light, deepGlow, shards };
}

function createBoundarySphere(parent) {
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
    new THREE.SphereGeometry(BOUNDARY_R, 48, 32),
    material,
  );
  mesh.frustumCulled = false;
  parent.add(mesh);
}

let markerTexture = null;
function getMarkerTexture() {
  if (markerTexture || typeof document === "undefined") return markerTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
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

function createBlastMarkers(parent) {
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

export function updateGouda(elapsed, cameraPos = null, visibility = 90) {
  uGoudaTime.value = elapsed;

  if (goldCore) {
    const pulse = 0.75 + 0.25 * Math.sin(elapsed * 0.8);
    goldCore.light.intensity = 900 * pulse;
    goldCore.deepGlow.intensity = 24 * (0.85 + 0.15 * Math.sin(elapsed * 0.31));
    goldCore.core.material.emissiveIntensity = 1.8 + 1.2 * pulse;
    goldCore.core.rotation.y = elapsed * 0.1;
    goldCore.core.rotation.x = elapsed * 0.04;
    for (const s of goldCore.shards) {
      const a = elapsed * s.speed + s.phase;
      s.mesh.position.set(
        Math.cos(a) * s.radius,
        Math.sin(a * 0.7 + s.tilt) * s.radius * 0.5,
        Math.sin(a) * s.radius,
      );
    }
  }

  if (markerMaterial) {
    markerMaterial.opacity = 0.35 + 0.22 * Math.sin(elapsed * 2.6);
  }

  if (cameraPos && worldGroup && elapsed - lastCull > 0.25) {
    lastCull = elapsed;
    const cullDist = Math.min(Math.max(visibility * 1.25, 80), 720);
    for (const child of worldGroup.children) {
      const reach = child.scale.x * 1.4;
      child.visible = child.position.distanceTo(cameraPos) - reach < cullDist;
    }
  }
}

// --- World assembly -----------------------------------------------------------------------------

function placeChunks(rng) {
  const specs = [
    {
      center: new THREE.Vector3(0, 0, 0),
      s: HEART_S,
      res: RES_HEART,
      label: "the heart",
      zone: "heart",
      opts: {
        kind: "hunk",
        eyesMin: 18,
        eyesMax: 24,
        eyeRBase: 0.1,
        eyeRVar: 0.17,
        exits: 6,
        coreEye: 0.34,
        deadEnds: 4,
      },
    },
  ];

  const tryBand = (zone, rMin, rMax, s, res, label, opts, guard) => {
    for (let shrink = 0; shrink < 4; shrink++, s *= 0.9) {
      for (let attempt = 0; attempt < 500; attempt++) {
        randDir(rng, _dir);
        const rad = rMin + rng() * (rMax - rMin);
        const p = new THREE.Vector3(_dir.x * rad, _dir.y * rad, _dir.z * rad);
        let ok = true;
        for (const other of specs) {
          const g =
            other.zone === "heart" ? 0.72 : other.zone === zone ? guard : null;
          if (g !== null && p.distanceTo(other.center) < (s + other.s) * g) {
            ok = false;
            break;
          }
        }
        if (ok) {
          specs.push({ center: p, s, res, label, zone, opts });
          return;
        }
      }
    }
  };

  // A fibonacci shell of fused wall chunks with radial through-routes.
  const shell = (zone, label, radius, n, sMin, sVar, res, opts) => {
    const GOLDEN = 2.399963229728653;
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = i * GOLDEN;
      const axis = new THREE.Vector3(
        Math.cos(th) * r + (rng() - 0.5) * 0.08,
        y + (rng() - 0.5) * 0.08,
        Math.sin(th) * r + (rng() - 0.5) * 0.08,
      ).normalize();
      const rad = radius + (rng() - 0.5) * 4;
      const colossal = i % 13 === 0;
      specs.push({
        center: axis.clone().multiplyScalar(rad),
        s: colossal ? sMin + sVar + 12 + rng() * 8 : sMin + rng() * sVar,
        res: colossal ? 64 : res,
        label: colossal ? `a colossal wheel` : label,
        zone,
        opts: { ...opts, axis: { x: axis.x, y: axis.y, z: axis.z } },
      });
    }
  };

  const hollowOpts = {
    kind: "wheel",
    eyesMin: 8,
    eyesMax: 12,
    eyeRBase: 0.1,
    eyeRVar: 0.12,
    exits: 4,
    deadEnds: 1,
  };
  const galleryOpts = {
    kind: "wheel",
    eyesMin: 6,
    eyesMax: 9,
    eyeRBase: 0.16,
    eyeRVar: 0.12,
    exits: 4,
    deadEnds: 2,
    tunnelR: [0.08, 0.04], // wide cathedral corridors
  };
  const wallOpts = {
    kind: "hunk",
    eyesMin: 12,
    eyesMax: 18,
    eyeRBase: 0.1,
    eyeRVar: 0.15,
    exits: 3,
    deadEnds: 1,
  };
  const warrenOpts = {
    kind: "hunk",
    eyesMin: 18,
    eyesMax: 26,
    eyeRBase: 0.05,
    eyeRVar: 0.05,
    exits: 2,
    deadEnds: 2,
    narrow: true,
    tangle: true,
    tunnelR: [0.038, 0.022],
  };
  const blockOpts = {
    kind: "block",
    eyesMin: 2,
    eyesMax: 4,
    eyeRBase: 0.09,
    eyeRVar: 0.09,
    exits: 2,
  };
  const slabOpts = {
    kind: "slab",
    eyesMin: 2,
    eyesMax: 4,
    eyeRBase: 0.1,
    eyeRVar: 0.08,
    exits: 2,
    pores: [14, 20],
    poreR: [0.08, 0.09], // big clean through-holes
  };

  const chimneyOpts = {
    kind: "column",
    eyesMin: 5,
    eyesMax: 8,
    eyeRBase: 0.08,
    eyeRVar: 0.08,
    exits: 3,
    pores: [12, 18],
  };

  // THE HOLLOWS: cramped approach wheels around the heart.
  for (let i = 0; i < HOLLOW_COUNT; i++)
    tryBand("hollows", 38, 60, 14 + rng() * 7, RES_MED, "the hollows", hollowOpts, 0.5);

  // THE BULWARK: sealed wall #2 — tight shell of fused hunks.
  shell("bulwark", "the bulwark", BULWARK_R, BULWARK_N + (difficulty - 1) * 2, 44, 10, RES_WALL, wallOpts);

  // THE GALLERIES: cathedral wheels between the walls.
  for (let i = 0; i < GALLERY_COUNT; i++)
    tryBand("galleries", 100, 140, 22 + rng() * 12, RES_MED, "the galleries", galleryOpts, 0.5);

  // THE CRUST: sealed wall #1 — the big outer wall of many giant parts.
  shell("crust", "the crust wall", CRUST_R, CRUST_N + (difficulty - 1) * 4, 60, 12, RES_WALL, wallOpts);

  // THE WARRENS: speleology chunks against the crust's outer face.
  for (let i = 0; i < WARREN_COUNT; i++)
    tryBand("warrens", 185, 225, 30 + rng() * 8, RES_WARREN, "the warrens", warrenOpts, 0.55);

  // THE SCREE: dense belt of small cut blocks.
  for (let i = 0; i < SCREE_COUNT; i++)
    tryBand("scree", 230, 285, 10 + rng() * 8, RES_SMALL, "the scree", blockOpts, 0.65);

  // THE CHIMNEYS: a forest of tall smoked columns — swim the vertical maze.
  for (let i = 0; i < CHIMNEY_COUNT; i++)
    tryBand("chimneys", 285, 340, 30 + rng() * 12, RES_MED, "the chimneys", chimneyOpts, 0.5);

  // THE REEF: fields of thin plates with big through-holes.
  for (let i = 0; i < REEF_COUNT; i++)
    tryBand("reef", 335, 385, 30 + rng() * 14, RES_MED, "the reef", slabOpts, 0.55);

  // THE DRIFT: sparse pale blocks at the very edge.
  for (let i = 0; i < DRIFT_COUNT; i++)
    tryBand("drift", 388, WORLD_R, 11 + rng() * 8, RES_SMALL, "the drift", blockOpts, 1.2);

  return specs;
}

function makeDebrisGeometry(rng) {
  const geo = new THREE.IcosahedronGeometry(1, 3);
  const pos = geo.attributes.position;
  const off = rng() * 50;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = fbm3(v.x * 1.4 + off, v.y * 1.4 + off * 2.1, v.z * 1.4 + off * 0.7);
    v.multiplyScalar(1 + 0.26 * n);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function buildGoudaWorld(scene, onProgress = () => {}, opts = {}) {
  worldSeed = (opts.seed ?? worldSeed) >>> 0;
  difficulty = Math.min(3, Math.max(1, opts.difficulty ?? difficulty));

  const t0 = performance.now();
  const rng = mulberry32(worldSeed);
  const materials = createZoneMaterials();
  const group = new THREE.Group();
  worldGroup = group;
  extrasGroup = new THREE.Group();

  const specs = placeChunks(rng);
  const total = specs.length + 1;
  let triangles = 0;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const chunk = makeChunkData(rng, spec.center, spec.s, spec.res, spec.opts);
    chunk.zone = spec.zone;
    chunks.push(chunk);
    const mesh = meshChunk(chunk, spec.res, materials[spec.zone]);
    triangles += mesh.geometry.attributes.position.count / 3;
    group.add(mesh);
    onProgress(i + 1, total, spec.label);
    await nextTick();
  }
  // NOTE: the MC scratch instances are deliberately KEPT — digging reuses
  // them to re-mesh chunks at runtime.

  const crumbGeos = [
    makeDebrisGeometry(rng),
    makeDebrisGeometry(rng),
    makeDebrisGeometry(rng),
  ];
  for (let i = 0; i < DEBRIS_COUNT; i++) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const host = chunks[Math.floor(rng() * chunks.length)];
      randDir(rng, _dir);
      const dist = host.s * (0.75 + rng() * 0.65);
      const p = new THREE.Vector3(
        host.center.x + _dir.x * dist,
        host.center.y + _dir.y * dist,
        host.center.z + _dir.z * dist,
      );
      const s = 0.7 + rng() * 2.4;
      if (worldDistance(p.x, p.y, p.z) < s + 1.2) continue;
      const crumb = new THREE.Mesh(crumbGeos[i % 3], materials.scree);
      crumb.position.copy(p);
      crumb.scale.setScalar(s);
      crumb.rotation.set(rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2);
      crumb.castShadow = true;
      crumb.receiveShadow = true;
      group.add(crumb);
      debris.push({ center: p, r: s * 0.8, mesh: crumb });
      break;
    }
  }

  scene.add(group);

  // HIDE THE GOLD: a random grand cavern inside a mid-radius wheel — never
  // at the center (the heart is a decoy), never near the borders, and never
  // on the compass. Seeded, so every peer hides it in the same place.
  const candidates = chunks.filter((c) => {
    const r = c.center.length();
    return (
      c.biggestEye &&
      r >= GOLD_BAND[0] &&
      r <= GOLD_BAND[1] &&
      c.biggestEye.r * c.s > 6
    );
  });
  const host = candidates.length
    ? candidates[Math.floor(rng() * candidates.length)]
    : chunks[0];
  const eye = host.biggestEye;
  goldPos = {
    x: host.center.x + eye.x * host.s,
    y: host.center.y + eye.y * host.s,
    z: host.center.z + eye.z * host.s,
  };
  const goldScale = Math.min(1, Math.max(0.4, (eye.r * host.s) / 16));

  createGoldCore(extrasGroup, rng, goldPos, goldScale);
  createBoundarySphere(extrasGroup);
  createBlastMarkers(extrasGroup);
  scene.add(extrasGroup);

  // Spawn at the drift's edge with the whole glowing ball in view. The
  // bathyscaphe berths here with its hatch facing the cheese (-Z), so keep
  // the doorway's exit corridor clear too, not just the spawn point.
  const p = new THREE.Vector3(0, 18, WORLD_R + 14);
  while (
    (worldDistance(p.x, p.y, p.z) < 6 || worldDistance(p.x, p.y, p.z - 9) < 4) &&
    p.z < BOUNDARY_R - 6
  )
    p.z += 3;
  spawnPoint = p;

  onProgress(total, total, "gold");
  console.log(
    `gouda: seed ${worldSeed} d${difficulty} — ${chunks.length} wheels, ` +
      `${debris.length} crumbs, ${blastPoints.length} blast walls, ` +
      `${Math.round(triangles / 1000)}k tris in ${Math.round(performance.now() - t0)}ms`,
  );
  return group;
}

export function disposeWorld(scene) {
  for (const g of [worldGroup, extrasGroup]) {
    if (!g) continue;
    scene.remove(g);
    g.traverse((child) => {
      child.geometry?.dispose();
      if (child.material?.dispose) child.material.dispose();
    });
  }
  worldGroup = null;
  extrasGroup = null;
  goldCore = null;
  goldPos = null;
  markerMaterial = null;
  chunks.length = 0;
  debris.length = 0;
  blastPoints.length = 0;
  spawnPoint = null;
}

// Where the gold actually hides (for win-condition logic — NOT for the HUD).
export function getGoldPos() {
  return goldPos;
}

export function getWorldSeed() {
  return worldSeed;
}

export function getBlastPoints() {
  return blastPoints;
}

// --- Runtime queries -----------------------------------------------------------------------

export function worldDistance(x, y, z) {
  let best = 1e9;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const dx = x - c.center.x,
      dy = y - c.center.y,
      dz = z - c.center.z;
    const dc = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dc - c.s > best) continue;
    if (dc > c.s * 1.4) {
      if (dc - c.s * (R0 + 0.25) < best) best = dc - c.s * (R0 + 0.25);
      continue;
    }
    const d = chunkSdf(c, dx / c.s, dy / c.s, dz / c.s) * c.s;
    if (d < best) best = d;
  }
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
export function resolveCollision(pos, radius) {
  let normal = null;
  for (let iter = 0; iter < 2; iter++) {
    const d = worldDistance(pos.x, pos.y, pos.z);
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

export function findOpenSpot(near = null, minD = 0, maxD = 0) {
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

export function getSpawnPoint() {
  return spawnPoint ?? { x: 0, y: 18, z: WORLD_R + 14 };
}
