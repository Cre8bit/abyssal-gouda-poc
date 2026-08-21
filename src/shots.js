// shots.js — dev-only screenshot mode. `?shot=<name>` skips the menu, pins the
// camera to a named vantage point and freezes the sim, so two runs of the same
// shot are directly comparable.
import { LEVEL_DROP } from "./bell.js";
import { forestFor, FOREST_RADIUS } from "./kelp.js";

// Offsets are relative to the bell, which always sits at x=0, z=0 at its
// level's depth — so one entry works at any level.
const VIEWS = {
  "bell-close": { level: 1, off: [0, 3, 14], yaw: 0, pitch: -0.06 },
  "bell-far": { level: 1, off: [0, 8, 58], yaw: 0, pitch: -0.1 },
  "bell-alarm": { level: 1, off: [0, 3, 16], yaw: 0, pitch: -0.06, flash: true },
  "bell-dark": { level: 3, off: [0, 4, 20], yaw: 0, pitch: -0.06 },
  "torch-off": { level: 1, off: [0, 3, 14], yaw: 0, pitch: -0.06, torch: false },
  "open-1": { level: 1, off: [70, 0, 0], yaw: -1.75, pitch: 0 },
  "open-2": { level: 2, off: [70, 0, 0], yaw: -1.75, pitch: 0 },
  "open-3": { level: 3, off: [70, 0, 0], yaw: -1.75, pitch: 0 },
  "kelp-inside": { level: 1, find: "kelp", yaw: 0.9, pitch: 0 },
  "kelp-up": { level: 1, find: "kelp", yaw: 0.9, pitch: 0.8 },
  "kelp-edge": { level: 1, find: "kelp-edge", yaw: 0, pitch: 0 },
  "kelp-rim": { level: 1, find: "kelp-rim", yaw: 0, pitch: 0 },
  // Ambience: each of these isolates one of the new systems.
  "levi-2": { level: 2, off: [40, 8, 40], yaw: 2.4, pitch: 0, leviathan: true },
  "levi-3": { level: 3, off: [40, 8, 40], yaw: 2.4, pitch: 0, leviathan: true },
  "wake-2": { level: 2, off: [40, 8, 40], yaw: 2.4, pitch: -0.5, wake: true },
  "jelly-1": { level: 1, off: [50, 4, 50], yaw: 2.4, pitch: 0.1 },
  "jelly-2": { level: 2, off: [50, 4, 50], yaw: 2.4, pitch: 0.1 },
  "kelp-deep": { level: 3, find: "kelp", yaw: 0.9, pitch: 0 },
  // Atmosphere angles: looking away from everything is the real test.
  "void-1": { level: 1, off: [40, 10, 40], yaw: 2.4, pitch: 0.15 },
  "void-2": { level: 2, off: [40, 10, 40], yaw: 2.4, pitch: 0.15 },
  "void-3": { level: 3, off: [40, 10, 40], yaw: 2.4, pitch: 0.15 },
  "down-2": { level: 2, off: [30, 6, 30], yaw: 2.4, pitch: -1.2 },
  "up-2": { level: 2, off: [30, -12, 30], yaw: 2.4, pitch: 1.1 },
  "bell-below": { level: 1, off: [0, -18, 22], yaw: 0, pitch: 0.5 },
  "bell-side": { level: 2, off: [24, 2, 6], yaw: -1.35, pitch: -0.05 },
  "flare-2": { level: 2, off: [30, 4, 30], yaw: 2.4, pitch: 0, flare: true },
  "flare-3": { level: 3, off: [30, 4, 30], yaw: 2.4, pitch: 0, flare: true },
};

export const SHOT_NAMES = Object.keys(VIEWS);

// Standing in the middle of the forest, at the height of its densest band.
function insideForest(level) {
  const f = forestFor(level);
  return { x: f.x + 6, y: f.y + 2, z: f.z + 4 };
}

// Outside looking in, far enough back to read the whole mass as a silhouette.
function atForestEdge(level) {
  const f = forestFor(level);
  return { x: f.x, y: f.y + 4, z: f.z + FOREST_RADIUS + 45 };
}

// Standing in the thin outskirts, where the gradient should be obvious.
function atForestRim(level) {
  const f = forestFor(level);
  return { x: f.x, y: f.y + 2, z: f.z + FOREST_RADIUS * 0.72 };
}

// The requested view, or null during normal play.
export function getShot() {
  const name = new URLSearchParams(location.search).get("shot");
  if (!name) return null;

  const view = VIEWS[name];
  if (!view) {
    showError(`unknown shot "${name}"\nknown: ${SHOT_NAMES.join(", ")}`);
    return null;
  }

  let base = null;
  if (view.find === "kelp") base = insideForest(view.level);
  else if (view.find === "kelp-edge") base = atForestEdge(view.level);
  else if (view.find === "kelp-rim") base = atForestRim(view.level);
  const spot = base ?? {
    x: view.off[0],
    y: -view.level * LEVEL_DROP + view.off[1],
    z: view.off[2],
  };

  return {
    name,
    level: view.level,
    x: spot.x,
    y: spot.y,
    z: spot.z,
    yaw: view.yaw ?? 0,
    pitch: view.pitch ?? 0,
    torch: view.torch !== false,
    flash: view.flash === true,
    flare: view.flare === true,
    leviathan: view.leviathan === true,
    wake: view.wake === true,
  };
}

// Errors have to be visible IN the picture — a headless run has nowhere else to
// put them, and a silently black frame is exactly what wasted time before.
let errorBox = null;
export function captureErrors() {
  const report = (text) => showError(text);
  window.addEventListener("error", (e) =>
    report(`${e.message}\n${e.filename ?? ""}:${e.lineno ?? ""}`),
  );
  window.addEventListener("unhandledrejection", (e) =>
    report(`unhandled rejection: ${e.reason?.message ?? e.reason}`),
  );
  // Three.js reports shader compile failures through console.error, which no
  // window handler ever sees.
  const original = console.error;
  console.error = (...args) => {
    original(...args);
    report(args.map((a) => (a?.message ?? String(a))).join(" ").slice(0, 1200));
  };
}

function showError(text) {
  if (!errorBox) {
    errorBox = document.createElement("pre");
    errorBox.style.cssText =
      "position:fixed;inset:0;z-index:99;margin:0;padding:18px;overflow:hidden;" +
      "background:rgba(40,0,0,0.86);color:#ff8a7a;font:13px/1.45 monospace;" +
      "white-space:pre-wrap;";
    document.body.appendChild(errorBox);
  }
  errorBox.textContent += `${text}\n\n`;
}
