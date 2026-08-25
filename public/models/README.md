# Models

> **Rule:** every model added here must also be registered in the preview
> bench — `src/preview.js` (`MODELS`), served at `/preview.html`. See
> `AGENTS.md`.

## catfish_rigged.glb (lantern-catfish mob)

The anglerfish-catfish, programmatically skinned and animated from
`catfish_with_skeletton.glb` (Tripo mesh + Rigify-style metarig, 54 bones:
spine chain, face/jaw, whisker chains, shoulder fins, 12-bone lantern stalk
ending at the `forehead.L.017` bulb). Blender's auto-weights failed on the
holey shell, so weights are distance-to-bone-segment with falloff and
Laplacian smoothing — see `tools/rig_catfish_blender.py` for the same
algorithm as a runnable Blender script. Baked clips: `swim` (2.4 s loop),
`bite` (1.1 s one-shot), `flicker` (1.8 s loop, bulb pulse). Driven in-game
by `src/catfish.js`.

## catfish_with_skeletton.glb (source, not loaded by the game)

Raw mesh + unbound skeleton the rigged file is generated from.

## ratdiverAbyssalGouda.glb (current player model)

The rat diver, Tripo-generated and rigged (41-joint skeleton with twist
helpers; the game drives only 16 bones procedurally — see `src/diverRig.js`).
The helmet carries the torch: the light rig is aimed by the head bone, which
is synced exactly to the player's camera. The GLB's baked "NlaTrack" swim
clip is intentionally unused; swimming is fully procedural.

If the file is missing, the game falls back to a procedural capsule diver —
everything still works.

## diver.glb (legacy, no longer loaded)

The previous remote-player diver — **"Astronaut" by Quaternius**, CC0.
Source page: https://poly.pizza/m/3hC2i0CTuO
