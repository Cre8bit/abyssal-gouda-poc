// effects.ts — player status plumbing (T0.2).
//
// Every player carries a 7-bit status mask, shipped in byte 3 of the binary
// state packet (net/) at 30 Hz — and re-broadcast IMMEDIATELY on any
// local change, so a flag is visible to peers well under 100 ms.
//
// The rule (see docs/plan-game-loop.md §2): effects are applied LOCALLY
// (inverted controls, screen blur, O₂ drain…); the network only carries the
// flags, and remote clients merely *render* what a flag implies (bubbles,
// coughs, the carrier's glow). Replication cost: zero extra bytes.

export const STATUS = {
  CARRYING: 1 << 0, // holding the Golden Gouda (phase 1)
  GASSED: 1 << 1, // inside a fermentation cloud (phase 3)
  POISONED: 1 << 2, // hit a rat-poison vein — inverted controls (phase 3)
  TRAPPED: 1 << 3, // snapped into a rat trap (phase 3)
  SPEAKING: 1 << 4, // mic activity — bubble trail (phase 4)
} as const;

export type StatusBit = (typeof STATUS)[keyof typeof STATUS];
export type StatusMask = number; // OR of StatusBits, 7 bits on the wire

// --- Local player ------------------------------------------------------------

let localMask: StatusMask = 0;
const expiries = new Map<StatusBit, number>(); // bit -> performance.now() deadline
// fires on any local mask change (main → instant rebroadcast)
let changeCb: ((mask: StatusMask) => void) | null = null;

export function onLocalStatusChange(fn: (mask: StatusMask) => void): void {
  changeCb = fn;
}

export function getLocalStatus(): StatusMask {
  return localMask;
}

export function hasLocalStatus(bit: StatusBit): boolean {
  return (localMask & bit) !== 0;
}

// Set or clear a status bit. `durationMs` auto-clears it (e.g. poison 10 s);
// setting the bit again refreshes the timer.
export function setLocalStatus(
  bit: StatusBit,
  on: boolean,
  durationMs = 0,
): void {
  const prev = localMask;
  if (on) {
    localMask |= bit;
    if (durationMs > 0) expiries.set(bit, performance.now() + durationMs);
    else expiries.delete(bit);
  } else {
    localMask &= ~bit;
    expiries.delete(bit);
  }
  if (localMask !== prev) changeCb?.(localMask);
}

// Call once per frame: expires timed statuses.
export function updateEffects(): void {
  if (expiries.size === 0) return;
  const now = performance.now();
  for (const [bit, deadline] of expiries) {
    if (now >= deadline) setLocalStatus(bit, false);
  }
}

// Reset for a fresh session (state.ts resetGameState): clears the local mask
// WITHOUT firing the change callback — there is nobody left to rebroadcast to.
export function resetEffects(): void {
  localMask = 0;
  expiries.clear();
  peerMasks.clear();
}

// --- Remote peers ------------------------------------------------------------

const peerMasks = new Map<string, StatusMask>(); // peerId -> latest received

export function setPeerStatus(peerId: string, mask: StatusMask): void {
  peerMasks.set(peerId, mask & 0x7f);
}

export function getPeerStatus(peerId: string): StatusMask {
  return peerMasks.get(peerId) ?? 0;
}

export function clearPeerStatus(peerId: string): void {
  peerMasks.delete(peerId);
}

// Compact HUD/debug rendering of a mask (e.g. "🧀🪤").
const ICONS: Array<[StatusBit, string]> = [
  [STATUS.CARRYING, "🧀"],
  [STATUS.GASSED, "🟢"],
  [STATUS.POISONED, "☠️"],
  [STATUS.TRAPPED, "🪤"],
  [STATUS.SPEAKING, "💬"],
];

export function statusIcons(mask: StatusMask): string {
  let out = "";
  for (const [bit, icon] of ICONS) if (mask & bit) out += icon;
  return out;
}
