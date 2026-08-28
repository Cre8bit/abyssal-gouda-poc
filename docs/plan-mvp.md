# MVP Roadmap — Abyssal Gouda

The sequenced plan. Decisions behind it live in `idea-register.md` (§0);
part concepts, look, and generator parameters live in `cheese-parts.md`.

**The pitch, one sentence:**

> Rats dive into a cheese abyss to recover the Golden Gouda — the kingdom's
> lost cheese-duplicator, still running — and haul it home before their air
> runs out.

**Done when** four people who've never seen it can be dropped in with no
explanation, a run ends in a win or a wipe inside 25 minutes, at least one
moment per run is worth retelling, and you can add a new cheese type or a new
layer without writing generator code.

---

## The spine — one gate, two biomes, one labyrinth

```
OPEN WATER  →  DRIFT  →  ▮ THE GREAT WHEEL ▮  →  THE DARK VEINS  →  THE MELT  →  THE GALLERIES ◉
   orient      scavenge      BREACH (the gate)     navigate blind     survive heat    get lost / take it
```

Five stops, one gate, one prize. Everything else is score.

**One gate only.** The blue wall (seal 2) is cut from MVP. The Wheel is the
single *the world has a door and you have to find it* moment, and doing it twice
made the verb routine. Later gates are an **insert between biomes** — the layer
spec below already supports them, so adding one is data, not code.

**Biome order is fixed for MVP** (veins, then melt). The stack is an ordered
array, so shuffling it later is one line and a re-run of the flood fill.

### The layer ladder — world units, sphere, Gouda at r = 0

| # | Layer | r out → r in | Mode | Part | Medium | Verb |
|---|---|---|---|---|---|---|
| 0 | Open water | 420 → 300 | — | — | water | leave, orient |
| 1 | The drift | 300 → 240 | `scatter` | drift crumb | water | scavenge — the driller wreck |
| 2 | **The Great Wheel** | 236 → 230 (**6 u**) | `hull` | dark rind | — | **breach** |
| 3 | The flooded belly | 230 → 150 | `scatter` | drift crumb, graded | water | fall, find the far wall |
| 4 | **The Dark Veins** | 150 → 90 | `fused` | roquefort | — | navigate by veins |
| 5 | **The Melt** | 90 → 50 | `fused` | fondue | **air** | cross the hot chambers |
| 6 | **The Galleries** | 50 → 6 | `fused` | mite bore | — | get lost |
| 7 | The heart | 6 → 0 | `chunk` | fresh curd | air pocket | take it |

Descent ≈ 420 u. Target ~12 min in, ~8 min out — the Ascent is shorter because
the route is already opened and the air pockets are already popped.

The **flooded belly** is not a biome and gets no new part: it is the drift's
crumb, re-seeded dark and graded thick near the inner wall and thinning inward
(W17), with a debris floor and the gnawed crown above (W16). Its whole job is to
be the first genuinely dark place and to make the Wheel feel hollow.

The Wheel is a **classic dark natural rind**, not wax — see `cheese-parts.md`
§3. That matters here for one reason: a 6 u husk cannot carry surface noise, so
its identity is texture and colour work, not geometry work, and it belongs to
whoever does materials rather than to worldgen.

---

## How to read this

Milestones are ordered by **what unblocks judgement**, not by what's exciting.
Between them are **⏸ WAIT gates**: points where you stop building and go play,
because the next milestone's design depends on an answer you cannot get from
the chair.

A gate has three parts: the question, what you do if the answer is *no*, and
what it unlocks. **Don't build past a gate you haven't run.**

| # | Milestone | Days | Cum. | Gate after |
|---|---|---|---|---|
| M1 | The thin haul | 3 | 3 | ⏸ A |
| M2 | **The world — parts, biomes, procedural stack** | 10 | 13 | ⏸ B |
| M3 | The gate as an event | 4 | 17 | ⏸ C |
| M4 | The slot | 2 | 19 | |
| M5 | The melt | 3 | 22 | ⏸ D |
| M6 | Air that bites | 2 | 24 | |
| M7 | The dark | 2 | 26 | |
| M8 | Legibility | 3 | 29 | ⏸ E |
| M9 | The Ascent & the inversion | 3 | 32 | |

**≈32 working days — six to seven weeks to MVP.** Down from 36: one seal
instead of two, six parts instead of nine, and essence/death/the finder parked
below. Up by three for the melt, the one genuinely new system.

**The map is M2, and it is one milestone, not four.** The old plan drip-fed
worldgen across three milestones with gates between the fragments, which meant
the world only existed at day 21 and every gate before that judged a slab in a
bench. Building the whole procedural pipeline in one block — hardness axes,
both placement modes, the seeded layer spec, the six parts, the assembled stack
— means the real world exists on **day 13** and everything after it is judged
against an actual descent. It is the largest single milestone in the plan and it
should be: it's the product.

---

## M1 — The thin haul · 3 days

Strip the haul to the bone so the world has cargo to be judged against. No
throwing, no polish, no world-change. Still day one: it's the highest-variance
unknown in the design, and it runs fine on the current placeholder world.

**M1.1 · Carry in arms, with hand-off and drop** *(1 d)*
Held in front, visible and heavy. Constant drag on swim speed (~−4 u/s),
sprint drain 1.8×. **Hand-off** at ~3 m with a prompt — the main cooperative
verb. **Drop** on damage or over-sprint, with ~3 s to catch it before it's
gone. Same code path later serves the driller and downed bodies.

**M1.2 · Gouda as an item** *(1 d)*
Retire the decorative `goldCore` in `gouda.ts`; register an `items.ts` kind
`gouda`, seeded at the world centre (D3) so it costs zero network. Contested
pickup needs the one piece of protocol `items.ts` lacks: a `pick` request
(joiner → host) answered by an authoritative `item*`. Carrier flag = the
already-reserved `STATUS.CARRYING`.
*AC:* two clients agree on the holder 100% of the time, including simultaneous
grabs.

**M1.3 · Weight, light, and the bell** *(1 d)*
Negative buoyancy (~−4 u/s, beatable by swim spam), reduced speed cap,
**carrier's helmet light forced off** while the Gouda lights a wide radius for
everyone. Gouda inside the bell's hatch radius → run ends, placeholder win
screen.
*AC:* a full run, start to win screen, at 2 players, on the current world.

> ### ⏸ WAIT — Gate A · *Is hauling it interesting?*
>
> Two players, current map, no other changes. Get it from the middle to the
> bell.
>
> **Ask:** is moving this thing through a tunnel an activity, or a walk with a
> speed debuff? Does the hand-off get used, or does one person just carry it
> the whole way?
>
> **If no:** the fix is the transport scheme and the buoyancy curve — throwing,
> tethers, two-rat carry — **not** more features downstream. M2 authors an
> entire world around the assumption that cargo is fun to move, so this is
> genuinely the cheapest day to find out it isn't.
>
> **Unlocks:** M2, which is the expensive one.

---

## M2 — The world · 10 days · *parts, biomes, and the procedural stack*

Build the map. All of it, in one block: the material axes, both placement
modes, the seeded layer spec, the six cheeses, the assembled world. At the end
of this milestone you can swim from the bell to the heart through the real
thing.

Sub-steps are ordered so each one unblocks the next, and the two hard
engineering risks (`fused`, `hull`) land before the content pass that depends on
them.

**M2.1 · The axes and the per-tool dig radius** *(1 d)* — **blocks everything.**
`hardness | porosity | odour` on `PartRecipe`, noise derived as
`hardness × tool`. And fix X3: `DIG_RADIUS = 2.4` carves a 4.8 u sphere — wider
than a gallery tunnel and **thicker than the whole 6 u Wheel crust**. One click
currently erases the biome it's used in. Hands ≈ 0.7 u, driller ≈ 2.4 u.
Nothing below is authorable until this exists, and it's why it's the first half
day of the milestone rather than a fix later.

**M2.2 · `fused` placement** *(2 d)* — overlapping chunks whose interiors
connect, with an `overlap` fraction guaranteeing fusion and no water between.
Three of the five layers are fused; an archipelago of hollow chunks can never
feel enclosed however you carve it. Profile here: small chunks at high res is
the expensive corner of the pipeline.

**M2.3 · `hull` placement and closure** *(2 d)* — tile chunks over a parametric
surface, `surface: "wheel"` (squat cylinder + rounded rim), `hollow: true`.
Validate `size ≥ 1.6 × 3.54 R/√N` at build time. Seal tiles get
`noCarveWithin` so no eye touches either face, and the thin-shell cap
`crust.amp × size < thickness / 3` is enforced (X4) — at 6 u that caps `amp` at
0.018 and the Wheel is smooth by law.

**M2.4 · The seeded layer spec** *(1.5 d)* — one JSON file per world, ordered
outside-in. Deterministic from `seed` + spec, so no geometry crosses the
network. Loader, schema validation, and the rules table below enforced at seed
time — **fail loudly, don't warn**.

```jsonc
{
  "version": 1,
  "seed": 20260828,
  "worldRadius": 420,
  "spine": { "startAngle": 12, "stepDeg": [40, 80], "drift": "down" },
  "bell": { "r": 400, "theta": 0, "phi": 0 },
  "layers": [
    { "id": "drift", "mode": "scatter",        // scatter | hull | fused | chunk
      "rOuter": 300, "rInner": 240,
      "recipe": "drift_crumb", "count": 140, "size": [8, 16],
      "water": true,
      "budgets": { "airPockets": 4, "essence": 6, "faults": 0, "softSpots": 0 },
      "props": [{ "type": "wreck", "count": 1, "contains": "driller" }] },

    { "id": "great_wheel", "mode": "hull",     // closed parametric shell
      "surface": "wheel", "r": 233, "thickness": 6,
      "recipe": "dark_rind", "tiles": 150, "tileSize": 109,
      "crust": { "amp": 0.018 }, "sealed": true, "hollow": true,
      "budgets": { "softSpots": 2, "airPockets": 0, "essence": 0 } },

    { "id": "belly", "mode": "scatter", "rOuter": 230, "rInner": 150,
      "recipe": "drift_crumb", "count": 60, "size": [15, 40],
      "water": true, "densityGrade": "outward",
      "fog": { "range": 0.6, "color": "#101418" },
      "budgets": { "airPockets": 3, "essence": 4 } },

    { "id": "dark_veins", "mode": "fused", "rOuter": 150, "rInner": 90,
      "recipe": "roquefort", "size": 25, "res": 72,
      "fog": { "range": 0.5, "color": "#2b3350" }, "swimSpeedMul": 0.8,
      "budgets": { "airPockets": 2, "essence": 10, "faults": 14 } },

    { "id": "the_melt", "mode": "fused", "rOuter": 90, "rInner": 50,
      "recipe": "fondue", "size": 22, "res": 72, "airFilled": true,
      "budgets": { "airPockets": 8, "essence": 8, "faults": 4 },
      "hazards": [{ "type": "melt_fall", "count": 12 },
                  { "type": "melt_pool", "count": 6 }] },

    { "id": "galleries", "mode": "fused", "rOuter": 50, "rInner": 6,
      "recipe": "mite_bore", "size": 18, "res": 72,
      "budgets": { "airPockets": 1, "essence": 14, "faults": 0 } },

    { "id": "heart", "mode": "chunk", "rOuter": 6, "rInner": 0,
      "recipe": "fresh_curd", "size": 12, "res": 72,
      "budgets": { "airPockets": 1 }, "props": [{ "type": "golden_gouda" }] }
  ]
}
```

| Rule | Constraint | Why |
|---|---|---|
| Sealing | `tileSize ≥ 1.6 × 3.54 R / √tiles` | tiles must overlap. At R 233: `≥ 1331/√N`; N 150 → 109. Fixes X1. |
| Crust amp | `amp × tileSize < thickness / 3` | at 6 u, `amp ≤ 0.018`. X4. |
| Resolution | `cells per radius = r × res ≥ 4` | size-independent; why the galleries are `size 18 @ res 72`. |
| Clearance | tunnels ≥ **1.3 u** (0.6 + 0.45 + margin) | mite bore authors at 1.0 — negative on purpose, see M2.5. |
| Reachability | flood-fill water from the bell | proves the shell is closed **and** that a soft spot and the Gouda are reachable. One test, two answers. |

**M2.5 · The six parts** *(2 d)* — drift crumb · dark rind · roquefort ·
**fondue (new)** · mite-bored paste · fresh curd. Full concepts, look and
starting numbers in `cheese-parts.md` §3; tune in the bench and copy back. Nine
became six by cutting the emmental, crystal paste, smear rind and bloom — each
was a fine idea attached to a layer that no longer exists, and six strong parts
beat ten with four passengers. They return as data if a later gate wants another
band.

Two parts carry the milestone's design risk and want the most bench time:
- **mite bore** — the galleries. Tunnels *and* chambers, alternating without
  warning. Cargo clearance sits at 1.0 u against the Gouda's 1.3 u, deliberately;
  whether the haulable route is authored or carved is a Gate B answer.
- **dark rind** — smooth by law, so its whole identity is the mould-ridge and
  cloth-weave texture, the near-black crust, and the pale paste showing through
  the crack web.

**M2.6 · Bench support** *(0.5 d)* — the bench renders a **fused sample slab**,
not one chunk (K4), and shows `r × res` and minimum clearance live beside the
sliders. You cannot tune claustrophobia by looking at one floating part.

**M2.7 · Assemble and swim it** *(1 d)* — the full stack at the radii in the
ladder, spine angle seeded, trait budgets per layer (K7), flood fill green.
Measure a bare descent and ascent, no tools, no objective.

> ### ⏸ WAIT — Gate B · *Does the world read?*
>
> Swim the whole thing, alone, no objective, no driller. Then again with two
> players and something 1.3 u wide in your arms.
>
> **Ask five things.** Can you tell which layer you're in, blind to the fog
> colour, by how you're moving? Does the Wheel read as a *wheel* — an object,
> not a wall? Is the belly a place or a long dark swim? Are the galleries
> **lost** or merely **annoying**? Where did the descent sag?
>
> **If a layer doesn't announce itself:** it's decoration — merge it into its
> neighbour. With five stops there is nowhere for a passenger to hide, which is
> the point of the cut.
> **If the galleries are annoying rather than lost:** the levers are chamber
> frequency and dead-end ratio, in that order. A maze that only branches is a
> hedge; a maze that opens into rooms is a place.
> **If the belly is a long dark swim:** density gradient (W17) first, then the
> three landmarks (W16) — not shrinking the Wheel.
> **If tunnels read as pipes:** check `r × res` before touching anything else.
>
> **Unlocks:** everything. Every remaining milestone is stakes, tools and
> readability layered onto a world that already exists — which is the entire
> reason the map moved to day 4.

---

## M3 — The gate as an event · 4 days

The Wheel exists as geometry after M2. This is what turns it into the twenty
seconds the run is remembered for.

**M3.1 · The driller** *(1 d)* — one per run (D23), seeded in the drift wreck.
Hands carve `hardness 0` slowly and near-silently; the driller carves `0–2` fast
and loud; `3` yields to nothing. Tool bounce and chip particles read the tier
back. Dig noise radius = `hardness × tool`, published as an attractor the
catfish already consumes (E4).

**M3.2 · Soft spots** *(1.5 d)* — 1–3 on the spine angle (D19), ship with 2.
Reads as a **weeping, discoloured, mite-pitted bulge**: dark rind gone soft and
damp, pale paste through the crack web, veins converging, a wet sheen nothing
else on the wheel has. Visible ~15 m, invisible beyond in fog, so finding it is
a search along a curve (N2). **~20 s of driller — the loudest thing in the
game** — or ~80 s of hand-carving (D22), so losing the driller is a slower run,
not a dead one. Opens one rat wide (N1). Stays open, inside face blank (D24).

**M3.3 · Light sticks** *(1 d)* — under D24 they are not a nicety, the seal is
unusable without them. Droppable, slow float, replicated via `items.ts`,
instanced additive sprites + a pool of 4 real `PointLight`s.
*AC:* 60 fps with 40 placed, and a stick left at a breach is findable from 30 m
against a blank inner wall.

**M3.4 · Breach polish** *(0.5 d)* — the drill audio ramp, the crust giving way,
the first sightline into the belly. This is a set-piece or it's a chore.

> ### ⏸ WAIT — Gate C · *Is the breach a set-piece?*
>
> Two to four players, one driller, one wheel, two soft spots.
>
> **Ask:** was searching the curve interesting or tedious? Did the 20 s of
> drilling feel like an event? **Did anyone mark the door — and if they didn't,
> was getting lost inside funny or infuriating?**
>
> **If the search is tedious:** raise `softSpots` to 3, or make the bulge read
> from further out. Don't add a HUD marker (D4).
> **If losing the door is infuriating:** the fallback is D24's alternative — the
> rind slumps closed but re-drills in ~5 s.
>
> **Answers Q6 and Q7, and retires Q5** (no second seal to be visible from the
> inside of). With one gate, this is also the last chance to decide whether gates
> are worth repeating — if the answer is a clear yes, seal 2 comes back as a
> layer-spec insert, not a rewrite.

---

## M4 — The slot · 2 days

D20's economy becomes real, now that there is something to hold and somewhere to
carry it.

**M4.1 · One pair of hands** *(1 d)* — slot occupants: Gouda, driller, downed
teammate. Light sticks and essence on the belt. HUD carry indicator (U3) —
always visible, because every other decision reads off it.

**M4.2 · Consequences** *(1 d)* — hand-carving works **with the slot still
full**, so the carrier can open a soft wall without putting the Gouda down; the
driller cannot. That asymmetry is the whole point of the rule.

*No gate — the answer arrives inside Gate D and Gate E. If the slot reads as
pure tax, the escapes are a second driller (D23's alternative) or throwable slot
items (M9.1, pulled forward) before softening the rule itself.*

---

## M5 — The melt · 3 days · *the one new system*

The melt is **air-filled**: steam-pocketed chambers, orange light, the only
place you can hear each other clearly and the **last generous air in the run**.
It sits directly before the galleries so the crew arrives topped up, talking and
warm — and then the galleries are dark, silent and drowning.

**M5.1 · The chambers** *(1 d)* — `airFilled` on a fused layer: no water volume,
movement swaps from swim to a heavy low-gravity walk and climb, voice occlusion
drops, oxygen refills freely. The biggest sensory swap in the game, and it is
mostly the *absence* of the water shader.

**M5.2 · Falls and pools** *(1 d)* — molten cheese sheets off the ceiling in
slow telegraphed ropes; pools on the floor **move**. Cooled floes are climbable
platforms, so the route through a chamber is partly built by what has already
fallen.

**M5.3 · Engulfed** *(1 d)* — **not death**: `coated` — slowed, vision fouled,
O₂ drain ×2, cleared by a teammate scraping you out or by reaching water.
Instant death in a hazard biome makes people stop moving. Admitted under the
standing rule because it also **weaponises**: a fresh fall can be dropped on
something following you.

> ### ⏸ WAIT — Gate D · *Is the melt a hazard or a refill?*
>
> It cannot be a strong version of both. Run it twice — once tuned generous,
> once tuned lethal.
>
> **Ask:** did anyone linger to breathe, or did everyone sprint through? Did
> being coated produce a rescue, or a death spiral?
>
> **If it plays as pure hazard:** cut fall count and pool coverage hard. M6's
> oxygen curve *depends* on this being the last big refill; if players won't
> stand still here, the whole back half of the run runs dry.
> **If it plays as a rest stop:** acceptable. A warm lit room before the
> labyrinth is doing structural work even with the heat turned down.

---

## M6 — Air that bites · 2 days

The rule (D11): **easy to forget, brutal when it bites.**

**M6.1 · Pockets in play** *(1 d)* — breaching an `air-pocket` refills and
consumes the pocket; **popped pockets stay popped and read as visibly deflated**
(S11), so the way home is drier than the way in through the same rooms. Seeded,
so peers agree for free.

**M6.2 · The curve** *(1 d)* — surplus in the drift and the belly, **the last
big refill in the melt**, deficit from the galleries inward (S10). The heart has
exactly one pocket and it is the last one in the game. Quiet HUD above ~40%;
below that escalate hard — breathing, heartbeat, vignette. The materials already
produce the curve; this is presentation and constants.

---

## M7 — The dark · 2 days

**M7.1 · Biome modifiers** *(0.5 d)* — `lightRange`, `fogDensity`, `drag`,
`soundOcclusion` per layer (W11). Small, and the veins don't exist without it.

**M7.2 · Veins as a route graph** *(1.5 d)* — the roquefort's veins stop being a
shader effect and become a connected graph the tunnel spanning tree follows, so
"follow the light" is literally true: hand-carvable *along* a vein, driller-only
across it. Settle Q8 here — some proportion must dead-end, or the biome is a
corridor with mood. Brittle vein routes that collapse behind you are the cheap
version of the same tension; take that if the graph work overruns.

---

## M8 — Legibility · 3 days · *ship before showing anyone new*

Every question a tester asked out loud at Gate B or C is a ticket in here.

- **M8.1 · The chalk manifest** *(1 d)* — controls and objective scrawled on the
  bell wall you already wake up facing. Worn, contradictory, added to by previous
  crews. Tutorial and lore on one surface.
- **M8.2 · HUD objective + carry indicator** *(0.5 d)* — *Find the Golden
  Gouda* → *Bring it back to the bell* → *GET OUT*.
- **M8.3 · Compass: bell bearing on the way out** *(0.5 d)* — never a gold
  bearing (D4).
- **M8.4 · Material legibility pass** *(0.5 d)* — U7: one trait, one colour, one
  consequence, ~5 readable signatures in fog. Six parts fit that budget exactly;
  nine did not.
- **M8.5 · README + docs pass** *(0.5 d)* — it still claims a gold compass
  marker that will never exist, and the layer count is now wrong everywhere.

> ### ⏸ WAIT — Gate E · *Four strangers, no explanation.*
>
> The first real playtest with people who haven't seen it. You say nothing.
>
> **Ask:** how long until they leave the bell? Do they find the driller? Does
> anyone say "what am I holding"? Where do they ask you a question out loud —
> because that's a legibility bug, not a player mistake. And how long did the
> run take?
>
> **If they never get through the gate:** that's a teaching failure, and the fix
> is in M8, not in making the seal easier.
> **If the run overran 25 min:** measure again after M9 before reaching for the
> finder.

---

## M9 — The Ascent & the inversion · 3 days

Without this the return is the same corridor backwards.

- **M9.1 · Throw / pass** *(1 d)* — the Gouda *and* the driller. A drill tossed
  across a gap is a better cooperative verb than one carried around it.
- **M9.2 · Pickup flips the world** *(1.5 d)* — one reliable event: the heart
  goes dark, the veins die back layer by layer, the melt's falls come faster,
  ambience turns, fog thickens.
- **M9.3 · The threat inversion** *(0.5 d)* — the outer bands are genuinely
  fish-free on the way in (C5, E2); the pickup floods them. Aggressive catfish
  profile post-pickup. The outer void past the boundary is the one place the
  Gouda is lost for good (G7) — everywhere else a dropped Gouda sinks back toward
  the heart and costs time, not the run.

---

## Locked, and carried in unchanged

Arms-carry, hand-off, 3 s catch, throw · one slot (Gouda / driller / downed
teammate) · light sticks and essence on the belt · no pickaxe, hands or driller
only · 45 s downed window · no map, no marker, navigation by landmark (D4) ·
the Duplicator lore, chalk delivery, no narrator · the Gouda is not splittable.

---

## Decisions that can't be made from the chair

| Question | Answered at | Blocks |
|---|---|---|
| Is the labyrinth *lost* or *annoying*? | Gate B | M2.5 tuning |
| Does cargo clearance widen, or is the route found? | Gate B | M2.5, M9 |
| Does every layer announce itself? | Gate B | the whole stack |
| Q7 · Does the driller wear out? | Gate C | M4 |
| Q6 · Can a soft spot be re-opened from either side? | Gate C | M9 |
| D24 vs the slump fallback | Gate C | M3.2 |
| Is one gate enough, or does seal 2 come back? | Gate C | — |
| Is the melt hazard or refill? | Gate D | M6.2 |
| Q8 · Roquefort veins: route or trap? | M7.2 | — |
| Does the run overrun? | Gate E, re-measured after M9 | the finder |

*Q5 (are seal 2's soft spots visible from the inside face) is retired — there is
no seal 2.*

---

## Parked, and the rule they come back under

**More gates** — including the one-player-wide tunnel that forcibly splits the
crew. The layer spec takes a new `hull` entry as data, so this is a content
decision at Gate C, not a rewrite. Don't add one before the first is proven.

**Essence & death** — essence as a carried score currency, downed-not-dead with
a 45 s window, revives that cost your score. Cut from MVP because the run has to
be worth finishing before it's worth failing. The death state is still the design
target for M5.3's `coated` status: build engulfment so a downed state slots into
the same path.

**The finder** — a diegetic instrument that pulses near the Gouda, shipped
disabled behind a flag. Only if runs overrun 25 minutes *after* M6 and M9 have
had their effect. The map stays hard (D5).

**The other four cheeses** — emmental, crystal paste, smear rind, bloom. Each
comes back with a band to live in, not before.

**Hazards** (H1–H4) — vacuum-pocket elevators, gas that blows walls open, poison
veins you can throw, rat traps you can re-arm. Each admitted individually, and
only with **both** a cheese type to live in **and** an offensive use. The melt is
the first hazard admitted under this rule; it's the template.

**More threats** (E3) — one monster cannot carry 25 minutes. Needs its own pass
now that the layers are real.

**The wisp** (S8) and **the Joker** (S9) — unchanged.

---

## Risks

- **M2 is 10 days and it is the whole game.** The mitigation isn't shrinking it,
  it's the internal order: the two placement modes and the flood-fill validator
  land before the content pass, so if worldgen overruns you find out on day 6
  with the parts still unauthored, not on day 12 with six cheeses tuned against
  geometry that doesn't close.
- **The seal doesn't close.** Highest-variance item inside M2, and with a 6 u
  crust the margins are thinner than at 18–24 u. Build the flood fill before you
  trust the geometry.
- **The thin rind reads as cheap.** A smooth shell is a smooth shell. If it looks
  like a beach ball at Gate B, the fix is the mould ridges, cloth weave, crust
  colour and the crack web — thickening it costs you the twenty-second drill.
- **Fused mass at high res blows the frame budget.** Small chunks at res 72 is
  the expensive corner. Profile in M2.2; the fallback is fewer, larger fused
  chunks and a slightly softer maze.
- **The melt is a third system in disguise.** Air-filled movement, moving hazard
  volumes and a status effect in three days is optimistic. If it slips, ship
  M5.1 alone — a lit air chamber with no falls — and take Gate D on that. The
  structural work is the air, not the lava.
- **The transport scheme is wrong.** Still the deepest risk, still day one,
  still Gate A — and now it gates a 10-day milestone, which is exactly why it
  stays first.
