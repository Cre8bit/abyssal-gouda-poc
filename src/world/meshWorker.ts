// meshWorker.ts — the mesh worker (WG-19/WG-20): one serialized chunk in,
// marching-cubes buffers out via transferables. All real work lives in
// sdf.ts (shared verbatim with the sync path, so worker output is
// bit-identical); this file is only the postMessage plumbing.
//
// Protocol: MeshJob → MeshResult, correlated by `id`. `field` present =
// remesh from a pre-dug field (the field is NOT echoed back); absent =
// fill from the chunk's SDF and return the filled field (`wantField`) so
// the main thread can cache it for digging.
import { meshChunkBuffers, type ChunkShape } from "./sdf.ts";

export interface MeshJob {
  id: number;
  chunk: ChunkShape;
  field?: Float32Array; // pre-dug voxel field (remesh path)
  wantField?: boolean; // return the filled field (initial build path)
}

export interface MeshResult {
  id: number;
  positions: Float32Array;
  normals: Float32Array;
  crust: Float32Array;
  vein: Float32Array | null;
  count: number;
  field: Float32Array | null;
}

// The worker global scope, structurally (tsconfig targets the dom lib).
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<MeshJob>) => void) | null;
  postMessage(msg: MeshResult, transfer: Transferable[]): void;
};

ctx.onmessage = (e: MessageEvent<MeshJob>) => {
  const { id, chunk, field, wantField } = e.data;
  const b = meshChunkBuffers(chunk, field ?? null);
  const result: MeshResult = {
    id,
    positions: b.positions,
    normals: b.normals,
    crust: b.crust,
    vein: b.vein,
    count: b.count,
    field: wantField ? b.field : null,
  };
  const transfer: Transferable[] = [
    b.positions.buffer,
    b.normals.buffer,
    b.crust.buffer,
  ];
  if (b.vein) transfer.push(b.vein.buffer);
  if (result.field) transfer.push(result.field.buffer);
  ctx.postMessage(result, transfer);
};
