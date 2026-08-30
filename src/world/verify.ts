// verify.ts — the route verifier (WG-02): "one test, two answers". Proves,
// per seed, that the run is SEALED (no route bell → gold while every seal is
// intact) and REACHABLE (breaching the Great Wheel's soft spots opens a route
// a rat can swim), and reports the cargo bottleneck along the solved path.
//
// Pure data module: builds the world through buildWorldData() (no meshing,
// no module state, no render imports) and searches the same SDF the game
// collides against. Node-runnable — tools/test-worldgen.ts drives it in CI;
// the bench calls verifyWorld() for its route overlay (WG-14).
//
// Search: greedy best-first (euclidean) on an implicit lattice (~1.25 u
// step). A cell is passable iff SOME point inside it clears the rat radius:
// the centre probe first, then a short hill-climb up the SDF gradient —
// without the climb, tunnels narrower than the lattice diagonal (the 1.1 u
// gallery bores) alias shut and the verifier reports false seals. Every
// accepted move also probes its midpoint (refined the same way) so a step
// can never jump a thin wall. It runs GOLD → BELL, so a sealed world
// exhausts the wheel's interior instead of flooding the boundless ocean
// around the bell. A throwaway chunk hash grid keeps each probe to the few
// chunks whose reach covers the cell (WG-21 generalizes this later).
import {
  buildWorldData,
  chunkDistance,
  R0,
  tileFieldCovers,
  type Chunk,
  type DebrisSpec,
  type WorldData,
} from "./gouda.ts";
import { WHEEL_WORLD, type WorldRecipe, type ZoneName } from "./recipes.ts";
import type { Vec3 } from "../state.ts";

// Clearance ceiling of any query; empty grid buckets report this much open
// water, so it caps the clearances verifyWorld may test (and the reported
// minClearance saturates here — bottlenecks are far below it).
const OPEN = 3;

export interface VerifyResult {
  sealed: boolean; // undug world: no gold → bell route at rat clearance
  reachable: boolean; // soft spots breached: a rat route exists
  path: Vec3[]; // the solved route, bell → gold (empty if unreachable)
  minClearance: number; // bottleneck world distance along the path
  bottleneck: Vec3 | null; // where the path is tightest
  bottleneckZone: ZoneName | null;
  visited: number; // lattice cells expanded across both searches
  ms: number;
}

export interface VerifyOpts {
  step?: number; // lattice step (world u)
  clearance?: number; // rat radius
  maxVisited?: number; // search abort ceiling (counts as "not found")
}

// --- Chunk hash grid ---------------------------------------------------------

interface Grid {
  cell: number;
  buckets: Map<number, number[]>; // packed cell → chunk indices (then debris)
  chunks: Chunk[];
  debris: DebrisSpec[];
}

const GRID_CELL = 24;

function cellKey(cx: number, cy: number, cz: number): number {
  return ((cx + 128) << 16) | ((cy + 128) << 8) | (cz + 128);
}

// A chunk lands in every cell its influence ball overlaps: outside that ball
// it cannot pull the distance below OPEN (see distanceAt's per-chunk bounds).
function buildGrid(data: WorldData): Grid {
  const g: Grid = {
    cell: GRID_CELL,
    buckets: new Map(),
    chunks: data.chunks,
    debris: data.debris,
  };
  const insert = (idx: number, c: Vec3, reach: number) => {
    const lo = (v: number) => Math.floor((v - reach) / GRID_CELL);
    const hi = (v: number) => Math.floor((v + reach) / GRID_CELL);
    for (let x = lo(c.x); x <= hi(c.x); x++)
      for (let y = lo(c.y); y <= hi(c.y); y++)
        for (let z = lo(c.z); z <= hi(c.z); z++) {
          const key = cellKey(x, y, z);
          let bucket = g.buckets.get(key);
          if (!bucket) g.buckets.set(key, (bucket = []));
          bucket.push(idx);
        }
  };
  for (let i = 0; i < data.chunks.length; i++) {
    const c = data.chunks[i];
    insert(i, c.center, (c.body ? 1.74 : 1.4) * c.s + OPEN + 1);
  }
  for (let i = 0; i < data.debris.length; i++) {
    const b = data.debris[i];
    insert(data.chunks.length + i, b.center, b.r + OPEN + 1);
  }
  return g;
}

// worldDistance over the bucket's chunks only — same per-chunk bounds as
// gouda.ts's distanceToWorld, saturating at OPEN.
function distanceAt(g: Grid, x: number, y: number, z: number): number {
  const bucket = g.buckets.get(
    cellKey(
      Math.floor(x / g.cell),
      Math.floor(y / g.cell),
      Math.floor(z / g.cell),
    ),
  );
  if (!bucket) return OPEN;
  let best = OPEN;
  for (let i = 0; i < bucket.length; i++) {
    const idx = bucket[i];
    if (idx >= g.chunks.length) {
      const b = g.debris[idx - g.chunks.length];
      const dx = x - b.center.x,
        dy = y - b.center.y,
        dz = z - b.center.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - b.r;
      if (d < best) best = d;
      continue;
    }
    const c = g.chunks[idx];
    const dx = x - c.center.x,
      dy = y - c.center.y,
      dz = z - c.center.z;
    const dc = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (c.body) {
      if (dc - c.s * 1.74 > best) continue;
      if (!tileFieldCovers(c, x, y, z)) continue;
      const d = chunkDistance(c, x, y, z);
      if (d < best) best = d;
      continue;
    }
    if (dc - c.s > best) continue;
    if (dc > c.s * 1.4) {
      const d = dc - c.s * (R0 + 0.25);
      if (d < best) best = d;
      continue;
    }
    const d = chunkDistance(c, x, y, z);
    if (d < best) best = d;
  }
  return best;
}

function zoneAt(g: Grid, p: Vec3): ZoneName | null {
  let zone: ZoneName | null = null;
  let best = Infinity;
  const bucket = g.buckets.get(
    cellKey(
      Math.floor(p.x / g.cell),
      Math.floor(p.y / g.cell),
      Math.floor(p.z / g.cell),
    ),
  );
  if (!bucket) return null;
  for (const idx of bucket) {
    if (idx >= g.chunks.length) continue;
    const c = g.chunks[idx];
    const d = chunkDistance(c, p.x, p.y, p.z);
    if (d < best) {
      best = d;
      zone = c.zone ?? null;
    }
  }
  return zone;
}

// --- Greedy best-first search ------------------------------------------------

interface SearchResult {
  found: boolean;
  capped: boolean; // hit maxVisited — verdict unusable
  visited: number;
  path: Vec3[] | null; // start → goal, when found and recorded
}

class MinHeap {
  f = new Float64Array(4096);
  k = new Int32Array(4096);
  n = 0;
  push(f: number, k: number): void {
    if (this.n === this.f.length) {
      const nf = new Float64Array(this.n * 2);
      nf.set(this.f);
      this.f = nf;
      const nk = new Int32Array(this.n * 2);
      nk.set(this.k);
      this.k = nk;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= f) break;
      this.f[i] = this.f[p];
      this.k[i] = this.k[p];
      i = p;
    }
    this.f[i] = f;
    this.k[i] = k;
  }
  pop(): number {
    const top = this.k[0];
    const f = this.f[--this.n];
    const k = this.k[this.n];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      if (l >= this.n) break;
      const r = l + 1;
      const m = r < this.n && this.f[r] < this.f[l] ? r : l;
      if (this.f[m] >= f) break;
      this.f[i] = this.f[m];
      this.k[i] = this.k[m];
      i = m;
    }
    this.f[i] = f;
    this.k[i] = k;
    return top;
  }
}

const NEIGHBORS: [number, number, number][] = [];
for (let dx = -1; dx <= 1; dx++)
  for (let dy = -1; dy <= 1; dy++)
    for (let dz = -1; dz <= 1; dz++)
      if (dx || dy || dz) NEIGHBORS.push([dx, dy, dz]);

// Hill-climb the SDF from p toward `target` clearance, confined to a box of
// ±reach around p — "is there an open point in this cell", the continuum
// passability a lattice centre probe under-approximates.
function climbsTo(
  g: Grid,
  px: number,
  py: number,
  pz: number,
  d0: number,
  target: number,
  reach: number,
): boolean {
  const EPS = 0.25;
  const iters = Math.max(4, Math.ceil((reach * 1.8) / 0.3));
  let x = px,
    y = py,
    z = pz,
    d = d0;
  for (let iter = 0; iter < iters; iter++) {
    let gx = distanceAt(g, x + EPS, y, z) - distanceAt(g, x - EPS, y, z);
    let gy = distanceAt(g, x, y + EPS, z) - distanceAt(g, x, y - EPS, z);
    let gz = distanceAt(g, x, y, z + EPS) - distanceAt(g, x, y, z - EPS);
    const len = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (len < 1e-6) return false;
    const stepLen = Math.min(0.35, target - d + 0.05) / len;
    gx *= stepLen;
    gy *= stepLen;
    gz *= stepLen;
    x = Math.max(px - reach, Math.min(px + reach, x + gx));
    y = Math.max(py - reach, Math.min(py + reach, y + gy));
    z = Math.max(pz - reach, Math.min(pz + reach, z + gz));
    const nd = distanceAt(g, x, y, z);
    if (nd >= target) return true;
    if (nd <= d) return false; // stalled against the box or a ridge
    d = nd;
  }
  return false;
}

// Best clearance point within ±reach of p — used to pull recorded path
// points off lattice centres and into the middle of their corridor.
function bestNear(
  g: Grid,
  px: number,
  py: number,
  pz: number,
  reach: number,
): { x: number; y: number; z: number; d: number } {
  const EPS = 0.25;
  let x = px,
    y = py,
    z = pz;
  let d = distanceAt(g, x, y, z);
  let best = { x, y, z, d };
  for (let iter = 0; iter < 5; iter++) {
    const gx = distanceAt(g, x + EPS, y, z) - distanceAt(g, x - EPS, y, z);
    const gy = distanceAt(g, x, y + EPS, z) - distanceAt(g, x, y - EPS, z);
    const gz = distanceAt(g, x, y, z + EPS) - distanceAt(g, x, y, z - EPS);
    const len = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (len < 1e-6) break;
    const stepLen = 0.3 / len;
    x = Math.max(px - reach, Math.min(px + reach, x + gx * stepLen));
    y = Math.max(py - reach, Math.min(py + reach, y + gy * stepLen));
    z = Math.max(pz - reach, Math.min(pz + reach, z + gz * stepLen));
    d = distanceAt(g, x, y, z);
    if (d > best.d) best = { x, y, z, d };
    else if (d < best.d - 0.2) break;
  }
  return best;
}

interface SearchMode {
  mode: "greedy" | "exhaust";
  // exhaust only: a cell past this WORLD radius means the flood escaped the
  // outermost seal into ocean that connects to the bell — stop, not sealed.
  escapeR?: number;
}

function search(
  g: Grid,
  start: Vec3,
  goal: Vec3,
  bound: number,
  step: number,
  clearance: number,
  maxVisited: number,
  recordPath: boolean,
  mode: SearchMode = { mode: "greedy" },
): SearchResult {
  const n = Math.ceil(bound / step) + 2;
  const dim = 2 * n + 1;
  const seen = new Uint8Array(Math.ceil((dim * dim * dim) / 8));
  const idxOf = (ix: number, iy: number, iz: number) =>
    ((ix + n) * dim + (iy + n)) * dim + (iz + n);
  const mark = (i: number) => (seen[i >> 3] |= 1 << (i & 7));
  const marked = (i: number) => (seen[i >> 3] & (1 << (i & 7))) !== 0;
  // Passable = some point of the cell clears the rat: centre probe, then a
  // confined hill-climb for near misses (narrow-tunnel aliasing).
  const passable = (ix: number, iy: number, iz: number) => {
    const x = ix * step,
      y = iy * step,
      z = iz * step;
    const d = distanceAt(g, x, y, z);
    if (d >= clearance) return true;
    if (d < clearance - 0.75) return false;
    return climbsTo(g, x, y, z, d, clearance, step * 0.55);
  };
  // A move may not jump a wall: its midpoint must show real open water
  // (refined the same way for corridors thinner than the lattice diagonal).
  const MID_MIN = 0.2;
  const edgeOpen = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
  ) => {
    const x = (ax + bx) * 0.5 * step,
      y = (ay + by) * 0.5 * step,
      z = (az + bz) * 0.5 * step;
    const d = distanceAt(g, x, y, z);
    if (d >= MID_MIN) return true;
    if (d < -0.1) return false;
    return climbsTo(g, x, y, z, d, MID_MIN, 0.4);
  };

  // Snap the start to the nearest passable cell within a small shell.
  let sx = Math.round(start.x / step),
    sy = Math.round(start.y / step),
    sz = Math.round(start.z / step);
  snap: for (let radius = 0; radius <= 3; radius++) {
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -radius; dy <= radius; dy++)
        for (let dz = -radius; dz <= radius; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== radius)
            continue;
          if (passable(sx + dx, sy + dy, sz + dz)) {
            sx += dx;
            sy += dy;
            sz += dz;
            break snap;
          }
        }
    if (radius === 3)
      return { found: false, capped: false, visited: 0, path: null };
  }

  const goalR2 = (step * 1.75) ** 2;
  const h = (ix: number, iy: number, iz: number) => {
    const dx = ix * step - goal.x,
      dy = iy * step - goal.y,
      dz = iz * step - goal.z;
    return dx * dx + dy * dy + dz * dz;
  };
  // greedy = best-first toward the goal; exhaust = plain flood (stack, no
  // heuristic) that stops the moment it escapes past mode.escapeR.
  const useHeap = mode.mode === "greedy";
  const heap = new MinHeap();
  const stack: number[] = [];
  const escaped = (ix: number, iy: number, iz: number) =>
    mode.escapeR !== undefined &&
    Math.hypot(ix * step, iy * step, iz * step) > mode.escapeR;
  const parents = recordPath ? new Map<number, number>() : null;
  const startIdx = idxOf(sx, sy, sz);
  mark(startIdx);
  if (useHeap) heap.push(h(sx, sy, sz), startIdx);
  else stack.push(startIdx);
  let visited = 0;
  let goalIdx = -1;

  while (useHeap ? heap.n > 0 : stack.length > 0) {
    const cur = useHeap ? heap.pop() : stack.pop()!;
    visited++;
    if (visited > maxVisited)
      return { found: false, capped: true, visited, path: null };
    let rem = cur;
    const cx = Math.floor(rem / (dim * dim)) - n;
    rem -= (cx + n) * dim * dim;
    const cy = Math.floor(rem / dim) - n;
    const cz = rem - (cy + n) * dim - n;

    for (const [dx, dy, dz] of NEIGHBORS) {
      const ix = cx + dx,
        iy = cy + dy,
        iz = cz + dz;
      if (Math.max(Math.abs(ix), Math.abs(iy), Math.abs(iz)) > n - 1) continue;
      const ni = idxOf(ix, iy, iz);
      if (marked(ni)) continue;
      if (!passable(ix, iy, iz)) {
        mark(ni); // impassable is direction-independent — close it for good
        continue;
      }
      // An edge-blocked cell stays unmarked: another direction may reach it.
      if (!edgeOpen(cx, cy, cz, ix, iy, iz)) continue;
      mark(ni);
      parents?.set(ni, cur);
      if (h(ix, iy, iz) <= goalR2 || escaped(ix, iy, iz)) {
        goalIdx = ni;
        break;
      }
      if (useHeap) heap.push(h(ix, iy, iz), ni);
      else stack.push(ni);
    }
    if (goalIdx >= 0) break;
  }

  if (goalIdx < 0) return { found: false, capped: false, visited, path: null };

  let path: Vec3[] | null = null;
  if (parents) {
    path = [{ x: goal.x, y: goal.y, z: goal.z }];
    let cur: number | undefined = goalIdx;
    while (cur !== undefined) {
      let rem = cur;
      const ix = Math.floor(rem / (dim * dim)) - n;
      rem -= (ix + n) * dim * dim;
      const iy = Math.floor(rem / dim) - n;
      const iz = rem - (iy + n) * dim - n;
      path.push({ x: ix * step, y: iy * step, z: iz * step });
      cur = parents.get(cur);
    }
    path.push({ x: start.x, y: start.y, z: start.z });
    path.reverse();
  }
  return { found: true, capped: false, visited, path };
}

// --- Breaching the seals -------------------------------------------------------

// Push a dig sphere into every chunk it reaches — the data-phase twin of
// digAt (no fields, no meshes, and no tool gate: this emulates the outcome
// of the M3 breach timer, not a hand swing).
function addDataDig(
  chunks: Chunk[],
  x: number,
  y: number,
  z: number,
  r: number,
): void {
  for (const c of chunks) {
    const dx = x - c.center.x,
      dy = y - c.center.y,
      dz = z - c.center.z;
    const dc = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dc > (c.body ? c.s * 1.74 : c.s * 1.35) + r) continue;
    c.digs.push({ x: dx / c.s, y: dy / c.s, z: dz / c.s, r: r / c.s });
  }
}

// Drill every Great Wheel soft spot: a driller-radius bore along the ray
// from the world origin through the spot (the hull is star-shaped around
// the origin, so the ray always crosses the husk), long enough to pierce
// the crust at any face obliquity.
function breachSoftSpots(data: WorldData): void {
  const DRILL_R = 2.4;
  for (const spot of data.plan.softSpots) {
    const len = Math.hypot(spot.x, spot.y, spot.z) || 1;
    const dx = spot.x / len,
      dy = spot.y / len,
      dz = spot.z / len;
    const reach = spot.r + 34;
    for (let t = -reach; t <= reach; t += 1.6)
      addDataDig(
        data.chunks,
        spot.x + dx * t,
        spot.y + dy * t,
        spot.z + dz * t,
        DRILL_R,
      );
  }
}

// --- The verifier ---------------------------------------------------------------

export function verifyWorld(
  seed: number,
  difficulty: number,
  world: WorldRecipe = WHEEL_WORLD,
  opts: VerifyOpts = {},
): VerifyResult {
  const step = opts.step ?? 1.25;
  const clearance = opts.clearance ?? 0.6;
  const maxVisited = opts.maxVisited ?? 30_000_000;
  const t0 = Date.now();

  const data = buildWorldData({ seed, difficulty, world });
  const grid = buildGrid(data);
  const bound = data.world.boundaryR;
  const gold = data.goldPos;
  const bell = data.spawnPoint;
  // The outermost seal's enclosing WORLD radius: a flood cell past this is
  // in ocean that connects to the bell (scatter bands are clutter, not
  // seals). A wheel hull's corners stick out to R·√(1+squash²).
  const squash = data.world.frame?.squash ?? 1;
  let escapeR = 0;
  for (const b of data.world.biomes) {
    const pl = b.placement;
    if (pl.mode === "hull")
      escapeR = Math.max(escapeR, pl.radius * Math.sqrt(1 + squash * squash));
    else if (pl.mode === "fused") escapeR = Math.max(escapeR, pl.rMax);
  }
  escapeR += 20;

  // Sealed: both seals intact (soft spots are solid rind until drilled) —
  // gold → bell must be unreachable. An exhaustive flood from the gold at a
  // coarser step (the hill-climb reach scales with it, so passability stays
  // continuum-based) either escapes past the outermost seal (not sealed) or
  // drains the interior and proves the seal.
  const sealedRun = search(
    grid,
    gold,
    bell,
    bound,
    step * 1.6,
    clearance,
    maxVisited,
    false,
    { mode: "exhaust", escapeR },
  );
  const sealed = !sealedRun.found && !sealedRun.capped;

  // Reachable: drill the soft spots, search again, record the route.
  breachSoftSpots(data);
  const openRun = search(
    grid,
    gold,
    bell,
    bound,
    step,
    clearance,
    maxVisited,
    true,
  );

  let path: Vec3[] = [];
  let minClearance = Infinity;
  let bottleneck: Vec3 | null = null;
  if (openRun.found && openRun.path) {
    // Pull lattice points into the middle of their corridor before
    // measuring — the centre of a cell passed via hill-climb sits in wax.
    path = openRun.path
      .slice()
      .reverse() // report bell → gold
      .map((p) => {
        const d = distanceAt(grid, p.x, p.y, p.z);
        if (d >= 1.3) return { ...p, d };
        return bestNear(grid, p.x, p.y, p.z, step * 0.55);
      })
      .map(({ x, y, z, d }) => {
        if (d < minClearance) {
          minClearance = d;
          bottleneck = { x, y, z };
        }
        return { x, y, z };
      });
  }

  return {
    sealed,
    reachable: openRun.found,
    path,
    minClearance: Number.isFinite(minClearance) ? minClearance : 0,
    bottleneck,
    bottleneckZone: bottleneck ? zoneAt(grid, bottleneck) : null,
    visited: sealedRun.visited + openRun.visited,
    ms: Date.now() - t0,
  };
}
