// shots.js — headless screenshot harness, active ONLY with ?shot=<name>.
// The runner (tools/runner.mjs) loads the page with a shot param; this module
// then skips the menu, pins the player to a named vantage point, aims the
// camera, and (optionally) holds movement keys so swim animation runs.
//
// Every field of a named shot can be overridden straight from the URL, so the
// runner can request arbitrary poses without a code change:
//   ?shot=fp-down&pitch=-1.2&yaw=0.4&x=0&y=8&z=430&keys=KeyW,ShiftLeft
// A normal player session (no ?shot=) never enters any code path here.
import { setLook } from "../input/input.ts";
import { configureFpBody } from "../entities/diverRig.ts";
import { addShotLight } from "../render/graphics.ts";
import { setBellCount } from "../world/bathyscaphe.ts";

// The runner polls this flag (tools/runner.ts) to know the capture is ready.
declare global {
  interface Window {
    __shotReady?: boolean;
  }
}

// A named preset: every field optional, URL params fill/override the rest.
interface ShotPreset {
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
  keys?: string[];
}

// The fully resolved config applyShot() consumes (built by getShotConfig()).
export interface ShotConfig {
  name: string;
  x: number | undefined;
  y: number | undefined;
  z: number | undefined;
  yaw: number;
  pitch: number;
  keys: string[];
  light: number;
  bells: number;
  settle: number;
}

// pitch/yaw in radians. keys = e.code values held for the whole capture.
// Positions omitted = stay at the world spawn (open water, labyrinth in view).
const SHOTS: Record<string, ShotPreset> = {
  // First-person body: the whole reason this harness exists — checking the
  // gloves at every look angle, idle and swimming.
  "fp-forward": { pitch: 0 },
  "fp-down-30": { pitch: -0.6 },
  "fp-down-60": { pitch: -1.1 },
  "fp-down-max": { pitch: -1.47 },
  "fp-up": { pitch: 0.9 },
  "fp-swim": { pitch: -0.15, keys: ["KeyW"] },
  "fp-swim-down": { pitch: -0.9, keys: ["KeyW", "KeyC"] },
  "fp-swim-sprint": { pitch: -0.35, keys: ["KeyW", "ShiftLeft"] },
  // Establishing shot: the glowing gouda system from the drift.
  world: { pitch: 0.05 },
  // The tin bell berthed at the spawn (default spawn ≈ (0, 18, 434); the
  // spawn sits at hatch eye height INSIDE it — see bathyscaphe.js), seen
  // from the gouda side so the hatch doorway + entry beacon are in frame.
  // &bells=N previews the multi-diver berth row.
  bell: { x: 10, y: 20, z: 414, yaw: 2.68, pitch: -0.06 },
};

export function getShotConfig(): ShotConfig | null {
  const p = new URLSearchParams(location.search);
  const name = p.get("shot");
  if (!name) return null;
  const base = SHOTS[name] ?? {};
  const num = <T extends number | undefined>(
    key: string,
    fallback: T,
  ): number | T => {
    const v = Number.parseFloat(p.get(key) ?? "");
    return Number.isFinite(v) ? v : fallback;
  };
  // FP body tuning sweep: &uy=&ux=&fy=&fx= (arm pose) and &ox=&oy=&oz=
  // (body offset from the eye) override diverRig's FP constants for this
  // capture only — a candidate pose can be screenshotted before it's baked in.
  const pose: Record<string, number> = {};
  for (const k of [
    "uy",
    "ux",
    "fy",
    "fx",
    "hx",
    "ox",
    "oy",
    "oz",
    "pb",
    "pf",
  ]) {
    const v = num(k, undefined);
    if (v !== undefined) pose[k] = v;
  }
  if (Object.keys(pose).length) configureFpBody(pose);

  return {
    name,
    x: num("x", base.x),
    y: num("y", base.y),
    z: num("z", base.z),
    yaw: num("yaw", base.yaw ?? 0),
    pitch: num("pitch", base.pitch ?? 0),
    keys: p.get("keys")?.split(",").filter(Boolean) ?? base.keys ?? [],
    light: num("light", 0),
    bells: num("bells", 0),
    settle: num("settle", 30),
  };
}

// Called by main.js once the world is built and the spawn point applied.
// teleport(x, y, z) is main.js's own teleport (resets velocity/buffers).
export function applyShot(
  cfg: ShotConfig,
  teleport: (x: number, y: number, z: number) => void,
  position: { x: number; y: number; z: number },
) {
  document.getElementById("menu")?.classList.add("hidden");
  document.getElementById("hud")?.classList.remove("hidden");
  // The loader's fade-out transition can straddle the capture — kill it.
  const loader = document.getElementById("loader");
  if (loader) loader.style.display = "none";
  if (cfg.light) addShotLight(cfg.light);
  if (cfg.bells) setBellCount(cfg.bells); // preview the multi-diver berth row

  teleport(cfg.x ?? position.x, cfg.y ?? position.y, cfg.z ?? position.z);
  setLook(cfg.yaw, cfg.pitch);

  // Hold movement keys via real events so input.js (and anything else
  // listening) sees exactly what a player pressing the key produces.
  for (const code of cfg.keys) {
    window.dispatchEvent(new KeyboardEvent("keydown", { code }));
  }

  // Raise the runner's ready flag after `settle` rendered frames, so swim
  // animation and drift are visibly mid-motion when the frame is captured.
  let frames = 0;
  const tick = () => {
    if (++frames >= cfg.settle) window.__shotReady = true;
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
