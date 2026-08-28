// recipes.ts — the cheese kit's data tables (M2). Everything the world
// generator consumes as *numbers* lives here as plain, JSON-serializable
// data; gouda.ts owns the SDF/marching-cubes implementations of the shape
// families and reads these tables. No three.js imports — node-testable.
//
// Three levels of recipe:
//   PartRecipe   one kind of cheese chunk (shape family + carve counts/radii)
//   BiomeRecipe  a zone: placement (band/shell/center), sizes, weighted part
//                list, wax material
//   WorldRecipe  the whole onion: ordered biome list + world-level radii
//
// Conventions: carve radii (eyes/pores/tunnels) are in chunk-local units
// where the body surface sits at |p| ≈ 0.6 in a [-1,1] grid — a radius of
// 0.1 on a 40 u chunk is a 4 u cavern. Sizes/radii at biome/world level are
// world units. Biome order in WorldRecipe.biomes IS generation order (the
// seeded rng stream and spacing checks depend on it).
//
// The worldgen bench (/worldgen.html) edits live copies of these tables and
// its "copy" buttons dump entries back in this shape — paste them here to
// ship a tuning.

export type PartKind = "wheel" | "hunk" | "block" | "slab" | "column";

export type ZoneName =
  | "drift"
  | "reef"
  | "chimneys"
  | "scree"
  | "warrens"
  | "crust"
  | "galleries"
  | "bulwark"
  | "hollows"
  | "heart";

export interface PartRecipe {
  id: string;
  label: string;
  kind: PartKind;
  // Bench default size range (world u). Biomes place at their own sizes.
  size: { min: number; max: number };
  // Surface noise: amp = wax bumpiness, freq = feature scale, depth = how
  // far under the surface the noise band fades out.
  crust: { amp: number; freq: number; depth: number };
  // Eyes: interior caverns/chambers, connected by the tunnel spanning tree.
  eyes: { min: number; max: number; rBase: number; rVar: number };
  coreEye: number; // 0 = none; else one guaranteed central cavern radius
  // Pores: small surface holes (slabs use big ones as through-holes).
  pores: { min: number; max: number; rBase: number; rVar: number };
  // bends = tortuosity: 0 straight, 1 winding, 2+ snaking speleology.
  tunnels: { rBase: number; rVar: number; bends: number };
  exits: number; // tunnels from outermost eyes to open water (+0–1 random)
  deadEnds: number; // sealed chambers behind thin marked walls (+1/difficulty)
  narrow: boolean; // tighter minimum tunnel radius
  tangle: boolean; // spanning tree rewires to random earlier eyes
  tags: string[]; // gameplay tags (air-pocket, dig-through, thread… — M3)
}

export type BiomePlacement =
  | { mode: "center" } // one chunk at the origin
  | {
      mode: "band"; // scattered through a spherical shell [rMin, rMax]
      rMin: number;
      rMax: number;
      count: number;
      guard: number; // same-zone spacing factor: min gap = (s1+s2)·guard
    }
  | {
      mode: "shell"; // fused fibonacci wall with radial through-routes
      radius: number;
      count: number;
      perDifficulty: number; // extra chunks per difficulty step above 1
      colossalEvery: number; // every Nth chunk is a landmark colossus
      colossalBonus: number; // added to size base for colossi
      colossalVar: number;
      colossalRes: number;
    };

export interface BiomeMaterial {
  paste: number; // carved interior color (hex)
  rind: number; // outer wax color (hex)
  vein: [number, number, number]; // glow color (linear rgb)
  veinStrength: number;
}

export interface BiomeRecipe {
  id: ZoneName;
  label: string; // build-progress label, e.g. "the hollows"
  placement: BiomePlacement;
  sizeBase: number; // chunk scale = sizeBase + rng()·sizeVar (world u)
  sizeVar: number;
  res: number; // marching-cubes grid (32|48|56|64|72|96)
  parts: { part: string; weight: number }[]; // weighted PartRecipe ids
  material: BiomeMaterial;
  fishMayEnter: boolean; // data for the M3 threat pass (unread today)
}

export interface WorldRecipe {
  worldR: number; // outer edge of the outermost band
  boundaryR: number; // visible boundary veil radius
  goldBand: { min: number; max: number }; // gold host wheel radial band
  goldMinCavernR: number; // smallest cavern (world u) that may hide it
  debrisCount: number; // free-floating crumbs
  heartGuard: number; // spacing factor of every chunk vs the heart
  parts: PartRecipe[];
  biomes: BiomeRecipe[]; // generation order — outermost LAST
}

// --- Default part table ------------------------------------------------------

const PASTE = 0xecc76a;

export const DEFAULT_PARTS: PartRecipe[] = [
  {
    id: "heart-hunk",
    label: "heart hunk",
    kind: "hunk",
    size: { min: 48, max: 64 },
    crust: { amp: 0.08, freq: 1.6, depth: 0.22 },
    eyes: { min: 18, max: 24, rBase: 0.1, rVar: 0.17 },
    coreEye: 0.34,
    pores: { min: 10, max: 18, rBase: 0.055, rVar: 0.075 },
    tunnels: { rBase: 0.055, rVar: 0.04, bends: 1 },
    exits: 6,
    deadEnds: 4,
    narrow: false,
    tangle: false,
    tags: ["landmark"],
  },
  {
    id: "hollow-wheel",
    label: "cramped wheel",
    kind: "wheel",
    size: { min: 14, max: 21 },
    crust: { amp: 0.08, freq: 1.6, depth: 0.22 },
    eyes: { min: 8, max: 12, rBase: 0.1, rVar: 0.12 },
    coreEye: 0,
    pores: { min: 10, max: 18, rBase: 0.055, rVar: 0.075 },
    tunnels: { rBase: 0.055, rVar: 0.04, bends: 1 },
    exits: 4,
    deadEnds: 1,
    narrow: false,
    tangle: false,
    tags: [],
  },
  {
    id: "gallery-wheel",
    label: "cathedral wheel",
    kind: "wheel",
    size: { min: 22, max: 34 },
    crust: { amp: 0.08, freq: 1.6, depth: 0.22 },
    eyes: { min: 6, max: 9, rBase: 0.16, rVar: 0.12 },
    coreEye: 0,
    pores: { min: 10, max: 18, rBase: 0.055, rVar: 0.075 },
    tunnels: { rBase: 0.08, rVar: 0.04, bends: 1 }, // wide corridors
    exits: 4,
    deadEnds: 2,
    narrow: false,
    tangle: false,
    tags: [],
  },
  {
    id: "wall-hunk",
    label: "wall hunk",
    kind: "hunk",
    size: { min: 44, max: 72 },
    crust: { amp: 0.08, freq: 1.6, depth: 0.22 },
    eyes: { min: 12, max: 18, rBase: 0.1, rVar: 0.15 },
    coreEye: 0,
    pores: { min: 10, max: 18, rBase: 0.055, rVar: 0.075 },
    tunnels: { rBase: 0.055, rVar: 0.04, bends: 1 },
    exits: 3,
    deadEnds: 1,
    narrow: false,
    tangle: false,
    tags: ["dig-through"],
  },
  {
    id: "warren-hunk",
    label: "warren hunk",
    kind: "hunk",
    size: { min: 30, max: 38 },
    crust: { amp: 0.08, freq: 1.6, depth: 0.22 },
    eyes: { min: 18, max: 26, rBase: 0.05, rVar: 0.05 },
    coreEye: 0,
    pores: { min: 10, max: 18, rBase: 0.055, rVar: 0.075 },
    tunnels: { rBase: 0.038, rVar: 0.022, bends: 2 },
    exits: 2,
    deadEnds: 2,
    narrow: true,
    tangle: true,
    tags: [],
  },
  {
    id: "cut-block",
    label: "cut block",
    kind: "block",
    size: { min: 10, max: 18 },
    crust: { amp: 0.04, freq: 1.6, depth: 0.22 },
    eyes: { min: 2, max: 4, rBase: 0.09, rVar: 0.09 },
    coreEye: 0,
    pores: { min: 10, max: 18, rBase: 0.055, rVar: 0.075 },
    tunnels: { rBase: 0.055, rVar: 0.04, bends: 0 },
    exits: 2,
    deadEnds: 0,
    narrow: false,
    tangle: false,
    tags: [],
  },
  {
    id: "holey-slab",
    label: "holey slab",
    kind: "slab",
    size: { min: 30, max: 44 },
    crust: { amp: 0.04, freq: 1.6, depth: 0.22 },
    eyes: { min: 2, max: 4, rBase: 0.1, rVar: 0.08 },
    coreEye: 0,
    pores: { min: 14, max: 20, rBase: 0.08, rVar: 0.09 }, // big through-holes
    tunnels: { rBase: 0.055, rVar: 0.04, bends: 0 },
    exits: 2,
    deadEnds: 0,
    narrow: false,
    tangle: false,
    tags: ["thread"],
  },
  {
    id: "smoked-column",
    label: "smoked column",
    kind: "column",
    size: { min: 30, max: 42 },
    crust: { amp: 0.08, freq: 1.6, depth: 0.22 },
    eyes: { min: 5, max: 8, rBase: 0.08, rVar: 0.08 },
    coreEye: 0,
    pores: { min: 12, max: 18, rBase: 0.055, rVar: 0.075 },
    tunnels: { rBase: 0.055, rVar: 0.04, bends: 1 },
    exits: 3,
    deadEnds: 0,
    narrow: false,
    tangle: false,
    tags: [],
  },
];

// --- Default biome table (generation order: inside → out) ---------------------

const COLOSSAL = {
  colossalEvery: 13,
  colossalBonus: 12,
  colossalVar: 8,
  colossalRes: 64,
};

export const DEFAULT_BIOMES: BiomeRecipe[] = [
  {
    id: "heart",
    label: "the heart",
    placement: { mode: "center" },
    sizeBase: 56,
    sizeVar: 0,
    res: 96,
    parts: [{ part: "heart-hunk", weight: 1 }],
    // gold wax decoy centerpiece
    material: {
      paste: 0xf0c85a,
      rind: 0xa77b22,
      vein: [1.0, 0.8, 0.22],
      veinStrength: 0.85,
    },
    fishMayEnter: true,
  },
  {
    id: "hollows",
    label: "the hollows",
    placement: { mode: "band", rMin: 38, rMax: 60, count: 8, guard: 0.5 },
    sizeBase: 14,
    sizeVar: 7,
    res: 48,
    parts: [{ part: "hollow-wheel", weight: 1 }],
    // black wax, aged — too close to the heart
    material: {
      paste: 0xdca93e,
      rind: 0x2c251c,
      vein: [0.95, 0.22, 0.08],
      veinStrength: 0.7,
    },
    fishMayEnter: true,
  },
  {
    id: "bulwark",
    label: "the bulwark",
    placement: {
      mode: "shell",
      radius: 80,
      count: 18,
      perDifficulty: 2,
      ...COLOSSAL,
    },
    sizeBase: 44,
    sizeVar: 10,
    res: 48,
    parts: [{ part: "wall-hunk", weight: 1 }],
    // dark burgundy wax — the inner wall
    material: {
      paste: 0xe5b64a,
      rind: 0x5e2a1c,
      vein: [0.95, 0.35, 0.1],
      veinStrength: 0.65,
    },
    fishMayEnter: true,
  },
  {
    id: "galleries",
    label: "the galleries",
    placement: { mode: "band", rMin: 100, rMax: 140, count: 12, guard: 0.5 },
    sizeBase: 22,
    sizeVar: 12,
    res: 48,
    parts: [{ part: "gallery-wheel", weight: 1 }],
    // orange wax cathedrals
    material: {
      paste: 0xeabf58,
      rind: 0xa85e20,
      vein: [1.0, 0.45, 0.1],
      veinStrength: 0.6,
    },
    fishMayEnter: true,
  },
  {
    id: "crust",
    label: "the crust wall",
    placement: {
      mode: "shell",
      radius: 155,
      count: 48,
      perDifficulty: 4,
      ...COLOSSAL,
    },
    sizeBase: 60,
    sizeVar: 12,
    res: 48,
    parts: [{ part: "wall-hunk", weight: 1 }],
    // THE classic: red wax gouda wall
    material: {
      paste: PASTE,
      rind: 0x8e3c22,
      vein: [0.95, 0.62, 0.12],
      veinStrength: 0.6,
    },
    fishMayEnter: true,
  },
  {
    id: "warrens",
    label: "the warrens",
    placement: { mode: "band", rMin: 185, rMax: 225, count: 10, guard: 0.55 },
    sizeBase: 30,
    sizeVar: 8,
    res: 64,
    parts: [{ part: "warren-hunk", weight: 1 }],
    // mouldy green-tinged burrow cheese
    material: {
      paste: 0xd8c266,
      rind: 0x77692f,
      vein: [0.5, 0.72, 0.12],
      veinStrength: 0.55,
    },
    fishMayEnter: true,
  },
  {
    id: "scree",
    label: "the scree",
    placement: { mode: "band", rMin: 230, rMax: 285, count: 44, guard: 0.65 },
    sizeBase: 10,
    sizeVar: 8,
    res: 32,
    parts: [{ part: "cut-block", weight: 1 }],
    // classic yellow gouda blocks
    material: {
      paste: PASTE,
      rind: 0xbd8f2a,
      vein: [0.6, 0.62, 0.12],
      veinStrength: 0.5,
    },
    fishMayEnter: true,
  },
  {
    id: "chimneys",
    label: "the chimneys",
    placement: { mode: "band", rMin: 285, rMax: 340, count: 14, guard: 0.5 },
    sizeBase: 30,
    sizeVar: 12,
    res: 48,
    parts: [{ part: "smoked-column", weight: 1 }],
    // tall smoked-rind chimneys
    material: {
      paste: 0xe0b955,
      rind: 0x6e4f28,
      vein: [0.7, 0.55, 0.15],
      veinStrength: 0.5,
    },
    fishMayEnter: true,
  },
  {
    id: "reef",
    label: "the reef",
    placement: { mode: "band", rMin: 335, rMax: 385, count: 18, guard: 0.55 },
    sizeBase: 30,
    sizeVar: 14,
    res: 48,
    parts: [{ part: "holey-slab", weight: 1 }],
    // young yellow wax plates
    material: {
      paste: PASTE,
      rind: 0xc79a2f,
      vein: [0.6, 0.6, 0.18],
      veinStrength: 0.45,
    },
    fishMayEnter: true,
  },
  {
    id: "drift",
    label: "the drift",
    placement: { mode: "band", rMin: 388, rMax: 420, count: 12, guard: 1.2 },
    sizeBase: 11,
    sizeVar: 8,
    res: 32,
    parts: [{ part: "cut-block", weight: 1 }],
    // bleached natural rind, ghost-pale
    material: {
      paste: 0xe3cc86,
      rind: 0xb3a06a,
      vein: [0.55, 0.52, 0.2],
      veinStrength: 0.4,
    },
    fishMayEnter: true,
  },
];

export const DEFAULT_WORLD: WorldRecipe = {
  worldR: 420,
  boundaryR: 470,
  goldBand: { min: 60, max: 175 },
  goldMinCavernR: 6,
  debrisCount: 460,
  heartGuard: 0.72,
  parts: DEFAULT_PARTS,
  biomes: DEFAULT_BIOMES,
};

// --- Helpers -------------------------------------------------------------------

export function partById(world: WorldRecipe, id: string): PartRecipe {
  const part = world.parts.find((p) => p.id === id);
  if (!part) throw new Error(`recipes: unknown part "${id}"`);
  return part;
}

// Weighted part pick. Single-entry lists consume NO rng (keeps the seeded
// stream identical to the pre-recipe generator for the default tables).
export function pickPart(
  world: WorldRecipe,
  biome: BiomeRecipe,
  rng: () => number,
): PartRecipe {
  if (biome.parts.length === 1) return partById(world, biome.parts[0].part);
  let total = 0;
  for (const e of biome.parts) total += e.weight;
  let roll = rng() * total;
  for (const e of biome.parts) {
    roll -= e.weight;
    if (roll <= 0) return partById(world, e.part);
  }
  return partById(world, biome.parts[biome.parts.length - 1].part);
}

export function cloneWorld(world: WorldRecipe): WorldRecipe {
  return structuredClone(world);
}
