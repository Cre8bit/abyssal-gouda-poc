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
  settle?: number; // frames to render before capture
  // Relative to gouda cavern; resolves at capture time if not explicitly set.
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

// pitch/yaw in radians. keys = e.code values held for capture.
const SHOTS: Record<string, ShotPreset> = {
  // First-person body: gloves at every look angle.
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
  // Gouda in cavern with levitating bits; settle=240 waits for orbit/drift.
  gouda: { gold: { dx: 0, dy: 0.5, dz: 3.2 }, pitch: -0.12, settle: 240 },
  "gouda-carry": {
    gold: { dx: 0, dy: 0.3, dz: 2.4 },
    pitch: -0.5,
    keys: ["KeyE"],
    settle: 240,
  },
  // Tin bell from gouda side; &bells=N previews multi-diver berth.
  bell: { x: 10, y: 20, z: 414, yaw: 2.68, pitch: -0.06 },
};

// FP-body tuning knobs from URL (shared with bench/preview.ts).
// Prefixes: d=LOOK-DOWN, c=CARRY, o=body offset, sc=scale, pb/pf=screen anchor.
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
  // Clear loader fade-out transition.
  const loader = document.getElementById("loader");
  if (loader) loader.style.display = "none";
  if (cfg.light) addShotLight(cfg.light);
  if (cfg.bells) setBellCount(cfg.bells);
  // Gold-relative presets resolve here once world is seeded; explicit x/y/z wins.
  const gold = cfg.gold ? getGoldPos() : null;
  teleport(
    cfg.x ?? (gold ? gold.x + cfg.gold!.dx : position.x),
    cfg.y ?? (gold ? gold.y + cfg.gold!.dy : position.y),
    cfg.z ?? (gold ? gold.z + cfg.gold!.dz : position.z),
  );
  setLook(cfg.yaw, cfg.pitch);
  // Dispatch real keyboard events so listeners see actual key presses.
  for (const code of cfg.keys) {
    window.dispatchEvent(new KeyboardEvent("keydown", { code }));
  }
  // Set ready flag after settle frames so motion is mid-frame.
  let frames = 0;
  const tick = () => {
    if (++frames >= cfg.settle) window.__shotReady = true;
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
