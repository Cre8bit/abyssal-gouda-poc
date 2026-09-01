// recipes.ts — the cheese kit's data tables (M2). Everything the world
// generator consumes as *numbers* lives here as plain, JSON-serializable
// data; gouda.ts owns the SDF/marching-cubes implementations of the shape
// families and reads these tables. No three.js imports — node-testable.
//
// Three levels of recipe:
//   PartRecipe   one kind of cheese chunk (shape family + carve counts/radii
//                + the hardness gameplay axis + mood/desc authoring text)
//   BiomeRecipe  a zone: placement (band/center/fused/hull), sizes,
//                weighted part list, wax material, budgets, modifiers
//   WorldRecipe  the whole map: ordered biome list + world-level radii,
//                the anisotropic frame (squash/tilt) and the descent spine
//
// Conventions: carve radii (eyes/pores/tunnels) are in chunk-local units
// where the body surface sits at |p| ≈ 0.6 in a [-1,1] grid — a radius of
// 0.1 on a 40 u chunk is a 4 u cavern. Sizes/radii at biome/world level are
// world units. Biome order in WorldRecipe.biomes IS generation order (the
// seeded rng stream, cross-biome guards, the sightline trail anchors and the
// melt-shell entrance terminus all depend on it).
//
// Placement modes come in two families:
//   per-chunk bodies  center | band — each chunk is its own closed
//                     ellipsoid body; band supports density/size grading
//                     and sightline-chained placement (the vein trail)
//   layer bodies      fused | hull — ONE analytic body per biome (a radial
//                     band, or a hull husk: the Great Wheel's rounded
//                     cylinder, the melt shell's sphere), meshed by
//                     lattice-aligned tiles that abut seamlessly; tile
//                     scale/res come from sizeBase (sizeVar must be 0)
//
// Layer-body radii are measured in the world FRAME: an optional vertical
// squash + tilt that makes the whole layer stack conform to a wheel's squat
// profile. `spine` seeds the descent route: one through-point per layer
// boundary, each rotated 40–80° from the last and drifting downward — the
// Great Wheel's first soft spot sits on it.
//
// The worldgen bench (/worldgen.html) edits live copies of these tables and
// its "copy" buttons dump entries back in this shape — paste them here to
// ship a tuning. The game plays WHEEL_WORLD, the six-biome cheese-parts.md
// map: two seals (the drilled Great Wheel, the found melt shell), one route.

export type PartKind = "wheel" | "hunk" | "block" | "slab" | "column";

export type ZoneName =
  | "drift"
  | "great-wheel"
  | "veins"
  | "melt-shell"
  | "melt"
  | "galleries"
  | "heart";

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
  hardness: Hardness; // what tool opens it (cheese-parts §1)
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
      sizeGrade?: "outward" | "inward"; // size tracks band position (WG-06)
      sightline?: boolean; // chain each chunk within sight of the last (WG-07)
      rotate?: { degPerSec: number }; // slow seeded tumble; per-chunk axis + signed rate (WG-12)
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
      softSpots: number; // 0–3 weeping bulges; #1 sits on the spine; 0 = sealed for good
      softSpotR: number; // bulge radius (world u)
      entrance?: { r: number }; // ONE generator-carved hidden bore (WG-08, melt shell)
      ridgeAmp: number; // concentric mould-ridge displacement (world u)
      ridgeFreq: number; // ridges per world u of face radius
    };

export interface BiomeMaterial {
  paste: number; // carved interior color (hex)
  rind: number; // outer wax color (hex)
  vein: [number, number, number]; // glow color (linear rgb)
  veinStrength: number;
  // WG-13: glow rides the baked edge-curvature attribute (silhouette rims,
  // carve mouths) instead of the interior noise patches — the dark veins.
  edgeVeins?: boolean;
}

// Seeded per-biome content counts (WG-11 places them; data-only today).
export interface BiomeBudgets {
  airPockets: number; // breathable O₂ bubbles seeded inside carved voids
  softSpots: number; // seals only — the difficulty dial
  hazards?: { meltFalls: number; meltPools: number; vents: number }; // the melt
}

// Per-biome sensory/physics multipliers (M3 reads these; data-only today).
export interface BiomeModifiers {
  lightRange: number; // ×
  fogDensity: number; // ×
  drag: number; // ×
  soundOcclusion: number; // 0–1
  temperature?: number; // the melt — hot water, not a medium change
}

export interface BiomeRecipe {
  id: ZoneName;
  label: string; // build-progress label, e.g. "the galleries"
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
}

// Vertical squash + tilt of the layer metric: bands/fused/hull measure their
// radii in this frame, so the whole layer stack lies like a squat tilted wheel.
export interface WorldFrameRecipe {
  squash: number; // 1 = spherical layers
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
  frame?: WorldFrameRecipe; // absent = identity
  spine?: SpineRecipe; // absent = no authored descent route
  parts: PartRecipe[];
  biomes: BiomeRecipe[]; // generation order (see header) — outermost LAST
}

// --- The seven parts (cheese-parts.md §2) --------------------------------------

export const MVP_PARTS: PartRecipe[] = [
  {
    id: "emmental-drift",
    label: "emmental drift",
    kind: "block",
    mood: "bleached, harmless, tumbling in the current",
    desc: "Centuries-dead Emmental gone chalky bone-white, riddled with the big round holes the cheese is named for. Air pockets hide inside some of them — the biome that teaches cheese has an inside.",
    size: { min: 8, max: 18 },
    hardness: 0,
    crust: { amp: 0.05, freq: 1.8, depth: 0.2 },
    eyes: { min: 2, max: 4, rBase: 0.18, rVar: 0.06 },
    coreEye: 0,
    pores: { min: 4, max: 8, rBase: 0.06, rVar: 0.03 },
    tunnels: { rBase: 0.07, rVar: 0.02, bends: 0 },
    exits: 2,
    deadEnds: 0,
    narrow: false,
    tangle: false,
    tags: ["hand-carve", "air-pocket"],
  },
  {
    id: "dark-rind",
    label: "dark rind",
    kind: "slab",
    mood: "the first gate — near-black, smooth by law",
    desc: "The Great Wheel's husk: six metres of aged natural rind and nothing behind it but black water. No wax, no lumps — its identity is colour, mould ridges and cloth weave. Hard cap: crust.amp × size < thickness/3.",
    size: { min: 40, max: 60 },
    hardness: 3,
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
    id: "roquefort-float",
    label: "roquefort float",
    kind: "hunk",
    mood: "light-eating blue floats — trust the veins",
    desc: "Floating Roquefort in pitch-black water. The glowing blue mold veining on the edges is the only information in the world; the trail of glows from chunk to chunk IS the navigation.",
    size: { min: 10, max: 40 },
    hardness: 1,
    crust: { amp: 0.07, freq: 1.6, depth: 0.22 },
    eyes: { min: 3, max: 6, rBase: 0.08, rVar: 0.03 },
    coreEye: 0,
    pores: { min: 0, max: 2, rBase: 0.03, rVar: 0.02 },
    tunnels: { rBase: 0.06, rVar: 0.015, bends: 1 },
    exits: 2,
    deadEnds: 1,
    narrow: false,
    tangle: false,
    tags: ["dark", "landmark", "edge-veins"],
  },
  {
    id: "melt-rind",
    label: "melt rind",
    kind: "slab",
    mood: "the second gate — scorched, vitrified, undrillable",
    desc: "The outer crust of the central cheese body that contains everything from the Melt inward. Hardness 3 with no soft spot: the only way in is the single hidden entrance the vein trail leads to.",
    size: { min: 16, max: 40 },
    hardness: 3,
    crust: { amp: 0.02, freq: 1.4, depth: 0.3 },
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
    id: "fondue",
    label: "fondue",
    kind: "hunk",
    mood: "hot orange cathedrals — volume, not geometry",
    desc: "Massive superheated caverns 25–40 u across joined by short wide throats. The one place you can see the far wall and every teammate at once — and every hazard is telegraphed, on a rhythm.",
    size: { min: 28, max: 34 },
    hardness: 1,
    crust: { amp: 0.09, freq: 1.4, depth: 0.3 },
    eyes: { min: 3, max: 5, rBase: 0.34, rVar: 0.08 },
    coreEye: 0.45,
    pores: { min: 4, max: 8, rBase: 0.05, rVar: 0.02 },
    tunnels: { rBase: 0.11, rVar: 0.02, bends: 1 },
    exits: 3,
    deadEnds: 0,
    narrow: false,
    tangle: false,
    tags: ["hot", "open"],
  },
  {
    id: "mite-bore",
    label: "mite-bored paste",
    kind: "hunk",
    mood: "not a cave system — a sponge",
    desc: "One colossal tan mass bored into thousands of one-rat holes that open into spherical gathering rooms and close again. Cargo clearance is 0.3 u negative on purpose — hauling out is the climax.",
    size: { min: 16, max: 20 },
    hardness: 1,
    crust: { amp: 0.05, freq: 2.0, depth: 0.18 },
    eyes: { min: 26, max: 34, rBase: 0.06, rVar: 0.02 },
    coreEye: 0,
    chambers: { chance: 0.12, rBase: 0.28, rVar: 0.03 },
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
    desc: "One single luminous chamber at the exact centre, still being made: the last air pocket in the game, and the Golden Gouda in it. Breathe. Take it. Realise the map now runs in reverse.",
    size: { min: 36, max: 44 },
    hardness: 0,
    crust: { amp: 0.1, freq: 1.3, depth: 0.28 },
    eyes: { min: 2, max: 4, rBase: 0.1, rVar: 0.04 },
    coreEye: 0.5,
    pores: { min: 4, max: 8, rBase: 0.04, rVar: 0.02 },
    tunnels: { rBase: 0.07, rVar: 0.02, bends: 1 },
    exits: 2,
    deadEnds: 0,
    narrow: false,
    tangle: false,
    tags: ["landmark", "air-pocket"],
  },
];

// --- The six-biome map (cheese-parts.md §3) ------------------------------------
//
// OPEN WATER → THE DRIFT → ▮ GREAT WHEEL ▮ → THE DARK VEINS → ▮ MELT SHELL ▮
// → THE MELT → THE GALLERIES → THE HEART ◉. Two seals, opened two ways: the
// Wheel is DRILLED at a soft spot, the shell is FOUND (the vein trail ends at
// its one hidden entrance). Generation order (this array) is a contract:
// great-wheel BEFORE veins (its soft spots anchor the sightline trail),
// melt-shell AFTER veins (its entrance sits at the trail terminus).

export const WHEEL_BIOMES: BiomeRecipe[] = [
  {
    id: "heart",
    label: "the heart",
    mood: "alive in a map made of corpses",
    desc: "One fresh-curd chamber at dead centre, the last air pocket, and the Golden Gouda in it. Everything else in the abyss is aged; this is still being made.",
    placement: { mode: "center" },
    sizeBase: 40,
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
    budgets: { airPockets: 1, softSpots: 0 },
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
    desc: "The Gouda's shell: one tan mass mite-bored into thousands of squeezes, spherical gathering rooms, and dead ends. Carrying the Gouda back out through this is the climax of the run.",
    placement: {
      mode: "fused",
      rMin: 8,
      rMax: 46,
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
    budgets: { airPockets: 0, softSpots: 0 },
    modifiers: { lightRange: 1, fogDensity: 1.1, drag: 1, soundOcclusion: 0.8 },
  },
  {
    id: "melt",
    label: "the melt",
    mood: "wet orange heat on a rhythm",
    desc: "The Fondue Cathedral: hot orange-lit caverns of superheated water, melt falls off the ceilings, crusting pools, thermal vents — all telegraphed, all cyclic. Built to be crossed together.",
    placement: {
      mode: "fused",
      rMin: 46,
      rMax: 88,
      warpAmp: 5,
      warpFreq: 0.03,
      loopFrac: 0.4,
      sideExits: 0,
    },
    sizeBase: 30,
    sizeVar: 0,
    res: 64,
    parts: [{ part: "fondue", weight: 1 }],
    // molten orange-gold over crusted amber
    material: {
      paste: 0xf59b2c,
      rind: 0x9a5a1a,
      vein: [1.0, 0.52, 0.1],
      veinStrength: 1.15,
    },
    fishMayEnter: false,
    budgets: {
      airPockets: 0,
      softSpots: 0,
      hazards: { meltFalls: 12, meltPools: 6, vents: 8 },
    },
    modifiers: {
      lightRange: 1.4,
      fogDensity: 0.6,
      drag: 1,
      soundOcclusion: 0.2,
      temperature: 1,
    },
  },
  {
    id: "great-wheel",
    label: "the Great Wheel",
    mood: "a horizon that doesn't stop",
    desc: "The first gate: a district-sized wheel aged black and eaten hollow — six metres of crust and nothing behind it. The weeping soft spots are the only doors; the first sits on the spine.",
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
    budgets: { airPockets: 0, softSpots: 2 },
    modifiers: { lightRange: 1, fogDensity: 1, drag: 1, soundOcclusion: 1 },
  },
  {
    id: "veins",
    label: "the dark veins",
    mood: "follow the glows or swim blind",
    desc: "Everything inside the Wheel down to the melt shell: a vast pitch-black scatter of floating Roquefort. The edge-glow trail spirals inward, chunk to chunk, and ends at the shell's one hidden entrance.",
    placement: {
      mode: "band",
      rMin: 100,
      rMax: 226,
      count: 90,
      // ≥ scatterSurfaceRadius(roquefort-float): interpenetrating scatter
      guard: 0.8,
      densityGrade: "inward",
      sizeGrade: "inward",
      sightline: true,
      rotate: { degPerSec: 1.2 },
    },
    sizeBase: 10,
    sizeVar: 30,
    res: 56,
    parts: [{ part: "roquefort-float", weight: 1 }],
    // near-black paste, cold blue-grey, blue-green glow on the edges
    material: {
      paste: 0x424a5e,
      rind: 0x1f2229,
      vein: [0.2, 0.95, 0.72],
      veinStrength: 1.35,
      edgeVeins: true,
    },
    fishMayEnter: true,
    budgets: { airPockets: 0, softSpots: 0 },
    modifiers: {
      lightRange: 0.25,
      fogDensity: 3,
      drag: 1.25,
      soundOcclusion: 0.6,
    },
  },
  {
    id: "melt-shell",
    label: "the melt shell",
    mood: "an impenetrable scorched crust",
    desc: "The second seal: vitrified rind around everything from the Melt inward, undrillable everywhere. One recessed, angled entrance at the vein trail's terminus — found, never dug.",
    placement: {
      mode: "hull",
      surface: "sphere",
      radius: 91,
      thickness: 5,
      rim: 0,
      softSpots: 0,
      softSpotR: 0,
      entrance: { r: 1.7 },
      ridgeAmp: 0,
      ridgeFreq: 1,
    },
    sizeBase: 20,
    sizeVar: 0,
    res: 48,
    parts: [{ part: "melt-rind", weight: 1 }],
    // dark amber-brown, heat-crazed, warm glow in the cracks
    material: {
      paste: 0xd8862c,
      rind: 0x4a2b16,
      vein: [1.0, 0.45, 0.12],
      veinStrength: 0.5,
    },
    fishMayEnter: false,
    budgets: { airPockets: 0, softSpots: 0 },
    modifiers: { lightRange: 1, fogDensity: 1, drag: 1, soundOcclusion: 0.8 },
  },
  {
    id: "drift",
    label: "the drift",
    mood: "bleached, harmless, tumbling",
    desc: "The Emmental Void: chalky bone-white debris, sparse at the world's edge and clustered thick against the Great Wheel, so the map itself funnels the descent. The driller's wreck is out here.",
    placement: {
      mode: "band",
      rMin: 240,
      rMax: 300,
      count: 120,
      guard: 1.0,
      densityGrade: "inward",
      rotate: { degPerSec: 0.6 },
    },
    sizeBase: 8,
    sizeVar: 10,
    res: 32,
    parts: [{ part: "emmental-drift", weight: 1 }],
    // bone and ash, matte
    material: {
      paste: 0xe9e2cb,
      rind: 0xc9bd9d,
      vein: [0.5, 0.5, 0.42],
      veinStrength: 0.15,
    },
    fishMayEnter: true,
    budgets: { airPockets: 6, softSpots: 0 },
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
  wheel: WHEEL_WORLD,
};

// --- Helpers -------------------------------------------------------------------

export function partById(world: WorldRecipe, id: string): PartRecipe {
  const part = world.parts.find((p) => p.id === id);
  if (!part) throw new Error(`recipes: unknown part "${id}"`);
  return part;
}

// Weighted part pick. Single-entry lists consume NO rng (draw order is part
// of the world format — see the header).
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

// Chunk-local geometry mirrored from gouda.ts so seed-time rules can bound a
// scatter chunk without importing the generator: the ellipsoid surface sits
// at |p| = SURFACE_R0, and makeChunkData draws each half-axis in a per-family
// range.
const SURFACE_R0 = 0.6;
const MAX_ELLIPSOID_AXIS: Record<PartKind, number> = {
  wheel: 1.15,
  hunk: 1.2,
  block: 1.2,
  slab: 1.2,
  column: 1.25,
};

// Widest a chunk's surface can reach, as a fraction of its scale `s`: the
// longest ellipsoid half-axis plus the crust displacement riding on it.
export function scatterSurfaceRadius(part: PartRecipe): number {
  return SURFACE_R0 * MAX_ELLIPSOID_AXIS[part.kind] + part.crust.amp;
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
    if (
      pl.mode === "band" &&
      pl.rotate &&
      (pl.rotate.degPerSec <= 0 || pl.rotate.degPerSec > 4)
    )
      errors.push(
        `${biome.id}: rotate ${pl.rotate.degPerSec}°/s outside (0, 4]`,
      );
    if (pl.mode === "band") {
      // Scatter chunks are independent bodies: shareCarves() refuses to
      // compose ellipsoid pairs, so two that interpenetrate become each
      // other's invisible walls
      for (const entry of biome.parts) {
        const part = world.parts.find((p) => p.id === entry.part);
        if (!part) continue;
        const surf = scatterSurfaceRadius(part);
        if (pl.guard < surf)
          errors.push(
            `${biome.id}: guard ${pl.guard} < ${surf.toFixed(2)} for part ` +
              `"${part.id}" — scatter chunks interpenetrate and their carves ` +
              `do not compose (invisible walls)`,
          );
      }
    }
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
      if (pl.entrance && pl.entrance.r < 1.4)
        errors.push(
          `${biome.id}: entrance r ${pl.entrance.r} < 1.4 — cargo cannot pass`,
        );
    }
  }
  if (world.frame && (world.frame.squash <= 0.1 || world.frame.squash > 1))
    errors.push(`frame.squash ${world.frame.squash} outside (0.1, 1]`);
  return errors;
}
