// gouda.js — the procedural abyssal gouda labyrinth, v2.
//
// SHAPE GRAMMAR — every chunk is an analytic SDF built from:
//   · a squashed ellipsoid base ("wheel": flattened round; "hunk": rounder)
//   · optional flat plane cuts ("block"/"wedge": cut-cheese slabs, like the
//     concept art's angular debris) with slightly beveled edges
//   · smooth crust noise (kept LOW so faces stay flat and holes stay round)
//   · minus perfectly spherical eyes (caverns/chambers) and pores
//   · minus winding tunnel capsules (bent polylines, not straight rods)
//
// CAVE SYSTEMS — eyes are linked by a spanning tree plus extra loops
// (multiple routes), exit tunnels are punched to the surface, bulwark wheels
// get guaranteed radial THROUGH-routes, and dead-end branches end in sealed
// chambers separated from a neighbouring cavity by a deliberately thin wall:
// marked blast walls, for the future explosives/digging feature
// (getBlastPoints()).
//
// ONION MAP — concentric zones, outside → in, each its own biome:
//   the drift    (~195–225)  sparse pale cut blocks, first silhouettes
//   the scree    (~150–190)  dense belt of small slabs & wedges to weave through
//   the bulwark  (~120)      near-sealed shell of giant fused wheels — pass
//                            THROUGH their tunnel complexes
//   the hollows  (~60–88)    cavernous wheels, red ominous glow
//   the heart    (0)         colossal hunk, gold core in its central cavern
//
// The same SDF is meshed once (marching cubes) and sampled at runtime for
// swim collision. Generation is seeded per game (host shares the seed), so
// every peer builds the identical maze — and every game is a new one.

import * as THREE from "three";
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";

export const WORLD_R = 225; // outer edge of the drift (world units)
export const BOUNDARY_R = 255; // visible map boundary sphere
export const HEART_POS = { x: 0, y: 0, z: 0 }; // the gouda gold

const HEART_S = 62;
const HEART_RES = 96;
const BULWARK_R = 120; // the crust wall: dense shell, sealed except tunnels
const BULWARK_N = 40; // many parts, spaced ⇒ crusts fuse into one wall
const HOLLOW_COUNT = 12;
const WARREN_COUNT = 6; // speleology chunks: long tangled narrow tunnels
const SCREE_COUNT = 24;
const DRIFT_COUNT = 8;
const DEBRIS_COUNT = 300;

const RES_BIG = 72;
const RES_BULWARK = 64;
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
const NOISE_FREQ = 1.6; // low frequency: waxy undulation, not rocky grit
const SHELL = 0.22;
const CARVE_SKIP = 0.3;
const SMOOTH_K = 0.05; // rounder, softer hole rims
const PLANE_K = 0.025; // slight bevel on cut faces

const noise = new ImprovedNoise();

// --- Generation parameters (set per game) -----------------------------------

let worldSeed = 1337;
let difficulty = 1; // 1..3: narrower tunnels, thicker bulwark, more dead ends

const chunks = [];
const debris = [];
const blastPoints = []; // { x, y, z } world-space thin walls (future explosives)
let worldGroup = null;
let extrasGroup = null; // gold core, boundary, markers, center glow
let goldCore = null;
let markerMaterial = null;
let spawnPoint = null;
let lastCull = -1;

const uGoudaTime = { value: 0 };

// --- Seeded RNG (mulberry32) -------------------------------------------------

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

// --- SDF primitives ----------------------------------------------------------

function fbm3(x, y, z) {
  return (
    noise.noise(x, y, z) +
    0.5 * noise.noise(x * 2.13 + 7.7, y * 2.13 + 3.1, z * 2.13 + 11.6)
  );
}

// Smooth max(a, -b): subtraction with a rounded seam of width k.
function smoothCut(d, cut, k) {
  const b = -cut;
  const h = Math.max(k - Math.abs(d - b), 0) / k;
  return Math.max(d, b) + h * h * k * 0.25;
}

// Smooth max(a, b): intersection with a small bevel (for plane cuts).
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

// The chunk SDF in LOCAL grid space [-1,1]. Used verbatim for both meshing
// and collision — keep them in lockstep.
function chunkSdf(c, x, y, z) {
  // Squashed base form.
  const ex = x * c.ix,
    ey = y * c.iy,
    ez = z * c.iz;
  let d = (Math.sqrt(ex * ex + ey * ey + ez * ez) - R0) * c.minAxis;

  // Crust noise, faded away from the base surface. Applied BEFORE the plane
  // cuts so the cut faces stay flat (fresh-cut cheese), and kept low so the
  // round sides read waxy, not rocky.
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

  // Flat cuts: slabs and wedges (blocks only; wheels have none).
  const planes = c.planes;
  for (let i = 0; i < planes.length; i++) {
    const pl = planes[i];
    d = smoothMax(d, x * pl.nx + y * pl.ny + z * pl.nz - pl.off, PLANE_K);
  }

  if (d > CARVE_SKIP) return d; // far outside: nothing to carve

  // Eyes, chambers and pores — perfect spheres, soft rims.
  const holes = c.holes;
  for (let i = 0; i < holes.length; i++) {
    const h = holes[i];
    const dx = x - h.x,
      dy = y - h.y,
      dz = z - h.z;
    d = smoothCut(d, Math.sqrt(dx * dx + dy * dy + dz * dz) - h.r, SMOOTH_K);
    // Deep inside a cavern the exact value no longer matters for the mesh
    // (no surface crossing) — bail out early, this is the hot loop.
    if (d > 0.45) return d;
  }

  // Winding tunnels.
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

  return d;
}

// --- Chunk data generation -----------------------------------------------------

const _dir = new THREE.Vector3();
const _dir2 = new THREE.Vector3();

// A tunnel from a to b as a bent polyline. bends=0: straight bore;
// bends=1: winding maze tunnel; bends=2+: long snaking speleology passage.
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

// opts:
//  kind: "wheel" | "hunk" | "block"
//  eyesMin/eyesMax, eyeRBase/eyeRVar, exits, coreEye
//  deadEnds: sealed chambers with thin marked walls
//  axis: radial through-route (bulwark)
function makeChunkData(rng, center, s, res, opts) {
  const cell = 2 / res;
  // narrow (warrens): allow tunnels near the grid limit — occasional pinch
  // points and squeezes are the point (speleology).
  const minTunnelR = (opts.narrow ? 2.2 : 2.6) * cell;
  const tunnelScale = [1.15, 1.0, 0.85][difficulty - 1] ?? 1.0;
  const tr = (base) => Math.max(minTunnelR, base * tunnelScale);
  // Straight bores for blocks, winding for wheels/hunks, long snaking
  // passages for the warrens.
  const bends = opts.narrow ? 2 : opts.kind !== "block" ? 1 : 0;

  // Base proportions: wheels are flattened rounds; hunks stay chunky;
  // blocks start chunky and get their identity from the plane cuts.
  let sx, sy, sz;
  if (opts.kind === "wheel") {
    sx = 0.95 + rng() * 0.2;
    sy = 0.5 + rng() * 0.2;
    sz = 0.95 + rng() * 0.2;
  } else {
    sx = 0.85 + rng() * 0.35;
    sy = 0.85 + rng() * 0.35;
    sz = 0.85 + rng() * 0.35;
  }

  const c = {
    center,
    s,
    ix: 1 / sx,
    iy: 1 / sy,
    iz: 1 / sz,
    minAxis: Math.min(sx, sy, sz),
    nOff: rng() * 100,
    amp: opts.kind === "block" ? 0.05 : 0.1, // blocks: crisp; wheels: waxy
    planes: [],
    holes: [],
    tunnels: [],
  };

  // Plane cuts for blocks: a parallel pair (slab thickness) + angled cuts.
  if (opts.kind === "block") {
    randDir(rng, _dir);
    const half = 0.22 + rng() * 0.14; // slab half-thickness
    c.planes.push({ nx: _dir.x, ny: _dir.y, nz: _dir.z, off: half });
    c.planes.push({ nx: -_dir.x, ny: -_dir.y, nz: -_dir.z, off: half });
    const nCuts = 1 + Math.floor(rng() * 3);
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

  // The heart's guaranteed grand cavern — where the gold lives.
  if (opts.coreEye) {
    const core = { x: 0, y: 0, z: 0, r: opts.coreEye };
    eyes.push(core);
    c.holes.push(core);
  }

  // Interior eyes: caverns and chambers.
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

  // Round surface pores — the gouda skin. Placed through the crust so many
  // read as clean circular holes; on thin slabs they punch right through.
  const nPores = 10 + Math.floor(rng() * 9);
  for (let i = 0; i < nPores; i++) {
    randDir(rng, _dir);
    const t = R0 * (0.85 + 0.3 * rng());
    c.holes.push({
      x: _dir.x * t * sx,
      y: _dir.y * t * sy,
      z: _dir.z * t * sz,
      r: Math.max(3.2 * cell * 0.5, 0.055 + 0.075 * rng()),
    });
  }

  // Spanning tree: every eye reachable from eye 0. Occasionally attach to
  // the SECOND-nearest instead — longer, more winding routes.
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
    // tangle (warrens): often attach to a RANDOM earlier chamber instead of
    // the nearest — long intertwined passages that cross each other, easy to
    // descend into, hard to retrace.
    const j = opts.tangle
      ? i > 1 && rng() < 0.5
        ? Math.floor(rng() * i)
        : best
      : i > 2 && rng() < 0.3
        ? second
        : best;
    addTunnel(
      c,
      rng,
      eyes[i],
      eyes[j],
      tr(opts.narrow ? 0.038 + 0.022 * rng() : 0.055 + 0.04 * rng()),
      bends,
    );
  }
  // Extra loops: multiple paths through the maze.
  const loops = 2 + Math.floor(eyes.length / 6);
  for (let i = 0; i < loops; i++) {
    const a = eyes[Math.floor(rng() * eyes.length)];
    const b = eyes[Math.floor(rng() * eyes.length)];
    if (a === b) continue;
    addTunnel(
      c,
      rng,
      a,
      b,
      tr(opts.narrow ? 0.035 + 0.02 * rng() : 0.05 + 0.035 * rng()),
      bends,
    );
  }

  // Exit tunnels from the outermost eyes to open water.
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
      false, // exits bore straight so the mouth is easy to read
    );
  }

  // Radial through-route (bulwark): guaranteed wide exits on BOTH faces.
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
        false,
      );
    }
  }

  // Dead-end branches with SEALED thin walls (future explosives).
  // A side tunnel leads to a chamber placed deliberately close to another
  // cavern — separated by a wall just ~1–3 m thick. The wall's midpoint is
  // recorded as a blast point and marked in-world.
  const nDead = (opts.deadEnds ?? 0) + (difficulty - 1);
  for (let k = 0; k < nDead && eyes.length >= 2; k++) {
    const start = eyes[Math.floor(rng() * eyes.length)];
    let target = eyes[Math.floor(rng() * eyes.length)];
    if (target === start) target = eyes[(eyes.indexOf(target) + 1) % eyes.length];
    // Chamber sits off the target cavern, wall thickness ~0.05 local.
    randDir(rng, _dir);
    const chR = 0.06 + 0.05 * rng();
    const wall = 0.045 + 0.02 * rng();
    const ch = {
      x: target.x + _dir.x * (target.r + chR + wall),
      y: target.y + _dir.y * (target.r + chR + wall),
      z: target.z + _dir.z * (target.r + chR + wall),
      r: chR,
    };
    // Keep the chamber inside the crust.
    const el = Math.sqrt(
      (ch.x / sx) ** 2 + (ch.y / sy) ** 2 + (ch.z / sz) ** 2,
    );
    if (el > R0 - chR * 0.8) continue;
    c.holes.push(ch);
    addTunnel(c, rng, start, ch, tr(0.045 + 0.03 * rng()), bends);
    // Blast point: middle of the thin wall, in world space.
    const bx = target.x + _dir.x * (target.r + wall / 2);
    const by = target.y + _dir.y * (target.r + wall / 2);
    const bz = target.z + _dir.z * (target.r + wall / 2);
    blastPoints.push({
      x: center.x + bx * s,
      y: center.y + by * s,
      z: center.z + bz * s,
    });
  }

  return c;
}

// --- Meshing --------------------------------------------------------------------

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

  mc.update();
  const count = mc.count;
  if (count / 3 > (MAX_POLYS[res] ?? 100000)) {
    console.warn("gouda: chunk exceeded poly budget, geometry truncated");
  }

  const positions = mc.geometry.attributes.position.array.slice(0, count * 3);
  const normals = mc.geometry.attributes.normal.array.slice(0, count * 3);

  // Sanitize normals: zero-length ones become NaN in GLSL and smear through
  // the bloom pass as black rectangles.
  for (let i = 0; i < normals.length; i += 3) {
    const nx = normals[i],
      ny = normals[i + 1],
      nz = normals[i + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-6) {
      normals[i] = nx / len;
      normals[i + 1] = ny / len;
      normals[i + 2] = nz / len;
    } else {
      normals[i] = 0;
      normals[i + 1] = 1;
      normals[i + 2] = 0;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(c.center);
  mesh.scale.setScalar(c.s);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// --- Biome materials: waxy cheese, per-zone bioluminescence ----------------------

// One MeshStandardMaterial per zone; each gets its own vein colour/strength
// so descending through the layers visibly changes the world's glow.
function createGoudaMaterial({ color, rough, vein, veinStrength }) {
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: rough,
    metalness: 0.0,
  });

  const veinVec = `vec3(${vein[0].toFixed(3)}, ${vein[1].toFixed(3)}, ${vein[2].toFixed(3)})`;
  const vs = veinStrength.toFixed(3);

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGoudaTime = uGoudaTime;

    shader.vertexShader =
      "varying vec3 vGoudaWorld;\nvarying vec3 vGoudaNormal;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vGoudaWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vGoudaNormal = mat3(modelMatrix) * objectNormal;`,
      );

    shader.fragmentShader =
      "uniform float uGoudaTime;\nvarying vec3 vGoudaWorld;\nvarying vec3 vGoudaNormal;\n" +
      shader.fragmentShader.replace(
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
          // Guarded: pow(x<0) and normalize(0) are NaN ⇒ black bloom rectangles.
          vec3 gn = normalize(vGoudaNormal + vec3(1e-5));
          float rim = pow(clamp(1.0 - abs(dot(gn, gv)), 0.0, 1.0), 2.2);
          totalEmissiveRadiance += ${veinVec} * patches * (0.25 + 0.75 * pulse) * ${vs};
          totalEmissiveRadiance += vec3(0.95, 0.62, 0.16) * rim * (0.05 + 0.06 * pulse);
        }`,
      );
  };

  return material;
}

function createZoneMaterials() {
  // All-yellow family — recognizably gouda everywhere; only the VEIN glow
  // shifts with depth to mark the biomes.
  return {
    // pale aged rind, faint warm shimmer
    drift: createGoudaMaterial({
      color: 0xd6bc55,
      rough: 0.58,
      vein: [0.55, 0.52, 0.2],
      veinStrength: 0.4,
    }),
    // bright young gouda, yellow-green glow
    scree: createGoudaMaterial({
      color: 0xdcaa2e,
      rough: 0.52,
      vein: [0.6, 0.62, 0.12],
      veinStrength: 0.5,
    }),
    // the warrens: sickly green-gold — something lives in these
    warrens: createGoudaMaterial({
      color: 0xd9a52c,
      rough: 0.5,
      vein: [0.5, 0.72, 0.12],
      veinStrength: 0.55,
    }),
    // amber, strong — the wall is alive
    bulwark: createGoudaMaterial({
      color: 0xdda434,
      rough: 0.48,
      vein: [0.95, 0.62, 0.12],
      veinStrength: 0.6,
    }),
    // deep red pulse — too close to the heart
    hollows: createGoudaMaterial({
      color: 0xcc9226,
      rough: 0.45,
      vein: [0.95, 0.28, 0.08],
      veinStrength: 0.65,
    }),
    // gold
    heart: createGoudaMaterial({
      color: 0xdda838,
      rough: 0.4,
      vein: [1.0, 0.8, 0.22],
      veinStrength: 0.85,
    }),
  };
}

// --- Gold core, boundary sphere, blast markers ------------------------------------

function createGoldCore(parent, rng) {
  const group = new THREE.Group();
  group.position.set(HEART_POS.x, HEART_POS.y, HEART_POS.z);

  const goldMat = new THREE.MeshStandardMaterial({
    color: 0xffc23d,
    emissive: 0xffb020,
    emissiveIntensity: 2.4,
    roughness: 0.3,
    metalness: 0.6,
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

  // Cavern light + a huge soft "the gold is that way" glow that warms the
  // inner layers and strengthens as you descend.
  const light = new THREE.PointLight(0xffb742, 900, 90, 1.8);
  group.add(light);
  const deepGlow = new THREE.PointLight(0xff9c33, 26, 290, 1.15);
  group.add(deepGlow);

  parent.add(group);
  goldCore = { group, core, light, deepGlow, shards };
}

// A barely-there fresnel shell marking the map's edge: from inside it reads
// as a faint curtain of deeper water — the boundary of the playable ball.
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
  // Radial glow with crack spokes.
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

// --- Per-frame updates -------------------------------------------------------------

// visibility: current fog visibility in world units (drives culling).
export function updateGouda(elapsed, cameraPos = null, visibility = 90) {
  uGoudaTime.value = elapsed;

  if (goldCore) {
    const pulse = 0.75 + 0.25 * Math.sin(elapsed * 0.8);
    goldCore.light.intensity = 900 * pulse;
    goldCore.deepGlow.intensity = 26 * (0.85 + 0.15 * Math.sin(elapsed * 0.31));
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

  // Fog-aware distance culling (throttled). In clear outer water you can see
  // the whole ball; in the deep murk almost everything can be skipped.
  if (cameraPos && worldGroup && elapsed - lastCull > 0.25) {
    lastCull = elapsed;
    const cullDist = Math.min(Math.max(visibility * 1.25, 80), 520);
    for (const child of worldGroup.children) {
      const reach = child.scale.x * 1.4;
      child.visible = child.position.distanceTo(cameraPos) - reach < cullDist;
    }
  }
}

// --- World assembly -------------------------------------------------------------------

function placeChunks(rng) {
  const specs = [
    {
      center: new THREE.Vector3(0, 0, 0),
      s: HEART_S,
      res: HEART_RES,
      label: "the heart",
      zone: "heart",
      opts: {
        kind: "hunk",
        eyesMin: 18,
        eyesMax: 24,
        eyeRBase: 0.1,
        eyeRVar: 0.17,
        exits: 6,
        coreEye: 0.32,
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

  const hollowOpts = {
    kind: "wheel",
    eyesMin: 9,
    eyesMax: 14,
    eyeRBase: 0.11,
    eyeRVar: 0.14,
    exits: 4,
    deadEnds: 1,
  };
  // "hunk", not "wheel": flattened wheels leave lens-shaped gaps between
  // shell neighbours and the wall stops being a wall (measured: seal drops
  // from ~93% to ~72%). The showcase flattened wheels live in the hollows.
  const bulwarkOpts = {
    kind: "hunk",
    eyesMin: 14,
    eyesMax: 20,
    eyeRBase: 0.1,
    eyeRVar: 0.16,
    exits: 3,
    deadEnds: 1,
  };
  const smallOpts = {
    kind: "block",
    eyesMin: 2,
    eyesMax: 4,
    eyeRBase: 0.09,
    eyeRVar: 0.09,
    exits: 2,
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
  };

  // THE HOLLOWS: cavernous wheels — some properly big.
  for (let i = 0; i < HOLLOW_COUNT; i++)
    tryBand("hollows", 60, 90, 18 + rng() * 14, RES_MED, "the hollows", hollowOpts, 0.5);

  // THE CRUST WALL: many giant hunks on a dense fibonacci shell. Spaced so
  // neighbouring crusts fuse hard — with 40 wheels the spacing (~67) is well
  // under the combined reach (~100): effectively no way around, only through
  // the radial tunnel routes. Every 13th piece is EXTRA colossal.
  const bulwarkN = BULWARK_N + (difficulty - 1) * 4;
  const GOLDEN = 2.399963229728653;
  for (let i = 0; i < bulwarkN; i++) {
    const y = 1 - (2 * (i + 0.5)) / bulwarkN;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = i * GOLDEN;
    const axis = new THREE.Vector3(
      Math.cos(th) * r + (rng() - 0.5) * 0.08,
      y + (rng() - 0.5) * 0.08,
      Math.sin(th) * r + (rng() - 0.5) * 0.08,
    ).normalize();
    const rad = BULWARK_R + (rng() - 0.5) * 4;
    const colossal = i % 13 === 0;
    specs.push({
      center: axis.clone().multiplyScalar(rad),
      s: colossal ? 76 + rng() * 10 : 57 + rng() * 11,
      res: colossal ? RES_BULWARK : 56,
      label: colossal ? "a colossal wheel" : "the crust wall",
      zone: "bulwark",
      opts: { ...bulwarkOpts, axis: { x: axis.x, y: axis.y, z: axis.z } },
    });
  }

  // THE WARRENS: speleology chunks nestled against the crust's outer face,
  // plugging gaps — long tangled narrow tunnels you sink into.
  for (let i = 0; i < WARREN_COUNT; i++)
    tryBand("warrens", 150, 172, 28 + rng() * 8, RES_BULWARK, "the warrens", warrenOpts, 0.55);

  // THE SCREE: small cut blocks littered over the crust's surface.
  for (let i = 0; i < SCREE_COUNT; i++)
    tryBand("scree", 155, 188, 10 + rng() * 6, RES_SMALL, "the scree", smallOpts, 0.65);

  // THE DRIFT: sparse pale blocks at the very edge.
  for (let i = 0; i < DRIFT_COUNT; i++)
    tryBand("drift", 192, WORLD_R, 10 + rng() * 7, RES_SMALL, "the drift", smallOpts, 1.3);

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

// Builds the world asynchronously. opts: { seed, difficulty }.
// onProgress(done, total, label).
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
    chunks.push(chunk);
    const mesh = meshChunk(chunk, spec.res, materials[spec.zone]);
    triangles += mesh.geometry.attributes.position.count / 3;
    group.add(mesh);
    onProgress(i + 1, total, spec.label);
    await nextTick();
  }

  for (const mc of mcCache.values()) mc.geometry.dispose();
  mcCache.clear();

  // Crumbs hug the wheels, littering swim lanes and tunnel mouths.
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
      debris.push({ center: p, r: s * 0.8 });
      break;
    }
  }

  scene.add(group);
  createGoldCore(extrasGroup, rng);
  createBoundarySphere(extrasGroup);
  createBlastMarkers(extrasGroup);
  scene.add(extrasGroup);

  // Spawn at the drift's edge with the whole glowing ball in view.
  const p = new THREE.Vector3(0, 14, WORLD_R + 18);
  while (worldDistance(p.x, p.y, p.z) < 6 && p.z < BOUNDARY_R - 4) p.z += 3;
  spawnPoint = p;

  onProgress(total, total, "gold");
  console.log(
    `gouda: seed ${worldSeed} d${difficulty} — ${chunks.length} wheels, ` +
      `${debris.length} crumbs, ${blastPoints.length} blast walls, ` +
      `${Math.round(triangles / 1000)}k tris in ${Math.round(performance.now() - t0)}ms`,
  );
  return group;
}

// Tears the world down so a new seed can be built (e.g. joining a host whose
// seed differs from ours).
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
  markerMaterial = null;
  chunks.length = 0;
  debris.length = 0;
  blastPoints.length = 0;
  spawnPoint = null;
}

export function getWorldSeed() {
  return worldSeed;
}

export function getBlastPoints() {
  return blastPoints;
}

// --- Runtime queries: collision + open-water sampling ----------------------------

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
  return spawnPoint ?? { x: 0, y: 14, z: WORLD_R + 18 };
}
