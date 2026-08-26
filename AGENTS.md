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
  systems/           per-frame simulation slices + their registry
    types.ts registry.ts effectsSystem.ts oxygenSystem.ts
    catfishSystem.ts itemsSystem.ts
  world/             the map
    gouda.ts           destructible SDF cheese world (marching cubes)
    bathyscaphe.ts     tin diving bells (visual + analytic collision)
  entities/          animated creatures/bodies
    catfish.ts         lantern-catfish AI + model
    diverRig.ts        procedural skinned swim rig
  render/
    graphics.ts        scene, camera, post, particles, render loop
    toon.ts            shared cel-shading kit
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
- **No facades/wrappers:** import directly from the module that owns the
  export (e.g. `net/mesh.ts` vs `net/sync.ts`) — no re-export index files.

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

Current entries: rat diver (procedural swim, `entities/diverRig.ts`),
first-person gloves (the local player's FP body), lantern-catfish (baked
swim/bite/flicker clips + lantern moods), tin bell (the bathyscaphe prop,
`world/bathyscaphe.ts`).

### Capturing the bench headlessly

`/preview.html?m=<id>` deep-links straight to a model. Chrome's plain
`--headless --screenshot` (and `--virtual-time-budget`) fires before the
async GLB mount, so it captures the loading screen — drive CDP instead
(`Page.navigate`, real `setTimeout` wait, `Page.captureScreenshot`). The
bench logs `bench: built <id>` to the console when the model is mounted.
