// network.js — PeerJS module: host/join, data channel, state + event messages.
import Peer from "peerjs";

let peer = null;
let connections = []; // active DataConnections (host may have several)

const callbacks = {
  onStateReceived: null, // (peerId, {x, y, z, yaw, pitch}) => void
  onEventReceived: null, // (peerId, data) => void  (tp, etc.)
  onPeerConnected: null, // (peerId) => void
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

// The raw Peer object (needed by the voice module for media calls).
export function getPeer() {
  return peer;
}

// ICE: STUN for direct connections + a free public TURN relay as fallback.
// TURN rescues the cases where direct WebRTC fails even on one machine:
// mDNS candidates blocked by firewalls/VPNs, NAT hairpin failures, etc.
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
// Both players MUST end up on the same signaling server — invite links pin
// the joiner to the host's mode (see getSignalingMode / joinGame).
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
        signalingMode = useLocal ? "local" : "cloud";
        console.log(`[net] signaling: ${signalingMode} server`);
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
  p.on("connection", (conn) => setupConnection(conn));
  return p.id;
}

// Client: connect to a host by ID. Resolves once the data channel is open.
// `mode` (from the invite link) pins us to the host's signaling server.
export async function joinGame(hostId, mode = null) {
  const p = await createPeer({ forceMode: mode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            "Connection timed out. Check the host window is still open; see the console (F12) for the ICE state — 'failed'/'disconnected' usually means a firewall or VPN is blocking WebRTC.",
          ),
        ),
      15000,
    );
    const conn = p.connect(hostId, { reliable: false });

    // Diagnostics: watch the actual WebRTC connection state.
    conn.on("iceStateChanged", (state) => {
      console.log("[net] ice state:", state);
    });

    conn.on("open", () => {
      clearTimeout(timer);
      setupConnection(conn, { alreadyOpen: true });
      resolve(conn.peer);
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // e.g. "peer-unavailable" (wrong/expired ID) surfaces on the peer itself.
    p.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function setupConnection(conn, { alreadyOpen = false } = {}) {
  const register = () => {
    connections.push(conn);
    callbacks.onPeerConnected?.(conn.peer);
  };

  if (alreadyOpen) register();
  else conn.on("open", register);

  conn.on("data", (data) => {
    if (data?.type === "state") {
      callbacks.onStateReceived?.(conn.peer, data);
    } else if (data?.type === "event") {
      callbacks.onEventReceived?.(conn.peer, data);
    }
  });

  conn.on("close", () => {
    connections = connections.filter((c) => c !== conn);
    callbacks.onPeerDisconnected?.(conn.peer);
  });
}

// Send the local player's position, facing, and flashlight state.
// yaw/pitch = where the player LOOKS (head + torch); swimYaw/swimPitch =
// the lazy body orientation, so remote peers can render the head turning
// independently of the body.
export function broadcastState(
  x,
  y,
  z,
  yaw = 0,
  pitch = 0,
  light = true,
  swimYaw = null,
  swimPitch = null,
) {
  const payload = {
    type: "state",
    x,
    y,
    z,
    yaw,
    pitch,
    light,
    sy: swimYaw ?? yaw,
    sp: swimPitch ?? pitch,
  };
  for (const conn of connections) {
    if (conn.open) conn.send(payload);
  }
}

// Send a one-off gameplay event (e.g. { kind: 'tp', x, z }).
export function sendEvent(data) {
  const payload = { type: "event", ...data };
  for (const conn of connections) {
    if (conn.open) conn.send(payload);
  }
}

export function isConnected() {
  return connections.some((c) => c.open);
}
