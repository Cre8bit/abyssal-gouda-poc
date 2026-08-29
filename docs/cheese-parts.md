# Cheese Parts — the build reference

The authoring companion to `idea-register.md` and `plan-mvp.md`. This is what
you open next to `/worldgen.html` when you're pushing sliders, and it is meant
to be enough to **build each bit from scratch**: what it is, what it looks like,
the numbers that make it that, where it sits in the world, and what the player
does with it.

**MVP only.** Six parts, one seal, five stops. Emmental, crystal paste, aged
crystal, smear rind and bloom are cut from this document — they were good ideas
attached to layers that no longer exist. They come back with a band to live in,
not before.

```
OPEN WATER  →  DRIFT  →  ▮ THE GREAT WHEEL ▮  →  THE DARK VEINS  →  THE MELT  →  THE GALLERIES ◉
              drift crumb      dark rind             roquefort         fondue      mite bore + curd
```

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
haul the Gouda held in front. That second number decides whether a route is
haulable, and it's the one the galleries deliberately sit under.

### ⚠ The dig radius is bigger than the level

`DIG_RADIUS = 2.4` carves a **4.8 u sphere**. That is wider than a mite-bored
tunnel (2.2 u), and **thicker than the entire Great Wheel crust**. One click
currently destroys the biome it's used in, and would punch through the gate as
though it weren't there.

**Digging has to become per-tool** before any of this is authorable:

| tool | carve radius | notes |
|---|---|---|
| hands | ~0.7 u | shapes a passage without erasing it. Slow, near-silent |
| driller | 2.4 u | the current value. Fast, loud, destructive by design |

That split isn't just a fix — it's the mechanic. Hands *thread*, the driller
*demolishes*, and choosing between them is choosing whether the tunnel you came
through still exists on the way back. It is also what stops the galleries being
solved with a straight line: the driller is **wider than a tunnel**, so drilling
through the maze widens it, it doesn't shortcut it. (Register X3.)

### The resolution rule — *why nothing feels tight*

Cell size is `size / res`, so the number of marching-cubes cells across a carve
radius is:

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

```
res ≥ 4 × size / (desired tunnel radius in u)
```

For a 1.1 u tunnel: `size 20 → res ≥ 73` (use 72 or 96). `size 30 → res ≥ 109`,
which isn't in the allowed set. **Claustrophobic cheese must be built from small
chunks at high resolution**, not from big chunks with small numbers.

### The other two causes of "nothing feels tight"

Narrow tunnels are necessary and not sufficient:

- **Chambers.** Eye radius much larger than tunnel radius means you surface into
  a room every few metres, and a room resets the feeling. A maze part wants many
  nodes and few rooms — but see the galleries, where *some* rooms are the point.
- **Exits.** `exits: 2` per chunk plus open water between chunks means daylight
  is never more than a few metres away. A maze formation wants exits only at its
  ends.
- **Water between parts.** The real one. An archipelago of hollow chunks can
  never feel enclosed, however you carve it. That's what **`fused`** placement is
  for: overlapping chunks whose interiors connect, with no water in between.

### Shell closure

For `N` chunks tiled on a surface of radius `R`, centre spacing is:

```
spacing ≈ 3.54 × R / √N
```

Neighbouring tiles only touch when the chunk *radius* reaches half the spacing;
to survive the noise crust eating the edges you want ~0.8 × spacing. Since
`size` is full width:

```
size ≥ 1.0 × spacing     bare closure, no margin
size ≥ 1.6 × spacing     recommended
```

Never trust this — **verify it**: flood-fill the water volume from the bell at
coarse resolution at seed time. Whatever the fill reaches is the outer band. If
it reaches the centre, the seal leaked. If it reaches no soft spot, you've
sealed the player out. Both cases: thicken, add tiles, reseed.

*(This is how X1 should have been caught: the crust at `R 155, count 48` has a
spacing of 79 u and ships at `size 60` — it doesn't reach bare closure, let
alone the margin. The lesson: **a big seal wants many small tiles or few
enormous ones, and the middle is where holes live.**)*

---

## 2. The four axes

Every part carries four numbers that gameplay reads. They replace "one verb per
biome" — the verb is what emerges from them.

| Axis | Values | Reads as | Drives |
|---|---|---|---|
| `hardness` | `0` hands · `1` driller · `2` driller, slow · `3` no-dig | rind colour, chip particles, tool bounce | who can open it and how long |
| `porosity` | `0`–`1` | how much void you can see into it | is there a natural route, or do you make one |
| `odour` | `0`–`1` | wet, glossy, warm vs dry, pale, matte | passive threat pressure; digging multiplies it |
| `noise` | derived: `hardness × tool` | — | dig noise radius. Hands ≈ silent, driller on hard ≈ a dinner bell |

The coupling is the point: **the harder the wall, the louder the breach, the
more it hunts you.**

The six MVP parts were chosen to cover the corners: solid + no-dig + loud (the
gate), solid + dark + navigable (the veins), porous + hot + open (the melt),
solid + narrow + endless (the galleries), and porous + soft + sticky (the
heart), with the drift as the harmless baseline you measure all of them against.

---

## 3. The six parts

Numbers are starting points for the bench, not gospel. `size` is world units;
`r×res` is shown where it's load-bearing.

---

### ▸ drift crumb — *bleached natural rind*

**What it is.** Centuries-dead cheese, gone chalky and grey-white, tumbling
slowly in the current. Small blocks far enough apart that you always see between
them. **Nothing here is a wall.** The drift exists so that the Wheel resolves
out of the fog as a horizon that doesn't stop — and so the driller has somewhere
to be.

**Look.** Matte, bone and ash, faintly powdery; edges rounded like sea glass.
Zero specular. Slow tumble, no two rotating together. Fog reads it as
silhouette-only past ~40 m.

**Numbers.**
```
kind: block · size 8–16 · res 32
hardness 0 · porosity 0.3 · odour 0
crust  { amp 0.05, freq 1.8, depth 0.2 }
eyes   { 1–3, rBase 0.09, rVar 0.06 }   coreEye 0
pores  { 6–10, rBase 0.05 }
tunnels{ rBase 0.06, bends 0 }  exits 2  deadEnds 0
tags: hand-carve
```

**Placement.** One layer only: the **drift** (r 300→240), `count ~140`,
`water: true`, sparse, one `wreck` prop containing the driller.

**What the player does.** Orients. Finds the driller. Learns that cheese can be
punched through, before anything punches back.

**Bench check.** Can you tell it's harmless at 40 m? If it reads as structure
rather than debris, it's too big or too dense.

---

### ▸ dark rind — *the Great Wheel*

**What it is.** The one gate. A classic wheel of cheese the size of a district:
a squat cylinder with a rounded rim, flat top and bottom, lying tilted in the
abyss. Aged in the dark for centuries and eaten hollow from within, so what's
left is a **husk — a few metres of crust and nothing behind it but black water**.

**Look — the change from the old wax.** No wax, no red. A **classic dark natural
rind**: near-black at a distance, resolving up close into deep grey-brown
mottling, dusted grey-white with old mould bloom, cracked in a fine dry web. The
flat faces carry the **concentric ridges of the mould** and the weave of the
cloth it was bandaged in; the rim is smoother and slightly glossy where it was
turned. Under a chipped crack you glimpse the pale straw-ivory paste beneath —
the only warm colour on the whole surface, and the thing that makes a soft spot
read.

The inner face is a different material entirely: pale, dry, **uniformly gnawed**
in every direction, featureless — which is exactly why you must mark your door
with a light stick.

**Why it must be smooth.** It's a hull tile, not a chunk you explore, and it's
thin. Surface noise displaces the face by `crust.amp × size`; at `amp 0.10` on a
size-109 tile that's **11 u**, twice the whole crust, and your watertight gate is
lace. Enforce for anything tagged `seal`:

```
crust.amp × size < thickness / 3
```

At `size 109, thickness 6` that caps `amp` at **0.018**. So the Wheel's
character has to come from **colour, the cloth-weave and mould-ridge texture,
the gnawed inner face and the soft-spot bulges — not from a lumpy silhouette.**
This is a texturing job, not a geometry job, and the ridges/weave give you all
the detail you need at zero displacement.

**Numbers.**
```
kind: hull tile · size 109 (at R 233, N 150) · res 48
thickness 6 u          ← a husk, not a fortress
hardness 3 (no-dig) · porosity 0 · odour 0.2
crust  { amp 0.018, freq 1.2, depth 0.3 }   ← capped by the thickness rule
eyes 0 · coreEye 0 · pores 0 · exits 0 · deadEnds 0
tags: seal
constraint: no carve of any kind within the shell thickness (noCarveWithin)
```

**Placement.** `mode: "hull"`, `surface: "wheel"` (squat cylinder + rounded
rim), `r 233`, `hollow: true`, `sealed: true`, `softSpots: 2`. Closure:
`size ≥ 1.6 × 3.54 × 233 / √N` → `≥ 1331/√N`; at N = 150 that's **109**.
Validate at build time *and* with the flood fill.

**What the player does.** Searches a curve the size of a horizon for the one
place the wall isn't a wall. Then makes the loudest noise in the game for twenty
seconds. Then loses the door.

**Breach time is authored on the soft spot, not derived from thickness** — at
6 u the driller would otherwise be through in one carve. See §4.

---

### ▸ roquefort — *the dark veins* · **two phases**

**What it is.** Everything inside the Wheel, all the way from the breach to the
melt. You come through the crust into **total darkness** — no ambient light, no
horizon, no floor — and the only things in the world are faint blue vein-lights
hanging in the black. The biome is one continuous idea (*the veins are the only
information*) expressed twice, at two scales.

#### Phase 1 — the drifting veins · `scatter`, in water · r 230 → 150

Floating chunks of roquefort, dark and invisible except for the vein networks
glowing faintly inside them. They read as **lanterns in a void**: you swim to
one, and from it you can just make out the next. **The trail is the navigation**
— there is nothing else, not even a wall.

The chunks get **bigger and closer together as you go inward**, so the trail
tightens on its own and the player is funnelled without ever being told. The
last few are house-sized, and then the trail ends at a mass that fills the fog
in every direction.

```
kind: hunk · size 10 → 45 (graded inward) · res 56
hardness 0 along veins / 1 across · porosity 0.35 · odour 0.5
crust  { amp 0.07, freq 1.6, depth 0.22 }
eyes   { 4–8, rBase 0.08 }   coreEye 0
tunnels{ rBase 0.06, bends 1 }  exits 2  deadEnds 1
veins: surface-visible, emissive, always on
tags: fault, dark, landmark, hand-carve
```

Placement: `mode: "scatter"`, r 230→150, `water: true`,
`densityGrade: "inward"`, `sizeGrade: "inward"`, `count ~70`, budgets
`airPockets 3, essence 6, faults 8`.

**Design rules for the trail.** Each chunk's glow must be visible from the
previous one [N9] — that sightline *is* the level design, and it's the only
place in the map where the game quietly leads you. Small pockets of air live
inside a few of them, so the trail is also a reason to stop. **Two or three
chunks are dead ends off the main line**, far enough apart to cost a minute, not
a run.

#### Phase 2 — the vein mass · `fused` · r 150 → 90

The trail ends at one continuous body of roquefort and you go **inside** it. No
more water between parts [D2]; from here to the heart you are within the cheese.
Your lamp reaches a third as far, the water is sticky, you move at 80%. The vein
graph is the route, the light, and the only thing hand-diggable: **follow the
veins or drill blind.**

```
kind: hunk · size 20–30 · res 64
hardness 0 along veins / 1 across · porosity 0.4 · odour 0.5
crust  { amp 0.07, freq 1.6, depth 0.22 }
eyes   { 8–14, rBase 0.07, rVar 0.04 }   coreEye 0
tunnels{ rBase 0.05, bends 2 }  exits 2  deadEnds 4
biome:  lightRange ×0.35, fogDensity ×2.5, drag ×1.25, veinStrength 1.0
tags: fault, dark, hand-carve
```

Placement: `mode: "fused"`, r 150→90, `swimSpeedMul 0.8`, budgets
`airPockets 2, essence 10, faults 14`.

**The entrance matters.** The mass should have a small number of visible mouths
where veins converge and break the surface — the same read as the Wheel's soft
spot, at a tenth the scale, and hand-carvable rather than drilled. Finding the
way *in* is the last beat of phase 1.

**The generator change both phases need.** Veins become a **real connected
graph** that the tunnel spanning tree follows, instead of a shader effect —
"follow the light" has to be literally true, and in phase 1 it has to be visible
from *outside* the chunk. Open question Q8: some proportion must dead-end, or
the biome is a corridor with mood. Brittle vein routes that collapse behind you
are the cheap version of the same tension; take that if the graph work overruns.

**Bench check.** Kill all lights except the veins, in both phases. Can you still
navigate? In phase 1, can you see the next chunk from the current one — with a
lamp *off*? If not, the trail isn't a trail and the darkness is just darkness.

---

### ▸ fondue — *the melt*

**What it is.** Thermal vents from the heart have cooked this layer soft. **It
is still fully submerged** — there is no air-filled space anywhere in the game
— but the water itself has changed: hot, churning, lit orange from below by
vents in the floor, streaked with ribbons of molten cheese pouring off the
ceiling and dispersing into the current like ink. Three or four cavernous voids
rather than a tunnel network, so it's the one place you can see the far wall,
the ceiling, and every teammate at once — the release valve between two hours of
dark, the veins before it blind and tight, the galleries after it blind and
tighter.

**Space first.** This biome is defined by volume, not by geometry detail. Three
or four chambers, each **25–40 u across**, connected by short wide throats.
Everything dangerous here is in plain sight, and that's the deal: **open, lit
and hazardous** against **tight, blind and empty**.

**Look.** Wet, glossy, molten orange-gold billowing off the ceiling in slow
ropes that *dissolve into the water* rather than falling through air — think an
underwater vent plume, not a waterfall. Cooled floes crusted on the floor in
dull amber. Water fog stays, but thinner and warmer-tinted, and it glows instead
of muddying. Everything strings and sags; no crisp edges anywhere. High odour:
the loudest-smelling place in the map.

**Numbers.**
```
kind: hunk · size 28–34 · res 64                  ← big chunks, big voids
hardness 1 · porosity 0.75 · odour 0.8
crust  { amp 0.09, freq 1.4, depth 0.3 }          ← sagging, molten, not crisp
eyes   { 3–5, rBase 0.34, rVar 0.08 }  coreEye 0.45   ← caverns, not chambers
pores  { 4–8, rBase 0.05 }
tunnels{ rBase 0.11, bends 0–1 }  exits 3  deadEnds 0   ← wide throats, no maze
biome:  lightRange ×1.4, fogDensity ×0.6, temperature 1.0
tags: air-pocket, hot, open, hand-carve
```

Note the inversion against every other part: **high `coreEye`, few eyes, no dead
ends.** The melt is the one place where the generator should be making *rooms*
and getting out of the way.

**Placement.** `mode: "fused"`, r 90→45, `overlap` low so the caverns stay
distinct, budgets `airPockets 8, essence 8, faults 4` — the air pockets sit
under the ceiling here same as anywhere else (S3/D10), and there are more of
them than in any other biome: this is still **the last generous refill in the
run**, it's just an ordinary air pocket doing the work, not a change of medium.

**The heat hazards.** All four are the same rule — visible, telegraphed, and
usable against something else. All happen *in water*.

| Hazard | Reads as | Does |
|---|---|---|
| `melt_fall` ×12 | a sag, a bulge, then a rope of molten cheese billowing off the ceiling into the current | `coated` on contact; can be triggered early and dropped on a pursuer |
| `melt_pool` ×6 | bright, roiling patch on the floor, crusting over and re-opening | `coated`; the crust supports weight for about a second before giving way |
| `thermal_vent` ×8 | a plume of superheated water and dissolved cheese jetting from a floor crack, on a rhythm | blinds and shoves; rides you up a shaft if you time it — the underwater equivalent of a geyser |
| `heat_zone` (ambient) | visible shimmer/distortion where hot and cold water mix | slow O₂ burn near the hottest chambers — the reason it isn't a free rest stop |

**Cooled floes** are the counterpart: dull amber slabs crusted grey on the
floor, climbable footing in an otherwise open volume, and *placed by what
already fell*. The route across a cavern floor is partly built out of its own
hazard.

**What the player does.**
- **Still swims.** No movement-mode change anywhere in this biome — the "biggest
  sensory swap" is the water itself going hot, bright and orange instead of cold
  and dark, not a swap out of water. Voice occlusion still applies as normal;
  this biome doesn't get quieter, it gets *visible*.
- **Reads the ceiling.** Falls are telegraphed — a sag, a bulge, then the rope
  billowing into the water.
- **Gets engulfed, and gets pulled out.** Being caught is **not death**:
  `coated` — slowed, vision fouled, O₂ drain ×2. Cleared by a teammate scraping
  it off, or by swimming through a `thermal_vent`'s cold counter-current (the
  temperature shock cracks the coating loose). Instant death in a hazard biome
  makes people stop moving.
- **Weaponises it.** A fresh fall can be dropped on something following you. That
  offensive use is why this hazard was admitted at all; a hazard that only taxes
  you is friction.

**The tension to watch.** It cannot be a strong hazard *and* a strong refill. If
players sprint through, the whole back half of the oxygen curve runs dry — cut
fall count and pool coverage before anything else.

---

### ▸ mite-bored paste — *the galleries*

**What it is.** The Gouda's shell, and the last act. One colossal mass of tan
cheese bored through by mites into thousands of holes. **Not a cave system — a
sponge.** One-rat squeezes open without warning into chambers you could lose the
crew in, then close again. Dead ends everywhere. Carrying the Gouda back out
through this is the climax of the run.

**Look.** Warm mid-tan, dry, matte, drilled everywhere with small round bores;
fine ochre dust hanging in the beam. Every surface looks the same in every
direction, which is the whole problem. Light sticks are the only landmarks the
player can make.

**Numbers.**
```
kind: hunk · size 16–20 · res 72        →  r×res: 0.055 × 72 = 4.0 ✓
hardness 1 · porosity 0.5 · odour 0.15
crust  { amp 0.05, freq 2.0, depth 0.18 }
eyes   { 26–34, rBase 0.06, rVar 0.02 }   ← barely wider than the tunnels…
coreEye 0
pores  { 0–2, rBase 0.03 }
tunnels{ rBase 0.055, rVar 0.012, bends 3 }
exits 1  deadEnds 5  narrow true  tangle true
tags: narrow, maze
```

**The one authored exception:** a small number of eyes at `rBase 0.25+` —
**chambers**, seeded maybe 1 in 8 chunks. A maze that only branches is a hedge;
a maze that opens into rooms is a place. The rooms are where the crew regroups,
argues, and realises nobody marked the way in.

**Placement.** `mode: "fused"`, r 50→6, budgets `airPockets 1, essence 14`.

**Cargo clearance — the number to watch.** `0.055 × 18 = 1.0 u`: passable for a
rat (needs 0.9), **below the 1.3 u needed to haul the Gouda**. That's a 0.3 u
negative margin, deliberately. Either the haulable route is authored, or it's
widened by hand on the way in — and then the crew has to remember which one it
was. Decide that in the bench with the slab in front of you, not from the chair.

**Bench check.** Swim in, try to get back out. Then do it again holding something
1.3 u wide. Is it *lost*, or is it *annoying*? Lost is dead ends plus rooms;
annoying is dead ends alone.

---

### ▸ fresh curd — *the heart*

**What it is.** One chamber at the centre, one air pocket — the last one in the
game — and the Golden Gouda in it. Everything else in the abyss is aged; the
centre is fresh, warm and still being made, because the Duplicator never stopped.

**Look.** White, wet, faintly luminous, still forming; whey beading off the
walls. Warm light against everything cold you've swum through. It should look
*alive* in a map made of corpses.

**Numbers.**
```
kind: hunk · size 48–64 · res 96
hardness 0 · porosity 0.6 · odour 0.4
crust  { amp 0.10, freq 1.3, depth 0.28 }
eyes   { 14–20, rBase 0.10, rVar 0.14 }   coreEye 0.34
tunnels{ rBase 0.07, bends 1 }  exits 5  deadEnds 3
biome:  dragModifier 1.6
tags: landmark, sticky, hand-carve
```

**Placement.** `mode: "chunk"`, r 6→0, one `air-pocket`, `golden_gouda` prop at
the centre (D3).

**What the player does.** Takes it — and immediately discovers the drag
modifier. The first thirty seconds of the ascent, hauling something heavy
through sticky cheese, is the worst movement in the game, and that's the point.

---

## 4. The seal — soft spots

There is **one seal in MVP**. Soft spots are placed **on** a hull, not generated
by its tiles.

- **1–3 per seal**; the count is the main difficulty dial. Ship with 2.
- Positioned on the **spine angle** (D19) — for a single gate, seeded once and
  drifting downward from the bell's bearing so it's never directly below you.
- Reads as a **weeping, discoloured, mite-pitted bulge**: the dark rind gone
  soft and damp, pale paste showing through the crack web, fine veins converging
  into it, a wet sheen the rest of the wheel doesn't have. **Visible from ~15 m,
  invisible beyond that in fog** — finding it is a search along a curve (N2).
- `hardness 1`: **~20 s of driller** — the loudest thing in the game — or ~80 s
  of hand-carving (D22), so losing the driller is a slower run, not a dead one.
- Opens **one rat wide** at first (N1).
- After breach it **stays open, and the inside face is blank** (D24). Mark it
  with a light stick or lose it. *(Fallback if that plays as infuriating rather
  than tense: the rind slumps closed but re-drills in ~5 s.)*

---

## 5. Assembling the world

The stack is data: one seeded JSON file, ordered outside-in. Recipes stay in
`recipes.ts` keyed by `recipe`; worldgen is deterministic from `seed` + spec, so
no geometry crosses the network.

| # | Layer | r out → r in | Mode | Part | Medium |
|---|---|---|---|---|---|
| 0 | Open water | 420 → 300 | — | — | water |
| 1 | The drift | 300 → 240 | `scatter` | drift crumb | water |
| 2 | **The Great Wheel** | 236 → 230 (6 u) | `hull` | dark rind | — |
| 3 | **Dark Veins — drifting** | 230 → 150 | `scatter` | roquefort, graded inward | water |
| 4 | **Dark Veins — the mass** | 150 → 90 | `fused` | roquefort | flooded |
| 5 | **The Melt** | 90 → 45 | `fused` | fondue | flooded, hot |
| 6 | **The Galleries** | 45 → 6 | `fused` | mite bore | flooded |
| 7 | The heart | 6 → 0 | `chunk` | fresh curd | flooded |

**There is no air-filled space anywhere in the game.** "Flooded" means the
carved voids inside a fused mass are full of water, same as everywhere else —
the game never leaves the swim/O₂ system. Air pockets are localized bubbles
seeded per-layer (`budgets.airPockets`), not a change of medium; the melt just
seeds more of them than any other layer, which is what makes it the run's last
generous refill.

**Rules the loader enforces at seed time — fail loudly, don't warn:**

| Rule | Constraint |
|---|---|
| Sealing | `tileSize ≥ 1.6 × 3.54 R / √tiles` — at R 233, `≥ 1331/√N`; N 150 → 109 |
| Crust amp | `amp × tileSize < thickness / 3` — at 6 u, `amp ≤ 0.018` |
| Resolution | `r × res ≥ 4` |
| Clearance | tunnels ≥ 1.3 u for cargo, ≥ 0.9 u for a rat — or fail *intentionally* |
| Reachability | flood-fill water from the bell: shell closed **and** soft spot + Gouda reachable |

The full JSON schema lives in `plan-mvp.md` §M2.

---

## 6. Fields `recipes.ts` needs

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
  temperature?: number;    // the melt — water heat, not a medium change
};
```

There is no `airFilled` flag. Every layer is water; the melt is `temperature`
turned up and a heavier `budgets.airPockets`, nothing else.

### `BiomePlacement` modes

```ts
| { mode: "scatter";                 // floating parts in water
    rMin: number; rMax: number;
    count: number;
    densityGrade?: "outward" | "inward" | "none";
    sizeGrade?: "outward" | "inward" | "none";   // the drifting veins get bigger inward
    sightline?: boolean }                        // enforce: each chunk visible from the last

| { mode: "hull";                    // generalises "shell" (K8)
    surface: "sphere" | "wheel";     // wheel = squat cylinder + rounded rim
    radius: number; height?: number;
    thickness: number;               // 6 for the Great Wheel — a husk
    hollow: boolean;                 // true = open water inside, not solid
    count: number;                   // validated against the closure formula
    softSpots: number }

| { mode: "fused";                   // K9 — overlapping, interiors connect
    rMin: number; rMax: number;
    count: number;
    overlap: number }                // fraction of chunk radius; > 0 guarantees fusion

| { mode: "chunk";                   // one authored piece — the heart
    radius: number }
```

---

## 7. Bench checklist

When a new part looks right in `/worldgen.html`, check it against these before
copying the numbers into `recipes.ts`:

- [ ] `r × res ≥ 4` for the smallest tunnel you care about
- [ ] Cut the camera inside — does a tunnel *feel* like a tunnel, or a pipe?
- [ ] Is the tightest route ≥ 0.9 u (rat) and ≥ 1.3 u (cargo), and is whichever
      it fails intentional?
- [ ] Would one carve from the tool you expect to be used here *erase* the
      feature you just tuned? (X3)
- [ ] Seal tiles only: does `crust.amp × size < thickness / 3` hold?
- [ ] Can you tell what the cheese is from 40 m, in fog, from silhouette and
      colour alone? (U7: one trait, one colour, one consequence — six parts fit
      that budget exactly; nine did not)
- [ ] For hull tiles: does `size ≥ 1.6 × 3.54 × R / √N` hold, and does the flood
      fill agree?
- [ ] Does the part give the player something to *do* that its neighbours in the
      stack don't?
