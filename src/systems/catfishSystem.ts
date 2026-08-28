// systems/catfishSystem.ts — everything catfish that ISN'T rendering.
//
// Wraps catfish.js (which owns models, animation, and the per-fish state
// machines) into the system contract:
//   update      — per-frame simulation/puppeting + the authority's ~8 Hz
//                 fish-state broadcast
//   "fish" event — a puppet applies the authority's states
//   disconnect  — deterministic authority election: lowest peer id among the
//                 survivors wins; every client computes the same result
//                 locally, so the school never goes masterless and no extra
//                 messages are needed
//   spawn()     — (re)release the school for a freshly built world
import {
  spawnCatfish,
  despawnCatfish,
  updateCatfishSystem,
  getCatfishState,
  applyCatfishState,
  setCatfishAuthority,
} from "../entities/catfish.ts";
import { getMyId, getPeerIds, getHostId } from "../net/mesh.ts";
import { sendEvent } from "../net/sync.ts";
import { playBite } from "../audio/ambience.ts";
import { game, type Vec3 } from "../state.ts";
import type { GameSystem } from "./types.ts";

const FISH_NET_INTERVAL = 0.12; // authority → puppets broadcast throttle (s)
const BITE_SHOVE = 9; // impulse away from the snapping jaws (u/s)

export interface CatfishSystemDeps {
  showEvent(text: string, durationMs?: number): void;
  // Hit callback; fish reports but doesn't know consequences (e.g., loss of grip).
  onDamage?(): void;
}

export interface CatfishSystem extends GameSystem {
  // Release the school for a new world (host/solo only — puppets get theirs
  // rebuilt by the authority's first "fish" state).
  spawn(difficulty: number): void;
}

export function createCatfishSystem({
  showEvent,
  onDamage,
}: CatfishSystemDeps): CatfishSystem {
  let netTimer = 0;

  const onBite = (fishPos: Vec3) => {
    const p = game.localPosition;
    const v = game.velocity;
    const dx = p.x - fishPos.x;
    const dy = p.y - fishPos.y;
    const dz = p.z - fishPos.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    v.x += (dx / d) * BITE_SHOVE;
    v.y += (dy / d) * BITE_SHOVE;
    v.z += (dz / d) * BITE_SHOVE;
    playBite();
    showEvent("🐟 A lantern-catfish snaps at you! Swim!");
    onDamage?.();
  };

  return {
    id: "catfish",
    order: 30,
    events: ["fish"],

    spawn(difficulty: number) {
      // Sync authority before async spawn (gates template load).
      setCatfishAuthority(game.fishAuthority);
      despawnCatfish();
      spawnCatfish(Math.min(8, 4 + difficulty), { onBite });
    },

    update({ dt, now, game, connected }) {
      // Mirror authority state (catfish.js gates on it).
      setCatfishAuthority(game.fishAuthority);
      updateCatfishSystem(
        dt,
        game.localPosition,
        now / 1000,
        game.remotePositions,
      );
      if (game.fishAuthority && connected) {
        netTimer += dt;
        if (netTimer >= FISH_NET_INTERVAL) {
          netTimer = 0;
          sendEvent({ kind: "fish", f: getCatfishState() });
        }
      }
    },

    onEvent(_fromPeerId, _kind, data) {
      if (!game.fishAuthority) applyCatfishState(data.f);
    },

    onPeerDisconnected(peerId) {
      // Elect new authority (lowest peer id, deterministic).
      if (peerId === (game.fishAuthorityId ?? getHostId())) {
        const candidates = [getMyId(), ...getPeerIds()]
          .filter((id): id is string => Boolean(id))
          .sort();
        game.fishAuthorityId = candidates[0] ?? getMyId();
        game.fishAuthority = game.fishAuthorityId === getMyId();
      }
      // Solo: assume authority.
      if (getPeerIds().length === 0) {
        game.fishAuthority = true;
        game.fishAuthorityId = getMyId();
      }
      setCatfishAuthority(game.fishAuthority);
    },

    reset() {
      netTimer = 0;
      despawnCatfish();
    },
  };
}
