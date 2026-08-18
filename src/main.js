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
  getMovement,
  getYaw,
  getPitch,
} from "./input.js";

const MOVE_SPEED = 5; // units per second
const NETWORK_RATE = 1 / 20; // send state 20x per second

const LOCAL_ID = "local";
const LOCAL_COLOR = 0xffa64d; // orange
const REMOTE_COLOR = 0x66ff99; // green

// --- UI elements ---
const menu = document.getElementById("menu");
const hostBtn = document.getElementById("host-btn");
const joinBtn = document.getElementById("join-btn");
const statusPanel = document.getElementById("status");
const statusText = document.getElementById("status-text");
const peerIdText = document.getElementById("peer-id");

const localPosition = { x: 0, y: 0, z: 0 };
let networkTimer = 0;

// --- Setup ---
const canvas = initGraphics(document.getElementById("scene-container"));
initInput();
initMouseLook(canvas);
addPlayer(LOCAL_ID, LOCAL_COLOR);

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
  showStatus("Player connected! Swim with ZQSD, aim with mouse.");
  peerIdText.classList.add("hidden");
});

onPeerDisconnected((peerId) => {
  removePlayer(peerId);
  showStatus("Player disconnected.");
});

onStateReceived((peerId, { x, y, z }) => {
  updatePlayerPosition(peerId, x, y, z);
});

// --- Game loop ---
renderLoop((delta) => {
  // 1. Read local input and move the local player relative to camera yaw.
  const move = getMovement();
  const yaw = getYaw();
  const cos = Math.cos(yaw),
    sin = Math.sin(yaw);
  localPosition.x += (move.x * cos + move.z * sin) * MOVE_SPEED * delta;
  localPosition.z += (-move.x * sin + move.z * cos) * MOVE_SPEED * delta;

  // 2. Update local graphics and camera.
  updatePlayerPosition(
    LOCAL_ID,
    localPosition.x,
    localPosition.y,
    localPosition.z,
  );
  updateCamera(localPosition, yaw, getPitch());

  // 3. Broadcast state, throttled to NETWORK_RATE.
  networkTimer += delta;
  if (networkTimer >= NETWORK_RATE && isConnected()) {
    networkTimer = 0;
    broadcastState(localPosition.x, localPosition.y, localPosition.z);
  }
});

function showStatus(text) {
  statusPanel.classList.remove("hidden");
  statusText.textContent = text;
}
