#!/usr/bin/env node
// test-worldgen.ts — the route verifier as an acceptance test (WG-02): on a
// small seed × difficulty matrix the wheel world must be SEALED before any
// breach and REACHABLE after drilling the soft spots, with the bottleneck
// reported. Pure data — no meshing, no DOM/GL. Runs in npm test.
import { verifyWorld } from "../src/world/verify.ts";
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
  check(`${tag}: sealed until the soft spots are drilled`, r.sealed);
  check(`${tag}: reachable once breached`, r.reachable, `visited ${r.visited}`);
  check(
    `${tag}: rat clearance holds along the route`,
    !r.reachable || r.minClearance >= 0.55,
    `min ${r.minClearance.toFixed(2)} u`,
  );
  console.log(
    `  · bottleneck ${r.minClearance.toFixed(2)} u @ ${r.bottleneckZone ?? "?"}` +
      ` · path ${r.path.length} pts · ${r.visited} cells · ${r.ms} ms`,
  );
}

// Sensitivity: with no Great Wheel at all the sealed check must FAIL —
// proves the search really is what stands between the bell and the gold.
{
  const noHull = cloneWorld(WHEEL_WORLD);
  noHull.biomes = noHull.biomes.filter((b) => b.placement.mode !== "hull");
  const r = verifyWorld(1337, 1, noHull);
  check("no-hull world: sealed check flips to open", !r.sealed);
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

console.log(
  `\nworldgen verification in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
);
if (failures) {
  console.error(`${failures} worldgen check(s) failed.`);
  process.exit(1);
}
console.log("All worldgen checks passed.");
