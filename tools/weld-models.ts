#!/usr/bin/env node
// weld-models.ts — the glTF-native "merge by distance" for public/models/*.glb.
//
// WHAT THE TRIPO/BLENDER EXPORTS ACTUALLY CONTAIN. Every shipped GLB carries
// ~3x more vertices than it has distinct positions (the rat diver: 4609 verts
// over 1526 positions). Those are NOT removable duplicates: a glTF vertex is
// one tuple of ALL attributes, and the texture atlas gives nearly every seam
// vertex a different TEXCOORD_0, so the GPU genuinely needs them. Welding them
// would smear the atlas. A Blender "merge by distance" + re-export gives the
// same file back, because Blender keeps UVs per face-corner and the exporter
// re-splits on the way out.
//
// WHAT IS BROKEN, AND WHAT THIS FIXES. What Blender's merge really unifies is
// the per-VERTEX data behind those corners — position, normal, vertex groups.
// In the exports that data has drifted apart between twins, which is the
// animation and lighting bug, not the vertex count:
//   - skin  — co-located verts bound to different bones tear the mesh open
//             along every atlas seam as it animates (catfish: 1789 of 1789
//             split positions diverge, worst weight delta 0.61).
//   - normal— twins differing by a FRACTION of a degree straddle a band edge
//             in the cel ramp (render/toon.ts) and stitch a visible seam line
//             across the model.
//   - position — float32 noise leaves twins 1e-7 apart: a hairline crack.
// So: unify position and skin across a whole position cluster, unify normals
// only within a cluster's near-parallel sub-groups (a genuine hard edge keeps
// its distinct normals), and never touch a UV. Vertices that come out fully
// identical then collapse for free.
//
// The rest pose is bit-identical (skinning at bind is the identity whatever
// the weights are, and weights stay normalised), the atlas is untouched, and
// the triangle list is unchanged — only re-indexed.
//
//   node tools/weld-models.ts --check        report, write nothing
//   node tools/weld-models.ts                rewrite public/models/*.glb
//   node tools/weld-models.ts a.glb b.glb    just those files
//
// Flags: --eps <rel>   position cluster radius, fraction of the bbox diagonal
//                      (default 1e-5 — three decades above the float noise it
//                      is there to catch, two below the finest real detail in
//                      any shipped model, tinBell's 3.4e-4).
//        --soft <deg>  normals closer than this unify (default 5). Anything
//                      further apart is a deliberate hard edge and is kept.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MODELS = path.join(ROOT, "public", "models");

// The glTF JSON is a schema-free document here: the tool reads a handful of
// well-known fields and copies the rest through untouched.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gltf = Record<string, any>;
type Glb = { json: Gltf; bin: Uint8Array };

type TypedArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Uint32Array
  | Float32Array;
type TypedArrayCtor = {
  new (buffer: ArrayBufferLike, byteOffset: number, length: number): TypedArray;
  BYTES_PER_ELEMENT: number;
};

const COMPONENT: Record<number, { size: number; arr: TypedArrayCtor }> = {
  5120: { size: 1, arr: Int8Array },
  5121: { size: 1, arr: Uint8Array },
  5122: { size: 2, arr: Int16Array },
  5123: { size: 2, arr: Uint16Array },
  5125: { size: 4, arr: Uint32Array },
  5126: { size: 4, arr: Float32Array },
};
const NCOMP: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

function readGlb(file: string): Glb {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  const total = buf.readUInt32LE(8);
  let off = 12;
  let json: Gltf | null = null;
  let bin = new Uint8Array(0);
  while (off + 8 <= total) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === 0x004e4942) bin = new Uint8Array(data);
    off += 8 + len;
  }
  if (!json) throw new Error(`${file}: no JSON chunk`);
  return { json, bin };
}

function writeGlb(file: string, json: Gltf, bin: Uint8Array) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = jsonBytes.length + ((4 - (jsonBytes.length % 4)) % 4);
  const binLen = bin.length + ((4 - (bin.length % 4)) % 4);
  const out = Buffer.alloc(12 + 8 + jsonLen + (binLen ? 8 + binLen : 0));
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonLen, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  Buffer.from(jsonBytes).copy(out, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen); // JSON pads with spaces
  if (binLen) {
    const o = 20 + jsonLen;
    out.writeUInt32LE(binLen, o);
    out.writeUInt32LE(0x004e4942, o + 4);
    Buffer.from(bin).copy(out, o + 8);
  }
  writeFileSync(file, out);
}

// An accessor's elements, tightly packed and de-interleaved.
function readAccessor(glb: Glb, i: number) {
  const acc = glb.json.accessors[i];
  if (acc.sparse) throw new Error("sparse accessors unsupported");
  const info = COMPONENT[acc.componentType];
  const n = NCOMP[acc.type];
  const elem = info.size * n;
  const bytes = new Uint8Array(acc.count * elem);
  if (acc.bufferView !== undefined) {
    const bv = glb.json.bufferViews[acc.bufferView];
    const stride = bv.byteStride ?? elem;
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    for (let e = 0; e < acc.count; e++) {
      bytes.set(
        glb.bin.subarray(base + e * stride, base + e * stride + elem),
        e * elem,
      );
    }
  }
  return {
    array: new info.arr(bytes.buffer, 0, acc.count * n),
    componentType: acc.componentType as number,
    type: acc.type as string,
    count: acc.count as number,
    normalized: !!acc.normalized,
    n,
  };
}

type Acc = ReturnType<typeof readAccessor>;

// ---------------------------------------------------------------- clustering

// Union-find over vertices whose positions lie within eps.
function clusterByPosition(pos: Float32Array, count: number, eps: number) {
  const parent = new Int32Array(count).map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  // Hash grid at cell size eps; a vertex only ever needs its 27 neighbours.
  const cell = Math.max(eps, 1e-12);
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const cellOf = (i: number) => [
    Math.floor(pos[3 * i] / cell),
    Math.floor(pos[3 * i + 1] / cell),
    Math.floor(pos[3 * i + 2] / cell),
  ];
  for (let i = 0; i < count; i++) {
    const [x, y, z] = cellOf(i);
    const k = key(x, y, z);
    const g = grid.get(k);
    if (g) g.push(i);
    else grid.set(k, [i]);
  }
  const eps2 = eps * eps;
  for (let i = 0; i < count; i++) {
    const [cx, cy, cz] = cellOf(i);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const g = grid.get(key(cx + dx, cy + dy, cz + dz));
          if (!g) continue;
          for (const k of g) {
            if (k <= i) continue;
            const ddx = pos[3 * i] - pos[3 * k],
              ddy = pos[3 * i + 1] - pos[3 * k + 1],
              ddz = pos[3 * i + 2] - pos[3 * k + 2];
            if (ddx * ddx + ddy * ddy + ddz * ddz <= eps2) union(i, k);
          }
        }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  return [...groups.values()];
}

// Split one position cluster into near-parallel normal sub-groups, so a
// genuine hard edge survives while sub-degree noise merges.
function subgroupByNormal(group: number[], nrm: Float32Array, cosSoft: number) {
  const buckets: { sum: [number, number, number]; members: number[] }[] = [];
  for (const v of group) {
    const vlen = Math.hypot(nrm[3 * v], nrm[3 * v + 1], nrm[3 * v + 2]) || 1;
    const x = nrm[3 * v] / vlen,
      y = nrm[3 * v + 1] / vlen,
      z = nrm[3 * v + 2] / vlen;
    let hit: (typeof buckets)[number] | undefined;
    for (const b of buckets) {
      const len = Math.hypot(...b.sum) || 1;
      if ((b.sum[0] * x + b.sum[1] * y + b.sum[2] * z) / len >= cosSoft) {
        hit = b;
        break;
      }
    }
    if (hit) {
      hit.sum[0] += x;
      hit.sum[1] += y;
      hit.sum[2] += z;
      hit.members.push(v);
    } else buckets.push({ sum: [x, y, z], members: [v] });
  }
  return buckets;
}

// ------------------------------------------------------------------ the weld

// Re-averaging an already-unified group lands a float32 ULP away from where
// it started. Report only changes above that, so a second pass over welded
// files honestly reports nothing to do.
const MOVE_FLOOR = 1e-9; // u, on models about 1 u across
const TURN_FLOOR = 1e-3; // deg

type PrimStats = {
  label: string;
  verts: number;
  outVerts: number;
  tris: number;
  posMoved: number;
  maxMove: number;
  nrmFixed: number;
  maxNrmDeg: number;
  hardKept: number;
  skinFixed: number;
  maxSkinDelta: number;
};

function weldPrimitive(
  glb: Glb,
  prim: Gltf,
  label: string,
  relEps: number,
  softDeg: number,
) {
  const attrs = Object.keys(prim.attributes);
  const src: Record<string, Acc> = {};
  for (const a of attrs) src[a] = readAccessor(glb, prim.attributes[a]);
  const count = src.POSITION.count;
  const pos = src.POSITION.array as Float32Array;
  const nrm = src.NORMAL ? (src.NORMAL.array as Float32Array) : null;
  const jt = src.JOINTS_0 ? src.JOINTS_0.array : null;
  const wt = src.WEIGHTS_0 ? (src.WEIGHTS_0.array as Float32Array) : null;

  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++)
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c], pos[3 * i + c]);
      hi[c] = Math.max(hi[c], pos[3 * i + c]);
    }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const eps = diag * relEps;
  const cosSoft = Math.cos((softDeg * Math.PI) / 180);

  const st: PrimStats = {
    label,
    verts: count,
    outVerts: 0,
    tris: 0,
    posMoved: 0,
    maxMove: 0,
    nrmFixed: 0,
    maxNrmDeg: 0,
    hardKept: 0,
    skinFixed: 0,
    maxSkinDelta: 0,
  };

  const groups = clusterByPosition(pos, count, eps);
  for (const g of groups) {
    if (g.length === 1) continue;

    // Position: one point for the whole cluster.
    const mid = [0, 0, 0];
    for (const v of g)
      for (let c = 0; c < 3; c++) mid[c] += pos[3 * v + c] / g.length;
    for (const v of g) {
      const d = Math.hypot(
        pos[3 * v] - mid[0],
        pos[3 * v + 1] - mid[1],
        pos[3 * v + 2] - mid[2],
      );
      if (d > MOVE_FLOOR) {
        st.posMoved++;
        st.maxMove = Math.max(st.maxMove, d);
      }
      for (let c = 0; c < 3; c++) pos[3 * v + c] = mid[c];
    }

    // Skin: one binding for the whole cluster — a hard edge must not tear
    // either, so this deliberately spans the normal sub-groups.
    if (jt && wt) {
      const acc = new Map<number, number>();
      for (const v of g)
        for (let c = 0; c < 4; c++) {
          const w = wt[4 * v + c];
          if (w > 0)
            acc.set(
              jt[4 * v + c],
              (acc.get(jt[4 * v + c]) ?? 0) + w / g.length,
            );
        }
      const top = [...acc.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, 4);
      const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
      let delta = 0;
      for (const v of g) {
        for (let c = 0; c < 4; c++) {
          const nj = top[c]?.[0] ?? 0;
          const nw = top[c] ? top[c][1] / sum : 0;
          delta = Math.max(
            delta,
            Math.abs(nw - (jt[4 * v + c] === nj ? wt[4 * v + c] : 0)),
          );
          jt[4 * v + c] = nj;
          wt[4 * v + c] = nw;
        }
      }
      if (delta > 1e-7) {
        st.skinFixed++;
        st.maxSkinDelta = Math.max(st.maxSkinDelta, delta);
      }
    }

    // Normal: unified per near-parallel sub-group only.
    if (nrm) {
      const buckets = subgroupByNormal(g, nrm, cosSoft);
      if (buckets.length > 1) st.hardKept++;
      for (const b of buckets) {
        if (b.members.length === 1) continue;
        const len = Math.hypot(...b.sum) || 1;
        const u = [b.sum[0] / len, b.sum[1] / len, b.sum[2] / len];
        let moved = false;
        for (const v of b.members) {
          // Divide out the stored length: a float32 unit normal is 1 +/- 1e-7
          // long, and acos near 1 turns that into a phantom 0.02 deg.
          const vlen =
            Math.hypot(nrm[3 * v], nrm[3 * v + 1], nrm[3 * v + 2]) || 1;
          const dot =
            (nrm[3 * v] * u[0] +
              nrm[3 * v + 1] * u[1] +
              nrm[3 * v + 2] * u[2]) /
            vlen;
          const ang =
            (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
          if (ang > TURN_FLOOR) {
            moved = true;
            st.maxNrmDeg = Math.max(st.maxNrmDeg, ang);
          }
          for (let c = 0; c < 3; c++) nrm[3 * v + c] = u[c];
        }
        if (moved) st.nrmFixed++;
      }
    }
  }

  // Collapse whatever is now byte-identical across EVERY attribute (UVs
  // included, so the atlas can never move), then re-index.
  const bytesOf: Record<string, Uint8Array> = {};
  const elemOf: Record<string, number> = {};
  for (const a of attrs) {
    const s = src[a];
    bytesOf[a] = new Uint8Array(
      s.array.buffer,
      s.array.byteOffset,
      s.array.byteLength,
    );
    elemOf[a] = COMPONENT[s.componentType].size * s.n;
  }
  const remap = new Int32Array(count).fill(-1);
  const kept: number[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    let k = "";
    for (const a of attrs)
      k +=
        Buffer.from(
          bytesOf[a].subarray(i * elemOf[a], (i + 1) * elemOf[a]),
        ).toString("latin1") + "|";
    const hit = seen.get(k);
    if (hit !== undefined) {
      remap[i] = hit;
      continue;
    }
    seen.set(k, kept.length);
    remap[i] = kept.length;
    kept.push(i);
  }
  st.outVerts = kept.length;

  const idxAcc =
    prim.indices !== undefined ? readAccessor(glb, prim.indices) : null;
  const oldIdx = idxAcc
    ? idxAcc.array
    : new Uint32Array(count).map((_, i) => i);
  const newIdx = new Uint32Array(oldIdx.length);
  for (let i = 0; i < oldIdx.length; i++) newIdx[i] = remap[oldIdx[i]];
  st.tris = oldIdx.length / 3;

  // Repack the kept vertices.
  const out: Record<string, { bytes: Uint8Array; acc: Acc }> = {};
  for (const a of attrs) {
    const e = elemOf[a];
    const packed = new Uint8Array(kept.length * e);
    kept.forEach((v, i) =>
      packed.set(bytesOf[a].subarray(v * e, (v + 1) * e), i * e),
    );
    out[a] = { bytes: packed, acc: src[a] };
  }
  return { st, out, newIdx, keptCount: kept.length };
}

// --------------------------------------------------------------- GLB rebuild

function rebuild(
  glb: Glb,
  edits: Map<
    number,
    {
      out: Record<string, { bytes: Uint8Array; acc: Acc }>;
      newIdx: Uint32Array;
      keptCount: number;
    }
  >,
) {
  const j = glb.json;
  const chunks: { bytes: Uint8Array; target?: number }[] = [];
  const addView = (bytes: Uint8Array, target?: number) => {
    chunks.push({ bytes, target });
    return chunks.length - 1;
  };

  // Images keep their bytes verbatim — the atlas must not be re-encoded.
  const imageBv = new Map<number, number>();
  for (const im of j.images ?? []) {
    if (im.bufferView === undefined) continue;
    const bv = j.bufferViews[im.bufferView];
    const at = bv.byteOffset ?? 0;
    imageBv.set(
      im.bufferView,
      addView(new Uint8Array(glb.bin.subarray(at, at + bv.byteLength))),
    );
  }

  // The accessors an edited primitive owns, keyed as before.
  type Repl = {
    bytes: Uint8Array;
    count: number;
    target: number;
    componentType?: number;
    type?: string;
  };
  const replaced = new Map<number, Repl>();
  j.meshes?.forEach((m: Gltf, mi: number) => {
    m.primitives.forEach((p: Gltf, pi: number) => {
      const e = edits.get(mi * 1000 + pi);
      if (!e) return;
      for (const a of Object.keys(p.attributes)) {
        replaced.set(p.attributes[a], {
          bytes: e.out[a].bytes,
          count: e.keptCount,
          target: 34962,
        });
      }
      if (p.indices !== undefined) {
        // Widen only if the mesh outgrew 16 bits; never narrow.
        const wide =
          e.keptCount > 65535 || j.accessors[p.indices].componentType === 5125;
        const arr = wide
          ? new Uint32Array(e.newIdx)
          : new Uint16Array(e.newIdx);
        replaced.set(p.indices, {
          bytes: new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength),
          count: e.newIdx.length,
          target: 34963,
          componentType: wide ? 5125 : 5123,
          type: "SCALAR",
        });
      }
    });
  });

  const accessors = j.accessors.map((acc: Gltf, i: number) => {
    const next: Gltf = { ...acc };
    delete next.byteOffset;
    const rep = replaced.get(i);
    if (!rep) {
      // Untouched (animation samplers, inverse bind matrices): copy through,
      // de-interleaved into a view of its own.
      if (acc.bufferView === undefined) return next;
      const { array } = readAccessor(glb, i);
      next.bufferView = addView(
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
        j.bufferViews[acc.bufferView].target,
      );
      return next;
    }
    next.count = rep.count;
    if (rep.componentType) next.componentType = rep.componentType;
    if (rep.type) next.type = rep.type;
    next.bufferView = addView(rep.bytes, rep.target);
    // Recompute bounds rather than carrying stale ones (POSITION requires them).
    if (acc.min || next.type === "VEC3") {
      const info = COMPONENT[next.componentType];
      const n = NCOMP[next.type];
      const view = new info.arr(
        rep.bytes.buffer,
        rep.bytes.byteOffset,
        rep.count * n,
      );
      const mn = Array(n).fill(Infinity);
      const mx = Array(n).fill(-Infinity);
      for (let e = 0; e < rep.count; e++)
        for (let c = 0; c < n; c++) {
          mn[c] = Math.min(mn[c], view[e * n + c]);
          mx[c] = Math.max(mx[c], view[e * n + c]);
        }
      next.min = mn;
      next.max = mx;
    }
    return next;
  });

  // Concatenate the views, each 4-byte aligned.
  let total = 0;
  const offsets = chunks.map((c) => {
    const o = total;
    total += c.bytes.length + ((4 - (c.bytes.length % 4)) % 4);
    return o;
  });
  const bin = new Uint8Array(total);
  chunks.forEach((c, i) => bin.set(c.bytes, offsets[i]));

  const out: Gltf = { ...j };
  out.accessors = accessors;
  out.bufferViews = chunks.map((c, i) => {
    const bv: Gltf = {
      buffer: 0,
      byteOffset: offsets[i],
      byteLength: c.bytes.length,
    };
    if (c.target) bv.target = c.target;
    return bv;
  });
  out.buffers = [{ byteLength: total }];
  if (j.images) {
    out.images = j.images.map((im: Gltf) =>
      im.bufferView === undefined
        ? im
        : { ...im, bufferView: imageBv.get(im.bufferView) },
    );
  }
  return { json: out, bin };
}

// ----------------------------------------------------------------------- CLI

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const relEps = Number(argv[argv.indexOf("--eps") + 1]) || 1e-5;
const softDeg = argv.includes("--soft")
  ? Number(argv[argv.indexOf("--soft") + 1])
  : 5;
const files = argv.filter(
  (a, i) =>
    !a.startsWith("--") && argv[i - 1] !== "--eps" && argv[i - 1] !== "--soft",
);
const targets = files.length
  ? files.map((f) => path.resolve(f))
  : readdirSync(MODELS)
      .filter((f) => f.endsWith(".glb"))
      .sort()
      .map((f) => path.join(MODELS, f));

console.log(
  `weld: eps ${relEps} of bbox diagonal, hard-edge threshold ${softDeg} deg${check ? "  (--check: nothing written)" : ""}`,
);

for (const file of targets) {
  const glb = readGlb(file);
  const j = glb.json;
  // The rebuild re-emits every bufferView, so anything holding a bufferView
  // this tool does not know about (a meshopt/Draco stream) must stop it.
  if (j.extensionsRequired?.length) {
    throw new Error(
      `${file}: requires extensions ${j.extensionsRequired.join(", ")}`,
    );
  }
  // Two primitives sharing one accessor would make an in-place edit ambiguous.
  const used = new Map<number, string>();
  j.meshes?.forEach((m: Gltf, mi: number) =>
    m.primitives.forEach((p: Gltf, pi: number) => {
      for (const a of [
        ...(Object.values(p.attributes) as number[]),
        ...(p.indices !== undefined ? [p.indices] : []),
      ]) {
        const at = `mesh${mi}/prim${pi}`;
        if (used.has(a))
          throw new Error(
            `${file}: accessor ${a} shared by ${used.get(a)} and ${at}`,
          );
        used.set(a, at);
      }
    }),
  );

  const edits = new Map<number, ReturnType<typeof weldPrimitive>>();
  const stats: PrimStats[] = [];
  j.meshes?.forEach((m: Gltf, mi: number) =>
    m.primitives.forEach((p: Gltf, pi: number) => {
      if ((p.mode ?? 4) !== 4) return;
      const r = weldPrimitive(glb, p, `mesh${mi}/prim${pi}`, relEps, softDeg);
      stats.push(r.st);
      edits.set(mi * 1000 + pi, r);
    }),
  );

  const before = readFileSync(file).length;
  const name = path.basename(file);
  console.log(`\n${name}`);
  for (const s of stats) {
    console.log(
      `  ${s.label}: ${s.verts} -> ${s.outVerts} verts, ${s.tris} tris (unchanged)\n` +
        `    positions snapped ${s.posMoved} (max move ${s.maxMove.toExponential(2)} u)\n` +
        `    normals unified   ${s.nrmFixed} groups (max turn ${s.maxNrmDeg.toFixed(3)} deg), hard edges kept ${s.hardKept}\n` +
        `    skin unified      ${s.skinFixed} groups (max weight delta ${s.maxSkinDelta.toFixed(4)})`,
    );
  }
  if (check) continue;
  const rebuilt = rebuild(glb, edits);
  writeGlb(file, rebuilt.json, rebuilt.bin);
  const after = readFileSync(file).length;
  console.log(
    `  written: ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB`,
  );
}
