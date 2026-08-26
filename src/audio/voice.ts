// voice.js — proximity voice chat over PeerJS media calls + Web Audio.
//
// Each remote voice is routed through an HRTF PannerNode positioned at the
// remote diver's world position, with the listener at the local camera.
// Result: your teammate gets louder (and directional) as you get closer.

import type { Peer, MediaConnection } from "peerjs";

export type VoiceStatus =
  "connecting" | "on" | "muted" | "off" | "error" | "mic-denied";

interface RemoteVoice {
  source: MediaStreamAudioSourceNode;
  panner: PannerNode;
  el: HTMLAudioElement;
  call: MediaConnection | null;
}

let audioCtx: AudioContext | null = null;
let localStream: MediaStream | null = null;
let muted = false;
let statusCb: ((state: VoiceStatus) => void) | null = null;

const remoteVoices = new Map<string, RemoteVoice>(); // peerId -> { source, panner, el, call }
const pendingCalls = new Set<string>(); // peerIds we are currently dialing

// PeerJS gives us no way to cancel a call that is mid-negotiation, and the
// mic prompt is an await we cannot take back — so a peer that drops while we
// are dialing still gets a "stream" event afterwards. Wiring that up would
// build a panner and an <audio> element for someone who has already left,
// with nothing left to tear them down. Instead every peer carries a dial
// generation: hangUp() bumps it, and each async continuation checks the
// generation it started under before touching any state. Only hangUp() ever
// bumps; entries are never removed (that would un-stale work still in
// flight), which is fine — it is one integer per peer id seen this session.
const callGen = new Map<string, number>();

function genOf(peerId: string): number {
  return callGen.get(peerId) ?? 0;
}

// True if the peer was hung up (or re-dialed) since `gen` was captured.
function isStale(peerId: string, gen: number): boolean {
  return genOf(peerId) !== gen;
}

export function onVoiceStatus(fn: (state: VoiceStatus) => void) {
  statusCb = fn;
}

function report(state: VoiceStatus) {
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
export function initVoice(peer: Peer) {
  peer.on("call", async (call) => {
    const gen = genOf(call.peer);
    try {
      call.answer(await ensureMic());
    } catch {
      call.answer(); // still receive their audio even if our mic is denied
      report("mic-denied");
    }
    // The mic prompt can outlive the caller.
    if (isStale(call.peer, gen)) {
      try {
        call.close();
      } catch {}
      return;
    }
    attachCall(call, gen);
  });
}

// Start a voice call to a remote peer. In the mesh, only the NEWCOMER
// initiates (network.js's `initiator` flag) — so two peers never call each
// other simultaneously. Guarded against duplicates anyway.
export async function callPeer(peer: Peer, remoteId: string) {
  if (remoteVoices.has(remoteId) || pendingCalls.has(remoteId)) return;
  pendingCalls.add(remoteId);
  const gen = genOf(remoteId);
  try {
    report("connecting");
    const mic = await ensureMic();
    // Hung up while the mic prompt was open — never place the call. Leave
    // pendingCalls alone: hangUp() already cleared our entry, and anything
    // there now belongs to a newer dial for the same id.
    if (isStale(remoteId, gen)) return;
    attachCall(peer.call(remoteId, mic), gen);
  } catch {
    if (!isStale(remoteId, gen)) {
      pendingCalls.delete(remoteId);
      report("mic-denied");
    }
  }
}

function attachCall(call: MediaConnection, gen: number) {
  call.on("stream", (stream) => {
    // The peer left while this call was negotiating: drop it rather than
    // wire up a voice chain that teardown() will never see.
    if (isStale(call.peer, gen)) {
      try {
        call.close();
      } catch {}
      return;
    }
    pendingCalls.delete(call.peer);
    setupSpatialAudio(call.peer, stream, call);
    report("on");
  });
  call.on("close", () => {
    if (!isStale(call.peer, gen)) teardown(call.peer);
  });
  call.on("error", () => {
    // A call we already hung up erroring out is expected, not a voice fault.
    if (isStale(call.peer, gen)) return;
    pendingCalls.delete(call.peer);
    report("error");
  });
}

// Drop one peer's voice (mesh disconnect).
export function hangUp(peerId: string) {
  callGen.set(peerId, genOf(peerId) + 1); // invalidate in-flight dials/streams
  pendingCalls.delete(peerId);
  const voice = remoteVoices.get(peerId);
  if (voice?.call) {
    try {
      voice.call.close();
    } catch {}
  }
  teardown(peerId);
}

function setupSpatialAudio(
  peerId: string,
  stream: MediaStream,
  call: MediaConnection | null = null,
) {
  audioCtx ??= new (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext
  )();
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

function teardown(peerId: string) {
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

export function setListenerPose(
  pos: { x: number; y: number; z: number },
  yaw: number,
  pitch: number,
) {
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

export function setVoicePosition(
  peerId: string,
  x: number,
  y: number,
  z: number,
) {
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
