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
  setFixedStep,
  setDread,
  setDepthLevel,
  fireFlare,
  setSwimSpeed,
  spawnCreature,
  placeCreature,
  creaturePosition,
  flashBellAlarm,
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
  setLook,
  isSprinting,
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
  ALARM_PERIOD,
  DROP_DURATION,
} from "./bell.js";
import { getShot, captureErrors } from "./shots.js";
import { updateCurrent, currentForceAt, forceCurrent } from "./current.js";
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";
import {
  initSonar,
  playPing,
  playDescent,
  playCreak,
  setDroneDepth,
  setSwimPace,
  setBreathRate,
  createCreatureVoice,
  setSonarListener,
} from "./sonar.js";
import {
  initVoice,
  callPeer,
  onVoiceStatus,
  setListenerPose,
  setVoicePosition,
  toggleMute,
} from "./voice.js";

const MAX_SPEED = 4.5; // units per second
const SPRINT_MULT = 2; // hold Shift to bolt for the bell
const WATER_INERTIA = 4; // how quickly velocity reaches its target
const NETWORK_RATE = 1 / 30; // send state 30x per second
const CEILING_Y = 4; // you cannot swim back above the start line
const O2_SECONDS = 180; // three minutes of autonomy
const O2_REFILL_RANGE = 12; // close to the bell tops you back up
const O2_REFILL_RATE = 22; // seconds of air gained per second alongside

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
const minimapCanvas = document.getElementById("minimap");
const bellRadarCanvas = document.getElementById("bell-radar");
const oxygenFill = document.getElementById("oxygen-fill");
const oxygenText = document.getElementById("oxygen-text");

const localPosition = { x: 0, y: 2, z: 8 };
const velocity = { x: 0, y: 0, z: 0 };
let networkTimer = 0;
let flashlightOn = true;

// Everyone starts hooked onto the bell; the first drop follows straight away.
let attached = true;
let mySlot = slotOffset("solo");
let isHost = false;
let settleTimer = -1; // counts down between the bell's stop and the ejection
let alarmTimer = ALARM_PERIOD;
let creakTimer = 12;
let flareCooldown = 0; // the flare is the one thing that buys you a look
const currentNoise = new ImprovedNoise();
const drift = { x: 0, y: 0, z: 0 }; // push from whatever current has hold of you
let inCurrent = false;
let creatureVoice = null;
let oxygen = O2_SECONDS;

const remoteBuffers = new Map(); // peerId -> SnapshotBuffer
const remoteAttached = new Map(); // peerId -> bool

// --- Setup ---
const canvas = initGraphics(document.getElementById("scene-container"));
initInput();
initMouseLook(canvas);

// Screenshot mode (?shot=<name>): hold one vantage point and freeze the sim.
captureErrors();
const shot = getShot();
if (shot) {
  menu.classList.add("hidden");
  attached = false;
  snapToLevel(shot.level);
  localPosition.x = shot.x;
  localPosition.y = shot.y;
  localPosition.z = shot.z;
  setLook(shot.yaw, shot.pitch);
  if (!shot.torch) flashlightOn = toggleFlashlight();
  setFixedStep(true);
}
let shotFrame = 0;

// Browsers block audio until the page has been interacted with.
const startAudio = () => {
  initSonar();
  creatureVoice ??= createCreatureVoice();
};
window.addEventListener("pointerdown", startAudio, { once: true });
window.addEventListener("keydown", startAudio, { once: true });

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
  } else if (e.code === "KeyG") {
    throwFlare();
  } else if (e.code === "KeyE") {
    toggleAttach();
  } else if (e.code === "KeyR") {
    restart();
    sendEvent({ kind: "restart" });
  }
});

const FLARE_RELOAD = 5; // seconds

function throwFlare() {
  if (flareCooldown > 0) {
    showEvent(`Flare charging — ${flareCooldown.toFixed(1)}s`);
    return;
  }
  const yaw = getYaw();
  const pitch = getPitch();
  const cosP = Math.cos(pitch);
  fireFlare(localPosition, {
    x: -Math.sin(yaw) * cosP,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosP,
  });
  flareCooldown = FLARE_RELOAD;
  showEvent("✷ Flare away.");
}

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
    playDescent(DROP_DURATION);
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
  if (updateBell(delta)) {
    settleTimer = SETTLE_DELAY;
    spawnCreature(getBell().y); // one arrives with every landing
  }
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
  if (!shot && isHost && settleTimer < 0 && readyToDrop(delta, hooked, crew)) {
    const level = bell.level + 1;
    startDrop(level);
    playDescent(DROP_DURATION);
    sendEvent({ kind: "drop", level });
    showEvent(`▼ The bell drops to level ${level}…`);
  }

  if (shot) {
    // Held pose: no input, no drift, and the alarm fires on a fixed frame.
    shotFrame++;
    if (shot.flash && shotFrame === 20) flashBellAlarm();
    if (shot.flare && shotFrame === 6) throwFlare();
    // Frame 4: the camera is not moved to the shot pose until later in a frame.
    if (shot.creature && shotFrame === 4) {
      placeCreature(
        localPosition,
        Math.atan2(-Math.cos(shot.yaw), -Math.sin(shot.yaw)),
        70,
      );
    }
    if (shot.current && shotFrame === 4) {
      forceCurrent(
        localPosition,
        currentNoise,
        Math.atan2(-Math.cos(shot.yaw), -Math.sin(shot.yaw)),
      );
    }
    velocity.x = velocity.y = velocity.z = 0;
  } else if (attached) {
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

    const top = MAX_SPEED * (isSprinting() ? SPRINT_MULT : 1);
    const target = {
      x: (fwd.x * move.z + right.x * move.x) * top,
      y: (fwd.y * move.z + move.y) * top,
      z: (fwd.z * move.z + right.z * move.x) * top,
    };

    // 5. Water inertia.
    const k = 1 - Math.exp(-WATER_INERTIA * delta);
    velocity.x += (target.x - velocity.x) * k;
    velocity.y += (target.y - velocity.y) * k;
    velocity.z += (target.z - velocity.z) * k;

    // The current is added on top of your own swimming, never replacing it —
    // you can always fight it, you just lose ground doing so.
    currentForceAt(localPosition.x, localPosition.y, localPosition.z, drift);
    const wasIn = inCurrent;
    inCurrent = Math.hypot(drift.x, drift.y, drift.z) > 0.2;
    if (inCurrent && !wasIn) showEvent("≋ Caught in a current.");

    localPosition.x += (velocity.x + drift.x) * delta;
    localPosition.y += (velocity.y + drift.y) * delta;
    localPosition.z += (velocity.z + drift.z) * delta;
    localPosition.y = Math.min(localPosition.y, CEILING_Y);
  }

  // 6. First-person camera (speed drives the flashlight bob).
  const speed =
    Math.hypot(velocity.x, velocity.y, velocity.z) /
    (MAX_SPEED * (isSprinting() ? SPRINT_MULT : 1));
  updateCamera(localPosition, yaw, pitch, Math.min(speed, 1));
  setSwimSpeed(shot?.wake ? 1 : Math.min(speed, 1));
  setSwimPace(Math.min(speed, 1));

  // 7. The abyss gets heavier from the second ejection depth down, and blooms
  //    thicken the water wherever you happen to be swimming.
  const dread = clamp((bell.level - 1) / 2, 0, 1);
  setDread(dread);
  setDroneDepth(dread);
  setBreathRate(Math.max(dread, Math.min(speed, 1)));
  setDepthLevel(bell.level);

  // 8. The bell's alarm: red flash on the hull, and a ping panned toward it.
  const bellDist = distanceToBell(localPosition);

  // Oxygen: it only ever goes down out here, and the bell is the only refill.
  if (!shot) {
    if (bellDist <= O2_REFILL_RANGE) {
      oxygen = Math.min(O2_SECONDS, oxygen + O2_REFILL_RATE * delta);
    } else {
      oxygen = Math.max(0, oxygen - delta);
    }
  }
  alarmTimer -= shot ? 0 : delta;
  if (alarmTimer <= 0) {
    alarmTimer = ALARM_PERIOD;
    const span = Math.hypot(localPosition.x, localPosition.z) || 1;
    const pan =
      (-localPosition.x * Math.cos(yaw) + localPosition.z * Math.sin(yaw)) /
      span;
    flashBellAlarm();
    playPing(bellDist, pan);
  }

  // Something shifting out in the dark, on no schedule you can learn.
  if (!shot) updateCurrent(delta, localPosition, currentNoise);
  if (shot?.current) updateCurrent(0, localPosition, currentNoise);
  if (flareCooldown > 0) flareCooldown = Math.max(0, flareCooldown - delta);
  creakTimer -= shot ? 0 : delta;
  if (creakTimer <= 0) {
    creakTimer = 9 + Math.random() * 22;
    playCreak();
  }

  // 9. Spatial audio listener follows the camera.
  setListenerPose(localPosition, yaw, pitch);
  setSonarListener(localPosition, yaw, pitch);
  if (creatureVoice) {
    const c = creaturePosition();
    creatureVoice.setPosition(c.x, c.y, c.z);
  }

  // 10. Broadcast local state, throttled.
  networkTimer += shot ? 0 : delta;
  if (networkTimer >= NETWORK_RATE) {
    networkTimer = 0;
    broadcastNow();
  }

  // 11. Smooth remote players from interpolation buffers + move their voices.
  for (const [peerId, buffer] of remoteBuffers) {
    const s = buffer.sample();
    if (s) {
      updatePlayerPosition(peerId, s.x, s.y, s.z, s.yaw, s.pitch);
      setVoicePosition(peerId, s.x, s.y, s.z);
    }
  }

  // 12. HUD.
  drawCompass(yaw);
  drawMinimap(yaw);
  drawBellRadar(yaw, bellDist);

  const o2 = oxygen / O2_SECONDS;
  oxygenFill.style.width = `${(o2 * 100).toFixed(1)}%`;
  oxygenFill.style.background =
    o2 > 0.5 ? "#9fe8ff" : o2 > 0.2 ? "#ffcc7a" : "#ff6a5a";
  oxygenText.textContent = `O₂ ${Math.ceil(oxygen)}s`;
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
}

// Four quadrants around you. A teammate lights the one they are in — enough to
// point you, never enough to walk straight to them.
const minimapCtx = minimapCanvas.getContext("2d");

function drawMinimap(yaw) {
  const w = minimapCanvas.width;
  const h = minimapCanvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) / 2 - 2;
  const ctx = minimapCtx;

  // How strongly each quadrant is lit: front, right, back, left.
  const lit = [0, 0, 0, 0];
  for (const [peerId, buffer] of remoteBuffers) {
    const sample = buffer.last?.() ?? buffer.sample();
    if (!sample) continue;
    const dx = sample.x - localPosition.x;
    const dz = sample.z - localPosition.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) continue;
    // Rotate into view space so the map turns with you.
    const forward = -Math.atan2(dx, -dz) - yaw;
    const a = ((forward % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const q = Math.floor(((a + Math.PI / 4) % (Math.PI * 2)) / (Math.PI / 2));
    lit[q] = Math.max(lit[q], Math.max(0.15, 1 - dist / 160));
  }

  paintQuadrants(ctx, minimapCanvas, lit, "120, 220, 255");
}

// The same dial again, but for the bell. Deliberately a second instrument
// rather than a marker on the first: you have to read them both.
const bellRadarCtx = bellRadarCanvas.getContext("2d");

function drawBellRadar(yaw, dist) {
  const bell = getBell();
  const lit = [0, 0, 0, 0];
  const dx = 0 - localPosition.x;
  const dz = 0 - localPosition.z;
  if (Math.hypot(dx, dz) > 0.001) {
    const forward = -Math.atan2(dx, -dz) - yaw;
    const a = ((forward % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const q = Math.floor(((a + Math.PI / 4) % (Math.PI * 2)) / (Math.PI / 2));
    lit[q] = Math.max(0.2, 1 - dist / 260);
  }
  paintQuadrants(bellRadarCtx, bellRadarCanvas, lit, "255, 196, 120");
  // Vertical hint: the bell is often above or below, not just off to one side.
  const rise = bell.y + 1.6 - localPosition.y;
  if (Math.abs(rise) > 4) {
    const ctx = bellRadarCtx;
    ctx.fillStyle = "rgba(255, 210, 150, 0.85)";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText(rise > 0 ? "▲" : "▼", bellRadarCanvas.width / 2, 12);
  }
}

function paintQuadrants(ctx, canvas, lit, rgb) {
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) / 2 - 2;
  ctx.clearRect(0, 0, w, h);
  for (let q = 0; q < 4; q++) {
    const start = -Math.PI / 2 - Math.PI / 4 + (q * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, start, start + Math.PI / 2);
    ctx.closePath();
    ctx.fillStyle = `rgba(${rgb}, ${0.05 + lit[q] * 0.45})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(${rgb}, 0.22)`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(220, 245, 255, 0.9)";
  ctx.beginPath();
  ctx.moveTo(cx, cy - 5);
  ctx.lineTo(cx - 3.5, cy + 4);
  ctx.lineTo(cx + 3.5, cy + 4);
  ctx.closePath();
  ctx.fill();
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
