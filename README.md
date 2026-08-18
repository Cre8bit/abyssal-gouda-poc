# Abyssal — Underwater Multiplayer Prototype

Minimal 3D underwater multiplayer prototype. 100% static frontend, hosted on GitHub Pages.

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
3. Swim with **ZQSD/WASD** (layout-agnostic), look with the mouse, **Space/Shift** to rise/sink, **F** flashlight, **T** scatter, **V** mute voice.

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
