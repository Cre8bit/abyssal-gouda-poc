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
//   T4 — no invisible cushion (§3-4). The field is NOT a metric, so comparing
//        it against a radius fattens the player. Truth is measured by
//        sphere-tracing 64 rays out of the probe, never from the field's own
//        maths: the largest clearance at which resolveCollision still pushes
//        was 1.58 u for a 0.6 u player before Fix C, 0.87 u after.
//   T5 — mesh ⊆ open (§2), over the chunk pairs shareCarves() refuses to
//        compose. A scatter chunk's rendered surface buried in another
//        scatter chunk's solid is a wall you can see through and cannot
//        enter — the dark veins before Fix B raised their placement guard.
//   T6 — an empty tile is empty (WG-25). A layer tile the generator proved
//        surface-free is never meshed and caches no field; if the proof were
//        wrong the tile would be an invisible collider, so every flagged one
//        is filled here, at the SHIPPED resolutions, and must yield 0 tris.
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
  resolveCollision,
  worldDistance,
  type Chunk,
} from "../src/world/gouda.ts";
import { R0, meshChunkBuffers } from "../src/world/sdf.ts";
import {
  WHEEL_WORLD,
  cloneWorld,
  partById,
  scatterSurfaceRadius,
} from "../src/world/recipes.ts";

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

// --- T4 — the field is not a metric, so the comparison must normalise ----------
// docs/bug-collision-render-desync.md §3. worldDistance is a min of per-chunk
// APPROXIMATE SDFs: bodySdfWorld scales by `squash`, baseSdf by `minAxis`, both
// worst-case reciprocal gradients. Comparing that raw value against a length
// gives the player an invisible cushion — 0.6/0.45 = 1.33 u of standoff in
// front of every fused-layer rim face. The truth is measured the one way that
// cannot restate the field's own maths: sphere-trace rays out of the probe and
// see where they actually meet the zero set.

const RADIUS = 0.6; // main.ts PLAYER_RADIUS
const GE = 0.25; // gouda.ts GRAD_EPS
const MIN_GRAD = 0.35; // gouda.ts — the resolver's gradient-collapse floor

// Distance along `u` to the zero set, or -1 if none within `max`. Sphere
// tracing is safe here precisely BECAUSE the field under-estimates: every
// step of `d` is a step no longer than the true clearance.
function traceHit(
  x: number,
  y: number,
  z: number,
  ux: number,
  uy: number,
  uz: number,
  max = 6,
): number {
  let t = 0;
  for (let i = 0; i < 120 && t < max; i++) {
    const d = worldDistance(x + ux * t, y + uy * t, z + uz * t);
    if (d <= 1e-3) return t;
    t += Math.max(d, 0.01);
  }
  return -1;
}

// A Fibonacci sphere: 64 directions, ~12.5° apart. min over them is an upper
// bound on the true distance to the surface, tight to ~3 % on a flat face.
const RAY_DIRS: [number, number, number][] = [];
for (let i = 0; i < 64; i++) {
  const y = 1 - (2 * i + 1) / 64;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const a = i * Math.PI * (3 - Math.sqrt(5));
  RAY_DIRS.push([Math.cos(a) * r, y, Math.sin(a) * r]);
}

// The nearest surface, from every side. -1 when nothing is within `max`.
function trueClearance(x: number, y: number, z: number): number {
  let best = -1;
  for (const [ux, uy, uz] of RAY_DIRS) {
    const t = traceHit(x, y, z, ux, uy, uz);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

{
  const r4 = mulberry32(4242);
  let probes = 0,
    pushed = 0,
    collapsed = 0,
    effR = 0;
  let worstAt = "";
  const zones = new Map<string, number>();
  for (const c of data.chunks) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const u = r4() * 2 - 1,
        a = r4() * Math.PI * 2,
        s = Math.sqrt(1 - u * u);
      const m = c.s * (0.7 + r4() * 0.7);
      const x = c.center.x + s * Math.cos(a) * m,
        y = c.center.y + u * m,
        z = c.center.z + s * Math.sin(a) * m;
      // Open water, but close enough that a cushion would be felt.
      const d = worldDistance(x, y, z);
      if (!(d > 0.05 && d < 3)) continue;
      // Between two cancelling walls the field has no usable gradient and the
      // resolver deliberately keeps its cushion (erring solid-side is right
      // there). Those points are counted, not asserted on.
      const gi = 1 / (2 * GE);
      const g = Math.hypot(
        (worldDistance(x + GE, y, z) - worldDistance(x - GE, y, z)) * gi,
        (worldDistance(x, y + GE, z) - worldDistance(x, y - GE, z)) * gi,
        (worldDistance(x, y, z + GE) - worldDistance(x, y, z - GE)) * gi,
      );
      if (g < MIN_GRAD) {
        collapsed++;
        continue;
      }
      probes++;
      zones.set(c.zone ?? "?", (zones.get(c.zone ?? "?") ?? 0) + 1);
      const p = { x, y, z };
      if (!resolveCollision(p, RADIUS)) continue; // not pushed: no cushion here
      pushed++;
      // Only now pay for the truth. The largest measured clearance at which a
      // push still happens IS the player's effective collision radius.
      const L = trueClearance(x, y, z);
      if (L < 0) continue; // nothing within 6 u: not a surface probe
      if (L > effR) {
        effR = L;
        worstAt = `${c.zone} s${c.s}, field said ${d.toFixed(2)} at |∇d| ${g.toFixed(2)}`;
      }
    }
  }
  check(
    "T4: the sampler finds surfaces to stand off from",
    probes >= 200 && pushed >= 50,
    `${probes} near-surface probes, ${pushed} pushed`,
  );
  // Before Fix C the fused rims pushed out past 1.4 u — 0.6 / squash 0.45.
  // d/|∇d| is only a FIRST-order correction, so a little slack survives on
  // strongly curved faces; the systematic 2.2× cushion does not.
  check(
    "T4: no invisible cushion — the effective collision radius is the radius",
    effR <= RADIUS * 1.6,
    `pushed at ${effR.toFixed(2)} u of measured clearance vs ${RADIUS} u asked (${worstAt})`,
  );
  console.log(
    `  · ${probes} near-surface probes [${[...zones].map(([k, v]) => `${k} ${v}`).join(", ")}], ` +
      `${pushed} pushed, ${collapsed} skipped at |∇d| < ${MIN_GRAD}`,
  );
  console.log(
    `  · effective collision radius ${effR.toFixed(2)} u (asked ${RADIUS})`,
  );
}

// --- T5 — mesh ⊆ open, for the pairs that never compose -----------------------
// docs/bug-collision-render-desync.md §2. shareCarves() skips ellipsoid pairs
// ("scatter chunks are independent bodies by design"), so two that
// interpenetrate never cut each other: A's tunnel is drawn straight through
// B's untouched solid and the player bounces off a wall they can see through.
// The scope is exactly that skip. Layer tiles are NOT in it: radially
// adjacent bands abut on purpose, so a band's rim vertex legitimately sits
// inside its neighbour's solid — an interior face, never a visible opening —
// and those pairs do compose their carves.
// Tolerance is the marching-cubes reconstruction floor (§6), 0.25 cells.

{
  const scatter = data.chunks.filter((c) => !c.body);
  // The mirror itself: recipes.ts declares the widest half-axis makeChunkData
  // can draw per shape family, and validateWorld bounds `guard` with it. Read
  // it back off real chunks so a re-tuned axis range cannot outgrow the rule.
  {
    let over = 0;
    let worstAt = "";
    for (const c of scatter) {
      const biome = world.biomes.find((b) => b.id === c.zone);
      if (!biome) continue;
      const bound = Math.max(
        ...biome.parts.map((e) =>
          scatterSurfaceRadius(partById(world, e.part)),
        ),
      );
      const measured = R0 / Math.min(c.ix, c.iy, c.iz) + c.amp;
      if (measured > bound + 1e-9) {
        over++;
        worstAt = `${c.zone}: ${measured.toFixed(3)} > ${bound.toFixed(3)}`;
      }
    }
    check(
      "T5: scatterSurfaceRadius() bounds the ellipsoids the generator draws",
      over === 0,
      `${over}/${scatter.length} chunks exceed the declared bound (${worstAt})`,
    );
  }
  // Only a chunk whose influence ball reaches A's surface can bury it.
  const neighbours = scatter.map((a) =>
    scatter.filter(
      (b) =>
        b !== a &&
        Math.hypot(
          a.center.x - b.center.x,
          a.center.y - b.center.y,
          a.center.z - b.center.z,
        ) <
          (a.s + b.s) * 1.4,
    ),
  );
  let verts = 0,
    buried = 0,
    worst = 0;
  let worstAt = "";
  const zones = new Map<string, number>();
  for (let i = 0; i < scatter.length; i++) {
    const a = scatter[i];
    if (!neighbours[i].length) continue;
    const tol = 0.25 * ((2 * a.s) / a.res);
    const mc = meshChunkBuffers(a);
    const pos = mc.positions;
    // Marching cubes emits neighbouring vertices a fraction of a cell apart:
    // every 7th carries the same information for a seventh of the queries.
    for (let v = 0; v < mc.count * 3; v += 21) {
      const x = a.center.x + pos[v] * a.s,
        y = a.center.y + pos[v + 1] * a.s,
        z = a.center.z + pos[v + 2] * a.s;
      verts++;
      for (const b of neighbours[i]) {
        const d = chunkDistance(b, x, y, z);
        if (d > -tol) continue;
        buried++;
        const key = `${a.zone}∩${b.zone}`;
        zones.set(key, (zones.get(key) ?? 0) + 1);
        if (-d - tol > worst) {
          worst = -d - tol;
          worstAt = `${a.zone} s${a.s.toFixed(1)} inside ${b.zone} s${b.s.toFixed(1)}`;
        }
        break;
      }
    }
  }
  check(
    "T5: the sampler finds scatter chunks close enough to bury each other",
    verts > 1000,
    `${verts} vertices over ${neighbours.filter((n) => n.length).length}/${scatter.length} scatter chunks with neighbours`,
  );
  // Before Fix B the dark veins placed at guard 0.45 against a 0.79 surface:
  // ~120 interpenetrating pairs per seed, up to 22 u deep.
  check(
    "T5: no scatter chunk's rendered surface is buried in another's solid",
    buried === 0,
    `${buried}/${verts} buried [${[...zones].map(([k, v]) => `${k} ${v}`).join(", ")}], ` +
      `worst ${worst.toFixed(2)} u past tolerance (${worstAt})`,
  );
  console.log(`  · ${verts} scatter vertices probed against their neighbours`);
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

// T6 — a tile PROVEN empty really is empty (WG-25). Such a tile is never
// meshed and never caches a field, so a proof that admitted one surface
// triangle would leave an invisible collider behind. Checked at the SHIPPED
// resolutions (a bigger marched box than this file's res 32), which is where
// the proof runs thinnest — only the flagged tiles are filled, and they are
// the cheap ones by construction.
{
  const shipped = buildWorldData({ seed: SEED, difficulty: 1 });
  let flagged = 0;
  let leaked = 0;
  let tris = 0;
  for (const c of shipped.chunks) {
    if (!c.empty) continue;
    flagged++;
    const b = meshChunkBuffers(c);
    c.field = null;
    if (b.count) {
      leaked++;
      tris += b.count / 3;
    }
  }
  check(
    "T6: every tile proven surface-free meshes to zero triangles",
    flagged > 0 && leaked === 0,
    `${flagged} flagged, ${leaked} leaked ${Math.round(tris)} tris`,
  );
  console.log(
    `  · ${flagged}/${shipped.chunks.length} tiles skipped at shipped res`,
  );
}

console.log(
  `\ncollision/render checks in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
);
if (failures) {
  console.error(`${failures} collision check(s) failed.`);
  process.exit(1);
}
console.log("All collision checks passed.");
