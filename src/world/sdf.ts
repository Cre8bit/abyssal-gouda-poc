// sdf.ts — the render-free SDF core of the cheese world (WG-19).
//
// Everything needed to turn one chunk's SDF params into marching-cubes
// buffers lives here, with no scene/material/DOM dependencies, so the SAME
// code runs on the main thread (gouda.ts), in the mesh worker pool
// (meshWorker.ts), and in node (verifier, tests):
//
//   · shape math: smooth ops, fbm3 crust noise, world frame, layer bodies
//   · chunkSdf(): the full per-chunk SDF (base + carves + player digs) —
//     the single source of truth for meshing, collision and digging
//   · fillField()/extractBuffers()/meshChunkBuffers(): voxel field fill +
//     compact geometry extraction (positions/normals/aCrust/aVein) as plain
//     typed arrays — transferable, wrapped into THREE geometry by callers
//
// ChunkShape is the structural view of a chunk this module reads —
// gouda.ts's Chunk extends it (center narrows to THREE.Vector3 there), and
// the worker receives it as structured-clone plain data. Placement,
// queries, digging and world assembly stay in gouda.ts.
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { MeshBasicMaterial } from "three";
import type { Vec3 } from "../state.ts";

const MAX_POLYS: Record<number, number> = {
  96: 220000,
  72: 140000,
  64: 110000,
  56: 90000,
  48: 70000,
  32: 24000,
};

// Poly budget per res: the authored table, or the WG-24 fallback formula.
export function polyBudget(res: number): number {
  return MAX_POLYS[res] ?? Math.round(res * res * res * 0.3);
}

// Local-space (unit-sphere) shape parameters. Surface ~ |p| = R0, grid [-1,1].
// Exported for the worldgen bench (proxy sphere radius ≈ chunk s · R0).
export const R0 = 0.6;
export const CARVE_SKIP = 0.3;
export const SMOOTH_K = 0.05;
const PLANE_K = 0.025;

const noise = new ImprovedNoise();

// --- Types (erased at runtime) ---------------------------------------------------

export interface PlaneCut {
  nx: number;
  ny: number;
  nz: number;
  off: number;
}

// Eyes (caverns/chambers), pores AND player digs all share this shape.
export interface SphereCarve {
  x: number;
  y: number;
  z: number;
  r: number;
}

export interface Tunnel {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  r: number;
}

// The structural chunk view the SDF core reads — every field is plain data
// (structured-clone safe for the mesh worker). gouda.ts's Chunk extends it.
export interface ChunkShape {
  center: Vec3;
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
  body?: LayerBody; // layer-body tile: base SDF comes from the layer, not the ellipsoid
  veinEdges?: boolean; // bake the aVein edge-glow attribute at extraction (WG-13)
}

// --- SDF primitives -----------------------------------------------------------------

export function fbm3(x: number, y: number, z: number): number {
  return (
    noise.noise(x, y, z) +
    0.5 * noise.noise(x * 2.13 + 7.7, y * 2.13 + 3.1, z * 2.13 + 11.6)
  );
}

export function smoothCut(d: number, cut: number, k: number): number {
  const b = -cut;
  const h = Math.max(k - Math.abs(d - b), 0) / k;
  return Math.max(d, b) + h * h * k * 0.25;
}

function smoothMax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

export function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export function segDist(
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

// --- World frame (squash + tilt) — layer-body radii are measured here ------------

// Precomputed rotation (tilt about X) + vertical squash. null = identity,
// and the identity path must not touch the numbers.
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
  // Hull hidden entrance (WG-08), world-space carves owned by THIS layer —
  // sealed tiles refuse foreign carves, but the door belongs to the seal.
  entranceCarves?: { holes: SphereCarve[]; tunnels: Tunnel[] };
}

// The hull's FULL solid (wheel/sphere before hollowing) — the husk is
// max(solid, -solid - thickness), and soft-spot projection bisects this.
export function hullSolidSdf(
  b: LayerBody,
  x: number,
  y: number,
  z: number,
): number {
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
export function bodySdfWorld(
  b: LayerBody,
  x: number,
  y: number,
  z: number,
): number {
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
export function baseSdf(
  c: ChunkShape,
  x: number,
  y: number,
  z: number,
): number {
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
export function chunkSdf(
  c: ChunkShape,
  x: number,
  y: number,
  z: number,
): number {
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
  // re-meshed geometry exactly. Same lim bounding as holes (WG-23a); heavily
  // dug chunks fall over to a per-cell bucket (WG-23c) — both exclusions are
  // strict supersets of what the smoothCut would have no-op'd, so the values
  // near the isosurface are bit-identical to the plain sweep.
  const digs = c.digs;
  const bucket =
    digs.length > DIG_BUCKET_THRESHOLD
      ? (digBucketAt(c, x, y, z) ?? EMPTY_BUCKET)
      : null;
  const nDigs = bucket ? bucket.length : digs.length;
  for (let i = 0; i < nDigs; i++) {
    const g = digs[bucket ? bucket[i] : i];
    const lim = d < -0.25 ? g.r + 0.31 : g.r - d + 0.06;
    const dx = x - g.x;
    if (dx > lim || dx < -lim) continue;
    const dy = y - g.y;
    if (dy > lim || dy < -lim) continue;
    const dz = z - g.z;
    if (dz > lim || dz < -lim) continue;
    d = smoothCut(d, Math.sqrt(dx * dx + dy * dy + dz * dz) - g.r, SMOOTH_K);
  }

  return d;
}

// --- Dig buckets (WG-23c) ---------------------------------------------------------

// Past this many digs a chunk gets a lazy per-cell index so chunkSdf checks
// only nearby digs. Rebuilt whenever the dig list has grown (cheap: once per
// dig, amortized over the thousands of samples a remesh runs).
const DIG_BUCKET_THRESHOLD = 64;
const DIG_CELL = 0.5; // local units; digs live in [-1.3, 1.3]
const DIG_PAD_LOCAL = 0.4; // ≥ the largest lim a dig can carry (r + 0.31)
const EMPTY_BUCKET: number[] = [];

interface DigGrid {
  count: number;
  cells: Map<number, number[]>;
}

const digGrids = new WeakMap<ChunkShape, DigGrid>();

function digCellKey(cx: number, cy: number, cz: number): number {
  return ((cx + 32) << 12) | ((cy + 32) << 6) | (cz + 32);
}

function digBucketAt(
  c: ChunkShape,
  x: number,
  y: number,
  z: number,
): number[] | null {
  let grid = digGrids.get(c);
  if (!grid || grid.count !== c.digs.length) {
    grid = { count: c.digs.length, cells: new Map() };
    for (let i = 0; i < c.digs.length; i++) {
      const g = c.digs[i];
      const reach = g.r + DIG_PAD_LOCAL;
      const lo = (v: number) => Math.floor((v - reach) / DIG_CELL);
      const hi = (v: number) => Math.floor((v + reach) / DIG_CELL);
      for (let cx = lo(g.x); cx <= hi(g.x); cx++)
        for (let cy = lo(g.y); cy <= hi(g.y); cy++)
          for (let cz = lo(g.z); cz <= hi(g.z); cz++) {
            const key = digCellKey(cx, cy, cz);
            let cell = grid.cells.get(key);
            if (!cell) grid.cells.set(key, (cell = []));
            cell.push(i);
          }
    }
    digGrids.set(c, grid);
  }
  return (
    grid.cells.get(
      digCellKey(
        Math.floor(x / DIG_CELL),
        Math.floor(y / DIG_CELL),
        Math.floor(z / DIG_CELL),
      ),
    ) ?? null
  );
}

// --- Field fill + geometry extraction ----------------------------------------------

// MC instances stay live per res; digging reuses them for chunk re-meshing.
// Each realm (main thread, each worker, node) holds its own cache.
const mcCache = new Map<number, MarchingCubes>();

export function getMC(res: number): MarchingCubes {
  let mc = mcCache.get(res);
  if (!mc) {
    mc = new MarchingCubes(
      res,
      new MeshBasicMaterial(),
      false,
      false,
      polyBudget(res),
    );
    mcCache.set(res, mc);
  }
  return mc;
}

// Edge-vein bake thresholds (WG-13): world-space mean-curvature band mapped
// to aVein 0→1. Smooth hunk faces (ρ ≫ 4 u) stay dark; carve mouths and
// silhouette rims (fillet ρ ≈ SMOOTH_K·s ≈ 0.5–2 u) light up.
const VEIN_CURV_LO = 0.25;
const VEIN_CURV_HI = 1.1;

// The compact per-chunk geometry, as plain transferable arrays. `field` is
// the filled voxel field the chunk caches for digging.
export interface ChunkMeshBuffers {
  positions: Float32Array;
  normals: Float32Array;
  crust: Float32Array;
  vein: Float32Array | null;
  field: Float32Array;
  count: number; // vertex count
}

// Fill the MC scratch field from the chunk's SDF (marching negates: solid > 0).
export function fillField(c: ChunkShape, mc: MarchingCubes): void {
  const field = mc.field;
  const res = c.res;
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
}

// Extract compact buffers with sanitized normals; compute rind factor
// (1=crust, 0=carved) and, for edge-vein parts, the aVein curvature bake.
export function extractBuffers(
  mc: MarchingCubes,
  c: ChunkShape,
): Omit<ChunkMeshBuffers, "field"> {
  const count = mc.count;
  const positions = mc.geometry.attributes.position.array.slice(
    0,
    count * 3,
  ) as Float32Array;
  const normals = mc.geometry.attributes.normal.array.slice(
    0,
    count * 3,
  ) as Float32Array;
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

  // WG-13 — bake aVein for edge-vein parts: the SDF Laplacian at the vertex
  // estimates mean curvature (convex edges > 0, cavity interiors < 0).
  // chunkSdf includes digs, so remeshing keeps the glow on the new rims;
  // chunks without the flag skip the buffer (a missing attribute reads 0).
  let vein: Float32Array | null = null;
  if (c.veinEdges) {
    vein = new Float32Array(count);
    const eps = 2.5 / c.res;
    const inv = 1 / (eps * eps * c.s);
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const x = positions[i3],
        y = positions[i3 + 1],
        z = positions[i3 + 2];
      const lap =
        chunkSdf(c, x + eps, y, z) +
        chunkSdf(c, x - eps, y, z) +
        chunkSdf(c, x, y + eps, z) +
        chunkSdf(c, x, y - eps, z) +
        chunkSdf(c, x, y, z + eps) +
        chunkSdf(c, x, y, z - eps) -
        6 * chunkSdf(c, x, y, z);
      const t2 = Math.max(
        0,
        Math.min(1, (lap * inv - VEIN_CURV_LO) / (VEIN_CURV_HI - VEIN_CURV_LO)),
      );
      vein[i] = t2 * t2 * (3 - 2 * t2);
    }
  }
  return { positions, normals, crust, vein, count };
}

// One chunk → mesh buffers, either from its SDF (build) or from a pre-dug
// field (remesh). The one entry point shared by meshChunk, remeshes and the
// worker — identical inputs give bit-identical buffers on any thread.
export function meshChunkBuffers(
  c: ChunkShape,
  field: Float32Array | null = null,
): ChunkMeshBuffers {
  const mc = getMC(c.res);
  mc.reset();
  mc.isolation = 0;
  let outField: Float32Array;
  if (field) {
    (mc.field as Float32Array).set(field);
    outField = field;
  } else {
    fillField(c, mc);
    outField = (mc.field as Float32Array).slice();
  }
  mc.update();
  const budget = polyBudget(c.res);
  const polys = mc.count / 3;
  if (polys > budget) {
    console.warn("gouda: chunk exceeded poly budget, geometry truncated");
  } else if (polys > budget * 0.9) {
    console.warn(
      `gouda: chunk at ${Math.round((polys / budget) * 100)}% of the res-${c.res} poly budget`,
    );
  }
  return { ...extractBuffers(mc, c), field: outField };
}
