// network.js — PeerJS full mesh: N peers, dual channels per pair.
//
// TOPOLOGY — full mesh. The host is only special as the *introducer*: when a
// newcomer connects, the host sends it the list of already-connected peers
// ("__peers") and the newcomer dials each of them (data + the caller layers
// voice on top via onPeerConnected's `initiator` flag). Only the newcomer
// ever dials, so two peers never dial each other simultaneously.
//
// CHANNELS — two per pair, sharing ONE RTCPeerConnection:
//  - events: the PeerJS DataConnection (reliable + ordered). World mutations
//    (dig, tp, seed, items…) MUST all arrive, in order: SCTP retransmits.
//  - state: a raw negotiated RTCDataChannel (unordered, maxRetransmits: 0).
//    30 Hz pose packets are disposable — a lost one is *replaced* 33 ms
//    later, so retransmitting it would only add latency (no head-of-line
//    blocking, no retransmit bursts after a loss). Both sides create it with
//    the same negotiated id, which keeps it invisible to PeerJS's internal
//    ondatachannel handling. Until it opens (or if it ever closes), state
//    silently falls back to the reliable channel.
//
// STATE PACKETS — 24-byte binary (see encodeState). Each carries a u16
// sequence number: stale/reordered packets are dropped on arrival, so an
// unordered channel can never make a player jump backwards.
//
// RESILIENCE — per-peer ping/pong over the events channel measures RTT
// (exposed via getRtt/getWorstRtt) and doubles as a keep-alive.
import Peer from "peerjs";
import {
  encodeState,
  decodeState,
  seqNewer,
  STATE_PACKET_BYTES,
} from "./protocol.js";

const STATE_CHANNEL_ID = 99; // negotiated id — clear of PeerJS's own channel
const PING_INTERVAL_MS = 2000;

let peer = null;
let myId = null;
let amHost = false;
let hostId = null; // the peer we joined (null on the host)

// peerId -> { conn, state: RTCDataChannel|null, seqIn, initiator, rtt, pingTimer }
const peers = new Map();

let seqOut = 0; // shared u16 counter for outgoing state packets

const callbacks = {
  onStateReceived: null, // (peerId, {x,y,z,yaw,pitch,sy,sp,light,status}) => void
  onEventReceived: null, // (peerId, data) => void
  onPeerConnected: null, // (peerId, {initiator}) => void
  onPeerDisconnected: null, // (peerId) => void
};

export function onStateReceived(fn) {
  callbacks.onStateReceived = fn;
}
export function onEventReceived(fn) {
  callbacks.onEventReceived = fn;
}
export function onPeerConnected(fn) {
  callbacks.onPeerConnected = fn;
}
export function onPeerDisconnected(fn) {
  callbacks.onPeerDisconnected = fn;
}

export function getPeer() {
  return peer;
}
export function getMyId() {
  return myId;
}
export function getHostId() {
  return hostId;
}
export function getPeerIds() {
  return [...peers.keys()];
}
export function isConnected() {
  return [...peers.values()].some((r) => r.conn.open);
}
// RTT (ms) to one peer, or the worst across the mesh (for the HUD).
export function getRtt(peerId) {
  return peers.get(peerId)?.rtt ?? null;
}
export function getWorstRtt() {
  let worst = null;
  for (const r of peers.values()) {
    if (r.rtt != null && (worst === null || r.rtt > worst)) worst = r.rtt;
  }
  return worst;
}

// ICE: STUN for direct connections + a free public TURN relay as fallback.
const ICE_CONFIG = {
  iceServers: [
    {
      urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
    },
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

// In dev, use the local signaling server started by Vite (vite.config.js),
// falling back to the public PeerJS cloud. In production: cloud directly.
let signalingMode = null; // 'local' | 'cloud' once connected

export function getSignalingMode() {
  return signalingMode;
}

function newPeer(useLocal) {
  const opts = {
    config: ICE_CONFIG,
    debug: import.meta.env.DEV ? 2 : 0,
  };
  return useLocal
    ? new Peer({
        host: location.hostname,
        port: 9004,
        path: "/abyssal",
        ...opts,
      })
    : new Peer(opts);
}

function createPeer({ forceMode = null } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (useLocal, canFallback) => {
      const p = newPeer(useLocal);
      let opened = false;
      p.on("open", () => {
        opened = true;
        peer = p;
        myId = p.id;
        signalingMode = useLocal ? "local" : "cloud";
        console.log(`[net] signaling: ${signalingMode} server`);
        // EVERY peer accepts incoming connections — that's what makes the
        // mesh possible (late joiners dial the existing peers directly).
        p.on("connection", (conn) => setupConnection(conn, false));
        resolve(p);
      });
      p.on("error", (err) => {
        if (opened) return; // post-open errors are handled per-connection
        p.destroy();
        if (canFallback) {
          console.warn("[net] local PeerJS server unreachable, using cloud…");
          attempt(false, false);
        } else if (forceMode === "local") {
          reject(
            new Error(
              "The host is on the local dev signaling server, which isn't reachable from here. Is `npm run dev` still running?",
            ),
          );
        } else {
          reject(err);
        }
      });
    };

    const wantLocal = forceMode ? forceMode === "local" : !!import.meta.env.DEV;
    const canFallback = !forceMode && !!import.meta.env.DEV;
    attempt(wantLocal, canFallback);
  });
}

// Host: wait for connections. Resolves with the ID to share.
export async function hostGame() {
  const p = await createPeer();
  amHost = true;
  return p.id;
}

// Client: connect to a host by ID. Resolves once the data channel is open.
// The host then introduces us to every other peer ("__peers") and we dial
// them all — full mesh.
export async function joinGame(hostPeerId, mode = null) {
  await createPeer({ forceMode: mode });
  hostId = hostPeerId.trim();
  await dial(hostId, 15000);
  return hostId;
}

// Dial one peer (we are the initiator). Resolves when the channel opens.
function dial(remoteId, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    if (peers.has(remoteId) || remoteId === myId) return resolve(remoteId);
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            "Connection timed out. Check the host window is still open; see the console (F12) for the ICE state — 'failed'/'disconnected' usually means a firewall or VPN is blocking WebRTC.",
          ),
        ),
      timeoutMs,
    );
    const conn = peer.connect(remoteId, { reliable: true });
    // e.g. "peer-unavailable" (wrong/expired ID) surfaces on the peer itself.
    const onPeerError = (err) => {
      clearTimeout(timer);
      peer.off?.("error", onPeerError);
      reject(err);
    };
    peer.on("error", onPeerError);
    conn.on("iceStateChanged", (state) => {
      console.log(`[net] ice state (${remoteId.slice(0, 6)}):`, state);
    });
    conn.on("open", () => {
      clearTimeout(timer);
      peer.off?.("error", onPeerError);
      setupConnection(conn, true, { alreadyOpen: true });
      resolve(remoteId);
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      peer.off?.("error", onPeerError);
      reject(err);
    });
  });
}

function setupConnection(conn, initiator, { alreadyOpen = false } = {}) {
  const register = () => {
    if (peers.has(conn.peer)) {
      // Duplicate (shouldn't happen — only newcomers dial): keep the old one.
      console.warn("[net] duplicate connection from", conn.peer);
      conn.close();
      return;
    }
    const rec = {
      conn,
      state: null,
      seqIn: -1,
      initiator,
      rtt: null,
      pingTimer: null,
    };
    peers.set(conn.peer, rec);
    attachStateChannel(rec);
    startPing(rec);

    // The host introduces the newcomer to everyone already here.
    if (amHost) {
      const others = getPeerIds().filter((id) => id !== conn.peer);
      if (others.length) {
        rawSend(rec, { type: "event", kind: "__peers", ids: others });
      }
    }
    callbacks.onPeerConnected?.(conn.peer, { initiator });
  };

  if (alreadyOpen) register();
  else conn.on("open", register);

  conn.on("data", (data) => {
    // Binary on the reliable channel = state packet fallback (raw channel
    // not open yet on the sender's side).
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      handleStatePacket(conn.peer, data);
      return;
    }
    if (data?.type === "event") {
      if (typeof data.kind === "string" && data.kind.startsWith("__")) {
        handleInternalEvent(conn.peer, data);
      } else {
        callbacks.onEventReceived?.(conn.peer, data);
      }
    } else if (data?.type === "state") {
      // Legacy JSON state (older clients) — still accepted.
      callbacks.onStateReceived?.(conn.peer, data);
    }
  });

  conn.on("close", () => dropPeer(conn.peer));
  conn.on("error", () => dropPeer(conn.peer));
}

function dropPeer(peerId) {
  const rec = peers.get(peerId);
  if (!rec) return;
  clearInterval(rec.pingTimer);
  try {
    rec.state?.close();
  } catch {}
  // Close the DataConnection too (idempotent if we got here from its own
  // close/error event) — this releases the underlying RTCPeerConnection
  // instead of leaving a half-dead pair holding sockets and ICE candidates.
  try {
    rec.conn.close();
  } catch {}
  peers.delete(peerId);
  callbacks.onPeerDisconnected?.(peerId);
}

// --- Mesh bookkeeping (internal "__" events on the reliable channel) ---

function handleInternalEvent(peerId, data) {
  if (data.kind === "__peers" && peerId === hostId) {
    // The host's introduction list: dial everyone we don't know yet.
    for (const id of data.ids ?? []) {
      if (id === myId || peers.has(id)) continue;
      dial(id).catch((err) =>
        console.warn(`[net] mesh dial to ${id.slice(0, 6)} failed:`, err),
      );
    }
  } else if (data.kind === "__ping") {
    sendEventTo(peerId, { kind: "__pong", t: data.t });
  } else if (data.kind === "__pong") {
    const rec = peers.get(peerId);
    if (rec) rec.rtt = Math.round(performance.now() - data.t);
  }
}

function startPing(rec) {
  rec.pingTimer = setInterval(() => {
    if (rec.conn.open) {
      rawSend(rec, { type: "event", kind: "__ping", t: performance.now() });
    }
  }, PING_INTERVAL_MS);
}

// --- Raw unreliable state channel -----------------------------------------

// Both sides create the channel with the same negotiated id — symmetric, no
// in-band signaling, and PeerJS's own ondatachannel never sees it.
function attachStateChannel(rec) {
  const pc = rec.conn.peerConnection;
  if (!pc || typeof pc.createDataChannel !== "function") return;
  try {
    const ch = pc.createDataChannel("state", {
      negotiated: true,
      id: STATE_CHANNEL_ID,
      ordered: false,
      maxRetransmits: 0,
    });
    ch.binaryType = "arraybuffer";
    ch.onopen = () => {
      rec.state = ch;
      console.log(`[net] unreliable state channel up (${rec.conn.peer.slice(0, 6)})`);
    };
    ch.onclose = () => {
      if (rec.state === ch) rec.state = null; // fall back to reliable
    };
    ch.onerror = () => {
      if (rec.state === ch) rec.state = null;
    };
    ch.onmessage = (e) => handleStatePacket(rec.conn.peer, e.data);
  } catch (err) {
    console.warn("[net] raw state channel unavailable, using fallback:", err);
  }
}

// --- State packet intake (codec lives in protocol.js) -----------------------

let badPacketWarned = false;
function handleStatePacket(peerId, data) {
  const rec = peers.get(peerId);
  if (!rec) return;
  const s = decodeState(data);
  if (!s) {
    // Otherwise a protocol-version mismatch is a SILENT desync: every state
    // packet dropped, remote divers frozen, no error anywhere.
    if (!badPacketWarned) {
      badPacketWarned = true;
      console.warn(
        `[net] dropping undecodable state packets from ${peerId.slice(0, 6)} — protocol version mismatch? Both players should reload to the latest build.`,
      );
    }
    return;
  }
  if (rec.seqIn >= 0 && !seqNewer(s.seq, rec.seqIn)) return; // stale — drop
  rec.seqIn = s.seq;
  callbacks.onStateReceived?.(peerId, s);
}

// --- Sending ----------------------------------------------------------------

function rawSend(rec, payload) {
  if (rec.conn.open) rec.conn.send(payload);
}

// Broadcast the local pose + flags to every peer, over the unreliable
// channel when up (reliable fallback otherwise). ~24 bytes × peers × 30 Hz.
// One scratch buffer, reused every tick: channel .send() copies the bytes
// synchronously, so nothing downstream holds a reference to it.
const stateScratch = new ArrayBuffer(STATE_PACKET_BYTES);
export function broadcastState(s) {
  if (peers.size === 0) return;
  seqOut = (seqOut + 1) & 0xffff;
  const packet = encodeState(s, seqOut, stateScratch);
  for (const rec of peers.values()) {
    if (rec.state?.readyState === "open") {
      try {
        rec.state.send(packet);
      } catch {
        rawSend(rec, packet); // buffer hiccup — fall back this once
      }
    } else {
      rawSend(rec, packet);
    }
  }
}

// Reliable gameplay event to every peer (e.g. { kind: 'dig', x, y, z }).
export function sendEvent(data) {
  const payload = { type: "event", ...data };
  for (const rec of peers.values()) rawSend(rec, payload);
}

// Reliable gameplay event to ONE peer (e.g. per-player scatter targets).
export function sendEventTo(peerId, data) {
  const rec = peers.get(peerId);
  if (rec) rawSend(rec, { type: "event", ...data });
}
