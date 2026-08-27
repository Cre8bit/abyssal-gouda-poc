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
  world/             the map
    gouda.ts           destructible SDF cheese world (marching cubes)
    bathyscaphe.ts     tin diving bells (visual + analytic collision)
  entities/          animated creatures/bodies
    catfish.ts         lantern-catfish AI + model
    diverRig.ts        procedural skinned swim rig
    goldenGouda.ts     the Golden Gouda wheel + its levitating bits
  render/
    graphics.ts        scene, camera, post, particles, render loop
    toon.ts            shared cel-shading kit — the ONLY toon-material door
  bench/
    preview.ts         model/animation bench entry (preview.html)
    shots.ts           headless screenshot harness (?shot=)
tools/               node-run (node 24 strips types natively)
  runner.ts            CDP screenshot runner
  test-protocol.ts     protocol unit tests (npm test)
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
`world/bathyscaphe.ts`), golden gouda (the cargo, `entities/goldenGouda.ts`).

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
