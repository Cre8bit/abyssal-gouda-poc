// voice.js — proximity voice chat over PeerJS media calls + Web Audio.
//
// Each remote voice is routed through an HRTF PannerNode positioned at the
// remote diver's world position, with the listener at the local camera.
// Result: your teammate gets louder (and directional) as you get closer.

let audioCtx = null;
let localStream = null;
let muted = false;
let statusCb = null;

const remoteVoices = new Map(); // peerId -> { panner, el }

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

// Start a voice call to a remote peer (the joiner initiates).
export async function callPeer(peer, remoteId) {
  try {
    report("connecting");
    const call = peer.call(remoteId, await ensureMic());
    attachCall(call);
  } catch {
    report("mic-denied");
  }
}

function attachCall(call) {
  call.on("stream", (stream) => {
    setupSpatialAudio(call.peer, stream);
    report("on");
  });
  call.on("close", () => teardown(call.peer));
  call.on("error", () => report("error"));
}

function setupSpatialAudio(peerId, stream) {
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
  // Half again as far as it used to carry: close enough to still mean "swim to
  // me", far enough that two divers working the same shell can actually talk.
  panner.refDistance = 3; // full volume within ~3 units
  panner.maxDistance = 120;
  panner.rolloffFactor = 1.13; // 1.7 / 1.5 — the fall-off itself is gentler too

  source.connect(panner);
  panner.connect(audioCtx.destination);

  remoteVoices.set(peerId, { panner, el });
}

function teardown(peerId) {
  const voice = remoteVoices.get(peerId);
  if (!voice) return;
  voice.panner.disconnect();
  voice.el.srcObject = null;
  remoteVoices.delete(peerId);
  report("off");
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
