// state.ts — the one place session-mutable game state lives.
//
// Before this module, position/velocity/seed/authority were module-level
// `let`s scattered across main.ts — nothing could reset them, so "replay
// with a new seed" or a lobby→game→lobby flow would inherit stale state.
// Now every system reads/writes the shared `game` object, and
// resetGameState() gives world rebuilds and host migration a clean slate.
//
// What does NOT live here: the mesh itself (net/mesh.ts owns peer
// records — connections outlive a world rebuild), rendering objects
// (render/graphics.ts), and per-frame scratch (pooled where it's used).
import { SnapshotBuffer } from "./net/interpolation.ts";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// One sphere carve out of the world. Also the wire shape of the "dig" event.
export interface SphereDig {
  x: number;
  y: number;
  z: number;
  r?: number; // omitted = the sender used the default dig radius
}

export interface GameState {
  // World identity — the host's values win; joiners rebuild on mismatch.
  seed: number;
  difficulty: number; // 1..3
  worldReady: boolean; // false while the labyrinth is carving
  // Digs received from peers mid-carve. gouda.ts only records a carve on the
  // chunks that exist when digAt() runs, so a dig applied during a build is
  // silently missing from every chunk carved after it — the map would diverge
  // from the sender's for good. Queue them here, replay once the world is up.
  pendingDigs: SphereDig[];

  // Local diver.
  localPosition: Vec3;
  velocity: Vec3;
  spawnPoint: Vec3; // bathyscaphe berth — also the O₂ recharge zone
  flashlightOn: boolean;

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
  hostedId: null,
  fishAuthority: true,
  fishAuthorityId: null,
  remoteBuffers: new Map(),
  remotePositions: [],
};

// Park the diver at a spawn: zero motion, forget remote interpolation history
// (so nobody sweeps across the map), used by teleports and world builds.
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

// Wipe everything a NEW WORLD must not inherit: motion and interpolation
// history. Peers/mesh survive (the crew stays connected across a rebuild);
// seed/difficulty change only when the caller passes them. Callers pair this
// with resetSystems() (systems/registry.ts) so statuses, oxygen and items
// reset through their own hooks — state.ts stays pure data.
export function resetGameState(
  opts: { seed?: number; difficulty?: number } = {},
): void {
  if (opts.seed !== undefined) game.seed = opts.seed >>> 0;
  if (opts.difficulty !== undefined) game.difficulty = opts.difficulty;
  game.worldReady = false;
  // Carves aimed at the world we are replacing — never replay them into the
  // new one. Callers reset before awaiting the build, so digs that arrive
  // during the carve still queue up behind this.
  game.pendingDigs.length = 0;
  game.velocity.x = game.velocity.y = game.velocity.z = 0;
  for (const buffer of game.remoteBuffers.values()) buffer.reset();
  game.remotePositions.length = 0;
}
