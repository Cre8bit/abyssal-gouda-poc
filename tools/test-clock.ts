// Unit tests for the shared world clock estimator (net/clock.ts) — pure
// math, no timers: samples are fed with explicit local/remote stamps.
// Run with: npm test (node ≥ 23.6 strips the .ts types natively).
import { ClockEstimator } from "../src/net/clock.ts";

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`✗ ${name}`);
  } else {
    console.log(`✓ ${name}`);
  }
}
const close = (a: number, b: number, eps: number) => Math.abs(a - b) < eps;

// A host whose monotonic clock runs TRUE_OFFSET seconds ahead of ours.
// A sample at local time L (ms) with round trip rtt carries the host stamp
// it took at the midpoint of the exchange.
const TRUE_OFFSET = 123.456;
const hostStamp = (localMs: number, rttMs: number) =>
  (localMs - rttMs / 2) / 1000 + TRUE_OFFSET;

// --- First sample snaps, whatever the RTT --------------------------------
{
  const c = new ClockEstimator();
  check("starts unsynced at offset 0", !c.synced && c.offset === 0);
  const rtt = 180;
  c.sample(hostStamp(1000, rtt), rtt, 1000);
  check("first sample snaps to the estimate", c.synced);
  check("snap lands on the true offset", close(c.offset, TRUE_OFFSET, 1e-9));
}

// --- Jittered samples blend and stay near the truth ------------------------
{
  const c = new ClockEstimator();
  // Deterministic jitter: rtt wobbles ±20 ms and the return leg is up to
  // 15 ms asymmetric — each raw estimate is off by up to that much, and the
  // EWMA has to hold the offset well inside the raw error band.
  let t = 0;
  for (let i = 0; i < 30; i++) {
    t += 2000;
    const rtt = 60 + 20 * Math.sin(i * 1.7);
    const asym = 0.015 * Math.sin(i * 2.3);
    c.sample(hostStamp(t, rtt) + asym, rtt, t);
  }
  check("jittered samples converge", close(c.offset, TRUE_OFFSET, 0.01));
}

// --- Asymmetric-jitter outliers are rejected, not blended ------------------
{
  const c = new ClockEstimator();
  c.sample(hostStamp(1000, 50), 50, 1000);
  const before = c.offset;
  // A retransmit spike: 500 ms round trip whose stamp is a quarter second
  // stale — trusting rtt/2 symmetry here would drag the offset visibly.
  const accepted = c.sample(hostStamp(3000, 500) - 0.25, 500, 3000);
  check("high-RTT outlier is rejected", !accepted);
  check("offset untouched by the outlier", c.offset === before);
  // The link itself degrading (every sample slow) is accepted again once
  // the best-RTT estimate decays up to meet it.
  let t = 3000;
  let recovered = false;
  for (let i = 0; i < 400 && !recovered; i++) {
    t += 2000;
    recovered = c.sample(hostStamp(t, 500), 500, t);
  }
  check("persistently slow link re-accepted after decay", recovered);
}

// --- A real discontinuity snaps instead of creeping ------------------------
{
  const c = new ClockEstimator();
  c.sample(hostStamp(1000, 40), 40, 1000);
  // New time base 30 s away (e.g. we re-joined a different host).
  const jumped = (localMs: number, rttMs: number) =>
    hostStamp(localMs, rttMs) + 30;
  c.sample(jumped(3000, 40), 40, 3000);
  check(
    "discontinuity > 1 s snaps in one sample",
    close(c.offset, TRUE_OFFSET + 30, 1e-9),
  );
}

// --- reset() rearms the snap ------------------------------------------------
{
  const c = new ClockEstimator();
  c.sample(hostStamp(1000, 40), 40, 1000);
  c.reset();
  check("reset clears offset and sync", c.offset === 0 && !c.synced);
}

if (failures > 0) {
  console.error(`\n${failures} clock test(s) failed`);
  process.exit(1);
}
console.log("\nAll clock tests passed");
