#!/usr/bin/env node
// test-recipes.ts — sanity checks over the default worldgen tables
// (src/world/recipes.ts), for BOTH shipped worlds: the classic onion and
// the Great Wheel MVP map. Pure data, runs in node with no DOM/GL.
import {
  DEFAULT_WORLD,
  WHEEL_WORLD,
  partById,
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
    } else if (pl.mode === "shell") {
      check(
        `${tag}: biome ${biome.id} shell inside the world`,
        pl.radius > 0 && pl.radius < world.worldR,
      );
      check(
        `${tag}: biome ${biome.id} shell colossal res valid`,
        VALID_RES.includes(pl.colossalRes),
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
      `${tag}: part ${part.id} axes in range`,
      part.hardness >= 0 &&
        part.hardness <= 3 &&
        part.porosity >= 0 &&
        part.porosity <= 1 &&
        part.odour >= 0 &&
        part.odour <= 1,
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

checkWorld("onion", DEFAULT_WORLD);
checkWorld("wheel", WHEEL_WORLD);

// The wheel world's authored intent, pinned so a careless edit shows up.
check(
  "wheel: has a frame (squash + tilt)",
  !!WHEEL_WORLD.frame && WHEEL_WORLD.frame.squash < 1,
);
check("wheel: has a spine", !!WHEEL_WORLD.spine);
check(
  "wheel: exactly one hull (the Great Wheel)",
  WHEEL_WORLD.biomes.filter((b) => b.placement.mode === "hull").length === 1,
);
check(
  "wheel: three fused layers (veins, melt, galleries)",
  WHEEL_WORLD.biomes.filter((b) => b.placement.mode === "fused").length === 3,
);
check(
  "wheel: the seal part is no-dig",
  WHEEL_WORLD.parts.find((p) => p.id === "dark-rind")?.hardness === 3,
);
check(
  "wheel: gold band sits at the heart",
  WHEEL_WORLD.goldBand.min === 0 && WHEEL_WORLD.goldBand.max < 20,
);

// The resolution rule (r × res ≥ 4) for the parts whose tunnels matter.
for (const world of [DEFAULT_WORLD, WHEEL_WORLD])
  for (const biome of world.biomes) {
    const pl = biome.placement;
    if (pl.mode !== "fused") continue;
    for (const entry of biome.parts) {
      const part = partById(world, entry.part);
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
