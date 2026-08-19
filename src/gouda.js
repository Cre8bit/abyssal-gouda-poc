// gouda.js — the procedural abyssal gouda labyrinth.
//
// Each chunk is an ANALYTIC SDF: a noise-crusted ellipsoid ("the wheel")
// minus a connected system of hole-spheres and tunnel-capsules. The holes
// are linked by a spanning tree of tunnels, plus explicit exit tunnels
// punched out to the surface — so every cavity is guaranteed reachable
// from open water. The same SDF is used twice:
//   1. meshed once at load with marching cubes (three's addon),
//   2. sampled at runtime for swim collision (push-out along the gradient).
//
// The map is built around THE HEART: a colossal central wheel whose core
// cavern holds the gouda gold. The only way to it is through the tunnels.
//
// Generation is seeded (WORLD_SEED), so every peer builds the exact same
// maze with zero network traffic. It runs async, one chunk per tick, so a
// loading screen can track progress.

import * as THREE from "three";
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";

export const WORLD_SEED = 1337;
export const WORLD_R = 210; // outer edge of the drift (world units)
export const HEART_POS = { x: 0, y: 0, z: 0 }; // the gouda gold

// --- Concentric zones, outside → in. Descending should feel like sinking
// deeper into one organism:
//   the drift   (195–220)  lone pale chunks, the first silhouettes
//   the scree   (150–190)  dense field of small swiss-cheese pebbles
//   the bulwark (~120)     near-sealed shell of giant fused wheels — the
//                          only honest way past is THROUGH their tunnels
//   the hollows (60–84)    cavernous mid wheels, big glowing chambers
//   the heart   (0)        colossal wheel, gold core in its central cavern
const HEART_S = 62;
const HEART_RES = 96;
const BULWARK_N = 34; // wheels on the fibonacci shell (34 ⇒ corner pockets between neighbours stay covered)
const BULWARK_R = 120; // shell radius
const HOLLOW_COUNT = 12;
const SCREE_COUNT = 34;
const DRIFT_COUNT = 7;
const DEBRIS_COUNT = 300; // drifting crumbs, littered around the wheels

const RES_BIG = 72;
const RES_BULWARK = 64; // giant wheels: coarser grid, same world-size tunnels
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

const CULL_DIST = 140; // hide meshes past this (fog is opaque long before)

// Local-space (unit-sphere) shape parameters. The chunk surface sits
// around |p| = R0, the grid spans [-1, 1].
const R0 = 0.6;
const NOISE_AMP = 0.2; // crust displacement (attenuated by the shell fade)
const NOISE_FREQ = 2.3;
const SHELL = 0.3; // only evaluate crust noise this close to the surface
const CARVE_SKIP = 0.3; // skip hole/tunnel carving when this far outside
const SMOOTH_K = 0.035; // smooth-subtraction radius (organic rims)

const noise = new ImprovedNoise();

const chunks = []; // { center, s, holes, tunnels, ix/iy/iz, minAxis, nOff }
const debris = []; // { center, r } collision spheres
let worldGroup = null;
let goldCore = null; // { group, core, light, shards }
let spawnPoint = null;
let lastCull = -1;

// Shared shader time for the bioluminescent pulse.
const uGoudaTime = { value: 0 };

// --- Seeded RNG (mulberry32): identical world on every client ------------

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

// --- SDF primitives -------------------------------------------------------

function fbm3(x, y, z) {
  return (
    noise.noise(x, y, z) +
    0.5 * noise.noise(x * 2.13 + 7.7, y * 2.13 + 3.1, z * 2.13 + 11.6) +
    0.25 * noise.noise(x * 4.61 + 19.3, y * 4.61 + 5.2, z * 4.61 + 2.8)
  );
}

// Smooth max(a, -b): subtraction with a rounded seam.
function smoothCut(d, cut, k) {
  const b = -cut;
  const h = Math.max(k - Math.abs(d - b), 0) / k;
  return Math.max(d, b) + h * h * k * 0.25;
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

// The chunk SDF in LOCAL space (grid space, [-1, 1]).
// Used verbatim for both meshing and collision — keep them in lockstep.
function chunkSdf(c, x, y, z) {
  // Squashed base wheel.
  const ex = x * c.ix,
    ey = y * c.iy,
    ez = z * c.iz;
  let d = (Math.sqrt(ex * ex + ey * ey + ez * ez) - R0) * c.minAxis;

  // Crust noise, faded away from the surface so deep voxels stay cheap.
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
      NOISE_AMP *
      fade;
  }

  if (d > CARVE_SKIP) return d; // far outside: nothing to carve

  // Holes (gouda eyes + surface pores).
  const holes = c.holes;
  for (let i = 0; i < holes.length; i++) {
    const h = holes[i];
    const dx = x - h.x,
      dy = y - h.y,
      dz = z - h.z;
    d = smoothCut(d, Math.sqrt(dx * dx + dy * dy + dz * dz) - h.r, SMOOTH_K);
  }

  // Tunnels (capsules linking the holes + exits to open water).
  const tunnels = c.tunnels;
  for (let i = 0; i < tunnels.length; i++) {
    const t = tunnels[i];
    d = smoothCut(
      d,
      segDist(x, y, z, t.ax, t.ay, t.az, t.bx, t.by, t.bz) - t.r,
      SMOOTH_K,
    );
  }

  return d;
}

// --- Chunk data generation -------------------------------------------------

const _dir = new THREE.Vector3();

// opts: { eyesMin, eyesMax, eyeRBase, eyeRVar, exits, coreEye }
function makeChunkData(rng, center, s, res, opts) {
  const cell = 2 / res;
  const minTunnelR = 2.6 * cell; // never thinner than the grid can resolve

  // Per-axis squash for irregular wheels.
  const sx = 0.8 + rng() * 0.45;
  const sy = 0.8 + rng() * 0.45;
  const sz = 0.8 + rng() * 0.45;

  const c = {
    center,
    s,
    ix: 1 / sx,
    iy: 1 / sy,
    iz: 1 / sz,
    minAxis: Math.min(sx, sy, sz),
    nOff: rng() * 100,
    holes: [],
    tunnels: [],
  };

  const eyes = [];

  // The heart wheel gets a guaranteed grand cavern dead center —
  // that's where the gouda gold lives.
  if (opts.coreEye) {
    const core = { x: 0, y: 0, z: 0, r: opts.coreEye };
    eyes.push(core);
    c.holes.push(core);
  }

  // Interior eyes: the caverns.
  const nEyes =
    opts.eyesMin + Math.floor(rng() * (opts.eyesMax - opts.eyesMin + 1));
  for (let i = 0; i < nEyes; i++) {
    randDir(rng, _dir);
    const t = R0 * (0.12 + 0.58 * rng());
    const x = _dir.x * t * sx,
      y = _dir.y * t * sy,
      z = _dir.z * t * sz;
    const centerBias = 1.25 - (t / R0) * 0.55; // bigger caverns deeper in
    const r = (opts.eyeRBase + opts.eyeRVar * rng()) * centerBias;
    const eye = { x, y, z, r };
    eyes.push(eye);
    c.holes.push(eye);
  }

  // Cosmetic surface pores (classic gouda skin).
  const nPores = 9 + Math.floor(rng() * 8);
  for (let i = 0; i < nPores; i++) {
    randDir(rng, _dir);
    const t = R0 * (0.92 + 0.22 * rng());
    c.holes.push({
      x: _dir.x * t * sx,
      y: _dir.y * t * sy,
      z: _dir.z * t * sz,
      r: 0.05 + 0.06 * rng(),
    });
  }

  // Spanning tree of tunnels: every eye reachable from eye 0.
  for (let i = 1; i < eyes.length; i++) {
    let best = 0,
      bestD = Infinity;
    for (let j = 0; j < i; j++) {
      const dx = eyes[i].x - eyes[j].x,
        dy = eyes[i].y - eyes[j].y,
        dz = eyes[i].z - eyes[j].z;
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd < bestD) {
        bestD = dd;
        best = j;
      }
    }
    c.tunnels.push({
      ax: eyes[i].x,
      ay: eyes[i].y,
      az: eyes[i].z,
      bx: eyes[best].x,
      by: eyes[best].y,
      bz: eyes[best].z,
      r: Math.max(minTunnelR, 0.06 + 0.045 * rng()),
    });
  }
  // A few extra loops so the maze isn't a pure tree.
  const loops = 2 + Math.floor(eyes.length / 8);
  for (let i = 0; i < loops; i++) {
    const a = eyes[Math.floor(rng() * eyes.length)];
    const b = eyes[Math.floor(rng() * eyes.length)];
    if (a === b) continue;
    c.tunnels.push({
      ax: a.x,
      ay: a.y,
      az: a.z,
      bx: b.x,
      by: b.y,
      bz: b.z,
      r: Math.max(minTunnelR, 0.055 + 0.04 * rng()),
    });
  }

  // Exit tunnels: punch the outermost eyes out past the crust, so the
  // cavity system always opens to the sea. (This is what lets you swim in.)
  const sorted = [...eyes].sort(
    (a, b) =>
      b.x * b.x + b.y * b.y + b.z * b.z - (a.x * a.x + a.y * a.y + a.z * a.z),
  );
  const nExits = opts.exits + Math.floor(rng() * 2);
  for (let i = 0; i < Math.min(nExits, sorted.length); i++) {
    const e = sorted[i];
    const len = Math.sqrt(e.x * e.x + e.y * e.y + e.z * e.z) || 1;
    const out = (R0 + 0.24) / len;
    c.tunnels.push({
      ax: e.x,
      ay: e.y,
      az: e.z,
      bx: e.x * out,
      by: e.y * out,
      bz: e.z * out,
      r: Math.max(minTunnelR, 0.07 + 0.035 * rng()),
    });
  }

  // Through-route (bulwark wheels): guaranteed wide exits on BOTH radial
  // faces — outward toward the scree, inward toward the hollows — from the
  // eyes best aligned with each face. The wheel becomes a mandatory tunnel
  // complex: the honest way past the shell is through it.
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
      c.tunnels.push({
        ax: best.x,
        ay: best.y,
        az: best.z,
        bx: sign * a.x * (R0 + 0.28) * sx,
        by: sign * a.y * (R0 + 0.28) * sy,
        bz: sign * a.z * (R0 + 0.28) * sz,
        r: Math.max(minTunnelR, 0.09 + 0.03 * rng()),
      });
    }
  }

  return c;
}

// --- Meshing ---------------------------------------------------------------

const mcCache = new Map(); // res -> MarchingCubes (reused scratch instance)

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
  mc.reset(); // wipes field AND the normal cache — required between chunks
  mc.isolation = 0;

  const field = mc.field;
  const half = res / 2;
  let idx = 0;
  for (let zi = 0; zi < res; zi++) {
    const z = (zi - half) / half;
    for (let yi = 0; yi < res; yi++) {
      const y = (yi - half) / half;
      for (let xi = 0; xi < res; xi++) {
        // density = -distance: positive inside the cheese
        field[idx++] = -chunkSdf(c, (xi - half) / half, y, z);
      }
    }
  }

  mc.update();
  const count = mc.count; // vertices written this update
  if (count / 3 > (MAX_POLYS[res] ?? 100000)) {
    console.warn("gouda: chunk exceeded poly budget, geometry truncated");
  }

  const positions = mc.geometry.attributes.position.array.slice(0, count * 3);
  const normals = mc.geometry.attributes.normal.array.slice(0, count * 3);

  // Marching-cubes gradient normals can come out zero-length on flat field
  // plateaus. normalize(vec3(0)) is NaN in GLSL, and one NaN fragment smears
  // through the bloom pass as black rectangles — sanitize here, on the CPU.
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

// --- Material: waxy, faintly bioluminescent, slow pulse ---------------------

function createGoudaMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xc9962e, // waxy gouda
    roughness: 0.48,
    metalness: 0.0,
  });

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
          // Two scales of patchy "veins" living under the skin.
          float g1 = sin(gp.x * 0.21 + 1.3) * sin(gp.y * 0.19 + 3.1) * sin(gp.z * 0.23 + 5.2);
          float g2 = sin(gp.x * 0.083 + 2.1) * sin(gp.y * 0.077) * sin(gp.z * 0.09 + 4.0);
          float patches = smoothstep(0.12, 0.72, g1 * 0.5 + 0.5)
                        * smoothstep(0.25, 0.9, g2 * 0.5 + 0.5);
          // Slow uneven heartbeat, phase-shifted across the maze.
          float pulse = 0.5 + 0.5 * sin(uGoudaTime * 0.55 + g2 * 6.0);
          pulse *= 0.7 + 0.3 * sin(uGoudaTime * 0.173 + gp.y * 0.05);
          vec3 gv = normalize(cameraPosition - gp);
          // Fake SSS: waxy translucency at grazing angles.
          // NOTE: both the normalize guard and the clamp are load-bearing —
          // pow(x, 2.2) with x < 0 is NaN, and NaNs turn the bloom pass
          // into flickering black rectangles.
          vec3 gn = normalize(vGoudaNormal + vec3(1e-5));
          float rim = pow(clamp(1.0 - abs(dot(gn, gv)), 0.0, 1.0), 2.2);
          totalEmissiveRadiance += vec3(0.42, 0.60, 0.10) * patches * (0.25 + 0.75 * pulse) * 0.5;
          totalEmissiveRadiance += vec3(0.95, 0.62, 0.16) * rim * (0.05 + 0.06 * pulse);
        }`,
      );
  };

  return material;
}

// --- The gouda gold: pulsing golden core in the heart cavern -----------------

function createGoldCore(scene, rng) {
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

  // Orbiting shards — loot that broke off the core.
  const shardGeo = new THREE.IcosahedronGeometry(0.7, 0);
  const shards = [];
  for (let i = 0; i < 12; i++) {
    const shard = new THREE.Mesh(shardGeo, goldMat);
    shards.push({
      mesh: shard,
      radius: 6.5 + rng() * 4,
      speed: 0.15 + rng() * 0.3,
      phase: rng() * Math.PI * 2,
      tilt: rng() * Math.PI,
      scale: 0.5 + rng() * 1.2,
    });
    shard.scale.setScalar(shards[shards.length - 1].scale);
    group.add(shard);
  }

  // The glow that leaks out of the tunnel mouths as you get close.
  const light = new THREE.PointLight(0xffb742, 900, 90, 1.8);
  group.add(light);

  scene.add(group);
  goldCore = { group, core, light, shards };
}

// Per-frame: pulse time, gold animation, distance culling.
export function updateGouda(elapsed, cameraPos = null) {
  uGoudaTime.value = elapsed;

  if (goldCore) {
    const pulse = 0.75 + 0.25 * Math.sin(elapsed * 0.8);
    goldCore.light.intensity = 900 * pulse;
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

  // Distance culling (throttled): the fog is opaque way before CULL_DIST,
  // so far meshes are pure vertex-stage waste. Frustum culling still applies.
  if (cameraPos && worldGroup && elapsed - lastCull > 0.25) {
    lastCull = elapsed;
    for (const child of worldGroup.children) {
      const reach = child.scale.x * 1.4;
      child.visible =
        child.position.distanceTo(cameraPos) - reach < CULL_DIST;
    }
  }
}

// --- World assembly ----------------------------------------------------------

function placeChunks(rng) {
  // The heart sits dead center; the zones ring it, outside → in.
  const specs = [
    {
      center: new THREE.Vector3(0, 0, 0),
      s: HEART_S,
      res: HEART_RES,
      label: "the heart",
      zone: "heart",
      opts: { eyesMin: 18, eyesMax: 24, eyeRBase: 0.1, eyeRVar: 0.17, exits: 6, coreEye: 0.32 },
    },
  ];

  // Band placement: random direction on the full sphere (it's a ball map),
  // radius inside the zone's band. Overlap is only guarded against the heart
  // and against wheels of the SAME zone — cross-zone fusing is welcome, it
  // welds the shells into continuous tunnel complexes. Heart reachability is
  // re-verified by the flood-fill smoke test (seeded ⇒ a pass is a guarantee).
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

  const hollowOpts = { eyesMin: 9, eyesMax: 14, eyeRBase: 0.1, eyeRVar: 0.13, exits: 4 };
  const bulwarkOpts = { eyesMin: 14, eyesMax: 20, eyeRBase: 0.1, eyeRVar: 0.16, exits: 3 };
  const smallOpts = { eyesMin: 4, eyesMax: 7, eyeRBase: 0.09, eyeRVar: 0.1, exits: 2 };

  // THE HOLLOWS: cavernous mid wheels between heart crust and bulwark.
  for (let i = 0; i < HOLLOW_COUNT; i++)
    tryBand("hollows", 60, 84, 14 + rng() * 8, RES_MED, "the hollows", hollowOpts, 0.55);

  // THE BULWARK: giant wheels on a fibonacci shell, spaced so neighbouring
  // crusts merge — a wall of cheese with almost no open water through it.
  // Each wheel gets guaranteed radial through-tunnels (opts.axis).
  const GOLDEN = 2.399963229728653;
  for (let i = 0; i < BULWARK_N; i++) {
    const y = 1 - (2 * (i + 0.5)) / BULWARK_N;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = i * GOLDEN;
    const axis = new THREE.Vector3(
      Math.cos(th) * r + (rng() - 0.5) * 0.08,
      y + (rng() - 0.5) * 0.08,
      Math.sin(th) * r + (rng() - 0.5) * 0.08,
    ).normalize();
    const rad = BULWARK_R + (rng() - 0.5) * 4;
    specs.push({
      center: axis.clone().multiplyScalar(rad),
      s: 57 + rng() * 11,
      res: RES_BULWARK,
      label: "the bulwark",
      zone: "bulwark",
      opts: { ...bulwarkOpts, axis: { x: axis.x, y: axis.y, z: axis.z } },
    });
  }

  // THE SCREE: a dense belt of small swiss-cheese pebbles to weave through.
  for (let i = 0; i < SCREE_COUNT; i++)
    tryBand("scree", 150, 190, 8 + rng() * 6, RES_SMALL, "the scree", smallOpts, 0.7);

  // THE DRIFT: sparse lone chunks at the edge — the first shapes in the fog.
  for (let i = 0; i < DRIFT_COUNT; i++)
    tryBand("drift", 193, WORLD_R + 8, 9 + rng() * 6, RES_SMALL, "the drift", smallOpts, 1.3);

  return specs;
}

function makeDebrisGeometry(rng) {
  const geo = new THREE.IcosahedronGeometry(1, 3);
  const pos = geo.attributes.position;
  const off = rng() * 50;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = fbm3(v.x * 1.6 + off, v.y * 1.6 + off * 2.1, v.z * 1.6 + off * 0.7);
    v.multiplyScalar(1 + 0.32 * n);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Builds everything asynchronously (one chunk per tick, so the loader can
// paint). onProgress(done, total, label). Returns the world group.
export async function buildGoudaWorld(scene, onProgress = () => {}) {
  const t0 = performance.now();
  const rng = mulberry32(WORLD_SEED);
  const material = createGoudaMaterial();
  const group = new THREE.Group();
  worldGroup = group;

  const specs = placeChunks(rng);
  const total = specs.length + 1; // +1 for the debris/finishing step
  let triangles = 0;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const chunk = makeChunkData(rng, spec.center, spec.s, spec.res, spec.opts);
    chunks.push(chunk);
    const mesh = meshChunk(chunk, spec.res, material);
    triangles += mesh.geometry.attributes.position.count / 3;
    group.add(mesh);
    onProgress(i + 1, total, spec.label);
    await nextTick(); // let the loading bar paint
  }

  // Free the marching-cubes scratch buffers (tens of MB).
  for (const mc of mcCache.values()) mc.geometry.dispose();
  mcCache.clear();

  // Drifting crumbs fill the space between wheels.
  const crumbGeos = [
    makeDebrisGeometry(rng),
    makeDebrisGeometry(rng),
    makeDebrisGeometry(rng),
  ];
  // Crumbs hug the wheels: they fill the swim lanes and tunnel mouths, so
  // the space BETWEEN the masses feels cluttered too, not open water.
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
      if (worldDistance(p.x, p.y, p.z) < s + 1.2) continue; // inside a wheel
      const crumb = new THREE.Mesh(crumbGeos[i % 3], material);
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
  createGoldCore(scene, rng);

  // Deterministic spawn: at the drift's edge, swimming inward until the
  // first shapes are close — but never deeper than the scree's outer rim,
  // so the descent always starts from the outermost zone.
  const p = new THREE.Vector3(0, 5, WORLD_R + 40);
  while (worldDistance(p.x, p.y, p.z) > 22 && p.z > 192) p.z -= 2;
  while (worldDistance(p.x, p.y, p.z) < 4 && p.z < WORLD_R + 80) p.z += 2;
  spawnPoint = p;

  onProgress(total, total, "gold");
  console.log(
    `gouda: ${chunks.length} wheels, ${debris.length} crumbs, ` +
      `${Math.round(triangles / 1000)}k tris in ${Math.round(performance.now() - t0)}ms`,
  );
  return group;
}

// --- Runtime queries: collision + open-water sampling ------------------------

// Signed distance from a world-space point to the nearest cheese surface.
export function worldDistance(x, y, z) {
  let best = 1e9;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const dx = x - c.center.x,
      dy = y - c.center.y,
      dz = z - c.center.z;
    const dc = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dc - c.s > best) continue; // can't beat the current best
    if (dc > c.s * 1.4) {
      // outside the grid: the bare ellipsoid bound is accurate enough
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

// Keeps `pos` at least `radius` away from any cheese wall.
// Returns the push-out normal when a collision happened, else null.
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

// A random point in open water, optionally at [minD, maxD] from `near`.
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
  return spawnPoint ?? { x: 0, y: 5, z: WORLD_R + 30 };
}
