# Abyssal — Underwater Multiplayer Prototype

Minimal 3D underwater multiplayer prototype. 100% static frontend, hosted on GitHub Pages.

## The Gouda Labyrinth (Phase 1)

An onion/ball map (R≈330) of nine concentric biomes, outside → in: **the
drift** (sparse pale blocks; from spawn the water is nearly clear and the
whole glowing system floats in view), **the reef** (fields of thin plates
with big through-holes), **the scree** (dense belt of small cut blocks),
**the warrens** (speleology: long tangled narrow tunnels), **the crust**
(sealed wall #1 — many giant fused hunks with radial through-routes), **the
galleries** (cathedral wheels, huge chambers), **the bulwark** (sealed wall
#2), **the hollows** (cramped wheels), and **the heart** (a grand cavern,
and a decoy). Fog thickens layer by layer; each biome has its own
bioluminescent vein colour. A run to the Gouda targets 10–20 minutes.

**The world is destructible**: press **E** to dig (**E** is contextual — it
lifts or hands over the Golden Gouda when that is in reach, and swings the
pickaxe otherwise). Each chunk keeps its
voxel field cached — a dig edits the carved voxels and re-runs marching
cubes on that single chunk (~20 ms), collision follows exactly, and dig
events sync to teammates over the P2P channel. Thin marked blast walls in
dead-end chambers can be dug through today and blasted in the future.

Interiors are mazes: winding tunnels, chamber rooms, loops for multiple
routes, and dead-end chambers sealed by deliberately thin walls, marked with
a pulsing crack-glow (`getBlastPoints()`) for the future explosives/digging
feature. Maps are seeded per game — the host's seed rides the invite link and
the P2P handshake (joiners rebuild automatically), and `?seed=N&d=1..3` in
the URL reproduces any map at any difficulty (narrower tunnels, thicker
bulwark, more dead ends). The compass **never** carries a gold marker: the
Gouda is fully hidden, and you find it by its glow leaking out of tunnel
mouths.

**The haul.** The Golden Gouda is a real object, not scenery — a wheel
seeded in a random mid-depth cavern that you pick up, carry in your arms,
and have to get home. Carrying it slows you down, drags you toward the
abyss, stows your pickaxe, and forces your own torch off: the wheel becomes
the party's light and the party's beacon. Sprinting with it, or taking a
catfish hit, can knock it out of your grip — you get about three seconds to
catch it before it tumbles away down a shaft. Press **E** next to a
teammate to hand it over. Get it inside the bell's hatch and the run is
won.

The world is a procedural 3D labyrinth of massive gouda chunks (`src/gouda.js`).
Each chunk is an analytic SDF — a noise-crusted ellipsoid minus a connected graph
of hole-spheres and tunnel-capsules — meshed once at load with marching cubes.
Interior cavities are always linked by tunnels and punched out to the surface, so
every chunk can be entered and explored. The same SDF drives swim collision
(gradient push-out with wall sliding). Generation is seeded, so all peers build
the identical maze with zero network traffic. The material carries a pulsing
bioluminescent vein pattern and fake-SSS rim glow — in the pitch-black murk you
navigate by the glow and your flashlight alone.

## Stack

- **Vite** — bundling & dev server
- **Three.js** — 3D rendering (fog, bubbles, player spheres)
- **PeerJS** — WebRTC P2P data channels (free public signaling server)

## Development

```bash
npm install
npm run dev
```

### Model & animation bench

`npm run dev`, then open **http://localhost:5173/preview.html** — an
inspection bench for every model in the game (rat diver, first-person gloves,
lantern-catfish). It runs the real animation code (procedural rig, baked
clips, lantern moods) with the ability to stop and stare: solo one clip,
freeze a pose on sliders, slow playback to 0.1×, toggle bones/wireframe, and
orbit freely. **Rule: every new model added to the game must be registered in
`src/preview.js` (`MODELS`) in the same PR — see `AGENTS.md`.**

## Multiplayer (Phase 0)

Up to N players over a **full P2P mesh**: the host is only the introducer —
when a newcomer joins, the host sends it the list of connected peers and the
newcomer dials each of them (data + proximity voice), so everyone sees and
hears everyone. Per pair there are two channels on one RTCPeerConnection:
a **reliable ordered** PeerJS channel for gameplay events (dig, tp, seed —
must all arrive), and a **raw unreliable, unordered** negotiated RTCDataChannel
for 30 Hz pose packets (24-byte binary, sequence-numbered so stale packets
are dropped; a lost pose is replaced 33 ms later instead of retransmitted —
no head-of-line blocking, no lag spikes on loss). Per-peer ping/pong measures
RTT (worst shown in the HUD). Run `npm test` for the codec unit tests.

Players carry a 7-bit **status mask** in each state packet (carrying,
gassed, poisoned, trapped, speaking — `src/effects.js`), re-broadcast
immediately on change. Effects apply locally; peers only render the flags.

**Oxygen** (`src/oxygen.js`): a full tank lasts ~10 min of calm swimming;
sprinting and distress statuses burn it faster. It refills near the spawn
point (the future bathyscaphe berth). Hitting zero = blackout, then respawn
at the spawn with a full tank. If the fish-simulating peer disconnects, the
remaining peers deterministically elect a replacement (lowest peer id).

## How to play

1. Player 1 clicks **Host Game**, then **Copy invite link** (or shares the ID).
2. Players 2-N open the invite link (auto-join), or click **Join Game** and enter the ID.
3. Swim with **ZQSD/WASD** (layout-agnostic), look with the mouse, **Space/C** to rise/sink, **Shift** sprint (burns O₂), **E** dig / lift the Gouda / hand it off, **F** flashlight, **T** scatter, **V** mute voice. Watch the O₂ bar — refill at the spawn. Find the Golden Gouda and haul it back to the bell.

## Testing locally (two windows)

```bash
npm run dev
```

1. Open http://localhost:5173 in one window → **Host Game** → **Copy invite link**.
2. Open the copied link in a second window (or another device on your LAN —
   the dev server listens on your local IP too). It joins automatically.

Notes:

- `npm run dev` also starts a **local PeerJS signaling server** (port 9004) —
  local games don't depend on the public PeerJS cloud at all. If the local
  server can't start (e.g. `peer` not installed yet), the app falls back to
  the public cloud automatically.
- Both windows will ask for mic access (proximity voice) — press V in one
  window to avoid feedback.
- Clipboard may be blocked on non-HTTPS LAN URLs — the invite URL is then
  shown for manual copying.
- Joining now times out after 12s with a clear error instead of hanging on
  "Connecting…".

## Deployment

Pushes to `main` trigger `.github/workflows/deploy.yml`, which runs `npm run build` and publishes `dist/` to GitHub Pages. In the repo settings, set **Pages → Source → GitHub Actions**.

To build locally: `npm run build` (output in `dist/`).
