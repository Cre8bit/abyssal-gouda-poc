// main.ts — entry point and orchestrator: wires UI, graphics, network, voice,
// input, and drives the frame. Simulation slices live in src/systems/* (one
// updateSystems() call per frame, deterministic order); session-mutable state
// lives in state.ts; this file owns only what remains: the menu/HUD DOM, the
// world build, movement + physics, and the world-level network events
// (dig/tp/seed) that mutate the map itself.
import {
  initGraphics,
  addPlayer,
  removePlayer,
  updatePlayerPosition,
  updateCamera,
  updateLocalPlayer,
  renderLoop,
  toggleFlashlight,
  setPlayerLight,
  setPlayerCarrying,
  loadWorld,
  rebuildWorld,
  emitBreath,
  burstAt,
  setFlashlight,
} from "./render/graphics.ts";
import {
  initAbyssAudio,
  updateAbyssAudio,
  setExhaleListener,
  playDig,
  playClick,
  playWhoosh,
} from "./audio/ambience.ts";
import {
  resolveCollision,
  findOpenSpot,
  getSpawnPoint,
  getGoldPos,
  digAt,
  raycastSolid,
  WORLD_R,
} from "./world/gouda.ts";
import {
  hostGame,
  joinGame,
  onPeerConnected,
  onPeerDisconnected,
  isConnected,
  getPeer,
  getHostId,
  getMyId,
  getPeerIds,
  getWorstRtt,
  getSignalingMode,
  type SignalingMode,
} from "./net/mesh.ts";
import {
  broadcastState,
  sendEvent,
  sendEventTo,
  onStateReceived,
  onEventReceived,
} from "./net/sync.ts";
import {
  initInput,
  initMouseLook,
  updateLook,
  getMovement,
  getYaw,
  getPitch,
  getSwimYaw,
  getSwimPitch,
  getYawVelocity,
  isSprinting,
} from "./input/input.ts";
import { SnapshotBuffer } from "./net/interpolation.ts";
import { getShotConfig, applyShot } from "./bench/shots.ts";
import { setLook } from "./input/input.ts";
import {
  initVoice,
  callPeer,
  hangUp,
  onVoiceStatus,
  setListenerPose,
  setVoicePosition,
  toggleMute,
} from "./audio/voice.ts";
import {
  STATUS,
  getLocalStatus,
  setLocalStatus,
  onLocalStatusChange,
  setPeerStatus,
  getPeerStatus,
  clearPeerStatus,
  statusIcons,
  hasLocalStatus,
} from "./game/effects.ts";
import { initOxygen, refillOxygen, isDead } from "./game/oxygen.ts";
import { setBellCount, collideBathyscaphe } from "./world/bathyscaphe.ts";
import {
  game,
  placeAtSpawn,
  resetGameState,
  type DigTool,
  type SphereDig,
  type Vec3,
} from "./state.ts";
import type { PlayerStateOut } from "./net/protocol.ts";
import {
  registerSystem,
  updateSystems,
  dispatchSystemEvent,
  notifySystemsPeerDisconnected,
  resetSystems,
} from "./systems/registry.ts";
import { createEffectsSystem } from "./systems/effectsSystem.ts";
import { createOxygenSystem } from "./systems/oxygenSystem.ts";
import { createCatfishSystem } from "./systems/catfishSystem.ts";
import { createItemsSystem } from "./systems/itemsSystem.ts";
import { createCargoSystem } from "./systems/cargoSystem.ts";
import { getMountedGouda } from "./entities/goldenGouda.ts";
import { carrySpeedCap, CARGO } from "./game/cargo.ts";
import {
  sendItemSnapshotTo,
  requestItemSnapshotFrom,
  getItem,
} from "./game/items.ts";

const MAX_SPEED = 10.0; // units per second — brisk fins
const SPRINT_MULT = 1.9; // hold Shift: burst of speed (descend is on C)
const WATER_INERTIA = 4; // how quickly velocity reaches its target
const NETWORK_RATE = 1 / 30; // send state 30x per second
const ABYSS_DEPTH = 612; // flavor: depth readout at y = 0
const PLAYER_RADIUS = 0.6; // collision clearance against the cheese
const WORLD_LIMIT = WORLD_R + 25; // soft leash, just inside the boundary veil

// Per-tool carve radii (WG-01): hands thread, the driller demolishes.
const DIG_RADII: Record<DigTool, number> = { hands: 0.7, driller: 2.4 };
const DIG_RANGE = 7; // how far the dig tool reaches
const DIG_COOLDOWN_MS = 400;

const REMOTE_COLOR = 0x66ff99;

const DEATH_RESPAWN_MS = 2600; // blackout duration before waking at spawn

// --- UI elements ---
// The HUD markup is static (index.html) — a missing id is a programming
// error, so fail fast at boot instead of null-checking every access.
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id} in index.html`);
  return node as T;
}
const menu = el("menu");
const hostBtn = el("host-btn");
const joinBtn = el("join-btn");
const statusPanel = el("status");
const statusText = el("status-text");
const peerIdText = el("peer-id");
const copyLinkBtn = el("copy-link-btn");
const miniCopyLinkBtn = el("mini-copy-link-btn");
const hud = el("hud");
const compassCanvas = el<HTMLCanvasElement>("compass");
const depthText = el("depth");
const voiceText = el("voice-indicator");
const tpGoudaBtn = el("tp-gouda-btn");
const eventCenter = el("event-center");
const o2Fill = el("o2-fill");
const o2Bar = el("o2-bar");
const pingText = el("ping");
const peerStatusText = el("peer-status");
const deathOverlay = el("death-overlay");
const winOverlay = el("win-overlay");
const winSub = el("win-sub");
const carryPrompt = el("carry-prompt");

// Network events trusted as-is (same-version peers). Dig shape shared with state.ts.
type DigEvent = SphereDig;
interface SeedEvent {
  seed: number;
  d?: number;
}

function errMsg(err: unknown): string {
  const e = err as { message?: string; type?: string } | null;
  return e?.message ?? e?.type ?? String(err);
}

let respawnTimer: ReturnType<typeof setTimeout> | undefined;

// --- Setup ---
const canvas = initGraphics(el("scene-container"));
initInput();
initMouseLook(canvas);

// Simulation systems in order (see systems/types.ts): one slot after input, before physics.
registerSystem(createEffectsSystem()); // 10 — expire timed statuses
registerSystem(createOxygenSystem({ o2Fill, o2Bar })); // 20 — drain + HUD
const cargoSys = registerSystem(
  createCargoSystem({
    showEvent,
    // G4: the carrier's own torch is off for as long as they hold the wheel.
    setTorch: (on) => {
      game.flashlightOn = setFlashlight(on);
      broadcastNow();
    },
    setPrompt: (text) => (carryPrompt.textContent = text ?? ""),
    onWin: showWin,
  }),
); // 35 — the haul
const catfishSys = registerSystem(
  createCatfishSystem({
    showEvent,
    // A bite can knock the Golden Gouda out of your arms (M1.1).
    onDamage: () => {
      if (Math.random() < CARGO.BITE_FUMBLE_CHANCE) {
        cargoSys.fumble("🧀 The jaws hit you — the Gouda is loose!");
      }
    },
  }),
); // 30
registerSystem(createItemsSystem()); // 40 — dynamic map objects

// Init procedural soundscape inside user gesture (idempotent).
for (const evt of ["pointerdown", "keydown"]) {
  window.addEventListener(evt, () => initAbyssAudio(), { passive: true });
}
setExhaleListener(() => emitBreath(4 + ((Math.random() * 3) | 0)));

// --- World generation, with a loading screen ---
// Seed from URL or random; host's seed is authoritative.
const bootParams = new URLSearchParams(location.search);
{
  let seed = Number.parseInt(bootParams.get("seed") ?? "", 10);
  if (!Number.isFinite(seed)) seed = (Math.random() * 2 ** 31) | 0;
  game.seed = seed;
  game.difficulty = Math.min(
    3,
    Math.max(1, Number.parseInt(bootParams.get("d") ?? "1", 10) || 1),
  );
}

const loaderEl = el("loader");
const loaderFill = el("loader-fill");
const loaderLabel = el("loader-label");

async function buildWorld(rebuild = false) {
  // Fresh world: clear motion, history, systems' state (statuses, oxygen, items).
  resetGameState();
  resetSystems();
  loaderEl.classList.remove("done");
  const progress = (done: number, total: number, label: string) => {
    loaderFill.style.width = `${Math.round((done / total) * 100)}%`;
    loaderLabel.textContent = `seed ${game.seed} · carving ${label} · ${done}/${total}`;
  };
  const build = rebuild ? rebuildWorld : loadWorld;
  await build(progress, { seed: game.seed, difficulty: game.difficulty });
  // Spawn at drift edge (O₂ recharge zone, bathyscaphe berth).
  placeAtSpawn(getSpawnPoint());
  refillOxygen();
  game.worldReady = true;
  // Replay pending digs (geometry only; audio/position already gone).
  for (const d of game.pendingDigs) applyDigEvent(d);
  game.pendingDigs.length = 0;
  loaderEl.classList.add("done");

  // Spawn catfish (host simulates, joiners get puppets).
  catfishSys.spawn(game.difficulty);
  // Spawn Gouda (seeded → same place, free on wire).
  cargoSys.spawn();
  // Rebuild: request live items from host.
  const hostId = getHostId();
  if (hostId) requestItemSnapshotFrom(hostId);
}
// Headless screenshot mode (?shot=<name>): skip menu, pin vantage.
const shotConfig = getShotConfig();
buildWorld().then(() => {
  if (shotConfig) applyShot(shotConfig, teleportLocal, game.localPosition);
});

hostBtn.addEventListener("click", async () => {
  showStatus("Creating game…");
  try {
    const id = await hostGame();
    game.hostedId = id;
    game.fishAuthority = true;
    game.fishAuthorityId = id;
    // A wheel picked up before the mesh existed is filed under "local".
    cargoSys.rebindLocalId();
    const peer = getPeer();
    if (peer) initVoice(peer); // non-null right after hostGame() resolves
    showStatus("Invite a diver:");
    peerIdText.textContent = id;
    peerIdText.classList.remove("hidden");
    copyLinkBtn.classList.remove("hidden");
    menu.classList.add("hidden");
    hud.classList.remove("hidden");
  } catch (err) {
    showStatus(`Hosting failed: ${errMsg(err)}`);
  }
});

// Invite link with signaling mode for server consistency.
function inviteUrl() {
  return `${location.origin}${location.pathname}?join=${encodeURIComponent(game.hostedId ?? "")}&s=${getSignalingMode()}&seed=${game.seed}&d=${game.difficulty}`;
}

copyLinkBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(inviteUrl());
    copyLinkBtn.textContent = "✔ Copied!";
  } catch {
    // Clipboard can be unavailable (e.g. non-HTTPS LAN) — show the URL.
    peerIdText.textContent = inviteUrl();
    copyLinkBtn.textContent = "Copy manually above";
  }
  setTimeout(() => (copyLinkBtn.textContent = "📋 Copy invite link"), 2000);
});

// Compact link button after first peer joins.
miniCopyLinkBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(inviteUrl());
    miniCopyLinkBtn.textContent = "✔";
  } catch {
    prompt("Copy this invite link:", inviteUrl());
  }
  setTimeout(() => (miniCopyLinkBtn.textContent = "📋"), 1500);
});

async function join(hostId: string, mode: SignalingMode | null = null) {
  showStatus("Connecting…");
  try {
    initVoiceEarly(); // install the call-answer handler before anyone dials us
    const remoteId = await joinGame(hostId.trim(), mode);
    // The host simulates the fish; we run puppets (until an election says
    // otherwise — catfishSystem mirrors this flag into catfish.js). Voice
    // calls are placed per-peer by onPeerConnected.
    game.fishAuthority = false;
    game.fishAuthorityId = remoteId;
    cargoSys.rebindLocalId();
    menu.classList.add("hidden");
    hud.classList.remove("hidden");
  } catch (err) {
    showStatus(`Connection failed: ${errMsg(err)}`);
    menu.classList.remove("hidden");
  }
}

// Poll for Peer with cap (race condition: calls arrive before join finishes).
function initVoiceEarly() {
  let tries = 0;
  const tryInit = () => {
    const p = getPeer();
    if (p) initVoice(p);
    else if (++tries < 50) setTimeout(tryInit, 200);
    else console.warn("voice: peer never came up — voice stays off");
  };
  tryInit();
}

joinBtn.addEventListener("click", () => {
  const hostId = prompt("Enter the Host ID:");
  if (hostId) join(hostId);
});

// Auto-join when opened through an invite link (?join=<host-id>&s=<mode>).
const urlParams = new URLSearchParams(location.search);
const joinParam = urlParams.get("join");
if (joinParam) {
  menu.classList.add("hidden");
  const mode = urlParams.get("s");
  join(joinParam, mode === "local" || mode === "cloud" ? mode : null);
}

tpGoudaBtn.addEventListener("click", teleportToGouda);

// Action keys (physical positions — layout-agnostic).
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyF") {
    if (hasLocalStatus(STATUS.CARRYING)) {
      showEvent("🔦 Not while you're holding it — the Gouda is your light.");
      return;
    }
    game.flashlightOn = toggleFlashlight();
    playClick();
    showEvent(
      game.flashlightOn
        ? "🔦 Flashlight ON"
        : "🔦 Flashlight OFF — pitch black…",
    );
    // Sync immediately so the other divers see your light die right away.
    broadcastNow();
  } else if (e.code === "KeyV") {
    toggleMute();
  } else if (e.code === "KeyT") {
    // TEMPORARY debug toggle until M3 seeds the driller item (WG-01).
    game.digTool = game.digTool === "hands" ? "driller" : "hands";
    playClick();
    showEvent(
      game.digTool === "driller"
        ? "🛠 [DEBUG] Tool: DRILLER (2.4 u, loud)"
        : "⛏ [DEBUG] Tool: bare paws (0.7 u, quiet)",
    );
  } else if (e.code === "KeyE") {
    // E key: Gouda first (can't dig with both arms full), then pickaxe.
    if (!cargoSys.use()) tryDig();
  }
});

// Replayed/remote digs go through the same hardness gate as local ones —
// same world, same tool ⇒ same verdict on every client.
function applyDigEvent(d: SphereDig) {
  const tool: DigTool = d.tool ?? "hands";
  digAt(d.x, d.y, d.z, d.r ?? DIG_RADII[tool], tool);
}

// Dig tool: SDF edits chunk voxels + marching cubes; collision tracks.
let lastDigAt = 0;
function tryDig() {
  if (!game.worldReady || isDead()) return;
  if (hasLocalStatus(STATUS.CARRYING)) {
    showEvent("⛏ Both arms are full — you can't swing with the Gouda.");
    return;
  }
  const now = performance.now();
  if (now - lastDigAt < DIG_COOLDOWN_MS) return;

  const yaw = getYaw();
  const pitch = getPitch();
  const cosP = Math.cos(pitch);
  const dir = {
    x: -Math.sin(yaw) * cosP,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosP,
  };
  const hit = raycastSolid(game.localPosition, dir, DIG_RANGE);
  if (!hit) {
    showEvent("⛏ Nothing within reach");
    return;
  }
  lastDigAt = now;
  const tool = game.digTool;
  const r = DIG_RADII[tool];
  const result = digAt(hit.x, hit.y, hit.z, r, tool);
  if (!result.changed) {
    if (result.rejected) {
      playClick();
      showEvent(
        tool === "hands"
          ? "⛏ Too hard for bare paws — this rind wants the driller."
          : "⛏ The driller skips off — nothing opens this.",
      );
    }
    return;
  }
  playDig();
  burstAt(hit.x, hit.y, hit.z); // gas pockets tear free of the cheese
  showEvent(
    tool === "driller"
      ? "🛠 The driller chews through"
      : "⛏ You carve into the gouda",
  );
  if (isConnected()) {
    sendEvent({ kind: "dig", x: hit.x, y: hit.y, z: hit.z, r, tool });
  }
}

// TEMPORARY: Jump to Gouda (playtest aid). Breaks D4 (hidden wheel).
function teleportToGouda() {
  if (!game.worldReady) return;
  // The live item position once it exists (it moves as soon as anyone
  // touches it); the seed position is the only thing there is before that.
  const target = getItem("gouda") ?? getGoldPos();
  if (!target) {
    showEvent("🧀 No Gouda in this world yet.");
    return;
  }
  // Land well inside pickup range (CARGO.PICKUP_RANGE is 3.2) but not on
  // top of the wheel itself, and findOpenSpot keeps us clear of the cheese.
  const spot = findOpenSpot(target, 1.5, 2.8);
  teleportLocal(spot.x, spot.y, spot.z);
  playWhoosh();
  showEvent("🧪 [DEBUG] Teleported to the Golden Gouda");
}

function teleportLocal(x: number, y: number, z: number) {
  game.localPosition.x = x;
  game.localPosition.y = y;
  game.localPosition.z = z;
  game.velocity.x = game.velocity.y = game.velocity.z = 0;
  // Forget remote history so interpolation doesn't sweep across the map.
  for (const buffer of game.remoteBuffers.values()) buffer.reset();
  broadcastNow();
}

// Immediate broadcast for discrete changes. Reused state object (no alloc per tick).
const netState: PlayerStateOut = {
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  sy: 0,
  sp: 0,
  light: true,
  status: 0,
};
function fillNetState() {
  netState.x = game.localPosition.x;
  netState.y = game.localPosition.y;
  netState.z = game.localPosition.z;
  netState.yaw = getYaw();
  netState.pitch = getPitch();
  netState.sy = getSwimYaw();
  netState.sp = getSwimPitch();
  netState.light = game.flashlightOn;
  netState.status = getLocalStatus();
  return netState;
}
function broadcastNow() {
  if (!isConnected()) return;
  broadcastState(fillNetState());
}

// Any local status change (trapped, poisoned…) ships instantly (T0.2 AC).
onLocalStatusChange(() => broadcastNow());

// Initiator: we dialed this peer (one data + voice call per pair).
onPeerConnected((peerId, { initiator }) => {
  addPlayer(peerId, REMOTE_COLOR);
  game.remoteBuffers.set(peerId, new SnapshotBuffer());
  setBellCount(1 + getPeerIds().length); // one berth per diver in the crew
  if (initiator) {
    const peer = getPeer(); // non-null: a mesh link just opened through it
    if (peer) callPeer(peer, peerId);
  }
  if (game.hostedId) {
    sendEventTo(peerId, { kind: "seed", seed: game.seed, d: game.difficulty });
    sendItemSnapshotTo(peerId);
  }
  broadcastNow(); // let them place us immediately
  statusPanel.classList.add("hidden");
  if (game.hostedId) miniCopyLinkBtn.classList.remove("hidden"); // only the host has a link to share
});

onPeerDisconnected((peerId) => {
  removePlayer(peerId);
  game.remoteBuffers.delete(peerId);
  clearPeerStatus(peerId);
  hangUp(peerId);
  setBellCount(1 + getPeerIds().length);
  // Systems react on their own terms — catfishSystem runs the fish-authority
  // election here (deterministic, zero coordination messages).
  notifySystemsPeerDisconnected(peerId);
  if (getPeerIds().length === 0) {
    miniCopyLinkBtn.classList.add("hidden");
  }
  showStatus("Diver disconnected.");
});

// Buffer for interpolation. Flags (light, status) applied instantly.
onStateReceived((peerId, { x, y, z, yaw, pitch, light, sy, sp, status }) => {
  game.remoteBuffers.get(peerId)?.push({ x, y, z, yaw, pitch, sy, sp });
  setPlayerLight(peerId, light !== false);
  if (status !== undefined) {
    setPeerStatus(peerId, status);
    // Exterior carry animation (FP half on local body status).
    setPlayerCarrying(peerId, (status & STATUS.CARRYING) !== 0);
  }
});

onEventReceived((peerId, data) => {
  // Route by kind; world/orchestrator handles remainder.
  if (dispatchSystemEvent(peerId, data.kind, data)) return;
  if (data.kind === "dig") {
    const d = data as unknown as DigEvent;
    if (!game.worldReady) {
      // Queue mid-build digs; replay after build completes.
      game.pendingDigs.push(d);
      return;
    }
    applyDigEvent(d);
    burstAt(d.x, d.y, d.z);
    // Audible only if they're digging nearby — muffled thumps through cheese.
    const dd = Math.hypot(
      d.x - game.localPosition.x,
      d.y - game.localPosition.y,
      d.z - game.localPosition.z,
    );
    if (dd < 45) playDig();
  } else if (
    data.kind === "seed" &&
    peerId === getHostId() && // only the host's seed is authoritative
    data.seed !== game.seed
  ) {
    // Joined a host with a different map: adopt their seed and rebuild.
    const d = data as unknown as SeedEvent;
    game.seed = d.seed >>> 0;
    game.difficulty = d.d ?? game.difficulty;
    showEvent("🧀 Different map detected — rebuilding to the host's seed…");
    buildWorld(true);
  }
});

onVoiceStatus((state) => {
  const labels: Record<string, string> = {
    connecting: "VOICE · connecting…",
    on: "VOICE · proximity on (V to mute)",
    muted: "VOICE · muted (V)",
    off: "VOICE · off",
    error: "VOICE · error",
    "mic-denied": "VOICE · mic access denied",
  };
  voiceText.textContent = labels[state] ?? "";
});

// Game loop: order is fixed — input → systems → physics → camera/body → audio → net → interp → HUD.
// Scratch objects (no allocation per frame).
const ZERO_MOVE = Object.freeze({ x: 0, y: 0, z: 0 });
const _fwd = { x: 0, y: 0, z: 0 };
const _right = { x: 0, z: 0 };
const _target = { x: 0, y: 0, z: 0 };
const remotePosPool: Vec3[] = []; // backing objects for remotePositions, by index
const frameCtx = { dt: 0, now: 0, game, connected: false };
let networkTimer = 0;
let hudTimer = 0; // slow HUD refresh (ping, peer statuses)
let cameraRoll = 0; // eased bank angle while turning
renderLoop((delta) => {
  if (!game.worldReady) return;
  const pos = game.localPosition;
  const vel = game.velocity;

  updateLook(delta);
  const yaw = getYaw();
  const pitch = getPitch();

  frameCtx.dt = delta;
  frameCtx.now = performance.now();
  frameCtx.connected = isConnected();
  updateSystems(frameCtx);

  // Desired velocity along lazy body orientation (not raw look). Dead divers drift.
  const move = isDead() ? ZERO_MOVE : getMovement();
  const swimYaw = getSwimYaw();
  const swimPitch = getSwimPitch();
  const cosP = Math.cos(swimPitch);
  _fwd.x = -Math.sin(swimYaw) * cosP;
  _fwd.y = Math.sin(swimPitch);
  _fwd.z = -Math.cos(swimYaw) * cosP;
  _right.x = Math.cos(swimYaw);
  _right.z = -Math.sin(swimYaw);

  // Carry: lower cap, downward pull (sink vs buoyancy).
  const carrying = hasLocalStatus(STATUS.CARRYING);
  const baseCap = carrying ? carrySpeedCap(MAX_SPEED) : MAX_SPEED;
  const speedCap = baseCap * (isSprinting() ? SPRINT_MULT : 1);
  _target.x = (_fwd.x * move.z + _right.x * move.x) * speedCap;
  _target.y = (_fwd.y * move.z + move.y) * speedCap;
  _target.z = (_fwd.z * move.z + _right.z * move.x) * speedCap;
  if (carrying) _target.y -= CARGO.SINK_RATE;

  // Water inertia.
  const k = 1 - Math.exp(-WATER_INERTIA * delta);
  vel.x += (_target.x - vel.x) * k;
  vel.y += (_target.y - vel.y) * k;
  vel.z += (_target.z - vel.z) * k;

  // Substep at ~0.5u to prevent tunnel clipping on sprints.
  const frameDist = Math.hypot(vel.x, vel.y, vel.z) * delta;
  const steps = Math.min(4, Math.max(1, Math.ceil(frameDist / 0.5)));
  const stepDelta = delta / steps;
  for (let s = 0; s < steps; s++) {
    pos.x += vel.x * stepDelta;
    pos.y += vel.y * stepDelta;
    pos.z += vel.z * stepDelta;

    // Resolve SDF collision; remove velocity component into wall (slide, no bounce).
    const hit = resolveCollision(pos, PLAYER_RADIUS);
    const bellHit = collideBathyscaphe(pos, PLAYER_RADIUS);
    for (const n of [hit, bellHit]) {
      if (!n) continue;
      const into = vel.x * n.x + vel.y * n.y + vel.z * n.z;
      if (into < 0) {
        vel.x -= n.x * into;
        vel.y -= n.y * into;
        vel.z -= n.z * into;
      }
    }
  }

  // Soft leash: boundary current pulls diver back.
  const distFromCenter = Math.hypot(pos.x, pos.y, pos.z);
  if (distFromCenter > WORLD_LIMIT) {
    const pull = (distFromCenter - WORLD_LIMIT) * 0.8 * delta;
    pos.x -= (pos.x / distFromCenter) * pull;
    pos.y -= (pos.y / distFromCenter) * pull;
    pos.z -= (pos.z / distFromCenter) * pull;
  }

  // First-person camera + subtle turn bank (reads as swimming).
  const speed = Math.hypot(vel.x, vel.y, vel.z) / MAX_SPEED;
  const rollTarget = Math.max(-0.09, Math.min(0.09, -getYawVelocity() * 0.03));
  cameraRoll += (rollTarget - cameraRoll) * Math.min(1, delta * 5);
  updateCamera(pos, yaw, pitch, Math.min(speed, 1), cameraRoll);

  // First-person body: trails lazy orientation; arms visible on look-down.
  updateLocalPlayer(
    pos,
    yaw,
    pitch,
    swimYaw,
    swimPitch,
    vel,
    hasLocalStatus(STATUS.CARRYING),
  );
  cargoSys.followCarrier();

  // Spatial audio follows camera; soundscape follows depth/speed/effort.
  setListenerPose(pos, yaw, pitch);
  updateAbyssAudio(delta, {
    speed: Math.min(1, speed),
    radius: distFromCenter,
    sprinting: isSprinting(),
  });

  // Broadcast throttled at NETWORK_RATE (24-byte binary, unreliable).
  networkTimer += delta;
  if (networkTimer >= NETWORK_RATE && frameCtx.connected) {
    networkTimer = 0;
    broadcastState(fillNetState());
  }

  // Sample remotes from buffers; sync voice positions.
  const remotePositions = game.remotePositions;
  remotePositions.length = 0;
  for (const [peerId, buffer] of game.remoteBuffers) {
    const s = buffer.sample();
    if (s) {
      updatePlayerPosition(peerId, s.x, s.y, s.z, s.yaw, s.pitch, s.sy, s.sp);
      setVoicePosition(peerId, s.x, s.y, s.z);
      // Pooled (reuse, no per-peer alloc).
      let entry = remotePosPool[remotePositions.length];
      if (!entry) {
        entry = { x: 0, y: 0, z: 0 };
        remotePosPool[remotePositions.length] = entry;
      }
      entry.x = s.x;
      entry.y = s.y;
      entry.z = s.z;
      remotePositions.push(entry);
    }
  }

  // HUD. Gold hidden by design (seek by sound); SHOW_GOUDA_BEARING overrides.
  drawCompass(yaw);
  depthText.textContent = `▼ ${Math.max(0, Math.round(ABYSS_DEPTH - pos.y))} m`;

  // Slow HUD: RTT + peer statuses.
  hudTimer += delta;
  if (hudTimer >= 0.5) {
    hudTimer = 0;
    const rtt = getWorstRtt();
    pingText.textContent = rtt !== null ? `⇄ ${rtt} ms` : "";
    let statusLine = "";
    for (const peerId of getPeerIds()) {
      const icons = statusIcons(getPeerStatus(peerId));
      if (icons) statusLine += `${peerId.slice(0, 4)} ${icons}  `;
    }
    peerStatusText.textContent = statusLine.trim();
  }
});

// Death & respawn: blackout, wake at berth.
initOxygen({
  onWarn: (t) => {
    playClick();
    showEvent(
      t <= 10
        ? "⚠️ O₂ CRITICAL — surface NOW"
        : `⚠️ O₂ at ${t}% — plan your way back`,
      3000,
    );
  },
  onDeath: () => {
    deathOverlay.classList.add("visible");
    showEvent("💀 Blackout… the abyss takes you.", DEATH_RESPAWN_MS);
    // Carried items dropped on death.
    cargoSys.fumble("🧀 Your grip fails — the Gouda slips away.");
    clearTimeout(respawnTimer);
    respawnTimer = setTimeout(() => {
      const s = game.spawnPoint;
      teleportLocal(s.x, s.y, s.z);
      refillOxygen();
      deathOverlay.classList.remove("visible");
      playWhoosh();
      showEvent("🫧 You wake at the bathyscaphe, tank refilled.");
    }, DEATH_RESPAWN_MS);
  },
});

// Dev: __abyssal console hook (status testing).
if (import.meta.env.DEV) {
  (window as unknown as { __abyssal?: unknown }).__abyssal = {
    setLocalStatus,
    STATUS,
    getPeerStatus,
    getPeerIds,
    setBellCount,
    game,
    getLocalPos: () => ({ ...game.localPosition }),
    teleport: teleportLocal,
    setLook,
    // Haul API: goldPos() → teleport → cargo.use().
    cargo: cargoSys,
    goldPos: getGoldPos,
    gouda: () => getItem("gouda"),
    goudaVisual: getMountedGouda, // live light/emissive tuning from the console
    getLocalStatus,
  };
}

// Compass strip.
const compassCtx = compassCanvas.getContext("2d")!;
const CARDINALS: Record<number, string> = {
  0: "N",
  45: "NE",
  90: "E",
  135: "SE",
  180: "S",
  225: "SW",
  270: "W",
  315: "NW",
};

function drawCompass(yaw: number) {
  const w = compassCanvas.width;
  const h = compassCanvas.height;
  const ctx = compassCtx;
  const pxPerDeg = w / 120;
  const heading = ((((-yaw * 180) / Math.PI) % 360) + 360) % 360;

  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(210, 235, 250, 0.75)";
  ctx.fillStyle = "rgba(210, 235, 250, 0.85)";
  ctx.font = "11px monospace";
  ctx.textAlign = "center";
  ctx.lineWidth = 1;

  // Iterate cardinal headings (avoid float-equality checks).
  for (let abs = 0; abs < 360; abs += 15) {
    const deg = ((((abs - heading + 540) % 360) + 360) % 360) - 180;
    if (deg < -60 || deg > 60) continue;
    const x = w / 2 + deg * pxPerDeg;
    const major = abs % 45 === 0;
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x, h - (major ? 10 : 5));
    ctx.stroke();
    if (major && CARDINALS[abs] !== undefined) {
      ctx.fillText(CARDINALS[abs], x, h - 14);
    }
  }

  ctx.fillRect(w / 2 - 1, h - 12, 2, 12);

  if (SHOW_GOUDA_BEARING) drawGoudaBearing(ctx, w, heading);
}

// TEMPORARY: Gouda bearing (playtest aid). Flip to false to disable.
const SHOW_GOUDA_BEARING = true;

function drawGoudaBearing(
  ctx: CanvasRenderingContext2D,
  w: number,
  heading: number,
) {
  // The item is the live wheel (it moves once someone lifts it); the seed
  // position is the fallback for the frame before it is spawned.
  const target = getItem("gouda") ?? getGoldPos();
  if (!target) return;

  const p = game.localPosition;
  const dx = target.x - p.x;
  const dy = target.y - p.y;
  const dz = target.z - p.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // Forward is (-sin yaw, -cos yaw) and heading is -yaw, so a heading h looks
  // along (sin h, -cos h) — invert that to get the wheel's absolute bearing.
  const bearing = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  // Signed shortest offset from where we are looking, in (-180, 180].
  const deg = ((((bearing - heading + 540) % 360) + 360) % 360) - 180;
  const off = deg < -60 || deg > 60; // outside the strip's 120° window
  // Clamped to the window, then inset so a pinned chevron stays on-canvas.
  const x = Math.max(
    8,
    Math.min(w - 8, w / 2 + Math.max(-60, Math.min(60, deg)) * (w / 120)),
  );

  ctx.fillStyle = "rgba(255, 208, 96, 0.95)";
  ctx.beginPath();
  if (off) {
    // Off the strip: a chevron pinned to the edge, pointing the short way.
    const s = deg > 0 ? 1 : -1; // apex leans the way you have to turn
    ctx.moveTo(x - s * 6, 14);
    ctx.lineTo(x - s * 6, 22);
    ctx.lineTo(x + s * 3, 18);
  } else {
    ctx.moveTo(x - 6, 14);
    ctx.lineTo(x + 6, 14);
    ctx.lineTo(x, 22);
  }
  ctx.closePath();
  ctx.fill();

  // Distance, kept clear of the canvas edges so it never clips.
  ctx.font = "11px monospace";
  ctx.textAlign = "center";
  ctx.fillText(
    `\u{1F9C0} ${Math.round(dist)} m ${dy > 2 ? "\u25B2" : dy < -2 ? "\u25BC" : "\u2022"}`,
    Math.max(46, Math.min(w - 46, x)),
    11,
  );
}

// --- Run won (M1.3, placeholder) -------------------------------------------
// The Gouda crossed the bell's hatch radius. M5.4 turns this into a real run
// summary (time, who died, who dropped it); for now it just has to
// be unmistakable that the run ENDED, and that you won it.
function showWin(carrier: string) {
  const mine = carrier === getMyId() || getPeerIds().indexOf(carrier) === -1;
  winSub.textContent = mine
    ? "you hauled it home"
    : `${carrier.slice(0, 4)} hauled it home`;
  winOverlay.classList.add("visible");
  carryPrompt.textContent = "";
  playWhoosh();
}

function showStatus(text: string) {
  statusPanel.classList.remove("hidden");
  statusText.textContent = text;
}

// Chat-like feed of transient toasts stacked on the side of the screen.
function showEvent(text: string, duration = 2200) {
  const toast = document.createElement("div");
  toast.className = "event-toast";
  toast.textContent = text;
  eventCenter.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => {
    toast.classList.remove("visible");
    toast.classList.add("leaving");
    setTimeout(() => toast.remove(), 400);
  }, duration);
}
