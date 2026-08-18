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
  terrainHeight,
} from "./graphics.js";
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

const MAX_SPEED = 4.5; // units per second
const WATER_INERTIA = 4; // how quickly velocity reaches its target
const NETWORK_RATE = 1 / 30; // send state 30x per second
const SURFACE_Y = 30; // conceptual waterline, for the depth readout
const EYE_CLEARANCE = 1.0; // min height above the terrain

const MAP_RANGE = 75; // scatter teleports stay within ±this
const SCATTER_MIN = 20; // min/max distance between the two divers
const SCATTER_MAX = 34;

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

const localPosition = { x: 0, y: 2, z: 8 };
const velocity = { x: 0, y: 0, z: 0 };
let networkTimer = 0;
let flashlightOn = true;

const remoteBuffers = new Map(); // peerId -> SnapshotBuffer

// --- Setup ---
const canvas = initGraphics(document.getElementById("scene-container"));
initInput();
initMouseLook(canvas);

// --- UI handlers ---
hostBtn.addEventListener("click", async () => {
  showStatus("Creating game…");
  try {
    const id = await hostGame();
    hostedId = id;
    initVoice(getPeer());
    showStatus(
      `Waiting for a diver to join (signaling: ${getSignalingMode()}). Share this ID or link:`,
    );
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
  return `${location.origin}${location.pathname}?join=${encodeURIComponent(hostedId)}&s=${getSignalingMode()}`;
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
  }
});

// --- Scatter teleport: throw both divers to random spots, 20-34 units apart.
function scatter() {
  if (!isConnected()) {
    showStatus("No diver connected yet.");
    return;
  }
  const a = {
    x: (Math.random() - 0.5) * 2 * MAP_RANGE,
    z: (Math.random() - 0.5) * 2 * MAP_RANGE,
  };
  const angle = Math.random() * Math.PI * 2;
  const dist = SCATTER_MIN + Math.random() * (SCATTER_MAX - SCATTER_MIN);
  const b = {
    x: clamp(a.x + Math.cos(angle) * dist, -MAP_RANGE, MAP_RANGE),
    z: clamp(a.z + Math.sin(angle) * dist, -MAP_RANGE, MAP_RANGE),
  };

  teleportLocal(a.x, a.z);
  sendEvent({ kind: "tp", x: b.x, z: b.z });
  showEvent(
    "⨨ Scattered! Find your teammate — look for their light, listen for their voice.",
  );
}

function teleportLocal(x, z) {
  localPosition.x = x;
  localPosition.z = z;
  localPosition.y = terrainHeight(x, z) + 2 + Math.random() * 4;
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
    teleportLocal(data.x, data.z);
    showEvent(
      "⨨ Scattered! Find your teammate — look for their light, listen for their voice.",
    );
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
  // 1. Smooth the camera look toward the mouse target.
  updateLook(delta);
  const yaw = getYaw();
  const pitch = getPitch();

  // 2. Desired velocity: swim where you look; strafe horizontal; Space/Shift vertical.
  const move = getMovement();
  const cosP = Math.cos(pitch);
  const fwd = {
    x: -Math.sin(yaw) * cosP,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosP,
  };
  const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };

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

  // Terrain collision + ceiling.
  const minY = terrainHeight(localPosition.x, localPosition.z) + EYE_CLEARANCE;
  localPosition.y = clamp(localPosition.y, minY, SURFACE_Y - 2);

  // 4. First-person camera (speed drives the flashlight bob).
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z) / MAX_SPEED;
  updateCamera(localPosition, yaw, pitch, Math.min(speed, 1));

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

  // 8. HUD.
  drawCompass(yaw);
  depthText.textContent = `▼ ${Math.max(0, Math.round(SURFACE_Y - localPosition.y))} m`;
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

  for (let deg = -60; deg <= 60; deg += 5) {
    const abs = (((heading + deg) % 360) + 360) % 360;
    if (abs % 15 !== 0) continue;
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
}

function showStatus(text) {
  statusPanel.classList.remove("hidden");
  statusText.textContent = text;
}

let eventTimer = null;
function showEvent(text, duration = 2200) {
  eventCenter.textContent = text;
  eventCenter.classList.add("visible");
  clearTimeout(eventTimer);
  eventTimer = setTimeout(
    () => eventCenter.classList.remove("visible"),
    duration,
  );
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
