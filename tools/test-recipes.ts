#!/usr/bin/env node
// test-recipes.ts — sanity checks over the shipped worldgen tables
// (src/world/recipes.ts): the six-biome Great Wheel map. Pure data, runs in
// node with no DOM/GL.
import {
  WHEEL_WORLD,
  cloneWorld,
  partById,
  scatterSurfaceRadius,
  validateWorld,
  VALID_RES,
  type BiomeRecipe,
  type WorldRecipe,
} from "../src/world/recipes.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`✓ ${name}`);
  } else {
    failures++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function checkWorld(tag: string, world: WorldRecipe): void {
  check(
    `${tag}: part ids are unique`,
    new Set(world.parts.map((p) => p.id)).size === world.parts.length,
  );
  check(
    `${tag}: biome ids are unique`,
    new Set(world.biomes.map((b) => b.id)).size === world.biomes.length,
  );

  const errors = validateWorld(world);
  check(`${tag}: validateWorld passes`, errors.length === 0, errors.join("; "));

  for (const biome of world.biomes) {
    for (const entry of biome.parts) {
      let resolves = true;
      try {
        partById(world, entry.part);
      } catch {
        resolves = false;
      }
      check(
        `${tag}: biome ${biome.id} part "${entry.part}" resolves`,
        resolves,
      );
      check(
        `${tag}: biome ${biome.id} part "${entry.part}" weight > 0`,
        entry.weight > 0,
      );
    }
    check(`${tag}: biome ${biome.id} has ≥1 part`, biome.parts.length >= 1);
    check(
      `${tag}: biome ${biome.id} res is a marching-cubes size`,
      VALID_RES.includes(biome.res),
      `res ${biome.res}`,
    );
    check(
      `${tag}: biome ${biome.id} sizes sane`,
      biome.sizeBase > 0 && biome.sizeVar >= 0,
    );
    check(
      `${tag}: biome ${biome.id} has mood + desc`,
      biome.mood.length > 0 && biome.desc.length > 0,
    );

    const pl = biome.placement;
    if (pl.mode === "band" || pl.mode === "fused") {
      check(
        `${tag}: biome ${biome.id} ${pl.mode} ordered within the world`,
        pl.rMin < pl.rMax && pl.rMax <= world.worldR,
        `${pl.rMin}–${pl.rMax} vs worldR ${world.worldR}`,
      );
    } else if (pl.mode === "hull") {
      check(
        `${tag}: biome ${biome.id} hull inside the world`,
        pl.radius > 0 && pl.radius < world.worldR,
      );
      check(
        `${tag}: biome ${biome.id} hull tiles use sizeVar 0`,
        biome.sizeVar === 0,
      );
      // The husk cap (X4): amp × tileSize < thickness / 3.
      for (const entry of biome.parts) {
        const part = partById(world, entry.part);
        check(
          `${tag}: hull ${biome.id} crust amp under the lace cap`,
          part.crust.amp * biome.sizeBase < pl.thickness / 3,
          `amp ${part.crust.amp} × ${biome.sizeBase} vs ${pl.thickness}/3`,
        );
      }
    }
    if (pl.mode === "fused")
      check(
        `${tag}: biome ${biome.id} fused tiles use sizeVar 0`,
        biome.sizeVar === 0,
      );
  }

  for (const part of world.parts) {
    check(
      `${tag}: part ${part.id} eye counts ordered`,
      part.eyes.min <= part.eyes.max && part.eyes.min >= 0,
    );
    check(
      `${tag}: part ${part.id} pore counts ordered`,
      part.pores.min <= part.pores.max && part.pores.min >= 0,
    );
    check(
      `${tag}: part ${part.id} size range ordered`,
      part.size.min <= part.size.max,
    );
    check(`${tag}: part ${part.id} crust depth positive`, part.crust.depth > 0);
    check(
      `${tag}: part ${part.id} hardness in range`,
      part.hardness >= 0 && part.hardness <= 3,
    );
    check(
      `${tag}: part ${part.id} has mood + desc`,
      part.mood.length > 0 && part.desc.length > 0,
    );
  }

  const centers = world.biomes.filter(
    (b: BiomeRecipe) => b.placement.mode === "center",
  );
  check(`${tag}: exactly one center biome (the heart)`, centers.length === 1);
  check(
    `${tag}: gold band ordered inside the world`,
    world.goldBand.min < world.goldBand.max &&
      world.goldBand.max < world.worldR,
  );
  check(
    `${tag}: boundary outside the world edge`,
    world.boundaryR > world.worldR,
  );
}

checkWorld("wheel", WHEEL_WORLD);

// The wheel world's authored intent, pinned so a careless edit shows up.
check(
  "wheel: has a frame (squash + tilt)",
  !!WHEEL_WORLD.frame && WHEEL_WORLD.frame.squash < 1,
);
check("wheel: has a spine", !!WHEEL_WORLD.spine);

// Generation order IS the contract (recipes.ts header): the Wheel's soft
// spots must exist before the veins place (sightline anchors), and the veins
// before the melt shell (its entrance sits at the trail terminus).
check(
  "wheel: biome generation order pinned",
  WHEEL_WORLD.biomes.map((b) => b.id).join(",") ===
    "heart,galleries,melt,great-wheel,veins,melt-shell,drift",
  WHEEL_WORLD.biomes.map((b) => b.id).join(","),
);

// Two seals, opened two different ways.
const wheelHull = WHEEL_WORLD.biomes.find((b) => b.id === "great-wheel")!;
const shellHull = WHEEL_WORLD.biomes.find((b) => b.id === "melt-shell")!;
check(
  "wheel: the Great Wheel is a wheel hull with soft spots",
  wheelHull.placement.mode === "hull" &&
    wheelHull.placement.surface === "wheel" &&
    wheelHull.placement.softSpots >= 1 &&
    !wheelHull.placement.entrance,
);
check(
  "wheel: the melt shell is a sphere hull, no soft spots, entrance ≥ 1.4 u",
  shellHull.placement.mode === "hull" &&
    shellHull.placement.surface === "sphere" &&
    shellHull.placement.softSpots === 0 &&
    (shellHull.placement.entrance?.r ?? 0) >= 1.4,
);
check(
  "wheel: both seal parts are no-dig",
  WHEEL_WORLD.parts.find((p) => p.id === "dark-rind")?.hardness === 3 &&
    WHEEL_WORLD.parts.find((p) => p.id === "melt-rind")?.hardness === 3,
);

// T3 (docs/bug-collision-render-desync.md §2) — the scatter-overlap rule.
// shareCarves() refuses to compose two ellipsoid chunks, so a band whose
// guard lets its chunks interpenetrate builds invisible walls. Every shipped
// band must clear its parts' surfaces, and a deliberately-overlapping table
// must be REJECTED — the rule is worthless if it only ever passes.
for (const biome of WHEEL_WORLD.biomes) {
  const pl = biome.placement;
  if (pl.mode !== "band") continue;
  for (const entry of biome.parts) {
    const surf = scatterSurfaceRadius(partById(WHEEL_WORLD, entry.part));
    check(
      `T3: band ${biome.id} guard clears ${entry.part}'s surface`,
      pl.guard >= surf,
      `guard ${pl.guard} vs surface ${surf.toFixed(3)}`,
    );
  }
}
{
  const overlapping = cloneWorld(WHEEL_WORLD);
  const b = overlapping.biomes.find((x) => x.id === "veins")!;
  if (b.placement.mode === "band") b.placement.guard = 0.45;
  const errors = validateWorld(overlapping);
  check(
    "T3: validateWorld rejects an interpenetrating scatter band",
    errors.some((e) => e.includes("veins") && e.includes("interpenetrate")),
    errors.join("; ") || "no errors raised",
  );
}

// The veins are a sightline-chained scatter, graded inward — no fused body.
const veins = WHEEL_WORLD.biomes.find((b) => b.id === "veins")!;
check(
  "wheel: veins are a graded sightline band",
  veins.placement.mode === "band" &&
    veins.placement.sightline === true &&
    veins.placement.densityGrade === "inward" &&
    veins.placement.sizeGrade === "inward",
);
check(
  "wheel: two fused layers (melt, galleries)",
  WHEEL_WORLD.biomes.filter((b) => b.placement.mode === "fused").length === 2,
);

// Budgets follow the WG-04 schema.
const drift = WHEEL_WORLD.biomes.find((b) => b.id === "drift")!;
const melt = WHEEL_WORLD.biomes.find((b) => b.id === "melt")!;
const heart = WHEEL_WORLD.biomes.find((b) => b.id === "heart")!;
check("wheel: drift seeds 6 air pockets", drift.budgets?.airPockets === 6);
check(
  "wheel: heart seeds the last air pocket",
  heart.budgets?.airPockets === 1,
);
check(
  "wheel: melt hazard budget seeded",
  melt.budgets?.hazards?.meltFalls === 12 &&
    melt.budgets?.hazards?.meltPools === 6 &&
    melt.budgets?.hazards?.vents === 8,
);
check(
  "wheel: gold band sits at the heart",
  WHEEL_WORLD.goldBand.min === 0 && WHEEL_WORLD.goldBand.max < 20,
);

// WG-12: the two scatter bands tumble — slow seeded rotation, in the law's
// (0, 4] °/s window.
const driftPl = drift.placement;
check(
  "wheel: veins + drift carry a rotate rate in (0, 4] °/s",
  veins.placement.mode === "band" &&
    driftPl.mode === "band" &&
    (veins.placement.rotate?.degPerSec ?? 0) > 0 &&
    (veins.placement.rotate?.degPerSec ?? 9) <= 4 &&
    (driftPl.rotate?.degPerSec ?? 0) > 0 &&
    (driftPl.rotate?.degPerSec ?? 9) <= 4,
);

// WG-13: the dark-veins glow is edge-baked — the part bakes aVein, the
// biome material consumes it instead of interior noise patches.
check(
  "wheel: roquefort bakes edge veins and the veins wax consumes them",
  partById(WHEEL_WORLD, "roquefort-float").tags.includes("edge-veins") &&
    veins.material.edgeVeins === true,
);

// The emmental holes stay readable: r × res ≥ 4 (cheese-parts §1).
const emmental = WHEEL_WORLD.parts.find((p) => p.id === "emmental-drift")!;
check(
  "r×res: emmental holes ≥ 4 cells",
  emmental.eyes.rBase * drift.res >= 4,
  `${(emmental.eyes.rBase * drift.res).toFixed(1)}`,
);

// The resolution rule (r × res ≥ 3 floor) for fused-layer tunnels.
for (const biome of WHEEL_WORLD.biomes) {
  const pl = biome.placement;
  if (pl.mode !== "fused") continue;
  for (const entry of biome.parts) {
    const part = partById(WHEEL_WORLD, entry.part);
    const cells = part.tunnels.rBase * biome.res;
    check(
      `r×res: ${biome.id}/${part.id} tunnels ≥ 3 cells`,
      cells >= 3,
      `${cells.toFixed(1)}`,
    );
  }
}

if (failures) {
  console.error(`\n${failures} recipe check(s) failed.`);
  process.exit(1);
}
console.log("\nAll recipe checks passed.");
