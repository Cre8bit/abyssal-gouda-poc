# Cheese Parts — the build reference

The authoring reference for the six-biome map. Open this next to `/worldgen.html`
when pushing sliders; it is meant to be enough to **build each biome from
scratch**: what it is, the verb it serves, the numbers that make it that, and
what the generator must guarantee. Companion: `roadmap-worldgen.md` (the
tickets).

**The whole game happens underwater.** There is no air-filled space anywhere —
air pockets are localized breathable bubbles seeded inside carved voids, never a
change of medium. There is no `airFilled` flag.

```
OPEN WATER → THE DRIFT → ▮ GREAT WHEEL ▮ → THE DARK VEINS → ▮ MELT SHELL ▮ → THE MELT → THE GALLERIES → THE HEART ◉
             emmental        dark rind       roquefort float    melt rind        fondue      mite bore     fresh curd
             scavenge        search &        trust &            (hidden          evade &     map &         take
             & orient        breach          navigate           entrance)        rescue      squeeze
```

Two seals, opened two different ways: the Great Wheel is **drilled** (one soft
spot, 20 s of noise), the melt shell is **found** (undrillable; the vein trail
ends at its one hidden entrance).

---

## 1. The arithmetic

### Carve radii → world units

Carve radii (`eyes.rBase`, `pores.rBase`, `tunnels.rBase`, `coreEye`) are
chunk-local, on a `[-1,1]` grid where the body surface sits near `|p| ≈ 0.6`:

```
world radius (u) = r × size
```

So `rBase 0.055` on a `size 18` chunk is a **1.0 u** tunnel radius — a 2.0 u
bore.

### Clearances and tools

| | value | source |
|---|---|---|
| player collision radius | **0.6 u** | `PLAYER_RADIUS` |
| Gouda radius | **0.45 u** | `GOUDA_RADIUS` |
| hands carve radius | **0.7 u** | shapes a passage without erasing it; near-silent |
| driller carve radius | **2.4 u** | fast, loud, destructive by design |
| swim speed cap | 10 u/s | `MAX_SPEED` |

**≥ 0.9 u** tunnel radius for a rat to pass with margin; **≥ 1.3 u** to haul
the Gouda held in front. That second number decides whether a route is
haulable, and it's the one the galleries deliberately sit under.

The tool split is a mechanic, not a fix: hands *thread*, the driller
*demolishes*. The driller is **wider than a gallery bore**, so drilling through
the maze widens it into unrecognizability instead of shortcutting it — the cost
of using it there is losing the map you made.

Hardness gates what each tool can touch:

| `hardness` | opened by | where |
|---|---|---|
| 0 | hands or driller | emmental drift, fresh curd |
| 1 | driller only | roquefort floats, fondue, mite bore; the Wheel's soft spot |
| 3 | nothing | dark rind (except its soft spot), melt rind everywhere |

Noise is derived — `hardness × tool`. Hands ≈ silent; the driller on the soft
spot is the loudest thing in the game, for 20 continuous seconds.

### The resolution rule

Cell size is `size / res`, so cells across a carve radius:

```
cells per radius = r × res      (independent of chunk size)
```

Below ~4, marching cubes plus the crust noise rounds the feature into a soft
blob. Minimum for a readable tunnel is **4.0**, comfortable is 5–6:

```
res ≥ 4 × size / (desired tunnel radius in u)
```

Claustrophobic cheese must be built from small chunks at high resolution, not
big chunks with small numbers.

### Why something feels tight (or doesn't)

- **Chambers.** Eye radius much larger than tunnel radius means you surface
  into a room every few metres, and a room resets the feeling.
- **Exits.** Multiple exits per chunk plus water between chunks means daylight
  is never far. A maze wants exits only at its ends.
- **Water between parts.** An archipelago of hollow chunks can never feel
  enclosed. That's what `fused` placement is for: one solid body, no water
  inside it except the carves.

### Hull closure

For `N` tiles on a surface of radius `R`, centre spacing ≈ `3.54 R / √N`;
to survive the crust eating the edges:

```
tileSize ≥ 1.6 × 3.54 × R / √N
```

Never trust the formula alone — the route verifier (flood fill / A*) is the
law: shell closed everywhere, doors reachable, gold reachable.

### Seal smoothness

Surface noise displaces a hull face by `crust.amp × size`; on a thin husk that
turns the gate into lace. For anything tagged `seal`:

```
crust.amp × size < thickness / 3
```

Seal character comes from colour and texture (ridges, weave, mottling), never
from silhouette.

---

## 2. The seven parts

Numbers are starting points for the bench, not gospel. `size` is world units;
`r×res` shown where load-bearing.

---

### ▸ emmental drift — *the Emmental Void* · verb: **scavenge & orient**

**What it is.** A massive open-water void filled with floating chunks of
bleached, centuries-dead Emmental — chalky bone-white, riddled with the big
round holes the cheese is named for. Sparse at the outer edge, **densely
clustered as you approach the Great Wheel**, so the map itself funnels the
descent. Harmless on the way down: this is where the crew learns the swim
controls, manages starting O₂, and finds the **wrecked bathyscaphe holding the
driller**.

**The mechanic.** The natural holes hide **air pockets** — topping up means
swimming *inside* the debris, so the biome teaches "cheese has an inside"
before anything hostile does.

**Look.** Matte, bone and ash, faintly powdery; hole mouths rounded like sea
glass; slow tumble, no two chunks rotating together. Fog reads it as
silhouette past ~40 m.

```
kind: block · size 8–18 · res 32
hardness 0
crust  { amp 0.05, freq 1.8, depth 0.2 }
eyes   { 2–4, rBase 0.18, rVar 0.06 }     ← the emmental holes; air pockets live in some
coreEye 0
pores  { 4–8, rBase 0.06 }
tunnels{ rBase 0.07, bends 0 }  exits 2  deadEnds 0
tags: hand-carve, air-pocket
```

`r×res`: hole radius `0.18 × 32 = 5.8` ✓.

**Placement.** `band` r 240→300, `count ~120`, `densityGrade: "inward"`
(sparse far out, clustered against the Wheel), slow seeded rotation. One
`wreck` prop (the bathyscaphe with the driller) seeded mid-band on the spine.
Budget: `airPockets ~6`, seeded at the tops of interior eyes.

**Bench check.** Is it readable as harmless debris at 40 m? Can you find an
air pocket by silhouette alone (a chunk big enough to have an inside)?

---

### ▸ dark rind — *the Great Wheel* · verb: **search & breach**

**What it is.** The first gate. A colossal wheel of cheese lying tilted in the
abyss: squat cylinder, rounded rim, aged black and eaten hollow — **6 u of
crust and nothing behind it but black water**. It blocks everything. The crew
fans out along a curved horizon to find the **single weeping soft spot**.

**Look.** Near-black natural rind: deep grey-brown mottling, grey-white mould
bloom, a fine dry crack web; concentric mould ridges and cloth weave on the
faces, smoother rim. Pale straw paste glimpsed under chipped cracks — the only
warm colour, and what makes the soft spot read. The **inside face is pale,
uniformly gnawed, featureless** — which is why the crew must drop a light
stick at the breach or lose the door from within.

**Numbers.**
```
kind: hull tile · size 109 (at R 233, N 150) · res 48
thickness 6 u
hardness 3 (soft spot digs as 1)
crust  { amp 0.018, freq 1.2, depth 0.3 }   ← capped: amp × 109 < 6/3
eyes 0 · pores 0 · exits 0 · deadEnds 0
noCarveWithin 2
tags: seal
```

**Placement.** `hull`, `surface: "wheel"`, `radius 233`, `thickness 6`,
`rim 26`, **`softSpots: 1`**, `softSpotR 8`, ridges on. Closure:
`size ≥ 1331/√N` → 109 at N 150.

**The soft spots.** Multiple weeping, discoloured, mite-pitted bulges scattered
around the perimeter — paste showing through the crack web, wet sheen, each
visible from ~15 m and invisible beyond. Finding one is a search along a curve;
choosing which one is a question. Each digs as `hardness 1`; the breach is
**~20 s of continuous driller** — the loudest noise in the game — opening a
bore wide enough to haul back out through (driller radius 2.4 u). After breach
it stays open, and only the light stick marks it.

**Bench check.** Walk the outer face: does the spot read at 15 m and vanish at
30? Inside face: with no light stick, can you find the hole again? (You
shouldn't be able to.)

---

### ▸ roquefort float — *the Dark Veins* · verb: **trust & navigate**

**What it is.** Everything inside the Wheel down to the melt shell: a vast,
**pitch-black** expanse of floating Roquefort. No solid mass, no walls, no
floor — helmet lamps are severely choked, and the only information in the
world is the **glowing blue mold veining on the edges of the floating
chunks**. The trail of glows is the navigation: from each chunk you can just
make out the next.

**The two mechanics.**
- **True 3D disorientation.** The trail doesn't go forward — it spirals up,
  down, and through larger floating corridors. And because the chunks
  **slowly rotate**, a glowing edge turns away and plunges the route into
  total darkness until it comes back around. The dark pulses; the crew waits,
  or trusts.
- **The undrillable wall.** The trail ends at the melt shell (next part),
  which cannot be dug anywhere. Lose the trail and you are swimming blind
  against an impenetrable wall — the vein sequence is the only way to the one
  hidden entrance, so the **trail terminus must land at the entrance** by
  construction.

**Look.** Near-black blue-grey paste that eats light; the veins are emissive
blue-green filaments concentrated along chunk edges and rims, readable from
outside the chunk at ~40 u through fog. Chunks grow from house-brick to
house-sized as you go inward, tightening the trail on its own.

```
kind: hunk · size 10 → 40 (graded inward) · res 56
hardness 1
crust  { amp 0.07, freq 1.6, depth 0.22 }
eyes   { 3–6, rBase 0.08 }   coreEye 0
tunnels{ rBase 0.06, bends 1 }  exits 2  deadEnds 1
veins: edge-concentrated, emissive, always on, visible from OUTSIDE
tags: dark, landmark
```

**Placement.** `band` r 100→226, `count ~90`, `densityGrade: "inward"`,
`sizeGrade: "inward"`, `sightline: true` (each chunk placed within
sight-range of the previous, hull-occlusion checked), slow seeded rotation.
2–3 chunks are authored dead ends off the main line — far enough apart to
cost a minute, not a run. Modifiers: `lightRange ×0.25`, `fogDensity ×3`.

**Bench check.** Lamp OFF, veins only: can you see the next chunk from the
current one, always? Let the chunks rotate a full period: is the longest
all-dark gap tense or unfair? Does the chain end within sight of the shell
entrance?

---

### ▸ melt rind — *the shell of the Melt* · verb: (the veins' destination)

**What it is.** The second seal: the outer crust of the massive central cheese
body that contains everything from the Melt inward. **Entirely undrillable —
`hardness 3` with no soft spot.** The crew cannot dig their own door; the only
way in is the **single, highly obscured, hidden entrance** the vein trail
leads to.

**Look.** Scorched, vitrified rind: dark amber-brown, heat-crazed, faintly
warm-glowing along deep cracks (the Melt bleeding light from inside). The
entrance is a recessed, angled crevice — invisible as a silhouette, found only
because the last vein glows point at it.

```
kind: hull tile · size ~66 (at R 91, N 60) · res 48
thickness 5 u
hardness 3 · no soft spots
crust  { amp 0.02, freq 1.4, depth 0.3 }    ← capped: amp × 66 < 5/3
eyes 0 · pores 0 · exits 0 · deadEnds 0
noCarveWithin 2
tags: seal
entrance: ONE generator-carved bore, radius ≥ 1.4 u (cargo must pass on the
way out), entering at an angle (not radial) and recessed so it never reads
at distance; positioned on the spine crossing of this layer boundary.
```

**Placement.** `hull`, `surface: "sphere"`, `radius 91`, `thickness 5`,
`softSpots: 0`. Closure: `size ≥ 1.6 × 3.54 × 91/√N` → 66 at N 60.

**Bench check.** Sphere-orbit at 30 u: the entrance must NOT read. Follow the
vein chain: it must. Verifier: with the entrance plugged, bell→gold must fail.

---

### ▸ fondue — *the Fondue Cathedral* · verb: **evade & rescue**

**What it is.** The claustrophobia breaks: massive, hot, **orange-lit
caverns** of superheated water, 25–40 u across, connected by short wide
throats. Three or four chambers, highly rhythmic. The one place you can see
the far wall, the ceiling, and every teammate at once — and everything
dangerous is in plain sight.

**Space first.** Volume, not geometry detail: few huge eyes, giant coreEye,
wide throats, **no dead ends**. The generator makes rooms and gets out of the
way.

**Look.** Wet, glossy, molten orange-gold billowing off the ceiling in slow
ropes that *dissolve into the water* like ink — an underwater vent plume, not
a waterfall. Cooled floes crusted dull amber on the floor. The fog thins,
warms, and glows.

```
kind: hunk · size 28–34 · res 64
hardness 1
crust  { amp 0.09, freq 1.4, depth 0.3 }
eyes   { 3–5, rBase 0.34, rVar 0.08 }  coreEye 0.45   ← caverns, not chambers
pores  { 4–8, rBase 0.05 }
tunnels{ rBase 0.11, bends 0–1 }  exits 3  deadEnds 0  ← wide throats, no maze
tags: hot, open
```

**Placement.** `fused` r 46→88. Modifiers: `lightRange ×1.4`,
`fogDensity ×0.6`, `temperature 1.0`. Hazard budget (seeded by the generator
at eye ceilings/floors): `meltFalls 12, meltPools 6, vents 8`.

**The hazards — all in water, all telegraphed, all on a rhythm.**

| hazard | reads as | does |
|---|---|---|
| `melt_fall` | a sag, a bulge, then a rope of molten cheese dripping from the ceiling on a seeded cycle | `coated` on contact |
| `melt_pool` | bright roiling patch on the floor; crusts over ~1 s, then gives way | `coated` if you fall in |
| `thermal_vent` | superheated geyser blasting from a floor crack, on a rhythm | blinds and shoves; impassable while erupting |

**The rhythm is the level design.** Cycles are seeded and staggered so
crossing a cavern is: wait for the geyser to subside → dart across a stable
cooled floe → pause before the next ceiling drip lands. Floes are the safe
beats between hazards.

**Engulfment is not death.** Getting hit coats a player in molten cheese:
severely slowed, vision fouled, **O₂ drain ×2** — until a **teammate scrapes
them off**. Evade & rescue: the biome is built to be crossed together.

**Bench check.** Walk mode: far wall visible? Every hazard readable before it
fires? Can a coated (slowed) player be reached from anywhere in the cavern
before their O₂ dies?

---

### ▸ mite-bored paste — *the Galleries* · verb: **map & squeeze**

**What it is.** A colossal sponge of endless, identical tan tunnels —
**~1.0 u clearance, one rat wide** — bored by mites. Dead ends and false
loops everywhere; every surface looks the same in every direction. The only
landmarks are the ones the crew makes with light sticks.

**The relief valve.** The squeezes occasionally open into small **spherical
gathering chambers** — regrouping points to check O₂, argue, and drop a light
stick before the next stretch. A maze that only branches is a hedge; the
rooms make it a place.

**The driller warning.** Everything here is `hardness 1`, so the driller
*works* — and using it is a terrible idea: at 2.4 u it obliterates the narrow
walls and destroys every recognizable path, including the light-stick trail's
context. That trade is the mechanic, not a bug.

```
kind: hunk · size 16–20 · res 72        → tunnel r×res: 0.055 × 72 = 4.0 ✓
hardness 1
crust  { amp 0.05, freq 2.0, depth 0.18 }
eyes   { 26–34, rBase 0.06, rVar 0.02 }   ← barely wider than the tunnels
coreEye 0
chambers { chance 0.12, rBase 0.28 }      ← the spherical gathering rooms, ~1 in 8 tiles
pores  { 0–2, rBase 0.03 }
tunnels{ rBase 0.055, rVar 0.012, bends 3 }
exits 1  deadEnds 5  narrow true  tangle true
tags: narrow, maze
```

**Placement.** `fused` r 8→46.

**Cargo clearance — the number to watch.** `0.055 × 18 = 1.0 u`: a rat passes
(needs 0.9), **the Gouda does not (needs 1.3)** — a deliberate 0.3 u negative
margin. Hauling out means finding the wider seams, or drilling and destroying
the maze you mapped. Decide the final margin in the bench with the slab in
front of you.

**Bench check.** Swim in, get back out. Do it again holding something 1.3 u
wide. Is it *lost* (dead ends + rooms) or merely *annoying* (dead ends alone)?

---

### ▸ fresh curd — *the Heart* · verb: **take**

**What it is.** A single, luminous, fresh chamber at the exact centre of the
map, holding **the last air pocket in the game** and the **Golden Gouda**. The
only moment of peace: everything else in the abyss is aged and dead; the
centre is still being made.

**Look.** White, wet, faintly luminous, whey beading off the walls. Warm
light against two hours of cold and dark. It should look *alive* in a map
made of corpses.

```
kind: hunk · size ~40 · res 96
hardness 0
crust  { amp 0.10, freq 1.3, depth 0.28 }
eyes   { 2–4, rBase 0.10 }   coreEye 0.5        ← one room is the part
tunnels{ rBase 0.07, bends 1 }  exits 2  deadEnds 0
tags: landmark, air-pocket
```

**Placement.** `center`, r 8→0. Props: one `air-pocket` (the last), the
`golden_gouda` at the centre.

**What the player does.** Breathes. Takes it. Realises the whole map now has
to be crossed in reverse, carrying it.

---

## 3. Assembling the world

One seeded recipe, ordered outside-in. Worldgen is deterministic from
`seed + tables`; no geometry crosses the network.

| # | Layer | r out → in | Mode | Part | Notes |
|---|---|---|---|---|---|
| 0 | Open water | 420 → 300 | — | — | descent |
| 1 | The Drift | 300 → 240 | `band`, graded inward | emmental drift | wreck + driller; air pockets in holes |
| 2 | **Great Wheel** | 236 → 230 | `hull` wheel | dark rind | seal #1 · 1 soft spot · 20 s drill |
| 3 | The Dark Veins | 226 → 100 | `band`, graded + sightline | roquefort float | rotating; trail = navigation |
| 4 | **Melt shell** | 96 → 91 | `hull` sphere | melt rind | seal #2 · undrillable · 1 hidden entrance ≥ 1.4 u |
| 5 | The Melt | 88 → 46 | `fused` | fondue | 3–4 caverns 25–40 u; rhythm hazards |
| 6 | The Galleries | 46 → 8 | `fused` | mite bore | 1.0 u squeezes + spherical rooms |
| 7 | The Heart | 8 → 0 | `center` | fresh curd | last air pocket + Golden Gouda |

Air pockets: generous in the drift (~6, inside emmental holes), **none seeded
by default between the Wheel and the Heart**, and exactly one in the heart —
the last in the game. If the O₂ curve proves too harsh at the gates, sparse
pockets in the veins are the tuning knob; add them in the bench, not here.

**Rules the loader enforces at seed time — fail loudly, don't warn:**

| Rule | Constraint |
|---|---|
| Hull closure | `tileSize ≥ 1.6 × 3.54 R / √N` — both hulls |
| Seal smoothness | `crust.amp × size < thickness / 3` — both hulls |
| Resolution | `r × res ≥ 4` for every carve that matters |
| Clearance | tunnels ≥ 0.9 u (rat); galleries fail 1.3 u (cargo) *intentionally*; melt entrance ≥ 1.4 u |
| Reachability | verifier: both seals closed with doors blocked; bell → soft spot → entrance → gold reachable with them open |
| Sightline | vein trail connected breach → entrance, ≤ 2–3 authored orphans |

---

## 4. Schema — what `recipes.ts` needs

The as-built schema is the source of truth (the bench's copy-JSON round-trips
it). Deltas the new map needs, and the fields it retires:

### `PartRecipe`

Keep: `id label kind mood desc size hardness crust eyes coreEye chambers
pores tunnels exits deadEnds narrow tangle noCarveWithin tags`.

**Retire:** `porosity`, `odour` — no consumer in the six-biome design.

### `BiomePlacement`

```ts
| { mode: "center" }                       // the heart
| { mode: "band";                          // floating parts in water
    rMin; rMax; count; guard;
    densityGrade?: "outward" | "inward";
    sizeGrade?: "outward" | "inward";      // NEW — veins/drift grow inward
    sightline?: boolean;                   // NEW — each chunk visible from the last
    rotate?: { degPerSec: number } }       // NEW — slow seeded tumble
| { mode: "fused";                         // one solid lattice-tiled band
    rMin; rMax; warpAmp; warpFreq; loopFrac; sideExits }
| { mode: "hull";                          // one closed lattice-tiled husk
    surface: "wheel" | "sphere";
    radius; thickness; rim;
    softSpots; softSpotR;                  // 0 on the melt shell
    entrance?: { r: number };              // NEW — melt shell's hidden bore
    ridgeAmp; ridgeFreq }
```

**Retire:** `mode: "shell"` (the classic fibonacci wall) and its colossal
params — superseded by `hull`.

### `BiomeRecipe`

```ts
budgets?: {
  airPockets: number;                      // O₂ bubbles seeded in carved voids
  softSpots: number;                       // seals only
  hazards?: { meltFalls: number; meltPools: number; vents: number };  // melt only
};
modifiers?: {
  lightRange: number;   // ×
  fogDensity: number;   // ×
  drag: number;         // ×
  soundOcclusion: number;
  temperature?: number; // the melt — hot water, not a medium change
};
```

**Retire:** `airFilled` (nothing is air-filled), `budgets.essence`,
`budgets.faults` (no consumer).

### `WorldRecipe`

Unchanged: `worldR boundaryR goldBand goldMinCavernR debrisCount heartGuard
frame spine parts biomes`. **Retire the old tables:** `DEFAULT_PARTS`,
`DEFAULT_BIOMES`, `DEFAULT_WORLD`, `WORLDS.onion` — the six-biome
`WHEEL_WORLD` is the only world.

---

## 5. Bench checklist

Before copying numbers into `recipes.ts`:

- [ ] `r × res ≥ 4` for the smallest tunnel you care about
- [ ] Camera inside — does a tunnel *feel* like a tunnel, or a pipe?
- [ ] Tightest route ≥ 0.9 u (rat); where it fails 1.3 u (cargo), is that intentional?
- [ ] Would one carve from the expected tool *erase* the feature you tuned?
- [ ] Seal tiles: `crust.amp × size < thickness / 3`, and closure formula holds
- [ ] Both seals: verifier says closed-with-doors-blocked AND reachable-with-doors-open
- [ ] Veins: lamp off, veins only — is the next chunk always findable? Through a rotation period?
- [ ] Melt: every hazard readable before it fires; a coated teammate reachable in time
- [ ] Can you tell what the cheese is from 40 m, in fog, from silhouette and colour alone?
- [ ] Does the part give the player a verb its neighbours don't?
