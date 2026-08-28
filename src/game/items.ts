// items.ts — registry for dynamic map objects with per-kind handlers.
// Seeded items cost zero network (broadcast: false); dynamic items replicate
// as events (item+, item-, item*). Data and dispatch only; visuals/audio
// belong to kind handlers. Supports world support checks (isSupported) for
// items on the live SDF.
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
  // Kind-specific payload; keep small and JSON-serializable.
  data: Record<string, unknown>;
}

export interface ItemKindDef {
  kind: string;
  // Mount presentation.
  onSpawn?(item: ItemInstance): void;
  // Per-frame behavior.
  onUpdate?(item: ItemInstance, ctx: FrameContext): void;
  // Apply authoritative correction (position/data changed).
  onSync?(item: ItemInstance): void;
  // Unmount and dispose.
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
  // Deterministic spawns pass their own id; local mints one.
  id?: string;
  // false for seeded/replicated items.
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
  return item; // replicated twice → idempotent
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

// Radius query; O(n) for now.
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

// Check if item has floor support (SDF is live).
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
  const existing = items.get(it.id);
  if (existing) {
    // Authoritative correction: update in place (e.g., Gouda moved).
    existing.x = it.x;
    existing.y = it.y;
    existing.z = it.z;
    existing.data = it.data ?? {};
    kinds.get(existing.kind)?.onSync?.(existing);
    return;
  }
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

// Broadcast item's state (authoritative answer for contested pickups).
export function syncItem(id: string): void {
  const item = items.get(id);
  if (item) sendEvent({ kind: "item*", list: [serialize(item)] });
}

// Request item snapshot from peer (after world rebuild).
export function requestItemSnapshotFrom(peerId: string): void {
  sendEventTo(peerId, { kind: "items?" });
}

// Send snapshot of all live items to late joiner.
export function sendItemSnapshotTo(peerId: string): void {
  if (items.size === 0) return;
  sendEventTo(peerId, {
    kind: "item*",
    list: [...items.values()].map(serialize),
  });
}

// System entry points for update and reset.
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
