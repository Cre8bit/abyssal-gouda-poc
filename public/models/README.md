# Models

> **Rule:** every model added here must also be registered in the preview
> bench — `src/bench/preview.ts` (`MODELS`), served at `/preview.html`. See
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
by `src/entities/catfish.ts`.

## catfish_with_skeletton.glb (source, not loaded by the game)

Raw mesh + unbound skeleton the rigged file is generated from.

## ratdiverAbyssalGouda.glb (current player model)

The rat diver, Tripo-generated and rigged (41-joint skeleton with twist
helpers; the game drives only 16 bones procedurally — see `src/entities/diverRig.ts`).
The helmet carries the torch: the light rig is aimed by the head bone, which
is synced exactly to the player's camera. The GLB's baked "NlaTrack" swim
clip is intentionally unused; swimming is fully procedural.

If the file is missing, the game falls back to a procedural capsule diver —
everything still works.

## light_stick.glb (throwable chem light)

A Tripo-generated glow vial with a carabiner clip — two meshes, no rig, no
clips. `src/entities/lightStick.ts` only MEASURES it: the bounding box scales
the longest dimension to `LIGHT_STICK_LENGTH` (0.4 u; a rat diver is ~1.3 u
tall) and the bigger of the two meshes is the vial, which is re-materialled
UNLIT and carries the point light. The clip stays cel-shaded, black-floored
and light-capped, because it sits a few centimetres from its own lamp. The
diver's three poses around it live in `diverRig.ts` as the `lightStick` grip's
states and are authored in `/preview.html?m=stick-pose`.

## drill_tool.glb (the driller)

Rigless too; `src/entities/driller.ts` measures it, scales the longest
dimension to `DRILLER_LENGTH`, and re-parents the business end under a pivot
so the bit can spin without moving the body.

## diver.glb (legacy, no longer loaded)

The previous remote-player diver — **"Astronaut" by Quaternius**, CC0.
Source page: https://poly.pizza/m/3hC2i0CTuO

## The weld pass (`tools/weld-models.ts`)

Every file here has been through `node tools/weld-models.ts`, which unifies
the per-vertex data (position, normal, skin weights) shared by co-located
vertices while leaving the UV splits — and therefore the atlas — alone. It
fixes seam tearing under animation and seam stitching under the cel ramp; it
does not meaningfully change the vertex count, and it cannot: see the
"Welding a re-exported model" section in `AGENTS.md` for why.

**Re-run it after any re-export from Tripo or Blender.** `--check` reports
without writing, and a second pass over welded files reports zero work.
