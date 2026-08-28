#!/usr/bin/env node
// test-recipes.ts — sanity checks over the default worldgen tables
// (src/world/recipes.ts). Pure data, runs in node with no DOM/GL.
import {
  DEFAULT_WORLD,
  partById,
  type BiomeRecipe,
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

const world = DEFAULT_WORLD;
const VALID_RES = new Set([32, 48, 56, 64, 72, 96]);

check(
  "part ids are unique",
  new Set(world.parts.map((p) => p.id)).size === world.parts.length,
);
check(
  "biome ids are unique",
  new Set(world.biomes.map((b) => b.id)).size === world.biomes.length,
);

for (const biome of world.biomes) {
  for (const entry of biome.parts) {
    let resolves = true;
    try {
      partById(world, entry.part);
    } catch {
      resolves = false;
    }
    check(`biome ${biome.id} part "${entry.part}" resolves`, resolves);
    check(
      `biome ${biome.id} part "${entry.part}" weight > 0`,
      entry.weight > 0,
    );
  }
  check(`biome ${biome.id} has ≥1 part`, biome.parts.length >= 1);
  check(
    `biome ${biome.id} res is a marching-cubes size`,
    VALID_RES.has(biome.res),
    `res ${biome.res}`,
  );
  check(
    `biome ${biome.id} sizes sane`,
    biome.sizeBase > 0 && biome.sizeVar >= 0,
  );

  const pl = biome.placement;
  if (pl.mode === "band") {
    check(
      `biome ${biome.id} band ordered within the world`,
      pl.rMin < pl.rMax && pl.rMax <= world.worldR,
      `${pl.rMin}–${pl.rMax} vs worldR ${world.worldR}`,
    );
  } else if (pl.mode === "shell") {
    check(
      `biome ${biome.id} shell inside the world`,
      pl.radius > 0 && pl.radius < world.worldR,
    );
    check(
      `biome ${biome.id} shell colossal res valid`,
      VALID_RES.has(pl.colossalRes),
    );
  }
}

for (const part of world.parts) {
  check(
    `part ${part.id} eye counts ordered`,
    part.eyes.min <= part.eyes.max && part.eyes.min >= 0,
  );
  check(
    `part ${part.id} pore counts ordered`,
    part.pores.min <= part.pores.max && part.pores.min >= 0,
  );
  check(`part ${part.id} size range ordered`, part.size.min <= part.size.max);
  check(`part ${part.id} crust depth positive`, part.crust.depth > 0);
}

const centers = world.biomes.filter(
  (b: BiomeRecipe) => b.placement.mode === "center",
);
check("exactly one center biome (the heart)", centers.length === 1);
check(
  "gold band ordered inside the world",
  world.goldBand.min < world.goldBand.max && world.goldBand.max < world.worldR,
);
check("boundary outside the world edge", world.boundaryR > world.worldR);

if (failures) {
  console.error(`\n${failures} recipe check(s) failed.`);
  process.exit(1);
}
console.log("\nAll recipe checks passed.");
