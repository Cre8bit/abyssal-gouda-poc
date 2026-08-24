# Models

## diver.glb (download required)

The remote-player diver is the **"Astronaut" by Quaternius** — low poly,
rigged, animated, **CC0 (public domain)**.

Download it into this folder as `diver.glb`:

```bash
curl -L -o public/models/diver.glb "https://static.poly.pizza/0076345b-bbea-42d5-931c-4a5ad2050b18.glb"
```

Source page: https://poly.pizza/m/3hC2i0CTuO

If the file is missing, the game falls back to a procedural capsule diver —
everything still works.

## headmonster_skeletton.glb — the Lanternmaw

Skinned mesh + a rigged **Rigify metarig** (54 joints, no baked animation
clips: everything it does is written per-frame in `src/angler.js`).

The rig is a face metarig retargeted onto a creature, so the bone *names* are
meaningless and the skin weights are the only reliable map. Roles, as measured
from the weight centroids in the GLB:

| bones | what they actually drive |
| --- | --- |
| `spine.004` | the head-ball itself — the root, and 2854 of the total weight |
| `spine.005`, `spine.006` | upper/back of the skull, used for the body's sway |
| `jaw` → `chin` → `chin.001` | the lower jaw, hinging forward at **+Z** |
| `lip.T.L/R` + `.001` `.002` | upper lip and snout, peeled back as the maw opens |
| `forehead.L.004` … `.014` | the **illicium** (lure stalk); `.014` is the esca bulb |
| `forehead.L/R` → `temple` → `jaw.L/R` → `cheek.B` → `brow.T` | the two 13-bone trailing tentacle chains |

Notes for anyone re-exporting it:

- The model is **1 unit nose-to-tail** and faces **+Z**, so its scale is its
  length in metres (`ANGLER_LENGTH = 46`).
- GLTFLoader strips dots from node names: `forehead.L.004` → `foreheadL004`.
- `angler.js` **probes** the jaw's open direction at load rather than assuming
  a bone roll, so a re-export with different rolls still opens downward.
- `npm run angler` re-runs the headless rig checks against whatever GLB is in
  this folder.
