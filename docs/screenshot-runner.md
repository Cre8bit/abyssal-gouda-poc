# Screenshot runner (headless playtesting)

A file-driven harness that lets an agent (or you) see the game, move the
player, and capture frames — no ports, no installs.

## Pieces

- `tools/runner.mjs` (`npm run runner`) — polls `shots/request.json`, keeps
  one warm headless Chrome (software WebGL) across runs and drives it over the
  DevTools protocol: each shot is a fresh tab, captured a few tabs at a time
  (`SHOT_CONCURRENCY`, default 3), so there is no per-shot browser cold start.
  Writes `shots/<name>.png` + `shots/status.json` (status is written last, so
  `state: "done"` means every PNG is finished). Interesting page console /
  error lines are surfaced in `status.json.logs`. The browser is released
  after `SHOT_IDLE_MS` (default 2 min) idle and relaunched on demand.
- `src/shots.js` — in-game shot mode, active only with `?shot=<name>`.
  Skips the menu, pins the player at a vantage point, aims the camera, holds
  movement keys, and (optionally) adds a flat inspection light. Signals
  `window.__shotReady` once the world is built and `settle` frames (default
  30) have rendered — that's what the runner waits for before capturing.

## Usage

```sh
npm run dev      # terminal 1
npm run runner   # terminal 2
```

Then write a request:

```json
{ "shots": ["fp-down-60", { "name": "fp-forward", "params": { "pitch": -1.2, "keys": "KeyW" } }] }
```

Entries are shot names or `{ name, params }`; params become URL overrides and
are baked into the output filename. Named shots live in `src/shots.js`
(`fp-forward`, `fp-down-30/60/max`, `fp-up`, `fp-swim`, `fp-swim-down`,
`fp-swim-sprint`, `world`).

## Useful params

- `pitch`, `yaw` (radians), `x`/`y`/`z` (world position), `keys`
  (comma-separated `e.code` values held for the whole capture)
- `light=N` — flat hemisphere light for geometry inspection
- `settle=N` — frames to render after the pose lands before the capture is
  taken (default 30; raise it to catch animation further into its cycle)
- `uy ux fy fx hx` / `ox oy oz` / `pb pf` — live overrides of the first-person
  hand pose, body offset, and screen-anchor pitch base/follow
  (`configureFpBody` in `src/diverRig.js`), for sweeping candidate poses
  before baking them in
- Env for the runner: `SHOT_URL`, `SHOT_SIZE`, `SHOT_BUDGET` (max ms to wait
  per shot for the ready signal, default 30000), `SHOT_SEED` (default 7 →
  identical world every run), `SHOT_CONCURRENCY` (parallel tabs, default 3),
  `SHOT_IDLE_MS` (idle ms before the warm browser is released, default
  120000), `CHROME_PATH`
