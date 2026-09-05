# Agent notes

## Project layout

The project is **100% TypeScript** — sources, tools, and configs. There are
no `.js` modules; new files are born `.ts`.

```
src/
  main.ts            entry point & orchestrator (index.html): UI/DOM, world
                     build, movement + physics, world-level net events
  state.ts           shared session state (the `game` object) + reset
  input/input.ts     layout-agnostic keys + pointer-lock mouse look
  net/               networking — no rendering imports
    protocol.ts        24-byte binary state codec (node-testable)
    mesh.ts            PeerJS full-mesh topology, channels, RTT
    sync.ts            packet dispatch, seq dedup, broadcast, events
    interpolation.ts   remote-pose snapshot buffers
    clock.ts           shared world clock (host-authoritative, NTP over
                       ping/pong) — the time base for rotation/hazard phase
  audio/
    ambience.ts        procedural abyss soundscape + SFX (Web Audio)
    voice.ts           proximity voice chat (PeerJS calls + HRTF panners)
  game/              pure gameplay logic — no three.js imports
    effects.ts         7-bit player status masks
    oxygen.ts          survival clock
    items.ts           dynamic map-object registry + replication
    cargo.ts           the rules of hauling the Golden Gouda (tuning table)
  systems/           per-frame simulation slices + their registry
    types.ts registry.ts effectsSystem.ts oxygenSystem.ts
    catfishSystem.ts cargoSystem.ts itemsSystem.ts
    drillerSystem.ts lightStickSystem.ts
  world/             the map
    gouda.ts           destructible SDF cheese world (marching cubes) —
                       the shape-family/placement IMPLEMENTATIONS, queries,
                       digging, the mesh worker pool + chunk spatial hash
    sdf.ts             render-free SDF core: chunkSdf/layer bodies/frame +
                       field fill + buffer extraction — the code shared
                       verbatim by gouda.ts, the mesh worker and node
    meshWorker.ts      Vite module worker: serialized chunk in, marching-
                       cubes buffers out via transferables (WG-19/20/22)
    recipes.ts         the cheese kit's DATA: part/biome/world recipe
                       tables (pure data, node-testable)
    verify.ts          the route verifier (sealed/reachable/clearance)
    bathyscaphe.ts     tin diving bells (visual + analytic collision)
  entities/          animated creatures/bodies
    catfish.ts         lantern-catfish AI + model
    diverRig.ts        procedural skinned swim rig
    goldenGouda.ts     the Golden Gouda wheel + its levitating bits
    driller.ts         the rind-opening power tool (one shared prop)
    lightStick.ts      the throwable chem baton (one prop per thrown item)
  render/
    graphics.ts        scene, camera, post, particles, render loop
    toon.ts            shared cel-shading kit — the ONLY toon-material door
  bench/
    preview.ts         model/animation bench entry (preview.html)
    worldgen.ts        cheese-kit worldgen bench entry (worldgen.html)
    ui.ts              tiny DOM control kit shared by both bench pages
    shots.ts           headless screenshot harness (?shot=)
tools/               node-run (node 24 strips types natively)
  runner.ts            CDP screenshot runner
  test-protocol.ts     protocol unit tests (npm test)
  test-clock.ts        shared-clock unit tests (npm test)
  test-recipes.ts      worldgen recipe-table sanity checks (npm test)
  test-worldgen.ts     route verifier + world fingerprint (npm test)
  test-collision.ts    collision == render: chunkCovers parity, dig-then-swim,
                       the effective collision radius, mesh ⊆ open for
                       scatter pairs and the empty-tile proof, against a
                       real node build (npm test)
```

## Conventions

- **Gates:** `npm run typecheck` (tsc --noEmit, strict) + `npm test` +
  `npm run lint` — all three run in CI before build.
- **Imports use explicit `.ts` extensions** (required so node can run the
  tools; unambiguous in Vite). Type-only imports use `import type`.
- **Erasable syntax only** (tsconfig enforces): no enums (use string unions /
  const objects), no namespaces, no parameter properties — every file must be
  plain JS after annotations are stripped, so the same file runs in the
  browser, node, and tsc.
- **Session state lives in `src/state.ts`** (the `game` object). Don't add
  module-level mutable `let`s for game state — put fields on `GameState` so
  `resetGameState()` keeps rebuilds/host-migration clean.
- **Simulation slices are systems** (`src/systems/`, contract in `types.ts`):
  explicit `order`, one `updateSystems()` slot per frame in main.ts (after
  input, before physics), network events routed by declared `events` kinds,
  `onPeerDisconnected` for elections, `reset()` for world rebuilds. A new
  mechanic = a system module + one `registerSystem()` line, not new inline
  blocks in main.ts.
- **Dynamic map objects go through `src/game/items.ts`** (typed registry:
  seeded spawns cost zero network, dynamic ones replicate as item+/item-/item*).
  An `item*` for an id you already hold is an authoritative **correction**,
  applied in place (`onSync`) — that is how the Golden Gouda changes hands.
- **Contested state is arbitrated by the host.** The pattern (see
  `systems/cargoSystem.ts`): peers `sendEventTo` the host alone, the host
  decides and publishes the result with `syncItem()`. Losers of a race are
  corrected by the same message that tells the winner they won, so there is
  no window in which two clients disagree. `getHostId() === null` is the
  arbiter test — it is null on the host AND in solo play.
- **No facades/wrappers:** import directly from the module that owns the
  export (e.g. `net/mesh.ts` vs `net/sync.ts`) — no re-export index files.
- **Everything lit is cel-shaded, through `render/toon.ts` and nowhere else.**
  Two doors, both landing in `toonMaterial()`, so the light bands and the ink
  rim can never drift apart:
  - GLB models → `toonify(root, { ink })`, called from the model's **own
    template prep** (`prepareDiverTemplate`, `prepareCatfishTemplate`,
    `createBellVisual`) — never from the code that mounts it. A model has
    several mount sites (game, remote clones, the bench) and one prep, so prep
    is the only place the cel pass cannot be forgotten. `toonify()` is
    idempotent, so re-prepping (the bench does) is free.
  - Meshes built in code → `toonMaterial(params, { ink, floor, shader, key })`,
    where `shader` is the model's own GLSL injection and the ink rides on top
    of it. Pass `key` whenever `shader` bakes constants into the source, or
    three's shader cache merges two looks into one.

  Never `new THREE.MeshToonMaterial` outside `toon.ts`: a hand-built one gets
  three's built-in 2-band fallback ramp and no rim. The ramp and the ink are
  deliberately unexported for the same reason. Not toon, on purpose: lamp
  bulbs and halos (`MeshBasicMaterial`/sprites), the particle/beam
  `ShaderMaterial`s, the boundary veil, and the Gouda's levitating bits —
  light sources and volumes, not surfaces.

## The cheese kit (M2) — worldgen is data + a bench

World generation is split in two on purpose:

- **`world/recipes.ts` holds every number** — `PartRecipe` (one kind of
  cheese chunk + the hardness gameplay axis + mood/desc authoring text),
  `BiomeRecipe` (placement, sizes, weighted part mix, wax material,
  budgets, modifiers), `WorldRecipe` (the ordered biome list + world
  radii + optional `frame`/`spine`). Pure data, no three.js, checked by
  `tools/test-recipes.ts`, and `validateWorld()` holds the seed-time rules
  (hull lace cap, fused sizeVar 0…) — the generator throws on violations.
- **`world/gouda.ts` holds every implementation** — the SDF shape families,
  chunk placement modes, meshing, digging, queries. `buildGoudaWorld()`
  takes an optional `world: WorldRecipe` override; the game itself always
  plays `WHEEL_WORLD`.

**One shipped world** lives in `recipes.ts` (`WORLDS.wheel`): the
cheese-parts.md six-biome map — seven parts, TWO seals (the drilled Great
Wheel, the found melt shell), one route. The classic onion and the `shell`
placement mode were retired in WG-04.

**Placement modes come in two families:**

- _Per-chunk bodies_ — `center | band`: every chunk is its own closed
  ellipsoid SDF. `band` supports `densityGrade`/`sizeGrade`
  (outward/inward), `sightline` (each chunk placed within sight of the
  already-placed trail — the dark veins), and `rotate` (WG-12: a slow
  seeded tumble — axis + signed rate per chunk from a SIDE rng stream, so
  the main stream and its fingerprint never move). Orientation is
  `rate × the clock fed to updateGouda`; queries un-rotate the probe point
  and digs are stored chunk-local, so collision == render by construction.
  A dig on a rotating chunk replicates as **chunk id + local coords**
  (`SphereDig.c`, replayed via `digAtChunkLocal`) — a world point replayed
  at a different clock would land elsewhere on the cheese.
  Scatter chunks are **independent bodies**: `shareCarves()` refuses to
  compose two ellipsoids, so two that interpenetrate become each other's
  invisible walls. `validateWorld()` therefore requires a band's `guard` to
  clear `scatterSurfaceRadius(part)` — the widest half-axis `makeChunkData`
  draws for that shape family, plus the crust. Loosening a `guard` below it
  is a rejected table, not a tuning.
- _Layer bodies_ — `fused | hull`: ONE analytic body per biome (a radial
  band of solid cheese; the Great Wheel's rounded-cylinder husk with
  soft-spot bulges; the melt shell's sphere husk with its one generated
  `entrance` bore), meshed by lattice-aligned cube tiles. Tile spacing is
  `2s(res-3)/res` — exactly the marched extent of three's MarchingCubes —
  so adjacent tiles sample identical world points and abut seam-free. Tile
  scale/res come from `sizeBase`/`res` (`sizeVar` must be 0). Carves are
  generated in WORLD space per layer (per-tile eye clusters, an inter-tile
  spanning tree + loops, side exits, the spine doors) and distributed into
  every tile they touch; `shareCarves()` then composes carves across
  interpenetrating meshes (a heart exit cuts the galleries tiles it passes
  through) — except into `sealed` tiles (`noCarveWithin`).

**Seeded props (WG-11)**: air pockets (drift ×6, heart ×1, at eye
ceilings), melt hazards (falls/pools/vents at cavern ceilings/floors, each
with a seeded phase), and the wreck are drawn at the **tail of the rng
stream** — strictly after every chunk/debris/gold/spawn draw, so the world
fingerprint is untouched. Exposed as `WorldPlan.props` / `getSeededProps()`;
the bench map view draws them (props tab, toggles per kind, HUD counts vs
budget); game systems consume them in M5/M6.

**Edge-vein glow (WG-13)**: parts tagged `edge-veins` (roquefort-float) get
an `aVein` vertex attribute baked at geometry extraction — an SDF-Laplacian
curvature probe, so convex rims and carve mouths light up and cavity
interiors stay dark; digs remesh with the glow on the new rims. A biome
material with `edgeVeins: true` (the veins wax) consumes it in place of the
interior noise-patch glow, scaled by `veinStrength` as before.

**The frame and the spine** (`WorldRecipe.frame`/`spine`): layer radii are
measured in an optionally squashed + tilted frame, which is how the whole
onion lies flat inside a squat wheel; the spine is the seeded descent route
— one through-point per layer boundary, stepping 40–80° and drifting down —
and the hull's first soft spot rides it. `getSpinePoints()`/
`getSoftSpots()` expose them after a build.

**Tune numbers in the worldgen bench, not by hand-editing tables blind.**
`/worldgen.html` (`npm run dev`) edits live copies of BOTH worlds (table
picker at the top). The panel is categorized (no giant scroll): a generate
block, a subject picker with the part/biome's mood line, then per-category
tabs (shape/carve/tunnels/look/info, place/mix/wax/game/info,
world/layers/build). Three views: part (one part, every field a slider,
live r×res + rat/cargo clearance verdicts in the HUD), biome (a wedge at
true density; fused/hull biomes render real lattice tiles WITH their
inter-tile carve network), map (proxies incl. hull silhouette, spine and
soft spots — or the real build). **Walk mode (F)** pointer-locks into a
player-speed swim (10 u/s, collision at the player's 0.6 u radius, resolved
through the game's own `pushOutOfField`) so you can navigate anything you
generate exactly like the game; the clip plane cuts along X/Y/Z through
everything. Edits autosave to localStorage; the
**copy buttons dump JSON to paste into `recipes.ts`**, which is the only
way a tuning ships. Deep links: `?world=<key>`, `?part=<id>`,
`?biome=<id>`, `?map=1`, `&build=1` (real build), `&seed=`.

Adding a new cheese part type or biome = a new table entry in `recipes.ts`
(author it in the bench, copy it out), NOT new generator code. New _shape
grammar_ (a new `PartKind`, a new placement mode, a new hull surface) is a
`gouda.ts` change.

⚠ The seeded rng stream is a pure function of the tables: draw order is part
of the world format, and `tools/test-worldgen.ts` pins the wheel-world
fingerprint (perf tickets must keep it exact; content tickets rebase it in
the same commit and say so). Editing a table changes every seed's world —
that's expected; just don't reorder the `biomes` array casually: generation
order is a contract (the Wheel's soft spots must exist before the veins
place, and the veins before the melt shell picks its entrance terminus).

Wheel-world build cost after the P3 perf pass (WG-19..24): in the browser,
meshing fans out to a worker pool (min(cores−1, 8), ~7× wall time on a
12-thread machine; sync-path geometry is bit-identical because both run the
same sdf.ts code), the GAME additionally streams chunks by distance
(`stream: true` — spawn surroundings mesh first, the rest follow the player
at ~120 u; collision needs no mesh, chunkSdf is the collider, and digs into
unmeshed chunks are recorded and baked at first meshing). Runtime queries
(worldDistance/digAt/raycast) ride a chunk spatial hash built per world
build and saturate at 8 u of open water. `worldDistance` is a `min` of
per-chunk APPROXIMATE SDFs — sign-correct, but **not a metric** (layer bands
scale by `squash`, ellipsoids by `minAxis`), so it under-reports distance by
up to 2.2×. Never compare it against a length directly: push through
`pushOutOfField()`, which divides by the measured `|∇d|` first.
`tools/test-collision.ts` T4 pins the resulting effective collision radius.
Dig remeshes run async through the pool (one in-flight per chunk, latest
field wins) — collision is exact the
moment digAt returns; a dig further than the meshing radius (a peer's, across
the map) only queues the swap and waits for someone to come look. Node and
the tests keep the sync path
(`workers: false` or no Worker global); a full-res node build still costs
~50 s — iterate at half res (the bench default). Biome wax is ONE shader
program: colors/veinStrength/edge-glow are uniforms (WG-24), so bench skin
edits write uniforms in place and never recompile.

**The WG-25 pass** cut that build 27.7 → 16.0 s of fill (worst single chunk,
which is what the pool's wall time floors at, 4.6 → 1.3 s) and bounded the
memory, with the fingerprint and every field value untouched:

- **Carve buckets** (`sdf.ts`). shareCarves can bury one chunk under
  thousands of carves (the heart takes 3,978 from the galleries tiles it
  interpenetrates) and every one of them was swept per voxel. Past 192
  carves a chunk gets a dense per-cell index and sweeps one cell's worth.
  The cell is a strict SUPERSET of what the per-carve `lim` test admits and
  keeps carves in ascending order, and the lim test still runs on every
  bucketed carve — so the applied sequence, and the field, is bit-identical
  (verified chunk-by-chunk over the whole wheel world). `chunkSdf` therefore
  dispatches to `plainSdf`/`bucketedSdf`: ONE function serving both leaves
  V8 with a mixed hot loop that costs the carve-free hull tiles ~35%.
- **Provably-empty tiles** (`gouda.ts`). 323 of the wheel world's 610 layer
  tiles hold no cheese at all. `tileMeshesEmpty()` proves it from the body
  alone — carves only remove material, so a marched box the body's surface
  cannot enter can never hold a triangle — and those tiles never fill, never
  cache a field and never enter the scene graph. The proof is conservative
  (bodySdfWorld is not a metric, so box clearance is measured against a
  Lipschitz bound on the body plus the crust-noise amplitude; an
  inconclusive box subdivides, and at the depth limit the tile is simply
  kept), it costs 4 ms for the whole world, and `test-collision.ts` T6 fills
  every flagged tile at the SHIPPED resolutions to prove it yields 0 tris.
  Tiles the proof misses are dropped by `mountOrDrop()` after the fill, on
  the measured triangle count. A dropped tile is diggable as ever (chunkSdf)
  and a dig re-queues it through the pump — except a PROVEN one, which has
  no cheese to dig.
- **Bounded field cache.** Fields are res³ Float32Arrays: a fully explored
  world used to hold 484 MB of them and streaming only deferred that. Empty
  chunks now cache none (−240 MB) and `pumpFieldCache` drops the rest for
  undug chunks past `FIELD_KEEP` (60 u — well past dig reach, so a dig
  always lands warm), which holds the dense inner biomes near 100 MB. A dig
  into an evicted chunk refills cold through the pool, digs included, since
  chunkSdf carries them.

## Model bench — standing rule

**Every model/creature added to the game MUST be registered in the preview
bench** (`src/bench/preview.ts`, the `MODELS` array), in the same change that
adds it. The bench is served at `/preview.html` (`npm run dev`, then open
http://localhost:5173/preview.html) and exists so models and their animations
can be inspected in isolation — clips soloed, poses frozen, playback slowed,
skeleton/wireframe overlays — without launching a full game.

A registry entry is small: `{ id, label, url, cam, build(gltf) }`, where
`build()` wires the model's real animation code (import the game's rig/clip
logic, don't reimplement it) and returns `{ group, update, ui, lines, bars }`.
The header comment in `src/bench/preview.ts` documents the full instance
contract; `buildCatfish` is the template for baked-clip models, `buildDiver`
for procedural rigs.

`url` is **optional**: a model built entirely in code has no GLB to fetch and
`build()` is handed `null`. All five entries ship a `url` today (the Golden
Gouda was the last code-built one), but the contract still allows it.

Current entries: rat diver (procedural swim, `entities/diverRig.ts`),
first-person gloves (the local player's FP body), lantern-catfish (baked
swim/bite/flicker clips + lantern moods), tin bell (the bathyscaphe prop,
`world/bathyscaphe.ts`), golden gouda (the cargo, `entities/goldenGouda.ts`),
driller (`entities/driller.ts`), light stick (`entities/lightStick.ts`), plus
the two **pose editors** below.

Both diver entries carry a **hold** toggle that cycles what is in the paws
(nothing → the wheel → the driller → the light stick), blends the rig into
that grip and mounts the real prop on the paw anchor the game uses — the
Golden Gouda at exactly the offset `game/cargo.ts` hands it, third person at
`HOLD_*` and first person at `FP_HOLD_*` (see below). The arms have to land ON
the wheel at every look pitch, and that toggle is how you check it without a
second player. **throw stick** on the same two entries runs the light stick's
state machine (belt grab → hold → throw) inside the live swim rig.

### The held-prop pose editors

`buildPoseEditor()` is one editor serving every held prop; a registry entry
hands it a prop factory and the grip it belongs to, and it **opens on the pose
that already ships** (`gripPlacements()` in diverRig.ts). Per-side `ArmPose`
sliders lock the arms, "gizmo select" puts a rotate handle on any of the 6
posable joints or a move/rotate handle on the prop itself, "snap to paw" drops
the prop into the hand bone's own frame at the current arm pose, and
"Export"/"copy" print the block to paste back into `diverRig.ts`. Two entries
use it today: **driller hold pose** (one state) and **light stick poses**
(three).

A grip whose `Grip.states` names several placements gets one tab per state, a
**belt ghost** of the prop at whichever state is the body fixture, and a
**play** button that walks the states through `updateDiverRig`'s own
smoothstep blend with the prop riding the paw anchor — so the preview is the
animation that ships, not a second implementation of it.

**Lighting gotcha for anything that glows from inside itself:** the shared
cel ramp (`render/toon.ts`) floors at 40/255, so an "unlit" face still takes
16% of a light — and a light inside its own body is a light 0.6 u away. That
clips to white and blooms over the whole screen when the object is carried in
first person. `entities/goldenGouda.ts` therefore asks `toonMaterial()` for
`floor: 0` — same 4 bands, same ink, black-floored — and gets its warmth from
`emissive` instead; anything orbiting close to the light (its bits) is unlit
`MeshBasicMaterial`.

A black-floored ramp is only half the fix once the model is a **sculpt**: the
ramp quantizes a light's ANGLE and never its magnitude, so a concave face —
the Gouda's bitten-out crater — points straight back at its own 620-intensity
lamp from 0.3 u and arrives at thousands of times albedo. The body material
therefore also clamps `reflectedLight.*Diffuse` (`BODY_LIGHT_CAP`) via
`toonMaterial`'s `shader` hook: the crater lands on "fully lit gold" instead of
"white hole", and a diver's torch stays far under the cap and shades normally.

Clamp the IRRADIANCE, not the shaded result, on anything **textured**. A flat
`min(reflectedLight, vec3(cap))` writes the same value on every texel that
reaches it, so the surface goes uniformly white and its map disappears — which
is exactly what the light stick's carabiner did, 0.05 u from its own burn.
`capClipLight()` in `entities/lightStick.ts` divides the surface's own albedo
back out, clamps that, and multiplies the albedo back on, scaling the whole
triple by its peak channel rather than each channel on its own so the burn's
green still tints the hardware. Its cap is therefore in ALBEDO MULTIPLES (1 =
"fully lit"), not in absolute radiance like the Gouda's — the Gouda gets away
with the flat clamp because its map is one bright gold and the crater is the
only thing that ever reaches the cap.

**Use the rig the artist shipped — don't rebuild it.** `golden_gouda.glb` is a
real skin: a `SkinnedMesh` plus an `Armature` of 8 joints, being 7 bones
weighted one per floating cheese bit and Blender's `neutral_bone`, which holds
every vertex no real bone claimed — i.e. the whole wheel (1027 of 1238 verts).
So `prepareGoudaTemplate()` only MEASURES it: which joint is the static body
(the one owning the most vertices — read off `JOINTS_0`/`WEIGHTS_0` rather than
matched by name, so a renamed armature still lands), the wheel's centre and
scale, and each bit bone's rest pose plus its own +Y, which is the direction
that bit levitates along. The levitation is then plain bone animation, written
back from the rest pose every frame so the pose stays a pure function of `t`.

The bits do three things on top of the wheel's own spin: they **breathe** out
of their sockets along that +Y, they **orbit** the wheel's axis at their own
signed rate, and they **drift** in and out along their true radial. Orbit and
drift need a pivot, so the template also measures the wheel's centre and spin
axis in the BITS' PARENT space (`hub` / `spinAxis`, pulled back through the
armature's own transform rather than assumed to match model space). The orbit
is PRE-multiplied onto the rest quaternion — it is a turn in the parent's
frame, and it has to carry the bone's outward axis and the bit's orientation
with it, or a bit slides sideways while staring one way. Drift is one-sided by
design: outward travel is generous, inward is a fraction of it, so a bit
coming home never sinks into the paste it came out of. `held` shrinks the
amplitudes only, never the rates, so picking the wheel up cannot snap a bit.

The binding is exact and one-sided — every vertex has exactly one influence at
weight 1.0, and no triangle spans two joints — and that is what lets ONE mesh
carry the two materials the lighting needs (cel-shaded, light-capped body;
unlit bits). A `SkinnedMesh` draws a material array through geometry **groups**,
which must be contiguous index ranges, so the template sorts the triangles
body-first and hands out two groups. Reordering the index buffer is safe:
skinning is per-vertex. `prepareGoudaTemplate()` is idempotent, because the
bench re-prepares the same GLTF on every switch back to the wheel.

Two nodes wrap the clone and cannot be merged: `rig` puts the wheel's centre on
the origin at world scale, `wheel` spins about that origin. One node carrying
both would swing the offset around with the rotation. Bones live in model
space, so `lift` (quoted in world u) is divided by `visual.scale` on its way
into `bone.position`.

Per-instance bones come from `SkeletonUtils.clone()` (same as `catfish.ts`),
which shares the geometry but mints a fresh `Skeleton` — so `dispose()` must
free the skeleton as well as the materials, or every hand-off of the cargo
leaks a bone texture. The bench prints `bits N / 7 bit bones`, so a re-export
that drops or renames a bit bone is visible immediately.

Note the shipped armature is FLAT (no bone parented to another bone), so the
bench's generic `SkeletonHelper` overlay has no segments to draw. The gouda
panel's own **bones** button is the useful one: it parents an arrow to each bit
bone along its +Y, so the arrows ride the real animated transform.

### Capturing the bench headlessly

`/preview.html?m=<id>` deep-links straight to a model. Chrome's plain
`--headless --screenshot` (and `--virtual-time-budget`) fires before the
async GLB mount, so it captures the loading screen — drive CDP instead
(`Page.navigate`, real `setTimeout` wait, `Page.captureScreenshot`). The
bench logs `bench: built <id>` to the console when the model is mounted.

Frame the shot from the URL as well: `?spin=0` stops the idle orbit (two
captures of one URL then frame the same thing), `?yaw=<deg>` swings the
default vantage about the model, `?dist=<u>` moves it in or out, and
`?hold=gouda|driller|lightStick` opens a diver entry with something already
in its paws. Driving the panel from `Runtime.evaluate` is fair game — the
buttons are plain DOM, and that is how the light stick's placements were
authored (click a state, click "snap to paw", click "Export", read the
console).

## The first-person body (`entities/diverRig.ts`)

`buildFpGeometry()` keeps the two ARMS — shoulder to fingertip — and deletes
everything else at prep time. The cut used to be at the ELBOW, which read as
two floating sleeves with their hollow interiors facing the camera whenever
you looked down; keeping the upper arm moves the only cut to the SHOULDER,
which the FP body offset parks below the frame.

`capOpenLoops()` closes that cut, and both halves of how it does it matter:
rings are found on **welded** positions (the export splits verts along UV
seams, so by raw index one ring is several unclosed arcs), and each ring is
fanned from a fresh **centroid** vertex appended to every attribute (the ring
is neither convex nor planar, so a fan anchored on one of its own vertices
throws long blades across the arm). The caps land at the tail of the index
buffer, which makes them a contiguous geometry **group** — so the cut can
carry its own flat, untextured material, because a centroid's borrowed UV
smears the atlas into stripes across the hole. Mount sites therefore have to
handle a material ARRAY on the FP mesh (`dressOwnSuit` in `render/graphics.ts`,
and the bench's own copy).

Placement is screenshot-tuned (`npm run runner`, the `fp-*` shots). The knob
that keeps the cut out of frame is the upper arm being swept BACK (`uy < 0`)
with the elbow folded hard: straighten the arm and the shoulder swings up into
view. The hands are HIDDEN BY DEFAULT: the level pose parks them under the
bottom frame edge with margin for the idle sway, and the look-down reveal has
a dead zone (`FP_REVEAL_START`) so small pitches — swimming along a floor,
glancing at the compass — never show them. The reveal ramps from there to
`FP_LOOK_DOWN`, landing the paws in the lower third angled in toward each
other: a neutral "ready to hold" shape for future held items. Carrying is its own pose, its own body offset AND its own scale — a rat
diver's arm is half a metre and the wheel rides over a metre out, so the arms
simply get longer while they are holding something (`FP_SCALE_CARRY`); nothing
but the arms is rendered, so there is no body to be out of proportion with.
All three cross-fade on `rig.carrySm`, and the FP pivot switches to tracking
the look EXACTLY (`fpBodyPitch`) because the wheel does.

## Grips and their states (`entities/diverRig.ts`)

What a diver has in its paws is a **grip**: one authored `GripPose` — both
arms plus the prop's transform in the rig-root frame — and the FP body offset
and arm length that go with it. `holdAnchor()` solves that placement once into
a node under the RIGHT HAND bone (`anchorLocal = boneChain⁻¹ · model⁻¹ ·
tool`, measured at `DIVER_SCALE`), so the prop inherits every stroke and sway
of the arm instead of being re-placed from the diver's position each frame.
`solveHeldAnchor()` is that solve, exported, because the bench pose editor
runs it on placements that are still being dragged around.

A grip can also name several placements in `states` and animate between them.
The light stick ships three — `grab` (the paw down at the belt, closing on a
holstered baton), `hold` (up and out in front, lighting the way) and `throw`
(swung through, paw open) — and `updateDiverRig({ carry, carryPhase })` blends
whichever is asked for over a smoothstep, at a per-state rate (`PHASE_EASE`: a
throw snaps, a reach to the belt reads as a movement). How long the timeline
SITS in each state before naming the next is `STICK_DWELL`, exported so the
game (`systems/lightStickSystem.ts`) and the bench's "throw stick" preview
walk one set of numbers. The prop's paw anchor is interpolated across the same
blend from the per-state solves, so it is always exactly where the arms
holding it put it — never a second animation that can drift out of sync with
the first. `rig.gripPhase`/`rig.gripU` are the read-back a game system times a
release off.

The light stick's states carry a SECOND right arm for first person
(`FP_STICK_*_R`), the same split `ARM_POSE_CARRY_FP` makes for the Gouda and
for the same reason: the third-person poses are authored in the bench against
a body seen from outside, and replayed at the eye they put the wrist 0.16 u
from the lens with the shoulder cut about to swing into frame. The FP set is
screenshot-tuned in the gloves bench instead. This costs nothing in
consistency, because `holdAnchor()` solves the prop into the HAND BONE's frame
from the third-person pose — so the baton is in the paw whichever arm the view
is drawing.

Every number in those states was authored in the bench, not by hand: see the
pose editors above.

## Two hold offsets (`game/cargo.ts`)

`HOLD_*` is where the Golden Gouda actually IS — the replicated item position,
and what every other diver sees in your arms. It has to be inside a rat
diver's reach or the wheel floats a body-length ahead of its carrier.

`FP_HOLD_*` is where the carrier's OWN camera draws it (`fpHoldPose`, used by
`systems/cargoSystem.ts` for the local visual only). It is further out because
the wheel is 1.24 u across in a 72° view and at the true offset it swallows the
crosshair. The gap is a first-person cosmetic, exactly like `FP_SCALE` and
`FP_OFFSET`: nobody else's view moves.

Both are RIGID IN THE VIEW FRAME — forward and down rotate with the look — so
the wheel holds one spot relative to its carrier however they tilt. It has to:
the arms are posed in that same frame, and a world-vertical drop would slide
the wheel through the hands on every pitch.

## Light sticks (`systems/lightStickSystem.ts`)

Every diver dives with four chem batons (`LIGHT_STICKS_PER_DIVER`). `[G]`
draws one from the belt or clips it back, left mouse throws it, and `[E]`
picks a thrown one back up. The mechanic is split by what has to be agreed on:

- **The belt is local.** `game.lightSticks` never crosses the wire — nobody
  else needs your count, only what you put in the water. The DRAWN stick is
  not an item either: it is a pose plus a visual in your own paw, published as
  `STATUS.HOLDING_STICK` (the last of the 7 wire bits, which picks the grip)
  plus a `stick` event per transition (which of the grip's three states the
  arms are in). Two roads on purpose: the bit is in every state packet, so a
  diver you swim up to is already holding what they are holding, while the
  event only has to carry the four transitions an animation needs.
- **A thrown stick is an item** (`game/items.ts`, kind `lightStick`),
  replicated like any other. Its THROWER integrates the flight and resyncs at
  `LOOSE_SYNC_S`; everyone else chases the synced position (`REMOTE_SMOOTH`)
  so seven samples read as a flight and not as seven hops. Water is the whole
  physics — drag until the throw is spent, then it hangs there, because a chem
  baton is neutrally buoyant and that is what makes it a breadcrumb. Picking
  one up is contested and goes through the host exactly like the driller:
  the REMOVAL of the item is the grant, so no two clients can both believe
  they took it.

The visuals come from two places, because a stick in a paw belongs to a diver
and a stick in the water does not. `entities/lightStick.ts` keeps a mount
registry keyed by ITEM ID for the thrown ones (unlike `driller.ts`, where one
shared prop is enough); `render/graphics.ts` owns the held ones, one per diver,
hung off that diver's own `holdAnchor(rig, "lightStick")`. Only the nearest
`MAX_LIVE_LIGHTS` thrown sticks keep a live `PointLight` — the vials still
glow, being unlit geometry, but a diver who has salted a gallery with a dozen
of them should not pay a uniform slot and a shader recompile for the ones
behind them.

`?shot=fp-stick` / `fp-stick-swim` capture a drawn stick in the real game (the
harness dispatches the `[G]` keydown); `__abyssal.stick` drives the whole state
machine from the console, which is how the throw was verified end to end.

## Comment Guidelines

### Allowed: Top-of-File Architecture Headers

- Multi-paragraph comments are permitted ONLY at the very top of a file (file-header level).
- File headers MUST focus exclusively on high-level architecture: file responsibility, API contract/exports, skeleton structure, parameter conventions, and frame-of-reference rules.
- Do NOT include step-by-step design history, trial-and-error logs, or subjective visual flavor text even in file headers.

### Banned: Mid-File & Inline Narrative Comments

- INSIDE functions or mid-file: keep comments strictly to 1–2 lines max.
- Zero narrative prose, historical rationale ("the old version did X"), or physical/visual metaphors inside function bodies.
- Code should explain _what_ it is doing, not why alternative values failed.
