// network.js — PeerJS module: host/join, data channel, state broadcast.
import Peer from 'peerjs';

let peer = null;
let connections = []; // active DataConnections (host may have several)

const callbacks = {
  onStateReceived: null, // (peerId, {x, y, z}) => void
  onPeerConnected: null, // (peerId) => void
  onPeerDisconnected: null, // (peerId) => void
};

export function onStateReceived(fn) {
  callbacks.onStateReceived = fn;
}

export function onPeerConnected(fn) {
  callbacks.onPeerConnected = fn;
}

export function onPeerDisconnected(fn) {
  callbacks.onPeerDisconnected = fn;
}

// Host: create a Peer on the public PeerJS cloud and wait for connections.
// Resolves with the generated peer ID to share with the other player.
export function hostGame() {
  return new Promise((resolve, reject) => {
    peer = new Peer(); // default public PeerJS signaling server

    peer.on('open', (id) => resolve(id));
    peer.on('error', (err) => reject(err));
    peer.on('connection', (conn) => setupConnection(conn));
  });
}

// Client: connect to a host by ID. Resolves once the data channel is open.
export function joinGame(hostId) {
  return new Promise((resolve, reject) => {
    peer = new Peer();

    peer.on('error', (err) => reject(err));
    peer.on('open', () => {
      const conn = peer.connect(hostId, { reliable: false });
      conn.on('open', () => {
        setupConnection(conn, { alreadyOpen: true });
        resolve(conn.peer);
      });
      conn.on('error', (err) => reject(err));
    });
  });
}

function setupConnection(conn, { alreadyOpen = false } = {}) {
  const register = () => {
    connections.push(conn);
    callbacks.onPeerConnected?.(conn.peer);
  };

  if (alreadyOpen) register();
  else conn.on('open', register);

  conn.on('data', (data) => {
    if (data?.type === 'state') {
      callbacks.onStateReceived?.(conn.peer, data);
    }
  });

  conn.on('close', () => {
    connections = connections.filter((c) => c !== conn);
    callbacks.onPeerDisconnected?.(conn.peer);
  });
}

// Send the local player's position + facing to every connected peer.
export function broadcastState(x, y, z, yaw = 0) {
  const payload = { type: 'state', x, y, z, yaw };
  for (const conn of connections) {
    if (conn.open) conn.send(payload);
  }
}

export function getLocalId() {
  return peer?.id ?? null;
}

export function isConnected() {
  return connections.some((c) => c.open);
}
