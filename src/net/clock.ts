// net/clock.ts — the shared world clock: one time base for every peer.
//
// WG-12 rotation (and the M5 hazard rhythm) is angle = rate × clock — a pure
// function of time, so peers agree exactly IFF they agree on the clock. This
// module is that agreement. The host's monotonic clock is the authority
// (offset 0 there, and in solo); every other peer estimates
// offset = host clock − local clock, NTP-style, off the existing 2 s
// keep-alive: pongs carry the responder's worldNow() stamp (mesh.ts), and the
// requester dates that stamp rtt/2 in the past. Only pongs from the host move
// the offset — a full mesh syncing pairwise would average, not converge.
//
// Geometry NEVER depends on this clock — digs replicate chunk-local
// (SphereDig.c) — so an error here is cosmetic: rotation/shimmer phase.
// That is why corrections BLEND instead of stepping (a step visibly pops
// every spinning chunk), why high-RTT samples are dropped rather than
// half-trusted, and why a host disconnect simply freezes the last offset:
// the survivors stay mutually converged on the departed host's time base.

const RTT_SLACK_MS = 50; // drop samples this much worse than the path's best
const SNAP_S = 1; // a discontinuity bigger than this steps instead of blending
const BLEND = 0.25; // EWMA gain per accepted sample (2 s cadence → ~10 s lock)

export class ClockEstimator {
  offset = 0; // seconds added to the local monotonic clock
  synced = false;
  bestRtt = Infinity;

  // One pong from the clock source; localMs = performance.now() at receipt.
  // Returns whether the sample was accepted.
  sample(remoteWorld: number, rttMs: number, localMs: number): boolean {
    // Best RTT decays upward so a genuinely degraded link is not locked out.
    this.bestRtt =
      rttMs < this.bestRtt ? rttMs : this.bestRtt * 0.98 + rttMs * 0.02;
    if (this.synced && rttMs > this.bestRtt + RTT_SLACK_MS) return false;
    const est = remoteWorld + rttMs / 2000 - localMs / 1000;
    if (!this.synced || Math.abs(est - this.offset) > SNAP_S) {
      this.offset = est;
      this.synced = true;
    } else {
      this.offset += (est - this.offset) * BLEND;
    }
    return true;
  }

  reset(): void {
    this.offset = 0;
    this.synced = false;
    this.bestRtt = Infinity;
  }
}

const clock = new ClockEstimator();

// The shared time base, in seconds. Feed THIS to anything phase-locked
// across peers (updateGouda's spin/shimmer clock); purely local cosmetics
// (particles, post) can stay on local time.
export function worldNow(): number {
  return performance.now() / 1000 + clock.offset;
}

// mesh.ts calls this for every pong that arrives from the host.
export function noteClockSample(remoteWorld: number, rttMs: number): void {
  const first = !clock.synced;
  if (clock.sample(remoteWorld, rttMs, performance.now()) && first) {
    console.log(
      `[net] world clock locked to host: offset ${clock.offset.toFixed(3)} s (rtt ${Math.round(rttMs)} ms)`,
    );
  }
}

// The host's clock IS the world clock — zero the offset on becoming it.
export function resetWorldClock(): void {
  clock.reset();
}
