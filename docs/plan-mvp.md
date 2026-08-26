# MVP Roadmap — Abyssal Gouda

The sequenced plan. Decisions behind it live in `idea-register.md` (§0);
`plan-game-loop.md` is the original engineering plan, kept as history.

**The pitch, one sentence:**

> Rats dive into a cheese abyss to recover the Golden Gouda — the kingdom's
> lost cheese-duplicator, still running — and haul it home before their air
> runs out.

**Done when** four people who've never seen it can be dropped in with no
explanation, a run ends in a win or a wipe inside 25 minutes, at least one
moment per run is worth retelling, and you can add a new cheese type or a new
biome without writing generator code.

---

## Shape of the plan

M1 gives you cargo. M2 gives you the tools to build cheese. M3 is where you
spend most of your time — actually authoring the biomes. Everything after
that makes the run readable and gives it stakes.

| # | Milestone | Days | Cum. |
|---|---|---|---|
| M1 | The thin haul | 3 | 3 |
| M2 | The cheese kit | 6 | 9 |
| M3 | The biome pass | 5 | 14 |
| M4 | Oxygen that bites | 2 | 16 |
| M5 | Legibility | 3 | 19 |
| M6 | The Ascent | 3 | 22 |
| M7 | Essence & death | 4 | 26 |
| M8 | Breadcrumbs | 2 | 28 |
| M9 | The finder | 1 | 29 |

**≈29 working days — six weeks to MVP.**

---

## M1 — The thin haul · 3 days

Strip the haul to the bone so biome work has cargo to be judged against. No
throwing, no polish, no world-change. Just: the Gouda is heavy and it has to
get home.

**M1.1 · Transport spike** *(1 d)* — **the open question (register G2).**
Prototype and pick, in the bench or a debug scene:

| Scheme | Feel | Risk |
|---|---|---|
| **Held** — clamped in front, first-person, constant drag | Simple, readable, always works | Least interesting; the Gouda becomes a stat |
| **Towed** — on a line behind you; two rats can pull together and go faster | Cooperative, physical, snags on geometry in a good way | Rope physics in tunnels; needs care |
| **Shoved** — a buoyant physics body you push along | Comedic, chaotic, great in open water | Miserable in the warrens; may fight the SDF collider |
| **Harnessed** — strapped on, hands free, heavy | Keeps the pickaxe usable while carrying | Removes the "your hands are full" tension |

*Decide by feel, not by spec.* Whatever wins becomes the code path that
downed-body dragging (M7) reuses.

**M1.2 · Gouda as an item** *(1 d)* — retire the decorative `goldCore` in
`gouda.ts`; register an `items.ts` kind `gouda`, seeded at `getGoldPos()` so
it costs zero network. Contested pickup needs the one piece of protocol
`items.ts` lacks: a `pick` request (joiner → host) answered by an
authoritative `item*`. Carrier flag = the already-reserved `STATUS.CARRYING`.
*AC:* two clients agree on the holder 100% of the time, including simultaneous
grabs.

**M1.3 · Weight, light, and the bell** *(1 d)* — negative buoyancy (~−4 u/s,
beatable by swim spam), reduced speed cap, **carrier's flashlight forced
off** while the Gouda itself lights a wide radius for everyone. Gouda inside
the bell's hatch radius → run ends, placeholder win screen.
*AC:* a full run, start to win screen, at 2 players.

> **Gate A** — play it. Is hauling it up through a tunnel interesting? If not,
> the fix is the transport scheme and the buoyancy curve, not more features.

---

## M2 — The cheese kit · 6 days · *the tool you'll live in*

This is what makes biome work fast instead of painful. Everything here is
infrastructure, and it pays for itself the moment M3 starts.

**M2.1 · `CheesePartType` recipes** *(2 d)* — a declarative table describing
one kind of cheese chunk:

```
{ id, shapeFamily, sizeRange, noiseCrust, shellThickness,
  holes: {count, radiusRange}, tunnels: {count, radiusRange, tortuosity},
  interiorDensity, material, tags }
```

`gouda.ts`'s current generators become the *implementations* of a handful of
shape families; the numbers move out into the table. Nothing about the SDF
or marching-cubes pipeline changes.

**M2.2 · Live sliders in the bench** *(2 d)* — `/preview.html?part=<id>`
mounts a single part with a slider panel bound to every recipe field.
Reshape, watch it remesh (~20 ms), orbit, cut the camera inside. A copy
button dumps the current values as a table entry.
*AC:* you can go from an idea to a saved part type without editing code.

**M2.3 · Biomes as recipes** *(1 d)* — a biome becomes data: a weighted list
of part types, spacing and density, radial band, fog, vein colour, and
whether the fish may enter. Adding a biome stops being a code change.

**M2.4 · Biome sample slab in the bench** *(0.5 d)* — render a representative
wedge of a biome rather than one part, so you tune density by looking at
density.

**M2.5 · Shot regression** *(0.5 d)* — one headless capture per part type and
per biome via the existing `?shot=` harness, so a generator tweak that ruins
the reef is visible in a diff.

---

## M3 — The biome pass · 5 days · *the content work*

Now author the world. Each biome gets **one verb** — a thing the player does
there that they don't do elsewhere. Colour and fog are not verbs.

**M3.1 · New cheese types the design needs** *(2 d)*

- **air-pocket cheese** — sealed bubbles, invisible until you breach them,
  refill O₂ and are consumed (tag `air-pocket`, feeds M4)
- **solid cheese** — no natural route through; the pickaxe is the only way
  (tag `dig-through`, makes digging structural rather than optional)
- **slotted cheese** — thin plates with narrow gaps you must slow down and
  align for; murder with cargo (tag `thread`)
- whatever else the sliders suggest — that's the point of M2

**M3.2 · Assign verbs and rebuild the layer stack** *(2 d)* — fill in the
biome table in the register. Working hypothesis, to be argued with once you
can actually see them:

| Layer | Verb | Built from |
|---|---|---|
| drift | orient | sparse pale parts, wide spacing |
| reef | thread | slotted cheese |
| scree | dig | small parts + solid cheese shortcuts |
| warrens | separate | long narrow tunnel parts, single-file |
| crust | endure | giant fused hunks, air pockets sparse |
| galleries | be hunted | cathedral chambers, open sightlines, fish allowed |
| bulwark | commit | dense, few routes, the point of no easy return |
| hollows | squeeze | cramped parts, hardest place to move the Gouda |
| heart | take it | the Gouda's cavern, below the equator |

**M3.3 · Scale and round-trip timing** *(1 d)* — measure a full round trip
with cargo. The map stays big and hard (register D5) — if the run overruns,
the lever is M9's finder, **not** shrinking the world.

> **Gate B** — a run with a friend, all nine biomes. Can you tell, blindfolded
> to the fog colour, which biome you're in by how you're moving? If not, the
> verbs aren't strong enough yet.

---

## M4 — Oxygen that bites · 2 days

The rule (register D11): **easy to forget, brutal when it bites.** Right now
it's a bar that nags. It should be a thing you don't think about until
suddenly it's the only thing you think about.

**M4.1 · Air pockets in play** *(1 d)* — breaching an `air-pocket` part
refills you and consumes the pocket. Seeded, so peers agree for free;
breaching replicates as an item event. Where you left a full pocket becomes
information worth remembering on the way back.

**M4.2 · The panic curve** *(1 d)* — quiet HUD above ~40%: no warnings, no
flashing. Below that, escalate hard — breathing, heartbeat, vignette, the
bar becoming impossible to ignore. Bell refill stays as the safe fallback.

---

## M5 — Legibility · 3 days · *ship before showing anyone new*

Cheap, unglamorous, and the difference between a confusing tech demo and a
party game. Every question a tester asks out loud is a ticket in here.

- **M5.1 · The chalk manifest** *(1 d)* — controls and objective scrawled on
  the bell wall you already wake up facing. Worn, contradictory, added to by
  previous crews. Tutorial and lore on one surface.
- **M5.2 · One-line HUD objective** *(0.5 d)* — *Find the Golden Gouda* →
  *Bring it back to the bell* → *GET OUT*. Plus a carry indicator.
- **M5.3 · Compass: bell bearing on the way out** *(0.5 d)* — never a gold
  bearing (D4). Without the return marker the escape is confusing, not tense.
- **M5.4 · Run summary** *(0.5 d)* — time, essence, who died, who dropped it.
- **M5.5 · README + docs pass** *(0.5 d)* — it currently claims a gold compass
  marker that will never exist.

---

## M6 — The Ascent · 3 days

Without this the return is the same corridor backwards.

- **M6.1 · Throw / pass** *(1 d)* — hand the Gouda to a teammate. Generates
  more voice chat than any hazard on the LATER list. Shape depends on M1.1.
- **M6.2 · Pickup flips the world** *(1.5 d)* — one reliable event: the heart
  goes dark, veins die back layer by layer, ambience turns, fog thickens.
  Presentation plus a few constants; no new simulation.
- **M6.3 · The fish wakes, and the void takes** *(0.5 d)* — aggressive catfish
  profile post-pickup (tuning constants in `catfish.ts`), and the outer void
  past the boundary becomes the one place the Gouda is lost for good.

---

## M7 — Essence & death · 4 days

- **M7.1 · Essence** *(1 d)* — seeded pickups, carried per-player, **lost on
  death**. The score currency and the greed loop.
- **M7.2 · Downed, not dead** *(1.5 d)* — O₂ zero leaves you limp and sinking,
  still on proximity voice, on a countdown. A teammate reaching you shares air.
  Dragging a downed body reuses M1.1's transport path.
- **M7.3 · Revive costs the run** *(0.5 d)* — spending essence to bring
  someone back is spending your score. The dilemma the design leans on.
- **M7.4 · Full death and the wipe** *(1 d)* — countdown expires → spectate a
  living teammate. Everyone dead → run over, summary screen. Late joiners drop
  into a run in progress.

---

## M8 — Breadcrumbs · 2 days

- **M8.1 · Minimal hotbar** *(1 d)* — slots, number keys/wheel, HUD counter.
- **M8.2 · Light sticks** *(1 d)* — droppable, slow float, replicated via
  `items.ts`, instanced additive sprites + a pool of 4 real `PointLight`s.
  *AC:* 60 fps with 40 placed.

---

## M9 — The finder · 1 day

A carried instrument that pulses faster near the Gouda. No bearing, no HUD
marker — diegetic only. **Ships disabled behind a flag.** Turn it on only if
Gate B and later playtests show runs overrunning 25 minutes. The map stays
hard (D5); this is the pressure valve.

---

## Parked, and the rule they come back under

**Gates** (register N1–N4) — including the one-player-wide tunnel that forces
the crew apart, which is the strongest 4-player idea in the register. Comes
back once the biomes exist to host them.

**Hazards** (H1–H4) — vacuum pockets as elevators, gas that blows walls open,
poison veins you can throw, rat traps you can re-arm for the fish. Each is
admitted individually, and only when it has **both** a cheese type to live in
**and** an offensive use. A hazard that only taxes you is friction; one you
can weaponise is a story.

**More threats** (E3) — one monster cannot carry 25 minutes. Needs its own
design pass after the biomes are real, because what hunts you should depend
on where you are.

**The wisp** (S8) — dead players flying through the cheese as the crew's
sonar. Design M7.4's death state so this slots in without rework.

**The Joker** (S9) — spending essence on a desperation gamble when the run is
falling apart.

---

## Risks

- **The transport scheme is wrong.** Highest-variance unknown in the plan,
  which is why it's day one. Everything downstream reuses it.
- **A big hard map plus fully hidden gold overruns.** Accepted deliberately
  (D4, D5). M9 is the mitigation; measure at Gate B before reaching for it.
- **The cheese kit eats more than 6 days.** It's authoring infrastructure and
  those always run long. If it does, cut M2.5 and M2.4 first — the sliders
  (M2.2) are the part that actually matters.
- **Verbs stay theoretical.** It's easy to write "thread" in a table and ship
  another tunnel. Gate B is the check.
