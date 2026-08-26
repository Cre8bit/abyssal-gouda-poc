# Idea Register — Abyssal Gouda

The decision record. `plan-mvp.md` is the sequenced plan that comes out of it;
`plan-game-loop.md` is the original engineering plan, kept as history.

**Verdicts:** `IN` (in the roadmap) · `OUT` (killed, don't revive) ·
`LATER` (after v1.0) · `?` (open) · `BUILT` (already in the codebase) ·
`LOCKED` (settled foundation — changing it invalidates work downstream).

---

## 0. Locked decisions

| # | Decision | Consequence |
|---|---|---|
| D1 | **The map stays a ball approached from outside.** The bell keeps its berth; the opening shot — the whole structure seen from afar — is protected | No global tilt |
| D2 | **The mass stays made of floating cheese parts** of varying type, size and density, as today | *Revised.* The "one fused rind" rework is dead. Differentiation comes from part types and verbs, not from a new silhouette |
| D3 | **The gold sits below the equator** — the route inward is also a route down | The return is an ascent; a dropped Gouda falls away from home |
| D4 | **The Gouda is fully hidden.** No HUD marker, ever. A carried **finder** instrument may pulse warm/cold, shipped disabled by default | Enable only if playtests overrun |
| D5 | **No funnel.** The map is big and hard on purpose | Run-length risk is mitigated by the finder flag, never by shrinking the map |
| D6 | **The Gouda is indivisible.** Got it or didn't | One beacon, one hand-off, one story |
| D7 | **Essence is the divisible resource** — carried, collected while exploring, **lost on death**, spent on revives, counted as score | The entire replayability dial |
| D8 | **Death = spectate a teammate, for v1.** The wisp is parked. The run ends when **everyone** is dead | Downed/revive must be good, because they're what keeps full death rare |
| D9 | **Lore = the Duplicator.** The Golden Gouda was the rat kingdom's cheese-duplicator. It was lost down here and left running — the whole abyss is its residue | *Revised.* No employer, no Famine. The world is evidence of the legend |
| D10 | **Air pockets inside certain cheese types are the primary O₂ refill**; the bell is the safe fallback | Oxygen becomes a spatial resource, not a countdown |
| D11 | **Oxygen must be easy to forget and sharp when it bites** — no nagging, hard panic escalation at the end | Retuning + presentation, not a new system |
| D12 | **Gates are LATER**, kept as a concepts doc — including one-player-wide tunnels that force the crew apart | Too good to lose, not first |
| D13 | **Hazards are LATER**, admitted one at a time, each tied to a cheese type and each with an offensive use | |
| D14 | **One monster is not enough** for a 25-minute session — more threat types needed, post-MVP | |
| D15 | **Late joiners can drop into a run in progress** | |
| D16 | **Authoring = declarative part-type recipes + live sliders in the preview bench** | The tool you'll live in |
| D17 | **Order: thin haul slice first, then biomes** | You can't tune "murder with cargo" without cargo |

---

## T · Foundations *(built)*

| ID | Idea | Verdict |
|---|---|---|
| T1 | Destructible seeded SDF cheese world, marching cubes per chunk | BUILT |
| T2 | Seeded generation + seed in the invite link & handshake | BUILT |
| T3 | N-player full P2P mesh, 30 Hz binary poses + reliable events | BUILT |
| T4 | Proximity voice, HRTF spatialised | BUILT |
| T5 | 7-bit player status bitmask — 5 used, 2 free | BUILT |
| T6 | Oxygen clock, blackout, respawn, refill zone | BUILT |
| T7 | Diving bell prop, spawn inside it, analytic collision | BUILT |
| T8 | Replicated item registry (`items.ts`) — no kinds registered yet | BUILT |
| T9 | Systems bus (`registerSystem`) | BUILT |
| T10 | Lantern-catfish AI, host-authoritative + authority election | BUILT |
| T11 | Model/animation preview bench | BUILT |

---

## K · The cheese kit *(the authoring layer — new)*

| ID | Idea | Verdict | Notes |
|---|---|---|---|
| K1 | **`CheesePartType` recipe table** — shape family, size range, hole/tunnel params, interior density, material, verb tags | IN | D16. The thing every biome is assembled from |
| K2 | **Live sliders in the preview bench** — reshape a part, watch it remesh, copy the numbers back into the table | IN | D16 |
| K3 | **A biome is a recipe** — weighted list of part types, spacing/density, fog, vein colour, whether the fish may enter | IN | Makes "add a biome" a data change |
| K4 | Bench view of a **biome sample slab**, not just one part | IN | You tune density by looking at density |
| K5 | Headless shot per part type and per biome for visual regression | IN | The `?shot=` harness already exists |
| K6 | Part tags that gameplay reads: `air-pocket`, `dig-through`, `thread`, `solid` | IN | The bridge between worldgen and mechanics |

---

## W · World & biomes

| ID | Idea | Verdict | Notes |
|---|---|---|---|
| W1 | Onion of concentric biomes, R≈420 | BUILT | Survives |
| W2 | ~~Tilt the whole map vertical~~ | OUT | D1 |
| W3 | ~~A spine fissure through every layer~~ | OUT | D1 |
| W4 | ~~Fuse the outer layers into one rind~~ | OUT | D2 |
| W5 | **One verb per biome**, not one colour | IN | The fix for "my biomes feel the same" |
| W6 | **Air-pocket cheese** — sealed bubbles you dig into to refill O₂ | IN | D10 |
| W7 | **Solid cheese that must be fully dug through** — no natural route | IN | Makes the pickaxe structural |
| W8 | Gold band biased below the equator | LOCKED | D3 |
| W9 | Per-zone material, wax rind, fog and vein colour | BUILT | Decoration — necessary, not sufficient |
| W10 | Seeded set dressing: wrecked bells, dead divers, shrines | IN? | Best lore-per-dev-hour in the project |
| W11 | Biome physics modifiers (speed, drag, fog boost) | LATER | |
| W12 | Thin blast walls with crack-glow (`getBlastPoints`) | BUILT | Generated but unused |
| W13 | Round-trip time measurement and scale tuning | IN | Measure; don't shrink the map to fix it (D5) |

### Biome verbs — to be filled in during the biome pass

| Layer | Verb | Cheese types | Status |
|---|---|---|---|
| drift | orient | sparse, pale | ? |
| reef | thread | thin slabs, big through-holes | ? |
| scree | dig | small cut blocks | ? |
| warrens | separate | long tangled narrow tunnels | ? |
| crust | ? | giant fused hunks | ? |
| galleries | be hunted | cathedral wheels | ? |
| bulwark | ? | sealed, meaner | ? |
| hollows | squeeze | cramped wheels | ? |
| heart | take it | colossal hunk | ? |

---

## N · Navigation & gates

| ID | Idea | Verdict | Notes |
|---|---|---|---|
| N1 | **Gates that force the crew apart** — one-player-wide tunnels through a hard crust | LATER | D12. Best 4-player idea in the register |
| N2 | Gate 1 *found* — search a surface for the real opening among dead ends | LATER | D12 |
| N3 | Gate 2 *made* — rotten soft spots, ~20 s of loud sustained digging | LATER | D12 |
| N4 | Gates close behind you after pickup, forcing a different route home | LATER | D12 |
| N5 | ~~The funnel constraint~~ | OUT | D5 |
| N6 | Compass carries a **bell bearing on the way out** | IN | Never a gold bearing (D4) |
| N7 | **The finder** — carried instrument, warm/cold pulse, no bearing | IN | D4, shipped behind a flag |
| N8 | Light sticks as breadcrumbs | IN | |

---

## C · Core loop & objectives

| ID | Idea | Verdict | Notes |
|---|---|---|---|
| C1 | **One win condition**: get the Golden Gouda into the bell | IN | Everything else is score |
| C2 | Score layered on top — essence, time, deaths | IN | D7 |
| C3 | Target run: 15–25 min, 2–4 players, one-shot party session | IN | |
| C4 | **The Ascent** — pickup flips the world: heart goes dark, veins die back, ambience turns to alarm | IN | The fix for "the return is the same corridor backwards" |
| C5 | Fish switches to an aggressive profile on pickup | IN | Tuning constants, no new AI |
| C6 | **The run ends when everyone is dead** | LOCKED | D8 |
| C7 | Victory screen + run summary + replay with a fresh seed | IN | |
| C8 | Late joiners drop into a run in progress | LOCKED | D15 |
| C9 | Ranks/grades on the summary | LATER | |
| C10 | Meta-progression / unlocks between runs | OUT | |

---

## G · The Golden Gouda

| ID | Idea | Verdict | Notes |
|---|---|---|---|
| G1 | Replicated item, host-arbitrated pickup | IN | Needs one new message: `pick` request → authoritative `item*` |
| G2 | **Carried in arms with hand-off and drop** — hold in front, slow swim, hand-off to teammates when close, drop on damage/sprint | LOCKED | Simple, readable, cooperative. Reuses carry code for downed-body drag (M7). Loseable on fumble. |
| G3 | **Weight** — negative buoyancy, reduced speed cap. One tuning for 2 and 4 players | IN | |
| G4 | **The light tradeoff** — carrier's flashlight forced off, but the Gouda lights a wide radius for everyone | IN | Carrier is the party's lamp *and* the party's beacon |
| G5 | **Throwable / passable** to a teammate | IN | Depends on the G2 outcome |
| G6 | **Dropped, it falls** away from home. Recoverable, but you've lost the time | IN | Works because of D3 |
| G7 | **One unrecoverable place** — the outer void past the boundary | IN | Makes the last stretch to the bell the tensest 30 s |
| G8 | ~~Splitting the wheel into wedges~~ | OUT | D6 |
| G9 | The fish is drawn to the Gouda's light | IN | Should be explicit, not implied |

---

## S · Survival, death & essence

| ID | Idea | Verdict | Notes |
|---|---|---|---|
| S1 | Oxygen as the personal clock | BUILT | |
| S2 | **Retune O₂: easy to forget, brutal when it bites** — quiet HUD, no nagging, hard escalation in the last stretch | IN | D11 |
| S3 | **Air pockets are the main refill**, bell is the safe fallback; pockets are consumable and seeded | IN | D10 — knowing where you left one matters on the way back |
| S4 | **Downed, not dead** — limp and sinking, still on voice, countdown, revived by a teammate sharing air | IN | Carries extra weight under D8 |
| S5 | **Essence** — carried while exploring, **lost on death**, spent on revives, counted as score | LOCKED | D7 |
| S6 | Dragging a downed body = heavy carry, reusing G3's code path | IN | One carry system, several payloads |
| S7 | Full death → spectate a living teammate | LOCKED | D8 |
| S8 | The wisp — fly through the world, ping for the living | LATER | D8. Design the death state so it can slot in without rework |
| S9 | **The Joker** — spend essence on a desperation gamble (lucky-wheel style) when the run is falling apart | LATER | Your idea, parked as a concept |

---

## E · Threats

| ID | Idea | Verdict | Notes |
|---|---|---|---|
| E1 | Lantern catfish | BUILT | |
| E2 | Fish confined to specific biomes | IN | Makes those biomes mean something |
| E3 | **More threat types** — one monster can't carry 25 minutes | LATER | D14. Needs its own design pass |
| E4 | Noise attraction (dig noise + mic volume as attractor) | LATER | |
| E5 | Speech bubbles from mic activity | LATER | |
| E6 | Blinding the fish with ≥3 nearby light sticks | LATER | |
| E7 | Gouda-coloured lures in the foggy biomes | LATER | |

---

## H · Hazards *(all LATER, D13)*

| ID | Idea | Verdict | Notes |
|---|---|---|---|
| H0 | **The rule**: a hazard that only taxes you is friction; one you can weaponise is a story. Nothing ships without an offensive use *and* a cheese type to live in | IN | |
| H1 | Vacuum pockets → **elevators**: ride the suction | LATER | |
| H2 | Fermentation gas → **blows walls open**; voice lowpass + coughing inside | LATER | |
| H3 | Rat-poison veins → dig out and **throw at the fish** | LATER | |
| H4 | Giant rat traps → **drag, re-arm, catch the fish** | LATER | |

---

## I · Items & tools

| ID | Idea | Verdict | Notes |
|---|---|---|---|
| I1 | Pickaxe / dig | BUILT | |
| I2 | Minimal hotbar | IN | |
| I3 | Light sticks — droppable, slow float, instanced sprites + 4 PointLights | IN | AC: 60 fps with 40 placed |
| I4 | Air sharing (the S4 revive verb) | IN | |
| I5 | The finder (= N7) | IN | Flag-gated |

---

## L · Lore & framing

| ID | Idea | Verdict | Notes |
|---|---|---|---|
| L1 | **The Duplicator** — the Golden Gouda was the rat kingdom's cheese-duplicator, lost in the abyss and left running. The whole cheese world is its residue | LOCKED | D9. The world is evidence of the legend |
| L2 | Density is diegetic: the closer you get, the more cheese there is, because the thing has been copying itself down there for centuries | IN | Ties worldgen to lore for free |
| L3 | **Chalk manifest on the bell wall** — worn, contradictory, added to by previous crews. Tutorial *and* lore on one surface | IN | You already wake up facing that wall |
| L4 | Shrines by earlier divers; the catfish is what happens to a rat who **ate** instead of carrying — implied, never stated | IN? | |
| L5 | No narrator, no radio — the world tells you | IN | |
| L6 | ~~The Company / corporate handler~~ | OUT | D9 |
| L7 | ~~The Famine~~ | OUT | D9 |

---

## U · Legibility & teaching

| ID | Idea | Verdict | Notes |
|---|---|---|---|
| U1 | Bell placard tutorial (= L3) | IN | Diegetic, unmissable, zero UI |
| U2 | One-line HUD objective that changes state: *Find it* → *Bring it back* → *GET OUT* | IN | |
| U3 | Carry indicator | IN | |
| U4 | Compass return marker (= N6) | IN | |
| U5 | Run summary — time, essence, who died, who dropped it | IN | The screen people screenshot |
| U6 | O₂ bar — quiet by default, loud at the end | IN | D11 |
| U7 | README is stale (claims a gold compass marker that D4 says will never exist) | IN | |

---

## Still open

| ID | Question |
|---|---|
| Q2 | Which biome gets which verb, and which cheese types build it? The biome pass answers this |
| Q3 | What are the other threat types? (E3, post-MVP) |
| Q4 | Does a late joiner spawn in the bell mid-run, or somewhere else? (D15 detail) |
