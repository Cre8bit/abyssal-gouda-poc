# Lighting Roadmap — making the abyss dark again

The engineering plan for `src/render/toon.ts` + `src/render/graphics.ts` +
every module that owns a `THREE.Light`, taking the game from "a lit diorama
that whites out at arm's length" to a horror lighting model that is cheap,
bounded, and tunable. Written 2026-09-03 against branch `abyssal-gouda` at
`13a65d3`, three r0.179, from a measured audit of the running game (§2).

This is the engineering half of **M7 — The dark** in `plan-mvp.md`. M7.1
(`lightRange`/`fogDensity` per biome) lands on top of LT-12; M7.2 (veins as a
route graph) is unaffected and stays where it is.

**The thesis:** five separate playtest symptoms — the white-out, the torch that
barely matters, invisible far lights, seeing too far, and the freeze on `[F]` —
are four decisions, not five bugs. Two of them are three-line changes.

---

## 0. State of the code

### Where light lives today

| Emitter | File | Construction | Toggled by |
|---|---|---|---|
| Ambient hemisphere | `graphics.ts:439` | `0x12303e/0x010407, 0.2` | never |
| Directional gloom | `graphics.ts:440` | `0x2c5566, 0.07` | never |
| Local torch core | `graphics.ts:752` | spot `260 cd, 65 u, 0.44 rad, pen .75, decay 1.7`, **castShadow 1024²** | `.visible` in `setFlashlight()` |
| Local torch spill | `graphics.ts:772` | spot `32 cd, 35 u, 1.05 rad, decay 1.6` | `.visible` |
| Local torch fill | `graphics.ts:785` | point `0.4 cd, 5 u` | `.visible` |
| Remote diver lamp | `graphics.ts:1540` | spot `190 cd, 50 u, 0.5 rad`, **castShadow 512²** | `.visible` in `setPlayerLight()` |
| Remote head glow | `graphics.ts:1571` | point `1.8 cd, 12 u` | add/remove with the player |
| Catfish lantern | `catfish.ts:243` | point `55 cd, 36 u` (120 on strike) | add/remove on spawn |
| Light stick burn | `lightStick.ts:162` | point `130 cd, 40 u` (`0.6` held) | `.visible` per frame via `setLightOn()` |
| Bell cabin | `bathyscaphe.ts:101` | point `14 cd, 12 u` | add/remove with the bell |
| Bell beacon / sill | `bathyscaphe.ts:124` | point `60 cd, 45 u` / `45 cd, 35 u` | — |
| Golden Gouda lamp | `goldenGouda.ts:300` | point `620 cd, 80 u` (`×0.05` held) | — |
| Golden Gouda leak | `goldenGouda.ts:302` | point `20 cd, 170 u` | — |

Volumetric dressing exists for **remote** divers only
(`createVolumetricLight`, `graphics.ts:1558`). Halo sprites exist for the
catfish (distance-scaled, `catfish.ts:436`), the bell (fixed 2.4 u) and remote
torches. The local torch, the light sticks and the dark veins have none.

### What is already right and must not be broken

- **`toon.ts` is the only door.** Two entries (`toonify`, `toonMaterial`), one
  ramp, one ink rim. Every fix below that touches surface response goes
  *through* it, never around it.
- **One shader program per look** (WG-24): biome wax is uniforms, not
  materials. Program count is a hard budget — see LT-05.
- **`BODY_LIGHT_CAP` / `CLIP_LIGHT_CAP`** already exist in
  `goldenGouda.ts` and `lightStick.ts`. They are the correct fix applied twice
  by hand; LT-01 promotes them, it does not replace them.
- Deliberately **not** toon: bulbs, halos, beam/particle `ShaderMaterial`s, the
  veil, the Gouda's bits. That list stays as-is.

### What does not exist

No light budget, no importance sort, no distance culling of lights, no
emitter registry, no glow-billboard system, no local beam, no exposure
adaptation, no luminance regression test.

---

## 1. How to read the tickets

Each ticket is one deliverable one agent can land in one branch, with its own
acceptance criteria (AC). Priority = order. Constraints on every ticket:

- `npm run typecheck` + `npm test` + `npm run lint` green.
- Erasable TS only; imports carry `.ts`; session state on `GameState`
  (`src/state.ts`), never module-level `let`.
- **`toon.ts` stays the only place a toon material is built.** A ticket that
  needs a new response rule adds it to `toonMaterial()`'s options, it does not
  add a second `onBeforeCompile` somewhere else.
- **The world fingerprint is untouched.** Nothing here draws from the rng
  stream. `tools/test-worldgen.ts` must stay green without a rebase.
- **No program-count growth.** Every ticket states its shader-variant impact.
  `customProgramCacheKey` must include any constant a ticket bakes into GLSL.
- Comment budget per `AGENTS.md`: architecture headers at the top of a file,
  1–2 lines inside a function, no narrative.

```
LT-01 ─┐
LT-02 ─┼─► LT-03 ─► LT-04        (P0 — independent of everything below)
       │
LT-05 ─┴─► LT-06 ─► LT-07, LT-08
              └───► LT-09 ─► LT-10, LT-11
LT-12 independent, any time after LT-04
LT-17 after LT-02 (it pins the numbers LT-02 produces)
```

---

## 2. The measured baseline

Reproduce with the probe in Appendix A. Headless Chrome, 1280 × 720, seed 7,
solo, difficulty 1. `hot` = share of pixels above 0.75 display luma, `white` =
above 0.95 (detail gone).

| Vantage | mean luma | hot | white |
|---|---:|---:|---:|
| `?shot=fp-forward` (drift), torch on | 0.158 | 0.0 % | 0 % |
| `?shot=fp-forward`, torch off | 0.124 | 0.0 % | 0 % |
| `?shot=gouda` (heart cavern), torch on | 0.314 | 1.2 % | 0 % |
| **nose to a wall, torch on** | **0.770** | **63.7 %** | **18.8 %** |
| nose to a wall, torch off | 0.526 | 0.0 % | 0 % |
| **thrown light stick at a wall** | **0.854** | **79.6 %** | **45.3 %** |

Frame stalls, same session:

| Event | Stall |
|---|---:|
| First `[F]` after load | **929 ms** |
| Later `[F]` in a new scene | 59 ms |
| First `[G]` (draw a baton) | 86 ms |
| Repeat of a seen light-count combination | 0 ms |

Steady state is a clean 16.7 ms. Light census in the heart, solo:
**2 spot + 11 point + 1 hemisphere + 1 directional**, over 207 visible meshes /
2.43 M triangles, 23 materials, 1 shadow caster.

**Targets after P0 + P1** (these are the AC numbers, don't re-derive them):

- No shipped vantage above **0.2 %** white.
- Nose to a wall, torch on: **< 5 %** hot.
- Torch off, ≥ 20 u from any lamp: mean luma **< 0.05**.
- No frame over **25 ms** across a full toggle sweep (`[F]` ×4, `[G]` ×4, one
  throw, one pickup).
- Light census **constant** regardless of party size or sticks in the water.

---

## 3. P0 — exposure (fix the white-out)

Nothing structural. This is the afternoon that turns "white screen" into "lit
cheese", and it is worth landing on its own so the rest is judged against a
readable image.

### LT-01 · Global light cap in `toon.ts` — ~2 h

**Why.** three's toon BRDF is
`irradiance = getGradientIrradiance(normal, lightDir) * light.color` — the
gradient **replaces** the cosine term, it does not modulate it
(`lights_toon_pars_fragment`, three r0.179). `TOON_FLOOR = 40` (`toon.ts:45`)
then floors that gradient at 40/255, so a surface facing *directly away* from a
lamp still collects **15.7 %** of it. Irradiance 1 u from the 260 cd torch is
260; through the darkest band and the Lambert BRDF that is still ~40× full
white. Every surface within ~5 u of any lamp is clipped, on every band, on
every face.

**What.**

1. New injection in `toon.ts`, alongside `applyInk`:

   ```ts
   // Cap the direct light a surface may collect at its own albedo: the cel
   // ramp quantizes a light's angle, never its magnitude, so a lamp 0.5 u
   // away arrives thousands of times past white.
   function applyLightCap(
     shader: THREE.WebGLProgramParametersWithUniforms,
     cap: number,
   ): void {
     const c = cap.toFixed(3);
     shader.fragmentShader = shader.fragmentShader.replace(
       "#include <lights_fragment_end>",
       /* glsl */ `#include <lights_fragment_end>
       reflectedLight.directDiffuse =
         min(reflectedLight.directDiffuse, material.diffuseColor * ${c});
       reflectedLight.indirectDiffuse =
         min(reflectedLight.indirectDiffuse, material.diffuseColor * ${c});`,
     );
   }
   ```

   `material.diffuseColor` is the `ToonMaterial` struct member and is in scope
   at `lights_fragment_end` — this is the same hook `goldenGouda.ts:423`
   already uses.

2. `ToonOptions` gains `lightCap?: number`; `const TOON_LIGHT_CAP = 0.85`.
3. **The `onBeforeCompile` guard must go.** Today it is
   `if (shader || ink > 0)`, so a plain `toonMaterial({ color })` never gets an
   injection at all. The cap has to apply unconditionally.
4. `customProgramCacheKey` becomes `` `toon:${key}:${ink}:${cap}` `` — the cap
   is baked into the source, so it is a cache salt.
5. Retire the two hand-rolled copies: `goldenGouda.ts` passes
   `lightCap: 0.5` instead of its `BODY_LIGHT_CAP` shader hook,
   `lightStick.ts` passes `lightCap: 0.55` instead of `capClipLight`. Both
   keep their tighter value as an explicit override; both lose ~15 lines.

**Program impact.** One extra variant only if a caller overrides the default
(two do). Net: unchanged.

**AC.** Nose-to-a-wall vantage reports **0 %** white; the Gouda's crater and
holes are readable at 3 m (the model currently reads as a flat disc); the ink
rim and the 4 bands are visually unchanged at normal range; `npm test` green.

### LT-02 · Highlight roll-off before bloom — ~2 h

**Why.** The chain is `RenderPass → UnrealBloomPass(0.3, 0.8, 0.88) →
horrorPass → OutputPass`, and the compressor lives *inside* horrorPass
(`graphics.ts:568`) — **after** bloom. Bloom therefore high-passes raw HDR
values in the tens, blurs them at radius 0.8 and adds them back across the
frame: that is the difference between a lens halo and a fog machine. Second
half of the same mistake: ACES runs in `OutputPass`, last, so the compressor's
"caps at ~2.0" is a cap in *linear* space that ACES maps to ~0.86 display.

**What.**

1. Extract the `HIGHLIGHT COMPRESSOR` block out of the horrorPass fragment
   shader into its own `ShaderPass`, inserted between `RenderPass` and
   `UnrealBloomPass`.
2. Shoulder from **0.75**, not 1.0:
   `vec3 o = max(c - 0.75, 0.0); c = min(c, vec3(0.75)) + o / (1.0 + o * 1.6);`
   — asymptotes at ~1.375 linear, ~0.72 after ACES at exposure 1.1.
3. Raise the bloom threshold from `0.88` to `1.0` so bloom keys off the
   roll-off's shoulder rather than fighting it. Keep strength/radius.
4. Leave the chromatic dispersion, the underwater grade, the blue floor and
   the vignette where they are.

**Program impact.** One new `ShaderPass` program. No lit-material change.

**AC.** Nose-to-a-wall < 5 % hot; the Gouda, the baton vials and the bell bulbs
still visibly bloom (bloom is the point, it just stops being global); no
banding introduced on the fog gradient.

### LT-03 · Give the torch a shape — ~3 h

**Why.** Core spot `angle 0.44 rad` is a 50° cone; spill `angle 1.05 rad` is a
**120°** cone at 32 cd over 35 u. The camera is 72° vertical / ~110°
horizontal. The spill alone floods the whole frame, so the torch has no shape —
no bright core, no dark periphery, nothing for the beam to carve out of the
dark. Switching it off changes the exposure of the picture but not its
composition, which is exactly the "barely see a diff" report.

**What.** Numbers to start from; retune by screenshot, not by argument:

| Constant | Now | Target |
|---|---:|---:|
| `FLASHLIGHT_INTENSITY` | 260 | **110** |
| core `angle` / `penumbra` / `decay` | 0.44 / 0.75 / 1.7 | **0.28 / 0.55 / 2.0** |
| `SPILL_INTENSITY` | 32 | **7** |
| spill `angle` / `decay` | 1.05 / 1.6 | **0.72 / 1.8** |
| fill | `0.4 cd, 5 u` | unchanged |

`decay: 2` is the physically correct inverse square and is what makes the cone
fall off inside the room rather than at the far plane; LT-01's cap is what
makes it safe at 0.5 u.

**AC.** Standing ≥ 8 u off a wall with the torch on, the frame reads as a
bright core inside a dark surround (visible in `?shot=fp-forward` and the
`gouda` cavern shot); the crosshair is never inside a uniformly lit field.

### LT-04 · Drop the ambient floor — ~2 h

**Why.** Off is never off. Hemisphere `0.2` + directional `0.07`
(`graphics.ts:439`), plus the cheese shader's unconditional
`totalEmissiveRadiance += uPaste * inPaste * 0.04` self-glow (`gouda.ts`, the
non-`edgeVeins` branch; `0.015` on the vein branch), plus its wet sheen and
caustics, plus the snow's `0.10` base alpha (`graphics.ts`, snow fragment),
plus the horror pass's blue lift.

**What.**

1. Hemisphere `0.2` → **0.05**; gloom directional `0.07` → **0.02**.
2. The gouda self-glow becomes a uniform, not a literal: add
   `uSelfGlow: { value: number }` to `GoudaUniforms`, default **0.015**
   (matching the vein branch), wire it through `updateGoudaMaterial()` and the
   bench skin tab. **This keeps the one-program rule** — it is a uniform, same
   as `uVeinStrength`.
3. Snow base alpha `0.10` → **0.045** (the `(0.10 + lit * 0.9)` term).
4. Horror pass blue floor `vec3(0.0015, 0.005, 0.008)` → halve it.

**Program impact.** None (uniform, not a constant).

**AC.** Torch off, ≥ 20 u from any lamp, mean luma **< 0.05**; the paste still
reads as cheese-coloured (not grey) when a torch does hit it; the bench's skin
sliders still write live with no recompile.

> **⏸ Judgement point.** Play it here, solo, from the bell to the veins. P0 is
> the whole change to how surfaces respond to light — everything after this is
> budget and dressing. If the abyss does not feel dark *now*, the numbers in
> LT-03/LT-04 are wrong and no amount of P2 will save it.

---

## 4. P1 — the light budget (kill the freeze, cap the cost)

### LT-05 · `render/lighting.ts` — the fixed light pool — ~1.5 d

**Why.** Measured **929 ms** on the first `[F]` after load. three's program
cache key contains `numDirLights / numPointLights / numSpotLights`
(`WebGLPrograms.getProgramCacheKey`), and `object.visible === false` removes a
light from the list entirely (`projectObject` returns early). So every light
toggle in the game is a synchronous recompile-and-relink of every lit material
in the scene. Repeat toggles are free because that combination is now cached —
which is why it reads as "*sometimes* freezes".

Second reason: three does not range-cull point lights. A catfish lantern 240 u
away costs exactly what one in your face costs, on every fragment of every
wall. Solo that is 11 point lights; a four-diver session with a salted gallery
and a berth of bells is around thirty.

**What.** One new module, `src/render/lighting.ts`. It is a *render* module,
not a `systems/` slice: it has no simulation state and no network events.

```ts
export interface Emitter {
  id: string;
  kind: "spot" | "point";
  /** World position, written by the owner each frame. */
  position: THREE.Vector3;
  /** Spot only: unit aim direction, world space. */
  direction?: THREE.Vector3;
  color: THREE.Color;
  /** 0 = dark. The owner drives this; nobody touches `.visible`. */
  intensity: number;
  range: number;
  decay?: number;
  /** Bias in the importance score. The carried Gouda and the local torch
   *  outrank a lantern regardless of distance. */
  priority?: number;
  /** Optional glow billboard (LT-09). */
  halo?: { size: number; opacity: number; color?: THREE.ColorRepresentation };
}

export function initLighting(scene: THREE.Scene, camera: THREE.Camera): void;
export function registerEmitter(e: Emitter): Emitter;   // returns the same object
export function unregisterEmitter(id: string): void;
export function updateLighting(): void;                  // once per frame
export function resetLighting(): void;                   // world rebuild
```

Internals, and the rules that make it work:

1. `const SLOTS = { spot: 2, point: 8 }`. Slot lights are created in
   `initLighting()`, `scene.add`ed **once**, and never removed, never hidden,
   never have `castShadow` changed. `spot.target` is added to the scene too.
2. **Slot 0 (spot) is reserved for the local torch**, permanently, and is the
   only shadow caster in the game (LT-07). It is never re-assigned, so the
   light the player is looking down never flickers between owners.
3. Each frame `updateLighting()` scores every registered emitter:
   `score = intensity * (1 + priority) / (1 + d²)` where `d` is distance to
   the camera. Emitters with `intensity <= 0` score 0.
4. **Hysteresis**, or slots thrash and you get popping: an emitter holding a
   slot keeps it until a challenger beats it by **25 %**, and a slot that
   changes owner ramps `intensity` over ~0.15 s rather than snapping.
5. Winners are written into the slot lights (`position`, `color`, `intensity`,
   `distance`, `decay`; spots also `target.position`). **Losers and unused
   slots get `intensity = 0`** — never `visible = false`. An intensity-0 light
   costs a few ALU per fragment and zero compiles.
6. Emitters below the cut still draw their billboard (LT-09), so they don't
   disappear — they stop *lighting*, which at range nobody can tell.
7. `updateLighting()` is called from `renderLoop()` in `graphics.ts`, after
   `updateLocalBody`/`updateRemoteDiver` (so positions are current) and before
   `composer.render()`.

**Program impact.** Locks the light counts for the whole session: exactly one
lit-material variant, compiled once at first draw.

**AC.**
- `grep -rn "isLight\|Light)" src | grep "\.visible"` returns nothing.
- No `scene.add` / `scene.remove` of a `THREE.Light` after `initGraphics()`.
- Probe reports **no frame over 25 ms** across the toggle sweep in §2.
- Census constant at `2 spot + 8 point + 1 hemi + 1 dir` with 0 players and
  with 3 fake remote players + 8 sticks in the water.

### LT-06 · Migrate every emitter onto the pool — ~1 d

**Why.** LT-05 is inert until the owners stop holding real lights.

**What.** One conversion per owner. In every case the visual (bulb mesh, halo
sprite, beam) stays where it is — only the `THREE.Light` moves.

| Owner | Change |
|---|---|
| Local torch (`createFlashlight`) | core spot → **slot 0**, permanent. `setFlashlight()` writes `intensity` (0 / `FLASHLIGHT_INTENSITY`), not `.visible`. Spill and fill become pooled emitters with high `priority`. |
| Remote diver lamp | `registerEmitter` on `addPlayer`, `unregisterEmitter` on `removePlayer`. `setPlayerLight()` writes `intensity`. **`castShadow` removed** (LT-07). |
| Remote head glow | pooled point, low priority, `halo` carried from the existing sprite. |
| Catfish lantern | `spawnOne` registers; `despawnCatfish` unregisters. The mood code (`f.light.intensity += …`) writes the emitter's `intensity` instead — same maths, one indirection. |
| Light stick | `createLightStickVisual` registers; `dispose` unregisters. **`MAX_LIVE_LIGHTS` and `setLightOn()` are deleted** — the pool's importance sort replaces the nearest-six rule, and does it better (a stick behind you loses to one ahead). `LIGHT_HELD` stays: a held baton registers at 0.6 cd. |
| Bell fixtures | cabin/beacon/sill register on `createBellVisual`, unregister on `dispose`. `setLamp()` writes intensity. |
| Golden Gouda | lamp + leak register; `held` still multiplies by `LAMP_HELD`; `priority: 2` so the party's cargo never loses a slot. |

**Watch for:** `removePlayer()` currently disposes lights by traversal
(`graphics.ts:1706`) — that path must unregister instead, and must not dispose
a pooled slot light.

**AC.** The 929 ms stall is gone from a cold load; `[G]`, `[F]`, throw and
pickup are all under 25 ms; sticks still light the gallery they were thrown
into; a stick behind a wall does not steal a slot from one in front.

### LT-07 · Shadow budget — ~4 h

**Why.** The torch is a 1024² shadow caster re-rendered every frame
(`shadowMap.autoUpdate = true`) over 207 meshes / 2.43 M triangles, and every
remote diver's lamp adds a 512² one. Four divers is five full scene traversals
per frame. Toggling `castShadow` is also a program-key change, so it can never
be dynamic (LT-05 rule 1).

**What.**

1. Only slot 0 casts. Remote lamps are constructed with `castShadow = false`
   and stay that way — a shadow you can only see from someone else's torch is
   not worth a scene traversal.
2. `spot.shadow.camera.far` **65 → 25**. Nothing readable is shadowed past
   that, and the depth range is what the map resolution is spent on.
3. `renderer.shadowMap.autoUpdate = false`; in `renderLoop`, set
   `shadowMap.needsUpdate = true` when the camera has moved > **0.15 u** or
   turned > **0.02 rad** since the last shadow render, else reuse.
   **Movement-gated, not rate-gated** — the note at `graphics.ts:431` about a
   30 Hz throttle flickering is correct and is about a *rate* throttle; a
   stationary camera has a stationary shadow, so reusing it is exact.

**AC.** No visible shadow flicker while swimming or while still; measurable
frame-time drop with 3 fake remote divers (compare `probe`'s mean frame ms at
`--disable-frame-rate-limit`); shadows still land under the diver's own hands
in first person.

### LT-08 · Emitters follow the shared clock, not local time — ~2 h

**Why.** Small, but it belongs to this pass: the light stick's flicker and the
Gouda's pulse run on local `elapsed`, so two divers looking at the same baton
see it breathe out of phase. `net/clock.ts` already exists and `updateGouda`
already uses it.

**What.** Feed `worldNow()` into `LightStickVisual.update` and
`GoudaVisual.update` at the call sites in `graphics.ts` / the systems. No
protocol change — the phase is a pure function of the shared clock.

**AC.** Two clients on one machine show the same baton at the same brightness.

---

## 5. P2 — the mood (build the dark)

### LT-09 · Glow billboards, one for every emitter — ~1 d

**Why.** Fog kills far lights. A chem baton's whole long-range presence is a
0.2 u unlit vial and a 40 u point light, both fogged out by the same
exponential that is supposed to hide *geometry*. The catfish is the only
emitter that solves this, by hand (`catfish.ts:436`): its halo sprite grows
with distance. The bell uses a fixed 2.4 u halo. The batons and the dark veins
have nothing — so the vein trail, which *is* the navigation mechanic, only
exists once its chunk is meshed and close.

**What.** `lighting.ts` owns one additive billboard system, fed by every
emitter that declares `halo`:

1. One `THREE.Points` (or `InstancedMesh` of quads) with a `ShaderMaterial`:
   `blending: AdditiveBlending`, `depthWrite: false`, **`fog: false`**,
   `transparent: true`. One draw call for every light in the world.
2. Per-instance attributes: world position, colour, base size, base opacity.
3. The distance curve is the point of the ticket — it must *not* be the fog
   curve:
   - screen size `size = base * (1 + d * 0.012)` clamped to `base * 4`
     (generalises the catfish's `min(3.2, 0.7 + d * 0.012)`);
   - alpha `opacity / (1 + d² / D²)` with `D ≈ 220 u`, so a light is a dim
     point at the horizon rather than nothing.
4. Fed from the emitter's *live* `intensity`, so a snuffed baton's halo dies
   with its light and a pooled-out one keeps glowing.
5. Retire the per-owner sprites it replaces (catfish `glow`, bell halos,
   remote head glow) — one system, one look.

**AC.** From 300 u a thrown baton is a visible green point; from the drift the
bell berth reads as a cluster of warm points; ≤ 1 draw call and 0 extra
programs added per emitter.

### LT-10 · The local torch gets a beam — ~5 h

**Why.** `createFlashlight()` builds spot + spill + fill and **no volumetric
beam**, while every remote diver gets
`createVolumetricLight({ length: 22, endRadius: 4.6 })`. The one light the
player looks at all game is the least dressed light in the game. This, plus
LT-03, is the whole "turning it off should feel like something".

**What.**

1. `createVolumetricLight({ length: 14, endRadius: 2.4, tint: 0xfff1cd,
   strength: 0.28 })` mounted on the flashlight group.
2. **It must not fill the near plane.** Translate the cone geometry so it
   starts ~0.6 u in front of the lens, `depthWrite: false`, and give it a
   `renderOrder` after opaque geometry. Verify by putting the camera 0.4 u from
   a wall — the beam must not become a white sheet (which is the failure mode
   the remote beams never hit because you are never inside one).
3. Drive `uIntensity` from the torch emitter's own intensity so the cone fades
   with the light instead of popping.
4. Add a lens halo at the source: a `createHalo(0.5, 0.22)` on the flashlight
   group, or an emitter `halo` on slot 0 once LT-09 lands.
5. The snow shader already receives the local beam pose in `uLightPos[0]`
   (`updateSnowLightUniforms`), so the motes are already lit correctly — only
   the visible cone is missing. Do not touch that path.

**AC.** `?shot=fp-forward` shows a cone in the water; nose-to-a-wall shows no
beam sheet; `[F]` off removes the cone in the same frame as the light.

### LT-11 · Vein beacons — ~5 h

**Why.** "Follow the lights" is the dark veins' whole verb (`plan-mvp.md`, M7.2
and the layer ladder), and today the trail only exists as per-fragment emissive
on meshed geometry. Streamed-out chunks contribute nothing, and fog eats what
is left.

**What.**

1. `gouda.ts` exposes the centres of chunks whose part is tagged
   `edge-veins` — a `getVeinBeacons(): { x, y, z, strength }[]` alongside
   `getSpinePoints()` / `getSoftSpots()`, read off the plan, **not** from the
   rng stream.
2. `graphics.ts` registers one halo-only emitter per beacon (`intensity: 0`,
   `halo` sized from `strength`). ~126 of them, all in the one LT-09 draw
   call, all costing zero light slots.
3. The beacon rides the chunk's rotation (WG-12) — read the same
   `spin.cos/sin` the mesh uses, or park the beacon at the chunk centre where
   rotation is a no-op.

**AC.** From the drift the vein trail reads as a chain of lights; the chain
does not appear or vanish as chunks stream in and out.

### LT-12 · Two media: fog for surfaces, curves for lights — ~4 h

**Why.** `FOG_BANDS` (`graphics.ts:165`) bottoms out at density `0.0038`
outside the ball — `3/σ` ≈ **790 u of visibility**. That is the seeing-too-far.
At the heart it is `0.047`, ~64 u. One exponential is being asked to hide
geometry *and* to carry light, and it cannot do both.

**What.**

1. Raise the outer ladder. Suggested first pass, keeping the inner bands:

   | r | now | target | ≈ visibility |
   |---:|---:|---:|---:|
   | 900 (spawn) | 0.0038 | **0.010** | 300 u |
   | 400 (drift) | 0.005 | **0.012** | 250 u |
   | 360 (reef) | 0.007 | **0.015** | 200 u |
   | 310 (chimneys) | 0.010 | **0.018** | 167 u |
   | 255 (scree) | 0.015 | **0.022** | 136 u |
   | ≤ 205 | unchanged | unchanged | |

2. LT-09's billboards are already `fog: false`, so the beacons survive the
   raise. **Land LT-09 before this**, or the drift goes blind.
3. Optional, worth a screenshot test: pre-divide the gouda shader's
   `totalEmissiveRadiance` by the fragment's fog factor so a glowing rim
   outlives its own albedo. One line in the existing injection, no new uniform.
4. Note the perf coupling: `updateGouda` derives its cull distance from
   `3 / fog.density` (`gouda.ts:1767`), so this ticket is also a draw-call cut.

**AC.** At spawn the far side of the ball is a glow, not a silhouette; the bell
berth is still findable from 250 u; chunk count drawn at spawn drops
measurably.

### LT-13 · Dark adaptation — ~3 h

**Why.** A hard cut to black reads as a bug; a slow adaptation reads as eyes.
It is also the cheapest way to make `[F]` off *feel* expensive.

**What.** `renderer.toneMappingExposure` driven from a module-level target +
current pair in `graphics.ts` (render state, not session state — same shelf as
`shake`/`moveFactor`, so it does not belong on `GameState`): torch off → target **0.75** immediately,
then ease to **1.25** over ~6 s; torch on → snap back to **1.1** over ~0.3 s.
Same treatment when the Gouda is picked up or dropped (it is the party's lamp).

**AC.** Killing the torch in a lit gallery goes dark and then partly recovers;
no exposure pumping while swimming through mixed lighting (the ease rates are
the knob).

---

## 6. P3 — light as a mechanic (sketch only)

Cheap once emitters are data. Not scoped here; each is a day or less.

- **LT-14 · Torch flicker and battery.** Intensity is already a per-frame
  write; a battery is one number on `GameState` and one HUD element.
- **LT-15 · Catfish react to light.** `stalk` already dims the lantern; the
  inverse — a fish that notices *your* torch — needs only the emitter list the
  pool already maintains.
- **LT-16 · The Gouda as the party's only lamp.** `setFlashlight(false)` on
  carry already ships; with P0–P2 landed it finally *means* something, and the
  haul becomes a lighting formation problem.

---

## 7. Guardrail

### LT-17 · Luminance regression — ~4 h

**Why.** `tools/test-worldgen.ts` pins a world fingerprint so a perf ticket
cannot silently move the world. Nothing pins the *image*, which is how
nose-to-a-wall got to 18.8 % white without anyone noticing.

**What.** `tools/test-lighting.ts`, run from `npm test` behind an opt-in flag
(it needs Chrome and a dev server, so it cannot be unconditional):

1. Drive the existing shot harness over a fixed list of vantages — at minimum
   `fp-forward`, `gouda`, `bell`, plus a nose-to-a-wall and a
   stick-thrown-at-a-wall case (both reachable by holding `KeyW` from a shot
   preset, see Appendix A).
2. For each: capture, measure mean / hot / white, and time every frame across a
   toggle sweep.
3. **Fail** if any vantage exceeds **0.2 %** white, or any frame exceeds
   **40 ms**, or mean luma moves more than ±0.08 from a checked-in baseline
   JSON.
4. Baselines live in `shots/lighting-baseline.json` and are rebased in the same
   commit as a deliberate look change, with the reason in the message — same
   contract as the world fingerprint.

**AC.** The test fails on today's `13a65d3` and passes after P0 + P1.

---

## Appendix A — the probe

Sixty lines of CDP; this is what produced every number in §2. Chrome must be at
`/Applications/Google Chrome.app/...`, `npm run dev` running on 5173.

```ts
// Launch: --headless=new --remote-debugging-port=9333 --window-size=1280,720
//         --user-data-dir=/tmp/abyss-probe --no-first-run
// Connect: fetch http://127.0.0.1:9333/json/new?about:blank (PUT) →
//          WebSocket on webSocketDebuggerUrl; send {id, method, params}.
// Enable Page + Runtime, then Page.navigate to
//   http://localhost:5173/?shot=gouda&seed=7&settle=90
// Poll Runtime.evaluate("!!window.__shotReady") until true (the world build
// takes ~20 s; allow 5 min).

// Per-frame timing:
window.__frames = [];
(function loop() {
  const t = performance.now();
  if (window.__lastT) window.__frames.push(t - window.__lastT);
  window.__lastT = t;
  requestAnimationFrame(loop);
})();

// Luminance of a captured PNG (pass Page.captureScreenshot's base64 back in —
// drawImage on the live WebGL canvas reads back blank without
// preserveDrawingBuffer):
window.__stats = (b64) => new Promise((res) => {
  const img = new Image();
  img.onload = () => {
    const off = document.createElement("canvas");
    off.width = 320; off.height = 180;
    const g = off.getContext("2d");
    g.drawImage(img, 0, 0, 320, 180);
    const d = g.getImageData(0, 0, 320, 180).data;
    let sum = 0, hot = 0, white = 0; const n = 320 * 180;
    for (let i = 0; i < d.length; i += 4) {
      const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      sum += l; if (l > 0.75) hot++; if (l > 0.95) white++;
    }
    res({ mean: sum / n, hot: hot / n, white: white / n });
  };
  img.src = "data:image/png;base64," + b64;
});

// Light census (the scene is reachable through the mounted Gouda):
let n = window.__abyssal.goudaVisual()?.group; while (n && n.parent) n = n.parent;
n.traverse(o => { if (o.isLight) { /* o.type, o.castShadow */ } });

// Driving the game: dispatch real KeyboardEvents on window —
//   KeyF torch, KeyG draw a baton, KeyW swim (keydown, wait, keyup).
//   window.__abyssal.stick.hurl() throws;  __abyssal.teleport(x, y, z).
// Nose-to-a-wall = ?shot=gouda then hold KeyW for ~2.5 s.
```

## Appendix B — reference numbers

**three r0.179 facts this roadmap depends on** (re-verify on a version bump):

- `RE_Direct_Toon` = `getGradientIrradiance(normal, lightDir) * light.color` —
  **no `dotNL` factor**. `lights_toon_pars_fragment`.
- `getDistanceAttenuation` = `1 / max(pow(d, decay), 0.01)` × a
  `pow2(saturate(1 - pow4(d / cutoff)))` window. It has **no near-field
  softening**: at d < 1 it grows without bound.
- Spot/point uniform colour is `light.color * light.intensity` with no `4π`
  division — intensity is candela, and 260 at 1 u means irradiance 260.
- `getProgramCacheKey` includes `numDirLights`, `numPointLights`,
  `numSpotLights` (and the shadow counts). `projectObject` skips
  `visible === false`, so hiding a light changes the count.
- `WebGLRenderer.setProgram` recompiles when
  `materialProperties.lightsStateVersion !== lights.state.version` and the new
  cache key has no cached program. Link status is checked lazily on first
  `getUniforms()` — i.e. it stalls the frame.
- `EffectComposer`: tone mapping runs in `OutputPass`, **after** every custom
  pass. Anything a pass does above 1.0 is happening in linear space.

**Current light census, heart, solo, difficulty 1:** 2 spot (torch core +
spill) + 11 point (5 catfish, 3 bell, 2 Gouda, 1 torch fill) + 1 hemisphere +
1 directional. 207 visible meshes, 2.43 M triangles, 23 materials, 1 shadow
caster.
