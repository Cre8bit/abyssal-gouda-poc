# Worldgen Roadmap — building the six-biome map

The engineering plan for taking `src/world/gouda.ts` + `src/world/recipes.ts`
+ `src/bench/worldgen.ts` to the six-biome map defined in `cheese-parts.md`
(the numbers live there; read it first). Updated 2026-08-30 for the redesigned
biomes: Emmental drift, Great Wheel with multiple scattered soft spots, scatter-only Dark Veins
with rotating chunks, a second undrillable seal (the melt shell) with one
hidden entrance positioned at the trail terminus, rhythmic melt hazards, gallery gathering chambers, single-room heart.

**The old worldgen is being retired, not maintained.** `DEFAULT_WORLD` /
`DEFAULT_PARTS` / `DEFAULT_BIOMES` and the `shell` placement mode go away
(WG-04); backward fingerprint compatibility with pre-recipe worlds is no
longer a constraint. The six-biome `WHEEL_WORLD` is the only world.

---

## 0. State of the code

What exists and is kept:

- **Layer bodies** (`LayerBody`, `bodySdfWorld`, `tileLayer`,
  `buildLayerChunks`): one analytic SDF per `fused`/`hull` layer, meshed by
  lattice-aligned tiles spaced `2s(res-3)/res` so tiles abut seam-free.
  World-space carves distributed into tiles; `shareCarves()` composes across
  interpenetrating meshes; `noCarveWithin`/`sealed` protects seal tiles from
  *generated* carves (not yet from player digs — WG-01).
- **Frame (squash+tilt), spine, hull soft spots** (`makeFrame`,
  `computeSpine`, `projectToHull`; soft spot #1 rides the spine).
  `getSpinePoints()`/`getSoftSpots()` expose them after a build.
- **The data layer**: `recipes.ts` is pure JSON-serializable data
  (Part/Biome/WorldRecipe), node-tested by `tools/test-recipes.ts`;
  `validateWorld()` is the seed-time law (fail, don't warn).
- **Deterministic multiplayer**: seed rides invite + handshake; digs
  replicate as tiny `{kind:"dig"}` events replayed through `digAt()`; late
  joiners replay `pendingDigs`. No geometry crosses the network.
- **The bench** (`/worldgen.html`): part/biome/map views, walk mode (F),
  clip plane, autosave, copy-JSON (the only way a tuning ships).
- The game already plays `WHEEL_WORLD` (`gouda.ts:2105`), so correctness
  (verifier) and perf (workers) are critical path.

What does not exist yet: hardness-gated per-tool digging, the route
verifier, the Emmental drift, the veins scatter trail (the tree still ships
the old `belly` band + a fused `veins` mass), the melt shell, chunk
rotation, sightline placement, hazard/air-pocket seeding, edge-vein glow,
measured clearance telemetry, workers, spatial indexing.

---

## 1. How to read the tickets

Each ticket is one deliverable one agent can land in one branch, with its own
acceptance criteria (AC). Priority = order. Constraints on every ticket:

- `npm run typecheck` + `npm test` + `npm run lint` green.
- Erasable TS only; imports carry `.ts`; **numbers in `recipes.ts`,
  implementations in `gouda.ts`**; session state on `GameState`.
- **Determinism**: world = f(seed, difficulty, tables); all rng via
  `mulberry32`, draw order part of the format. Content tickets may change the
  stream (say so in the commit); perf tickets may not — prove by fingerprint
  (chunk layout + vertex counts + gold + spawn across ≥3 seeds) against the
  *current* `WHEEL_WORLD`.
- Tunables land in the bench first, ship by copy-paste into `recipes.ts`.

```
WG-01 ─► (M3 breach timer)      WG-04 ─► WG-05..10
WG-02 ─► WG-08, WG-14           WG-06 ─► WG-07, WG-12, WG-13
WG-19 ─► WG-20, WG-22           WG-21 independent, any time
```

---

## 2. P0 — safety rails (before any more tuning)

### WG-01 · Per-tool digging with hardness gating — ~1 d

**Why.** `DIG_RADIUS = 2.4` carves a 4.8 u sphere — wider than a gallery bore,
thicker than the Great Wheel — and `digAt()` edits sealed tiles, so both seals
are currently void.

**What.**
1. `Chunk` gains `hardness`, copied from the part in `makeChunkData()` /
   `buildLayerChunks()`.
2. `digAt(x, y, z, r, tool: "hands" | "driller")`: hands dig hardness 0 only;
   driller digs ≤ 2; 3 yields to nothing. A failing chunk is skipped (no field
   edit, no dig entry) — the loop continues, since one sphere can straddle
   soft crumb and a seal.
3. **Soft-spot exception (Great Wheel only):** a dig point within `spot.r` of
   a `body.softSpots` entry treats the tile as hardness 1. This is the
   geometric hook the M3 ~20 s breach timer attaches to. **The melt shell gets
   no exception** — its entrance is generated open (WG-08), never dug.
4. `main.ts`: per-tool radii — hands **0.7 u**, driller **2.4 u**. Dig events
   gain `tool` so peers apply the same gate (same world ⇒ same verdict).
   Debug toggle for the active tool until M3 seeds the driller item.
5. `digAt` returns whether it was rejected (tool-bounce feedback later).

**AC.** Hands never mark either hull; driller opens only the Wheel's soft
spot; a hands carve in the drift is 1.4 u across (the galleries are
hardness 1 — driller only, per the table); replayed digs converge
across clients; undug-world fingerprint unchanged.

### WG-02 · Route verifier: bell → breach → entrance → gold — ~1.5 d

**Why.** The acceptance test for everything else: both seals closed, the run
completable. "One test, two answers."

**What.** New pure module `src/world/verify.ts` (node-runnable, no render
imports):
1. Extract the data phase of `buildGoudaWorld` into an exported
   `buildWorldData()` (plan + chunks + carves, no meshing) shared by game,
   bench and verifier.
2. Don't flood the ocean — greedy best-first search (A*, euclidean) on an
   implicit lattice (step ~1.25 u), cell passable iff
   `worldDistance ≥ clearance`:
   - **Sealed checks**: bell → gold with (a) all Great Wheel soft spots
     treated as solid, (b) the melt-shell entrance plugged. Each must **fail**
     independently.
   - **Reachable check**: both seals breached → must **succeed** at clearance
     0.6 (a rat). Record the path.
   - **Cargo check**: min `worldDistance` along the path = the bottleneck.
     Report it; the galleries sit below 1.3 u by design (reported, not
     failed); the melt-shell entrance must clear **1.4 u** (hard fail — it
     can't be widened).
3. Throwaway chunk hash grid inside verify.ts so each probe tests ~2–8
   chunks (WG-21 generalizes later).
4. `tools/test-worldgen.ts` in `npm test`: wheel world, 2–3 seeds × d1/d3,
   under ~60 s total. Export `verifyWorld(seed, difficulty, world)` →
   `{sealed, reachable, path, minClearance, visited}` for the bench.

**AC.** Shipped world passes on the seed matrix; thinning either hull to
0.5 u flips its sealed check; deleting the spine degrades the path; runtime
in budget.

### WG-03 · Truthful clearance telemetry in the bench — ~0.5 d

**Why.** The bench's `partMetrics` recomputes tunnel radius as `rBase × s`,
but the generator applies `max(minTunnelR, base × tunnelScale)` with
`minTunnelR = (narrow ? 2.2 : 2.6)·(2/res)` and difficulty scaling — so
verdicts are wrong near the floor and difficulty never changes them.

**What.** Export `effectiveTunnelRadius(part, s, res, difficulty)` from
`gouda.ts` (the one formula generation uses); rewrite `partMetrics` on it,
show effective range + `r×res` + rat/cargo verdicts vs 0.9/1.3 u; add a
**measured** line for built previews (sample `chunkDistance` at tunnel
segment midpoints, report min/median); pass `view.difficulty` in.

**AC.** Verdicts respond to difficulty; derived ≈ measured within ~0.15 u on
a smooth part; mite-bore reports ~1.0 u (rat ✓ / cargo ✗).

---

## 3. P1 — build the six biomes

### WG-04 · Retire the old worldgen + schema audit — ~1 d

**Why.** Only the newest generation ships; dead tables and dead fields cost
every future reader.

**What.**
1. Delete `DEFAULT_PARTS`, `DEFAULT_BIOMES`, `DEFAULT_WORLD`, `WORLDS.onion`;
   `WORLDS = { wheel }`. Prune `ZoneName` to
   `drift | great-wheel | veins | melt-shell | melt | galleries | heart`.
2. Delete the `shell` placement mode and its colossal params from the type,
   `placeChunks`, and the bench (superseded by `hull`).
3. Field audit — remove with all readers: `BiomeRecipe.airFilled` (nothing is
   air-filled; scrub "air-filled" from all `desc`/`mood` strings),
   `budgets.essence`, `budgets.faults`, `PartRecipe.porosity`,
   `PartRecipe.odour`. `budgets` becomes
   `{airPockets, softSpots, hazards?}` per cheese-parts §4.
4. Update `tools/test-recipes.ts` pins; drop the old-world fingerprint tests
   (compat is no longer a goal); keep/rebase the wheel-world fingerprint as
   the new perf baseline.

**AC.** Grep finds no `DEFAULT_WORLD`/`airFilled`/`essence`/`faults`/
`porosity`/`odour`/`"shell"` placement; bench world picker shows one world;
game boots and plays identically on the wheel map.

### WG-05 · The Drift becomes the Emmental Void — ~0.5 d · after WG-04

**What.** Replace `drift-crumb` with `emmental-drift` (cheese-parts §2: big
`eyes` rBase 0.18 — the holes; hardness 0; tags `hand-carve air-pocket`).
Drift biome: `band` r 240→300, count ~120, **`densityGrade: "inward"`**
(sparse far out, clustered against the Wheel — note the grade direction flips
from the old belly). Budget `airPockets 6`. Wreck prop position seeded on the
spine mid-band (consumed by WG-11).

**AC.** Map view shows clustering toward the hull; hole `r×res ≥ 4`; walk
mode: a chunk's interior is enterable through its holes; tests green; commit
flags the seed-stream change.

### WG-06 · The Dark Veins: scatter trail replaces belly + fused mass — ~1 d · after WG-04

**Why.** The design dropped the solid-mass concept: everything between the
Wheel and the melt shell is one vast pitch-black scatter of floating
Roquefort.

**What.**
1. Delete the `belly` biome and the fused `veins` biome; add one `veins`
   scatter biome: `band` r 100→226, count ~90, sizes 10→40,
   `densityGrade: "inward"`, modifiers `lightRange 0.25, fogDensity 3`.
2. `BiomePlacement` band gains `sizeGrade?: "outward" | "inward"`; implement
   in `tryBand()` (size lerped by placement radius, rng drawn in a fixed
   documented order).
3. Retune the `roquefort` part → `roquefort-float` (cheese-parts §2: eyes
   3–6, deadEnds 1, res 56, hardness 1, high `veinStrength`).

**AC.** Chunks grow/densify inward in map view; the layer is water end to
end (no fused body); validateWorld + tests green; WG-02 verifier still
passes.

### WG-07 · Sightline placement + trail validation — ~1 d · after WG-06

**Why.** "From each chunk you can just make out the next" **is** the level
design, and the trail must end at the melt-shell entrance — a seed-time
guarantee, not eyeballing.

**What.**
1. Band placement gains `sightline?: boolean`: a candidate is accepted only
   if some already-placed same-zone chunk (or, for the first, the Wheel's
   soft spot) lies within `sightRange` (~40 u) AND the segment isn't blocked
   by either hull (`hullSolidSdf` sphere-trace; other floaters don't block).
   Rejection-resample like the existing guards.
2. Chain check in `verifyWorld`: hop nearest-unvisited within sightRange
   from the breach; the chain must reach within sightRange of the melt-shell
   entrance (WG-08); orphans ≤ the 2–3 authored dead-end chunks.
3. Bench map view: draw the chain, green ≤ sightRange, red above; HUD
   `trail: N linked, M orphans, entrance ✓/✗`.

**AC.** 4 seeds × d1–3: zero unreachable trail segments breach → entrance;
disabling the flag reproduces plain scatter.

### WG-08 · The melt shell: second hull, hidden entrance — ~1.5 d · after WG-02

**Why.** The trail needs a destination that cannot be cheated: an undrillable
crust around everything from the Melt inward, entered only through one
obscured bore found by following the vein trail.

**What.**
1. New `melt-shell` biome: `hull`, `surface: "sphere"`, radius 91, thickness
   5, `softSpots: 0`, part `melt-rind` (hardness 3, `noCarveWithin 2`,
   tags `seal`). The type already allows `"sphere"` — implement/verify the
   sphere husk path in `bodySdfWorld`/`tileLayer` (the wheel is the only
   exercised surface today).
2. Hull placement gains `entrance?: { r: number }`: ONE generator-carved
   bore, r ≥ 1.4 u (cargo must pass outbound), positioned at the terminus of
   the vein trail sightline chain (the last vein chunk's sightRange must
   reach it — WG-07 validates this). The entrance is recessed and angled so
   it reads only at close range. Carved as a layer carve exempt from
   `sealed` (it belongs to the layer itself), shared into neighbours via
   `shareCarves` as usual.
3. WG-01 interaction: no soft-spot exception — the shell is never diggable.
4. Extend the verifier (WG-02 item): entrance-plugged sealed check; entrance
   clearance ≥ 1.4 u hard-fail.

**AC.** Verifier: sealed with entrance plugged, reachable with it open,
entrance bottleneck ≥ 1.4 u; orbiting at 30 u in the bench the entrance does
not read as a silhouette; the vein-trail chain reaches it via WG-07.

### WG-09 · The Melt goes cathedral: volume-first retune + rhythm data — ~1 d

**What.**
1. Retune `fondue` + `melt` biome in the bench toward cheese-parts §2: eyes
   3–5 rBase 0.34, coreEye 0.45, tunnels rBase 0.11 bends ≤ 1, deadEnds 0,
   sizeBase ~30, fused r 46→88. Caverns exceed one tile on purpose — layer
   carves already span fused tiles; that's how 25–40 u rooms come from ≤ 19 u
   eyes overlapping.
2. Budget `hazards: { meltFalls: 12, meltPools: 6, vents: 8 }` (schema from
   WG-04). Positions seeded by WG-11; cycle timing is game-side (M5) but the
   *phase offsets* are seeded here so the wait–dash–pause rhythm is
   deterministic and shared.
3. Re-run the verifier: huge carves near layer boundaries must not breach
   the melt shell or open through-routes; if sealed regresses, pull cavern
   centers inward via the existing `bodySdfWorld < -r·0.5` bias.

**AC.** Walk mode shows 3–4 distinct 25–40 u caverns per seed, far wall
visible, wide throats; verifier green.

### WG-10 · Galleries + Heart retune — ~0.5 d

**What.** Galleries: keep mite-bore numbers (1.0 u squeezes), make the
`chambers` exception read as **spherical gathering rooms** (chance ~0.12,
rBase 0.28, low rVar so they read as deliberate spheres, ~1 in 8 tiles).
Heart: retune `fresh-curd` to a single-room part (coreEye 0.5, eyes 2–4,
exits 2, deadEnds 0, size ~40) — one luminous chamber, the last air pocket,
the Gouda. Verify in walk mode; cargo bottleneck stays a reported number.

**AC.** A gallery walk hits a spherical room within ~60 s of swimming; the
heart is one readable room; verifier reports galleries as the bottleneck.

### WG-11 · Seed the props: air pockets, hazards, wreck — ~1.5 d

**Why.** Air pockets (drift, heart), melt hazards, and the driller wreck need
deterministic, replicated-for-free positions consistent with the carved
geometry — only the generator can place them.

**What.**
1. During generation (same rng stream, fixed documented draw order), emit
   world-space seed points per biome:
   - `airPocket`: top of an interior eye (eye center + up·0.6r, snapped just
     inside the surface) — drift ×6, heart ×1.
   - `wreck`: one, on the spine mid-drift (the bathyscaphe + driller).
   - `melt_fall` / `melt_pool` / `thermal_vent`: ceiling-/floor-normal points
     inside the melt's big eyes, each with a seeded phase offset.
2. Expose `getSeededProps(): SeededProp[]` (`{kind, zone, pos, dir?,
   phase?}`), reset in `disposeWorld`, included in `WorldPlan` for the bench.
3. Bench map view: toggleable markers per kind; HUD count vs budget.
4. Node fingerprint test: same seed ⇒ identical prop list.

**AC.** Counts match budgets; positions within 0.5 u of a surface in open
water (spot-check `worldDistance`); deterministic; game code does not consume
them yet (M5/M6).

### WG-12 · Scatter chunks rotate — ~2 d · after WG-06

**Why.** "Because chunks rotate, the glowing edges turn away, plunging the
crew into total darkness" — a core veins mechanic, and drift flavor.

**What.**
1. Band placement gains `rotate?: { degPerSec: number }`; each chunk gets a
   seeded axis + signed rate. Orientation is a pure function of world clock
   `t` (peers already share a synced clock for interpolation — reuse it).
2. Queries go chunk-local: `worldDistance`/`raycastSolid`/`chunkSdf` callers
   transform the probe point by the chunk's inverse rotation; the mesh gets
   the forward rotation per frame. SDF stays static in local space, so
   collision == render is preserved by construction.
3. **Digs are stored and replicated in chunk-local coordinates** for rotating
   chunks (id + local pos): a world-space dig replayed at a different `t`
   would land elsewhere. Extend the dig event with the chunk id when the
   target rotates.
4. Rates are slow (~0.5–2 °/s); collision response treats surfaces as static
   per frame (no angular velocity imparted — test that a player resting
   against a chunk isn't dragged).

**AC.** Veins chunks visibly rotate; a dig made on a rotating chunk appears
at the same spot on the cheese for a late joiner; fingerprint of non-rotating
biomes unchanged; no per-frame cost regression in still biomes.

### WG-13 · Edge-vein glow, readable from outside — ~1.5 d · after WG-06

**Why.** The trail only works if the blue mold veining is visible from
*outside* the chunk, concentrated on edges/rims, through fog at ~40 u —
today's vein look is interior shader noise.

**What.** During geometry extraction for scatter roquefort, bake a vertex
attribute from local curvature/edge distance (deterministic, remesh-stable)
and drive the emissive from it via the biome material (`veinStrength`), so
silhouette edges carry the glow. Bench check: lamp off, veins only, next
chunk findable; through a rotation period the glow disappears and returns.

**AC.** In the bench at `fogDensity ×3` with lights off, a chunk 40 u away
reads as a faint blue constellation; interior faces stay near-black; no new
material programs beyond the existing biome set.

---

## 4. P2 — the bench becomes the instrument

### WG-14 · Route + verifier visualization — ~0.5 d · after WG-02

Map view (proxies AND real build): run `verifyWorld` async after (re)build;
render the solved path as a polyline with both door pass-throughs
highlighted; HUD verdict `SEALED ✓✗ (wheel/shell) · REACHABLE ✓✗ ·
bottleneck X.XX u @ zone`. **AC:** a deliberately holed hull shows ✗ red;
shipped world shows ✓ with the galleries as bottleneck.

### WG-15 · Map view completeness — ~0.5 d

Per-biome radius rings (band/fused rMin/rMax, both hull radii); spine + soft
spot + shell entrance drawn in the **real build** view too (today proxies
only); real `getSpawnPoint()` + bell glyph in real build; rings labelled by
biome id. **AC:** the layer ladder is readable at a glance in both map modes.

### WG-16 · Bench stops duplicating the generator — ~1 d

The scattered-biome preview reimplements band placement and drifts from
`placeChunks`. Refactor: `planWorldLayout()` already returns every spec —
filter by zone + wedge cone (as the fused path already does). Pass the real
`spineIn/spineOut` into wedge `buildLayerChunks` so the preview shows door
tunnels. **AC:** preview chunk set == map layout subset for the same seed;
duplicated placement code deleted.

### WG-17 · Bench hygiene batch — ~0.5 d

(a) `syncUrl()` writes `seed`/`d`/`build` so a rerolled find is shareable;
(b) `validateWorld` debounced on every edit, red badge in ALL views;
(c) "edited vs shipped" dot per world; (d) `budgets` controls match the
WG-04 schema; (e) fix the `refreshSkin` material leak. **AC:** each item
demonstrable; autosave debounce unchanged.

### WG-18 · Perf HUD — ~0.5 d

FPS (rolling), `renderer.info`, triangle total + per-biome breakdown, last
build/remesh wall time. Bench-only overlay, all modes. **AC:** numbers sane
on the real wheel build; program count makes WG-24's win observable.

---

## 5. P3 — the performance pass

The wheel world is ~900 chunks / ~7.5M tris / ~80 s single-threaded at full
res. Order: WG-19 is the big rock; WG-21 is independent and can go first.

### WG-19 · Worker-pool meshing at build time — ~2.5 d

1. Extract SDF + field-fill + geometry-extraction into a render-free
   `src/world/sdf.ts` (`MarchingCubes` is GL-free and worker-safe).
2. `src/world/meshWorker.ts` (Vite module worker): serialized chunk in,
   buffers out via transferables (including `c.field`, so digging works).
3. Pool of `min(hardwareConcurrency - 1, 8)`; fan out after `shareCarves`;
   upload as results land (content stays deterministic — rng is complete
   before meshing).
4. Keep the sync path (`opts.workers: false`) for node, tests, verifier.

**AC.** Geometry fingerprint identical to sync for 3 seeds; ≥3× wall time on
8 cores; no >50 ms main-thread tasks during build; loader still ticks.

### WG-20 · Async dig remesh through the pool — ~1 d · after WG-19

`digAt` keeps the instant part (dig list + field edit ⇒ collision correct
immediately); the MC re-run queues on the pool, geometry swapped on arrival.
Coalesce: one in-flight remesh per chunk, latest field wins. **AC:** digging
a res-72 chunk causes no frame >16 ms; rapid digs converge; collision never
lags visual by more than one remesh.

### WG-21 · Chunk spatial hash — ~1 d

Uniform grid over chunk AABBs, built once per world build. Query from
`worldDistance`, `digAt`, `raycastSolid`, `findOpenSpot`, `shareCarves`.
Rotating chunks (WG-12) index by their bounding sphere so the cell set is
rotation-invariant. **AC:** fingerprint unchanged; chunk-tests per
`worldDistance` call drops ~10×; physics feel unchanged.

### WG-22 · Lazy meshing by distance — ~1.5 d · after WG-19

Mesh only chunks within ~120 u of a player at spawn; feed the rest to the
pool by distance as players descend. Collision needs no mesh (SDF) — but
`digAt` assumes `c.field` exists: when null, record the dig and skip the
field edit (the eventual first meshing includes it via `chunkSdf`).
**AC:** time-to-playable < 5 s at half res; digging an unmeshed chunk neither
crashes nor desyncs; no visible pop within 60 u.

### WG-23 · Dig-list hygiene — ~0.5 d

(a) Give the `digs` loop in `chunkSdf` the same `lim` bounding early-out as
holes/tunnels; (b) merge a new dig fully contained in an existing one; bucket
digs by cell past ~64 per chunk. **AC:** 500 scripted digs into one chunk
keeps remesh under 2× its 0-dig cost; geometry unchanged for non-degenerate
sets.

### WG-24 · Material uniforms + poly-budget formula — ~0.5 d

Convert `createGoudaMaterial`'s baked vec3 constants to uniforms (`uPaste`,
`uRind`, `uVein`, `uVeinStrength`); drop the shader-cache `key`; bench
`editSkin` updates uniforms in place. Replace `MAX_POLYS[res] ?? 100000`
with a `round(res³·0.3)` fallback + a near-budget build warning.
**AC:** one gouda program for all biomes in `renderer.info`; screenshot diff
none; no truncation warnings.

---

## Appendix — invariants no ticket may break

- **Determinism**: world = f(seed, difficulty, tables); rng via `mulberry32`;
  draw order is part of the format. Rotation/hazard timing are pure functions
  of the shared clock, never of local frame time.
- **Collision == render**: both come from `chunkSdf` (digs included; rotation
  applied to the query, not the field). Never edit one representation alone.
- **Tile seams**: lattice tiles abut only because spacing `2s(res-3)/res`
  equals the marched extent AND `sizeVar = 0` AND crust noise is sampled in
  world space with the layer's shared `nOff`. Per-tile res changes break
  seams — WG-22 does distance-*scheduling*, not distance-*resolution*.
- **Clearance floor**: real tunnel radius is
  `max((narrow ? 2.2 : 2.6)·2s/res, rBase·tunnelScale·s)` — quote effective
  values, never raw `rBase`, in any UI or doc.
- **Two seals, two doors, one route**: the Wheel opens only at its scattered
  soft spots (any one drilled by the crew); the melt shell opens nowhere
  (its entrance is generated at the trail terminus). The verifier proves both
  seals closed and both doors reachable after every content change.
- **Numbers ship only via `recipes.ts`** — the bench's copy buttons are the
  sole tuning path; `validateWorld` fails, it doesn't warn.
