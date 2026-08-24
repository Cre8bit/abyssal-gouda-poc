# Abyssal — Underwater Multiplayer Prototype

Minimal 3D underwater multiplayer prototype. 100% static frontend, hosted on GitHub Pages.

## The Bell Descent

No seafloor — pure open water. Everyone starts hooked onto the **diving bell**.
Once every diver is attached, the bell falls **100 m**, stops dead, and shakes
the crew off at random bearings around it. Swim back, press **E** to hook on
again, and the bell drops another level. The water clouds over as you go: clear
at the surface, murky at level 1, black from level 2 down. Depth is continuous —
nothing loads or unloads between levels.

The host owns the bell: it decides when everyone is aboard and broadcasts each
drop (`src/bell.js` holds the state machine, `src/main.js` drives it). Ejection
positions are drawn independently on each client, so no positions cross the wire
beyond the normal 30 Hz state stream.

## The Lanternmaw

From two levels down there is a second light in the water. It flashes on the
same five-second beat as the bell's alarm, it pings on roughly the same
frequency, and the bell radar in the corner of your HUD will light its
quadrant for you in the same amber — because that instrument has never known
what the bell *is*, only what pings like one. Swim to the wrong light and the
lure reels back toward the teeth, a 46-metre face lights itself up out of the
black, and the maw takes everyone still in front of it.

- Being swallowed is not death: you are out of the dive until the bell settles
  again, and the crew hauls you back with them. Survivors still count as a full
  crew, so one bad encounter can't deadlock the descent.
- **Everyone** swallowed is a wipe, and the dive resets to the surface.
- The hull is real safety — it will not take a diver hooked onto the bell.
- The host owns the hunt and streams the pose (`src/angler.js`); no client ever
  decides on its own whether it was eaten.

The model ships rigged but with **zero animation clips** — the swim, the
tentacle wave, the lure bob, the gape and the lunge are all written per-frame
onto the skeleton. `npm run angler` runs those rig checks headlessly.

## Stack

- **Vite** — bundling & dev server
- **Three.js** — 3D rendering (fog, bubbles, player spheres)
- **PeerJS** — WebRTC P2P data channels (free public signaling server)

## Development

```bash
npm install
npm run dev
```

## How to play

1. Player 1 clicks **Host Game**, then **Copy invite link** (or shares the ID).
2. Player 2 opens the invite link (auto-joins), or clicks **Join Game** and enters the ID.
3. Swim with **ZQSD/WASD** (layout-agnostic), look with the mouse, **Space/Shift** to rise/sink, **F** flashlight, **E** hook on / release the bell, **R** restart the dive, **V** mute voice.

## Testing locally (two windows)

```bash
npm run dev
```

1. Open http://localhost:5173 in one window → **Host Game** → **Copy invite link**.
2. Open the copied link in a second window (or another device on your LAN —
   the dev server listens on your local IP too). It joins automatically.

Notes:

- `npm run dev` also starts a **local PeerJS signaling server** (port 9001) —
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
