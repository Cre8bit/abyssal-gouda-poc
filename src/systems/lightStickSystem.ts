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
import { getHostId, getRtt } from "../net/mesh.ts";
import { sendEvent, sendEventTo } from "../net/sync.ts";
import { getYaw, getPitch } from "../input/input.ts";
import { game, LIGHT_STICKS_PER_DIVER, type Vec3 } from "../state.ts";
import type { GameSystem } from "./types.ts";

// --- Flight ------------------------------------------------------------------
const THROW_SPEED = 5.5; // u/s out of the paw, along the look
// 1/s. A baton is a light thing thrown through water, so drag is the whole
// physics and THROW_SPEED / STICK_DRAG is the whole range: ~1.8 u, a body
// length and a half. This is a PLACEMENT, not a throw — you set the baton
// down in front of you and swim on, so a line of them reads as a trail you
// can follow back rather than a scatter across the gallery.
const STICK_DRAG = 3;
const REST_SPEED = 0.5; // u/s under which it is simply hanging there
const WALL_DAMP = 0.25; // a baton hitting cheese does not bounce, it stops
const STICK_RADIUS = LIGHT_STICK_LENGTH * 0.6;
// The tumble. A baton let go of underwater turns end over end about a random
// axis and keeps turning long after the water has stopped it moving, which is
// why the spin outlives the flight (SPIN_DRAG well under STICK_DRAG): what
// finally comes to rest is a stick lying at some angle, never one that
// happens to be axis-aligned.
const SPIN_SPEED = 7; // rad/s about a random axis, out of the paw
const SPIN_SPREAD = 0.45; // fraction of SPIN_SPEED the rate wanders by
const SPIN_DRAG = 1.1; // 1/s
const SPIN_REST = 0.08; // rad/s under which the tumble is simply over
const LOOSE_SYNC_S = 0.12; // authoritative resync cadence while it flies

// Which burning sticks actually light the scene is entities/lightStick.ts's
// business: a fixed pool of point lights, brightest-and-nearest into slots
// that are never added or removed, so drawing, throwing or collecting one can
// never change the scene's light count and relink every material in it.
//
// A stick we do not own is dead-reckoned from the velocity it carries (see
// fly()), so this only has to absorb the small error each sync brings (1/s).
const REMOTE_SMOOTH = 14;

type Action = "draw" | "stow" | "throw";

export interface LightStickSystemDeps {
  showEvent(text: string, durationMs?: number): void;
  // Contextual HUD line, or null to clear it. Lowest priority of the three
  // carry systems — the Gouda and the driller both speak over it.
  setPrompt(text: string | null): void;
  // The local first-person paw gains or loses its stick. Remote paws go
  // through setPeerHolding/setPeerStick below — their steady state is the
  // status bit, which is in every packet, so a diver you swim up to is
  // already holding what they are holding.
  holdInPaw(on: boolean): void;
  // A remote diver moved to another grip state (undefined = back to rest).
  setPeerPhase(peerId: string, phase: string | undefined): void;
  // A remote diver's paw gains or loses the baton itself. Split from the
  // status mask because the mask cannot say WHERE in the swing it left.
  setPeerStick(peerId: string, on: boolean): void;
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
  // A peer's status mask says whether they are holding one; the system says
  // whether their paw still has it (see the throw replay).
  setPeerHolding(peerId: string, on: boolean): void;
}

export function createLightStickSystem({
  showEvent,
  setPrompt,
  holdInPaw,
  setPeerPhase,
  setPeerStick,
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
  // Whether the paw has actually closed on the drawn baton yet — false through
  // the first STICK_DWELL.clasp of a draw, while the arm is still reaching.
  let clasped = false;
  // Every thrown stick alive in the world, so the flight integrator does not
  // have to walk the whole item registry.
  const live = new Set<string>();
  // A peer's throw, replayed: which peers the status mask says are holding a
  // stick, and how long until the one in their paw leaves it.
  const peerHolding = new Set<string>();
  const peerSwing = new Map<string, number>();
  // …and how long until the paw of one still REACHING for their belt closes
  // on a baton (the mask flips at the top of the reach — see the clasp note).
  const peerClasp = new Map<string, number>();
  // Every tumbling baton's angular velocity, rad/s about world axes. Local
  // presentation, derived from the item id rather than sent: everyone hashes
  // the same id to the same tumble, so the batons agree without a byte on the
  // wire and nobody has to arbitrate which way a glow stick is lying.
  const spins = new Map<string, Vec3>();
  let looseSyncTimer = 0;
  let mintCounter = 0;

  const _pos: Vec3 = { x: 0, y: 0, z: 0 };
  const _paw: Vec3 = { x: 0, y: 0, z: 0 };
  const _vel: Vec3 = { x: 0, y: 0, z: 0 };

  // Same arbiter test as cargoSystem/drillerSystem: null on the host AND solo.
  const isAuthority = () => getHostId() === null;

  // FNV-1a, then a cheap LCG off it: an item id in, a repeatable stream of
  // 0…1 out. Deterministic across clients, which is the whole point.
  function seeded(id: string): () => number {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
      h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    }
    return () => {
      h = (Math.imul(h, 1664525) + 1013904223) | 0;
      return ((h >>> 8) & 0xffffff) / 0x1000000;
    };
  }

  // Give a baton the attitude and the tumble its id says it has. A stick that
  // is already at rest when we meet it (a late join, someone else's fixture)
  // gets the attitude and no tumble — the turning is long over.
  function tumble(item: ItemInstance): void {
    const visual = getMountedLightStick(item.id);
    if (!visual) return;
    const rnd = seeded(item.id);
    visual.setTilt(
      (rnd() - 0.5) * Math.PI * 2,
      (rnd() - 0.5) * Math.PI * 2,
      (rnd() - 0.5) * Math.PI * 2,
    );
    if (!isMoving(item)) return;
    // A uniform axis on the sphere, so no throw favours a plane.
    const up = rnd() * 2 - 1;
    const phi = rnd() * Math.PI * 2;
    const flat = Math.sqrt(Math.max(0, 1 - up * up));
    const rate = SPIN_SPEED * (1 + SPIN_SPREAD * (rnd() * 2 - 1));
    spins.set(item.id, {
      x: flat * Math.cos(phi) * rate,
      y: up * rate,
      z: flat * Math.sin(phi) * rate,
    });
  }

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
    // The baton itself lands in the paw at STICK_DWELL.clasp, not now: the arm
    // is still on its way down to the holster, and in first person a stick
    // already in it slides up past the bottom of the lens out of nowhere.
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
    clasped = false;
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
      if (!clasped && actionT >= STICK_DWELL.clasp) {
        clasped = true;
        holdInPaw(true); // the paw is at the belt — NOW it has a baton
      }
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
      clasped = false;
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
    if (clasped) holdInPaw(false);
    drawn = false;
    clasped = false;
    action = null;
    actionT = 0;
    setLocalStatus(STATUS.HOLDING_STICK, false);
    publish(null);
  }

  // --- A peer's throw, replayed ----------------------------------------------
  // Their status mask holds HOLDING_STICK set until the swing finishes, but
  // the baton left their paw at STICK_DWELL.release — which, both messages
  // having crossed the same wire, is exactly when their thrown item lands
  // here. Without this the paw keeps a second baton through the whole
  // follow-through, alongside the one already flying.

  function pawFull(peerId: string): boolean {
    if (!peerHolding.has(peerId)) return false;
    if ((peerClasp.get(peerId) ?? 0) > 0) return false; // still reaching
    return peerSwing.get(peerId) !== 0;
  }

  function setPeerHolding(peerId: string, on: boolean): void {
    if (on) {
      // The mask flips the instant they press [G], but their paw does not
      // close on the baton until STICK_DWELL.clasp — same reach ours takes.
      if (!peerHolding.has(peerId)) peerClasp.set(peerId, STICK_DWELL.clasp);
      peerHolding.add(peerId);
    } else {
      peerHolding.delete(peerId);
      peerSwing.delete(peerId);
      peerClasp.delete(peerId);
    }
    setPeerStick(peerId, pawFull(peerId));
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
  // EVERYONE integrates, from the velocity the item carries. A sync every
  // LOOSE_SYNC_S is ~7 samples across a throw, and a client that only chased
  // those samples watched the baton crawl a body length behind where the
  // thrower had already put it — the lag you see across the wire. The thrower
  // is still the authority: its syncs are corrections, and drawWorld()'s
  // smoother eats them. Water is the whole physics: drag until the throw is
  // spent, then it hangs where it stopped (a chem baton is neutrally buoyant —
  // it neither sinks nor rises, which is what makes it a breadcrumb).
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
      // Where it came to rest is the thrower's to publish; everyone else has
      // simply arrived at the same answer and waits to be corrected.
      if (isMine(item)) syncItem(item.id);
    }
  }

  // A flight state is already one trip old when it lands here. Wind it forward
  // by that trip, so a baton is where the thrower has it, not where they had
  // it: the two together are the whole of the throw lag.
  function catchUp(item: ItemInstance): void {
    if (!isMoving(item) || isMine(item)) return;
    const rtt = getRtt(item.data.owner as string);
    if (rtt) fly(item, Math.min(rtt / 2000, 0.15));
  }

  // --- Presentation ----------------------------------------------------------
  // Place every world stick; which of them light the scene is the pool's call.
  function drawWorld(now: number, dt: number): void {
    const k = 1 - Math.exp(-REMOTE_SMOOTH * dt);
    for (const id of live) {
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
      const w = spins.get(id);
      if (w) visual.spin(w.x, w.y, w.z, dt);
      visual.update(now, false);
    }
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
          catchUp(item);
          const visual = mountLightStick(item.id);
          visual?.group.position.set(item.x, item.y, item.z);
          tumble(item);
        },
        onSync: catchUp,
        onRemove: (item) => {
          live.delete(item.id);
          spins.delete(item.id);
          unmountLightStick(item.id);
        },
      });
    },

    toggle,
    hurl,
    use,
    stow,
    setPeerHolding,
    phase: () => phase ?? undefined,

    update({ dt, now, connected }) {
      // Both paws just filled with something else (a hand-off, a pickup):
      // the drawn stick goes back on the belt rather than clipping through.
      if (drawn && action !== "throw" && handsFull()) stow();
      stepAction(dt);
      setBelt(game.lightSticks, drawn);

      for (const [id, left] of peerSwing) {
        if (left <= 0) continue;
        const next = Math.max(0, left - dt);
        peerSwing.set(id, next);
        if (next === 0) setPeerStick(id, false);
      }
      for (const [id, left] of peerClasp) {
        const next = Math.max(0, left - dt);
        peerClasp.set(id, next);
        if (next === 0 && left > 0) setPeerStick(id, pawFull(id));
      }

      let anyMoving = false;
      for (const id of live) {
        const item = getItem(id);
        if (!item || !isMoving(item)) continue;
        anyMoving = true;
        fly(item, dt);
      }
      // The tumble outlives the flight: the water stops a baton travelling
      // long before it stops it turning, so this runs off `spins` and not off
      // `moving`. When it dies the entry goes, and the stick simply hangs
      // there at whatever angle it stopped.
      for (const [id, w] of spins) {
        const damp = Math.exp(-SPIN_DRAG * dt);
        w.x *= damp;
        w.y *= damp;
        w.z *= damp;
        if (Math.hypot(w.x, w.y, w.z) < SPIN_REST) spins.delete(id);
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
        // "throw" starts the countdown to the paw opening; the swing ending
        // ("") means it is already open, whatever their status mask still
        // says — the two ride different channels and can land in either order.
        if (p === "throw") peerSwing.set(fromPeerId, STICK_DWELL.release);
        else if (p) peerSwing.delete(fromPeerId);
        else peerSwing.set(fromPeerId, 0);
        setPeerStick(fromPeerId, pawFull(fromPeerId));
      } else if (kind === "stickGot") {
        grant();
      } else if (isAuthority()) {
        arbitrate(fromPeerId, kind, data);
      }
    },

    onPeerDisconnected(peerId) {
      setPeerPhase(peerId, undefined);
      peerHolding.delete(peerId);
      peerSwing.delete(peerId);
      peerClasp.delete(peerId);
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
      peerHolding.clear();
      peerSwing.clear();
      peerClasp.clear();
      spins.clear();
      sent = undefined;
      looseSyncTimer = 0;
      mintCounter = 0;
      setPrompt(null);
    },
  };
}
