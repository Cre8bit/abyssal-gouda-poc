# Idea Register — Abyssal Gouda

The decision record. `plan-mvp.md` is the sequenced plan that comes out of it.
`cheese-parts.md` is the authoring companion: the part concepts and the
parameters you tune in the worldgen bench.

**Verdicts:** `IN` (in the roadmap) · `OUT` (killed, don't revive) ·
`LATER` (after v1.0) · `?` (open) · `BUILT` (already in the codebase) ·
`LOCKED` (settled foundation — changing it invalidates work downstream).

Dead entries are deleted rather than archived. If an idea isn't here, it
isn't coming back.

---

## 0. Locked decisions

| #   | Decision                                                                                                                                                                                                   | Consequence                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| D1  | **The map stays a ball approached from outside.** The bell keeps its berth; the opening shot — the whole structure seen from afar — is protected                                                           | No global tilt                                                                        |
| D2  | **The map floats until the warrens, then fuses.** The drift and the Wheel's hollow interior are discrete parts in water; from the warrens inward it becomes one continuous cheese body you are _inside_ of | You can't feel enclosed in an archipelago. Also the diegetic version of L2            |
| D2b | **The Great Wheel is hollow and water-filled** — devoured from the inside, a husk with a few metres of crust left. Its interior is open water, dark, and hosts its own floating-parts biome                | The first seal is a boundary, not a solid. Buys a whole biome inside the gate         |
| D3  | **The Gouda sits at the dead centre.** Every layer is between you and it, from every approach angle                                                                                                        | The geometry, not a rule, is what stops you skipping content                          |
| D4  | **The Gouda is fully hidden.** No HUD marker, ever. A carried **finder** instrument may pulse warm/cold, shipped disabled by default                                                                       | Enable only if playtests overrun                                                      |
| D5  | **No funnel.** The map is big and hard on purpose                                                                                                                                                          | Run-length risk is mitigated by the finder flag, never by shrinking the map           |
| D6  | **The Gouda is indivisible.** Got it or didn't                                                                                                                                                             | One beacon, one hand-off, one story                                                   |
| D7  | **Essence is the divisible resource** — carried, collected while exploring, **lost on death**, spent on revives, counted as score                                                                          | The entire replayability dial                                                         |
| D8  | **Death = spectate a teammate, for v1.** The run ends when **everyone** is dead                                                                                                                            | Downed/revive must be good, because they're what keeps full death rare                |
| D9  | **Lore = the Duplicator.** The Golden Gouda was the rat kingdom's cheese-duplicator. It was lost down here and left running — the whole abyss is its residue                                               | No employer, no famine. The world is evidence of the legend                           |
| D10 | **Air pockets inside certain cheese types are the primary O₂ refill**; the bell is the safe fallback                                                                                                       | Oxygen becomes a spatial resource, not a countdown                                    |
| D11 | **Oxygen must be easy to forget and sharp when it bites** — no nagging, hard panic escalation at the end                                                                                                   | Retuning + presentation, not a new system                                             |
| D12 | **Gates are the map's skeleton.** The seals _are_ the gates — no longer a parked feature                                                                                                                   | Everything about routing hangs off them                                               |
| D13 | **Hazards are LATER**, admitted one at a time, each tied to a cheese type and each with an offensive use                                                                                                   |                                                                                       |
| D14 | **One monster is not enough** for a 25-minute session — more threat types needed, post-MVP                                                                                                                 |                                                                                       |
| D15 | **Late joiners can drop into a run in progress**                                                                                                                                                           |                                                                                       |
| D16 | **Authoring = declarative part-type recipes + live sliders in the worldgen bench**                                                                                                                         | The tool you live in                                                                  |
| D17 | **Order: thin haul slice first, then biomes**                                                                                                                                                              | You can't tune "murder with cargo" without cargo                                      |
| D18 | **Sealed shells alternate with open bands.** A seal is a closed surface with no natural opening; the only way through is a soft spot                                                                       | You cannot swim around a sphere. Containment is geometric, not scripted               |
| D19 | **The spine is the breach points, not the geometry.** Each seal's soft spots sit 40–80° around the ball from the previous seal's                                                                           | The route wanders steeply through the map without any corridor existing               |
| D20 | **One slot per rat.** Big objects — the Gouda, the driller, a downed teammate — occupy the same pair of hands. Light sticks and essence live on the belt                                                   | Every carry is a choice not to carry something else. This is the cooperative engine   |
| D21 | **Seal rind is not drillable at all.** Only soft spots yield                                                                                                                                               | Armour, lock, key. No player ever drills the wrong wall for four minutes              |
| D22 | **A soft spot is hand-carvable at ~4× the time**                                                                                                                                                           | Losing the driller is a slower game, never a dead run                                 |
| D23 | **One driller per run, found in the drift.** Not issued at the bell                                                                                                                                        | The first act of every run is a search. Losing it is a disaster with a fallback (D22) |
| D24 | **A breach stays open, and the inside face is blank.** No landmark marks the door from within                                                                                                              | Somebody has to spend a light stick on it. Breadcrumbs become the load-bearing item   |
| D25 | **Two seals, not three.** Wax then crystal; object then horizon                                                                                                                                            | A third breach makes the verb routine                                                 |

---

## T · Foundations _(built)_

| ID  | Idea                                                            | Verdict |
| --- | --------------------------------------------------------------- | ------- |
| T1  | Destructible seeded SDF cheese world, marching cubes per chunk  | BUILT   |
| T2  | Seeded generation + seed in the invite link & handshake         | BUILT   |
| T3  | N-player full P2P mesh, 30 Hz binary poses + reliable events    | BUILT   |
| T4  | Proximity voice, HRTF spatialised                               | BUILT   |
| T5  | 7-bit player status bitmask — 5 used, 2 free                    | BUILT   |
| T6  | Oxygen clock, blackout, respawn, refill zone                    | BUILT   |
| T7  | Diving bell prop, spawn inside it, analytic collision           | BUILT   |
| T8  | Replicated item registry (`items.ts`) — no kinds registered yet | BUILT   |
| T9  | Systems bus (`registerSystem`)                                  | BUILT   |
| T10 | Lantern-catfish AI, host-authoritative + authority election     | BUILT   |
| T11 | Model/animation preview bench + worldgen bench                  | BUILT   |

---

## K · The cheese kit _(the authoring layer)_

| ID  | Idea                                                                                                | Verdict | Notes                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| K1  | **`PartRecipe` table** — shape family, size range, carve counts/radii, tags                         | BUILT   | `recipes.ts`                                                                                                   |
| K2  | **Live sliders in the bench** — reshape a part, watch it remesh, copy the numbers back              | BUILT   | `/worldgen.html`                                                                                               |
| K3  | **A biome is a recipe** — weighted part list, placement, material, fish flag                        | BUILT   |                                                                                                                |
| K4  | Bench view of a **biome sample slab**, not just one part                                            | IN      | You tune density by looking at density                                                                         |
| K5  | Headless shot per part type and per biome for visual regression                                     | IN      | The `?shot=` harness exists                                                                                    |
| K6  | **Four authored axes per part: hardness · porosity · odour · noise**                                | IN      | Replaces the "one verb per biome" field. See `cheese-parts.md`                                                 |
| K7  | **Trait budgets per biome** — `airPockets`, `essence`, `faults`, `softSpots` as seeded counts       | IN      | Tune scarcity by biome, not by chunk                                                                           |
| K8  | **`hull` placement mode** — generalises `shell` to any parametric surface (sphere, wheel, anything) | IN      | Both seals share one code path                                                                                 |
| K9  | **Fused placement mode** — overlapping chunks whose interiors connect, no water between             | IN      | D2's inner half. The actual fix for "nothing feels claustrophobic"                                             |
| K10 | **Flood-fill seal verification at seed time**                                                       | IN      | The only way to be sure a shell is closed once noise is in the pipeline. Doubles as the gold-reachability test |

---

## W · World & biomes

| ID  | Idea                                                                                                                                             | Verdict | Notes                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------- |
| W1  | Onion of concentric layers, R≈420                                                                                                                | BUILT   | Survives, and D18 gives it teeth                                                                                      |
| W5  | **A biome is a distinct way of moving**, not a colour                                                                                            | IN      | Now emergent from K6's axes rather than an authored `verb` field                                                      |
| W6  | **Air-pocket cheese** — sealed bubbles you dig into to refill O₂                                                                                 | IN      | D10                                                                                                                   |
| W7  | **Cheese that must be dug through** — no natural route                                                                                           | IN      | Makes the driller structural                                                                                          |
| W9  | Per-zone material, wax rind, fog and vein colour                                                                                                 | BUILT   | Necessary, not sufficient                                                                                             |
| W10 | Seeded set dressing: wrecked bells, dead divers, shrines                                                                                         | IN      | Best lore-per-dev-hour in the project. Also where the driller lives (D23)                                             |
| W11 | **Per-biome light range and fog density**                                                                                                        | IN      | Promoted from LATER. The dark biome does not exist without it                                                         |
| W12 | Thin blast walls with crack-glow (`getBlastPoints`)                                                                                              | BUILT   | Generated but unused — candidate for soft-spot marking                                                                |
| W13 | Round-trip time measurement and scale tuning                                                                                                     | IN      | Measure; don't shrink the map (D5)                                                                                    |
| W14 | **The scale rhythm**: small → colossal → medium → small → colossal → medium → intimate                                                           | IN      | Scale contrast does as much work as material contrast, and it's free                                                  |
| W15 | ~~The wheel exhales trapped gas on breach~~                                                                                                      | OUT     | D2b. The interior is water. Air stays scattered in the floating parts, as everywhere else                             |
| W16 | **The hollow has a floor and a ceiling** — collapsed debris piled at the bottom, the gnawed crown above, the warrens' mass hanging in the middle | IN      | A 200 u dark water ball is disorienting and empty. These are the three landmarks that fix it, and none of them are UI |
| W17 | **Density gradient inside the hollow** — thick with floating parts near the inner wall, thinning toward the middle                               | IN      | Otherwise the crossing is two minutes of nothing                                                                      |
| W18 | **The gnawed inner face** — uniformly chewed, no landmarks anywhere on it                                                                        | IN      | Reinforces D24: visually busy, so your own small breach hole is _harder_ to spot on the way back                      |

### The layer stack

Radii are world units, `worldR = 420`, gold at 0.

| Layer                      | R                   | Type                              | Built from            | What the player does                                                                            |
| -------------------------- | ------------------- | --------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| the berth                  | 470→420             | open water                        | —                     | leave the bell                                                                                  |
| **the drift**              | 420→240             | floating, sparse                  | drift crumb           | orient; find the driller; see the Wheel                                                         |
| **the Great Wheel's rind** | ~230, **4–6 thick** | **SEAL 1**                        | wax rind              | search the curve for a soft spot, then breach                                                   |
| **the hollow**             | 226→150             | floating, in open water, **dark** | emmental, drift crumb | breathe, hand-carve, stock up. The last generous air, and the first place with no ambient light |
| **the warrens**            | 150→95              | fused                             | mite-bored paste      | squeeze, separate, breadcrumb                                                                   |
| **the blue wall**          | ~88, 12–16 thick    | **SEAL 2**                        | crystal paste         | breach again — louder, brittler, nowhere to run                                                 |
| **the dark**               | 85→30               | fused                             | roquefort             | follow the veins; helmet light dies here                                                        |
| **the galleries**          | 30→                 | chambers                          | smear rind            | be hunted, in the open, after an hour of enclosure                                              |
| **the heart**              | core                | —                                 | fresh curd            | take it                                                                                         |

The rhythm is deliberate: **open → tight → blind → exposed → warm.** The
warrens and the dark are both "you can't see", for opposite reasons, so they
don't read as the same biome twice.

---

## N · Navigation & routing

| ID  | Idea                                                                                                           | Verdict | Notes                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| N1  | **Seals force the crew apart** — a soft spot is one rat wide at first                                          | IN      | D12. Best 4-player idea in the register, now structural                                         |
| N2  | **Search a curved surface for the real soft spot** among decoys                                                | IN      | Reads as a weeping, discoloured, mite-pitted bulge. Visible ~15 m, invisible beyond that in fog |
| N6  | Compass carries a **bell bearing on the way out**                                                              | IN      | Never a gold bearing (D4)                                                                       |
| N7  | **The finder** — carried instrument, warm/cold pulse, no bearing                                               | IN      | D4, shipped behind a flag                                                                       |
| N8  | **Light sticks as breadcrumbs — and as door markers**                                                          | IN      | D24 makes these load-bearing, not decorative                                                    |
| N9  | **Landmark sightlines** — each formation placed so the next one's silhouette is visible from the previous exit | IN?     | How the map reads without UI. Cheap where it applies, impossible inside fused mass              |

---

## C · Core loop & objectives

| ID  | Idea                                                                                                   | Verdict | Notes                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------- |
| C1  | **One win condition**: get the Golden Gouda into the bell                                              | IN      | Everything else is score                                                                                         |
| C2  | Score layered on top — essence, time, deaths                                                           | IN      | D7                                                                                                               |
| C3  | Target run: 15–25 min, 2–4 players, one-shot party session                                             | IN      |                                                                                                                  |
| C4  | **The Ascent** — pickup flips the world: heart goes dark, veins die back, ambience turns to alarm      | IN      | The fix for "the return is the same corridor backwards"                                                          |
| C5  | **Threat inversion** — the open water is _sparsely_ patrolled on the way in; the pickup makes it swarm | IN      | Revised: the outer half is no longer empty (E2), so the inversion is density and aggression rather than presence |
| C6  | **The run ends when everyone is dead**                                                                 | LOCKED  | D8                                                                                                               |
| C7  | Victory screen + run summary + replay with a fresh seed                                                | IN      |                                                                                                                  |
| C8  | Late joiners drop into a run in progress                                                               | LOCKED  | D15                                                                                                              |
| C9  | Ranks/grades on the summary                                                                            | LATER   |                                                                                                                  |

---

## G · The Golden Gouda

| ID  | Idea                                                                                                    | Verdict | Notes                                                   |
| --- | ------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------- |
| G1  | Replicated item, host-arbitrated pickup                                                                 | IN      | One new message: `pick` request → authoritative `item*` |
| G2  | **Carried in arms with hand-off and drop** — occupies the slot (D20), hold in front, slow swim          | LOCKED  | Reuses carry code for downed-body drag (S6)             |
| G3  | **Weight** — negative buoyancy, reduced speed cap                                                       | IN      |                                                         |
| G4  | **The light tradeoff** — carrier's helmet light forced off, the Gouda lights a wide radius for everyone | IN      | Carrier is the party's lamp _and_ the party's beacon    |
| G5  | **Throwable / passable** — including across a gap, which is the good version of moving the driller too  | IN      |                                                         |
| G6  | **Dropped, it falls** — toward the centre, away from home. Recoverable, but you've lost the time        | IN      | Works because of D3                                     |
| G7  | **One unrecoverable place** — the outer void past the boundary                                          | IN      | Makes the last stretch to the bell the tensest 30 s     |
| G9  | The fish is drawn to the Gouda's light                                                                  | IN      | Should be explicit, not implied                         |

---

## S · Survival, death & essence

| ID  | Idea                                                                                                  | Verdict | Notes                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Oxygen as the personal clock                                                                          | BUILT   |                                                                                                                                                                                 |
| S2  | **Retune O₂: easy to forget, brutal when it bites**                                                   | IN      | D11                                                                                                                                                                             |
| S3  | **Air pockets are the main refill**, bell is the safe fallback; pockets are consumable and seeded     | IN      | D10                                                                                                                                                                             |
| S4  | **Downed, not dead** — limp and sinking, still on voice, countdown, revived by a teammate sharing air | IN      | Carries extra weight under D8                                                                                                                                                   |
| S5  | **Essence** — carried while exploring, **lost on death**, spent on revives, counted as score          | LOCKED  | D7                                                                                                                                                                              |
| S6  | Dragging a downed body = the slot (D20), reusing G2's code path                                       | IN      | One carry system, several payloads                                                                                                                                              |
| S7  | Full death → spectate a living teammate                                                               | LOCKED  | D8                                                                                                                                                                              |
| S8  | The wisp — fly through the world, ping for the living                                                 | LATER   | Design the death state so it slots in without rework                                                                                                                            |
| S9  | **The Joker** — spend essence on a desperation gamble when the run is falling apart                   | LATER   |                                                                                                                                                                                 |
| S10 | **The air curve**: surplus in the drift and the hollow, deficit from the warrens inward               | IN      | Emerges from the materials — young gassy cheese outside, aged dry cheese inside. The last generous air is the emmental floating in the hollow, and it should feel like the last |
| S11 | **Popped pockets stay popped**, and read as visibly deflated                                          | IN      | The way home is drier than the way in, through the same rooms                                                                                                                   |

---

## E · Threats

| ID  | Idea                                                                                                                                            | Verdict | Notes                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Lantern catfish                                                                                                                                 | BUILT   |                                                                                                                                                                                                                               |
| E2  | **The catfish is an open-water animal** — the drift and the space around the Wheel, sparse on the way in                                        | IN      | It patrols the outside. It does not belong in the enclosed layers                                                                                                                                                             |
| E3  | **More threat types** — one monster can't carry 25 minutes                                                                                      | LATER   | D14                                                                                                                                                                                                                           |
| E8  | **The hollow has its own inhabitant** — whatever devoured the Wheel from inside is a different creature from the catfish, and this is its space | IN?     | The design slot is reserved by D2b even though the creature isn't designed. For MVP the hollow can run empty or borrow the catfish; the _shape_ of the space (dark, open, floating cover) is what a future mob gets built for |
| E4  | **Noise attraction** — dig noise scaled by tool and material (K6), plus mic volume                                                              | IN?     | Promoted from LATER because K6 makes it nearly free: the driller on hard cheese is the loudest thing in the game                                                                                                              |
| E5  | Speech bubbles from mic activity                                                                                                                | LATER   |                                                                                                                                                                                                                               |
| E6  | Blinding the fish with ≥3 nearby light sticks                                                                                                   | LATER   |                                                                                                                                                                                                                               |
| E7  | Gouda-coloured lures in the foggy biomes                                                                                                        | LATER   |                                                                                                                                                                                                                               |

---

## H · Hazards _(all LATER, D13)_

| ID  | Idea                                                                                                                                                            | Verdict | Notes                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------- |
| H0  | **The rule**: a hazard that only taxes you is friction; one you can weaponise is a story. Nothing ships without an offensive use _and_ a cheese type to live in | IN      |                                                                             |
| H1  | Vacuum pockets → **elevators**: ride the suction                                                                                                                | LATER   |                                                                             |
| H2  | Fermentation gas → **blows walls open**; voice lowpass + coughing inside                                                                                        | LATER   | The surviving half of the dead W15 — gas as a weapon rather than as scenery |
| H3  | Rat-poison veins → dig out and **throw at the fish**                                                                                                            | LATER   |                                                                             |
| H4  | Giant rat traps → **drag, re-arm, catch the fish**                                                                                                              | LATER   |                                                                             |

---

## I · Items & tools

| ID  | Idea                                                                                               | Verdict | Notes                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| I1  | ~~Pickaxe~~ — **deleted**. Hands or driller, nothing between                                       | IN      | The two-tier tool ladder is the whole hardness system                                                                        |
| I2  | **Hand-carving** — works on soft cheese only, slow, near-silent, and **leaves the slot free**      | IN      | In soft biomes the Gouda carrier is still useful; in hard ones they're cargo. Sequencing materials _is_ the difficulty curve |
| I3  | **The driller** — one per run (D23), occupies the slot, opens soft spots and hard paste, deafening | IN      |                                                                                                                              |
| I4  | **Light sticks** — droppable, slow float, instanced sprites + a pool of 4 PointLights              | IN      | AC: 60 fps with 40 placed. Door-marking (D24) is their real job                                                              |
| I5  | Air sharing (the S4 revive verb)                                                                   | IN      | Not an item — a gesture                                                                                                      |
| I6  | The finder (= N7)                                                                                  | IN      | Flag-gated                                                                                                                   |
| I7  | ~~Air flasks / tanks in hand~~                                                                     | OUT     | The slot is for objects that create decisions, not consumables                                                               |

---

## L · Lore & framing

| ID  | Idea                                                                                                                                                                | Verdict | Notes                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------ |
| L1  | **The Duplicator** — the Golden Gouda was the rat kingdom's cheese-duplicator, lost in the abyss and left running. The whole cheese world is its residue            | LOCKED  | D9                                   |
| L2  | **Density is diegetic** — the closer in, the more cheese, until it stops being objects and becomes one body (D2). The centre is _fresh_; the crust is centuries old | IN      | Ties worldgen to lore for free       |
| L3  | **Chalk manifest on the bell wall** — worn, contradictory, added to by previous crews. Tutorial _and_ lore on one surface                                           | IN      | You already wake up facing that wall |
| L4  | Shrines by earlier divers; the catfish is what happens to a rat who **ate** instead of carrying — implied, never stated                                             | IN?     |                                      |
| L5  | No narrator, no radio — the world tells you                                                                                                                         | IN      |                                      |

---

## U · Legibility & teaching

| ID  | Idea                                                                               | Verdict | Notes                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | Bell placard tutorial (= L3)                                                       | IN      | Diegetic, unmissable, zero UI                                                                                                                       |
| U2  | One-line HUD objective that changes state: _Find it_ → _Bring it back_ → _GET OUT_ | IN      |                                                                                                                                                     |
| U3  | Carry indicator — what's in your hands, always                                     | IN      | D20 makes this mandatory                                                                                                                            |
| U4  | Compass return marker (= N6)                                                       | IN      |                                                                                                                                                     |
| U5  | Run summary — time, essence, who died, who dropped it, **who marked the door**     | IN      | The screen people screenshot                                                                                                                        |
| U6  | O₂ bar — quiet by default, loud at the end                                         | IN      | D11                                                                                                                                                 |
| U7  | **One trait = one colour = one consequence**, ~7 signatures maximum                | IN      | With fog you get maybe five readable colours. Spend the palette on traits, not on zones — two zones may share a look if they differ in how you move |
| U8  | README is stale (claims a gold compass marker that D4 says will never exist)       | IN      |                                                                                                                                                     |

---

## Known defects

| ID  | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | **The crust shell is leaking.** `radius 155, count 48` gives a centre spacing of ≈79 u, but `sizeBase 60` is a chunk radius of ~30 — the tiles don't even touch, before the noise crust eats the edges. Closing it needs `size ≈ 127` at count 48, or count ≈ 215 at size 60. K10's flood fill is what should have caught this                                                                                                                                                                                                                                                                                                                                                                                                                             |
| X2  | **Tunnels read open even when they're numerically narrow.** Three causes, all fixable in data: chambers every few metres (`eyes 18–26`), too few marching-cubes cells per tunnel radius, and `exits: 2` per chunk with open water between chunks. See `cheese-parts.md` §"Why nothing feels tight"                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| X3  | **`DIG_RADIUS = 2.4` erases the labyrinth.** One carve is a 4.8 u sphere — wider than a mite-bored tunnel (2.0 u across) and roughly the whole thickness of the Wheel's crust (D2b). As it stands, a single click destroys the biome it's used in and punches straight through the first seal. **Digging must be per-tool**: hands ≈ 0.7, driller ≈ 2.4. Blocks M2                                                                                                                                                                                                                                                                                                                                                                                         |
| X4  | **Noise crust can self-perforate a thin shell.** Surface noise displaces by `crust.amp × size` — 0.10 on a size-70 tile is 7 u, more than the Wheel's whole crust. Rule: `crust.amp × size < thickness / 3`, enforced for any part tagged `seal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| X5  | **A dig that lands short says nothing.** `raycastSolid` stops at raw `d < 0.4`; the field under-reports, so the hit sits a median 0.26 u (p99 0.64 u) in front of the surface. In **0.9 % of aims overall and 2.0 % in the galleries** that is further than the hands radius (0.7), so `digAt` returns `changed: false, rejected: false` and [main.ts](../src/main.ts) falls through **with no message at all** — the player clicks a wall and gets silence. The cheap fix is feedback on that branch (or nudging the hit point down the ray), not normalising `raycastSolid`. Numbers in [bug-collision-render-desync.md](bug-collision-render-desync.md) §3                                                                                              |
| X6  | **Interpenetrating scatter chunks cannot compose their carves.** `shareCarves()` skips ellipsoid pairs, so two overlapping floats are each other's invisible walls; Fix B1 forbids the overlap at placement (`guard ≥ scatterSurfaceRadius`) rather than fixing it. Doing it properly (B2) means dropping the skip — but `rotate` gives every veins chunk its own seeded spin axis and rate, and carves are stored chunk-local, so a borrowed carve cannot be expressed in a static local frame. B2 needs **spin per sightline-cluster instead of per chunk**: a design change with its own fingerprint rebase. Only worth it if the veins ever want to interpenetrate on purpose. See [bug-collision-render-desync.md](bug-collision-render-desync.md) §2 |

---

## Still open

| ID  | Question                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q3  | What are the other threat types? (E3, post-MVP)                                                                                                            |
| Q4  | Does a late joiner spawn in the bell mid-run, or somewhere else? (D15 detail)                                                                              |
| Q5  | Are seal 2's soft spots visible from the **inside** face? If yes, the return through the blue wall is trivial and all the tension lives in the outer wheel |
| Q6  | Can a soft spot, once opened, be re-opened from either side? Determines whether a split crew can regroup or is committed                                   |
| Q7  | Does the driller wear out — charge, fuel, or breaks after N breaches? If it's permanent, the seals stop mattering on the ascent                            |
| Q8  | Roquefort veins: always a route, or ~30% dead ends? Always-a-route is a corridor with mood                                                                 |
