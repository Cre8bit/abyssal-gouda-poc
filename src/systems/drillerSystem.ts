// systems/drillerSystem.ts — the driller: ownership arbitration and handoff
// for the one tool that opens hardness 1-2 rind (M3.1). Same pick/give/drop
// shape as systems/cargoSystem.ts (the Golden Gouda) — same host-authoritative
// arbitration, same hold offsets — but it is a TOOL, not cargo: no win check,
// no sprint fumble, no speed penalty, and holding it is what lets you dig
// with it, so it never blocks digging the way STATUS.CARRYING does.
import {
  registerItemKind,
  spawnItem,
  getItem,
  syncItem,
  heldBy,
  type ItemInstance,
} from "../game/items.ts";
import {
  CARGO,
  LOCAL_ID,
  distance,
  fpHoldPose,
  holdPose,
  isSelf,
  nearestTeammate,
  selfId,
} from "../game/cargo.ts";
import {
  DRILLER_LENGTH,
  mountDriller,
  unmountDriller,
  getMountedDriller,
} from "../entities/driller.ts";
import { STATUS, setLocalStatus } from "../game/effects.ts";
import { resolveCollision, getSeededProps } from "../world/gouda.ts";
import { collideBathyscaphe } from "../world/bathyscaphe.ts";
import { getHostId, getMyId } from "../net/mesh.ts";
import { sendEventTo } from "../net/sync.ts";
import { getYaw, getPitch } from "../input/input.ts";
import { game, type Vec3 } from "../state.ts";
import type { GameSystem } from "./types.ts";

// One driller per run, seeded in the drift wreck (M3.1) — every client seeds
// it under the same name, so the id never has to be minted or agreed on.
const DRILLER_ID = "driller";
// Dropped driller sinks at a flat rate — no catch window, no fumble: a
// deliberate drop or a death, never something a bite knocks loose.
const DRILLER_SINK = 1.3; // u/s
const DRILLER_RADIUS = DRILLER_LENGTH / 2; // collision probe vs the world/bell
const LOOSE_SYNC_S = 0.12; // periodic authoritative resync while falling

export interface DrillerSystemDeps {
  showEvent(text: string, durationMs?: number): void;
  // Contextual HUD line, or null to clear it. Only ever set when the Gouda's
  // own prompt (cargoSystem, higher priority) has nothing to say.
  setPrompt(text: string | null): void;
  // Park the driller in the carrier's right paw, so it rides the arm's own
  // swim sway. False means no rig took it — place it in the world by hand.
  holdInPaw(peerId: string | null, self: boolean): boolean;
}

export interface DrillerSystem extends GameSystem {
  // Seed the driller into a freshly built world (main.ts, after worldReady).
  spawn(): void;
  // The contextual verb behind the action key: pick it up, or hand it over.
  // Returns true if it consumed the press (main.ts falls through otherwise).
  use(): boolean;
  // Deliberate drop (G key). Returns false (no-op) if you aren't holding it.
  drop(reason?: string): boolean;
  // One bite of cheese: spin the bit up, whoever is holding it. Driven by
  // the dig path in main.ts, local digs and replayed remote ones alike.
  strike(): void;
  // Re-pose a carried driller AFTER physics has moved the diver this frame —
  // same reason as cargoSystem.followCarrier: posing it pre-physics leaves
  // it a frame behind the camera.
  followCarrier(): void;
  // We just acquired a peer id (hosted or joined) — re-file a driller held
  // under the pre-connect "local" placeholder (same reason as cargoSystem).
  rebindLocalId(): void;
}

export function createDrillerSystem({
  showEvent,
  setPrompt,
  holdInPaw,
}: DrillerSystemDeps): DrillerSystem {
  let lastHolder: string | null = null;
  let looseSyncTimer = 0;

  const _pos: Vec3 = { x: 0, y: 0, z: 0 };
  const _hold: Vec3 = { x: 0, y: 0, z: 0 };
  const _view: Vec3 = { x: 0, y: 0, z: 0 };

  // --- Authority (same test as cargoSystem — see its comment) ---------------
  const isAuthority = () => getHostId() === null;

  function request(kind: string, payload: Record<string, unknown> = {}): void {
    const hostId = getHostId();
    const msg = { id: DRILLER_ID, ...payload };
    if (isAuthority() || !hostId) arbitrate(selfId(), kind, msg);
    else sendEventTo(hostId, { kind, ...msg });
  }

  function arbitrate(
    from: string,
    kind: string,
    data: Record<string, unknown>,
  ): void {
    if (data.id !== DRILLER_ID) return; // another carry system's request
    const item = getItem(DRILLER_ID);
    if (!item) return;
    const holder = holderOf(item);

    if (kind === "pick") {
      if (holder === null && withinReach(from, item) && !heldBy(from))
        setHolder(item, from);
      else syncItem(DRILLER_ID);
      return;
    }
    if (holder !== from) {
      syncItem(DRILLER_ID);
      return;
    }
    if (kind === "give" && typeof data.to === "string") {
      setHolder(item, data.to);
    } else if (kind === "drop") {
      if (typeof data.x === "number") item.x = data.x;
      if (typeof data.y === "number") item.y = data.y;
      if (typeof data.z === "number") item.z = data.z;
      setHolder(item, null);
    }
  }

  function withinReach(peerId: string, item: ItemInstance): boolean {
    if (isSelf(peerId)) {
      return distance(game.localPosition, item) <= CARGO.PICKUP_RANGE;
    }
    const s = game.remoteBuffers.get(peerId)?.sample();
    if (!s) return false;
    return distance(s, item) <= CARGO.PICKUP_RANGE * 2;
  }

  function setHolder(item: ItemInstance, holder: string | null): void {
    item.data.holder = holder;
    item.data.falling = holder === null;
    reconcile(item);
    syncItem(DRILLER_ID);
  }

  function isFalling(item: ItemInstance): boolean {
    return item.data.falling === true;
  }

  function holderOf(item: ItemInstance): string | null {
    const h = item.data.holder;
    return typeof h === "string" ? h : null;
  }

  // --- Local reaction to a change of hands ----------------------------------
  // Unlike the Gouda: no torch, no STATUS.CARRYING (that bit blocks digging;
  // the driller IS the dig tool). game.digTool is the one thing that has to
  // flip in lockstep with who's holding it.
  function reconcile(item: ItemInstance): void {
    const holder = holderOf(item);
    if (holder === lastHolder) return;
    const wasMine = isSelf(lastHolder);
    const isMine = isSelf(holder);
    lastHolder = holder;

    if (isMine && !wasMine) {
      game.digTool = "driller";
      setLocalStatus(STATUS.HOLDING_DRILLER, true);
      showEvent("🛠 The driller — heavy, and loud when it bites.");
    } else if (!isMine && wasMine) {
      game.digTool = "hands";
      setLocalStatus(STATUS.HOLDING_DRILLER, false);
    }
  }

  // --- The verbs ------------------------------------------------------------
  function use(): boolean {
    const item = getItem(DRILLER_ID);
    if (!item) return false;
    const holder = holderOf(item);

    if (isSelf(holder)) {
      // Hand-off — same cooperative verb as the Gouda.
      const mate = nearestTeammate(game.localPosition);
      if (!mate || mate.d > CARGO.HANDOFF_RANGE) {
        showEvent("🛠 Nobody close enough to take it.");
        return true;
      }
      request("give", { to: mate.id });
      showEvent(`🤝 Handing the driller to ${mate.id.slice(0, 4)}…`);
      return true;
    }

    if (holder !== null) return false; // someone else has it — no stealing
    if (distance(game.localPosition, item) > CARGO.PICKUP_RANGE) return false;
    if (heldBy(selfId())) {
      showEvent("🛠 Both hands are full — drop what you're carrying first.");
      return true;
    }
    request("pick");
    return true;
  }

  function release(reason: string): void {
    const item = getItem(DRILLER_ID);
    if (!item || !isSelf(holderOf(item))) return;
    holdPose(game.localPosition, getYaw(), getPitch(), _hold);
    request("drop", { x: _hold.x, y: _hold.y, z: _hold.z });
    showEvent(reason, 3200);
  }

  function drop(reason = "🛠 You set the driller down."): boolean {
    const item = getItem(DRILLER_ID);
    if (!item || !isSelf(holderOf(item))) return false;
    release(reason);
    return true;
  }

  // --- Loose-driller physics --------------------------------------------------
  function fall(item: ItemInstance, dt: number): void {
    if (!isFalling(item)) return;
    _pos.x = item.x;
    _pos.y = item.y - DRILLER_SINK * dt;
    _pos.z = item.z;

    const hit = resolveCollision(_pos, DRILLER_RADIUS);
    const bell = collideBathyscaphe(_pos, DRILLER_RADIUS);
    item.x = _pos.x;
    item.y = _pos.y;
    item.z = _pos.z;
    // Landed on something: it stays put until someone picks it up again.
    if ((hit && hit.y > 0.2) || (bell && bell.y > 0.2)) {
      if (isAuthority()) {
        item.data.falling = false;
        syncItem(DRILLER_ID);
      }
    }
  }

  function placeVisual(item: ItemInstance, holder: string | null): void {
    const visual = getMountedDriller();
    if (!visual) return;
    const self = isSelf(holder);
    // In a paw the arm owns the transform; the rest is a world placement.
    if (holdInPaw(holder === null ? null : holder, self)) return;
    if (self) {
      fpHoldPose(game.localPosition, getYaw(), getPitch(), _view);
      visual.group.position.set(_view.x, _view.y, _view.z);
    } else {
      visual.group.position.set(item.x, item.y, item.z);
    }
  }

  // --- HUD ------------------------------------------------------------------
  function updatePrompt(item: ItemInstance, holder: string | null): void {
    if (isSelf(holder)) {
      const mate = nearestTeammate(game.localPosition);
      setPrompt(
        mate && mate.d <= CARGO.HANDOFF_RANGE
          ? `🤝 [E] hand the driller to ${mate.id.slice(0, 4)}`
          : "🛠 carrying the driller",
      );
      return;
    }
    if (holder !== null) {
      setPrompt(null);
      return;
    }
    const d = distance(game.localPosition, item);
    if (d <= CARGO.PICKUP_RANGE) {
      setPrompt(
        heldBy(selfId()) ? "🛠 hands full" : "🛠 [E] pick up the driller",
      );
    } else {
      setPrompt(null);
    }
  }

  return {
    id: "driller",
    order: 36, // right after cargo (35): the Gouda's prompt/pick wins ties
    events: ["pick", "give", "drop"],

    init() {
      registerItemKind({
        kind: "driller",
        onSpawn: () => {
          mountDriller();
        },
        onRemove: () => {
          unmountDriller();
        },
        onSync: (item) => reconcile(item),
      });
    },

    spawn() {
      const wreck = getSeededProps().find((p) => p.kind === "wreck");
      if (!wreck) {
        console.warn("[driller] world has no wreck prop — no driller seeded");
        return;
      }
      // Seeded: identical on every client, so it costs nothing to place and
      // a late joiner who rebuilt the same map already has it.
      console.log(
        "[driller] spawning driller at wreck position",
        wreck.pos.x,
        ",",
        wreck.pos.y,
        ",",
        wreck.pos.z,
      );
      spawnItem(
        "driller",
        wreck.pos,
        { holder: null, falling: false },
        { id: DRILLER_ID, broadcast: false },
      );
    },

    use,
    drop,

    strike() {
      getMountedDriller()?.strike();
    },

    followCarrier() {
      const item = getItem(DRILLER_ID);
      if (!item || !isSelf(holderOf(item))) return;
      holdPose(game.localPosition, getYaw(), getPitch(), _hold);
      item.x = _hold.x;
      item.y = _hold.y;
      item.z = _hold.z;
      placeVisual(item, holderOf(item));
    },

    rebindLocalId() {
      const item = getItem(DRILLER_ID);
      const myId = getMyId();
      if (!item || !myId || item.data.holder !== LOCAL_ID) return;
      item.data.holder = myId;
      lastHolder = myId;
    },

    update({ dt, connected }) {
      const item = getItem(DRILLER_ID);
      const visual = getMountedDriller();
      if (!item) {
        setPrompt(null);
        return;
      }
      const holder = holderOf(item);
      if (holder !== lastHolder) reconcile(item);

      if (holder !== null) {
        if (isSelf(holder)) {
          holdPose(game.localPosition, getYaw(), getPitch(), _hold);
          item.x = _hold.x;
          item.y = _hold.y;
          item.z = _hold.z;
        } else {
          const s = game.remoteBuffers.get(holder)?.sample();
          if (s) {
            _pos.x = s.x;
            _pos.y = s.y;
            _pos.z = s.z;
            holdPose(_pos, s.yaw ?? 0, s.pitch ?? 0, _hold);
            item.x = _hold.x;
            item.y = _hold.y;
            item.z = _hold.z;
          }
        }
      } else {
        fall(item, dt);
        if (isAuthority() && connected && isFalling(item)) {
          looseSyncTimer += dt;
          if (looseSyncTimer >= LOOSE_SYNC_S) {
            looseSyncTimer = 0;
            syncItem(DRILLER_ID);
          }
        }
      }

      visual?.update(performance.now() / 1000, holder !== null);
      placeVisual(item, holder);
      updatePrompt(item, holder);
    },

    onEvent(fromPeerId, kind, data) {
      if (isAuthority()) arbitrate(fromPeerId, kind, data);
    },

    onPeerDisconnected(peerId) {
      const item = getItem(DRILLER_ID);
      if (!item || holderOf(item) !== peerId) return;
      if (isAuthority()) setHolder(item, null);
      else {
        item.data.holder = null;
        reconcile(item);
      }
      showEvent("🛠 The carrier is gone — the driller is adrift.", 3200);
    },

    reset() {
      lastHolder = null;
      looseSyncTimer = 0;
      setPrompt(null);
    },
  };
}
