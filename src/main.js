// main.js — entry point: wires UI, graphics, network, voice, and input.
import {
  initGraphics,
  addPlayer,
  removePlayer,
  updatePlayerPosition,
  updateCamera,
  renderLoop,
  toggleFlashlight,
  setPlayerLight,
  loadWorld,
  rebuildWorld,
} from "./graphics.js";
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
  onStateReceived,
  onEventReceived,
  onPeerConnected,
  onPeerDisconnected,
  isConnected,
  getPeer,
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
} from "./input.js";
import { SnapshotBuffer } from "./interpolation.js";
import {
  initVoice,
  callPeer,
  onVoiceStatus,
  setListenerPose,
  setVoicePosition,
  toggleMute,
} from "./voice.js";

const MAX_SPEED = 10.0; // units per second — brisk fins
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

const localPosition = { x: 0, y: 5, z: WORLD_R + 30 };
const velocity = { x: 0, y: 0, z: 0 };
let networkTimer = 0;
let flashlightOn = true;
let worldReady = false;
let cameraRoll = 0; // eased bank angle while turning

const remoteBuffers = new Map(); // peerId -> SnapshotBuffer

// --- Setup ---
const canvas = initGraphics(document.getElementById("scene-container"));
initInput();
initMouseLook(canvas);

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
  const spawn = getSpawnPoint();
  localPosition.x = spawn.x;
  localPosition.y = spawn.y;
  localPosition.z = spawn.z;
  velocity.x = velocity.y = velocity.z = 0;
  for (const buffer of remoteBuffers.values()) buffer.reset();
  worldReady = true;
  loaderEl.classList.add("done");
}
buildWorld();

// --- UI handlers ---
hostBtn.addEventListener("click", async () => {
  showStatus("Creating game…");
  try {
    const id = await hostGame();
    hostedId = id;
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
    const remoteId = await joinGame(hostId.trim(), mode);
    initVoice(getPeer());
    callPeer(getPeer(), remoteId); // start proximity voice
    menu.classList.add("hidden");
    hud.classList.remove("hidden");
  } catch (err) {
    showStatus(`Connection failed: ${err.message ?? err.type ?? err}`);
    menu.classList.remove("hidden");
  }
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
    showEvent(
      flashlightOn ? "🔦 Flashlight ON" : "🔦 Flashlight OFF — pitch black…",
    );
    // Sync immediately so the other diver sees your light die right away.
    if (isConnected()) {
      broadcastState(
        localPosition.x,
        localPosition.y,
        localPosition.z,
        getYaw(),
        getPitch(),
        flashlightOn,
      );
    }
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
  if (!worldReady) return;
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
  showEvent("⛏ You carve into the gouda");
  if (isConnected()) {
    sendEvent({ kind: "dig", x: hit.x, y: hit.y, z: hit.z, r: DIG_RADIUS });
  }
}

// --- Scatter teleport: throw both divers into random open pockets of the
// labyrinth, 20-34 units apart.
function scatter() {
  if (!isConnected()) {
    showStatus("No diver connected yet.");
    return;
  }
  const a = findOpenSpot();
  const b = findOpenSpot(a, SCATTER_MIN, SCATTER_MAX);

  teleportLocal(a.x, a.y, a.z);
  sendEvent({ kind: "tp", x: b.x, y: b.y, z: b.z });
  showEvent(
    "⨨ Scattered! Find your teammate — look for their light, listen for their voice.",
  );
}

function teleportLocal(x, y, z) {
  localPosition.x = x;
  localPosition.y = y;
  localPosition.z = z;
  velocity.x = velocity.y = velocity.z = 0;
  // Forget remote history so interpolation doesn't sweep across the map.
  for (const buffer of remoteBuffers.values()) buffer.reset();
  if (isConnected()) {
    broadcastState(
      localPosition.x,
      localPosition.y,
      localPosition.z,
      getYaw(),
      getPitch(),
      flashlightOn,
    );
  }
}

// --- Network callbacks ---
onPeerConnected((peerId) => {
  addPlayer(peerId, REMOTE_COLOR);
  remoteBuffers.set(peerId, new SnapshotBuffer());
  // The host's map is the authoritative one: tell the joiner our seed.
  if (hostedId) sendEvent({ kind: "seed", seed, d: difficulty });
  statusPanel.classList.add("hidden");
  scatterBtn.classList.remove("hidden");
  if (hostedId) miniCopyLinkBtn.classList.remove("hidden"); // only the host has a link to share
});

onPeerDisconnected((peerId) => {
  removePlayer(peerId);
  remoteBuffers.delete(peerId);
  scatterBtn.classList.add("hidden");
  miniCopyLinkBtn.classList.add("hidden");
  showStatus("Diver disconnected.");
});

// Buffer remote state for interpolation — never applied directly.
// (Flashlight state is applied instantly: lights don't interpolate.)
onStateReceived((peerId, { x, y, z, yaw, pitch, light }) => {
  remoteBuffers.get(peerId)?.push({ x, y, z, yaw, pitch });
  setPlayerLight(peerId, light !== false);
});

onEventReceived((peerId, data) => {
  if (data.kind === "tp") {
    teleportLocal(data.x, data.y ?? 5, data.z);
    showEvent(
      "⨨ Scattered! Find your teammate — look for their light, listen for their voice.",
    );
  } else if (data.kind === "dig") {
    // Teammate dug somewhere: apply the same carve locally.
    digAt(data.x, data.y, data.z, data.r ?? DIG_RADIUS);
  } else if (data.kind === "seed" && data.seed !== seed) {
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
renderLoop((delta) => {
  if (!worldReady) return; // still carving the labyrinth

  // 1. Smooth the camera look toward the mouse target.
  updateLook(delta);
  const yaw = getYaw();
  const pitch = getPitch();

  // 2. Desired velocity — along the lazy BODY orientation, not the raw look.
  // The body trails the head, so glancing around mid-swim doesn't zigzag
  // your trajectory; hold a direction and the body settles onto it.
  const move = getMovement();
  const swimYaw = getSwimYaw();
  const swimPitch = getSwimPitch();
  const cosP = Math.cos(swimPitch);
  const fwd = {
    x: -Math.sin(swimYaw) * cosP,
    y: Math.sin(swimPitch),
    z: -Math.cos(swimYaw) * cosP,
  };
  const right = { x: Math.cos(swimYaw), z: -Math.sin(swimYaw) };

  const target = {
    x: (fwd.x * move.z + right.x * move.x) * MAX_SPEED,
    y: (fwd.y * move.z + move.y) * MAX_SPEED,
    z: (fwd.z * move.z + right.z * move.x) * MAX_SPEED,
  };

  // 3. Water inertia.
  const k = 1 - Math.exp(-WATER_INERTIA * delta);
  velocity.x += (target.x - velocity.x) * k;
  velocity.y += (target.y - velocity.y) * k;
  velocity.z += (target.z - velocity.z) * k;

  localPosition.x += velocity.x * delta;
  localPosition.y += velocity.y * delta;
  localPosition.z += velocity.z * delta;

  // Cheese collision: the SDF pushes the diver out of the walls, then the
  // velocity component pointing into the wall is removed so you slide along
  // tunnel walls instead of bouncing.
  const hit = resolveCollision(localPosition, PLAYER_RADIUS);
  if (hit) {
    const into = velocity.x * hit.x + velocity.y * hit.y + velocity.z * hit.z;
    if (into < 0) {
      velocity.x -= hit.x * into;
      velocity.y -= hit.y * into;
      velocity.z -= hit.z * into;
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

  // 5. Spatial audio listener follows the camera.
  setListenerPose(localPosition, yaw, pitch);

  // 6. Broadcast local state, throttled.
  networkTimer += delta;
  if (networkTimer >= NETWORK_RATE && isConnected()) {
    networkTimer = 0;
    broadcastState(
      localPosition.x,
      localPosition.y,
      localPosition.z,
      yaw,
      pitch,
      flashlightOn,
    );
  }

  // 7. Smooth remote players from interpolation buffers + move their voices.
  for (const [peerId, buffer] of remoteBuffers) {
    const s = buffer.sample();
    if (s) {
      updatePlayerPosition(peerId, s.x, s.y, s.z, s.yaw, s.pitch);
      setVoicePosition(peerId, s.x, s.y, s.z);
    }
  }

  // 8. HUD. (No gold tracker: the gold is hidden — search, listen for the
  // glow leaking out of tunnel mouths.)
  drawCompass(yaw);
  depthText.textContent = `▼ ${Math.max(0, Math.round(ABYSS_DEPTH - localPosition.y))} m`;
});

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

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
