// recipes.ts — the cheese kit's data tables (M2). Everything the world
// generator consumes as *numbers* lives here as plain, JSON-serializable
// data; gouda.ts owns the SDF/marching-cubes implementations of the shape
// families and reads these tables. No three.js imports — node-testable.
//
// Three levels of recipe:
//   PartRecipe   one kind of cheese chunk (shape family + carve counts/radii
//                + the gameplay axes: hardness / porosity / odour)
//   BiomeRecipe  a zone: placement (band/shell/center/fused/hull), sizes,
//                weighted part list, wax material, budgets, modifiers
//   WorldRecipe  the whole onion: ordered biome list + world-level radii,
//                the anisotropic frame (squash/tilt) and the descent spine
//
// Conventions: carve radii (eyes/pores/tunnels) are in chunk-local units
// where the body surface sits at |p| ≈ 0.6 in a [-1,1] grid — a radius of
// 0.1 on a 40 u chunk is a 4 u cavern. Sizes/radii at biome/world level are
// world units. Biome order in WorldRecipe.biomes IS generation order (the
// seeded rng stream and spacing checks depend on it).
//
// Placement modes come in two families:
//   per-chunk bodies  center | band | shell — each chunk is its own closed
//                     ellipsoid body (the classic onion uses only these)
//   layer bodies      fused | hull — ONE analytic body per biome (a radial
//                     band, or the Great Wheel's rounded-cylinder husk),
//                     meshed by lattice-aligned tiles that abut seamlessly;
//                     tile scale/res come from sizeBase (sizeVar must be 0)
//
// Layer-body radii are measured in the world FRAME: an optional vertical
// squash + tilt that makes the whole onion conform to a wheel's squat
// profile. `spine` seeds the descent route: one through-point per layer
// boundary, each rotated 40–80° from the last and drifting downward — the
// hull's first soft spot sits on it.
//
// The worldgen bench (/worldgen.html) edits live copies of these tables and
// its "copy" buttons dump entries back in this shape — paste them here to
// ship a tuning. The game always plays DEFAULT_WORLD; WHEEL_WORLD is the
// cheese-parts.md MVP map, authored here and tuned in the bench until it
// replaces the default.

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
  | "heart"
  | "great-wheel"
  | "belly"
  | "veins"
  | "melt";

// 0 hands · 1 driller · 2 driller-slow · 3 no-dig
export type Hardness = 0 | 1 | 2 | 3;

export interface PartRecipe {
  id: string;
  label: string;
  kind: PartKind;
  mood: string; // one line: the feel the numbers are chasing
  desc: string; // what it is + what the player does in it
  // Bench default size range (world u). Biomes place at their own sizes.
  size: { min: number; max: number };
  // Gameplay axes (M2.1): read by tools/threat/noise systems, shown in bench.
  hardness: Hardness;
  porosity: number; // 0–1: how much void you can see into it
  odour: number; // 0–1: passive threat pressure; digging multiplies it
  // Surface noise: amp = wax bumpiness, freq = feature scale, depth = how
  // far under the surface the noise band fades out.
  crust: { amp: number; freq: number; depth: number };
  // Eyes: interior caverns/chambers, connected by the tunnel spanning tree.
  eyes: { min: number; max: number; rBase: number; rVar: number };
  coreEye: number; // 0 = none; else one guaranteed central cavern radius
  // Rare oversized rooms (the galleries' authored exception): per chunk/tile,
  // chance of one chamber eye at rBase+.
  chambers?: { chance: number; rBase: number; rVar: number };
  // Pores: small surface holes (slabs use big ones as through-holes).
  pores: { min: number; max: number; rBase: number; rVar: number };
  // bends = tortuosity: 0 straight, 1 winding, 2+ snaking speleology.
  tunnels: { rBase: number; rVar: number; bends: number };
  exits: number; // tunnels from outermost eyes to open water (+0–1 random)
  deadEnds: number; // sealed chambers behind thin marked walls (+1/difficulty)
  narrow: boolean; // tighter minimum tunnel radius
  tangle: boolean; // spanning tree rewires to random earlier eyes
  noCarveWithin?: number; // seal tiles: keep every carve this far (u) from both faces
  tags: string[]; // gameplay tags (air-pocket, seal, hand-carve, maze…)
}

export type BiomePlacement =
  | { mode: "center" } // one chunk at the origin
  | {
      mode: "band"; // scattered through a frame-shell [rMin, rMax]
      rMin: number;
      rMax: number;
      count: number;
      guard: number; // same-zone spacing factor: min gap = (s1+s2)·guard
      densityGrade?: "outward" | "inward"; // bias placement radius (absent = uniform)
    }
  | {
      mode: "shell"; // fused fibonacci wall of ellipsoid chunks (classic)
      radius: number;
      count: number;
      perDifficulty: number; // extra chunks per difficulty step above 1
      colossalEvery: number; // every Nth chunk is a landmark colossus
      colossalBonus: number; // added to size base for colossi
      colossalVar: number;
      colossalRes: number;
    }
  | {
      mode: "fused"; // ONE solid frame-band body, lattice-tiled (K9)
      rMin: number;
      rMax: number;
      warpAmp: number; // low-freq radial warp of both boundaries (world u)
      warpFreq: number; // warp noise frequency (1/world u)
      loopFrac: number; // chance an adjacent tile pair gets a loop tunnel
      sideExits: number; // extra bores from the network to the outer medium
    }
  | {
      mode: "hull"; // ONE closed parametric husk, lattice-tiled (K8)
      surface: "wheel" | "sphere"; // wheel = squat cylinder + rounded rim
      radius: number; // equatorial radius (frame u); wheel height from frame squash
      thickness: number; // husk wall (world u) — a husk, not a fortress
      rim: number; // rim rounding radius (wheel only, world u)
      softSpots: number; // 1–3 weeping bulges; #1 sits on the spine
      softSpotR: number; // bulge radius (world u)
      ridgeAmp: number; // concentric mould-ridge displacement (world u)
      ridgeFreq: number; // ridges per world u of face radius
    };

export interface BiomeMaterial {
  paste: number; // carved interior color (hex)
  rind: number; // outer wax color (hex)
  vein: [number, number, number]; // glow color (linear rgb)
  veinStrength: number;
}

// Seeded per-biome content counts (M3 reads these; data-only today).
export interface BiomeBudgets {
  airPockets: number; // sealed O₂ bubbles
  essence: number; // crystal deposits
  faults: number; // brittle vein lines (roquefort)
  softSpots: number; // seals only — the difficulty dial
}

// Per-biome sensory/physics multipliers (M3 reads these; data-only today).
export interface BiomeModifiers {
  lightRange: number; // ×
  fogDensity: number; // ×
  drag: number; // ×
  soundOcclusion: number; // 0–1
  temperature?: number; // the melt
}

export interface BiomeRecipe {
  id: ZoneName;
  label: string; // build-progress label, e.g. "the hollows"
  mood: string;
  desc: string;
  placement: BiomePlacement;
  sizeBase: number; // chunk scale = sizeBase + rng()·sizeVar (world u);
  sizeVar: number; //   fused/hull tiles use sizeBase alone (sizeVar 0)
  res: number; // marching-cubes grid (32|48|56|64|72|96)
  parts: { part: string; weight: number }[]; // weighted PartRecipe ids
  material: BiomeMaterial;
  fishMayEnter: boolean; // data for the M3 threat pass (unread today)
  budgets?: BiomeBudgets;
  modifiers?: BiomeModifiers;
  airFilled?: boolean; // the melt — no water volume, walk/climb, free O₂
}

// Vertical squash + tilt of the layer metric: bands/fused/hull measure their
// radii in this frame, so the whole onion lies like a squat tilted wheel.
export interface WorldFrameRecipe {
  squash: number; // 1 = spherical layers (the classic onion)
  tiltDeg: number;
}

// The descent route: one seeded through-point per layer boundary, stepping
// 40–80° around and drifting downward (D19). Soft spot #1 rides it.
export interface SpineRecipe {
  stepDeg: { min: number; max: number };
  drift: number; // 0–1 downward bias per step
}

export interface WorldRecipe {
  worldR: number; // outer edge of the outermost band
  boundaryR: number; // visible boundary veil radius
  goldBand: { min: number; max: number }; // gold host radial band (frame u)
  goldMinCavernR: number; // smallest cavern (world u) that may hide it
  debrisCount: number; // free-floating crumbs
  heartGuard: number; // spacing factor of every chunk vs the heart
  frame?: WorldFrameRecipe; // absent = identity (classic onion)
  spine?: SpineRecipe; // absent = no authored descent route
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
    mood: "a grand hollow throne room — and a lie",
    desc: "The colossal centerpiece hunk. Cathedral caverns around a huge core chamber, riddled with exits. The compass points here, the gold does not.",
    size: { min: 48, max: 64 },
    hardness: 1,
    porosity: 0.6,
    odour: 0.4,
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
    mood: "tight, black-waxed, too close to the middle",
    desc: "Small aged wheels crowding the approach: modest chambers, many mouths, quick to cross and easy to lose your bearing in.",
    size: { min: 14, max: 21 },
    hardness: 1,
    porosity: 0.45,
    odour: 0.35,
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
    mood: "vaulted orange halls, generous and echoing",
    desc: "Big wheels with few, huge chambers and wide corridors — the one place hauling feels easy, which is why it sits mid-run.",
    size: { min: 22, max: 34 },
    hardness: 1,
    porosity: 0.55,
    odour: 0.3,
    crust: { amp: 0.08, freq: 1.6, depth: 0.22 },
    eyes: { min: 6, max: 9, rBase: 0.16, rVar: 0.12 },
    coreEye: 0,
    pores: { min: 10, max: 18, rBase: 0.055, rVar: 0.075 },
    tunnels: { rBase: 0.08, rVar: 0.04, bends: 1 },
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
    mood: "a fortress brick pretending to be food",
    desc: "Giant fused hunks that make up the sealed walls. Passable only through their own tunnel complexes; the radial through-route is the door.",
    size: { min: 44, max: 72 },
    hardness: 2,
    porosity: 0.35,
    odour: 0.25,
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
    mood: "speleology — long, tangled, shoulder-width",
    desc: "Burrow cheese: many small chambers strung on narrow snaking tunnels that rewire into each other. Easy in, disorienting out.",
    size: { min: 30, max: 38 },
    hardness: 1,
    porosity: 0.5,
    odour: 0.4,
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
    mood: "harmless rubble, sea-glass edges",
    desc: "Small tumbling blocks with a couple of hollows each. Debris you weave between — nothing here is a wall.",
    size: { min: 10, max: 18 },
    hardness: 0,
    porosity: 0.3,
    odour: 0.1,
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
    mood: "a curtain you thread, not a door you open",
    desc: "Thin plates riddled with big through-holes. The reef stacks them into fields you weave between and through.",
    size: { min: 30, max: 44 },
    hardness: 0,
    porosity: 0.7,
    odour: 0.15,
    crust: { amp: 0.04, freq: 1.6, depth: 0.22 },
    eyes: { min: 2, max: 4, rBase: 0.1, rVar: 0.08 },
    coreEye: 0,
    pores: { min: 14, max: 20, rBase: 0.08, rVar: 0.09 },
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
    mood: "tall dark stacks, a burnt-rind forest",
    desc: "Chimney columns with a few stacked chambers. Landmarks first, shelter second.",
    size: { min: 30, max: 42 },
    hardness: 1,
    porosity: 0.4,
    odour: 0.3,
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

// --- MVP part table (cheese-parts.md §3 — the six) -----------------------------

export const MVP_PARTS: PartRecipe[] = [
  {
    id: "drift-crumb",
    label: "drift crumb",
    kind: "block",
    mood: "bleached, harmless, tumbling in the current",
    desc: "Centuries-dead cheese gone chalky grey-white. Small blocks far enough apart that you always see between them — nothing here is a wall. The player orients, finds the driller, learns cheese can be punched through.",
    size: { min: 8, max: 16 },
    hardness: 0,
    porosity: 0.3,
    odour: 0,
    crust: { amp: 0.05, freq: 1.8, depth: 0.2 },
    eyes: { min: 1, max: 3, rBase: 0.09, rVar: 0.06 },
    coreEye: 0,
    pores: { min: 6, max: 10, rBase: 0.05, rVar: 0.03 },
    tunnels: { rBase: 0.06, rVar: 0.02, bends: 0 },
    exits: 2,
    deadEnds: 0,
    narrow: false,
    tangle: false,
    tags: ["hand-carve"],
  },
  {
    id: "dark-rind",
    label: "dark rind",
    kind: "slab",
    mood: "the one gate — near-black, smooth by law",
    desc: "The Great Wheel's husk: a few metres of aged natural rind and nothing behind it but black water. No wax, no lumps — its identity is colour, mould ridges and cloth weave. Hard cap: crust.amp × size < thickness/3.",
    size: { min: 40, max: 60 },
    hardness: 3,
    porosity: 0,
    odour: 0.2,
    crust: { amp: 0.018, freq: 1.2, depth: 0.3 },
    eyes: { min: 0, max: 0, rBase: 0, rVar: 0 },
    coreEye: 0,
    pores: { min: 0, max: 0, rBase: 0, rVar: 0 },
    tunnels: { rBase: 0, rVar: 0, bends: 0 },
    exits: 0,
    deadEnds: 0,
    narrow: false,
    tangle: false,
    noCarveWithin: 2,
    tags: ["seal"],
  },
  {
    id: "roquefort",
    label: "roquefort",
    kind: "hunk",
    mood: "light-eating blue paste — follow the veins or drill blind",
    desc: "Fused blue-grey paste where your lamp reaches a third as far. The glowing vein network is the only visible thing and the only hand-diggable line. Dead ends are the point.",
    size: { min: 20, max: 30 },
    hardness: 1,
    porosity: 0.4,
    odour: 0.5,
    crust: { amp: 0.07, freq: 1.6, depth: 0.22 },
    eyes: { min: 8, max: 14, rBase: 0.07, rVar: 0.04 },
    coreEye: 0,
    pores: { min: 0, max: 2, rBase: 0.03, rVar: 0.02 },
    tunnels: { rBase: 0.05, rVar: 0.015, bends: 2 },
    exits: 2,
    deadEnds: 4,
    narrow: false,
    tangle: false,
    tags: ["fault", "dark", "hand-carve"],
  },
  {
    id: "fondue",
    label: "fondue",
    kind: "hunk",
    mood: "wet orange heat — the last generous air in the run",
    desc: "Vent-cooked soft cheese, air-filled: steam-pocketed chambers, ropes of melt off the ceiling, cooled floes underfoot. Breathe, talk, read the ceiling — then drown in silence one layer down.",
    size: { min: 20, max: 24 },
    hardness: 1,
    porosity: 0.65,
    odour: 0.8,
    crust: { amp: 0.09, freq: 1.4, depth: 0.3 },
    eyes: { min: 6, max: 10, rBase: 0.16, rVar: 0.06 },
    coreEye: 0.25,
    pores: { min: 4, max: 8, rBase: 0.05, rVar: 0.02 },
    tunnels: { rBase: 0.075, rVar: 0.02, bends: 1 },
    exits: 3,
    deadEnds: 2,
    narrow: false,
    tangle: false,
    tags: ["air-pocket", "hot", "hand-carve"],
  },
  {
    id: "mite-bore",
    label: "mite-bored paste",
    kind: "hunk",
    mood: "not a cave system — a sponge",
    desc: "One colossal tan mass bored into thousands of one-rat holes that open into rooms and close again. Every surface looks the same in every direction. Cargo clearance is 0.3 u negative on purpose — hauling out is the climax.",
    size: { min: 16, max: 20 },
    hardness: 1,
    porosity: 0.5,
    odour: 0.15,
    crust: { amp: 0.05, freq: 2.0, depth: 0.18 },
    eyes: { min: 26, max: 34, rBase: 0.06, rVar: 0.02 },
    coreEye: 0,
    chambers: { chance: 0.12, rBase: 0.25, rVar: 0.08 },
    pores: { min: 0, max: 2, rBase: 0.03, rVar: 0.01 },
    tunnels: { rBase: 0.055, rVar: 0.012, bends: 3 },
    exits: 1,
    deadEnds: 5,
    narrow: true,
    tangle: true,
    tags: ["narrow", "maze"],
  },
  {
    id: "fresh-curd",
    label: "fresh curd",
    kind: "hunk",
    mood: "alive in a map made of corpses",
    desc: "White, wet, faintly luminous, still being made. One chamber at the centre, the last air pocket, and the Golden Gouda in it. The drag modifier makes the first thirty seconds of the ascent the worst movement in the game.",
    size: { min: 48, max: 64 },
    hardness: 0,
    porosity: 0.6,
    odour: 0.4,
    crust: { amp: 0.1, freq: 1.3, depth: 0.28 },
    eyes: { min: 14, max: 20, rBase: 0.1, rVar: 0.14 },
    coreEye: 0.34,
    pores: { min: 4, max: 8, rBase: 0.04, rVar: 0.02 },
    tunnels: { rBase: 0.07, rVar: 0.02, bends: 1 },
    exits: 5,
    deadEnds: 3,
    narrow: false,
    tangle: false,
    tags: ["landmark", "sticky", "hand-carve"],
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
    mood: "the throne room the compass lies about",
    desc: "One colossal hunk at dead centre — a grand cavern, a landmark, a decoy. The gold is never here.",
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
    mood: "cramped, black-waxed, breath held",
    desc: "The tight approach ring of small aged wheels just outside the heart.",
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
    mood: "the second wall — tighter, meaner",
    desc: "An inner shell of fused wall hunks; the only ways through are their own tunnel complexes.",
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
    mood: "vaulted halls, orange wax, easy hauling",
    desc: "Cathedral wheels between the walls: huge chambers, wide corridors, a breather with teeth.",
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
    mood: "THE red wall on the horizon",
    desc: "The first sealed wall: many giant fused red-wax hunks, passable only through their tunnels.",
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
    mood: "mouldy burrows, shoulder-width dark",
    desc: "The speleology belt: long tangled narrow tunnels through green-tinged hunks.",
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
    mood: "a rubble belt of honest yellow cheese",
    desc: "Dense field of small cut blocks — cover, snacks, and sightline clutter.",
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
    mood: "a drowned forest of smoked stacks",
    desc: "Tall smoked-rind columns; the first vertical landmarks on the way down.",
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
    mood: "curtains of young cheese, holes for days",
    desc: "Fields of thin slabs with big through-holes — weave between and through the plates.",
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
    mood: "ghost-pale silhouettes resolving out of fog",
    desc: "Sparse bleached blocks at the world's edge — the first shapes a new diver sees.",
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

// --- The Great Wheel world (cheese-parts.md §5 — the MVP map) ------------------
//
// OPEN WATER → DRIFT → ▮ THE GREAT WHEEL ▮ → THE DARK VEINS → THE MELT →
// THE GALLERIES ◉. One seal, five stops. Frame squash 0.45 lays every layer
// flat inside the wheel; the spine threads soft spot → veins → melt →
// galleries → heart.

export const WHEEL_BIOMES: BiomeRecipe[] = [
  {
    id: "heart",
    label: "the heart",
    mood: "alive in a map made of corpses",
    desc: "One fresh-curd chamber at dead centre, the last air pocket, and the Golden Gouda in it. Everything else in the abyss is aged; this is still being made.",
    placement: { mode: "center" },
    sizeBase: 52,
    sizeVar: 0,
    res: 96,
    parts: [{ part: "fresh-curd", weight: 1 }],
    // white, wet, faintly luminous
    material: {
      paste: 0xf7f0dc,
      rind: 0xe6d9b8,
      vein: [1.0, 0.92, 0.62],
      veinStrength: 0.95,
    },
    fishMayEnter: true,
    budgets: { airPockets: 1, essence: 0, faults: 0, softSpots: 0 },
    modifiers: {
      lightRange: 1.1,
      fogDensity: 0.9,
      drag: 1.6,
      soundOcclusion: 0.5,
    },
  },
  {
    id: "galleries",
    label: "the galleries",
    mood: "not a cave system — a sponge",
    desc: "The Gouda's shell: one tan mass mite-bored into thousands of holes, rooms, and dead ends. Carrying the Gouda back out through this is the climax of the run.",
    placement: {
      mode: "fused",
      rMin: 8,
      rMax: 50,
      warpAmp: 4,
      warpFreq: 0.035,
      loopFrac: 0.3,
      sideExits: 0,
    },
    sizeBase: 18,
    sizeVar: 0,
    res: 72,
    parts: [{ part: "mite-bore", weight: 1 }],
    // warm mid-tan, dry, matte
    material: {
      paste: 0xdcb571,
      rind: 0xb9924e,
      vein: [0.72, 0.55, 0.28],
      veinStrength: 0.12,
    },
    fishMayEnter: true,
    budgets: { airPockets: 1, essence: 14, faults: 0, softSpots: 0 },
    modifiers: { lightRange: 1, fogDensity: 1.1, drag: 1, soundOcclusion: 0.8 },
  },
  {
    id: "melt",
    label: "the melt",
    mood: "wet orange heat — the last generous air",
    desc: "Vent-cooked and air-filled: molten gold sheeting off the ceiling, cooled floes underfoot, steam instead of fog. The crew arrives topped up and talking — then the galleries are dark, silent and drowning.",
    placement: {
      mode: "fused",
      rMin: 46,
      rMax: 94,
      warpAmp: 5,
      warpFreq: 0.03,
      loopFrac: 0.4,
      sideExits: 0,
    },
    sizeBase: 22,
    sizeVar: 0,
    res: 72,
    parts: [{ part: "fondue", weight: 1 }],
    // molten orange-gold over crusted amber
    material: {
      paste: 0xf59b2c,
      rind: 0x9a5a1a,
      vein: [1.0, 0.52, 0.1],
      veinStrength: 1.15,
    },
    fishMayEnter: false,
    airFilled: true,
    budgets: { airPockets: 8, essence: 8, faults: 4, softSpots: 0 },
    modifiers: {
      lightRange: 1.4,
      fogDensity: 0.6,
      drag: 1,
      soundOcclusion: 0.2,
      temperature: 1,
    },
  },
  {
    id: "veins",
    label: "the dark veins",
    mood: "follow the veins or drill blind",
    desc: "The first biome inside the gate. Fused roquefort that eats light — the glowing vein graph is the only visible thing and the only hand-diggable line.",
    placement: {
      mode: "fused",
      rMin: 88,
      rMax: 150,
      warpAmp: 4,
      warpFreq: 0.025,
      loopFrac: 0.25,
      sideExits: 1,
    },
    sizeBase: 25,
    sizeVar: 0,
    res: 72,
    parts: [{ part: "roquefort", weight: 1 }],
    // near-black paste, cold blue-grey, blue-green glow
    material: {
      paste: 0x424a5e,
      rind: 0x1f2229,
      vein: [0.2, 0.95, 0.72],
      veinStrength: 1.35,
    },
    fishMayEnter: true,
    budgets: { airPockets: 2, essence: 10, faults: 14, softSpots: 0 },
    modifiers: {
      lightRange: 0.35,
      fogDensity: 2.5,
      drag: 1.25,
      soundOcclusion: 0.6,
    },
  },
  {
    id: "belly",
    label: "the flooded belly",
    mood: "eighty metres of black water and old bones",
    desc: "Inside the husk: re-seeded drift crumb, larger and darker, thick against the inner wall and thinning toward the middle so the crossing is a descent, not a void.",
    placement: {
      mode: "band",
      rMin: 152,
      rMax: 226,
      count: 60,
      guard: 0.45,
      densityGrade: "outward",
    },
    sizeBase: 16,
    sizeVar: 22,
    res: 32,
    parts: [{ part: "drift-crumb", weight: 1 }],
    // the drift gone dark
    material: {
      paste: 0xcdbf96,
      rind: 0x776a4e,
      vein: [0.4, 0.42, 0.3],
      veinStrength: 0.2,
    },
    fishMayEnter: true,
    budgets: { airPockets: 3, essence: 4, faults: 0, softSpots: 0 },
    modifiers: {
      lightRange: 0.8,
      fogDensity: 1.3,
      drag: 1,
      soundOcclusion: 0.4,
    },
  },
  {
    id: "great-wheel",
    label: "the Great Wheel",
    mood: "a horizon that doesn't stop",
    desc: "The one gate: a district-sized wheel aged black and eaten hollow — six metres of crust and nothing behind it. Two weeping soft spots are the only doors; the first sits on the spine.",
    placement: {
      mode: "hull",
      surface: "wheel",
      radius: 233,
      thickness: 6,
      rim: 26,
      softSpots: 2,
      softSpotR: 8,
      ridgeAmp: 0.5,
      ridgeFreq: 0.5,
    },
    sizeBase: 46,
    sizeVar: 0,
    res: 48,
    parts: [{ part: "dark-rind", weight: 1 }],
    // near-black natural rind over pale straw paste
    material: {
      paste: 0xe8d9a8,
      rind: 0x241c14,
      vein: [0.55, 0.5, 0.4],
      veinStrength: 0.18,
    },
    fishMayEnter: false,
    budgets: { airPockets: 0, essence: 0, faults: 0, softSpots: 2 },
    modifiers: { lightRange: 1, fogDensity: 1, drag: 1, soundOcclusion: 1 },
  },
  {
    id: "drift",
    label: "the drift",
    mood: "bleached, harmless, tumbling",
    desc: "Chalky grey-white blocks in the open current. The Wheel resolves out of the fog behind them as a horizon that doesn't stop — and the driller's wreck is out here somewhere.",
    placement: { mode: "band", rMin: 240, rMax: 300, count: 120, guard: 1.0 },
    sizeBase: 9,
    sizeVar: 7,
    res: 32,
    parts: [{ part: "drift-crumb", weight: 1 }],
    // bone and ash, matte
    material: {
      paste: 0xe9e2cb,
      rind: 0xc9bd9d,
      vein: [0.5, 0.5, 0.42],
      veinStrength: 0.15,
    },
    fishMayEnter: true,
    budgets: { airPockets: 4, essence: 6, faults: 0, softSpots: 0 },
    modifiers: { lightRange: 1, fogDensity: 1, drag: 1, soundOcclusion: 0 },
  },
];

export const WHEEL_WORLD: WorldRecipe = {
  worldR: 420,
  boundaryR: 470,
  goldBand: { min: 0, max: 12 },
  goldMinCavernR: 6,
  debrisCount: 240,
  heartGuard: 0.72,
  frame: { squash: 0.45, tiltDeg: 16 },
  spine: { stepDeg: { min: 40, max: 80 }, drift: 0.5 },
  parts: [...MVP_PARTS],
  biomes: WHEEL_BIOMES,
};

// The bench's world registry: which table set is being edited/previewed.
export const WORLDS: Record<string, WorldRecipe> = {
  onion: DEFAULT_WORLD,
  wheel: WHEEL_WORLD,
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

export const VALID_RES = [32, 48, 56, 64, 72, 96];

// Seed-time rules (plan-mvp §M2.4): violations that would generate a broken
// world. The generator refuses to build while any of these hold; the bench
// shows them live. Soft authorial choices (cargo clearance) are NOT here.
export function validateWorld(world: WorldRecipe): string[] {
  const errors: string[] = [];
  for (const biome of world.biomes) {
    const pl = biome.placement;
    if (!VALID_RES.includes(biome.res))
      errors.push(`${biome.id}: res ${biome.res} is not a marching-cubes size`);
    if (pl.mode === "fused" || pl.mode === "hull") {
      if (biome.sizeVar !== 0)
        errors.push(`${biome.id}: ${pl.mode} tiles need sizeVar 0`);
      if (biome.sizeBase < 8)
        errors.push(`${biome.id}: tile size ${biome.sizeBase} too small`);
    }
    if (pl.mode === "fused" && pl.rMin >= pl.rMax)
      errors.push(`${biome.id}: fused band ${pl.rMin}–${pl.rMax} not ordered`);
    if (pl.mode === "band" && pl.rMin >= pl.rMax)
      errors.push(`${biome.id}: band ${pl.rMin}–${pl.rMax} not ordered`);
    if (pl.mode === "hull") {
      for (const entry of biome.parts) {
        const part = world.parts.find((p) => p.id === entry.part);
        if (part && part.crust.amp * biome.sizeBase >= pl.thickness / 3)
          errors.push(
            `${biome.id}: crust.amp ${part.crust.amp} × tile ${biome.sizeBase} ` +
              `≥ thickness ${pl.thickness}/3 — the husk would be lace ` +
              `(cap: ${(pl.thickness / 3 / biome.sizeBase).toFixed(3)})`,
          );
      }
      if (pl.softSpots < 0 || pl.softSpots > 3)
        errors.push(`${biome.id}: softSpots must be 0–3`);
    }
  }
  if (world.frame && (world.frame.squash <= 0.1 || world.frame.squash > 1))
    errors.push(`frame.squash ${world.frame.squash} outside (0.1, 1]`);
  return errors;
}
