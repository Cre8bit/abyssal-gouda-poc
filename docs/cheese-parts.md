# Cheese Parts — concepts, parameters and tuning

The authoring companion to `idea-register.md`. This is what you open next to
`/worldgen.html` when you're pushing sliders.

Three things live here:

1. **The arithmetic** — how a slider value becomes a size in metres, and the
   one rule that decides whether a tunnel reads as tight or as a pipe.
2. **The nine part concepts** — what each cheese *is*, and the numbers that
   make it that.
3. **The new fields** the design needs that `recipes.ts` doesn't have yet.

---

## 1. The arithmetic

### Carve radii → world units

Carve radii (`eyes.rBase`, `pores.rBase`, `tunnels.rBase`, `coreEye`) are
chunk-local, on a `[-1,1]` grid where the body surface sits near `|p| ≈ 0.6`.

```
world radius (u) = r × size
```

So `rBase 0.055` on a `size 20` chunk is a **1.1 u** tunnel radius — a 2.2 u
bore.

The clearances that matter, from the constants in `main.ts` and
`goldenGouda.ts`:

| | value | source |
|---|---|---|
| player collision radius | **0.6 u** | `PLAYER_RADIUS` |
| Gouda radius | **0.45 u** | `GOUDA_RADIUS` |
| carve sphere radius | **2.4 u** | `DIG_RADIUS` — see the warning below |
| swim speed cap | 10 u/s | `MAX_SPEED` |

So: **≥ 0.9 u** tunnel radius for a rat to pass with margin, **≥ 1.3 u** to
haul the Gouda held in front. That second number is what decides whether a
route is haulable, and it's the one the labyrinth deliberately sits under.

### ⚠ The dig radius is bigger than the level

`DIG_RADIUS = 2.4` carves a **4.8 u sphere**. That is wider than a mite-bored
tunnel (2.2 u), and roughly the entire thickness of the Great Wheel's crust.
One click currently destroys the biome it's used in, and would punch through
the first seal as though it weren't there.

**Digging has to become per-tool** before any of this is authorable:

| tool | carve radius | notes |
|---|---|---|
| hands | ~0.7 u | shapes a passage without erasing it. Slow, near-silent |
| driller | 2.4 u | the current value. Fast, loud, destructive by design |

That split isn't just a fix — it's the mechanic. Hands *thread*, the driller
*demolishes*, and choosing between them is choosing whether the tunnel you
came through still exists on the way back. (Register X3.)

### The resolution rule — *why nothing feels tight*

Cell size is `size / res`, so the number of marching-cubes cells across a
carve radius is:

```
cells per radius = r × res
```

**It doesn't depend on chunk size.** Below ~4 cells per radius, marching cubes
plus the noise crust rounds the feature into a soft blob: your numerically
narrow tunnel renders as a wide soft pipe.

| | `r × res` | verdict |
|---|---|---|
| warren-hunk today | `0.038 × 64` = **2.4** | blobby — this is the bug |
| minimum for a readable tunnel | **4.0** | |
| comfortable | **5–6** | |

Combine the two and you get the constraint that shapes the whole labyrinth
biome:

```
res ≥ 4 × size / (desired tunnel radius in u)
```

For a 1.1 u tunnel: `size 20 → res ≥ 73` (use 72 or 96). `size 30 → res ≥ 109`,
which isn't in the allowed set. **Claustrophobic cheese must be built from
small chunks at high resolution**, not from big chunks with small numbers.

### Why nothing feels tight — the other two causes

Narrow tunnels are necessary and not sufficient. Three things break enclosure,
and the resolution rule is only one:

- **Chambers.** `eyes: 18–26` at `rBase 0.05` means you surface into a room
  every few metres, and a room resets the feeling. A maze part wants **many
  nodes and no rooms** — eye radius barely above tunnel radius.
- **Exits.** `exits: 2` per chunk plus open water between chunks means daylight
  is never more than a few metres away. A maze formation wants exits only at
  its ends.
- **Water between parts.** The real one. An archipelago of hollow chunks can
  never feel enclosed, however you carve it. This is what the **fused**
  placement mode (K9) is for: overlapping chunks whose interiors connect, with
  no water in between.

### Shell closure

For `N` chunks tiled on a sphere of radius `R`, centre spacing is:

```
spacing ≈ 3.54 × R / √N
```

Neighbouring tiles only touch at all when the chunk *radius* reaches half the
spacing; to survive the noise crust eating the edges you want ~0.8 × spacing.
Since `size` is full width:

```
size ≥ 1.0 × spacing     bare closure, no margin
size ≥ 1.6 × spacing     recommended
```

Never trust this — **verify it** (K10): flood-fill the water volume from the
bell at coarse resolution at seed time. Whatever the fill reaches is the
outer band. If it reaches the centre, the seal leaked. If it reaches no soft
spot, you've sealed the player out. Both cases: thicken, add tiles, reseed.

*(This is how X1 should have been caught: the crust at `R 155, count 48` has a
spacing of 79 u and ships at `size 60` — it doesn't even reach bare closure,
let alone the margin. Fixing it means `size ≈ 127` at count 48, or count ≈ 215
at size 60. Which is the real lesson: **a big seal wants many small tiles or
few enormous ones, and the middle is where holes live.**)*

---

## 2. The four axes

Every part carries four numbers that gameplay reads. They replace the
"one verb per biome" field — the verb is what emerges from them.

| Axis | Values | Reads as | Drives |
|---|---|---|---|
| `hardness` | `0` hands · `1` driller · `2` driller, slow · `3` no-dig | rind colour, chip particles, tool bounce | who can open it and how long it takes |
| `porosity` | `0`–`1` | how much void you can see into it | is there a natural route, or do you make one |
| `odour` | `0`–`1` | wet orange smear vs dry pale rind | passive threat pressure; digging multiplies it |
| `noise` | derived: `hardness × tool` | — | dig noise radius. Hands ≈ silent, driller on hard ≈ a dinner bell |

The coupling is the point: **the harder the wall, the louder the breach, the
more it hunts you.** Hard + stinky is automatically a set-piece; soft + quiet
is automatically the slow safe route that costs air instead of blood.

Corners worth making sure the run visits: **porous + hard** (never dig, just
navigate — emmental), **solid + hard + stinky** (the breach), **solid + soft +
quiet** (the slog), **porous + soft + sticky** (the heart).

---

## 3. The nine parts

Numbers are starting points for the bench, not gospel. `size` is world units;
`r×res` is shown where it's the load-bearing constraint.

### drift crumb — *bleached natural rind*

Sparse floating debris. The tutorial that isn't one: nothing here can hurt
you, and it's where the driller is (W10, D23).

```
kind: block · size 8–16 · res 32
hardness 0 · porosity 0.3 · odour 0
crust  { amp 0.05, freq 1.8, depth 0.2 }
eyes   { 1–3, rBase 0.09, rVar 0.06 }   coreEye 0
pores  { 6–10, rBase 0.05 }
tunnels{ rBase 0.06, bends 0 }  exits 2  deadEnds 0
tags: hand-carve
```

### emmental — *eye cheese*

The generous biome, floating in the Wheel's hollow (D2b). Huge smooth
spherical voids, wide connections, air everywhere. Teaches **eyes = air**
before the game ever charges you for it — and it's the last generous air in
the run.

```
kind: wheel · size 15–40 · res 56
hardness 0 · porosity 0.85 · odour 0.1
crust  { amp 0.06, freq 1.4, depth 0.24 }
eyes   { 10–16, rBase 0.14, rVar 0.06 }   coreEye 0.3
pores  { 8–14, rBase 0.06 }
tunnels{ rBase 0.09, bends 0–1 }  exits 5  deadEnds 1
tags: air-pocket, hand-carve
```

Tuning note: the eyes want to be *round and smooth*, not noisy — that's the
silhouette that makes the whole biome legible from 50 m. Keep `crust.amp` low.

### wax rind — *the seal*

Not a chunk you explore. A tile in a `hull` surface, and a **thin** one: the
Great Wheel is a husk, eaten out from within, with a few metres of crust left
(D2b). It has no interior at all — any eye touching both faces is a free
tunnel through your gate, and it *will* happen if you let the generator place
eyes here.

```
kind: hull tile · size 60–80 · res 48
thickness 4–6 u        ← a husk, not a fortress
hardness 3 (no-dig) · porosity 0 · odour 0.2
crust  { amp 0.02, freq 1.2, depth 0.3 }   ← see the thickness rule
eyes 0 · coreEye 0 · pores 0 · exits 0 · deadEnds 0
tags: seal
constraint: no carve of any kind within the shell thickness
```

**The thin-shell noise rule.** Surface noise displaces the face by
`crust.amp × size`. At `amp 0.10` on a size-70 tile that's **7 u** — more than
the entire crust, so the shell perforates itself and your watertight gate is
lace. Enforce for anything tagged `seal`:

```
crust.amp × size < thickness / 3
```

At `size 70, thickness 5` that caps `amp` at **0.024**. The consequence is
aesthetic and worth knowing: a thin seal has to be *smooth*. Its character
comes from colour, the gnawed inner face (W18) and the soft-spot bulges — not
from a lumpy silhouette.

Breach time is authored on the soft-spot interaction, **not** derived from
thickness — at 4–6 u the driller would otherwise be through in one carve.

Soft spots are placed **on top** of this, not generated by it — see §4.

### mite-bored paste — *the labyrinth*

Dense, fused, drilled through by something long gone. Small chunks at high
res, packed until their interiors connect, and almost no chambers. This is the
part that only works if K9 (fused placement) exists.

```
kind: hunk · size 16–20 · res 72        →  r×res: 0.055 × 72 = 4.0 ✓
hardness 1 · porosity 0.5 · odour 0.15
crust  { amp 0.05, freq 2.0, depth 0.18 }
eyes   { 26–34, rBase 0.06, rVar 0.02 }  ← barely wider than the tunnels
coreEye 0
pores  { 0–2, rBase 0.03 }
tunnels{ rBase 0.055, rVar 0.012, bends 3 }
exits 1  deadEnds 5  narrow true  tangle true
tags: narrow, maze
```

Cargo clearance: `0.055 × 18 = 1.0 u` — passable for a rat (needs 0.9), **below
the 1.3 u needed to haul the Gouda**. That's deliberate, and it's a 0.3 u
margin, so it wants checking in the bench rather than trusting. The haulable
route through the warrens has to be authored, or widened by hand on the way in
— and then the crew has to remember which one it was.

### roquefort — *the dark*

Near-black paste that eats helmet light (needs W11). The only illumination is
the vein network, which is also the route. Brittle along a vein, stubborn
across it.

```
kind: hunk · size 20–30 · res 64
hardness 0 along veins / 1 across · porosity 0.4 · odour 0.5
crust  { amp 0.07, freq 1.6, depth 0.22 }
eyes   { 8–14, rBase 0.07, rVar 0.04 }   coreEye 0
tunnels{ rBase 0.05, bends 2 }  exits 2  deadEnds 4
biome:  lightRange ×0.35, fogDensity ×2.5, veinStrength 1.0
tags: fault, dark, hand-carve
```

The generator change this needs: **veins become a real connected graph** that
the tunnel spanning tree follows, instead of a shader effect. "Follow the
light" has to be literally true. Open question Q8 — some proportion of veins
should dead-end, or the biome is a corridor with mood.

### crystal paste — *the blue wall*

Seal 2. A different drilling job from the wax: brittle, sparking, shards, and
it screams. Same `hull` mechanism, different material and different feel.

```
kind: hull tile · size 40 · res 48
hardness 3 (no-dig) · porosity 0 · odour 0.3
crust  { amp 0.06, freq 2.2, depth 0.2 }
eyes 0 · pores 0 · exits 0
tags: seal, crystal
```

Closure check at `R 88`: spacing must fall to ≤ 25 u, so **N ≥ 156 tiles** at
size 40 (or ~60 tiles at size 65). Validate in the bench before shipping the
numbers.

### aged crystal paste — *essence host*

The mineable variant, scattered through the fused bands rather than forming a
wall. The only reason to dig something you could swim around.

```
kind: hunk · size 20–30 · res 56
hardness 2 · porosity 0.15 · odour 0.1
eyes   { 2–4, rBase 0.07 }  tunnels { rBase 0.045, bends 1 }
exits 1  deadEnds 2
tags: essence, hard-dig
```

### smear rind — *the galleries*

Washed-rind cathedrals. Wide sightlines, high odour, the fish's floor. Placed
after an hour of enclosure so the openness reads as exposure, not relief.

```
kind: wheel · size 25–40 · res 48
hardness 1 · porosity 0.7 · odour 0.9
crust  { amp 0.08, freq 1.5, depth 0.22 }
eyes   { 5–8, rBase 0.18, rVar 0.1 }   coreEye 0
tunnels{ rBase 0.09, bends 1 }  exits 4  deadEnds 1
tags: attract
```

### bloom — *brie, the silent slog*

Soft fused mass that muffles sound **and** light. Hand-carvable fast, zero air
pockets. A zone where speed isn't an option and stealth is free — the inverse
trade to everything else in the map.

```
kind: hunk · size 20–28 · res 56
hardness 0 · porosity 0.2 · odour 0.3
crust  { amp 0.12, freq 2.4, depth 0.35 }   ← fuzzy
eyes   { 4–8, rBase 0.08 }  tunnels { rBase 0.06, bends 2 }
exits 1  deadEnds 3
biome:  lightRange ×0.6, soundOcclusion 0.8
tags: soft, quiet, hand-carve
```

*Currently unplaced in the layer stack — a candidate for either a pocket
inside the warrens or an alternate quiet route past the galleries.*

### fresh curd — *the heart*

Warm, sticky, still being made. Everything else in the map is aged; the centre
is fresh, because the Duplicator never stopped (L2). The drag modifier is what
makes the first thirty seconds of the ascent hell.

```
kind: hunk · size 48–64 · res 96
hardness 0 · porosity 0.6 · odour 0.4
crust  { amp 0.10, freq 1.3, depth 0.28 }
eyes   { 14–20, rBase 0.10, rVar 0.14 }   coreEye 0.34
tunnels{ rBase 0.07, bends 1 }  exits 5  deadEnds 3
biome:  dragModifier 1.6
tags: landmark, sticky, hand-carve
```

---

## 4. New fields `recipes.ts` needs

### On `PartRecipe`

```ts
hardness: 0 | 1 | 2 | 3;   // hands | driller | driller-slow | no-dig
porosity: number;          // 0–1, authored (also derivable, but author it)
odour: number;             // 0–1
noCarveWithin?: number;    // seal tiles: keep every carve this far from both faces
```

### On `BiomeRecipe`

```ts
budgets: {
  airPockets: number;   // sealed O₂ bubbles seeded in this biome
  essence: number;      // crystal deposits
  faults: number;       // brittle vein lines (roquefort)
  softSpots: number;    // seals only — 1–3, the difficulty dial
};
modifiers: {
  lightRange: number;      // ×, W11
  fogDensity: number;      // ×, W11
  drag: number;            // ×
  soundOcclusion: number;  // 0–1
};
```

### New `BiomePlacement` modes

```ts
| { mode: "hull";                    // generalises "shell" (K8)
    surface: "sphere" | "wheel";     // wheel = squat cylinder + rounded rim
    radius: number; height?: number; // height for wheel
    thickness: number;               // 4–6 for the Great Wheel — a husk
    hollow: boolean;                 // true = open water inside, not solid
    count: number;                   // validated against the closure formula
    softSpots: number }

| { mode: "fused";                   // K9 — overlapping, interiors connect
    rMin: number; rMax: number;
    count: number;
    overlap: number }                // fraction of chunk radius; > 0 guarantees fusion
```

### Soft spots

Placed **on** a hull, not generated by its tiles:

- **1–3 per seal**, count = the main difficulty dial.
- Positioned on the spine angle (D19): 40–80° around the ball from the
  previous seal's spots, drifting downward.
- Reads as a **weeping, discoloured, mite-pitted bulge**. Visible from ~15 m,
  invisible beyond that in fog — so finding it is a search along a curve (N2).
- `hardness 1`: ~20 s of driller, or ~80 s of hand-carving (D22).
- Opens one rat wide at first (N1).
- After breach it **stays open, and the inside face is blank** (D24). Mark it
  with a light stick or lose it.

---

## 5. Bench checklist

When a new part looks right in `/worldgen.html`, check it against these before
copying the numbers into `recipes.ts`:

- [ ] `r × res ≥ 4` for the smallest tunnel you care about
- [ ] Cut the camera inside — does a tunnel *feel* like a tunnel, or a pipe?
- [ ] Is the tightest route ≥ 0.9 u (rat) and ≥ 1.3 u (cargo), and is
      whichever it fails intentional?
- [ ] Would one carve from the tool you expect to be used here *erase* the
      feature you just tuned? (X3)
- [ ] Seal tiles only: does `crust.amp × size < thickness / 3` hold?
- [ ] Can you tell what the cheese is from 40 m, in fog, from silhouette and
      colour alone? (U7: one trait, one colour, one consequence)
- [ ] For hull tiles: does `size ≥ 1.6 × 3.54 × R / √N` hold, and does the
      flood fill agree?
- [ ] Does the part give the player something to *do* that its neighbours in
      the stack don't?
