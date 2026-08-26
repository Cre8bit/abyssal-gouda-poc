// interpolation.js — snapshot buffer for smooth remote player movement.
//
// Remote state arrives in discrete packets (~20/s) with network jitter.
// Instead of teleporting the remote player on every packet, we buffer
// snapshots (timestamped on arrival) and render the remote player a fixed
// delay in the past, linearly interpolating between the two snapshots that
// surround the render time. Result: continuous, lag-jitter-free motion.

const RENDER_DELAY_MS = 120; // ~2.5 packets of headroom at 20 Hz
const MAX_EXTRAPOLATION_MS = 200; // cap prediction when packets stop
const BUFFER_TTL_MS = 1000;

export class SnapshotBuffer {
  constructor() {
    this.snapshots = []; // [{ t, x, y, z, yaw, pitch }]
    // sample() returns this reused object (one per buffer, refilled every
    // frame) — consume it before the next sample() call, don't store it.
    this._out = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, sy: 0, sp: 0 };
  }

  // Call on teleports: forget history so we don't interpolate across the map.
  reset() {
    this.snapshots.length = 0;
  }

  push(state) {
    this.snapshots.push({ t: performance.now(), ...state });
    // Drop stale history.
    const cutoff = performance.now() - BUFFER_TTL_MS;
    while (this.snapshots.length > 2 && this.snapshots[0].t < cutoff) {
      this.snapshots.shift();
    }
  }

  // Returns the interpolated state at (now - RENDER_DELAY_MS), or null.
  sample() {
    const snaps = this.snapshots;
    if (snaps.length === 0) return null;

    const renderT = performance.now() - RENDER_DELAY_MS;

    // Before the first snapshot: hold it.
    if (renderT <= snaps[0].t) return snaps[0];

    // Find the pair surrounding renderT and interpolate.
    for (let i = 0; i < snaps.length - 1; i++) {
      const a = snaps[i];
      const b = snaps[i + 1];
      if (renderT >= a.t && renderT <= b.t) {
        const alpha = (renderT - a.t) / Math.max(b.t - a.t, 1e-6);
        const out = this._out;
        out.x = lerp(a.x, b.x, alpha);
        out.y = lerp(a.y, b.y, alpha);
        out.z = lerp(a.z, b.z, alpha);
        out.yaw = lerpAngle(a.yaw ?? 0, b.yaw ?? 0, alpha);
        out.pitch = lerp(a.pitch ?? 0, b.pitch ?? 0, alpha);
        // Lazy body orientation (may be absent from older peers).
        out.sy = lerpAngle(a.sy ?? a.yaw ?? 0, b.sy ?? b.yaw ?? 0, alpha);
        out.sp = lerp(a.sp ?? a.pitch ?? 0, b.sp ?? b.pitch ?? 0, alpha);
        return out;
      }
    }

    // Past the newest snapshot: extrapolate the position briefly, then hold.
    // Angles (including the lazy body sy/sp) HOLD rather than extrapolate —
    // a predicted spin looks worse than a paused one.
    const last = snaps[snaps.length - 1];
    if (snaps.length >= 2) {
      const prev = snaps[snaps.length - 2];
      const dt = Math.max(last.t - prev.t, 1e-6);
      const overshoot = Math.min(renderT - last.t, MAX_EXTRAPOLATION_MS);
      const alpha = overshoot / dt;
      const out = this._out;
      out.x = last.x + (last.x - prev.x) * alpha;
      out.y = last.y + (last.y - prev.y) * alpha;
      out.z = last.z + (last.z - prev.z) * alpha;
      out.yaw = last.yaw ?? 0;
      out.pitch = last.pitch ?? 0;
      out.sy = last.sy ?? last.yaw ?? 0;
      out.sp = last.sp ?? last.pitch ?? 0;
      return out;
    }
    return last;
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Interpolates angles along the shortest arc (handles the ±π wrap).
function lerpAngle(a, b, t) {
  let diff = (b - a) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}
