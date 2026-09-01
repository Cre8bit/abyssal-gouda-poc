// systems/cargoSystem.ts — Golden Gouda ownership arbitration and handoff.
// Carrier-side logic: pickup, drop, hand-over requests sent to host for
// authority. Local reaction to sync messages: torch, status, falling state.
// Loose wheel physics: catch window, sink, synchronization.
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
  looseSinkRate,
  nearestTeammate,
  selfId,
  sprintFumbleChance,
} from "../game/cargo.ts";
import {
  GOUDA_RADIUS,
  mountGouda,
  unmountGouda,
  getMountedGouda,
} from "../entities/goldenGouda.ts";
import { STATUS, setLocalStatus } from "../game/effects.ts";
import { getGoldPos, resolveCollision } from "../world/gouda.ts";
import { collideBathyscaphe } from "../world/bathyscaphe.ts";
import { getHostId, getMyId } from "../net/mesh.ts";
import { sendEvent, sendEventTo } from "../net/sync.ts";
import { getYaw, getPitch, isSprinting } from "../input/input.ts";
import { game, type Vec3 } from "../state.ts";
import type { GameSystem } from "./types.ts";

// One wheel per world, and every client seeds it under the same name — the
// id never has to be minted, agreed on, or replicated.
const GOUDA_ID = "gouda";
// Prevents drift in falling wheel state; syncs every 0.12 s while falling.
const LOOSE_SYNC_S = 0.12;

export interface CargoSystemDeps {
  showEvent(text: string, durationMs?: number): void;
  // Force the local torch on/off (G4: the carrier IS the light).
  setTorch(on: boolean): void;
  // Contextual HUD line, or null to clear it.
  setPrompt(text: string | null): void;
  // The run is over: someone got it home.
  onWin(carrier: string): void;
}

export interface CargoSystem extends GameSystem {
  // Seed the wheel into a freshly built world (main.ts, after worldReady).
  spawn(): void;
  // The contextual verb behind the action key: lift it, or hand it over.
  // Returns true if it consumed the press (main.ts falls through to the
  // pickaxe otherwise).
  use(): boolean;
  // Lose your grip — a fish hit you, or the abyss took you.
  fumble(reason: string): void;
  // Deliberate drop (R key). No lockout — unlike a fumble, this was a
  // choice. Returns false (no-op) if you aren't the carrier.
  drop(): boolean;
  // Re-pose a carried wheel AFTER physics has moved the diver this frame.
  // Systems run before physics, so posing it there leaves the wheel a frame
  // behind the camera — which reads as the cheese swimming in your hands
  // every time you clip a tunnel wall.
  followCarrier(): void;
  // We just acquired a peer id (hosted or joined). A wheel we picked up
  // before the mesh existed is filed under "local" — re-file it under the
  // real id now, while we are still provably the only diver in the session.
  rebindLocalId(): void;
}

export function createCargoSystem({
  showEvent,
  setTorch,
  setPrompt,
  onWin,
}: CargoSystemDeps): CargoSystem {
  // Local view of the haul. The holder of record is item.data.holder (it is
  // what replicates); these are the things only this client needs to know.
  let lastHolder: string | null = null;
  // When WE learned the wheel went loose. Only drives the local catch-window
  // curve (how fast it tumbles) — whether it is still falling at all is
  // replicated, not decided here.
  let looseSince = 0;
  let vy = 0; // loose fall speed
  let regrabUntil = 0; // the fumbler's own brief lockout
  let torchBeforeCarry = true; // what to give back when the wheel leaves you
  let looseSyncTimer = 0;
  let sprintHeld = 0; // seconds of unbroken sprinting while carrying
  let won = false;

  const _pos: Vec3 = { x: 0, y: 0, z: 0 };
  const _hold: Vec3 = { x: 0, y: 0, z: 0 };
  const _view: Vec3 = { x: 0, y: 0, z: 0 }; // the carrier's own framing offset

  // --- Authority ------------------------------------------------------------
  // mesh.ts keeps hostId null on the host and in solo play — "nobody above
  // me" is exactly the arbiter test.
  const isAuthority = () => getHostId() === null;

  // Send a request to whoever arbitrates — or, if that's us, act on it now.
  // Every carry system listens on the same "pick"/"give"/"drop" kinds
  // (registry routes an event kind to every system that declared it), so the
  // request carries its own item id and arbitrate() below ignores anything
  // that isn't the Gouda's.
  function request(kind: string, payload: Record<string, unknown> = {}): void {
    const hostId = getHostId();
    const msg = { id: GOUDA_ID, ...payload };
    if (isAuthority() || !hostId) arbitrate(selfId(), kind, msg);
    else sendEventTo(hostId, { kind, ...msg });
  }

  // THE authoritative decision point. Runs only on the host (or solo).
  function arbitrate(
    from: string,
    kind: string,
    data: Record<string, unknown>,
  ): void {
    if (data.id !== GOUDA_ID) return; // another carry system's request
    const item = getItem(GOUDA_ID);
    if (!item || won) return;
    const holder = holderOf(item);

    if (kind === "pick") {
      // Contested grab: first request in wins, every later one is answered
      // with the same truth, so the loser's client corrects itself. Hands
      // already full with something else (the "one pair of hands" rule) are
      // an equally flat denial.
      if (holder === null && withinReach(from, item) && !heldBy(from))
        setHolder(item, from);
      else syncItem(GOUDA_ID); // denied — tell them who really has it
      return;
    }
    // Only the current carrier may hand it over or let it go. A request that
    // lost a race (they dropped it a frame before someone else took it) is
    // stale by definition and is answered with the truth instead.
    if (holder !== from) {
      syncItem(GOUDA_ID);
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

  // Loose check: allows ~2x range to account for interpolation delay.
  function withinReach(peerId: string, item: ItemInstance): boolean {
    if (isSelf(peerId)) {
      return distance(game.localPosition, item) <= CARGO.PICKUP_RANGE;
    }
    const s = game.remoteBuffers.get(peerId)?.sample();
    if (!s) return false;
    return distance(s, item) <= CARGO.PICKUP_RANGE * 2;
  }

  // Authoritative mutation + the one-row "item*" that publishes it.
  function setHolder(item: ItemInstance, holder: string | null): void {
    item.data.holder = holder;
    // Letting go starts a fall; taking it ends one.
    item.data.falling = holder === null;
    reconcile(item);
    syncItem(GOUDA_ID);
  }

  // Replicated state; ensures all clients agree when fall ends.
  function isFalling(item: ItemInstance): boolean {
    return item.data.falling === true;
  }

  function holderOf(item: ItemInstance): string | null {
    const h = item.data.holder;
    return typeof h === "string" ? h : null;
  }

  // --- Local reaction to a change of hands ----------------------------------
  // Handles all holder changes: status, torch, falling state.
  function reconcile(item: ItemInstance): void {
    const holder = holderOf(item);
    if (holder === lastHolder) return;
    const wasMine = isSelf(lastHolder);
    const isMine = isSelf(holder);
    lastHolder = holder;

    // Loose: the catch window starts now, on every client that hears about it.
    looseSince = holder === null ? performance.now() : 0;
    vy = 0;

    if (isMine && !wasMine) {
      setLocalStatus(STATUS.CARRYING, true);
      // G4: your torch is off while you hold it — you ARE the light now.
      torchBeforeCarry = game.flashlightOn;
      setTorch(false);
      regrabUntil = 0;
      sprintHeld = 0; // a fresh grip gets the full grace window
      showEvent("🧀 The Golden Gouda — heavy, warm, and still humming.");
    } else if (!isMine && wasMine) {
      setLocalStatus(STATUS.CARRYING, false);
      setTorch(torchBeforeCarry);
    }
  }

  // --- The verbs ------------------------------------------------------------
  function use(): boolean {
    const item = getItem(GOUDA_ID);
    if (!item || won) return false;
    const holder = holderOf(item);

    // Already holding it — E is now the "use" key, and there is nothing to
    // use the Gouda for; leave the press for tryDig (which itself refuses to
    // swing with both arms full via STATUS.CARRYING).
    if (isSelf(holder)) return false;

    if (holder !== null) return false; // someone else has it — no stealing
    if (performance.now() < regrabUntil) return true; // you JUST fumbled it
    if (distance(game.localPosition, item) > CARGO.PICKUP_RANGE) return false;
    if (heldBy(selfId())) {
      showEvent("🧀 Both hands are full — drop what you're carrying first.");
      return true;
    }
    request("pick");
    return true;
  }

  // Carrier-side request; position travels with it.
  function release(reason: string, lockout: boolean): void {
    const item = getItem(GOUDA_ID);
    if (!item || !isSelf(holderOf(item))) return;
    holdPose(game.localPosition, getYaw(), getPitch(), _hold);
    if (lockout) regrabUntil = performance.now() + CARGO.REGRAB_MS;
    request("drop", { x: _hold.x, y: _hold.y, z: _hold.z });
    showEvent(reason, 3200);
  }

  function fumble(reason: string): void {
    release(reason, true);
  }

  function drop(): boolean {
    const item = getItem(GOUDA_ID);
    if (!item || !isSelf(holderOf(item))) return false;
    // R with a teammate close hands it over instead of letting it fall.
    const mate = nearestTeammate(game.localPosition);
    if (mate && mate.d <= CARGO.HANDOFF_RANGE) {
      request("give", { to: mate.id });
      showEvent(`🤝 Handing it to ${mate.id.slice(0, 4)}…`);
      return true;
    }
    release("🧀 You set the Golden Gouda down.", false);
    return true;
  }

  // --- Loose-wheel physics --------------------------------------------------
  // Synced fall from same position; authority re-publishes periodically.
  function fall(item: ItemInstance, dt: number): void {
    if (!isFalling(item)) return; // resting — in its cavern, or where it fell
    const target = -looseSinkRate(performance.now() - looseSince);
    vy += (target - vy) * (1 - Math.exp(-CARGO.LOOSE_INERTIA * dt));
    _pos.x = item.x;
    _pos.y = item.y + vy * dt;
    _pos.z = item.z;

    const hit = resolveCollision(_pos, GOUDA_RADIUS);
    const bell = collideBathyscaphe(_pos, GOUDA_RADIUS);
    item.x = _pos.x;
    item.y = _pos.y;
    item.z = _pos.z;
    // Landed on something: it stays put until someone picks it up again.
    if ((hit && hit.y > 0.2) || (bell && bell.y > 0.2)) {
      vy = 0;
      // Only authority declares landing and publishes.
      if (isAuthority()) {
        item.data.falling = false;
        syncItem(GOUDA_ID);
      }
    }
  }

  // Carrier sees first-person offset (1.24 u wheel in 72° view); others see true position.
  function placeVisual(item: ItemInstance, holder: string | null): void {
    const visual = getMountedGouda();
    if (!visual) return;
    if (isSelf(holder)) {
      fpHoldPose(game.localPosition, getYaw(), getPitch(), _view);
      visual.group.position.set(_view.x, _view.y, _view.z);
    } else {
      visual.group.position.set(item.x, item.y, item.z);
    }
  }

  // --- HUD ------------------------------------------------------------------
  // A single contextual line: what the action key does right now. The wheel
  // is never on the compass and never gets a marker (D4) — this only ever
  // says something when you are already next to it.
  function updatePrompt(item: ItemInstance, holder: string | null): void {
    if (isSelf(holder)) {
      const mate = nearestTeammate(game.localPosition);
      setPrompt(
        mate && mate.d <= CARGO.HANDOFF_RANGE
          ? `🤝 [R] hand the Gouda to ${mate.id.slice(0, 4)}`
          : "🧀 carrying the Golden Gouda — [R] drop",
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
        heldBy(selfId())
          ? "🧀 hands full"
          : isFalling(item)
            ? "🧀 [E] CATCH IT"
            : "🧀 [E] lift the Golden Gouda",
      );
    } else {
      setPrompt(null);
    }
  }

  return {
    id: "cargo",
    order: 35, // after the fish (a bite can knock it out of your arms),
    // before items (order 40) and before physics reads the carry penalty
    events: ["pick", "give", "drop", "won"],

    init() {
      registerItemKind({
        kind: "gouda",
        onSpawn: () => {
          mountGouda();
        },
        onRemove: () => {
          unmountGouda();
        },
        // The host just told us it changed hands (or fell somewhere else).
        onSync: (item) => reconcile(item),
      });
    },

    spawn() {
      const pos = getGoldPos();
      if (!pos) {
        console.warn("[cargo] world has no gold position — no Gouda seeded");
        return;
      }
      // Seeded: identical on every client, so it costs nothing to place and
      // a late joiner who rebuilt the same map already has it.
      spawnItem(
        "gouda",
        pos,
        { holder: null, falling: false },
        { id: GOUDA_ID, broadcast: false },
      );
    },

    use,
    fumble,
    drop,

    followCarrier() {
      const item = getItem(GOUDA_ID);
      if (!item || !isSelf(holderOf(item))) return;
      holdPose(game.localPosition, getYaw(), getPitch(), _hold);
      item.x = _hold.x;
      item.y = _hold.y;
      item.z = _hold.z;
      placeVisual(item, holderOf(item));
    },

    rebindLocalId() {
      const item = getItem(GOUDA_ID);
      const myId = getMyId();
      if (!item || !myId || item.data.holder !== LOCAL_ID) return;
      item.data.holder = myId;
      lastHolder = myId; // same hands, new name — not a change of holder
    },

    update({ dt, game, connected }) {
      const item = getItem(GOUDA_ID);
      const visual = getMountedGouda();
      if (!item || won) {
        setPrompt(null);
        return;
      }
      const holder = holderOf(item);
      // A holder set by a snapshot we applied before this system ever saw it
      // (late join) still has to go through reconcile once.
      if (holder !== lastHolder) reconcile(item);

      if (holder !== null) {
        // Carried: the wheel rides its holder. No network for this — every
        // client already knows where every diver is.
        if (isSelf(holder)) {
          holdPose(game.localPosition, getYaw(), getPitch(), _hold);
          item.x = _hold.x;
          item.y = _hold.y;
          item.z = _hold.z;
          // Sprinting with both arms full is how you lose it (G2). Never a
          // random tick: this only rolls while YOU chose to sprint, and only
          // once you have HELD the sprint past the grace window — the timer
          // resets the moment you let go, so short bursts are always free.
          sprintHeld = isSprinting() ? sprintHeld + dt : 0;
          if (
            isSprinting() &&
            Math.random() < sprintFumbleChance(dt, sprintHeld)
          ) {
            fumble("🧀 It slips! Too fast, too heavy — catch it!");
          }
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
            syncItem(GOUDA_ID);
          }
        }
      }

      visual?.update(performance.now() / 1000, holder !== null);
      placeVisual(item, holder);

      // Home. The bell's hatch radius is the finish line (M1.3).
      if (
        isAuthority() &&
        distance(item, game.spawnPoint) < CARGO.DELIVER_RANGE
      ) {
        won = true;
        const by = holder ?? selfId();
        if (connected) sendEvent({ kind: "won", by });
        onWin(by);
        return;
      }

      updatePrompt(item, holder);
    },

    onEvent(fromPeerId, kind, data) {
      if (kind === "won") {
        won = true;
        onWin(typeof data.by === "string" ? data.by : fromPeerId);
        return;
      }
      // A request only ever reaches the arbiter (requests are sent to the
      // host alone) — but drop a stray one rather than acting out of turn.
      if (isAuthority()) arbitrate(fromPeerId, kind, data);
    },

    onPeerDisconnected(peerId) {
      const item = getItem(GOUDA_ID);
      if (!item || holderOf(item) !== peerId) return;
      // The carrier is gone. The wheel stays where they were last seen and
      // falls from there — every client can work that out on its own, and
      // the authority publishes it so late arrivals agree.
      if (isAuthority()) setHolder(item, null);
      else {
        item.data.holder = null;
        reconcile(item);
      }
      showEvent("🧀 The carrier is gone — the Gouda is adrift.", 3200);
    },

    reset() {
      // itemsSystem clears the registry (and unmounts the visual through
      // onRemove); this is everything ABOUT the haul that must not survive.
      lastHolder = null;
      looseSince = 0;
      vy = 0;
      regrabUntil = 0;
      looseSyncTimer = 0;
      sprintHeld = 0;
      won = false;
      torchBeforeCarry = true;
      setPrompt(null);
    },
  };
}
