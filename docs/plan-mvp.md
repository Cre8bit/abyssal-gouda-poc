# MVP Roadmap — Abyssal Gouda

The sequenced plan. Decisions behind it live in `idea-register.md` (§0);
part concepts and generator parameters live in `cheese-parts.md`.

**The pitch, one sentence:**

> Rats dive into a cheese abyss to recover the Golden Gouda — the kingdom's
> lost cheese-duplicator, still running — and haul it home before their air
> runs out.

**Done when** four people who've never seen it can be dropped in with no
explanation, a run ends in a win or a wipe inside 25 minutes, at least one
moment per run is worth retelling, and you can add a new cheese type or a new
layer without writing generator code.

---

## How to read this

Milestones are ordered by **what unblocks judgement**, not by what's exciting.
Between them are **⏸ WAIT gates**: points where you stop building and go play,
because the next milestone's design depends on an answer you cannot get from
the chair.

A gate has three parts: the question, what you do if the answer is *no*, and
what it unlocks. **Don't build past a gate you haven't run.** Every one of them
sits in front of work that would have to be thrown away if the answer came back
wrong.

| # | Milestone | Days | Cum. | Gate after |
|---|---|---|---|---|
| M1 | The thin haul | 3 | 3 | ⏸ A |
| M2 | Hands, driller, one slot | 3 | 6 | ⏸ B |
| M3 | The seal | 6 | 12 | ⏸ C |
| M4 | Fused mass & the labyrinth | 4 | 16 | ⏸ D |
| M5 | The layer stack | 5 | 21 | ⏸ E |
| M6 | Air that bites | 2 | 23 | |
| M7 | The dark | 2 | 25 | |
| M8 | Legibility | 3 | 28 | ⏸ F |
| M9 | The Ascent & the inversion | 3 | 31 | |
| M10 | Essence & death | 4 | 35 | |
| M11 | The finder | 1 | 36 | |

**≈36 working days — seven to eight weeks to MVP.** Longer than the previous
plan's 29 because the map architecture (M3, M4) is now real engineering rather
than a content pass.

---

## M1 — The thin haul · 3 days

Strip the haul to the bone so everything downstream has cargo to be judged
against. No throwing, no polish, no world-change.

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
> **Ask:** is moving this thing through a tunnel a activity, or a walk with a
> speed debuff? Does the hand-off get used, or does one person just carry it
> the whole way?
>
> **If no:** the fix is the transport scheme and the buoyancy curve — throwing,
> tethers, two-rat carry — **not** more features downstream. Everything from M2
> on assumes cargo is fun to move.
>
> **Unlocks:** the entire rest of the plan. This is the highest-variance
> unknown and it's why it's day one.

---

## M2 — Hands, driller, one slot · 3 days

Materials are defined by the tools that open them, so the tools come before
the cheese. This is also where D20's slot economy becomes real.

**M2.1 · The slot** *(1 d)*
One pair of hands. Slot occupants: Gouda, driller, downed teammate. Light
sticks and essence on the belt. HUD carry indicator (U3) — always visible,
because every other decision in the game reads off it.

**M2.2 · Hardness tiers and hand-carving** *(1 d)*
`hardness: 0|1|2|3` on `PartRecipe` (see `cheese-parts.md` §4). Hands carve
`0` slowly and near-silently **with the slot still free**; the driller carves
`0–2` fast and loud; `3` does not yield to anything. Tool bounce and chip
particles read the tier back to the player.

**M2.3 · Per-tool dig radius** *(0.5 d)* — **fixes X3, and it blocks
everything.** `DIG_RADIUS = 2.4` carves a 4.8 u sphere: wider than a labyrinth
tunnel and thicker than the Great Wheel's crust. One click currently erases the
biome it's used in. Hands ≈ 0.7 u, driller ≈ 2.4 u. This isn't only a fix —
hands *thread* and the driller *demolishes*, and choosing between them is
choosing whether your route home still exists.

**M2.4 · The driller and dig noise** *(0.5 d)*
One driller per run (D23), seeded in a wreck in the drift. Occupies the slot.
Dig noise radius = `hardness × tool`, published as an attractor the catfish
already knows how to consume (E4).
*AC:* a player can tell, from 20 m, whether a wall is hand-carvable — and the
fish comes when you drill.

> ### ⏸ WAIT — Gate B · *Does one slot create decisions or just chores?*
>
> Two players, one driller, a wall between them and the Gouda.
>
> **Ask:** does "who holds what" get discussed out loud? Does anyone
> voluntarily put the driller down? When the carrier hits a soft wall and
> hand-carves without dropping the Gouda, does that land as a moment?
>
> **If no:** the likely culprit is that the slot is *pure* tax — add a second
> driller (register D23's alternative) or let slot items be thrown (G5) before
> you soften the rule itself. Deleting D20 invalidates M3 and M5.
>
> **Unlocks:** M3. A seal is a lock, and it isn't a lock if the key isn't
> scarce.

---

## M3 — The seal · 6 days · *the riskiest engineering in the plan*

The Great Wheel. This is the milestone most likely to overrun, because
"guaranteed watertight surface built from noisy marching-cubes chunks" is a
harder promise than it sounds.

**M3.1 · `hull` placement mode** *(2 d)*
Generalise `shell` to tile chunks over a parametric surface — sphere and
`wheel` (squat cylinder with a rounded rim), `hollow: true` so the interior is
open water rather than solid (D2b). Tile count validated against
`size ≥ 1.6 × 3.54R/√N` at build time, with a console warning when it fails.
Seal tiles get `noCarveWithin`, so no eye may touch either face, and the
thin-shell noise cap `crust.amp × size < thickness / 3` is enforced (X4) —
at 4–6 u of crust the default noise would turn the gate into lace.

**M3.2 · Flood-fill verification** *(1 d)*
At seed time, flood-fill the *water* volume from the bell on a coarse grid.
What it reaches is the outer band. Reaching the centre = leak → thicken/reseed.
Reaching no soft spot = sealed out → reseed. Doubles as the gold-reachability
test. **Fix X1 here** — the current crust doesn't reach bare closure.

**M3.2b · The hollow** *(0.5 d, folded into M3.1's budget)*
The Wheel's interior is a biome, not a void: floating parts graded thick near
the inner wall and thinning toward the middle (W17), a debris floor, the gnawed
crown above (W16), and no ambient light at all — the first genuinely dark place
in the run.

**M3.3 · Soft spots** *(1.5 d)*
1–3 per seal, placed on the spine angle (D19). Weeping, discoloured, pitted;
readable at ~15 m and invisible beyond in fog. ~20 s of driller or ~80 s of
hand-carving (D22). Opens one rat wide (N1). Stays open, inside face blank
(D24).

**M3.4 · Light sticks** *(1.5 d)*
Pulled forward from the old M8 — under D24 they are no longer a nicety, the
seal is unusable without them. Droppable, slow float, replicated via
`items.ts`, instanced additive sprites + a pool of 4 real `PointLight`s.
*AC:* 60 fps with 40 placed, and a stick left at a breach is findable from
30 m against a blank inner wall.

> ### ⏸ WAIT — Gate C · *Is the breach a set-piece?*
>
> Two to four players, one driller, one wheel, one soft spot. Find it, open it,
> go through, come back out.
>
> **Ask four things.** Was searching the curve for the bulge interesting or
> tedious? Did the 20 s of drilling feel like an event? **Did anyone mark the
> door — and if they didn't, was getting lost inside funny or infuriating?**
> And once through: does the hollow read as a *place*, or as a long dark swim?
>
> **If the search is tedious:** raise `softSpots` to 3, or make the bulge read
> from further out. Don't add a HUD marker (D4).
> **If the hollow is a long dark swim:** the levers are the density gradient
> (W17) and the three landmarks (W16), in that order — not shrinking the Wheel.
> **If losing the door is infuriating:** the fallback is register D24's
> alternative — wax slumps closed but re-drills in ~5 s. Decide this *here*,
> because M5 authors the second seal around the answer.
>
> **Answers Q5, Q6, Q7 from the register** — none of them can be answered
> before you've stood in front of a real seal.
>
> **Unlocks:** M4 and M5. The whole layer stack is seals and bands.

---

## M4 — Fused mass & the labyrinth · 4 days

D2's inner half, and the fix for X2. An archipelago of hollow chunks can never
feel enclosed no matter how you carve it.

**M4.1 · `fused` placement mode** *(2 d)*
Overlapping chunks whose interiors connect, with an `overlap` fraction that
guarantees fusion and no water between. Watch the chunk budget: small chunks at
high res is the expensive corner of the pipeline, so profile before authoring.

**M4.2 · The mite-bored part** *(1 d)*
`size 16–20 @ res 72`, `r × res ≈ 4.0`, eyes barely wider than tunnels,
`exits 1`, `deadEnds 5`, `tangle`. Cargo clearance ~1.0 u — deliberately below
the Gouda's 1.3 u, so the haulable route has to be found or made.

**M4.3 · Bench support** *(1 d)*
The bench renders a fused sample slab, not one chunk (K4), and shows
`r × res` and minimum clearance live next to the sliders. You cannot tune
claustrophobia by looking at one floating part.

> ### ⏸ WAIT — Gate D · *Does it feel tight?*
>
> Alone, headset on, no objective. Swim into the labyrinth slab and try to get
> back out.
>
> **Ask:** is there a moment of not knowing which way is out? Does the tunnel
> read as a tunnel or as a soft pipe? Does carrying something make it worse in
> a good way?
>
> **If no:** check `r × res` first, then chamber size, then whether you're
> actually inside fused mass or still island-hopping. All three are data, not
> code — that's the point of having done M4.1.
>
> **Unlocks:** M5. If the tightest biome in the game doesn't read, authoring
> eight more of them is wasted work.

---

## M5 — The layer stack · 5 days · *the content work*

Now author the world. Everything here should be data.

**M5.1 · The nine parts** *(2 d)* — drift crumb, emmental, wax rind,
mite-bored paste, roquefort, crystal paste, aged crystal, smear rind, bloom,
fresh curd. Numbers in `cheese-parts.md` §3 are starting points; tune them in
the bench and copy them back.

**M5.2 · The stack and the spine** *(2 d)* — the eight layers from the
register's §W table, at their radii. Spine angles: each seal's soft spots 40–80°
around from the previous seal's, drifting downward (D19). Trait budgets per
biome (K7).

**M5.3 · Round-trip timing** *(1 d)* — measure a full descent and ascent with
cargo. The map stays big and hard (D5) — if the run overruns, the lever is
M11's finder, **not** shrinking the world.

> ### ⏸ WAIT — Gate E · *The full descent.*
>
> Two to four players, no explanation, from the bell to the Gouda and back.
> Record it. This is the first time the game exists.
>
> **Ask:** can you tell which layer you're in, blindfolded to the fog colour,
> by how you're moving? Where did the run sag? How long did it take?
>
> **If a layer doesn't announce itself:** that layer is decoration. Merge it
> into its neighbour rather than adding a mechanic to justify it — eight strong
> layers beat ten with two passengers.
> **If the run overran 25 min:** note it, don't act. M6 and M9 both shorten the
> felt length; measure again after them before reaching for M11.
>
> **Unlocks:** everything after this is tuning, stakes and readability on a
> world that already works.

---

## M6 — Air that bites · 2 days

The rule (D11): **easy to forget, brutal when it bites.**

**M6.1 · Pockets in play** *(1 d)* — breaching an `air-pocket` refills and
consumes the pocket; **popped pockets stay popped and read as visibly
deflated** (S11), so the way home is drier than the way in through the same
rooms. Seeded, so peers agree for free.

**M6.2 · The curve** *(1 d)* — surplus in the drift and the hollow, deficit
from the warrens inward (S10); the emmental floating inside the Wheel is the
last generous air and should feel like it.
Quiet HUD above ~40%; below that, escalate hard — breathing, heartbeat,
vignette. The materials already produce the curve; this is presentation and
constants.

---

## M7 — The dark · 2 days

**M7.1 · Biome modifiers** *(0.5 d)* — `lightRange`, `fogDensity`, `drag`,
`soundOcclusion` per biome (W11). Small, and four biomes are waiting on it.

**M7.2 · Veins as a route graph** *(1.5 d)* — the roquefort's veins stop being
a shader effect and become a connected graph the tunnel spanning tree follows,
so "follow the light" is literally true. Settle Q8 here: some proportion of
veins must dead-end, or the biome is a corridor with mood.

---

## M8 — Legibility · 3 days · *ship before showing anyone new*

Every question a tester asked out loud at Gate E is a ticket in here.

- **M8.1 · The chalk manifest** *(1 d)* — controls and objective scrawled on
  the bell wall you already wake up facing. Worn, contradictory, added to by
  previous crews. Tutorial and lore on one surface.
- **M8.2 · HUD objective + carry indicator** *(0.5 d)* — *Find the Golden
  Gouda* → *Bring it back to the bell* → *GET OUT*.
- **M8.3 · Compass: bell bearing on the way out** *(0.5 d)* — never a gold
  bearing (D4).
- **M8.4 · Material legibility pass** *(0.5 d)* — U7: one trait, one colour,
  one consequence, ~5 readable signatures in fog. This is where you find out
  two of your nine cheeses look the same.
- **M8.5 · README + docs pass** *(0.5 d)* — it still claims a gold compass
  marker that will never exist.

> ### ⏸ WAIT — Gate F · *Four strangers, no explanation.*
>
> The first real playtest with people who haven't seen it. You say nothing.
>
> **Ask:** how long until they leave the bell? Do they find the driller? Does
> anyone say "what am I holding"? Where do they ask you a question out loud —
> because that's a legibility bug, not a player mistake.
>
> **If they never get through the first seal:** that's a teaching failure, and
> the fix is in M8, not in making the seal easier.
>
> **Unlocks:** M9 and M10 — stakes only matter once people understand what
> they're doing.

---

## M9 — The Ascent & the inversion · 3 days

Without this the return is the same corridor backwards.

- **M9.1 · Throw / pass** *(1 d)* — the Gouda *and* the driller. A drill tossed
  across a gap is a better cooperative verb than one carried around it.
- **M9.2 · Pickup flips the world** *(1.5 d)* — one reliable event: the heart
  goes dark, veins die back layer by layer, ambience turns, fog thickens.
- **M9.3 · The threat inversion** *(0.5 d)* — the outer bands are genuinely
  fish-free on the way in (C5, E2); the pickup floods them. Aggressive catfish
  profile post-pickup. The outer void past the boundary becomes the one place
  the Gouda is lost for good (G7).

---

## M10 — Essence & death · 4 days

- **M10.1 · Essence** *(1 d)* — seeded in crystal paste, carried per-player,
  **lost on death**. The score currency and the greed loop.
- **M10.2 · Downed, not dead** *(1.5 d)* — O₂ zero leaves you limp and sinking,
  still on proximity voice, on a countdown. A teammate reaching you shares air.
  Dragging a downed body takes the slot (D20) and reuses M1.1's path.
- **M10.3 · Revive costs the run** *(0.5 d)* — spending essence to bring
  someone back is spending your score.
- **M10.4 · Full death, the wipe, the summary** *(1 d)* — countdown expires →
  spectate a living teammate. Everyone dead → run over. Summary: time, essence,
  who died, who dropped it, **who marked the door**. Late joiners drop in.

---

## M11 — The finder · 1 day

A carried instrument that pulses faster near the Gouda. No bearing, no HUD
marker — diegetic only. **Ships disabled behind a flag.** Turn it on only if
Gate E and Gate F show runs overrunning 25 minutes *after* M6 and M9 have had
their effect. The map stays hard (D5); this is the pressure valve, and reaching
for it early hides a pacing problem instead of fixing it.

---

## Decisions that can't be made from the chair

| Question | Answered at | Blocks |
|---|---|---|
| Q7 · Does the driller wear out? | Gate C | M5's second seal |
| Q6 · Can a soft spot be re-opened from either side? | Gate C | M5, M9 |
| Q5 · Are seal 2's soft spots visible from inside? | Gate C | M5 |
| D24 vs the slump fallback | Gate C | M3.3, M5.2 |
| Q8 · Roquefort veins: route or trap? | M7.2, confirmed at Gate E | — |
| Does the run overrun? | Gate E, re-measured after M9 | M11 |

---

## Parked, and the rule they come back under

**Hazards** (H1–H4) — vacuum-pocket elevators, gas that blows walls open,
poison veins you can throw, rat traps you can re-arm. Each is admitted
individually, and only with **both** a cheese type to live in **and** an
offensive use. A hazard that only taxes you is friction; one you can weaponise
is a story.

**More threats** (E3) — one monster cannot carry 25 minutes. Needs its own pass
after the layers are real, because what hunts you should depend on where you
are.

**The wisp** (S8) — dead players flying through the cheese as the crew's sonar.
Design M10.4's death state so this slots in without rework.

**The Joker** (S9) — spending essence on a desperation gamble when the run is
falling apart.

---

## Risks

- **The seal doesn't close.** M3 is the new highest-variance item: watertight
  surfaces out of noisy chunks. Mitigation is M3.2's flood fill — build the
  verifier before you trust the geometry, not after.
- **Fused mass at high res blows the frame budget.** Small chunks at res 72 is
  the expensive corner. Profile in M4.1 before authoring five layers of it; the
  fallback is fewer, larger fused chunks and accepting a slightly softer maze.
- **The transport scheme is wrong.** Still the deepest risk, still day one,
  still Gate A.
- **The slot is tax, not tension.** Gate B. If it reads as chores, soften it
  there — after M3 it's load-bearing and expensive to remove.
- **Layers stay theoretical.** It's easy to write "the dark" in a table and
  ship another tunnel. Gate E is the check, and the honest response to a
  passenger layer is deletion.
