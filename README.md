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

1. Player 1 clicks **Host Game** and shares the generated ID.
2. Player 2 clicks **Join Game** and enters that ID.
3. Move with **WASD**. Positions sync directly peer-to-peer.

## Deployment

Pushes to `main` trigger `.github/workflows/deploy.yml`, which runs `npm run build` and publishes `dist/` to GitHub Pages. In the repo settings, set **Pages → Source → GitHub Actions**.

To build locally: `npm run build` (output in `dist/`).
