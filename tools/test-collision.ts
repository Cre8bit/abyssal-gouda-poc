#!/usr/bin/env node
// test-collision.ts — collision == render, the invariant
// docs/bug-collision-render-desync.md §1 restored by unifying the collision
// and dig predicates into chunkCovers(). Both checks run against a REAL node
// build (sync mesh path), so they exercise digAt/worldDistance and the chunk
// spatial hash themselves rather than re-stating their maths:
//
//   T1 — hash ⊇ coverage. At the outer edge of every chunk's authority
//        region (found by BISECTING chunkCovers, never by copying its box),
//        the module query must still see that chunk. A bucket that misses one
//        makes the world silently more open — and the chunk un-diggable.
//   T2 — dig, then swim. A driller bore centred on a point where a chunk is
//        solid and authoritative must leave that point open. Sampled in the
//        shell the old sphere-shaped dig predicate could not reach: every one
//        of those digs left an invisible wall before the fix.
//
// The world is built at res 32 (the predicates are resolution-independent and
// a full-res node build costs ~80 s); tile size grows the blind shell, so the
// coarse grid is the harsher case, not the softer one. Runs in npm test.
import * as THREE from "three";
import {
  buildGoudaWorld,
  buildWorldData,
  chunkCovers,
  chunkDistance,
  digAt,
  distanceToWorld,
  mulberry32,
  softSpotDigRadius,
  worldDistance,
  type Chunk,
} from "../src/world/gouda.ts";
import { WHEEL_WORLD, cloneWorld } from "../src/world/recipes.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`✓ ${name}`);
  } else {
    failures++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const SEED = 1337;
const RES = 32;
const DRILL_R = 2.4; // main.ts DIG_RADII.driller
const TOL = 0.05;
const OPEN = 8; // gouda.ts GRID_SAT — worldDistance saturates here

const t0 = Date.now();
const world = cloneWorld(WHEEL_WORLD);
for (const biome of world.biomes) biome.res = RES;
const data = buildWorldData({ seed: SEED, difficulty: 1, world });
await buildGoudaWorld(new THREE.Scene(), () => {}, {
  seed: SEED,
  difficulty: 1,
  world,
  workers: false,
});
check("world builds in node", data.chunks.length > 0);

// Farthest point from a chunk's centre along `dir` that the authority
// predicate still claims. Bisection keeps the test blind to the box's shape.
function coverageEdge(c: Chunk, dx: number, dy: number, dz: number): number {
  let lo = 0,
    hi = 4 * c.s + 16;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    if (
      chunkCovers(
        c,
        c.center.x + dx * m,
        c.center.y + dy * m,
        c.center.z + dz * m,
      )
    )
      lo = m;
    else hi = m;
  }
  return lo;
}

// A chunk the driller cannot open (hardness 3 seals, outside their soft
// spots) legitimately stays solid — digHardness's rule, read from outside.
function sealedAgainstDriller(
  c: Chunk,
  x: number,
  y: number,
  z: number,
): boolean {
  if (c.hardness <= 2) return false;
  for (const s of c.body?.softSpots ?? []) {
    const rr = softSpotDigRadius(s.r);
    const dx = x - s.x,
      dy = y - s.y,
      dz = z - s.z;
    if (dx * dx + dy * dy + dz * dz < rr * rr) return false;
  }
  return true;
}

// --- T1 — the spatial hash is a superset of the coverage predicate -------------

const AXES: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const DIAGS: [number, number, number][] = [];
for (const sx of [-1, 1])
  for (const sy of [-1, 1])
    for (const sz of [-1, 1])
      DIAGS.push([sx / Math.sqrt(3), sy / Math.sqrt(3), sz / Math.sqrt(3)]);
const T1_DIRS = [...AXES, ...DIAGS];

{
  let probes = 0,
    leaks = 0,
    worst = 0;
  let worstAt = "";
  for (const c of data.chunks) {
    for (const d of T1_DIRS) {
      const edge = coverageEdge(c, d[0], d[1], d[2]);
      for (const f of [0.5, 0.999]) {
        const m = edge * f;
        const x = c.center.x + d[0] * m,
          y = c.center.y + d[1] * m,
          z = c.center.z + d[2] * m;
        // Only points this chunk actually pulls below the saturation floor
        // can prove the bucket saw it.
        const cd = chunkDistance(c, x, y, z);
        if (cd >= OPEN) continue;
        probes++;
        const wd = worldDistance(x, y, z);
        if (wd > cd + 1e-6) {
          leaks++;
          if (wd - cd > worst) {
            worst = wd - cd;
            worstAt = `${c.zone} s${c.s} @ ${m.toFixed(1)} u`;
          }
        }
      }
    }
  }
  check(
    "T1: every chunk that covers a point is in that point's grid bucket",
    leaks === 0,
    `${leaks}/${probes} probes leaked, worst ${worst.toFixed(2)} u (${worstAt})`,
  );
  console.log(
    `  · ${probes} coverage-edge probes over ${data.chunks.length} chunks`,
  );
}

// --- T2 — dig, then swim -------------------------------------------------------

// The pre-fix dig predicate: a sphere, where the collider owns a box. Used
// ONLY to aim the sampler at the shell where the two disagreed.
const oldDigReach = (c: Chunk): number =>
  (c.body ? c.s * 1.74 : c.s * 1.35) + DRILL_R;

interface DigStats {
  digs: number;
  fails: number;
  notSolid: number;
  sealed: number;
  debris: number;
  zones: Map<string, number>;
}

// Dig a driller bore at p and assert p is open afterwards. Points a seal or a
// surviving crumb could legitimately hold are skipped, not asserted.
function digAndSwim(
  st: DigStats,
  c: Chunk,
  x: number,
  y: number,
  z: number,
): void {
  if (chunkDistance(c, x, y, z) >= 0) {
    st.notSolid++;
    return;
  }
  if (distanceToWorld([], data.debris, x, y, z) < DRILL_R + 0.5) {
    st.debris++;
    return;
  }
  for (const o of data.chunks)
    if (
      chunkCovers(o, x, y, z) &&
      sealedAgainstDriller(o, x, y, z) &&
      chunkDistance(o, x, y, z) < DRILL_R
    ) {
      st.sealed++;
      return;
    }
  digAt(x, y, z, DRILL_R, "driller");
  st.digs++;
  st.zones.set(c.zone ?? "?", (st.zones.get(c.zone ?? "?") ?? 0) + 1);
  if (worldDistance(x, y, z) < DRILL_R - TOL) st.fails++;
}

const fresh = (): DigStats => ({
  digs: 0,
  fails: 0,
  notSolid: 0,
  sealed: 0,
  debris: 0,
  zones: new Map(),
});
const report = (st: DigStats): string =>
  `${st.digs} digs [${[...st.zones].map(([k, v]) => `${k} ${v}`).join(", ")}]` +
  ` · skipped ${st.notSolid} open, ${st.sealed} sealed, ${st.debris} crumbed`;

const rng = mulberry32(9);

// T2a — the blind shell: covered by the chunk, out of the old sphere's reach.
{
  const st = fresh();
  for (const c of data.chunks) {
    const from = oldDigReach(c);
    for (let attempt = 0; attempt < 40; attempt++) {
      let dx = (rng() < 0.5 ? -1 : 1) * (0.75 + rng() * 0.25),
        dy = (rng() < 0.5 ? -1 : 1) * (0.75 + rng() * 0.25),
        dz = (rng() < 0.5 ? -1 : 1) * (0.75 + rng() * 0.25);
      const len = Math.hypot(dx, dy, dz);
      dx /= len;
      dy /= len;
      dz /= len;
      const edge = coverageEdge(c, dx, dy, dz);
      if (edge <= from + 0.02) continue;
      const m = from + 0.01 + rng() * (edge - from - 0.02);
      digAndSwim(
        st,
        c,
        c.center.x + dx * m,
        c.center.y + dy * m,
        c.center.z + dz * m,
      );
    }
  }
  check(
    "T2a: the sampler reaches the old predicate's blind shell",
    st.digs >= 20,
    `${st.digs} solid blind-shell points found`,
  );
  check(
    "T2a: a driller bore in the blind shell leaves the point open",
    st.fails === 0,
    `${st.fails}/${st.digs} still solid after the dig`,
  );
  console.log(`  · ${report(st)}`);
}

// T2b — anywhere in a chunk's authority region, every zone, rotating chunks
// included (their digs are stored chunk-local).
{
  const st = fresh();
  const order = data.chunks.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const i of order) {
    if (st.digs >= 60) break;
    const c = data.chunks[i];
    const ext = AXES.map((a) => coverageEdge(c, a[0], a[1], a[2]));
    for (let attempt = 0; attempt < 4 && st.digs < 60; attempt++) {
      const along = (k: number): number => {
        const neg = rng() < 0.5;
        return (neg ? -1 : 1) * ext[neg ? k * 2 + 1 : k * 2] * rng();
      };
      const x = c.center.x + along(0),
        y = c.center.y + along(1),
        z = c.center.z + along(2);
      if (!chunkCovers(c, x, y, z)) continue;
      digAndSwim(st, c, x, y, z);
    }
  }
  check(
    "T2b: a driller bore anywhere a chunk is authoritative leaves the point open",
    st.fails === 0,
    `${st.fails}/${st.digs} still solid after the dig`,
  );
  console.log(`  · ${report(st)}`);
}

console.log(
  `\ncollision/render checks in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
);
if (failures) {
  console.error(`${failures} collision check(s) failed.`);
  process.exit(1);
}
console.log("All collision checks passed.");
