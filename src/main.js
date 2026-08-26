// main.js — entry point: wires UI, graphics, network, voice, and input.
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
} from "./graphics.js";
import {
  initAbyssAudio,
  updateAbyssAudio,
  setExhaleListener,
  playDig,
  playBite,
  playClick,
  playWhoosh,
} from "./audio.js";
import {
  resolveCollision,
  findOpenSpot,
  getSpawnPoint,
  digAt,
  raycastSolid,
  WORLD_R,
} from "./gouda.js";
import {
  hostGame,
  joinGame,
  broadcastState,
  sendEvent,
  sendEventTo,
  onStateReceived,
  onEventReceived,
  onPeerConnected,
  onPeerDisconnected,
  isConnected,
  getPeer,
  getMyId,
  getHostId,
  getPeerIds,
  getWorstRtt,
  getSignalingMode,
} from "./network.js";
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
} from "./input.js";
import { SnapshotBuffer } from "./interpolation.js";
import { getShotConfig, applyShot } from "./shots.js";
import { setLook } from "./input.js";
import {
  spawnCatfish,
  despawnCatfish,
  updateCatfishSystem,
  getCatfishState,
  applyCatfishState,
  setCatfishAuthority,
} from "./catfish.js";
import {
  initVoice,
  callPeer,
  hangUp,
  onVoiceStatus,
  setListenerPose,
  setVoicePosition,
  toggleMute,
} from "./voice.js";
import {
  STATUS,
  getLocalStatus,
  setLocalStatus,
  updateEffects,
  onLocalStatusChange,
  setPeerStatus,
  getPeerStatus,
  clearPeerStatus,
  statusIcons,
} from "./effects.js";
import {
  initOxygen,
  updateOxygen,
  refillOxygen,
  isDead,
} from "./oxygen.js";
import { setBellCount, collideBathyscaphe } from "./bathyscaphe.js";

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

const RECHARGE_RADIUS = 16; // O₂ refill bubble around the spawn point
const DEATH_RESPAWN_MS = 2600; // blackout duration before waking at spawn

// --- UI elements ---
const menu = document.getElementById("menu");
const hostBtn = document.getElementById("host-btn");
const joinBtn = document.getElementById("join-btn");
const statusPanel = document.getElementById("status");
const statusText = document.getElementById("status-text");
const peerIdText = document.getElementById("peer-id");
const copyLinkBtn = document.getElementById("copy-link-btn");
const miniCopyLinkBtn = document.getElementById("mini-copy-link-btn");
const hud = document.getElementById("hud");
const compassCanvas = document.getElementById("compass");
const depthText = document.getElementById("depth");
const voiceText = document.getElementById("voice-indicator");
const scatterBtn = document.getElementById("scatter-btn");
const eventCenter = document.getElementById("event-center");
const o2Fill = document.getElementById("o2-fill");
const o2Bar = document.getElementById("o2-bar");
const pingText = document.getElementById("ping");
const peerStatusText = document.getElementById("peer-status");
const deathOverlay = document.getElementById("death-overlay");

const localPosition = { x: 0, y: 5, z: WORLD_R + 30 };
const velocity = { x: 0, y: 0, z: 0 };
const spawnPoint = { x: 0, y: 5, z: WORLD_R + 30 }; // bathyscaphe berth
let networkTimer = 0;
let fishNetTimer = 0; // authority → puppets fish-state broadcast throttle
let hudTimer = 0; // slow HUD refresh (ping, peer statuses)
const remotePositions = []; // rebuilt each frame — fish hunt the nearest diver
let flashlightOn = true;
let worldReady = false;
let cameraRoll = 0; // eased bank angle while turning
let fishAuthority = true; // solo & host simulate; becomes false on join
let fishAuthorityId = null; // who currently simulates the fish (election)
let respawnTimer = null;

const remoteBuffers = new Map(); // peerId -> SnapshotBuffer

// --- Setup ---
const canvas = initGraphics(document.getElementById("scene-container"));
initInput();
initMouseLook(canvas);

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
let seed = Number.parseInt(bootParams.get("seed") ?? "", 10);
if (!Number.isFinite(seed)) seed = (Math.random() * 2 ** 31) | 0;
let difficulty = Math.min(
  3,
  Math.max(1, Number.parseInt(bootParams.get("d") ?? "1", 10) || 1),
);

const loaderEl = document.getElementById("loader");
const loaderFill = document.getElementById("loader-fill");
const loaderLabel = document.getElementById("loader-label");

async function buildWorld(rebuild = false) {
  worldReady = false;
  loaderEl.classList.remove("done");
  const progress = (done, total, label) => {
    loaderFill.style.width = `${Math.round((done / total) * 100)}%`;
    loaderLabel.textContent = `seed ${seed} · carving ${label} · ${done}/${total}`;
  };
  const build = rebuild ? rebuildWorld : loadWorld;
  await build(progress, { seed, difficulty });
  // Spawn at the drift's edge, the whole glowing system in view (-Z).
  // This is also the O₂ recharge zone — the future bathyscaphe berth.
  const spawn = getSpawnPoint();
  spawnPoint.x = spawn.x;
  spawnPoint.y = spawn.y;
  spawnPoint.z = spawn.z;
  localPosition.x = spawn.x;
  localPosition.y = spawn.y;
  localPosition.z = spawn.z;
  velocity.x = velocity.y = velocity.z = 0;
  refillOxygen();
  for (const buffer of remoteBuffers.values()) buffer.reset();
  worldReady = true;
  loaderEl.classList.add("done");

  // Release the lantern-catfish — packs cruising the open water (plus a few
  // in the labyrinth). Host-simulated and broadcast to joiners; solo players
  // simulate their own.
  despawnCatfish();
  spawnCatfish(Math.min(8, 4 + difficulty), {
    onBite: (fishPos) => {
      // Shove the diver away from the snapping jaws.
      const dx = localPosition.x - fishPos.x;
      const dy = localPosition.y - fishPos.y;
      const dz = localPosition.z - fishPos.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      velocity.x += (dx / d) * 9;
      velocity.y += (dy / d) * 9;
      velocity.z += (dz / d) * 9;
      playBite();
      showEvent("🐟 A lantern-catfish snaps at you! Swim!");
    },
  });
}
// Headless screenshot mode (?shot=<name>, see shots.js + tools/runner.mjs):
// once the world is up, skip the menu and pin the player to the vantage point.
const shotConfig = getShotConfig();
buildWorld().then(() => {
  if (shotConfig) applyShot(shotConfig, teleportLocal, localPosition);
});

// --- UI handlers ---
hostBtn.addEventListener("click", async () => {
  showStatus("Creating game…");
  try {
    const id = await hostGame();
    hostedId = id;
    fishAuthority = true;
    fishAuthorityId = id;
    initVoice(getPeer());
    showStatus("Invite a diver:");
    peerIdText.textContent = id;
    peerIdText.classList.remove("hidden");
    copyLinkBtn.classList.remove("hidden");
    menu.classList.add("hidden");
    hud.classList.remove("hidden");
  } catch (err) {
    showStatus(`Hosting failed: ${err.message ?? err.type ?? err}`);
  }
});

// Invite link: open it in another window/device to auto-join this game.
// Includes the signaling mode so the joiner uses the SAME server as the host.
let hostedId = null;
function inviteUrl() {
  return `${location.origin}${location.pathname}?join=${encodeURIComponent(hostedId)}&s=${getSignalingMode()}&seed=${seed}&d=${difficulty}`;
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

async function join(hostId, mode = null) {
  showStatus("Connecting…");
  try {
    initVoiceEarly(); // install the call-answer handler before anyone dials us
    const remoteId = await joinGame(hostId.trim(), mode);
    // The host simulates the fish; we run puppets (until an election says
    // otherwise). Voice calls are placed per-peer by onPeerConnected.
    fishAuthority = false;
    fishAuthorityId = remoteId;
    setCatfishAuthority(false);
    menu.classList.add("hidden");
    hud.classList.remove("hidden");
  } catch (err) {
    showStatus(`Connection failed: ${err.message ?? err.type ?? err}`);
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
    flashlightOn = toggleFlashlight();
    playClick();
    showEvent(
      flashlightOn ? "🔦 Flashlight ON" : "🔦 Flashlight OFF — pitch black…",
    );
    // Sync immediately so the other divers see your light die right away.
    broadcastNow();
  } else if (e.code === "KeyV") {
    toggleMute();
  } else if (e.code === "KeyT" && isConnected()) {
    scatter();
  } else if (e.code === "KeyE") {
    tryDig();
  }
});

// --- Dig tool: carve a sphere out of whatever cheese you're aiming at. ---
// The world is a live SDF: digAt() edits the chunk's cached voxel field and
// re-runs marching cubes on just that chunk — collision follows exactly.
let lastDigAt = 0;
function tryDig() {
  if (!worldReady || isDead()) return;
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
  const hit = raycastSolid(localPosition, dir, DIG_RANGE);
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

function teleportLocal(x, y, z) {
  localPosition.x = x;
  localPosition.y = y;
  localPosition.z = z;
  velocity.x = velocity.y = velocity.z = 0;
  // Forget remote history so interpolation doesn't sweep across the map.
  for (const buffer of remoteBuffers.values()) buffer.reset();
  broadcastNow();
}

// Immediate state broadcast — used on discrete changes (light toggled,
// status flag flipped, teleport) so peers see them well under 100 ms
// instead of waiting for the next 30 Hz tick.
// One reused state object: broadcastState() encodes it synchronously, and
// this runs 30×/s — no need to allocate a fresh literal every tick.
const netState = {
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
  netState.x = localPosition.x;
  netState.y = localPosition.y;
  netState.z = localPosition.z;
  netState.yaw = getYaw();
  netState.pitch = getPitch();
  netState.sy = getSwimYaw();
  netState.sp = getSwimPitch();
  netState.light = flashlightOn;
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
onPeerConnected((peerId, { initiator } = {}) => {
  addPlayer(peerId, REMOTE_COLOR);
  remoteBuffers.set(peerId, new SnapshotBuffer());
  setBellCount(1 + getPeerIds().length); // one berth per diver in the crew
  if (initiator) callPeer(getPeer(), peerId);
  // The host's map is the authoritative one: tell the newcomer our seed.
  if (hostedId) sendEventTo(peerId, { kind: "seed", seed, d: difficulty });
  broadcastNow(); // let them place us immediately
  statusPanel.classList.add("hidden");
  scatterBtn.classList.remove("hidden");
  if (hostedId) miniCopyLinkBtn.classList.remove("hidden"); // only the host has a link to share
});

onPeerDisconnected((peerId) => {
  removePlayer(peerId);
  remoteBuffers.delete(peerId);
  clearPeerStatus(peerId);
  hangUp(peerId);
  setBellCount(1 + getPeerIds().length);
  // If the fish simulator left, elect a replacement: lowest peer id among
  // the survivors. Everyone computes the same result locally — consistent
  // without any extra messages.
  if (peerId === (fishAuthorityId ?? getHostId())) {
    const candidates = [getMyId(), ...getPeerIds()].filter(Boolean).sort();
    fishAuthorityId = candidates[0] ?? getMyId();
    fishAuthority = fishAuthorityId === getMyId();
    if (fishAuthority) setCatfishAuthority(true);
  }
  if (getPeerIds().length === 0) {
    fishAuthority = true;
    setCatfishAuthority(true);
    scatterBtn.classList.add("hidden");
    miniCopyLinkBtn.classList.add("hidden");
  }
  showStatus("Diver disconnected.");
});

// Buffer remote state for interpolation — never applied directly.
// (Flashlight + status are applied instantly: flags don't interpolate.)
onStateReceived((peerId, { x, y, z, yaw, pitch, light, sy, sp, status }) => {
  remoteBuffers.get(peerId)?.push({ x, y, z, yaw, pitch, sy, sp });
  setPlayerLight(peerId, light !== false);
  if (status !== undefined) setPeerStatus(peerId, status);
});

onEventReceived((peerId, data) => {
  if (data.kind === "tp") {
    teleportLocal(data.x, data.y ?? 5, data.z);
    playWhoosh();
    showEvent(
      "⨨ Scattered! Find your teammates — look for their lights, listen for their voices.",
    );
  } else if (data.kind === "dig") {
    // Teammate dug somewhere: apply the same carve locally.
    digAt(data.x, data.y, data.z, data.r ?? DIG_RADIUS);
    burstAt(data.x, data.y, data.z);
    // Audible only if they're digging nearby — muffled thumps through cheese.
    const dd = Math.hypot(
      data.x - localPosition.x,
      data.y - localPosition.y,
      data.z - localPosition.z,
    );
    if (dd < 45) playDig();
  } else if (data.kind === "fish" && !fishAuthority) {
    // The authority's fish states: run them as interpolated puppets.
    applyCatfishState(data.f);
  } else if (
    data.kind === "seed" &&
    peerId === getHostId() && // only the host's seed is authoritative
    data.seed !== seed
  ) {
    // Joined a host with a different map: adopt their seed and rebuild.
    seed = data.seed >>> 0;
    difficulty = data.d ?? difficulty;
    showEvent("🧀 Different map detected — rebuilding to the host's seed…");
    buildWorld(true);
  }
});

// --- Voice status indicator ---
onVoiceStatus((state) => {
  const labels = {
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
// Scratch objects for the per-frame math below — the loop must not allocate.
const ZERO_MOVE = Object.freeze({ x: 0, y: 0, z: 0 });
const _fwd = { x: 0, y: 0, z: 0 };
const _right = { x: 0, z: 0 };
const _target = { x: 0, y: 0, z: 0 };
const remotePosPool = []; // backing objects for remotePositions, by index
renderLoop((delta) => {
  if (!worldReady) return; // still carving the labyrinth

  // 1. Smooth the camera look toward the mouse target.
  updateLook(delta);
  const yaw = getYaw();
  const pitch = getPitch();

  // 1b. Timed status effects expire here (poison wears off, etc.).
  updateEffects();

  // 2. Desired velocity — along the lazy BODY orientation, not the raw look.
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

  const speedCap = MAX_SPEED * (isSprinting() ? SPRINT_MULT : 1);
  _target.x = (_fwd.x * move.z + _right.x * move.x) * speedCap;
  _target.y = (_fwd.y * move.z + move.y) * speedCap;
  _target.z = (_fwd.z * move.z + _right.z * move.x) * speedCap;

  // 3. Water inertia.
  const k = 1 - Math.exp(-WATER_INERTIA * delta);
  velocity.x += (_target.x - velocity.x) * k;
  velocity.y += (_target.y - velocity.y) * k;
  velocity.z += (_target.z - velocity.z) * k;

  // Move + collide in substeps of at most ~0.5 u: a stall frame (delta
  // clamped at 0.1 s) while sprinting covers 1.9 u — farther than the bell
  // wall is thick — and a single end-of-frame resolve would tunnel straight
  // through it. At normal framerates this stays a single step.
  const frameDist =
    Math.hypot(velocity.x, velocity.y, velocity.z) * delta;
  const steps = Math.min(4, Math.max(1, Math.ceil(frameDist / 0.5)));
  const stepDelta = delta / steps;
  for (let s = 0; s < steps; s++) {
    localPosition.x += velocity.x * stepDelta;
    localPosition.y += velocity.y * stepDelta;
    localPosition.z += velocity.z * stepDelta;

    // Cheese collision: the SDF pushes the diver out of the walls, then the
    // velocity component pointing into the wall is removed so you slide
    // along tunnel walls instead of bouncing.
    const hit = resolveCollision(localPosition, PLAYER_RADIUS);
    // The tin bells are solid too (walls + floor + crown, hatch open).
    const bellHit = collideBathyscaphe(localPosition, PLAYER_RADIUS);
    for (const n of [hit, bellHit]) {
      if (!n) continue;
      const into = velocity.x * n.x + velocity.y * n.y + velocity.z * n.z;
      if (into < 0) {
        velocity.x -= n.x * into;
        velocity.y -= n.y * into;
        velocity.z -= n.z * into;
      }
    }
  }

  // Soft leash: past the edge of the field, the current pushes you back.
  const distFromCenter = Math.hypot(
    localPosition.x,
    localPosition.y,
    localPosition.z,
  );
  if (distFromCenter > WORLD_LIMIT) {
    const pull = (distFromCenter - WORLD_LIMIT) * 0.8 * delta;
    localPosition.x -= (localPosition.x / distFromCenter) * pull;
    localPosition.y -= (localPosition.y / distFromCenter) * pull;
    localPosition.z -= (localPosition.z / distFromCenter) * pull;
  }

  // 4. First-person camera (speed drives the flashlight bob) with a subtle
  // bank into turns — reads as swimming, not as a tripod spinning.
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z) / MAX_SPEED;
  const rollTarget = Math.max(-0.09, Math.min(0.09, -getYawVelocity() * 0.03));
  cameraRoll += (rollTarget - cameraRoll) * Math.min(1, delta * 5);
  updateCamera(localPosition, yaw, pitch, Math.min(speed, 1), cameraRoll);

  // 4b. First-person body: trails the lazy swim orientation while the head
  // (camera) looks around freely — arms come into view when you look down.
  updateLocalPlayer(localPosition, yaw, pitch, swimYaw, swimPitch, velocity);

  // 4c. Lantern-catfish: host/solo simulates (hunting the nearest diver),
  // joiners interpolate the host's puppets.
  updateCatfishSystem(
    delta,
    localPosition,
    performance.now() / 1000,
    remotePositions,
  );
  if (fishAuthority && isConnected()) {
    fishNetTimer += delta;
    if (fishNetTimer >= 0.12) {
      fishNetTimer = 0;
      sendEvent({ kind: "fish", f: getCatfishState() });
    }
  }

  // 4d. Oxygen: drains while diving (faster when sprinting or in distress),
  // refills near the spawn point — the future bathyscaphe berth.
  const distToSpawn = Math.hypot(
    localPosition.x - spawnPoint.x,
    localPosition.y - spawnPoint.y,
    localPosition.z - spawnPoint.z,
  );
  const o2Frac = updateOxygen(delta, {
    sprinting: isSprinting(),
    status: getLocalStatus(),
    inRefillZone: distToSpawn < RECHARGE_RADIUS,
  });
  o2Fill.style.width = `${Math.round(o2Frac * 100)}%`;
  o2Bar.classList.toggle("low", o2Frac < 0.25 && !isDead());
  o2Bar.classList.toggle(
    "refilling",
    distToSpawn < RECHARGE_RADIUS && o2Frac < 1,
  );

  // 5. Spatial audio listener follows the camera; the procedural abyss
  // soundscape follows depth, speed, and effort.
  setListenerPose(localPosition, yaw, pitch);
  updateAbyssAudio(delta, {
    speed: Math.min(1, speed),
    radius: distFromCenter,
    sprinting: isSprinting(),
  });

  // 6. Broadcast local state, throttled — a 24-byte binary packet over the
  // unreliable channel (see network.js): losses are replaced, never resent.
  networkTimer += delta;
  if (networkTimer >= NETWORK_RATE && isConnected()) {
    networkTimer = 0;
    broadcastState(fillNetState());
  }

  // 7. Smooth remote players from interpolation buffers + move their voices.
  remotePositions.length = 0;
  for (const [peerId, buffer] of remoteBuffers) {
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

  // 8. HUD. (No gold tracker: the gold is hidden — search, listen for the
  // glow leaking out of tunnel mouths.)
  drawCompass(yaw);
  depthText.textContent = `▼ ${Math.max(0, Math.round(ABYSS_DEPTH - localPosition.y))} m`;

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
    // TODO(phase 1): drop the Golden Gouda (and any carried items) here.
    setLocalStatus(STATUS.CARRYING, false);
    clearTimeout(respawnTimer);
    respawnTimer = setTimeout(() => {
      teleportLocal(spawnPoint.x, spawnPoint.y, spawnPoint.z);
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
  window.__abyssal = {
    setLocalStatus,
    STATUS,
    getPeerStatus,
    getPeerIds,
    setBellCount,
    getLocalPos: () => ({ ...localPosition }),
    teleport: teleportLocal,
    setLook,
  };
}

// --- Compass strip (canvas, like a dive HUD) ---
const compassCtx = compassCanvas.getContext("2d");
const CARDINALS = {
  0: "N",
  45: "NE",
  90: "E",
  135: "SE",
  180: "S",
  225: "SW",
  270: "W",
  315: "NW",
};

function drawCompass(yaw) {
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

  // (No gold bearing — the gold is hidden somewhere in the wheels; the
  // compass only keeps you oriented.)
}

function showStatus(text) {
  statusPanel.classList.remove("hidden");
  statusText.textContent = text;
}

// Chat-like feed of transient toasts stacked on the side of the screen.
function showEvent(text, duration = 2200) {
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

