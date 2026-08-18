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

Notes: both windows will ask for mic access (proximity voice). Signaling goes
through the public PeerJS cloud even locally, so an internet connection is
required. Clipboard may be blocked on non-HTTPS LAN URLs — the invite URL is
shown for manual copying in that case.

## Deployment

Pushes to `main` trigger `.github/workflows/deploy.yml`, which runs `npm run build` and publishes `dist/` to GitHub Pages. In the repo settings, set **Pages → Source → GitHub Actions**.

To build locally: `npm run build` (output in `dist/`).
