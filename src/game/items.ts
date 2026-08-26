// items.ts — the typed registry for dynamic map objects (light sticks,
// traps, pickups, the Golden Gouda…). Born in TypeScript on purpose: this is
// the contract every roadmap feature consumes, so its shapes are enforced,
// not comment-documented.
//
// DESIGN (docs/plan-game-loop.md §2):
//  - SEEDED items (hazards placed at worldgen) cost zero network — every
//    client derives them from the seed and spawns with broadcast: false.
//  - DYNAMIC items (a dropped light stick) replicate as reliable events:
//    "item+" (spawn), "item-" (remove), "item*" (bulk snapshot for late
//    joiners). Ids are globally unique without coordination: minted as
//    "<myPeerId>#<counter>" (or "local#<counter>" before the mesh is up).
//  - This module owns DATA and dispatch only. Visuals/audio belong to each
//    kind's handlers (onSpawn/onRemove mount and unmount whatever they
//    like) — items.ts itself never imports three.js, so the registry stays
//    portable and worker-safe.
//
// The world is a live SDF, so items sitting on cheese can lose their floor
// to a dig: isSupported() probes the voxel field below an item — kinds that
// should fall or pop when undermined check it in onUpdate.
import { worldDistance } from "../world/gouda.ts";
import { getMyId } from "../net/mesh.ts";
import { sendEvent, sendEventTo } from "../net/sync.ts";
import type { Vec3 } from "../state.ts";
import type { FrameContext } from "../systems/types.ts";

export interface ItemInstance {
  id: string;
  kind: string;
  x: number;
  y: number;
  z: number;
  // Kind-specific payload. Replicated verbatim in "item+"/"item*" — keep it
  // small and JSON-serializable.
  data: Record<string, unknown>;
}

export interface ItemKindDef {
  kind: string;
  // Mount presentation (add meshes/lights to the scene, start sounds).
  onSpawn?(item: ItemInstance): void;
  // Per-frame behavior (burn down a timer, check isSupported, animate).
  onUpdate?(item: ItemInstance, ctx: FrameContext): void;
  // Unmount + dispose whatever onSpawn created.
  onRemove?(item: ItemInstance): void;
}

const kinds = new Map<string, ItemKindDef>();
const items = new Map<string, ItemInstance>();
let idCounter = 0;

export function registerItemKind(def: ItemKindDef): void {
  if (kinds.has(def.kind)) {
    throw new Error(`item kind "${def.kind}" registered twice`);
  }
  kinds.set(def.kind, def);
}

function mintId(): string {
  return `${getMyId() ?? "local"}#${++idCounter}`;
}

export interface SpawnOptions {
  // Deterministic/replicated spawns pass their own id; local mints one.
  id?: string;
  // false for seeded items (every client derives them) and applied replicas.
  broadcast?: boolean;
}

export function spawnItem(
  kind: string,
  pos: Vec3,
  data: Record<string, unknown> = {},
  { id, broadcast = true }: SpawnOptions = {},
): ItemInstance | null {
  const def = kinds.get(kind);
  if (!def) {
    console.warn(`[items] spawn of unregistered kind "${kind}" ignored`);
    return null;
  }
  const itemId = id ?? mintId();
  if (items.has(itemId)) return items.get(itemId) ?? null; // replicated twice
  const item: ItemInstance = {
    id: itemId,
    kind,
    x: pos.x,
    y: pos.y,
    z: pos.z,
    data,
  };
  items.set(itemId, item);
  def.onSpawn?.(item);
  if (broadcast) sendEvent({ kind: "item+", it: serialize(item) });
  return item;
}

export function removeItem(id: string, { broadcast = true } = {}): void {
  const item = items.get(id);
  if (!item) return;
  items.delete(id);
  kinds.get(item.kind)?.onRemove?.(item);
  if (broadcast) sendEvent({ kind: "item-", id });
}

export function getItem(id: string): ItemInstance | undefined {
  return items.get(id);
}

export function itemCount(): number {
  return items.size;
}

// Radius query (e.g. "is a light stick nearby?"). O(n) — fine at POC scale;
// spatial-index it only when profiling says so.
export function itemsNear(
  pos: Vec3,
  radius: number,
  kind?: string,
): ItemInstance[] {
  const out: ItemInstance[] = [];
  const r2 = radius * radius;
  for (const item of items.values()) {
    if (kind && item.kind !== kind) continue;
    const dx = item.x - pos.x;
    const dy = item.y - pos.y;
    const dz = item.z - pos.z;
    if (dx * dx + dy * dy + dz * dz <= r2) out.push(item);
  }
  return out;
}

// Is there solid cheese within `gap` units below the item? The SDF is live —
// a teammate's dig can carve the floor out from under a placed item.
export function isSupported(item: ItemInstance, gap = 1.5): boolean {
  return worldDistance(item.x, item.y - gap, item.z) <= 0;
}

// --- Replication -------------------------------------------------------------

interface SerializedItem {
  id: string;
  kind: string;
  x: number;
  y: number;
  z: number;
  data: Record<string, unknown>;
}

function serialize(item: ItemInstance): SerializedItem {
  return {
    id: item.id,
    kind: item.kind,
    x: item.x,
    y: item.y,
    z: item.z,
    data: item.data,
  };
}

function applyOne(raw: unknown): void {
  const it = raw as SerializedItem | null;
  if (!it || typeof it.id !== "string" || typeof it.kind !== "string") return;
  spawnItem(it.kind, { x: it.x, y: it.y, z: it.z }, it.data ?? {}, {
    id: it.id,
    broadcast: false,
  });
}

// Handle a replicated item event ("item+", "item-", "item*").
export function applyItemEvent(
  kind: string,
  data: Record<string, unknown>,
): void {
  if (kind === "item+") {
    applyOne(data.it);
  } else if (kind === "item-") {
    if (typeof data.id === "string") removeItem(data.id, { broadcast: false });
  } else if (kind === "item*") {
    if (Array.isArray(data.list)) for (const raw of data.list) applyOne(raw);
  }
}

// Bring a late joiner up to speed with every live dynamic item (the host
// calls this from onPeerConnected, right after the seed handshake).
export function sendItemSnapshotTo(peerId: string): void {
  if (items.size === 0) return;
  sendEventTo(peerId, {
    kind: "item*",
    list: [...items.values()].map(serialize),
  });
}

// Per-frame + reset entry points for the itemsSystem wrapper.
export function updateItems(ctx: FrameContext): void {
  for (const item of items.values()) {
    kinds.get(item.kind)?.onUpdate?.(item, ctx);
  }
}

export function clearItems(): void {
  for (const item of items.values()) {
    kinds.get(item.kind)?.onRemove?.(item);
  }
  items.clear();
}
