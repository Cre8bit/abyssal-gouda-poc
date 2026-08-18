// main.js — entry point: wires UI, graphics, network, and input together.
import {
  initGraphics,
  addPlayer,
  removePlayer,
  updatePlayerPosition,
  updateCamera,
  renderLoop,
} from "./graphics.js";
import {
  hostGame,
  joinGame,
  broadcastState,
  onStateReceived,
  onPeerConnected,
  onPeerDisconnected,
  isConnected,
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

const MAX_SPEED = 4.5; // units per second
const WATER_INERTIA = 4; // how quickly velocity reaches its target
const NETWORK_RATE = 1 / 20; // send state 20x per second
const FLOOR_Y = -1.3; // eye level can't go below this
const SURFACE_Y = 28;

const REMOTE_COLOR = 0x66ff99;

// --- UI elements ---
const menu = document.getElementById("menu");
const hostBtn = document.getElementById("host-btn");
const joinBtn = document.getElementById("join-btn");
const statusPanel = document.getElementById("status");
const statusText = document.getElementById("status-text");
const peerIdText = document.getElementById("peer-id");

const localPosition = { x: 0, y: 2, z: 0 };
const velocity = { x: 0, y: 0, z: 0 };
let networkTimer = 0;

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
    showStatus("Waiting for a player to join. Share this ID:");
    peerIdText.textContent = id;
    peerIdText.classList.remove("hidden");
    menu.classList.add("hidden");
  } catch (err) {
    showStatus(`Hosting failed: ${err.message ?? err.type ?? err}`);
  }
});

joinBtn.addEventListener("click", async () => {
  const hostId = prompt("Enter the Host ID:");
  if (!hostId) return;

  showStatus("Connecting…");
  try {
    await joinGame(hostId.trim());
    menu.classList.add("hidden");
  } catch (err) {
    showStatus(`Connection failed: ${err.message ?? err.type ?? err}`);
  }
});

// --- Network callbacks ---
onPeerConnected((peerId) => {
  addPlayer(peerId, REMOTE_COLOR);
  remoteBuffers.set(peerId, new SnapshotBuffer());
  showStatus("Diver connected! Swim: ZQSD/WASD · Look: mouse · Up/Down: Space/Shift");
  peerIdText.classList.add("hidden");
});

onPeerDisconnected((peerId) => {
  removePlayer(peerId);
  remoteBuffers.delete(peerId);
  showStatus("Diver disconnected.");
});

// Don't apply remote state directly — buffer it for interpolation.
onStateReceived((peerId, { x, y, z, yaw }) => {
  remoteBuffers.get(peerId)?.push({ x, y, z, yaw });
});

// --- Game loop ---
renderLoop((delta) => {
  // 1. Smooth the camera look toward the mouse target.
  updateLook(delta);
  const yaw = getYaw();
  const pitch = getPitch();

  // 2. Build the desired velocity in world space:
  //    forward follows the full look direction (swim where you look),
  //    strafe stays horizontal, Space/Shift add vertical thrust.
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

  // 3. Water inertia: ease velocity toward the target (no instant stops).
  const k = 1 - Math.exp(-WATER_INERTIA * delta);
  velocity.x += (target.x - velocity.x) * k;
  velocity.y += (target.y - velocity.y) * k;
  velocity.z += (target.z - velocity.z) * k;

  localPosition.x += velocity.x * delta;
  localPosition.y = clamp(localPosition.y + velocity.y * delta, FLOOR_Y, SURFACE_Y);
  localPosition.z += velocity.z * delta;

  // 4. First-person camera.
  updateCamera(localPosition, yaw, pitch);

  // 5. Broadcast local state, throttled.
  networkTimer += delta;
  if (networkTimer >= NETWORK_RATE && isConnected()) {
    networkTimer = 0;
    broadcastState(localPosition.x, localPosition.y, localPosition.z, yaw);
  }

  // 6. Sample interpolation buffers for smooth remote movement.
  for (const [peerId, buffer] of remoteBuffers) {
    const s = buffer.sample();
    if (s) updatePlayerPosition(peerId, s.x, s.y, s.z, s.yaw);
  }
});

function showStatus(text) {
  statusPanel.classList.remove("hidden");
  statusText.textContent = text;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
