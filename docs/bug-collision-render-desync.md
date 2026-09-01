# Invisible walls — the collision ≠ render desync

**Symptom.** Tunnels and openings that are clearly rendered, clearly wide
enough for a 0.6 u rat, refuse to let the player through. The same thing
happens after digging: the mesh opens, you can see through the hole, you
cannot enter it. Occasionally the driller "works" (`changed: true`, mesh
updates) and the wall is still there.

**The broken invariant.** `collision == render` — the whole world is one
SDF, meshed by marching cubes and collided by evaluating the same SDF.
The invariant currently fails in five distinct, independently reproducible
ways. Only one of them is the discretisation error people usually blame;
the other four are logic bugs.

Before anything else, one correction to the usual mental model, because it
inverts two of the three hypotheses in the original discussion:

> `worldDistance()` is a **`min` over chunks**, i.e. a **union of solids**.
> A chunk that is _missing_ from the query makes the world **more open**.
> A chunk that is _wrongly included_, or _included but not updated_, makes
> the world **more solid**.

So an invisible wall is never a _missing_ chunk. It is always a chunk that
says "solid" at a point where **its own mesh does not exist** (or is not
visible), and which nothing else can override — because `min` cannot be
overridden by an open neighbour.

---

## 0. Verdict on the three hypotheses from the discussion

| Hypothesis                                        | Verdict                        | Why                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Spatial-hash padding (WG-21)**               | **Not the bug — and inverted** | [gridReach()](src/world/gouda.ts#L3116) already pads by `GRID_SAT = 8` and `DIG_PAD = 3`, and the bucket is a superset. More importantly, missing a chunk in a `min` makes the point _more open_, never solid. Padding the query by the player radius would be a correctness downgrade, not a fix.                                                               |
| **2. `shareCarves` desync main-thread vs worker** | **Not the bug**                | [shareCarves()](src/world/gouda.ts#L2367) runs inside `buildWorldData()`, strictly _before_ any meshing. [serializeChunk()](src/world/gouda.ts) hands the worker the _same_ `holes`/`tunnels` arrays. Worker and main thread evaluate identical `ChunkShape` data through identical `sdf.ts` code. **However** `shareCarves` has a real, different bug — see §2. |
| **3. Iso-level mismatch**                         | **Not the bug**                | [meshChunkBuffers()](src/world/sdf.ts#L597) sets `mc.isolation = 0` and [fillField()](src/world/sdf.ts) writes `field = -chunkSdf(...)`. The mesh is exactly the SDF's zero set. There is a _sub-cell_ reconstruction error (§6), but no threshold mismatch.                                                                                                     |

---

## 1. BUG A — the dig predicate and the collision predicate are different shapes

**This is the one that matches "I carved it and still can't get through".**

A layer-body tile (`fused`/`hull` biomes: the melt, the galleries, the
Great Wheel, the melt shell) is authoritative over a **box**:

[tileFieldCovers()](src/world/gouda.ts#L3078)

```ts
const cellW = (2 * c.s) / c.res;
const pad = SMOOTH_K * c.s + 2 * cellW; // SMOOTH_K = 0.05
const lo = -(c.s - cellW) - pad;
const hi = c.s - 2 * cellW + pad;
```

[chunkContribution()](src/world/gouda.ts#L3175) honours that box. But
[digAt()](src/world/gouda.ts#L936) uses a **sphere**:

```ts
// gouda.ts:961
if (dc > (c.body ? c.s * 1.74 : c.s * 1.35) + r) continue;
```

A box is not a sphere. The worst-axis half-extent of the coverage box is

$$\text{half} = (s - \text{cellW}) + \text{pad} = 1.05\,s + \text{cellW}$$

so its **corner** sits at

$$d_{\text{corner}} = \sqrt{3}\,(1.05\,s + \text{cellW}) = s\left(1.8187 + \frac{3.4641}{\text{res}}\right)$$

while the dig only reaches `1.74·s + r`. Every tile therefore has eight
corner pockets where **collision listens to the tile but digging does not**:

| biome       | `s` | `res` | `cellW` | coverage corner | dig reach (hands, r=0.7) | dig reach (driller, r=2.4) | blind shell     |
| ----------- | --- | ----- | ------- | --------------- | ------------------------ | -------------------------- | --------------- |
| galleries   | 18  | 72    | 0.500   | **33.60**       | 32.02                    | 33.72                      | 1.58 u / 0      |
| melt        | 30  | 64    | 0.938   | **56.18**       | 52.90                    | 54.60                      | 3.28 u / 1.58 u |
| melt-shell  | 20  | 48    | 0.833   | **37.82**       | 35.50                    | 37.20                      | 2.32 u / 0.62 u |
| great-wheel | 46  | 48    | 1.917   | **86.98**       | 80.74                    | 82.44                      | 6.24 u / 4.54 u |

And critically — a tile's **marched geometry** only spans
`±(s − cellW)`, corner `1.732·(s − cellW)` = **30.3 u** for the galleries.
So the 30.3 → 33.6 u shell is a region where the tile:

- contributes solid to `worldDistance` ✅
- has **no triangles of its own** ❌ (invisible)
- **is never touched by `digAt`** ❌

The mesh you are looking at there belongs to the _neighbouring_ tile
(spacing `2s(res−3)/res` = 34.5 u for the galleries, so the boxes overlap).
`digAt` opens the neighbour, its mesh visibly opens, and the far tile keeps
its untouched solid in the `min`.

> **Result: you dig a hole you can see straight through and cannot enter.**

The screenshot's readout `x 0.1 y −21.2 z −18` is frame radius ≈ 41.4 in the
squashed/tilted frame — the **galleries**, near its 46 u boundary with the
**melt**. That is exactly where 18 u galleries tiles and 30 u melt tiles
overlap, i.e. where the largest blind shell (3.28 u, melt tiles) applies.

This bug is **deterministic and identical on every peer** (same predicate,
same world), so it never shows up as a multiplayer desync — it is uniformly
wrong everywhere.

### Fix A

Collapse the two predicates into one. A chunk that is allowed to say
"solid" must be a chunk the dig can reach.

```ts
// src/world/gouda.ts — replace tileFieldCovers, add chunkCovers

// A layer tile's field is authoritative inside its marched box plus the
// carve-distribution pad. `extra` inflates it by a dig radius.
export function tileFieldCovers(
  c: Chunk,
  x: number,
  y: number,
  z: number,
  extra = 0,
): boolean {
  const cellW = (2 * c.s) / c.res;
  const pad = SMOOTH_K * c.s + 2 * cellW + extra;
  const lo = -(c.s - cellW) - pad;
  const hi = c.s - 2 * cellW + pad;
  const dx = x - c.center.x;
  if (dx < lo || dx > hi) return false;
  const dy = y - c.center.y;
  if (dy < lo || dy > hi) return false;
  const dz = z - c.center.z;
  return dz >= lo && dz <= hi;
}

// THE authority predicate. Collision, digging and culling all read this:
// a chunk that can report solid at p must be diggable at p.
export function chunkCovers(
  c: Chunk,
  x: number,
  y: number,
  z: number,
  extra = 0,
): boolean {
  if (c.body) return tileFieldCovers(c, x, y, z, extra);
  const dx = x - c.center.x,
    dy = y - c.center.y,
    dz = z - c.center.z;
  const reach = c.s * 1.4 + extra;
  return dx * dx + dy * dy + dz * dz <= reach * reach;
}
```

```diff
 // gouda.ts — digAt()
     const dc = Math.sqrt(dx * dx + dy * dy + dz * dz);
-    if (dc > (c.body ? c.s * 1.74 : c.s * 1.35) + r) continue;
+    if (!chunkCovers(c, x, y, z, r)) continue;
```

```diff
 // gouda.ts — chunkContribution()
   if (c.body) {
-    if (dc - c.s * 1.74 > best) return best;
-    if (!tileFieldCovers(c, x, y, z)) return best;
+    if (!tileFieldCovers(c, x, y, z)) return best;
     const d = chunkSdf(c, dx / c.s, dy / c.s, dz / c.s) * c.s;
     return d < best ? d : best;
   }
-  if (dc - c.s > best) return best;
-  if (dc > c.s * 1.4) {
+  if (dc - c.s > best) return best;
+  if (!chunkCovers(c, x, y, z)) {
     const d = dc - c.s * (R0 + 0.25);
     return d < best ? d : best;
   }
```

(The `dc - c.s * 1.74 > best` early-reject must go: after the fix it can
reject a point the dig _does_ reach, re-opening the mismatch in the other
direction. The box test is roughly as cheap as the sphere test anyway.)

Finally, keep the spatial hash a superset of the new predicate:

```diff
 function gridReach(c: Chunk): number {
-  return c.body
-    ? c.s * 1.9 + DIG_PAD
-    : Math.max(c.s * 1.4, c.s * 0.85 + GRID_SAT, c.s * 1.35 + DIG_PAD);
+  if (c.body) {
+    // √3 × the coverage box's worst-axis half-extent, plus the dig ball.
+    const cellW = (2 * c.s) / c.res;
+    return Math.sqrt(3) * (1.05 * c.s + cellW) + DIG_PAD;
+  }
+  return Math.max(c.s * 0.85 + GRID_SAT, c.s * 1.4 + DIG_PAD);
 }
```

(The old `1.9·s + DIG_PAD` happens to be adequate for every shipped `res`,
but only by 0.5 % — it is a landmine, not a bound. Make it derived.)

**Risk:** none to generated data. `digAt` touching more tiles only produces
carves that were already implied by the collision field. No fingerprint
change (`tools/test-worldgen.ts` unaffected: nothing in the _generation_
path moves).

---

## 2. BUG B — interpenetrating scatter chunks never compose their carves

[shareCarves()](src/world/gouda.ts#L2367) composes carves across
interpenetrating meshes, except:

```ts
// gouda.ts:2471
if (!ca.body && !cb.body) continue; // two plain ellipsoid chunks: never share
```

The rationale (AGENTS.md) is _"scatter chunks are independent bodies by
design"_ — i.e. the code assumes ellipsoid chunks do not overlap. The
recipe table contradicts that assumption:

```ts
// src/world/recipes.ts — the dark veins
placement: {
  mode: "band", rMin: 100, rMax: 226, count: 90,
  guard: 0.45,                       // ← min centre gap = 0.45·(s₁+s₂)
  sizeGrade: "inward", sightline: true, rotate: { degPerSec: 1.2 },
},
sizeBase: 10, sizeVar: 30,           // s ∈ [10, 40]
```

A `hunk` part's ellipsoid axes are `0.85 + rng()·0.35 ∈ [0.85, 1.20]`, so
its surface sits at `R0·maxAxis + crust.amp = 0.6·1.20 + 0.07 ≈ 0.79·s`.
Two chunks whose surfaces do not touch need centres at least
`0.79·(s₁+s₂)` apart. `guard: 0.45` allows **0.45**.

> Two 30 u roquefort floats are placed 27 u apart with 24 u of combined
> surface radius: **they interpenetrate by ~16 u**, and chunk A's tunnel
> network is carved into A only. B is solid right through it.

`worldDistance` = `min(A_open, B_solid)` = **solid**. B's mesh _is_ drawn
inside A's cavern, but the veins are `paste: 0x424a5e` with
`lightRange: 0.25` and `fogDensity: 3` — you cannot see the intruding
surface. Classic invisible wall.

Worse: the veins are `rotate`d, so B's solid **sweeps through** A's tunnel
over time. The wall moves.

### Fix B

Two options; **B1 is shippable, B2 is the "right" one but is blocked.**

**B1 — forbid the overlap at placement, and make it machine-checked.**

```diff
 // src/world/recipes.ts — WHEEL_BIOMES, id: "veins"
     placement: {
       mode: "band",
       rMin: 100,
       rMax: 226,
       count: 90,
-      guard: 0.45,
+      guard: 0.8,
```

and encode the invariant so a future table edit cannot silently re-break it:

```ts
// src/world/recipes.ts — validateWorld()
if (pl.mode === "band") {
  // Scatter chunks are independent bodies: shareCarves() refuses to compose
  // ellipsoid pairs, so overlapping ones become each other's invisible walls.
  const MAX_AXIS = 1.2; // makeChunkData's widest ellipsoid axis
  for (const entry of biome.parts) {
    const part = world.parts.find((p) => p.id === entry.part);
    if (!part) continue;
    const surf = 0.6 * MAX_AXIS + part.crust.amp; // R0·axis + crust
    if (pl.guard < surf)
      errors.push(
        `${biome.id}: guard ${pl.guard} < ${surf.toFixed(2)} — scatter chunks ` +
          `interpenetrate and their carves do not compose (invisible walls)`,
      );
  }
}
```

**Note:** `guard` is a _placement_ parameter — raising it **changes every
seed's world**. `tools/test-worldgen.ts` pins the wheel-world fingerprint
and **must be rebased in the same commit**, and the change must be called
out (AGENTS.md, "content tickets rebase it in the same commit and say so").
Expect the veins to thin out; re-tune `count` in `/worldgen.html` (map view,
`?world=wheel&biome=veins`) and check `verifyWorld()`'s `trail.orphans`
stays 0 before shipping.

**B2 — actually share the carves (blocked today).** Dropping the
`!ca.body && !cb.body` skip is not enough: `rotate` gives every veins chunk
its **own seeded spin axis and rate**, and carves are stored chunk-local.
A carve borrowed from a neighbour that spins differently cannot be
expressed in a static local frame. B2 therefore requires making `spin`
**per sightline-cluster** rather than per chunk, which is a design change
(and its own fingerprint rebase). Record it in `docs/idea-register.md`
rather than doing it under a bugfix.

---

## 3. BUG C — `worldDistance` is not a metric, so the player is fatter than 0.6 u

`resolveCollision(pos, 0.6)` compares an SDF value against a _length_. That
is only valid if the field is 1-Lipschitz (|∇d| = 1). It is not.

**Layer bands** — [bodySdfWorld()](src/world/sdf.ts#L242):

```ts
d = Math.max(rr - b.rMax, b.rMin - rr);
if (f) d *= Math.min(1, f.squash); // sdf.ts:261 — squash = 0.45
```

`rr` is a **frame radius**, and its world gradient is direction-dependent:

$$|\nabla rr| = 1 \ \text{(equatorial)} \ \dots \ \tfrac{1}{\text{squash}} = 2.22 \ \text{(polar)}$$

The blanket `× squash` assumes the _worst case everywhere_. On the
equatorial faces of the melt and the galleries the true gradient is 1, so
the field reports **0.45 × the real distance**:

> The player's effective collision radius against a fused-layer rim face is
> **0.6 / 0.45 = 1.33 u** — a **0.73 u invisible cushion** in front of every
> visible surface.

**Ellipsoid chunks** — [baseSdf()](src/world/sdf.ts#L310):

```ts
let d = (Math.sqrt(ex * ex + ey * ey + ez * ez) - R0) * c.minAxis;
```

Same trick, same problem: `minAxis` is the worst-case reciprocal gradient.
For a shipped `hunk` (axes in `[0.85, 1.20]`) the worst ratio is
`0.85/1.20 = 0.71`, so the effective radius is **0.85 u** (0.25 u cushion).
Milder, but it stacks with everything else.

Note the carve terms (`holes`/`tunnels`/`digs`) _are_ exact metric
distances, so the inside of a bore is fine — the cushion lives on the
**body surfaces**: layer rims, chunk exteriors, spine-door mouths, the gaps
_between_ two floats. Which is exactly "the gap looks wide enough and I
bounce off it".

Secondary casualties of the same non-metric field:
`raycastSolid`'s `d < 0.4` hit test fires at true 0.89 u;
`findOpenSpot`'s `> 1.8` demands true 4 u; `verify.ts`'s `minClearance`
under-reports the cargo bottleneck.

### Fix C — normalise in the query path, not in the field

> **Shipped** ([pushOutOfField()](../src/world/gouda.ts)). Do **not** re-scale
> `bodySdfWorld`/`baseSdf`: the field values feed marching cubes, and MC
> interpolates linearly between samples, so changing the scaling moves the mesh
> and **rebases the world fingerprint**. The correction lives at the point of
> comparison instead — the resolver already computes a central-difference
> gradient, so one divide makes the value metric. `MIN_GRAD = 0.35` clamps the
> divisor so a collapsing gradient (mid-way between two opposing walls) cannot
> invent unbounded clearance; below that floor the resolver deliberately keeps
> its cushion, which is the solid-side error. Measured by **T4**: the largest
> clearance at which a 0.6 u player was still pushed went **1.58 u → 0.87 u**
> (the residual is the first-order nature of `d/|∇d|` on strongly curved
> faces, not the systematic 2.2× rim cushion).
>
> `resolveCollision` now delegates to `pushOutOfField(field, pos, radius, out)`,
> which takes the field as an argument — so the worldgen bench's walk mode
> pushes off its preview chunks through this exact code instead of the copy it
> used to carry.

```ts
// src/world/gouda.ts
const GRAD_EPS = 0.25;
const MAX_PUSH_ITERS = 4;
const MIN_GRAD = 0.35; // below this the gradient is two walls cancelling

// worldDistance is a min of per-chunk APPROXIMATE SDFs — sign-correct but
// not 1-Lipschitz. d / |∇d| is the first-order distance to the isosurface,
// which is what a radius may be compared against.
export function pushOutOfField(
  field: DistanceField,
  pos: Vec3,
  radius: number,
  out: Vec3[] | null = null,
): boolean {
  const invEps = 1 / (2 * GRAD_EPS);
  for (let iter = 0; ; iter++) {
    const d = field(pos.x, pos.y, pos.z);
    if (!Number.isFinite(d)) return false;
    if (d >= radius) return false; // cheap reject: d never overstates the gap

    const gx = (field(pos.x + GRAD_EPS, ...) - field(pos.x - GRAD_EPS, ...)) * invEps;
    // ... gy, gz likewise
    const g = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (g < 1e-4) return true; // no usable normal: do nothing

    const dTrue = d / Math.max(g, MIN_GRAD);
    if (dTrue >= radius) return false;
    if (iter === MAX_PUSH_ITERS) return true; // out of pushes, still inside

    const inv = 1 / g;
    const nx = gx * inv, ny = gy * inv, nz = gz * inv;
    const push = radius - dTrue + 0.001;
    pos.x += nx * push;
    pos.y += ny * push;
    pos.z += nz * push;
    if (out) out.push({ x: nx, y: ny, z: nz });
  }
}
```

**Risk:** none to generated data — the field is untouched, only the
comparison changes; `tools/test-worldgen.ts`'s fingerprints are unmoved. The
player _can_ now enter places it previously could not.

**The secondary casualties above: measured, and deliberately left.**
`raycastSolid`, `findOpenSpot` and `verify.ts`'s `minClearance` still read the
raw field. Each was checked against the same 64-ray oracle T4 uses before being
left alone — the 2.2× worst case is a _body-surface_ number and none of these
three lives on a body surface:

| reader                     | worst case on paper            | measured                                                                                                      | verdict                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raycastSolid` (`d < 0.4`) | dig centre 0.89 u short        | median standoff **0.26 u**, p99 0.64 u; **0.9 %** of hands aims (2.0 % in the galleries) land too far to bite | papercut — the `step = max(0.15, 0.85·d)` march overshoots the threshold and lands close anyway                                                                                                                                        |
| `verify.ts` `minClearance` | bottleneck 2.2× under-reported | reported **0.62 u** vs measured **0.66 u** (6 %)                                                              | the shipped bottleneck is inside the melt shell's **entrance bore** — a carve term, where the field is already an exact metric distance. The verifier's real error is its own lattice step, which the `0.5` floor already covers       |
| `findOpenSpot` (`> 1.8`)   | demands a true 4 u             | n/a                                                                                                           | working as tuned: normalising it would let catfish and respawns land in spots ~2× tighter than the ones the game was balanced around. That is a gameplay change, not a bugfix — retune the `1.8` in the same commit if it is ever done |

The one thing worth fixing in that list is not a metric problem at all: when a
dig lands short, `digAt` returns `changed: false, rejected: false` and
[main.ts](../src/main.ts) returns **silently** — no message. 2 % of galleries
hand-digs give the player no feedback whatsoever. Filed in
[idea-register.md](idea-register.md), not here.

## 4. BUG D — the collision resolver itself

Same function, three more defects:

1. **Two iterations only.** In a passage narrower than `2·radius + slack`,
   iteration 1 pushes off wall A, iteration 2 pushes back into wall A off
   wall B, and the loop exits with the player still embedded. → 4 iterations.
2. **`(0,1,0)` fallback normal.** When the gradient degenerates
   (`len < 1e-5` — exactly what happens between two opposing walls) the old
   code invented an **upward** normal and shoved the player by
   `radius - d` straight into the ceiling. A degenerate gradient means "no
   information", not "up".
3. **Only the last normal was returned**, so [main.ts](../src/main.ts)
   could only cancel velocity into one wall. In a squeeze the second wall's
   normal is discarded, the player keeps drifting into it, and the next frame
   repeats — reading as a hard stop with no slide.

### Fix D

> **Shipped** with Fix C. (1) and (2) are in `pushOutOfField` above:
> `MAX_PUSH_ITERS = 4`, and the degenerate-gradient branch now returns instead
> of inventing a normal. (3) is `resolveCollisionAll(pos, radius, out)`, which
> appends **every** wall it pushed off; `resolveCollision` survives as the
> single-normal convenience for the movers that only ever slide along one
> (catfish, the dropped cargo, the dropped driller).
>
> The optional hardening shipped too, with a guard the sketch did not have:
> when the resolver returns "still embedded", main.ts rewinds to the substep's
> entry position **only if that position was demonstrably open water**. Without
> the guard, a player who starts a frame inside solid — a rotating veins chunk
> sweeping over them (§2), a chunk meshed late (§5) — would be pinned there
> forever instead of being pushed out.

```diff
 // main.ts — the substep
+    _entry.x = pos.x; _entry.y = pos.y; _entry.z = pos.z;
     pos.x += vel.x * stepDelta; /* … */
-    const hit = resolveCollision(pos, PLAYER_RADIUS);
+    _normals.length = 0;
+    const stuck = resolveCollisionAll(pos, PLAYER_RADIUS, _normals);
     const bellHit = collideBathyscaphe(pos, PLAYER_RADIUS);
-    for (const n of [hit, bellHit]) {
-      if (!n) continue;
+    if (bellHit) _normals.push(bellHit);
+    for (const n of _normals) {
       const into = vel.x * n.x + vel.y * n.y + vel.z * n.z;
       if (into < 0) { /* cancel into the wall */ }
     }
+    if (stuck && worldDistance(_entry.x, _entry.y, _entry.z) >= PLAYER_RADIUS) {
+      pos.x = _entry.x; pos.y = _entry.y; pos.z = _entry.z;
+    }
```

## 5. BUG E — a streamed chunk that fails to mesh is a permanent invisible solid

[streamChunk()](src/world/gouda.ts#L826), WG-22. The game builds with
`stream: true`: chunks beyond `MESH_AHEAD = 120` of spawn are pushed to
`unmeshed` and meshed later by distance. Collision does **not** wait for the
mesh — `chunkSdf` is the collider, so an unmeshed chunk is _solid and
invisible by design_.

[pumpStreaming()](src/world/gouda.ts#L853) removes the chunk from the queue
**before** dispatch:

```ts
unmeshed.shift();
streamChunk(c);
```

and `streamChunk` never puts it back:

```ts
.catch((err) => console.warn("gouda: streamed meshing failed", err))
```

Any worker error — a transient OOM under the res-72/96 poly budgets, a
`postMessage` clone failure, a worker respawn — permanently loses that
chunk. It stays solid, forever, with no geometry. Same for the
`worldGroup !== group` early-return in `.then` if a rebuild lands mid-flight.

### Fix E

> **Shipped** ([streamChunk()](../src/world/gouda.ts), `pumpStreaming()`): the
> `.catch` now requeues instead of dropping, bounded at `STREAM_RETRIES = 2`
> and then falling back to the synchronous main-thread `meshChunk` — a
> poisoned chunk can neither vanish nor loop the pump. The rebuild case
> (`worldGroup !== group`) deliberately does _not_ requeue: `disposeWorld`
> already cleared `chunks`, so nothing is left to be solid and a requeue would
> resurrect a dead chunk. The watchdog moved **above** the
> `streamBusy >= maxBusy` bail-out (a starved pump is precisely how a near
> chunk lingers) and warns once per chunk, so it cannot spam at 4 Hz.

Sketch as audited:

```diff
-    .catch((err) => console.warn("gouda: streamed meshing failed", err))
+    .catch((err) => {
+      // An unmeshed chunk is an invisible solid — never drop one.
+      console.warn("gouda: streamed meshing failed, requeueing", err);
+      if (worldGroup === group && !c.mesh) unmeshed.push(c);
+    })
```

Add a watchdog so the failure is loud instead of silent:

```ts
// pumpStreaming(), after the sort
if (unmeshed.length && unmeshed[0].center.distanceTo(cameraPos) < 40)
  console.warn("gouda: unmeshed chunk inside 40 u — invisible collider");
```

Consider also a bounded retry (2 attempts, then fall back to the synchronous
`meshChunk` on the main thread) so a poisoned chunk cannot loop forever.

---

## 6. Residual — marching-cubes reconstruction error (not a bug, a floor)

The mesh is the isosurface of the **linearly interpolated** field on a grid
of spacing `cellW = 2s/res`; collision is the **analytic** SDF. For a
surface of curvature radius ρ the two differ by ≈ `cellW² / (8ρ)`, and the
sign of the error depends on curvature:

- **Concave** (a tunnel bore): the field is convex along a grid edge, the
  interpolant over-estimates it, the mesh wall lands **closer to the axis**
  than truth → rendered bore is _narrower_ than the collider. Safe direction.
- **Convex** (rims, spurs, the smooth-cut fillets at tunnel junctions, where
  ρ ≈ `SMOOTH_K·s`): the mesh is **thinner** than the real solid → a
  sub-cell invisible skin.

Worst shipped case: the Great Wheel, `cellW = 1.92`, fillet ρ ≈ 2.3 →
**≈ 0.20 u**. Real, but an order of magnitude below bugs A–D. Do not chase
it until A–E are fixed; if it ever matters, the answer is a shrink term
(`isolation = -0.5·cellW` equivalent) on the _collision_ side, never a
change to the mesh.

---

## 7. Instrumentation — prove it, don't guess

The decisive tool is "which chunk is blocking me, and does it have a mesh
here?". Add an argmin-reporting query beside `worldDistance`:

```ts
// src/world/gouda.ts

export interface BlockerInfo {
  d: number; // the value that blocked
  index: number; // chunk index (the dig wire id)
  zone: ZoneName | null;
  tile: boolean; // layer-body tile vs scatter chunk
  meshed: boolean; // false ⇒ invisible collider (BUG E)
  inMarchedBox: boolean; // false ⇒ solid where this chunk has no triangles
  digReaches: boolean; // false ⇒ BUG A: you cannot dig what blocks you
  center: Vec3;
  s: number;
}

// Debug-only: same traversal as worldDistance, but names the argmin.
export function worldBlocker(
  x: number,
  y: number,
  z: number,
  digR = 2.4,
): BlockerInfo | null {
  const bucket = gridBucketAt(x, y, z);
  if (!bucket) return null;
  let best = GRID_SAT,
    hit = -1;
  for (const i of bucket) {
    const d = chunkContribution(chunks[i], x, y, z, best);
    if (d < best) {
      best = d;
      hit = i;
    }
  }
  if (hit < 0) return null;
  const c = chunks[hit];
  const cellW = (2 * c.s) / c.res;
  const inBox =
    Math.abs(x - c.center.x) <= c.s - cellW &&
    Math.abs(y - c.center.y) <= c.s - cellW &&
    Math.abs(z - c.center.z) <= c.s - cellW;
  return {
    d: best,
    index: hit,
    zone: c.zone ?? null,
    tile: !!c.body,
    meshed: !!c.mesh,
    inMarchedBox: inBox,
    digReaches: chunkCovers(c, x, y, z, digR),
    center: { x: c.center.x, y: c.center.y, z: c.center.z },
    s: c.s,
  };
}
```

Wire it to a debug key in [main.ts](src/main.ts) next to the existing
`game.debug` block:

```ts
// [B]lame: what is holding me?
const b = worldBlocker(pos.x, pos.y, pos.z);
if (b)
  console.log(
    `blocked by #${b.index} ${b.zone} ${b.tile ? "tile" : "chunk"} ` +
      `d=${b.d.toFixed(2)} meshed=${b.meshed} inMarchedBox=${b.inMarchedBox} ` +
      `digReaches=${b.digReaches}`,
  );
```

**Reading the output:**

| output                                                                          | bug                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `meshed=false`                                                                  | **E** — streamed chunk lost or not yet meshed           |
| `inMarchedBox=false`                                                            | **A** — solid in a tile's pad shell, no triangles there |
| `digReaches=false`                                                              | **A** — confirmed: you cannot dig what blocks you       |
| `tile=false`, zone `veins`, and the mesh you see belongs to a _different_ index | **B** — interpenetrating floats                         |
| all true, `d` ≈ 0.45 × the eyeballed gap                                        | **C** — non-metric field                                |

The bench reproduces all of this: `/worldgen.html`, **walk mode (F)** uses
the same predicates ([worldgen.ts:321](src/bench/worldgen.ts#L321) calls
`tileFieldCovers` + `chunkDistance`), so bugs A and C are reproducible
there without launching a session, with the clip plane to see the geometry.

---

## 8. Regression tests

All node-runnable (`node 24` strips types), all in `tools/`, all wired into
`npm test`. Build at half res to keep CI under a minute.

> **Shipped with Fix A: `tools/test-collision.ts`** (T1 + T2, ~12 s: a real
> `buildGoudaWorld` in node at res 32, so `digAt`/`worldDistance`/the spatial
> hash are exercised, not re-implemented). Coverage edges are found by
> _bisecting_ `chunkCovers` itself, so the test never restates the box maths.
> T1 as written below is a tautology once both callers read one predicate, so
> it ships as the invariant that _can_ still break: the grid bucket at a point
> must contain every chunk that covers it (`worldDistance ≤ chunkDistance(c)`
> — a bucket that misses a chunk opens the world and un-diggables it). T2 is
> verbatim, sampled in the old sphere's blind shell: 46/46 of those digs left
> an invisible wall before the fix, 0/46 after; a `1.9·s → 0.9·s` `gridReach`
> shrink trips T1. **T4 shipped with Fix C + D** (see below). T3 and T5 are
> still open — both belong with Fix B.

**T1 — predicate parity (catches A forever).** For the shipped seed, for
every layer-body chunk, sample its 8 coverage-box corners plus 64 random
points inside `tileFieldCovers`; assert `chunkCovers(c, p, 0)` implies the
dig predicate accepts at `r = 0`. After Fix A this is true by construction —
it is the guard against re-divergence.

**T2 — dig, then swim (the end-to-end assertion).** Build in node, take N
points along the verifier's solved `path`, call
`digAt(p, DIG_RADII.driller, "driller")`, then assert
`worldDistance(p) >= DIG_RADII.driller - 0.05`.
**This fails today** on any point in a tile's blind corner and passes after
Fix A. It is the single most valuable test in this list.

**T3 — placement invariant (catches B).** Extend `tools/test-recipes.ts` to
assert `validateWorld(WHEEL_WORLD)` is empty with the new scatter-overlap
rule from Fix B, and that a deliberately-overlapping fixture is rejected.

**T4 — metric sanity (catches C).** _Shipped, and re-aimed._ Bisecting along
the gradient (as originally sketched) is not a usable oracle: at a `min` seam
the steepest-descent direction does not point at the nearest surface, and it
reads a 0.41 u clearance as 4.04 u. The shipped test measures truth by
**sphere-tracing 64 Fibonacci-sphere rays** out of the probe and taking the
minimum hit — sound because the field _under_-estimates, so every step of `d`
is a step no longer than the true clearance, and tight to ~3 % at 12.5°
angular spacing.

The statistic is the **effective collision radius**: over 4.7 k probes within
3 u of a surface, the largest measured clearance at which `resolveCollision`
still pushes a 0.6 u player. **1.58 u before Fix C, 0.87 u after**, gate at
`0.6 × 1.6`. Probes where `|∇d| < MIN_GRAD` are counted and skipped, not
asserted on — there the resolver's cushion is the deliberate solid-side
clamp, not the bug.

**T5 — mesh ⊆ open (catches B and any future phantom).** For the shipped
seed at half res, for every extracted vertex `v` of every chunk, assert
`worldDistance(v) > -tol` with `tol = 0.25·cellW`. A vertex sitting deep
inside another chunk's solid is, by definition, a rendered surface the
collider disagrees with.

---

## 9. Fix order

1. **A** — `chunkCovers` unification (`gouda.ts`). Zero data risk, biggest win,
   directly kills "carved it, can't enter". Ship with **T1 + T2**.
2. **E** — requeue on stream failure (`gouda.ts`). One-line, zero risk.
3. **C + D** — ✅ **done**: metric normalisation and the resolver rewrite
   (`gouda.ts`, `main.ts`, and the bench walk mode now shares the resolver
   rather than copying it). No generated data changed — `test-worldgen.ts`'s
   fingerprints are untouched. Shipped with **T4**. Still worth re-walking the
   galleries squeezes in the bench by hand: they get _easier_.
4. **B** — `veins.guard` 0.45 → 0.80 plus the `validateWorld` rule
   (`recipes.ts`). **Changes every seed.** Rebase
   `tools/test-worldgen.ts`'s fingerprint in the same commit and say so in
   the message. Re-check `verifyWorld().trail.orphans === 0` and re-tune
   `count` in the bench. Ship with **T3 + T5**.
5. **§6** — leave alone.

Gates as always: `npm run typecheck && npm test && npm run lint`.

---

## Appendix — constants involved

| constant                                   | value                   | where                                                |
| ------------------------------------------ | ----------------------- | ---------------------------------------------------- |
| `PLAYER_RADIUS`                            | 0.6                     | [main.ts:138](src/main.ts#L138)                      |
| `DIG_RADII`                                | hands 0.7, driller 2.4  | [main.ts:142](src/main.ts#L142)                      |
| `DIG_RANGE`                                | 7                       | [main.ts:143](src/main.ts#L143)                      |
| `SMOOTH_K`                                 | 0.05 (local)            | [sdf.ts](src/world/sdf.ts)                           |
| `R0`                                       | 0.6 (local)             | [sdf.ts](src/world/sdf.ts)                           |
| `GRID_CELL` / `GRID_SAT` / `DIG_PAD`       | 24 / 8 / 3              | [gouda.ts:3105](src/world/gouda.ts#L3105)            |
| `GRAD_EPS` / `MAX_PUSH_ITERS` / `MIN_GRAD` | 0.25 / 4 / 0.35         | [gouda.ts](../src/world/gouda.ts) `pushOutOfField`   |
| `MESH_AHEAD`                               | 120                     | [gouda.ts:817](src/world/gouda.ts#L817)              |
| tile marched extent                        | `±(s − 2s/res)`         | three `MarchingCubes`, x ∈ [1, res−2]                |
| tile spacing                               | `2s(res−3)/res`         | [gouda.ts:1652](src/world/gouda.ts#L1652)            |
| carve-distribution pad                     | `SMOOTH_K·s + 2·cellW`  | `buildLayerChunks`, `shareCarves`, `tileFieldCovers` |
| frame                                      | `squash 0.45, tilt 16°` | [recipes.ts](src/world/recipes.ts) `WHEEL_WORLD`     |
