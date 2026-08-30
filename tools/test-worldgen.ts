#!/usr/bin/env node
// test-worldgen.ts — the route verifier as an acceptance test (WG-02, WG-07,
// WG-08): on a small seed × difficulty matrix the wheel world must hold BOTH
// seals before their doors open and be REACHABLE after, the sightline trail
// must chain breach → entrance, and the entrance bore must clear 1.4 u.
// Also pins the wheel-world fingerprint — the perf-ticket baseline (WG-04):
// perf changes must not move it; content changes rebase it deliberately.
// Pure data — no meshing, no DOM/GL. Runs in npm test.
import { verifyWorld } from "../src/world/verify.ts";
import { buildWorldData } from "../src/world/gouda.ts";
import { WHEEL_WORLD, cloneWorld } from "../src/world/recipes.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`✓ ${name}`);
  } else {
    failures++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// FNV-1a over the seeded stream's observable output: chunk layout + carve
// counts + gold + spawn. Cheap, meshing-free, and any draw-order change
// moves it.
function fingerprint(seed: number, difficulty: number): string {
  const data = buildWorldData({ seed, difficulty });
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    const q = Math.round(v * 1000) | 0;
    for (let i = 0; i < 4; i++) {
      h ^= (q >>> (i * 8)) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
  };
  for (const c of data.chunks) {
    mix(c.center.x);
    mix(c.center.y);
    mix(c.center.z);
    mix(c.s);
    mix(c.res);
    mix(c.holes.length);
    mix(c.tunnels.length);
  }
  mix(data.debris.length);
  mix(data.goldPos.x);
  mix(data.goldPos.y);
  mix(data.goldPos.z);
  mix(data.spawnPoint.z);
  return (h >>> 0).toString(16).padStart(8, "0");
}

const t0 = Date.now();
const MATRIX: [number, number][] = [
  [1337, 1],
  [1337, 3],
  [424242, 1],
];

const results = new Map<string, ReturnType<typeof verifyWorld>>();
for (const [seed, diff] of MATRIX) {
  const r = verifyWorld(seed, diff);
  results.set(`${seed}/${diff}`, r);
  const tag = `wheel seed ${seed} d${diff}`;
  check(`${tag}: the Great Wheel is sealed until drilled`, r.sealedWheel);
  check(
    `${tag}: the melt shell is sealed with its entrance plugged`,
    r.sealedShell,
  );
  check(`${tag}: reachable once breached`, r.reachable, `visited ${r.visited}`);
  // Passability is enforced at 0.6 u by the search itself; the reported min
  // under-measures by the path-refinement reach, hence the 0.5 floor.
  check(
    `${tag}: rat clearance holds along the route`,
    !r.reachable || r.minClearance >= 0.5,
    `min ${r.minClearance.toFixed(2)} u`,
  );
  check(
    `${tag}: entrance bore clears cargo (≥ 1.4 u)`,
    (r.entranceClearance ?? 0) >= 1.4,
    `${r.entranceClearance?.toFixed(2)} u`,
  );
  check(
    `${tag}: vein trail chains breach → entrance`,
    !!r.trail && r.trail.reachesEntrance && r.trail.orphans <= 3,
    r.trail
      ? `${r.trail.linked}/${r.trail.nodes} linked, ${r.trail.orphans} orphans, entrance ${r.trail.reachesEntrance ? "✓" : "✗"}`
      : "no trail",
  );
  console.log(
    `  · bottleneck ${r.minClearance.toFixed(2)} u @ ${r.bottleneckZone ?? "?"}` +
      ` · entrance ${r.entranceClearance?.toFixed(2) ?? "—"} u` +
      ` · trail ${r.trail?.linked ?? 0}/${r.trail?.nodes ?? 0}` +
      ` · path ${r.path.length} pts · ${r.visited} cells · ${r.ms} ms`,
  );
}

// Sensitivity: with no hulls at all the wheel-seal check must FAIL — proves
// the search really is what stands between the bell and the gold. (Sightline
// goes too: without a hull there are no soft-spot anchors to chain from.)
{
  const noHull = cloneWorld(WHEEL_WORLD);
  noHull.biomes = noHull.biomes.filter((b) => b.placement.mode !== "hull");
  for (const b of noHull.biomes)
    if (b.placement.mode === "band") delete b.placement.sightline;
  const r = verifyWorld(1337, 1, noHull);
  check("no-hull world: sealed check flips to open", !r.sealedWheel);
}

// Determinism: the verifier is a pure function of (seed, difficulty).
{
  const a = results.get("1337/1")!;
  const b = verifyWorld(1337, 1);
  check(
    "verifier is deterministic",
    a.path.length === b.path.length &&
      a.minClearance === b.minClearance &&
      a.visited === b.visited,
  );
}

// Wheel-world fingerprint baseline (WG-04). Perf tickets (WG-19/21/22) must
// keep these EXACT; a content ticket that changes the stream rebases them in
// the same commit and says so.
const PINNED: Record<string, string> = {
  "1337/1": "bf179d31",
  "1337/3": "06178761",
  "424242/1": "e250706b",
};
for (const [key, want] of Object.entries(PINNED)) {
  const [seed, diff] = key.split("/").map(Number);
  const got = fingerprint(seed, diff);
  if (want === "TBD") {
    console.log(`· fingerprint ${key} = "${got}" (pin me)`);
  } else {
    check(`fingerprint ${key} matches baseline`, got === want, got);
  }
}

console.log(
  `\nworldgen verification in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
);
if (failures) {
  console.error(`${failures} worldgen check(s) failed.`);
  process.exit(1);
}
console.log("All worldgen checks passed.");
