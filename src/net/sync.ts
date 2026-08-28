// net/sync.ts — packet flow over the mesh: codec dispatch, sequence
// validation, and the send paths. The synchronous, hot (30 Hz) half of the
// network layer; its sibling mesh.ts owns the connections themselves.
//
// STATE PACKETS — 24-byte binary (see protocol.ts). Each carries a u16
// sequence number: stale/reordered packets are dropped on arrival, so an
// unordered channel can never make a player jump backwards.
import {
  encodeState,
  decodeState,
  seqNewer,
  STATE_PACKET_BYTES,
  type PlayerStateOut,
  type PlayerStateIn,
} from "./protocol.ts";
import { peers, rawSend, setDataSinks, type EventPayload } from "./mesh.ts";

// Application-level reliable events ({ kind: "dig", x, y, z … }). The set of
// kinds is open — features register their own (items, traps…) — so payload
// fields beyond `kind` stay loosely typed at this boundary.
export interface GameEvent {
  kind: string;
  [key: string]: unknown;
}

type StateReceivedCb = (peerId: string, state: PlayerStateIn) => void;
type EventReceivedCb = (peerId: string, data: GameEvent) => void;

let stateReceivedCb: StateReceivedCb | null = null;
let eventReceivedCb: EventReceivedCb | null = null;

export function onStateReceived(fn: StateReceivedCb): void {
  stateReceivedCb = fn;
}
export function onEventReceived(fn: EventReceivedCb): void {
  eventReceivedCb = fn;
}

// --- Intake (mesh.ts hands the raw firehose to us) ---------------------------

let badPacketWarned = false;
function handleStatePacket(
  peerId: string,
  data: ArrayBuffer | ArrayBufferView,
): void {
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
  stateReceivedCb?.(peerId, s);
}

setDataSinks({
  onBinary: handleStatePacket,
  onEvent: (peerId, data) => {
    if (typeof data.kind === "string") {
      eventReceivedCb?.(peerId, data as GameEvent);
    }
  },
  // Legacy JSON state (older clients): forward as-is — decodeState fields
  // and JSON fields share the same names.
  onLegacyState: (peerId, data) => {
    stateReceivedCb?.(peerId, data as PlayerStateIn);
  },
});

// --- Sending ------------------------------------------------------------------

let seqOut = 0; // shared u16 counter for outgoing state packets

// Broadcast the local pose + flags to every peer, over the unreliable
// channel when up (reliable fallback otherwise). ~24 bytes × peers × 30 Hz.
// One scratch buffer, reused every tick: channel .send() copies the bytes
// synchronously, so nothing downstream holds a reference to it.
const stateScratch = new ArrayBuffer(STATE_PACKET_BYTES);
export function broadcastState(s: PlayerStateOut): void {
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
export function sendEvent(data: GameEvent): void {
  const payload: EventPayload = { type: "event", ...data };
  for (const rec of peers.values()) rawSend(rec, payload);
}

// Reliable gameplay event to ONE peer (e.g. the world seed on join).
export function sendEventTo(peerId: string, data: GameEvent): void {
  const rec = peers.get(peerId);
  if (rec) rawSend(rec, { type: "event", ...data });
}
