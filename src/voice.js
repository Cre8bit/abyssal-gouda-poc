// voice.js — proximity voice chat over PeerJS media calls + Web Audio.
//
// Each remote voice is routed through an HRTF PannerNode positioned at the
// remote diver's world position, with the listener at the local camera.
// Result: your teammate gets louder (and directional) as you get closer.

let audioCtx = null;
let localStream = null;
let muted = false;
let statusCb = null;

const remoteVoices = new Map(); // peerId -> { source, panner, el, call }
const pendingCalls = new Set(); // peerIds we are currently dialing

export function onVoiceStatus(fn) {
  statusCb = fn;
}

function report(state) {
  statusCb?.(state);
}

async function ensureMic() {
  if (!localStream) {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  }
  return localStream;
}

// Answer incoming voice calls (both host and client should install this).
export function initVoice(peer) {
  peer.on("call", async (call) => {
    try {
      call.answer(await ensureMic());
      attachCall(call);
    } catch {
      call.answer(); // still receive their audio even if our mic is denied
      attachCall(call);
      report("mic-denied");
    }
  });
}

// Start a voice call to a remote peer. In the mesh, only the NEWCOMER
// initiates (network.js's `initiator` flag) — so two peers never call each
// other simultaneously. Guarded against duplicates anyway.
export async function callPeer(peer, remoteId) {
  if (remoteVoices.has(remoteId) || pendingCalls.has(remoteId)) return;
  pendingCalls.add(remoteId);
  try {
    report("connecting");
    const call = peer.call(remoteId, await ensureMic());
    attachCall(call);
  } catch {
    pendingCalls.delete(remoteId);
    report("mic-denied");
  }
}

function attachCall(call) {
  call.on("stream", (stream) => {
    pendingCalls.delete(call.peer);
    setupSpatialAudio(call.peer, stream, call);
    report("on");
  });
  call.on("close", () => teardown(call.peer));
  call.on("error", () => {
    pendingCalls.delete(call.peer);
    report("error");
  });
}

// Drop one peer's voice (mesh disconnect).
export function hangUp(peerId) {
  pendingCalls.delete(peerId);
  const voice = remoteVoices.get(peerId);
  if (voice?.call) {
    try {
      voice.call.close();
    } catch {}
  }
  teardown(peerId);
}

function setupSpatialAudio(peerId, stream, call = null) {
  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume();

  // Chrome quirk: WebRTC audio only flows into Web Audio if the stream is
  // also attached to a media element. Keep it muted — Web Audio does output.
  const el = new Audio();
  el.srcObject = stream;
  el.muted = true;
  el.play().catch(() => {});

  const source = audioCtx.createMediaStreamSource(stream);
  const panner = audioCtx.createPanner();
  panner.panningModel = "HRTF";
  panner.distanceModel = "inverse";
  panner.refDistance = 2; // full volume within ~2 units
  panner.maxDistance = 80;
  panner.rolloffFactor = 1.7; // fades fast — you must get CLOSE

  source.connect(panner);
  panner.connect(audioCtx.destination);

  remoteVoices.set(peerId, { source, panner, el, call });
}

function teardown(peerId) {
  const voice = remoteVoices.get(peerId);
  if (!voice) return;
  // Unwind the whole per-peer audio chain: a still-connected source keeps
  // the panner (and the remote MediaStream) alive across joins/leaves.
  voice.source.disconnect();
  voice.panner.disconnect();
  voice.el.pause();
  voice.el.srcObject = null;
  remoteVoices.delete(peerId);
  // Only report silence when the LAST voice is gone (mesh: several peers).
  if (remoteVoices.size === 0) report("off");
}

// --- Per-frame spatial updates ---

export function setListenerPose(pos, yaw, pitch) {
  if (!audioCtx) return;
  const l = audioCtx.listener;
  const cosP = Math.cos(pitch);
  const fwd = {
    x: -Math.sin(yaw) * cosP,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosP,
  };

  if (l.positionX) {
    // Modern API
    l.positionX.value = pos.x;
    l.positionY.value = pos.y;
    l.positionZ.value = pos.z;
    l.forwardX.value = fwd.x;
    l.forwardY.value = fwd.y;
    l.forwardZ.value = fwd.z;
    l.upX.value = 0;
    l.upY.value = 1;
    l.upZ.value = 0;
  } else {
    l.setPosition(pos.x, pos.y, pos.z);
    l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
  }
}

export function setVoicePosition(peerId, x, y, z) {
  const voice = remoteVoices.get(peerId);
  if (!voice) return;
  const p = voice.panner;
  if (p.positionX) {
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
  } else {
    p.setPosition(x, y, z);
  }
}

// Returns the new muted state.
export function toggleMute() {
  muted = !muted;
  localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  report(muted ? "muted" : "on");
  return muted;
}
