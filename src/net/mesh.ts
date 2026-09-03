// network/mesh.ts — PeerJS full mesh: connection topology & lifecycle.
//
// This half of the network layer owns WHO we are connected to; its sibling
// sync.ts owns WHAT flows over those connections (packet codec, dispatch,
// broadcast). The split line: mesh code is asynchronous and stateful
// (signaling, dialing, ICE, keep-alive), state code is synchronous and hot
// (30 Hz). sync.ts plugs into the raw data firehose via setDataSinks().
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
// RESILIENCE — per-peer ping/pong over the events channel measures RTT
// (exposed via getRtt/getWorstRtt) and doubles as a keep-alive. Pongs also
// carry the responder's world-clock stamp (net/clock.ts): pongs from the
// HOST are the samples every other peer syncs its shared clock from.
import Peer, { type DataConnection } from "peerjs";
import { noteClockSample, resetWorldClock, worldNow } from "./clock.ts";

const STATE_CHANNEL_ID = 99; // negotiated id — clear of PeerJS's own channel
const PING_INTERVAL_MS = 2000;

// One entry per mesh link. `seqIn` belongs logically to sync.ts (packet
// dedup) but lives here so dropping a peer drops its sequence history too.
export interface PeerRecord {
  conn: DataConnection;
  state: RTCDataChannel | null;
  seqIn: number;
  initiator: boolean;
  rtt: number | null;
  pingTimer: ReturnType<typeof setInterval> | null;
}

// Reliable-channel JSON payloads ({ type: "event", kind, ... }).
export interface EventPayload {
  type: string;
  kind?: string;
  [key: string]: unknown;
}

let peer: Peer | null = null;
let myId: string | null = null;
let amHost = false;
let hostId: string | null = null; // the peer we joined (null on the host)

export const peers = new Map<string, PeerRecord>();

// --- Data sinks: sync.ts registers here at module init -----------------------
export interface DataSinks {
  // Binary = a state packet (raw channel, or reliable-channel fallback).
  onBinary(peerId: string, data: ArrayBuffer | ArrayBufferView): void;
  // Application-level reliable event (internal "__" events never reach this).
  onEvent(peerId: string, data: EventPayload): void;
  // Legacy JSON state from older clients — still accepted.
  onLegacyState(peerId: string, data: unknown): void;
}

let sinks: DataSinks = {
  onBinary: () => {},
  onEvent: () => {},
  onLegacyState: () => {},
};

export function setDataSinks(s: DataSinks): void {
  sinks = s;
}

// --- Lifecycle callbacks (main.js) -------------------------------------------
type PeerConnectedCb = (peerId: string, info: { initiator: boolean }) => void;
type PeerDisconnectedCb = (peerId: string) => void;

let peerConnectedCb: PeerConnectedCb | null = null;
let peerDisconnectedCb: PeerDisconnectedCb | null = null;

export function onPeerConnected(fn: PeerConnectedCb): void {
  peerConnectedCb = fn;
}
export function onPeerDisconnected(fn: PeerDisconnectedCb): void {
  peerDisconnectedCb = fn;
}

// --- Getters ------------------------------------------------------------------
export function getPeer(): Peer | null {
  return peer;
}
export function getMyId(): string | null {
  return myId;
}
export function getHostId(): string | null {
  return hostId;
}
export function getPeerIds(): string[] {
  return [...peers.keys()];
}
export function isConnected(): boolean {
  return [...peers.values()].some((r) => r.conn.open);
}
// RTT (ms) to one peer, or the worst across the mesh (for the HUD).
export function getRtt(peerId: string): number | null {
  return peers.get(peerId)?.rtt ?? null;
}
export function getWorstRtt(): number | null {
  let worst: number | null = null;
  for (const r of peers.values()) {
    if (r.rtt != null && (worst === null || r.rtt > worst)) worst = r.rtt;
  }
  return worst;
}

// ICE: STUN for direct connections + a free public TURN relay as fallback.
const ICE_CONFIG: RTCConfiguration = {
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

// In dev, use the local signaling server started by Vite (vite.config.ts),
// falling back to the public PeerJS cloud. In production: cloud directly.
export type SignalingMode = "local" | "cloud";
let signalingMode: SignalingMode | null = null; // set once connected

export function getSignalingMode(): SignalingMode | null {
  return signalingMode;
}

function newPeer(useLocal: boolean): Peer {
  const opts = {
    config: ICE_CONFIG,
    debug: import.meta.env.DEV ? 2 : 0,
  };
  // The local server is reached through the DEV SERVER'S OWN ORIGIN (Vite
  // proxies /abyssal to it, websocket upgrade included). 
  return useLocal
    ? new Peer({
        host: location.hostname,
        port: location.port
          ? Number(location.port)
          : location.protocol === "https:"
            ? 443
            : 80,
        path: "/abyssal",
        ...opts,
      })
    : new Peer(opts);
}

function createPeer({
  forceMode = null,
}: { forceMode?: SignalingMode | null } = {}): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const attempt = (useLocal: boolean, canFallback: boolean) => {
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
              `The local dev signaling server isn't reachable at ${location.host}. Open the invite link on the HOST's address (not localhost), and check \`npm run dev\` is still running there.`,
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
export async function hostGame(): Promise<string> {
  const p = await createPeer();
  amHost = true;
  resetWorldClock(); // our clock is now the authority — offset back to 0
  return p.id;
}

// Client: connect to a host by ID. Resolves once the data channel is open.
// The host then introduces us to every other peer ("__peers") and we dial
// them all — full mesh.
export async function joinGame(
  hostPeerId: string,
  mode: SignalingMode | null = null,
): Promise<string> {
  await createPeer({ forceMode: mode });
  hostId = hostPeerId.trim();
  await dial(hostId, 15000);
  return hostId;
}

// Dial one peer (we are the initiator). Resolves when the channel opens.
function dial(remoteId: string, timeoutMs = 12000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (peers.has(remoteId) || remoteId === myId || !peer)
      return resolve(remoteId);
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
    const onPeerError = (err: Error) => {
      clearTimeout(timer);
      peer?.off("error", onPeerError);
      reject(err);
    };
    peer.on("error", onPeerError);
    conn.on("iceStateChanged", (state) => {
      console.log(`[net] ice state (${remoteId.slice(0, 6)}):`, state);
    });
    conn.on("open", () => {
      clearTimeout(timer);
      peer?.off("error", onPeerError);
      setupConnection(conn, true, { alreadyOpen: true });
      resolve(remoteId);
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      peer?.off("error", onPeerError);
      reject(err);
    });
  });
}

function setupConnection(
  conn: DataConnection,
  initiator: boolean,
  { alreadyOpen = false } = {},
): void {
  const register = () => {
    if (peers.has(conn.peer)) {
      // Duplicate (shouldn't happen — only newcomers dial): keep the old one.
      console.warn("[net] duplicate connection from", conn.peer);
      conn.close();
      return;
    }
    const rec: PeerRecord = {
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
    peerConnectedCb?.(conn.peer, { initiator });
  };

  if (alreadyOpen) register();
  else conn.on("open", register);

  conn.on("data", (data) => {
    // Binary on the reliable channel = state packet fallback (raw channel
    // not open yet on the sender's side).
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      sinks.onBinary(conn.peer, data);
      return;
    }
    const msg = data as EventPayload | null;
    if (msg?.type === "event") {
      if (typeof msg.kind === "string" && msg.kind.startsWith("__")) {
        handleInternalEvent(conn.peer, msg);
      } else {
        sinks.onEvent(conn.peer, msg);
      }
    } else if (msg?.type === "state") {
      // Legacy JSON state (older clients) — still accepted.
      sinks.onLegacyState(conn.peer, msg);
    }
  });

  conn.on("close", () => dropPeer(conn.peer));
  conn.on("error", () => dropPeer(conn.peer));
}

function dropPeer(peerId: string): void {
  const rec = peers.get(peerId);
  if (!rec) return;
  if (rec.pingTimer !== null) clearInterval(rec.pingTimer);
  try {
    rec.state?.close();
  } catch {
    /* best effort */
  }
  // Close the DataConnection too (idempotent if we got here from its own
  // close/error event) — this releases the underlying RTCPeerConnection
  // instead of leaving a half-dead pair holding sockets and ICE candidates.
  try {
    rec.conn.close();
  } catch {
    /* best effort */
  }
  peers.delete(peerId);
  peerDisconnectedCb?.(peerId);
}

// --- Mesh bookkeeping (internal "__" events on the reliable channel) ---

function handleInternalEvent(peerId: string, data: EventPayload): void {
  if (data.kind === "__peers" && peerId === hostId) {
    // The host's introduction list: dial everyone we don't know yet.
    const ids = Array.isArray(data.ids) ? (data.ids as string[]) : [];
    for (const id of ids) {
      if (id === myId || peers.has(id)) continue;
      dial(id).catch((err) =>
        console.warn(`[net] mesh dial to ${id.slice(0, 6)} failed:`, err),
      );
    }
  } else if (data.kind === "__ping") {
    const rec = peers.get(peerId);
    if (rec) {
      rawSend(rec, { type: "event", kind: "__pong", t: data.t, w: worldNow() });
    }
  } else if (data.kind === "__pong") {
    const rec = peers.get(peerId);
    if (rec && typeof data.t === "number") {
      const rtt = performance.now() - data.t;
      rec.rtt = Math.round(rtt);
      // Clock samples are trusted from the clock source alone (the host).
      if (peerId === hostId && typeof data.w === "number") {
        noteClockSample(data.w, rtt);
      }
    }
  }
}

function startPing(rec: PeerRecord): void {
  const ping = () => {
    if (rec.conn.open) {
      rawSend(rec, { type: "event", kind: "__ping", t: performance.now() });
    }
  };
  // First ping immediately: a joiner's world clock locks on the first pong,
  // well before its world build finishes — no visible rotation snap later.
  ping();
  rec.pingTimer = setInterval(ping, PING_INTERVAL_MS);
}

// --- Raw unreliable state channel -----------------------------------------

// Both sides create the channel with the same negotiated id — symmetric, no
// in-band signaling, and PeerJS's own ondatachannel never sees it.
function attachStateChannel(rec: PeerRecord): void {
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
      console.log(
        `[net] unreliable state channel up (${rec.conn.peer.slice(0, 6)})`,
      );
    };
    ch.onclose = () => {
      if (rec.state === ch) rec.state = null; // fall back to reliable
    };
    ch.onerror = () => {
      if (rec.state === ch) rec.state = null;
    };
    ch.onmessage = (e) => sinks.onBinary(rec.conn.peer, e.data);
  } catch (err) {
    console.warn("[net] raw state channel unavailable, using fallback:", err);
  }
}

// Reliable-channel send, used by both halves of the layer.
export function rawSend(
  rec: PeerRecord,
  payload: EventPayload | ArrayBuffer | ArrayBufferView,
): void {
  if (rec.conn.open) rec.conn.send(payload);
}
