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
import { getGoldPos } from "../world/gouda.ts";

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
  settle?: number; // frames to render before the capture (see ShotConfig)
  // Park relative to the Golden Gouda's cavern rather than at a fixed world
  // point. The wheel's hiding place is seeded, so a hard-coded vantage point
  // would have to be re-measured every time SHOT_SEED changed; this resolves
  // against getGoldPos() at capture time instead. Explicit x/y/z still win.
  gold?: { dx: number; dy: number; dz: number };
}

// The fully resolved config applyShot() consumes (built by getShotConfig()).
export interface ShotConfig {
  name: string;
  x: number | undefined;
  y: number | undefined;
  z: number | undefined;
  gold: { dx: number; dy: number; dz: number } | undefined;
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
  // The Golden Gouda in its cavern: the levitating bits, the lamp, and (with
  // KeyE held at the top of the capture) the wheel in your own two hands.
  // `settle` is raised well past the default because the bits' orbit and
  // radial drift are slow by design — 30 frames in, nothing has moved yet.
  gouda: { gold: { dx: 0, dy: 0.5, dz: 3.2 }, pitch: -0.12, settle: 240 },
  "gouda-carry": {
    gold: { dx: 0, dy: 0.3, dz: 2.4 },
    pitch: -0.5,
    keys: ["KeyE"],
    settle: 240,
  },
  // The tin bell berthed at the spawn (default spawn ≈ (0, 18, 434); the
  // spawn sits at hatch eye height INSIDE it — see bathyscaphe.js), seen
  // from the gouda side so the hatch doorway + entry beacon are in frame.
  // &bells=N previews the multi-diver berth row.
  bell: { x: 10, y: 20, z: 414, yaw: 2.68, pitch: -0.06 },
};

// The FP-body tuning knobs, read straight off the URL. Shared with the model
// bench (bench/preview.ts) so a candidate arm pose can be swept in either
// place with the same query string: the bench for the geometry (it reads the
// joint positions back in camera space), the shot runner for the frame.
//
// &uy=&ux=&fy=&fx=&fz=&hx=&hy=&hz= is the LEVEL arm pose; the same eight
// `d`-prefixed are the LOOK-DOWN reveal and `c`-prefixed the CARRY grip.
// &ox=&oy=&oz= / &coy=&coz= move the body off the eye (idle and carrying),
// &sc= sets how long the arms are relative to the FOV, and
// &pb=&pf= are the screen anchor. They override diverRig's constants for this
// page load only — a candidate pose can be seen before it is baked in.
const ARM_KEYS = ["uy", "ux", "fy", "fx", "fz", "hx", "hy", "hz"];
export function applyFpBodyParams(p: URLSearchParams): void {
  const pose: Record<string, number> = {};
  for (const k of [
    ...ARM_KEYS,
    ...ARM_KEYS.map((k) => `d${k}`),
    ...ARM_KEYS.map((k) => `c${k}`),
    "ox",
    "oy",
    "oz",
    "sc",
    "pb",
    "pf",
    "rs",
    "coy",
    "coz",
  ]) {
    const v = Number.parseFloat(p.get(k) ?? "");
    if (Number.isFinite(v)) pose[k] = v;
  }
  if (Object.keys(pose).length) configureFpBody(pose);
}

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
  applyFpBodyParams(p);

  return {
    name,
    x: num("x", base.x),
    y: num("y", base.y),
    z: num("z", base.z),
    gold: base.gold,
    yaw: num("yaw", base.yaw ?? 0),
    pitch: num("pitch", base.pitch ?? 0),
    keys: p.get("keys")?.split(",").filter(Boolean) ?? base.keys ?? [],
    light: num("light", 0),
    bells: num("bells", 0),
    settle: num("settle", base.settle ?? 30),
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

  // Gold-relative presets resolve here, once the world exists and the wheel
  // has been seeded. An explicit x/y/z (from the preset or the URL) wins.
  const gold = cfg.gold ? getGoldPos() : null;
  teleport(
    cfg.x ?? (gold ? gold.x + cfg.gold!.dx : position.x),
    cfg.y ?? (gold ? gold.y + cfg.gold!.dy : position.y),
    cfg.z ?? (gold ? gold.z + cfg.gold!.dz : position.z),
  );
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
