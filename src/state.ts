// state.ts — shared session-mutable game state, central reset point.
// Before: position/velocity/seed scattered as module-level `let`s → stale state on replay.
// Now: all systems use the `game` object; resetGameState() clears motion and interpolation.
// What does NOT live here: mesh/peers (net/mesh.ts), render objects (render/graphics.ts),
// or per-frame scratch.
import { SnapshotBuffer } from "./net/interpolation.ts";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// The two carve tools (WG-01). Hands open hardness 0; the driller opens ≤ 2;
// hardness 3 (the seals) yields to nothing.
export type DigTool = "hands" | "driller";

// One sphere carve out of the world. Also the wire shape of the "dig" event.
// When `c` is present the dig landed on a ROTATING chunk (WG-12): x/y/z are
// that chunk's local (unit) coords, resolved through the receiver's current
// orientation — a world point replayed at a different clock would land
// elsewhere on the cheese.
export interface SphereDig {
  x: number;
  y: number;
  z: number;
  r?: number; // omitted = the sender used the default dig radius
  tool?: DigTool; // omitted = hands (the conservative gate)
  c?: number; // rotating target's chunk index (chunk arrays are seed-identical)
}

// Debug aids
export interface DebugState {
  mode: boolean;
  freeCam: boolean;
  routeMarkers: boolean; // L key — soft spots + the melt-shell entrance
  routeIdx: number; // which of those the next Shift+L teleport lands on
}

export interface GameState {
  // World identity — the host's values win; joiners rebuild on mismatch.
  seed: number;
  difficulty: number; // 1..3
  worldReady: boolean; // false while the labyrinth is carving
  // Queued digs from peers; replayed once world build completes (prevents map divergence)
  pendingDigs: SphereDig[];

  // Local diver.
  localPosition: Vec3;
  velocity: Vec3;
  spawnPoint: Vec3; // bathyscaphe berth — also the O₂ recharge zone
  flashlightOn: boolean;
  digTool: DigTool; // "driller" iff drillerSystem says you're holding it
  debug: DebugState;
  mapWireframe: boolean; // [I] key — overlay only, survives independent of debug.mode

  // Session roles.
  hostedId: string | null; // our shareable id when we are the host
  fishAuthority: boolean; // solo & host simulate; false on join (until election)
  fishAuthorityId: string | null; // who currently simulates the fish

  // Remote divers.
  remoteBuffers: Map<string, SnapshotBuffer>; // peerId -> interpolation buffer
  remotePositions: Vec3[]; // rebuilt each frame — fish hunt the nearest diver
}

const DEFAULT_SPAWN: Vec3 = { x: 0, y: 5, z: 450 }; // pre-worldgen placeholder

export const game: GameState = {
  seed: 0,
  difficulty: 1,
  worldReady: false,
  pendingDigs: [],
  localPosition: { ...DEFAULT_SPAWN },
  velocity: { x: 0, y: 0, z: 0 },
  spawnPoint: { ...DEFAULT_SPAWN },
  flashlightOn: true,
  digTool: "hands",
  debug: { mode: false, freeCam: false, routeMarkers: false, routeIdx: 0 },
  mapWireframe: false,
  hostedId: null,
  fishAuthority: true,
  fishAuthorityId: null,
  remoteBuffers: new Map(),
  remotePositions: [],
};

// Teleport to spawn, zero motion, reset remote interpolation history.
export function placeAtSpawn(spawn: Vec3): void {
  game.spawnPoint.x = spawn.x;
  game.spawnPoint.y = spawn.y;
  game.spawnPoint.z = spawn.z;
  game.localPosition.x = spawn.x;
  game.localPosition.y = spawn.y;
  game.localPosition.z = spawn.z;
  game.velocity.x = game.velocity.y = game.velocity.z = 0;
  for (const buffer of game.remoteBuffers.values()) buffer.reset();
}

// Clear motion and interpolation (peers/mesh persist across rebuilds).
// Seed/difficulty update only if provided. Call with resetSystems() to reset all systems.
export function resetGameState(
  opts: { seed?: number; difficulty?: number } = {},
): void {
  if (opts.seed !== undefined) game.seed = opts.seed >>> 0;
  if (opts.difficulty !== undefined) game.difficulty = opts.difficulty;
  game.worldReady = false;
  // Discard old digs; new ones queue during build and replay after.
  game.pendingDigs.length = 0;
  game.velocity.x = game.velocity.y = game.velocity.z = 0;
  for (const buffer of game.remoteBuffers.values()) buffer.reset();
  game.remotePositions.length = 0;
}
