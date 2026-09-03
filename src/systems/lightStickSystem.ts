// systems/lightStickSystem.ts — the light sticks: the four chem batons every
// diver dives with, and the three things you can do with one (M3.2).
//
//   [G]   draw one from the belt, or put the drawn one back
//   [LMB] throw the drawn one — it flies, the water stops it, and it hangs
//         there burning, which is how you find your way back
//   [E]   pick a hanging one up again (yours or a teammate's)
//
// Two halves, split by what has to be agreed on:
//
// - The BELT is local. `game.lightSticks` never crosses the wire: nobody else
//   needs your count, only what you put in the water. The drawn stick is not
//   an item either — it is a pose plus a visual in your own paw, published as
//   STATUS.HOLDING_STICK (the arms) and the "stick" event (which of the grip's
//   three states the arms are in, so a remote throw animates in step).
// - A THROWN stick is an item (game/items.ts, kind "lightStick"), replicated
//   like any other. Its THROWER simulates the flight and resyncs while it
//   moves; at rest it is a fixture nobody has to think about again. Picking
//   one up is contested, so it goes through the host exactly like the driller
//   (systems/drillerSystem.ts) — the removal of the item IS the grant.
import {
  registerItemKind,
  spawnItem,
  removeItem,
  getItem,
  syncItem,
  heldBy,
  type ItemInstance,
} from "../game/items.ts";
import { CARGO, distance, holdPose, isSelf, selfId } from "../game/cargo.ts";
import {
  LIGHT_STICK_LENGTH,
  mountLightStick,
  unmountLightStick,
  getMountedLightStick,
} from "../entities/lightStick.ts";
import { STICK_DWELL, type StickPhase } from "../entities/diverRig.ts";
import { STATUS, setLocalStatus, hasLocalStatus } from "../game/effects.ts";
import { resolveCollision } from "../world/gouda.ts";
import { collideBathyscaphe } from "../world/bathyscaphe.ts";
import { getHostId } from "../net/mesh.ts";
import { sendEvent, sendEventTo } from "../net/sync.ts";
import { getYaw, getPitch } from "../input/input.ts";
import { game, LIGHT_STICKS_PER_DIVER, type Vec3 } from "../state.ts";
import type { GameSystem } from "./types.ts";

// --- Flight ------------------------------------------------------------------
const THROW_SPEED = 15; // u/s out of the paw, along the look
const STICK_DRAG = 1.7; // 1/s — water eats a throw in a couple of body lengths
const REST_SPEED = 0.35; // u/s under which it is simply hanging there
const WALL_DAMP = 0.25; // a baton hitting cheese does not bounce, it stops
const STICK_RADIUS = LIGHT_STICK_LENGTH * 0.6;
const LOOSE_SYNC_S = 0.12; // authoritative resync cadence while it flies

// How many burning sticks light the scene at once. Past this the vials still
// glow (they are unlit geometry) but their point lights are off: every live
// light is a per-material uniform slot and a shader recompile when the count
// moves, and a diver who has salted a gallery with a dozen of them should not
// pay for the ones behind them.
const MAX_LIVE_LIGHTS = 6;
// A stick we do not own arrives at LOOSE_SYNC_S, i.e. ~7 samples across a
// throw. Chasing them instead of snapping turns that into a flight (1/s).
const REMOTE_SMOOTH = 14;

type Action = "draw" | "stow" | "throw";

export interface LightStickSystemDeps {
  showEvent(text: string, durationMs?: number): void;
  // Contextual HUD line, or null to clear it. Lowest priority of the three
  // carry systems — the Gouda and the driller both speak over it.
  setPrompt(text: string | null): void;
  // The local first-person paw gains or loses its stick. Remote paws are
  // driven from STATUS.HOLDING_STICK instead — the bit is in every packet, so
  // a diver you swim up to is already holding what they are holding.
  holdInPaw(on: boolean): void;
  // A remote diver moved to another grip state (undefined = back to rest).
  setPeerPhase(peerId: string, phase: string | undefined): void;
  // Belt readout: how many are left, and whether one is in the paw.
  setBelt(count: number, drawn: boolean): void;
  // The throw itself, so main.ts can put a sound on it.
  onThrow(): void;
}

export interface LightStickSystem extends GameSystem {
  // [G]: draw one, or put the drawn one back. False = nothing to do.
  toggle(): boolean;
  // [LMB]: let the drawn one go. False when the paw is empty.
  hurl(): boolean;
  // The E-chain: pick a hanging stick up. True if it consumed the press.
  use(): boolean;
  // This frame's grip state for the local rig (main.ts hands it to graphics).
  phase(): string | undefined;
  // Death and other forced releases: the drawn stick goes back on the belt.
  stow(): void;
}

export function createLightStickSystem({
  showEvent,
  setPrompt,
  holdInPaw,
  setPeerPhase,
  setBelt,
  onThrow,
}: LightStickSystemDeps): LightStickSystem {
  // The paw: what is in it and what the arm is doing about it.
  let drawn = false;
  let action: Action | null = null;
  let actionT = 0;
  let phase: StickPhase | null = null;
  let sent: string | undefined;
  // A throw asked for while the paw is still reaching for the belt. Held so
  // that [G] immediately followed by a click throws, instead of eating the
  // press — the draw is a third of a second and nobody waits it out.
  let queuedThrow = false;
  // Every thrown stick alive in the world, so the light budget and the flight
  // integrator do not have to walk the whole item registry.
  const live = new Set<string>();
  let looseSyncTimer = 0;
  let mintCounter = 0;

  const _pos: Vec3 = { x: 0, y: 0, z: 0 };
  const _paw: Vec3 = { x: 0, y: 0, z: 0 };
  const _vel: Vec3 = { x: 0, y: 0, z: 0 };

  // Same arbiter test as cargoSystem/drillerSystem: null on the host AND solo.
  const isAuthority = () => getHostId() === null;

  // Reads into the scratch above — fly() runs per frame per airborne stick.
  const velOf = (item: ItemInstance): Vec3 => {
    _vel.x = (item.data.vx as number) ?? 0;
    _vel.y = (item.data.vy as number) ?? 0;
    _vel.z = (item.data.vz as number) ?? 0;
    return _vel;
  };
  const isMoving = (item: ItemInstance) => item.data.moving === true;
  const isMine = (item: ItemInstance) => isSelf(item.data.owner as string);

  // --- The paw ---------------------------------------------------------------

  // Publish the grip state, so a remote diver's arms walk the same three
  // placements ours do. Four small messages per stick — the status mask
  // carries the steady state, this carries only the transitions.
  function publish(next: StickPhase | null): void {
    phase = next;
    const wire = next ?? "";
    if (wire === (sent ?? "")) return;
    sent = wire;
    sendEvent({ kind: "stick", p: wire });
  }

  function handsFull(): boolean {
    return hasLocalStatus(STATUS.CARRYING) || !!heldBy(selfId());
  }

  function toggle(): boolean {
    if (action) return true; // mid-animation — swallow the press
    if (drawn) {
      action = "stow";
      actionT = 0;
      publish("grab");
      return true;
    }
    if (handsFull()) {
      showEvent("🔆 Both paws are full — put that down first.");
      return true;
    }
    if (game.lightSticks <= 0) {
      showEvent("🔆 Your belt is empty — go collect the ones you threw.");
      return true;
    }
    drawn = true;
    action = "draw";
    actionT = 0;
    setLocalStatus(STATUS.HOLDING_STICK, true);
    holdInPaw(true);
    publish("grab");
    return true;
  }

  function hurl(): boolean {
    if (!drawn || action === "stow" || action === "throw") return false;
    if (action === "draw") {
      queuedThrow = true;
      return true;
    }
    action = "throw";
    actionT = 0;
    publish("throw");
    return true;
  }

  // The release, halfway into the swing: the belt loses one, the water gains
  // an item, and the paw empties while the arm is still following through.
  function release(): void {
    drawn = false;
    holdInPaw(false);
    game.lightSticks = Math.max(0, game.lightSticks - 1);

    const yaw = getYaw();
    const pitch = getPitch();
    holdPose(game.localPosition, yaw, pitch, _paw);
    const cosP = Math.cos(pitch);
    const dir = {
      x: -Math.sin(yaw) * cosP,
      y: Math.sin(pitch),
      z: -Math.cos(yaw) * cosP,
    };
    spawnItem(
      "lightStick",
      _paw,
      {
        owner: selfId(),
        moving: true,
        // The diver's own motion rides along, so a stick thrown while
        // sprinting forward does not hang in the water behind them.
        vx: dir.x * THROW_SPEED + game.velocity.x,
        vy: dir.y * THROW_SPEED + game.velocity.y,
        vz: dir.z * THROW_SPEED + game.velocity.z,
      },
      { id: `stick:${selfId()}:${++mintCounter}` },
    );
    onThrow();
  }

  // Advance whichever timeline is running. Returns nothing — `phase`, `drawn`
  // and the status bit are the outputs.
  function stepAction(dt: number): void {
    if (!action) return;
    actionT += dt;
    if (action === "draw") {
      if (actionT < STICK_DWELL.grab) return;
      action = null;
      publish("hold");
      if (queuedThrow) {
        queuedThrow = false;
        hurl();
      }
      return;
    }
    if (action === "stow") {
      if (actionT < STICK_DWELL.grab) return;
      action = null;
      drawn = false;
      holdInPaw(false);
      setLocalStatus(STATUS.HOLDING_STICK, false);
      publish(null);
      return;
    }
    // throw
    if (drawn && actionT >= STICK_DWELL.release) release();
    if (actionT < STICK_DWELL.throw) return;
    action = null;
    setLocalStatus(STATUS.HOLDING_STICK, false);
    publish(null);
  }

  function stow(): void {
    queuedThrow = false;
    if (!drawn && !action) return;
    if (drawn) holdInPaw(false);
    drawn = false;
    action = null;
    actionT = 0;
    setLocalStatus(STATUS.HOLDING_STICK, false);
    publish(null);
  }

  // --- Picking one back up (contested — the host decides) --------------------

  function request(kind: string, payload: Record<string, unknown>): void {
    const hostId = getHostId();
    if (isAuthority() || !hostId) arbitrate(selfId(), kind, payload);
    else sendEventTo(hostId, { kind, ...payload });
  }

  function arbitrate(
    from: string,
    kind: string,
    data: Record<string, unknown>,
  ): void {
    if (kind !== "stickTake" || typeof data.id !== "string") return;
    const item = getItem(data.id);
    if (!item || item.kind !== "lightStick" || isMoving(item)) return;
    if (!withinReach(from, item)) return;
    // The removal IS the grant: the loser of a race sees the item vanish and
    // nothing else, so no two clients can both believe they took it.
    removeItem(item.id);
    if (isSelf(from)) grant();
    else sendEventTo(from, { kind: "stickGot" });
  }

  function grant(): void {
    game.lightSticks = Math.min(LIGHT_STICKS_PER_DIVER, game.lightSticks + 1);
    showEvent(`🔆 Light stick recovered — ${game.lightSticks} on the belt.`);
  }

  function withinReach(peerId: string, item: ItemInstance): boolean {
    if (isSelf(peerId)) {
      return distance(game.localPosition, item) <= CARGO.PICKUP_RANGE;
    }
    const s = game.remoteBuffers.get(peerId)?.sample();
    return !!s && distance(s, item) <= CARGO.PICKUP_RANGE * 2;
  }

  // The nearest hanging stick within arm's reach, or null.
  function reachable(): ItemInstance | null {
    let best: ItemInstance | null = null;
    let bestD: number = CARGO.PICKUP_RANGE;
    for (const id of live) {
      const item = getItem(id);
      if (!item || isMoving(item)) continue;
      const d = distance(game.localPosition, item);
      if (d <= bestD) {
        best = item;
        bestD = d;
      }
    }
    return best;
  }

  function use(): boolean {
    if (game.lightSticks >= LIGHT_STICKS_PER_DIVER) return false;
    const item = reachable();
    if (!item) return false;
    request("stickTake", { id: item.id });
    return true;
  }

  // --- Flight ----------------------------------------------------------------
  // Only the thrower integrates; everyone else renders what it syncs. Water
  // is the whole physics: drag until the throw is spent, then it hangs where
  // it stopped (a chem baton is neutrally buoyant — it neither sinks nor
  // rises, which is exactly what makes it a breadcrumb).
  function fly(item: ItemInstance, dt: number): void {
    const v = velOf(item);
    const damp = Math.exp(-STICK_DRAG * dt);
    v.x *= damp;
    v.y *= damp;
    v.z *= damp;

    _pos.x = item.x + v.x * dt;
    _pos.y = item.y + v.y * dt;
    _pos.z = item.z + v.z * dt;
    const hit =
      resolveCollision(_pos, STICK_RADIUS) ??
      collideBathyscaphe(_pos, STICK_RADIUS);
    if (hit) {
      v.x *= WALL_DAMP;
      v.y *= WALL_DAMP;
      v.z *= WALL_DAMP;
    }
    item.x = _pos.x;
    item.y = _pos.y;
    item.z = _pos.z;
    item.data.vx = v.x;
    item.data.vy = v.y;
    item.data.vz = v.z;
    if (Math.hypot(v.x, v.y, v.z) < REST_SPEED) {
      item.data.moving = false;
      item.data.vx = item.data.vy = item.data.vz = 0;
      syncItem(item.id);
    }
  }

  // --- Presentation ----------------------------------------------------------
  // Place every world stick and spend the light budget on the nearest few.
  function drawWorld(now: number, dt: number): void {
    let lit = 0;
    const ordered =
      live.size <= MAX_LIVE_LIGHTS ? [...live] : byDistance([...live]);
    const k = 1 - Math.exp(-REMOTE_SMOOTH * dt);
    for (const id of ordered) {
      const item = getItem(id);
      const visual = getMountedLightStick(id);
      if (!item || !visual) continue;
      const at = visual.group.position;
      if (isMoving(item) && !isMine(item)) {
        at.x += (item.x - at.x) * k;
        at.y += (item.y - at.y) * k;
        at.z += (item.z - at.z) * k;
      } else {
        at.set(item.x, item.y, item.z);
      }
      visual.setLightOn(lit++ < MAX_LIVE_LIGHTS);
      visual.update(now, false);
    }
  }

  function byDistance(ids: string[]): string[] {
    const d = (id: string) => {
      const item = getItem(id);
      return item ? distance(game.localPosition, item) : Infinity;
    };
    return ids.sort((a, b) => d(a) - d(b));
  }

  // --- HUD -------------------------------------------------------------------
  function updatePrompt(): void {
    if (drawn) {
      setPrompt("🔆 light stick lit — [LMB] throw · [G] stow");
      return;
    }
    if (game.lightSticks < LIGHT_STICKS_PER_DIVER && reachable()) {
      setPrompt("🔆 [E] collect the light stick");
      return;
    }
    setPrompt(null);
  }

  return {
    id: "lightStick",
    order: 37, // after the driller (36): both speak to the same HUD line
    events: ["stick", "stickTake", "stickGot"],

    init() {
      registerItemKind({
        kind: "lightStick",
        onSpawn: (item) => {
          live.add(item.id);
          const visual = mountLightStick(item.id);
          visual?.group.position.set(item.x, item.y, item.z);
        },
        onRemove: (item) => {
          live.delete(item.id);
          unmountLightStick(item.id);
        },
      });
    },

    toggle,
    hurl,
    use,
    stow,
    phase: () => phase ?? undefined,

    update({ dt, now, connected }) {
      // Both paws just filled with something else (a hand-off, a pickup):
      // the drawn stick goes back on the belt rather than clipping through.
      if (drawn && action !== "throw" && handsFull()) stow();
      stepAction(dt);
      setBelt(game.lightSticks, drawn);

      let anyMoving = false;
      for (const id of live) {
        const item = getItem(id);
        if (!item || !isMoving(item)) continue;
        anyMoving = true;
        if (isMine(item)) fly(item, dt);
      }
      if (anyMoving && connected) {
        looseSyncTimer += dt;
        if (looseSyncTimer >= LOOSE_SYNC_S) {
          looseSyncTimer = 0;
          for (const id of live) {
            const item = getItem(id);
            if (item && isMoving(item) && isMine(item)) syncItem(id);
          }
        }
      }

      drawWorld(now / 1000, dt);
      updatePrompt();
    },

    onEvent(fromPeerId, kind, data) {
      if (kind === "stick") {
        const p = typeof data.p === "string" ? data.p : "";
        setPeerPhase(fromPeerId, p || undefined);
      } else if (kind === "stickGot") {
        grant();
      } else if (isAuthority()) {
        arbitrate(fromPeerId, kind, data);
      }
    },

    onPeerDisconnected(peerId) {
      setPeerPhase(peerId, undefined);
      if (!isAuthority()) return;
      // Their thrown sticks keep burning — nobody is left to integrate the
      // ones still in flight, so the host freezes them where they are.
      for (const id of live) {
        const item = getItem(id);
        if (!item || item.data.owner !== peerId || !isMoving(item)) continue;
        item.data.moving = false;
        item.data.vx = item.data.vy = item.data.vz = 0;
        syncItem(id);
      }
    },

    reset() {
      // clearItems() (itemsSystem) fires onRemove for every stick, which
      // empties `live` and unmounts the visuals.
      stow();
      queuedThrow = false;
      sent = undefined;
      looseSyncTimer = 0;
      mintCounter = 0;
      setPrompt(null);
    },
  };
}
