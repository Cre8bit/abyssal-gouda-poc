# Agent notes

## Model bench — standing rule

**Every model/creature added to the game MUST be registered in the preview
bench** (`src/preview.js`, the `MODELS` array), in the same change that adds
it. The bench is served at `/preview.html` (`npm run dev`, then open
http://localhost:5173/preview.html) and exists so models and their animations
can be inspected in isolation — clips soloed, poses frozen, playback slowed,
skeleton/wireframe overlays — without launching a full game.

A registry entry is small: `{ id, label, url, cam, build(gltf) }`, where
`build()` wires the model's real animation code (import the game's rig/clip
logic, don't reimplement it) and returns `{ group, update, ui, lines, bars }`.
The header comment in `src/preview.js` documents the full instance contract;
`buildCatfish` is the template for baked-clip models, `buildDiver` for
procedural rigs.

Current entries: rat diver (procedural swim, `diverRig.js`), first-person
gloves (the local player's FP body), lantern-catfish (baked swim/bite/flicker
clips + lantern moods).

### Capturing the bench headlessly

`/preview.html?m=<id>` deep-links straight to a model. Chrome's plain
`--headless --screenshot` (and `--virtual-time-budget`) fires before the
async GLB mount, so it captures the loading screen — drive CDP instead
(`Page.navigate`, real `setTimeout` wait, `Page.captureScreenshot`). The
bench logs `bench: built <id>` to the console when the model is mounted.
