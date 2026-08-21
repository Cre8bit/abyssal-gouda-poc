# Models

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
