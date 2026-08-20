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
  setBellY,
  setWaterLevel,
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
  getBell,
  resetBell,
  startDrop,
  snapToLevel,
  updateBell,
  readyToDrop,
  slotOffset,
  ejectPosition,
  distanceToBell,
  ATTACH_RADIUS,
  SETTLE_DELAY,
} from "./bell.js";
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
const CEILING_Y = 4; // you cannot swim back above the start line

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
const restartBtn = document.getElementById("restart-btn");
const bellPrompt = document.getElementById("bell-prompt");
const eventCenter = document.getElementById("event-center");

const localPosition = { x: 0, y: 2, z: 8 };
const velocity = { x: 0, y: 0, z: 0 };
let networkTimer = 0;
let flashlightOn = true;

// Everyone starts hooked onto the bell; the first drop follows straight away.
let attached = true;
let mySlot = slotOffset("solo");
let isHost = false;
let settleTimer = -1; // counts down between the bell's stop and the ejection

const remoteBuffers = new Map(); // peerId -> SnapshotBuffer
const remoteAttached = new Map(); // peerId -> bool

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
    isHost = true;
    mySlot = slotOffset(id);
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
    mySlot = slotOffset(getPeer().id);
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

restartBtn.addEventListener("click", () => {
  restart();
  sendEvent({ kind: "restart" });
});

// Action keys (physical positions — layout-agnostic).
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyF") {
    flashlightOn = toggleFlashlight();
    showEvent(
      flashlightOn ? "🔦 Flashlight ON" : "🔦 Flashlight OFF — pitch black…",
    );
    // Sync immediately so the other diver sees your light die right away.
    broadcastNow();
  } else if (e.code === "KeyV") {
    toggleMute();
  } else if (e.code === "KeyE") {
    toggleAttach();
  } else if (e.code === "KeyR") {
    restart();
    sendEvent({ kind: "restart" });
  }
});

function broadcastNow() {
  if (!isConnected()) return;
  broadcastState(
    localPosition.x,
    localPosition.y,
    localPosition.z,
    getYaw(),
    getPitch(),
    flashlightOn,
    attached,
  );
}

// --- The bell cycle: hook on → all aboard → fall → thrown off → swim back ---

function toggleAttach() {
  if (attached) {
    attached = false;
    showEvent("⚓ Released — you are loose in the water.");
  } else if (distanceToBell(localPosition) > ATTACH_RADIUS) {
    showEvent("Too far from the bell to grab a handhold.");
    return;
  } else {
    attached = true;
    showEvent("⚓ Hooked on. Waiting for the others…");
  }
  broadcastNow();
}

// The bell shakes everyone off where it stops, each at their own random bearing.
function eject() {
  attached = false;
  const spot = ejectPosition(getBell().y);
  localPosition.x = spot.x;
  localPosition.y = spot.y;
  localPosition.z = spot.z;
  velocity.x = velocity.y = velocity.z = 0;
  // Forget remote history so interpolation doesn't sweep across the map.
  for (const buffer of remoteBuffers.values()) buffer.reset();
  showEvent("⨂ Thrown clear! Find the bell and hook back on.");
  broadcastNow();
}

function restart() {
  resetBell();
  setBellY(0);
  setWaterLevel(0);
  attached = true;
  settleTimer = -1;
  for (const peerId of remoteAttached.keys()) remoteAttached.set(peerId, true);
  for (const buffer of remoteBuffers.values()) buffer.reset();
  showEvent("⟲ Restart — everyone back on the bell at the surface.");
  broadcastNow();
}

// --- Network callbacks ---
onPeerConnected((peerId) => {
  addPlayer(peerId, REMOTE_COLOR);
  remoteBuffers.set(peerId, new SnapshotBuffer());
  remoteAttached.set(peerId, false);
  statusPanel.classList.add("hidden");
  if (hostedId) miniCopyLinkBtn.classList.remove("hidden"); // only the host has a link to share
  // A joiner starts at level 0 — drop them straight onto the bell's real depth.
  if (isHost) sendEvent({ kind: "sync", level: getBell().level });
});

onPeerDisconnected((peerId) => {
  removePlayer(peerId);
  remoteBuffers.delete(peerId);
  remoteAttached.delete(peerId);
  miniCopyLinkBtn.classList.add("hidden");
  showStatus("Diver disconnected.");
});

// Buffer remote state for interpolation — never applied directly.
// (Flashlight state is applied instantly: lights don't interpolate.)
onStateReceived((peerId, { x, y, z, yaw, pitch, light, att }) => {
  remoteBuffers.get(peerId)?.push({ x, y, z, yaw, pitch });
  remoteAttached.set(peerId, att === true);
  setPlayerLight(peerId, light !== false);
});

onEventReceived((peerId, data) => {
  if (data.kind === "drop") {
    startDrop(data.level);
    showEvent(`▼ The bell drops to level ${data.level}…`);
  } else if (data.kind === "sync") {
    snapToLevel(data.level);
    attached = true;
    settleTimer = -1;
  } else if (data.kind === "restart") {
    restart();
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

  // 2. Advance the bell, then hand out the ejection once it has settled.
  const bell = getBell();
  if (updateBell(delta)) settleTimer = SETTLE_DELAY;
  setBellY(bell.y);
  setWaterLevel(bell.level);
  if (settleTimer >= 0) {
    settleTimer -= delta;
    if (settleTimer < 0) eject();
  }

  const hooked =
    (attached ? 1 : 0) +
    [...remoteAttached.values()].filter(Boolean).length;
  const crew = 1 + remoteAttached.size;

  // 3. The host alone decides when the bell falls, and tells everyone.
  if (isHost && settleTimer < 0 && readyToDrop(delta, hooked, crew)) {
    const level = bell.level + 1;
    startDrop(level);
    sendEvent({ kind: "drop", level });
    showEvent(`▼ The bell drops to level ${level}…`);
  }

  if (attached) {
    // Riding the bell: the slot owns your position, swimming is disabled.
    localPosition.x = mySlot.x;
    localPosition.y = bell.y + mySlot.y;
    localPosition.z = mySlot.z;
    velocity.x = velocity.y = velocity.z = 0;
  } else {
    // 4. Desired velocity: swim where you look; strafe horizontal; Space/Shift vertical.
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

    // 5. Water inertia.
    const k = 1 - Math.exp(-WATER_INERTIA * delta);
    velocity.x += (target.x - velocity.x) * k;
    velocity.y += (target.y - velocity.y) * k;
    velocity.z += (target.z - velocity.z) * k;

    localPosition.x += velocity.x * delta;
    localPosition.y += velocity.y * delta;
    localPosition.z += velocity.z * delta;
    localPosition.y = Math.min(localPosition.y, CEILING_Y);
  }

  // 6. First-person camera (speed drives the flashlight bob).
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z) / MAX_SPEED;
  updateCamera(localPosition, yaw, pitch, Math.min(speed, 1));

  // 7. Spatial audio listener follows the camera.
  setListenerPose(localPosition, yaw, pitch);

  // 8. Broadcast local state, throttled.
  networkTimer += delta;
  if (networkTimer >= NETWORK_RATE) {
    networkTimer = 0;
    broadcastNow();
  }

  // 9. Smooth remote players from interpolation buffers + move their voices.
  for (const [peerId, buffer] of remoteBuffers) {
    const s = buffer.sample();
    if (s) {
      updatePlayerPosition(peerId, s.x, s.y, s.z, s.yaw, s.pitch);
      setVoicePosition(peerId, s.x, s.y, s.z);
    }
  }

  // 10. HUD.
  const bellDist = distanceToBell(localPosition);
  drawCompass(yaw, Math.atan2(-localPosition.x, localPosition.z));
  depthText.textContent = `LVL ${bell.level} · ▼ ${Math.max(0, Math.round(-localPosition.y))} m`;
  bellPrompt.textContent = attached
    ? `⚓ Hooked on — ${hooked}/${crew} aboard · E to release`
    : bellDist <= ATTACH_RADIUS
      ? `⚓ Press E to hook onto the bell — ${hooked}/${crew} aboard`
      : `Bell ${Math.round(bellDist)} m away — ${hooked}/${crew} aboard`;
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

function drawCompass(yaw, bellBearing) {
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

  // Bell marker, pinned to the strip edge when it is behind you, so the arrow
  // always says which way to turn.
  const bellDeg = (bellBearing * 180) / Math.PI;
  const rel = ((((bellDeg - heading + 540) % 360) + 360) % 360) - 180;
  const bx = w / 2 + clamp(rel, -60, 60) * pxPerDeg;
  ctx.fillStyle = "rgba(255, 205, 130, 0.95)";
  ctx.beginPath();
  ctx.moveTo(bx, 10);
  ctx.lineTo(bx - 5, 1);
  ctx.lineTo(bx + 5, 1);
  ctx.closePath();
  ctx.fill();

  // Center marker.
  ctx.fillStyle = "rgba(210, 235, 250, 0.85)";
  ctx.fillRect(w / 2 - 1, h - 12, 2, 12);
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
