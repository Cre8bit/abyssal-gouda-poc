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

const SCATTER_MIN = 20; // min/max distance between the two divers
const SCATTER_MAX = 34;

const DIG_RADIUS = 2.4; // carve sphere radius (world units)
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
const scatterBtn = el("scatter-btn");
const eventCenter = el("event-center");
const o2Fill = el("o2-fill");
const o2Bar = el("o2-bar");
const pingText = el("ping");
const peerStatusText = el("peer-status");
const deathOverlay = el("death-overlay");
const winOverlay = el("win-overlay");
const winSub = el("win-sub");
const carryPrompt = el("carry-prompt");

// Network events arrive as loose GameEvent records — each handled kind
// trusts its payload shape exactly as the JS did (same-version peers).
interface TpEvent {
  x: number;
  y?: number;
  z: number;
}
// The carve shape is shared with state.ts — mid-build digs are queued there.
type DigEvent = SphereDig;
interface SeedEvent {
  seed: number;
  d?: number;
}

// PeerJS errors carry .type; DOM/JS errors carry .message — show whichever.
function errMsg(err: unknown): string {
  const e = err as { message?: string; type?: string } | null;
  return e?.message ?? e?.type ?? String(err);
}

let respawnTimer: ReturnType<typeof setTimeout> | undefined;

// --- Setup ---
const canvas = initGraphics(el("scene-container"));
initInput();
initMouseLook(canvas);

// Simulation systems, in explicit execution order (see systems/types.ts):
// the loop runs them in ONE slot — after input smoothing, before physics.
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

// Procedural abyss soundscape — must boot inside a user gesture, so hook
// every plausible first interaction (idempotent).
for (const evt of ["pointerdown", "keydown"]) {
  window.addEventListener(evt, () => initAbyssAudio(), { passive: true });
}
// The regulator's exhale releases a visible bubble cluster at the helmet.
setExhaleListener(() => emitBreath(4 + ((Math.random() * 3) | 0)));

// --- World generation, with a loading screen ---
// Every game gets its own seed: from the URL if present (invite links carry
// it), otherwise random. The host's seed wins — joiners rebuild on mismatch.
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
  // Fresh-world slate: motion, interpolation history (state.ts) + every
  // system's own residue — statuses, oxygen, the old school, items.
  resetGameState();
  resetSystems();
  loaderEl.classList.remove("done");
  const progress = (done: number, total: number, label: string) => {
    loaderFill.style.width = `${Math.round((done / total) * 100)}%`;
    loaderLabel.textContent = `seed ${game.seed} · carving ${label} · ${done}/${total}`;
  };
  const build = rebuild ? rebuildWorld : loadWorld;
  await build(progress, { seed: game.seed, difficulty: game.difficulty });
  // Spawn at the drift's edge, the whole glowing system in view (-Z).
  // This is also the O₂ recharge zone — the bathyscaphe berth.
  placeAtSpawn(getSpawnPoint());
  refillOxygen();
  game.worldReady = true;
  // Replay carves that landed during the build — geometry only: the burst and
  // the thump belong to a moment that has already passed (and to a position
  // the diver was nowhere near, since we were still on the loading screen).
  for (const d of game.pendingDigs) digAt(d.x, d.y, d.z, d.r ?? DIG_RADIUS);
  game.pendingDigs.length = 0;
  loaderEl.classList.add("done");

  // Release the lantern-catfish (host/solo simulate; joiners get puppets
  // rebuilt from the authority's first fish-state broadcast).
  catfishSys.spawn(game.difficulty);
  // Seed the Golden Gouda into its cavern. Same seed → same hiding place on
  // every client, so placing it costs nothing on the wire (M1.2).
  cargoSys.spawn();
  // …but a REBUILD wiped the registry, so anything that has already moved
  // (the wheel is in someone's arms, a light stick was dropped) has to come
  // back from the host.
  const hostId = getHostId();
  if (hostId) requestItemSnapshotFrom(hostId);
}
// Headless screenshot mode (?shot=<name>, see shots.js + tools/runner.mjs):
// once the world is up, skip the menu and pin the player to the vantage point.
const shotConfig = getShotConfig();
buildWorld().then(() => {
  if (shotConfig) applyShot(shotConfig, teleportLocal, game.localPosition);
});

// --- UI handlers ---
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

// Invite link: open it in another window/device to auto-join this game.
// Includes the signaling mode so the joiner uses the SAME server as the host.
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

// Compact stand-in for the copy-link button once the status panel is gone
// (a diver has joined) — still lets the host share the link for more peers.
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

// initVoice needs the Peer object, which only exists after joinGame() starts
// creating it — but incoming calls can race us. Poll briefly until it's up,
// with a cap: if the join failed, the peer never appears and an uncapped
// poll would spin forever.
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

scatterBtn.addEventListener("click", scatter);

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
  } else if (e.code === "KeyT" && isConnected()) {
    scatter();
  } else if (e.code === "KeyE") {
    // One contextual verb: the Gouda first (lift it, or hand it over), the
    // pickaxe otherwise. They can never both apply — you cannot dig with
    // both arms full, which is exactly why the wheel gets first refusal.
    if (!cargoSys.use()) tryDig();
  }
});

// --- Dig tool: carve a sphere out of whatever cheese you're aiming at. ---
// The world is a live SDF: digAt() edits the chunk's cached voxel field and
// re-runs marching cubes on just that chunk — collision follows exactly.
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
  digAt(hit.x, hit.y, hit.z, DIG_RADIUS);
  playDig();
  burstAt(hit.x, hit.y, hit.z); // gas pockets tear free of the cheese
  showEvent("⛏ You carve into the gouda");
  if (isConnected()) {
    sendEvent({ kind: "dig", x: hit.x, y: hit.y, z: hit.z, r: DIG_RADIUS });
  }
}

// --- Scatter teleport: throw EVERY diver into their own random open pocket
// of the labyrinth, each 20-34 units from the previous one.
function scatter() {
  if (!isConnected()) {
    showStatus("No diver connected yet.");
    return;
  }
  let prev = findOpenSpot();
  teleportLocal(prev.x, prev.y, prev.z);
  playWhoosh();
  // Each peer gets a DISTINCT spot (the old broadcast sent everyone to the
  // same one — fine at 2 players, a pile-up at 4).
  for (const peerId of getPeerIds()) {
    prev = findOpenSpot(prev, SCATTER_MIN, SCATTER_MAX);
    sendEventTo(peerId, { kind: "tp", x: prev.x, y: prev.y, z: prev.z });
  }
  showEvent(
    "⨨ Scattered! Find your teammates — look for their lights, listen for their voices.",
  );
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

// Immediate state broadcast — used on discrete changes (light toggled,
// status flag flipped, teleport) so peers see them well under 100 ms
// instead of waiting for the next 30 Hz tick.
// One reused state object: broadcastState() encodes it synchronously, and
// this runs 30×/s — no need to allocate a fresh literal every tick.
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

// --- Network callbacks ---
// Mesh: `initiator` is true when WE dialed this peer (we joined after them),
// in which case we also place the voice call — the other side just answers.
// Result: every pair gets exactly one data link and one voice call.
onPeerConnected((peerId, { initiator }) => {
  addPlayer(peerId, REMOTE_COLOR);
  game.remoteBuffers.set(peerId, new SnapshotBuffer());
  setBellCount(1 + getPeerIds().length); // one berth per diver in the crew
  if (initiator) {
    const peer = getPeer(); // non-null: a mesh link just opened through it
    if (peer) callPeer(peer, peerId);
  }
  if (game.hostedId) {
    // The host's map is the authoritative one: tell the newcomer our seed,
    // then every live dynamic item (light sticks, drops…).
    sendEventTo(peerId, { kind: "seed", seed: game.seed, d: game.difficulty });
    sendItemSnapshotTo(peerId);
  }
  broadcastNow(); // let them place us immediately
  statusPanel.classList.add("hidden");
  scatterBtn.classList.remove("hidden");
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
    scatterBtn.classList.add("hidden");
    miniCopyLinkBtn.classList.add("hidden");
  }
  showStatus("Diver disconnected.");
});

// Buffer remote state for interpolation — never applied directly.
// (Flashlight + status are applied instantly: flags don't interpolate.)
onStateReceived((peerId, { x, y, z, yaw, pitch, light, sy, sp, status }) => {
  game.remoteBuffers.get(peerId)?.push({ x, y, z, yaw, pitch, sy, sp });
  setPlayerLight(peerId, light !== false);
  if (status !== undefined) setPeerStatus(peerId, status);
});

onEventReceived((peerId, data) => {
  // Systems first (fish states, item replication…) — the registry routes by
  // declared kind. What remains is world/orchestrator business.
  if (dispatchSystemEvent(peerId, data.kind, data)) return;
  if (data.kind === "tp") {
    const d = data as unknown as TpEvent;
    teleportLocal(d.x, d.y ?? 5, d.z);
    playWhoosh();
    showEvent(
      "⨨ Scattered! Find your teammates — look for their lights, listen for their voices.",
    );
  } else if (data.kind === "dig") {
    // Teammate dug somewhere: apply the same carve locally.
    const d = data as unknown as DigEvent;
    if (!game.worldReady) {
      // Mid-carve: digAt() would only reach the chunks built so far and the
      // rest would come out of the oven unbroken. Replay it after the build.
      game.pendingDigs.push(d);
      return;
    }
    digAt(d.x, d.y, d.z, d.r ?? DIG_RADIUS);
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

// --- Voice status indicator ---
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

// --- Game loop ---
// Frame order is fixed: input smoothing → systems (effects/oxygen/catfish/
// items, sorted by their `order`) → physics → camera/body → audio → network
// broadcast → remote interpolation → HUD.
// Scratch objects for the per-frame math below — the loop must not allocate.
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
  if (!game.worldReady) return; // still carving the labyrinth
  const pos = game.localPosition;
  const vel = game.velocity;

  // 1. Smooth the camera look toward the mouse target.
  updateLook(delta);
  const yaw = getYaw();
  const pitch = getPitch();

  // 2. Simulation systems, in their declared order.
  frameCtx.dt = delta;
  frameCtx.now = performance.now();
  frameCtx.connected = isConnected();
  updateSystems(frameCtx);

  // 3. Desired velocity — along the lazy BODY orientation, not the raw look.
  // The body trails the head, so glancing around mid-swim doesn't zigzag
  // your trajectory; hold a direction and the body settles onto it.
  // A blacked-out diver drifts, limp — no propulsion.
  const move = isDead() ? ZERO_MOVE : getMovement();
  const swimYaw = getSwimYaw();
  const swimPitch = getSwimPitch();
  const cosP = Math.cos(swimPitch);
  _fwd.x = -Math.sin(swimYaw) * cosP;
  _fwd.y = Math.sin(swimPitch);
  _fwd.z = -Math.cos(swimYaw) * cosP;
  _right.x = Math.cos(swimYaw);
  _right.z = -Math.sin(swimYaw);

  // Hauling the Golden Gouda: a lower cap and a constant pull downward
  // (G3). The sink is applied to the TARGET velocity, so swimming up still
  // works — you just have to keep doing it, and the moment you stop kicking
  // the abyss starts taking it back down (D3: home is up).
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

  // Move + collide in substeps of at most ~0.5 u: a stall frame (delta
  // clamped at 0.1 s) while sprinting covers 1.9 u — farther than the bell
  // wall is thick — and a single end-of-frame resolve would tunnel straight
  // through it. At normal framerates this stays a single step.
  const frameDist = Math.hypot(vel.x, vel.y, vel.z) * delta;
  const steps = Math.min(4, Math.max(1, Math.ceil(frameDist / 0.5)));
  const stepDelta = delta / steps;
  for (let s = 0; s < steps; s++) {
    pos.x += vel.x * stepDelta;
    pos.y += vel.y * stepDelta;
    pos.z += vel.z * stepDelta;

    // Cheese collision: the SDF pushes the diver out of the walls, then the
    // velocity component pointing into the wall is removed so you slide
    // along tunnel walls instead of bouncing.
    const hit = resolveCollision(pos, PLAYER_RADIUS);
    // The tin bells are solid too (walls + floor + crown, hatch open).
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

  // Soft leash: past the edge of the field, the current pushes you back.
  const distFromCenter = Math.hypot(pos.x, pos.y, pos.z);
  if (distFromCenter > WORLD_LIMIT) {
    const pull = (distFromCenter - WORLD_LIMIT) * 0.8 * delta;
    pos.x -= (pos.x / distFromCenter) * pull;
    pos.y -= (pos.y / distFromCenter) * pull;
    pos.z -= (pos.z / distFromCenter) * pull;
  }

  // 4. First-person camera (speed drives the flashlight bob) with a subtle
  // bank into turns — reads as swimming, not as a tripod spinning.
  const speed = Math.hypot(vel.x, vel.y, vel.z) / MAX_SPEED;
  const rollTarget = Math.max(-0.09, Math.min(0.09, -getYawVelocity() * 0.03));
  cameraRoll += (rollTarget - cameraRoll) * Math.min(1, delta * 5);
  updateCamera(pos, yaw, pitch, Math.min(speed, 1), cameraRoll);

  // 4b. First-person body: trails the lazy swim orientation while the head
  // (camera) looks around freely — arms come into view when you look down.
  updateLocalPlayer(pos, yaw, pitch, swimYaw, swimPitch, vel);
  // 4c. …and whatever is in those arms rides the body it is strapped to.
  cargoSys.followCarrier();

  // 5. Spatial audio listener follows the camera; the procedural abyss
  // soundscape follows depth, speed, and effort.
  setListenerPose(pos, yaw, pitch);
  updateAbyssAudio(delta, {
    speed: Math.min(1, speed),
    radius: distFromCenter,
    sprinting: isSprinting(),
  });

  // 6. Broadcast local state, throttled — a 24-byte binary packet over the
  // unreliable channel (see network/): losses are replaced, never resent.
  networkTimer += delta;
  if (networkTimer >= NETWORK_RATE && frameCtx.connected) {
    networkTimer = 0;
    broadcastState(fillNetState());
  }

  // 7. Smooth remote players from interpolation buffers + move their voices.
  const remotePositions = game.remotePositions;
  remotePositions.length = 0;
  for (const [peerId, buffer] of game.remoteBuffers) {
    const s = buffer.sample();
    if (s) {
      updatePlayerPosition(peerId, s.x, s.y, s.z, s.yaw, s.pitch, s.sy, s.sp);
      setVoicePosition(peerId, s.x, s.y, s.z);
      // Pooled by index — same objects reused every frame, no per-peer churn.
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

  // 8. HUD. (The gold is hidden by design — search, listen for the glow
  // leaking out of tunnel mouths. SHOW_GOUDA_BEARING temporarily overrides
  // that for playtesting; see drawGoudaBearing.)
  drawCompass(yaw);
  depthText.textContent = `▼ ${Math.max(0, Math.round(ABYSS_DEPTH - pos.y))} m`;

  // 8b. Slow HUD refresh: mesh latency + teammate status flags.
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

// --- Death & respawn: blackout, then wake at the bathyscaphe berth ---------
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
    // Limp hands: whatever you were carrying is left in the water where you
    // blacked out, not carried home for you.
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

// Dev hook: flip status bits from the console to verify T0.2's AC
// (e.g. __abyssal.setLocalStatus(__abyssal.STATUS.TRAPPED, true, 5000)).
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
    // The haul (M1), driveable from the console or a headless harness:
    // __abyssal.goldPos() → teleport next to it → cargo.use() to lift it.
    cargo: cargoSys,
    goldPos: getGoldPos,
    gouda: () => getItem("gouda"),
    goudaVisual: getMountedGouda, // live light/emissive tuning from the console
    getLocalStatus,
  };
}

// --- Compass strip (canvas, like a dive HUD) ---
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
  const pxPerDeg = w / 120; // 120° field of view on the strip
  const heading = ((((-yaw * 180) / Math.PI) % 360) + 360) % 360;

  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(210, 235, 250, 0.75)";
  ctx.fillStyle = "rgba(210, 235, 250, 0.85)";
  ctx.font = "11px monospace";
  ctx.textAlign = "center";
  ctx.lineWidth = 1;

  // Iterate fixed absolute headings (heading is a continuous float, so
  // comparing it against multiples of 15 directly would almost never match).
  for (let abs = 0; abs < 360; abs += 15) {
    // Signed shortest distance from the current heading, in (-180, 180].
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

  // Center marker.
  ctx.fillRect(w / 2 - 1, h - 12, 2, 12);

  if (SHOW_GOUDA_BEARING) drawGoudaBearing(ctx, w, heading);
}

// --- TEMPORARY playtest aid: bearing to the Golden Gouda -------------------
// This deliberately breaks register D4 (the wheel is hidden and never
// tracked — you find it by searching and by the glow leaking out of tunnel
// mouths). It exists so a solo tester can reach the cargo without digging the
// whole labyrinth first. Flip the flag to false (or delete this block and the
// call above, plus the extra 14px of canvas height in index.html) to get the
// real HUD back.
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
// summary (time, essence, who died, who dropped it); for now it just has to
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
