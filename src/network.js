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

// In dev, use the local signaling server started by Vite (vite.config.js).
// If it isn't running, fall back to the public PeerJS cloud automatically.
// In production (GitHub Pages) the public cloud is used directly.
function newPeer(useLocal) {
  return useLocal
    ? new Peer({ host: location.hostname, port: 9001, path: "/abyssal" })
    : new Peer();
}

function createPeer() {
  return new Promise((resolve, reject) => {
    const attempt = (useLocal, canFallback) => {
      const p = newPeer(useLocal);
      let opened = false;
      p.on("open", () => {
        opened = true;
        peer = p;
        resolve(p);
      });
      p.on("error", (err) => {
        if (opened) return; // post-open errors are handled per-connection
        p.destroy();
        if (canFallback) {
          console.warn("Local PeerJS server unreachable, using public cloud…");
          attempt(false, false);
        } else {
          reject(err);
        }
      });
    };
    attempt(import.meta.env.DEV, import.meta.env.DEV);
  });
}

// Host: wait for connections. Resolves with the ID to share.
export async function hostGame() {
  const p = await createPeer();
  p.on("connection", (conn) => setupConnection(conn));
  return p.id;
}

// Client: connect to a host by ID. Resolves once the data channel is open.
export async function joinGame(hostId) {
  const p = await createPeer();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Connection timed out — is the host still open?")),
      12000,
    );
    const conn = p.connect(hostId, { reliable: false });
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
export function broadcastState(x, y, z, yaw = 0, pitch = 0, light = true) {
  const payload = { type: "state", x, y, z, yaw, pitch, light };
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
