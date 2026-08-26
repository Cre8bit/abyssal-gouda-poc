#!/usr/bin/env node
// chorus-harness.mjs — runs the bell-locating maths outside the browser, with no
// renderer, so the parts that are easy to get silently wrong can be checked as
// numbers instead of squinted at on a HUD:
//
//   · the placement gates reject an off-shell spot and a bunched-up one
//   · SHELL, RING and TWINS each genuinely contain the bell
//   · four beacons in open water LOCK onto the bell, never onto its ghost
//   · four beacons at one depth REFUSE to lock instead of guessing
//   · a fifth beacon at a different depth breaks that tie
//   · copying another diver's belt merges it, once, without losing your own
//   · the fix map draws every stage without throwing
//
// Run with:  npm run chorus
import {
  BEACON_RANGE, BELL_RADIUS, MIN_SEPARATION, MAX_BEACONS,
  STAGE, STAGE_NAME, placeBeacon, clearBeacons, solve, onShell, separationOK,
  beaconCount, myBeaconCount, adoptBeacons, getBeacons,
} from "../src/triangulation.js";
import { initFixMap, drawFixMap } from "../src/fixmap.js";

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? `  — ${detail}` : ""}`);
}

const bell = { x: 0, y: -100, z: 0 };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// Where the diver stands when the antenna chimes: on the shell within tolerance
// and clear of every beacon already planted.
function legalSpot(placed) {
  for (let t = 0; t < 6000; t++) {
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const dir = { x: s * Math.cos(th), y: u, z: s * Math.sin(th) };
    const r = BEACON_RANGE + (Math.random() * 2 - 1) * BELL_RADIUS;
    const p = { x: bell.x + dir.x * r, y: bell.y + dir.y * r, z: bell.z + dir.z * r };
    if (placed.every((q) => dist(p, q) >= MIN_SEPARATION)) return p;
  }
  return null;
}

// The same, for a diver who never leaves one depth. Their beacons all land in a
// horizontal plane the bell is NOT in, which is the layout that cannot tell the
// bell from its mirror image on the far side of that plane.
function legalSpotAtDepth(placed, depth) {
  const rise = depth - bell.y;
  for (let t = 0; t < 6000; t++) {
    const r = BEACON_RANGE + (Math.random() * 2 - 1) * BELL_RADIUS;
    const flat = Math.sqrt(r * r - rise * rise);
    const th = Math.random() * Math.PI * 2;
    const p = { x: bell.x + Math.cos(th) * flat, y: depth, z: bell.z + Math.sin(th) * flat };
    if (placed.every((q) => dist(p, q) >= MIN_SEPARATION)) return p;
  }
  return null;
}

function plantAt(p) {
  placeBeacon(p, dist(p, bell));
}

// --- The gates ------------------------------------------------------------
console.log("\n--- placement gates ---");
check("bell dead on the shell chimes", onShell(BEACON_RANGE));
check("bell one metre inside the band chimes", onShell(BEACON_RANGE - BELL_RADIUS + 1));
check("bell just outside the band is silent", !onShell(BEACON_RANGE + BELL_RADIUS + 1));
check("bell far too close is silent", !onShell(40));

clearBeacons();
plantAt({ x: 0, y: -100, z: 100 });
check(
  "a spot on top of a beacon is refused",
  !separationOK({ x: 0, y: -100, z: 100 + MIN_SEPARATION - 5 }),
);
check(
  "a spot beyond the separation is allowed",
  separationOK({ x: 0, y: -100, z: 100 + MIN_SEPARATION + 5 }),
);

clearBeacons();
for (let i = 0; i < MAX_BEACONS + 3; i++) {
  plantAt({ x: i * 60, y: -100 - i * 7, z: 40 });
}
check(`the belt holds ${MAX_BEACONS} beacons and no more`, beaconCount() === MAX_BEACONS);

// --- Every stage must contain the bell ------------------------------------
console.log("\n--- each stage's shape contains the bell ---");
let shellErr = 0, ringErr = 0, twinErr = 0, ringStage = 0, thirdStage = 0, merged = 0;
const TRIALS = 2000;
for (let t = 0; t < TRIALS; t++) {
  clearBeacons();
  const placed = [];
  for (let i = 0; i < 3; i++) {
    const p = legalSpot(placed);
    placed.push(p);
    plantAt(p);
    const sol = solve();
    if (i === 0) {
      shellErr = Math.max(shellErr, Math.abs(dist(sol.center, bell) - sol.radius));
    } else if (i === 1) {
      if (sol.stage === STAGE.RING) ringStage++;
      const c = sol.ring.center;
      const n = sol.ring.normal;
      const along = (bell.x - c.x) * n.x + (bell.y - c.y) * n.y + (bell.z - c.z) * n.z;
      const radial = Math.sqrt(Math.max(dist(bell, c) ** 2 - along ** 2, 0)) - sol.ring.radius;
      ringErr = Math.max(ringErr, Math.hypot(along, radial));
    } else {
      if (sol.stage === STAGE.TWINS) thirdStage++;
      else if (sol.stage === STAGE.LOCK) merged++; // the pair fell inside the bell
      const d = sol.points
        ? Math.min(dist(sol.points[0], bell), dist(sol.points[1], bell))
        : dist(sol.point, bell);
      twinErr = Math.max(twinErr, d);
    }
  }
}
check("1 beacon → SHELL passes through the bell", shellErr < 0.01, `worst ${shellErr.toExponential(1)} m`);
check("2 beacons → always RING", ringStage === TRIALS);
check("2 beacons → the RING passes through the bell", ringErr < 0.01, `worst ${ringErr.toExponential(1)} m`);
check(
  "3 beacons → TWINS, or a LOCK once the pair merges",
  thirdStage + merged === TRIALS,
  `${thirdStage} twins, ${merged} merged`,
);
check(
  "3 beacons → the answer is inside the bell's body",
  twinErr <= BELL_RADIUS / 2 + 0.01,
  `worst ${twinErr.toFixed(2)} m`,
);

// --- Four beacons: lock, and never onto the ghost -------------------------
console.log("\n--- 4 beacons in open water ---");
let locked = 0, held = 0, ghost = 0, worstLock = 0, cleanPicks = 0, worstClean = 0;
for (let t = 0; t < TRIALS; t++) {
  clearBeacons();
  const placed = [];
  for (let i = 0; i < 4; i++) {
    const p = legalSpot(placed);
    placed.push(p);
    plantAt(p);
  }
  const sol = solve();
  if (sol.stage === STAGE.LOCK) {
    locked++;
    const e = dist(sol.point, bell);
    worstLock = Math.max(worstLock, e);
    if (e > BELL_RADIUS) ghost++;
    // A clean pick discarded the ghost outright; a merged one averaged a pair
    // that both sat inside the bell.
    if (!sol.merged) {
      cleanPicks++;
      worstClean = Math.max(worstClean, e);
    }
  } else if (sol.stage === STAGE.TWINS && sol.flat) held++;
}
check("locks on the great majority of layouts", locked / TRIALS > 0.85, `${((locked / TRIALS) * 100).toFixed(0)}%`);
check("never locks onto the ghost", ghost === 0, `${ghost} of ${locked} locks landed outside the bell`);
check("a lock lands inside the bell's body", worstLock <= BELL_RADIUS / 2 + 0.01, `worst ${worstLock.toFixed(2)} m`);
check("a lock that discarded a ghost is exact", worstClean < 0.01, `${cleanPicks} clean, worst ${worstClean.toExponential(1)} m`);
check("the rest hold at TWINS, flagged flat", locked + held === TRIALS, `${TRIALS - locked - held} did neither`);

// --- A diver who never changes depth --------------------------------------
console.log("\n--- 4 beacons all planted at one depth ---");
let flatLocked = 0, flatHeld = 0, rescued = 0;
for (let t = 0; t < TRIALS; t++) {
  clearBeacons();
  const placed = [];
  const depth = bell.y + 30 + Math.random() * 30; // hovering above the bell
  for (let i = 0; i < 4; i++) {
    const p = legalSpotAtDepth(placed, depth);
    placed.push(p);
    plantAt(p);
  }
  const sol = solve();
  if (sol.stage === STAGE.LOCK) flatLocked++;
  else if (sol.stage === STAGE.TWINS) flatHeld++;

  // Dropping to a new depth for a fifth beacon is the way out.
  const deeper = legalSpot(placed);
  if (deeper) {
    plantAt(deeper);
    const after = solve();
    if (after.stage === STAGE.LOCK && dist(after.point, bell) < BELL_RADIUS) rescued++;
  }
}
check("one depth cannot lock — it holds at TWINS", flatHeld / TRIALS > 0.95, `held ${((flatHeld / TRIALS) * 100).toFixed(0)}%, locked ${flatLocked}`);
check("a 5th beacon at a new depth locks it", rescued / TRIALS > 0.95, `${((rescued / TRIALS) * 100).toFixed(0)}%`);

// The far side of the same coin: beacons level WITH the bell pin it outright,
// because the two candidates merge into the one point between them.
console.log("\n--- 3 beacons level with the bell ---");
let mergedLocks = 0, mergedWorst = 0;
for (let t = 0; t < TRIALS; t++) {
  clearBeacons();
  const placed = [];
  for (let i = 0; i < 3; i++) {
    const p = legalSpotAtDepth(placed, bell.y);
    placed.push(p);
    plantAt(p);
  }
  const sol = solve();
  if (sol.stage === STAGE.LOCK) {
    mergedLocks++;
    mergedWorst = Math.max(mergedWorst, dist(sol.point, bell));
  }
}
check("3 beacons at the bell's own depth lock it", mergedLocks / TRIALS > 0.95, `${((mergedLocks / TRIALS) * 100).toFixed(0)}%`);
check("...and that lock is the bell", mergedWorst < BELL_RADIUS, `worst ${mergedWorst.toFixed(2)} m`);

// --- Degenerate input must not throw or lie ------------------------------
console.log("\n--- degenerate layouts ---");
clearBeacons();
for (const z of [0, 60, 130]) plantAt({ x: 0, y: -100, z });
const line = solve();
check("three beacons in a straight line stay honest", line.collinear === true && line.stage <= STAGE.TWINS, `stage ${line.stage}`);
check("...and hand back a drawable shape", !!(line.ring || line.points || line.point));

clearBeacons();
check("no beacons → NO FIX", solve().stage === STAGE.NONE);

// --- Copying another diver's belt -----------------------------------------
console.log("\n--- copying beacons off another diver ---");
const at = (o) => ({ x: bell.x + o[0], y: bell.y + o[1], z: bell.z + o[2] });
const asTheirs = (o, seq) => ({ ...at(o), r: Math.hypot(...o), owner: "them", seq });

clearBeacons();
plantAt(at([100, 0, 0]));
// What the other diver hands over: their own two, planted elsewhere on the shell.
const theirs = [asTheirs([0, 0, -100], 0), asTheirs([60, 50, 62], 1)];
check("one beacon of mine → SHELL", solve().stage === STAGE.SHELL);
const added = adoptBeacons(theirs);
check("copying adds both of theirs", added === 2 && beaconCount() === 3);
check("...and mine is still just one", myBeaconCount() === 1);
check("three beacons between us → TWINS", solve().stage === STAGE.TWINS, `stage ${STAGE_NAME[solve().stage]}`);
check("copying the same belt twice adds nothing", adoptBeacons(theirs) === 0 && beaconCount() === 3);
check(
  "a copied beacon blocks planting next to it",
  !separationOK(at([0, 0, -100 + MIN_SEPARATION - 5])),
);
check(
  "theirs are marked as not mine",
  getBeacons().filter((b) => b.mine === false).length === 2,
);

// The belt limit counts what YOU plant, so a copied set never locks you out.
clearBeacons();
adoptBeacons(
  Array.from({ length: 6 }, (_, i) => ({
    x: i * 40, y: bell.y, z: 0, r: 100, owner: "them", seq: i,
  })),
);
let planted = 0;
for (let i = 0; i < MAX_BEACONS + 2; i++) {
  if (placeBeacon({ x: -i * 60 - 200, y: bell.y, z: 0 }, 100)) planted++;
}
check(`a full copied set still leaves all ${MAX_BEACONS} of my own`, planted === MAX_BEACONS);
check("held total is both belts", beaconCount() === MAX_BEACONS + 6);

console.log(`\n${failures ? `${failures} FAILED` : "all checks passed"}`);
process.exit(failures ? 1 : 0);

// --- The fix map ----------------------------------------------------------
// Drawing runs against a stub 2D context: no pixels to look at, but every stage
// gets exercised, so a bad field name or a divide-by-zero cannot hide behind a
// screenshot that was never taken.
console.log("\n--- the fix map draws every stage ---");
const calls = [];
const stubCtx = new Proxy(
  {
    createRadialGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 10 }),
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => {
        for (const a of args) {
          if (typeof a === "number" && !Number.isFinite(a)) {
            throw new Error(`${String(prop)} got a non-finite argument`);
          }
        }
        calls.push(String(prop));
      };
    },
    set: () => true,
  },
);
initFixMap({ width: 152, height: 152, getContext: () => stubCtx });

const diver = { x: 40, y: bell.y + 12, z: 90 };
const layouts = [
  ["no beacons", []],
  ["1 → shell", [[100, 0, 0]]],
  ["2 → ring", [[100, 0, 0], [0, 0, 100]]],
  ["3 → twins", [[100, 0, 0], [0, 0, 100], [0, 100, 0]]],
  ["4 → lock", [[100, 0, 0], [0, 0, 100], [0, 100, 0], [-58, -58, -58]]],
  ["4 flat → twins", [[92, 40, 0], [0, 40, 92], [-92, 40, 0], [0, 40, -92]]],
  ["3 level with the bell → merges", [[0, 0, 100], [0, 60, 80], [0, 87, 50]]],
  ["3 strung out in a line", [[95, 0, -55], [95, 0, 0], [95, 0, 55]]],
  ["diver on a beacon", [[40, 12, 90]]],
];
for (const [label, offs] of layouts) {
  clearBeacons();
  for (const o of offs) {
    const at = { x: o[0], y: bell.y + o[1], z: o[2] };
    placeBeacon(at, dist(at, bell));
  }
  const fix = solve();
  let error = null;
  try {
    calls.length = 0;
    drawFixMap({ fix, beacons: getBeacons(), player: diver, yaw: 2.4 });
  } catch (e) {
    error = e.message;
  }
  check(
    `${label} — stage ${STAGE_NAME[fix.stage]}`,
    !error && calls.length > 20,
    error ?? `${calls.length} draw calls`,
  );
}

console.log(`\n${failures ? `${failures} FAILED` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
