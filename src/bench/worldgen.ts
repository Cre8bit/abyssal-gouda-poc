// worldgen.ts — the cheese kit's authoring bench (M2), served at
// /worldgen.html. Edits a live WorldRecipe copy (persisted to localStorage)
// through three views, all driven by the REAL generator in world/gouda.ts:
//
//   part   one CheesePartType at the origin — every PartRecipe field on a
//          slider, instant remesh, any biome's skin
//   biome  a representative wedge of one biome — placement density, sizes,
//          part mix, wax material; fused/hull biomes show real lattice
//          tiles with their inter-tile carve network
//   map    the whole map as instant proxies (spheres for scattered
//          chunks, boxes for layer tiles, hull silhouettes, the spine,
//          soft spots, the vein trail chain and the shell entrance); or
//          the real full build via buildGoudaWorld(). Both map modes carry
//          the same overlay: labelled per-biome radius rings, spine, soft
//          spots, entrance, wreck, seeded props — and the route verifier
//          (WG-14) runs in a worker after every (re)build, drawing the
//          solved bell → gold path with its door pass-throughs and posting
//          the SEALED / REACHABLE / bottleneck verdict into the HUD.
//
// A perf overlay (WG-18) sits top-right in every mode: rolling FPS,
// renderer.info, scene-triangle census by biome, last build wall time.
//
// The panel is CATEGORIZED: a mode row (part/biome/map + world table), a
// generate block, a subject picker with its mood line, then per-category
// tabs — no giant scrolling sidebar. WALK mode (F) pointer-locks into a
// player-speed swim (10 u/s, collision at the player's 0.6 u radius) so any
// part/biome/world can be navigated exactly like the game. The clip plane
// cuts along X/Y/Z (flippable) through everything, including real builds.
//
// "copy" buttons dump the edited entry as JSON to paste into
// world/recipes.ts — that is the commit step; the game only ever plays the
// shipped tables. Deep links: ?world=, ?part=, ?biome=, ?map=1, &seed=.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  buildGoudaWorld,
  buildLayerChunks,
  buildWorldData,
  chunkDistance,
  createGoudaMaterial,
  effectiveTunnelRadius,
  tileFieldCovers,
  disposeWorld,
  getGoldPos,
  getSeededProps,
  getSpawnPoint,
  makeChunkData,
  meshChunk,
  mulberry32,
  nearestSpinePoint,
  planWorldLayout,
  updateGouda,
  updateGoudaMaterial,
  worldDistance,
  type Chunk,
  type GenCtx,
  type SeededProp,
  type SeededPropKind,
  type WorldData,
  type WorldPlan,
} from "../world/gouda.ts";
import { makeFrame, R0 } from "../world/sdf.ts";
import { traceTrail, type VerifyResult } from "../world/verify.ts";
import type { VerifyReply, VerifyRequest } from "./verifyWorker.ts";
import {
  cloneWorld,
  validateWorld,
  WHEEL_WORLD,
  type BiomeMaterial,
  type BiomeRecipe,
  type Hardness,
  type PartKind,
  type PartRecipe,
  type WorldRecipe,
} from "../world/recipes.ts";
import type { Vec3 } from "../state.ts";
import {
  button,
  colorRow,
  markOn,
  numRow,
  section,
  selectRow,
  sliderRow,
  textRow,
} from "./ui.ts";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const STORAGE_KEY = "abyssal.worldgen.v3";
const RES_CHOICES = [32, 48, 56, 64, 72, 96];
const KINDS: PartKind[] = ["wheel", "hunk", "block", "slab", "column"];
const HALF_RES: Record<number, number> = {
  96: 48,
  72: 48,
  64: 32,
  56: 32,
  48: 32,
  32: 32,
};
const WORLD_DEFAULTS: Record<string, WorldRecipe> = {
  wheel: WHEEL_WORLD,
};
const WORLD_LABELS: Record<string, string> = {
  wheel: "great wheel",
};

// --- Working config ----------------------------------------------------------

interface Store {
  v: number;
  active: string;
  worlds: Record<string, WorldRecipe>;
}

function freshStore(): Store {
  return {
    v: 3,
    active: "wheel",
    worlds: {
      wheel: cloneWorld(WHEEL_WORLD),
    },
  };
}

// Older stores (v1/v2) carried the retired classic-onion schema — they are
// not migrated, a fresh copy of the shipped tables replaces them.
function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as Store;
      if (data.v === 3 && data.worlds?.wheel) return data;
    }
  } catch {
    // fall through to defaults
  }
  return freshStore();
}

const store = loadStore();
let world: WorldRecipe = store.worlds[store.active];

function save(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  // WG-17b/c: every edit funnels through here — recheck the seed-time rules
  // (badge in ALL views) and the edited-vs-shipped dot on the world picker.
  scheduleValidate();
  refreshWorldPicker();
}

// WG-17c: the world picker marks tables that drift from the shipped copy.
let worldPicker: ReturnType<typeof selectRow> | null = null;

function worldOptions(): { value: string; label: string }[] {
  return Object.keys(WORLD_DEFAULTS).map((k) => {
    const edited =
      JSON.stringify(store.worlds[k]) !== JSON.stringify(WORLD_DEFAULTS[k]);
    return { value: k, label: (edited ? "● " : "") + (WORLD_LABELS[k] ?? k) };
  });
}

function refreshWorldPicker(): void {
  worldPicker?.refresh(worldOptions());
  worldPicker?.set(store.active);
}

// WG-17b: validateWorld on every edit (debounced like the rebuild), surfaced
// as a red badge in every view — not just the map's build tab.
let validateTimer = 0;
function scheduleValidate(): void {
  clearTimeout(validateTimer);
  validateTimer = window.setTimeout(() => {
    const errors = validateWorld(world);
    const badge = $("validate-badge");
    badge.style.display = errors.length ? "block" : "none";
    badge.textContent = errors.length
      ? `✗ ${errors.length} rule violation${errors.length > 1 ? "s" : ""} — ${errors[0]}`
      : "";
    badge.title = errors.join("\n");
  }, 150);
}

type Mode = "part" | "biome" | "map";

const view = {
  mode: "part" as Mode,
  seed: 7,
  difficulty: 1,
  cat: { part: "shape", biome: "place", map: "world" } as Record<Mode, string>,
  // part view
  partId: world.parts[0].id,
  partSize: 0, // 0 = derive from the recipe's size range on selection
  partRes: 48,
  skinBiomeId: world.biomes[0].id as string,
  // biome view
  biomeId: world.biomes[0].id as string,
  wedgeDeg: 35,
  // map view
  built: false, // real meshes mounted (vs proxies)
  buildHalfRes: true,
  // seeded-prop marker overlay (WG-11), per kind
  propKinds: {
    airPocket: true,
    wreck: true,
    melt_fall: true,
    melt_pool: true,
    thermal_vent: true,
  } as Record<SeededPropKind, boolean>,
  // shared view options
  clipOn: false,
  clipAxis: "y" as "x" | "y" | "z",
  clipFlip: false,
  clipFrac: 0,
  fogOn: true,
  // Per-mode densities: each view sits at a very different camera distance.
  fog: { part: 0.004, biome: 0.0015, map: 0.0004 } as Record<Mode, number>,
  wire: false,
  spin: false,
  lamp: true,
};

function currentPart(): PartRecipe {
  return world.parts.find((p) => p.id === view.partId) ?? world.parts[0];
}

function currentBiome(): BiomeRecipe {
  return world.biomes.find((b) => b.id === view.biomeId) ?? world.biomes[0];
}

// --- Scene -------------------------------------------------------------------

const WATER = 0x04141e;
const scene = new THREE.Scene();
scene.background = new THREE.Color(WATER);
scene.fog = new THREE.FogExp2(WATER, view.fog[view.mode]);

const camera = new THREE.PerspectiveCamera(
  52,
  innerWidth / innerHeight,
  0.05,
  4000,
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
$("stage").appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
camera.position.set(40, 20, 60);

scene.add(new THREE.HemisphereLight(0x8fd0ff, 0x02121c, 0.9));
const key = new THREE.DirectionalLight(0xbfe4ff, 1.6);
key.position.set(1, 1.4, 1.2);
scene.add(key);
const rim = new THREE.DirectionalLight(0x4f8fb5, 0.9);
rim.position.set(-1.3, 0.3, -1);
scene.add(rim);

// Headlamp: sees into clipped interiors and tunnel mouths.
const lamp = new THREE.PointLight(0xffeec9, 60, 0, 1);
lamp.visible = view.lamp;
camera.add(lamp);
scene.add(camera);

const gridSmall = new THREE.GridHelper(80, 40, 0x2a5a72, 0x14313f);
const gridLarge = new THREE.GridHelper(1200, 60, 0x2a5a72, 0x14313f);
for (const g of [gridSmall, gridLarge]) {
  (g.material as THREE.Material).transparent = true;
  (g.material as THREE.Material).opacity = 0.35;
  scene.add(g);
}
let gridOn = true;

// Global clip plane — cuts EVERYTHING (bench meshes and real builds alike).
const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e9);
let clipScale = 20; // world-u range of the clip slider, set per rebuild

function updateClip(): void {
  const a = view.clipAxis;
  const sign = view.clipFlip ? 1 : -1;
  clipPlane.normal.set(
    a === "x" ? sign : 0,
    a === "y" ? sign : 0,
    a === "z" ? sign : 0,
  );
  clipPlane.constant = -sign * view.clipFrac * clipScale;
  renderer.clippingPlanes = view.clipOn ? [clipPlane] : [];
  renderer.localClippingEnabled = view.clipOn;
}

// --- Walk mode (be the player) --------------------------------------------------

const PLAYER_RADIUS = 0.6;
const WALK_SPEED = 10; // the game's MAX_SPEED

const walk = {
  on: false,
  collide: true,
  yaw: 0,
  pitch: 0,
  keys: new Set<string>(),
  vel: new THREE.Vector3(),
};

// The part/biome previews keep their chunk SDFs for walk collision.
let benchChunks: Chunk[] = [];

function benchDistance(x: number, y: number, z: number): number {
  if (view.built) return worldDistance(x, y, z);
  let best = 1e9;
  for (const c of benchChunks) {
    const dc = c.center.distanceTo(_wp.set(x, y, z));
    if (dc - c.s * 1.8 > best) continue;
    if (c.body && !tileFieldCovers(c, x, y, z)) continue;
    const d = chunkDistance(c, x, y, z);
    if (d < best) best = d;
  }
  return best;
}

const _wp = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rgt = new THREE.Vector3();
const _mv = new THREE.Vector3();

function enterWalk(): void {
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
  walk.yaw = e.y;
  walk.pitch = e.x;
  walk.vel.set(0, 0, 0);
  walk.keys.clear();
  walk.on = true;
  controls.enabled = false;
  renderer.domElement.requestPointerLock();
  $("walk-hud").style.display = "block";
  $("crosshair").style.display = "block";
  walkBtn.classList.add("on");
}

function exitWalk(): void {
  walk.on = false;
  controls.enabled = true;
  camera.getWorldDirection(_fwd);
  controls.target.copy(camera.position).addScaledVector(_fwd, 8);
  $("walk-hud").style.display = "none";
  $("crosshair").style.display = "none";
  walkBtn.classList.remove("on");
  if (document.pointerLockElement === renderer.domElement)
    document.exitPointerLock();
}

document.addEventListener("pointerlockchange", () => {
  if (walk.on && document.pointerLockElement !== renderer.domElement)
    exitWalk();
});

addEventListener("mousemove", (e) => {
  if (!walk.on || document.pointerLockElement !== renderer.domElement) return;
  walk.yaw -= e.movementX * 0.0022;
  walk.pitch = Math.max(
    -1.55,
    Math.min(1.55, walk.pitch - e.movementY * 0.0022),
  );
});

function updateWalk(dt: number): void {
  camera.quaternion.setFromEuler(
    new THREE.Euler(walk.pitch, walk.yaw, 0, "YXZ"),
  );
  camera.getWorldDirection(_fwd);
  _rgt.crossVectors(_fwd, camera.up).normalize();
  _mv.set(0, 0, 0);
  const k = walk.keys;
  if (k.has("KeyW")) _mv.add(_fwd);
  if (k.has("KeyS")) _mv.addScaledVector(_fwd, -1);
  if (k.has("KeyD")) _mv.add(_rgt);
  if (k.has("KeyA")) _mv.addScaledVector(_rgt, -1);
  if (k.has("Space")) _mv.y += 1;
  if (k.has("KeyC")) _mv.y -= 1;
  if (_mv.lengthSq() > 0) _mv.normalize();
  const speed =
    WALK_SPEED * (k.has("ShiftLeft") || k.has("ShiftRight") ? 3 : 1);
  _mv.multiplyScalar(speed);
  walk.vel.lerp(_mv, 1 - Math.exp(-dt * 9));
  camera.position.addScaledVector(walk.vel, dt);

  if (!walk.collide) return;
  const p = camera.position;
  for (let iter = 0; iter < 2; iter++) {
    const d = benchDistance(p.x, p.y, p.z);
    if (!Number.isFinite(d) || d >= PLAYER_RADIUS) break;
    const E = 0.25;
    let nx =
      benchDistance(p.x + E, p.y, p.z) - benchDistance(p.x - E, p.y, p.z);
    let ny =
      benchDistance(p.x, p.y + E, p.z) - benchDistance(p.x, p.y - E, p.z);
    let nz =
      benchDistance(p.x, p.y, p.z + E) - benchDistance(p.x, p.y, p.z - E);
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-5) {
      nx = 0;
      ny = 1;
      nz = 0;
    } else {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    p.x += nx * (PLAYER_RADIUS - d + 0.001);
    p.y += ny * (PLAYER_RADIUS - d + 0.001);
    p.z += nz * (PLAYER_RADIUS - d + 0.001);
  }
}

// --- Content lifecycle ---------------------------------------------------------

let content: THREE.Group | null = null;
let disposables: { dispose(): void }[] = [];
let buildToken = 0;

function setLoading(text: string | null): void {
  const el = $("loading");
  el.style.display = text === null ? "none" : "flex";
  if (text !== null) el.textContent = text;
}

function disposeContent(): void {
  buildToken++;
  if (view.built) {
    disposeWorld(scene);
    view.built = false;
  }
  if (content) {
    scene.remove(content);
    content = null;
  }
  for (const d of disposables) d.dispose();
  disposables = [];
  benchChunks = [];
  clearProps();
  cancelVerify();
  mapHud = null;
  setLoading(null);
}

// --- Seeded prop markers (WG-11) -------------------------------------------------

const PROP_COLORS: Record<SeededPropKind, number> = {
  airPocket: 0x8fe8ff,
  wreck: 0x9ca3af,
  melt_fall: 0xff7043,
  melt_pool: 0xffb020,
  thermal_vent: 0xffe36e,
};

let propsGroup: THREE.Group | null = null;
let propDisposables: { dispose(): void }[] = [];

function clearProps(): void {
  if (propsGroup) scene.remove(propsGroup);
  propsGroup = null;
  for (const d of propDisposables) d.dispose();
  propDisposables = [];
}

// One data build for the proxies overlay (no meshing, ~50 ms): the plan the
// specs came from, plus the REAL seeded props / spawn / gold — the same
// values a full build would land on. null on an invalid recipe (dataErr).
let dataErr: string | null = null;
function computeWorldData(): WorldData | null {
  dataErr = null;
  try {
    return buildWorldData({
      seed: view.seed,
      difficulty: view.difficulty,
      world,
    });
  } catch (err) {
    dataErr = (err as Error).message;
    return null;
  }
}

// Redraw the marker overlay; returns the prop list for HUD counting.
function drawProps(props: SeededProp[]): SeededProp[] {
  clearProps();
  const group = new THREE.Group();
  const mats = new Map<SeededPropKind, THREE.MeshBasicMaterial>();
  for (const p of props) {
    if (!view.propKinds[p.kind]) continue;
    let mat = mats.get(p.kind);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({ color: PROP_COLORS[p.kind] });
      mats.set(p.kind, mat);
      propDisposables.push(mat);
    }
    const marker = new THREE.Mesh(proxyGeo, mat);
    marker.position.set(p.pos.x, p.pos.y, p.pos.z);
    marker.scale.setScalar(p.kind === "wreck" ? 3 : 1.6);
    group.add(marker);
    if (p.dir) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z),
        new THREE.Vector3(
          p.pos.x + p.dir.x * 5,
          p.pos.y + p.dir.y * 5,
          p.pos.z + p.dir.z * 5,
        ),
      ]);
      const lineMat = new THREE.LineBasicMaterial({
        color: PROP_COLORS[p.kind],
        transparent: true,
        opacity: 0.7,
      });
      propDisposables.push(geo, lineMat);
      group.add(new THREE.Line(geo, lineMat));
    }
  }
  scene.add(group);
  propsGroup = group;
  return props;
}

// HUD lines: seeded counts vs the recipe budgets.
function propHudLines(props: SeededProp[]): HudLine[] {
  const count = (kind: SeededPropKind, zone?: string) =>
    props.filter((p) => p.kind === kind && (!zone || p.zone === zone)).length;
  const lines: HudLine[] = [];
  for (const biome of world.biomes) {
    const bud = biome.budgets;
    if (bud?.airPockets) {
      const got = count("airPocket", biome.id);
      lines.push([
        `air · ${biome.id}`,
        `${got} / ${bud.airPockets}`,
        got === bud.airPockets ? "ok" : "bad",
      ]);
    }
    if (bud?.hazards) {
      const spec: [SeededPropKind, number][] = [
        ["melt_fall", bud.hazards.meltFalls],
        ["melt_pool", bud.hazards.meltPools],
        ["thermal_vent", bud.hazards.vents],
      ];
      for (const [kind, want] of spec) {
        const got = count(kind, biome.id);
        lines.push([kind, `${got} / ${want}`, got === want ? "ok" : "bad"]);
      }
    }
  }
  lines.push(["wreck", String(count("wreck"))]);
  return lines;
}

// --- Route verifier overlay (WG-14) ------------------------------------------------

const verifyState = {
  worker: null as Worker | null,
  token: 0, // stamps requests; replies with older stamps are dropped
  running: false,
  result: null as VerifyResult | null,
  error: null as string | null,
};
let routeGroup: THREE.Group | null = null;
let routeDisposables: { dispose(): void }[] = [];

function clearRoute(): void {
  if (routeGroup) scene.remove(routeGroup);
  routeGroup = null;
  for (const d of routeDisposables) d.dispose();
  routeDisposables = [];
}

function cancelVerify(): void {
  verifyState.token++;
  verifyState.running = false;
  verifyState.result = null;
  verifyState.error = null;
  verifyState.worker?.terminate();
  verifyState.worker = null;
  clearRoute();
}

// Kick a verifier pass for the current map content. Runs in a worker on the
// FULL-res edited tables (half-res is a preview shortcut; the verdict must
// match what ships), so the bench stays interactive through the search.
function startVerify(plan: WorldPlan): void {
  cancelVerify();
  const token = verifyState.token;
  verifyState.running = true;
  const w = new Worker(new URL("./verifyWorker.ts", import.meta.url), {
    type: "module",
  });
  verifyState.worker = w;
  w.onmessage = (e: MessageEvent<VerifyReply>) => {
    if (e.data.token !== verifyState.token) return; // superseded mid-run
    verifyState.running = false;
    verifyState.result = e.data.result ?? null;
    verifyState.error = e.data.error ?? null;
    w.terminate();
    verifyState.worker = null;
    if (verifyState.result) drawRoute(verifyState.result, plan);
    refreshMapHud();
  };
  const msg: VerifyRequest = {
    token,
    seed: view.seed,
    difficulty: view.difficulty,
    world,
  };
  w.postMessage(msg);
  refreshMapHud();
}

// The solved route bell → gold, drawn through everything (no depth test):
// the polyline, a ring on each door the path threads, and the bottleneck.
function drawRoute(r: VerifyResult, plan: WorldPlan): void {
  clearRoute();
  if (!r.path.length) return;
  const group = new THREE.Group();
  const pts = r.path.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({
    color: 0xff7ad9,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });
  routeDisposables.push(geo, mat);
  const line = new THREE.Line(geo, mat);
  line.renderOrder = 8;
  group.add(line);

  const doorMat = new THREE.MeshBasicMaterial({
    color: 0x86ffbe,
    wireframe: true,
    transparent: true,
    opacity: 0.8,
    depthTest: false,
  });
  routeDisposables.push(doorMat);
  const doors: { x: number; y: number; z: number; r: number }[] = [
    ...plan.softSpots,
  ];
  if (plan.entrance) {
    doors.push({ ...plan.entrance.surface, r: plan.entrance.r + 1.5 });
  }
  for (const d of doors) {
    let near = Infinity;
    for (const p of pts) {
      const v = Math.hypot(p.x - d.x, p.y - d.y, p.z - d.z);
      if (v < near) near = v;
    }
    if (near > d.r + 6) continue; // the route didn't pass through this door
    const m = new THREE.Mesh(proxyGeo, doorMat);
    m.position.set(d.x, d.y, d.z);
    m.scale.setScalar(d.r + 2);
    m.renderOrder = 8;
    group.add(m);
  }

  if (r.bottleneck) {
    const bm = new THREE.MeshBasicMaterial({
      color: 0xf87171,
      depthTest: false,
    });
    routeDisposables.push(bm);
    const b = new THREE.Mesh(proxyGeo, bm);
    b.position.set(r.bottleneck.x, r.bottleneck.y, r.bottleneck.z);
    b.scale.setScalar(2);
    b.renderOrder = 9;
    group.add(b);
  }

  scene.add(group);
  routeGroup = group;
}

// Map HUD = verifier verdict block + the view's own base lines; the verdict
// refreshes in place when the worker lands without rebuilding anything.
let mapHud: { title: string; lines: HudLine[] } | null = null;

function setMapHud(title: string, lines: HudLine[]): void {
  mapHud = { title, lines };
  refreshMapHud();
}

function verifyHudLines(): HudLine[] {
  if (verifyState.running) return [["verifier", "running…"]];
  if (verifyState.error) return [["verifier", verifyState.error, "bad"]];
  const r = verifyState.result;
  if (!r) return [];
  const lines: HudLine[] = [
    [
      "sealed",
      `wheel ${r.sealedWheel ? "✓" : "✗"} · shell ${r.sealedShell ? "✓" : "✗"}`,
      r.sealed ? "ok" : "bad",
    ],
    ["reachable", r.reachable ? "✓" : "✗", r.reachable ? "ok" : "bad"],
  ];
  if (r.reachable)
    lines.push([
      "bottleneck",
      `${r.minClearance.toFixed(2)} u @ ${r.bottleneckZone ?? "?"}`,
      r.minClearance >= 0.5 ? "ok" : "bad",
    ]);
  if (r.entranceClearance != null)
    lines.push([
      "entrance clear",
      `${r.entranceClearance.toFixed(2)} u`,
      r.entranceClearance >= 1.4 ? "ok" : "bad",
    ]);
  lines.push(["verify time", `${(r.ms / 1000).toFixed(1)} s`]);
  return lines;
}

function refreshMapHud(): void {
  if (view.mode !== "map" || !mapHud) return;
  setHud(mapHud.title, [...verifyHudLines(), ...mapHud.lines]);
}

// --- Shared map overlay (WG-15) -----------------------------------------------------

// A flat circle of radius r in the group's local XZ plane.
function ringLine(radius: number, color: number, opacity: number): THREE.Line {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
  });
  disposables.push(geo, mat);
  return new THREE.Line(geo, mat);
}

// A small always-facing text label (biome ids on the radius rings).
function labelSprite(text: string, color: number): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const font = "600 28px ui-monospace, Menlo, monospace";
  const measure = canvas.getContext("2d")!;
  measure.font = font;
  canvas.width = Math.ceil(measure.measureText(text).width) + 16;
  canvas.height = 40;
  const c = canvas.getContext("2d")!; // resizing reset the context state
  c.font = font;
  c.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  c.fillText(text, 8, 30);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
  });
  disposables.push(tex, mat);
  const sprite = new THREE.Sprite(mat);
  // Sized for the map camera (~2× worldR away) — smaller drowns at 800 u.
  sprite.scale.set((canvas.width / canvas.height) * 18, 18, 1);
  sprite.renderOrder = 7;
  return sprite;
}

// A tiny tin-bell glyph at the spawn berth (dome + open skirt).
function bellGlyph(pos: Vec3): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: 0xa8d8cf,
    wireframe: true,
    transparent: true,
    opacity: 0.9,
  });
  const domeGeo = new THREE.SphereGeometry(
    3,
    12,
    6,
    0,
    Math.PI * 2,
    0,
    Math.PI / 2,
  );
  const skirtGeo = new THREE.CylinderGeometry(3, 3.8, 3, 12, 1, true);
  disposables.push(mat, domeGeo, skirtGeo);
  const dome = new THREE.Mesh(domeGeo, mat);
  const skirt = new THREE.Mesh(skirtGeo, mat);
  skirt.position.y = -1.5;
  g.add(dome, skirt);
  g.position.set(pos.x, pos.y, pos.z);
  return g;
}

// Everything the map should always show, proxies AND real build: labelled
// per-biome radius rings (the layer ladder), world radii, the spine, hull
// soft spots, the sightline trail, the shell entrance, the wreck. Returns
// the trail verdict for the HUD.
function drawMapOverlay(
  plan: WorldPlan,
  group: THREE.Group,
): ReturnType<typeof traceTrail> {
  // The layer ladder, in the tilted frame (layer radii are frame-metric).
  const frame = makeFrame(world.frame);
  const rings = new THREE.Group();
  if (frame) rings.rotation.x = -Math.asin(frame.sin);
  for (const [i, biome] of world.biomes.entries()) {
    const pl = biome.placement;
    let radii: number[] = [];
    if (pl.mode === "band" || pl.mode === "fused") radii = [pl.rMin, pl.rMax];
    else if (pl.mode === "hull") radii = [pl.radius];
    if (!radii.length) continue; // center mode — a point, not a band
    const color = biome.material.rind;
    for (const r of radii) rings.add(ringLine(r, color, 0.45));
    const rOut = Math.max(...radii);
    const label = labelSprite(biome.id, color);
    // Staggered azimuth so near-coincident radii don't stack their labels.
    const az = Math.PI / 4 + i * 0.7;
    label.position.set(Math.cos(az) * rOut, 0, Math.sin(az) * rOut);
    rings.add(label);
  }
  group.add(rings);

  // World radii: gold band (gold), world edge + boundary veil (teal).
  const shells: [number, number, number][] = [
    [world.goldBand.min, 0xffd24a, 0.1],
    [world.goldBand.max, 0xffd24a, 0.1],
    [world.worldR, 0x2a7da5, 0.08],
    [world.boundaryR, 0x1d4457, 0.1],
  ];
  for (const [radius, color, opacity] of shells) {
    if (radius <= 0) continue;
    const m = new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      transparent: true,
      opacity,
    });
    disposables.push(m);
    const mesh = new THREE.Mesh(shellGeo, m);
    mesh.scale.setScalar(radius);
    group.add(mesh);
  }

  // Spine (the descent route) + hull soft spots.
  if (plan.spine.length) {
    const sm = new THREE.MeshBasicMaterial({ color: 0xffe08a });
    disposables.push(sm);
    const pts: THREE.Vector3[] = [];
    for (const p of plan.spine) {
      const marker = new THREE.Mesh(proxyGeo, sm);
      marker.position.set(p.x, p.y, p.z);
      marker.scale.setScalar(3.5);
      group.add(marker);
      pts.push(new THREE.Vector3(p.x, p.y, p.z));
    }
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xffe08a,
      transparent: true,
      opacity: 0.6,
    });
    disposables.push(lineGeo, lineMat);
    group.add(new THREE.Line(lineGeo, lineMat));
  }
  if (plan.softSpots.length) {
    const om = new THREE.MeshBasicMaterial({ color: 0xff8a4a });
    disposables.push(om);
    for (const sp of plan.softSpots) {
      const marker = new THREE.Mesh(proxyGeo, om);
      marker.position.set(sp.x, sp.y, sp.z);
      marker.scale.setScalar(sp.r * 0.8);
      group.add(marker);
    }
  }

  // The vein trail chain (WG-07): linking hops green, out-of-range red.
  const trail = traceTrail(world, plan);
  if (trail) {
    const draw = (ok: boolean, color: number) => {
      const pts: THREE.Vector3[] = [];
      for (const e of trail.edges)
        if (e.ok === ok)
          pts.push(
            new THREE.Vector3(e.a.x, e.a.y, e.a.z),
            new THREE.Vector3(e.b.x, e.b.y, e.b.z),
          );
      if (!pts.length) return;
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.75,
      });
      disposables.push(geo, mat);
      group.add(new THREE.LineSegments(geo, mat));
    };
    draw(true, 0x4ade80);
    draw(false, 0xef4444);
  }

  // The melt-shell entrance (WG-08) + the wreck (WG-05).
  if (plan.entrance) {
    const em = new THREE.MeshBasicMaterial({ color: 0x34e5e5 });
    disposables.push(em);
    const e = plan.entrance;
    const marker = new THREE.Mesh(proxyGeo, em);
    marker.position.set(e.surface.x, e.surface.y, e.surface.z);
    marker.scale.setScalar(3);
    group.add(marker);
  }
  if (plan.wreckPos) {
    const wm = new THREE.MeshBasicMaterial({ color: 0x9ca3af });
    disposables.push(wm);
    const marker = new THREE.Mesh(proxyGeo, wm);
    marker.position.set(plan.wreckPos.x, plan.wreckPos.y, plan.wreckPos.z);
    marker.scale.setScalar(3);
    group.add(marker);
  }

  return trail;
}

function mount(group: THREE.Group): void {
  content = group;
  scene.add(group);
  applyWire();
}

function frameCamera(dist: number): void {
  camera.position.set(dist * 0.72, dist * 0.42, dist * 0.9);
  controls.target.set(0, 0, 0);
}

type HudLine = [string, string] | [string, string, "ok" | "bad"];

function setHud(title: string, lines: HudLine[]): void {
  $("hud-title").textContent = title;
  const body = $("hud-body");
  body.innerHTML = "";
  for (const [k, v, cls] of lines) {
    const div = document.createElement("div");
    div.className = "hud-line";
    div.innerHTML = `<span class="k"></span><span class="v"></span>`;
    (div.querySelector(".k") as HTMLElement).textContent = k;
    const val = div.querySelector(".v") as HTMLElement;
    val.textContent = v;
    if (cls) val.classList.add(cls);
    body.appendChild(div);
  }
}

function applyWire(): void {
  content?.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material])
      (mat as THREE.MeshToonMaterial).wireframe = view.wire;
  });
}

// Bench skins are double-sided so clipped cut faces read.
function makeSkinMaterial(m: BiomeMaterial): THREE.MeshToonMaterial {
  const mat = createGoudaMaterial(m);
  mat.side = THREE.DoubleSide;
  disposables.push(mat);
  return mat;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// --- Rebuild (debounced) ---------------------------------------------------------

let rebuildTimer = 0;
function scheduleRebuild(delay = 120): void {
  clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => void rebuild(), delay);
  syncUrl(); // seed/difficulty rerolls keep the address bar shareable
}

async function rebuild(): Promise<void> {
  disposeContent();
  gridSmall.visible = gridOn && view.mode !== "map";
  gridLarge.visible = gridOn && view.mode === "map";
  if (view.mode === "part") rebuildPart();
  else if (view.mode === "biome") await rebuildBiome();
  else rebuildMapProxies();
  updateClip();
}

// The edit funnel: mutate tables, persist, regenerate.
function edit(fn: () => void, delay = 120): void {
  fn();
  save();
  scheduleRebuild(delay);
}

// Material-only edits re-skin without remeshing.
function editSkin(fn: () => void): void {
  fn();
  save();
  refreshSkin();
}

function skinSource(): BiomeMaterial {
  if (view.mode === "biome") return currentBiome().material;
  const skin = world.biomes.find((b) => b.id === view.skinBiomeId);
  return (skin ?? world.biomes[0]).material;
}

// WG-24: skins are uniform-driven — a material edit writes the live
// uniforms in place, no new material, no recompiled program, no disposal
// bookkeeping (which WG-17e used to need).
function refreshSkin(): void {
  if (!content || view.mode === "map") return;
  const skin = skinSource();
  content.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material])
      updateGoudaMaterial(mat as THREE.Material, skin);
  });
  applyWire();
}

// --- Part view -------------------------------------------------------------------

// Truthful clearance telemetry (WG-03): quote the radius the generator
// actually carves — effectiveTunnelRadius, i.e. max(lattice floor,
// difficulty-scaled base) — never raw rBase.
function partMetrics(
  part: PartRecipe,
  s: number,
  res: number,
  difficulty: number,
): HudLine[] {
  const lines: HudLine[] = [];
  if (part.tunnels.rBase > 0 || part.eyes.max >= 2) {
    const effMin = effectiveTunnelRadius(part, s, res, difficulty);
    const effMax = effectiveTunnelRadius(
      part,
      s,
      res,
      difficulty,
      part.tunnels.rBase + part.tunnels.rVar,
    );
    const cells = (effMin / s) * res;
    const crisp = cells >= 3.95; // the readable-tunnel rule, r×res ≥ 4
    lines.push([
      "tunnel r×res",
      `${cells.toFixed(1)} ${crisp ? "✓" : "✗ blobby <4"}`,
      crisp ? "ok" : "bad",
    ]);
    lines.push([
      `tunnel r eff (d${difficulty})`,
      `${effMin.toFixed(2)}–${effMax.toFixed(2)} u ` +
        `${effMin >= 1.3 ? "(cargo ✓)" : effMin >= 0.9 ? "(rat ✓ cargo ✗)" : "(rat ✗)"}`,
      effMin >= 0.9 ? "ok" : "bad",
    ]);
  }
  if (part.eyes.rBase > 0)
    lines.push(["eye radius", `${(part.eyes.rBase * s).toFixed(1)} u`]);
  if (part.noCarveWithin != null)
    lines.push(["seal amp cap", `amp ≤ thickness/3/size`]);
  return lines;
}

// Measured clearance of a built preview: the composed SDF sampled at every
// tunnel-segment midpoint — what the generator DID, next to what the
// formula promised.
function measuredClearance(chunkList: Chunk[]): HudLine[] {
  const samples: number[] = [];
  for (const c of chunkList) {
    for (const t of c.tunnels) {
      const mx = c.center.x + ((t.ax + t.bx) / 2) * c.s;
      const my = c.center.y + ((t.ay + t.by) / 2) * c.s;
      const mz = c.center.z + ((t.az + t.bz) / 2) * c.s;
      let d = Infinity;
      for (const other of chunkList) {
        if (other.body && !tileFieldCovers(other, mx, my, mz)) continue;
        const v = chunkDistance(other, mx, my, mz);
        if (v < d) d = v;
      }
      if (Number.isFinite(d)) samples.push(d);
    }
  }
  if (!samples.length) return [];
  samples.sort((a, b) => a - b);
  const min = samples[0];
  const median = samples[samples.length >> 1];
  return [
    [
      "tunnel measured",
      `min ${min.toFixed(2)} · med ${median.toFixed(2)} u`,
      median >= 0.9 ? "ok" : "bad",
    ],
  ];
}

function rebuildPart(): void {
  const part = currentPart();
  if (view.partSize <= 0)
    view.partSize = Math.round((part.size.min + part.size.max) / 2);
  const s = view.partSize;

  const rng = mulberry32(view.seed >>> 0);
  const blast: Vec3[] = [];
  const t0 = performance.now();
  const chunk = makeChunkData(
    rng,
    new THREE.Vector3(0, 0, 0),
    s,
    view.partRes,
    part,
    { difficulty: view.difficulty, blastPoints: blast },
  );
  const tGen = performance.now();
  const mesh = meshChunk(chunk, makeSkinMaterial(skinSource()));
  mesh.userData.zone = part.id;
  chunk.field = null; // the bench never digs; drop the cached voxels
  const tMesh = performance.now();
  notePerfBuild("part gen+mesh", tMesh - t0);
  disposables.push(mesh.geometry);
  benchChunks = [chunk];

  const group = new THREE.Group();
  group.add(mesh);
  mount(group);

  clipScale = s * 0.8;
  gridSmall.position.y = -s * 0.75;
  frameCamera(s * 2.1);

  const tris = Math.round(mesh.geometry.attributes.position.count / 3);
  setHud(`part · ${part.id}`, [
    ["kind", part.kind],
    ["triangles", tris.toLocaleString()],
    [
      "gen / mesh",
      `${(tGen - t0).toFixed(0)} / ${(tMesh - tGen).toFixed(0)} ms`,
    ],
    ["eyes+pores", String(chunk.holes.length)],
    ["tunnel segs", String(chunk.tunnels.length)],
    ["blast walls", String(blast.length)],
    ["size / res", `${s.toFixed(0)} u / ${view.partRes}³`],
    ...partMetrics(part, s, view.partRes, view.difficulty),
    ...measuredClearance(benchChunks),
  ]);
}

// --- Biome view ------------------------------------------------------------------

async function rebuildBiome(): Promise<void> {
  const token = buildToken;
  const biome = currentBiome();
  const pl = biome.placement;
  const cosTheta = Math.cos((view.wedgeDeg * Math.PI) / 180);
  const coneFrac = (1 - cosTheta) / 2;

  if (pl.mode === "fused" || pl.mode === "hull") {
    await rebuildLayerWedge(token, biome, cosTheta, coneFrac);
    return;
  }

  const rng = mulberry32(view.seed >>> 0);
  const ctx = { difficulty: view.difficulty, blastPoints: [] as Vec3[] };

  // WG-16: no re-implemented placement — the preview IS the real layout,
  // filtered by zone + wedge cone (as the fused path already does). Carves
  // still come from a bench-local stream: the real one interleaves every
  // biome, so per-chunk carves can't be replayed in isolation.
  let plan: WorldPlan;
  try {
    plan = planWorldLayout(view.seed, view.difficulty, world);
  } catch (err) {
    setHud("invalid recipe", [["error", (err as Error).message, "bad"]]);
    return;
  }
  const zoneSpecs = plan.specs.filter((sp) => sp.zone === biome.id);
  let placed =
    pl.mode === "center"
      ? zoneSpecs
      : zoneSpecs.filter((sp) => {
          const len = sp.center.length() || 1;
          return sp.center.z / len >= cosTheta;
        });
  if (!placed.length)
    placed = zoneSpecs.slice(0, Math.min(8, zoneSpecs.length));
  const rMid = pl.mode === "band" ? (pl.rMin + pl.rMax) / 2 : 0;

  const group = new THREE.Group();
  group.position.z = -rMid; // recentre the wedge on the origin
  mount(group);

  const mat = makeSkinMaterial(biome.material);
  let tris = 0;
  const t0 = performance.now();
  for (let i = 0; i < placed.length; i++) {
    setLoading(`carving ${i + 1} / ${placed.length}…`);
    await tick();
    if (token !== buildToken) return; // superseded by a newer rebuild
    const c = placed[i];
    const chunk = makeChunkData(rng, c.center, c.s, c.res, c.part, ctx);
    const mesh = meshChunk(chunk, mat);
    mesh.userData.zone = biome.id;
    chunk.field = null;
    // Walk collision runs in world coords — bake the wedge recentre in.
    chunk.center = c.center.clone().add(group.position);
    benchChunks.push(chunk);
    disposables.push(mesh.geometry);
    tris += mesh.geometry.attributes.position.count / 3;
    group.add(mesh);
  }
  setLoading(null);
  applyWire();
  notePerfBuild("wedge build", performance.now() - t0);

  // The wedge spreads laterally by ~2·r·sin(θ) — frame for that, not just
  // the band's radial depth.
  const sinTheta = Math.sin((view.wedgeDeg * Math.PI) / 180);
  const extent =
    pl.mode === "center"
      ? biome.sizeBase * 2.1
      : Math.max(
          pl.rMax - pl.rMin + biome.sizeBase * 2 + 30,
          1.6 * pl.rMax * sinTheta,
        );
  clipScale = extent * 0.5;
  gridSmall.position.y = -extent * 0.45;
  frameCamera(Math.min(extent * 1.1, 700));

  setHud(`biome · ${biome.id}`, [
    ["wedge", `${view.wedgeDeg}° (${(coneFrac * 100).toFixed(1)}% of shell)`],
    ["chunks", `${placed.length} of ${zoneSpecs.length} total`],
    ["triangles", Math.round(tris).toLocaleString()],
    ["carve time", `${(performance.now() - t0).toFixed(0)} ms`],
    ["blast walls", String(ctx.blastPoints.length)],
    ["fish may enter", biome.fishMayEnter ? "yes" : "no"],
  ]);
}

// Fused/hull biomes: the real lattice tiles inside the wedge cone, with the
// real inter-tile carve network (K4 — you cannot tune claustrophobia on one
// floating part).
async function rebuildLayerWedge(
  token: number,
  biome: BiomeRecipe,
  cosTheta: number,
  coneFrac: number,
): Promise<void> {
  const pl = biome.placement;
  if (pl.mode !== "fused" && pl.mode !== "hull") return;

  let plan: WorldPlan;
  try {
    plan = planWorldLayout(view.seed, view.difficulty, world);
  } catch (err) {
    setHud("invalid recipe", [["error", (err as Error).message, "bad"]]);
    return;
  }
  const tiles = plan.specs.filter((sp) => sp.zone === biome.id);
  let use = tiles.filter((sp) => {
    const len = sp.center.length() || 1;
    return sp.center.z / len >= cosTheta;
  });
  if (!use.length) use = tiles.slice(0, Math.min(6, tiles.length));

  const rng = mulberry32(view.seed >>> 0);
  const ctx: GenCtx = { difficulty: view.difficulty, blastPoints: [] };
  const chunks = buildLayerChunks(rng, use, ctx, {
    loopFrac: pl.mode === "fused" ? pl.loopFrac : 0,
    sideExits: pl.mode === "fused" ? pl.sideExits : 0,
    // WG-16: the REAL spine doors, so the wedge preview shows the door
    // tunnels that will pierce this layer in the full build.
    spineIn:
      pl.mode === "fused" ? nearestSpinePoint(plan.spine, pl.rMax) : null,
    spineOut:
      pl.mode === "fused" ? nearestSpinePoint(plan.spine, pl.rMin) : null,
  });

  const rMid = pl.mode === "fused" ? (pl.rMin + pl.rMax) / 2 : pl.radius;
  const group = new THREE.Group();
  group.position.z = -rMid;
  mount(group);

  const mat = makeSkinMaterial(biome.material);
  let tris = 0;
  const t0 = performance.now();
  for (let i = 0; i < chunks.length; i++) {
    setLoading(`carving tile ${i + 1} / ${chunks.length}…`);
    await tick();
    if (token !== buildToken) return;
    const chunk = chunks[i];
    const mesh = meshChunk(chunk, mat);
    mesh.userData.zone = biome.id;
    chunk.field = null;
    chunk.center = chunk.center.clone().add(group.position);
    benchChunks.push(chunk);
    disposables.push(mesh.geometry);
    tris += mesh.geometry.attributes.position.count / 3;
    group.add(mesh);
  }
  setLoading(null);
  applyWire();
  notePerfBuild("wedge build", performance.now() - t0);

  const sinTheta = Math.sin((view.wedgeDeg * Math.PI) / 180);
  const extent = Math.max(
    pl.mode === "fused" ? pl.rMax - pl.rMin + 40 : pl.thickness + 60,
    1.6 * rMid * sinTheta,
  );
  clipScale = extent * 0.6;
  gridSmall.position.y = -extent * 0.45;
  frameCamera(Math.min(extent * 1.15, 700));

  const part = world.parts.find((p) => p.id === biome.parts[0]?.part);
  setHud(`biome · ${biome.id} (${pl.mode})`, [
    ["wedge", `${view.wedgeDeg}° (${(coneFrac * 100).toFixed(1)}%)`],
    ["tiles", `${use.length} of ${tiles.length} total`],
    ["triangles", Math.round(tris).toLocaleString()],
    ["carve time", `${(performance.now() - t0).toFixed(0)} ms`],
    ["blast walls", String(ctx.blastPoints.length)],
    ...(part
      ? partMetrics(part, biome.sizeBase, biome.res, view.difficulty)
      : []),
    ...measuredClearance(benchChunks),
  ]);
}

// --- Map view (the whole map arranging itself) ---------------------------------

const proxyGeo = new THREE.SphereGeometry(1, 14, 10);
const boxGeo = new THREE.BoxGeometry(2, 2, 2);
const shellGeo = new THREE.SphereGeometry(1, 40, 24);

function rebuildMapProxies(): void {
  const t0 = performance.now();
  // Full data build (~50 ms, no meshing): the plan for the proxies, plus the
  // REAL seeded props / spawn / gold instead of approximations.
  const data = computeWorldData();
  if (!data) {
    setHud("invalid recipe", [["error", dataErr ?? "?", "bad"]]);
    return;
  }
  const plan = data.plan;
  const group = new THREE.Group();

  const zoneMats = new Map<string, THREE.MeshBasicMaterial>();
  const counts = new Map<string, number>();
  for (const biome of world.biomes) {
    const m = new THREE.MeshBasicMaterial({
      color: biome.material.rind,
      wireframe: true,
      transparent: true,
      opacity: biome.placement.mode === "fused" ? 0.2 : 0.45,
    });
    zoneMats.set(biome.id, m);
    disposables.push(m);
    counts.set(biome.id, 0);
  }

  for (const spec of plan.specs) {
    const proxy = new THREE.Mesh(
      spec.body ? boxGeo : proxyGeo,
      zoneMats.get(spec.zone),
    );
    proxy.position.copy(spec.center);
    proxy.scale.setScalar(spec.body ? spec.s : spec.s * R0);
    group.add(proxy);
    counts.set(spec.zone, (counts.get(spec.zone) ?? 0) + 1);
  }

  // Hull silhouettes (the Great Wheel), in the tilted frame.
  const frame = makeFrame(world.frame);
  for (const biome of world.biomes) {
    const pl = biome.placement;
    if (pl.mode !== "hull") continue;
    const m = new THREE.MeshBasicMaterial({
      color: biome.material.rind,
      wireframe: true,
      transparent: true,
      opacity: 0.25,
    });
    disposables.push(m);
    const halfH =
      pl.surface === "sphere" ? pl.radius : pl.radius * (frame?.squash ?? 1);
    const geo =
      pl.surface === "sphere"
        ? shellGeo
        : new THREE.CylinderGeometry(
            pl.radius,
            pl.radius,
            halfH * 2,
            48,
            1,
            false,
          );
    if (pl.surface !== "sphere") disposables.push(geo);
    const sil = new THREE.Mesh(geo, m);
    if (pl.surface === "sphere") sil.scale.setScalar(pl.radius);
    if (frame) sil.rotation.x = -Math.asin(frame.sin);
    group.add(sil);
  }

  // Rings, spine, soft spots, trail, entrance, wreck — shared with the real
  // build view (WG-15).
  const trail = drawMapOverlay(plan, group);

  // Real spawn (data build) + bell glyph + real gold.
  const spawnMat = new THREE.MeshBasicMaterial({ color: 0x66ff99 });
  disposables.push(spawnMat);
  const spawn = new THREE.Mesh(proxyGeo, spawnMat);
  spawn.position.set(data.spawnPoint.x, data.spawnPoint.y, data.spawnPoint.z);
  spawn.scale.setScalar(3);
  group.add(spawn);
  group.add(bellGlyph(data.spawnPoint));
  const goldMat = new THREE.MeshBasicMaterial({ color: 0xffd24a });
  disposables.push(goldMat);
  const gold = new THREE.Mesh(proxyGeo, goldMat);
  gold.position.set(data.goldPos.x, data.goldPos.y, data.goldPos.z);
  gold.scale.setScalar(3);
  group.add(gold);

  mount(group);
  frameCamera(world.worldR * 2.05);
  clipScale = world.worldR;

  const planMs = performance.now() - t0;
  notePerfBuild("map data build", planMs);
  const props = drawProps(plan.props);
  const lines: HudLine[] = [
    ["chunks", String(plan.specs.length)],
    ["planned in", `${planMs.toFixed(0)} ms`],
  ];
  if (plan.spine.length)
    lines.push(["spine", plan.spine.map((p) => p.r.toFixed(0)).join(" → ")]);
  if (trail)
    lines.push([
      "trail",
      `${trail.linked} linked, ${trail.orphans} orphans, ` +
        `entrance ${trail.reachesEntrance ? "✓" : "✗"}`,
      trail.reachesEntrance && trail.orphans <= 3 ? "ok" : "bad",
    ]);
  lines.push(...propHudLines(props));
  for (const biome of world.biomes)
    lines.push([biome.id, String(counts.get(biome.id) ?? 0)]);
  setMapHud("map · layout proxies", lines);
  startVerify(plan);
}

async function buildRealWorld(): Promise<void> {
  disposeContent();
  const token = buildToken;
  gridLarge.visible = false;

  // Optional res downshift so full-world iteration stays quick.
  const buildWorld = cloneWorld(world);
  if (view.buildHalfRes)
    for (const biome of buildWorld.biomes)
      biome.res = HALF_RES[biome.res] ?? 32;

  const t0 = performance.now();
  try {
    await buildGoudaWorld(
      scene,
      (done, total, label) => setLoading(`${done}/${total} · ${label}`),
      { seed: view.seed, difficulty: view.difficulty, world: buildWorld },
    );
  } catch (err) {
    setLoading(null);
    setHud("invalid recipe", [["error", (err as Error).message, "bad"]]);
    return;
  }
  if (token !== buildToken) {
    // A newer rebuild superseded this one mid-build; tear down our world.
    disposeWorld(scene);
    return;
  }
  view.built = true;
  setLoading(null);
  clipScale = world.worldR;
  const buildMs = performance.now() - t0;
  notePerfBuild("world build", buildMs);
  syncUrl(); // &build=1 — a built find is shareable (WG-17a)

  // Overlay over the real build: same ladder/spine/trail/doors as proxies
  // (WG-15) — re-planned from the recipe the build actually used, so the
  // markers land on the meshed geometry.
  const markers = new THREE.Group();
  const plan = planWorldLayout(view.seed, view.difficulty, buildWorld);
  const trail = drawMapOverlay(plan, markers);

  const gold = getGoldPos();
  if (gold) {
    const m = new THREE.MeshBasicMaterial({ color: 0xffd24a });
    disposables.push(m);
    const g = new THREE.Mesh(proxyGeo, m);
    g.position.set(gold.x, gold.y, gold.z);
    g.scale.setScalar(3);
    markers.add(g);
  }
  const spawnMat = new THREE.MeshBasicMaterial({ color: 0x66ff99 });
  disposables.push(spawnMat);
  const sp = getSpawnPoint();
  const spawn = new THREE.Mesh(proxyGeo, spawnMat);
  spawn.position.set(sp.x, sp.y, sp.z);
  spawn.scale.setScalar(3);
  markers.add(spawn);
  markers.add(bellGlyph(sp));
  mount(markers);

  const props = drawProps(getSeededProps());
  const lines: HudLine[] = [
    ["seed / diff", `${view.seed} / d${view.difficulty}`],
    ["res", view.buildHalfRes ? "half" : "full"],
    ["built in", `${(buildMs / 1000).toFixed(1)} s`],
    [
      "gold",
      gold
        ? `${gold.x.toFixed(0)}, ${gold.y.toFixed(0)}, ${gold.z.toFixed(0)}`
        : "—",
    ],
    ["gold radius", gold ? Math.hypot(gold.x, gold.y, gold.z).toFixed(0) : "—"],
  ];
  if (trail)
    lines.push([
      "trail",
      `${trail.linked} linked, ${trail.orphans} orphans, ` +
        `entrance ${trail.reachesEntrance ? "✓" : "✗"}`,
      trail.reachesEntrance && trail.orphans <= 3 ? "ok" : "bad",
    ]);
  lines.push(...propHudLines(props), ["walk it", "press F"]);
  setMapHud("map · real build", lines);
  startVerify(plan);
}

// --- Copy helpers ------------------------------------------------------------------

function copyButton(
  parent: HTMLElement,
  label: string,
  payload: () => unknown,
): void {
  button(parent, label, (b) => {
    void navigator.clipboard.writeText(JSON.stringify(payload(), null, 2));
    const old = b.textContent;
    b.textContent = "copied!";
    setTimeout(() => (b.textContent = old), 900);
  });
}

// --- Tool panel --------------------------------------------------------------------

const int = (v: number) => v.toFixed(0);

// A min/max pair that keeps min ≤ max while dragging either.
function rangePair(
  parent: HTMLElement,
  labelMin: string,
  labelMax: string,
  min: number,
  max: number,
  step: number,
  get: () => { a: number; b: number },
  set: (a: number, b: number) => void,
  fmt?: (v: number) => string,
): void {
  const hi = { set: (_v: number) => {} };
  const lo = sliderRow(
    parent,
    labelMin,
    min,
    max,
    step,
    get().a,
    (v) => {
      const { b } = get();
      const nb = Math.max(v, b);
      set(v, nb);
      if (nb !== b) hi.set(nb);
    },
    fmt,
  );
  const hiHandle = sliderRow(
    parent,
    labelMax,
    min,
    max,
    step,
    get().b,
    (v) => {
      const { a } = get();
      const na = Math.min(v, a);
      set(na, v);
      if (na !== a) lo.set(na);
    },
    fmt,
  );
  hi.set = (v) => hiHandle.set(v);
}

function buildGenerateUI(): void {
  const panel = $("generate");
  panel.innerHTML = "";
  const gen = section(panel, "Generate").parentElement!;
  const row = gen.querySelector(".row") as HTMLElement;
  const seedField = numRow(gen, "seed", view.seed, (v) => {
    view.seed = v >>> 0;
    scheduleRebuild(0);
  });
  button(row, "reroll", () => {
    view.seed = (Math.random() * 4294967296) >>> 0;
    seedField.set(view.seed);
    scheduleRebuild(0);
  });
  const diffBtns: Record<string, HTMLButtonElement> = {};
  for (const d of [1, 2, 3])
    diffBtns[d] = button(row, `d${d}`, () => {
      view.difficulty = d;
      markOn(diffBtns, String(d));
      scheduleRebuild(0);
    });
  markOn(diffBtns, String(view.difficulty));

  if (view.mode === "part") {
    const part = currentPart();
    sliderRow(
      gen,
      "size u",
      4,
      120,
      1,
      view.partSize || (part.size.min + part.size.max) / 2,
      (v) => {
        view.partSize = v;
        scheduleRebuild();
      },
      int,
    );
    const resBtns: Record<string, HTMLButtonElement> = {};
    for (const r of RES_CHOICES)
      resBtns[r] = button(row, `${r}³`, () => {
        view.partRes = r;
        markOn(resBtns, String(r));
        scheduleRebuild(0);
      });
    markOn(resBtns, String(view.partRes));
  } else if (view.mode === "biome") {
    sliderRow(
      gen,
      "wedge °",
      15,
      70,
      1,
      view.wedgeDeg,
      (v) => {
        view.wedgeDeg = v;
        scheduleRebuild();
      },
      int,
    );
  }
}

function moodLine(parent: HTMLElement, text: string): void {
  if (!text) return;
  const div = document.createElement("div");
  div.className = "mood";
  div.textContent = `“${text}”`;
  parent.appendChild(div);
}

function buildSubjectUI(): void {
  const panel = $("subject");
  panel.innerHTML = "";

  if (view.mode === "part") {
    const part = currentPart();
    const box = section(panel, "Part").parentElement!;
    const row = box.querySelector(".row") as HTMLElement;
    selectRow(
      box,
      "part",
      world.parts.map((p) => ({ value: p.id, label: p.label || p.id })),
      part.id,
      (id) => {
        view.partId = id;
        view.partSize = 0;
        buildToolUI();
        scheduleRebuild(0);
      },
    );
    button(row, "+ duplicate", () => {
      const id = prompt("new part id", `${part.id}-2`)?.trim();
      if (!id || world.parts.some((p) => p.id === id)) return;
      const clone = structuredClone(part);
      clone.id = id;
      clone.label = id.replace(/-/g, " ");
      world.parts.push(clone);
      view.partId = id;
      view.partSize = 0;
      save();
      buildToolUI();
      scheduleRebuild(0);
    });
    button(row, "delete", () => {
      const users = world.biomes.filter((b) =>
        b.parts.some((e) => e.part === part.id),
      );
      if (users.length)
        return alert(`in use by: ${users.map((b) => b.id).join(", ")}`);
      if (world.parts.length === 1 || !confirm(`delete part "${part.id}"?`))
        return;
      world.parts.splice(world.parts.indexOf(part), 1);
      view.partId = world.parts[0].id;
      view.partSize = 0;
      save();
      buildToolUI();
      scheduleRebuild(0);
    });
    moodLine(panel, part.mood);
  } else if (view.mode === "biome") {
    const biome = currentBiome();
    const box = section(panel, "Biome").parentElement!;
    selectRow(
      box,
      "biome",
      world.biomes.map((b) => ({
        value: b.id,
        label: `${b.id} · ${b.placement.mode}`,
      })),
      biome.id,
      (id) => {
        view.biomeId = id;
        buildToolUI();
        scheduleRebuild(0);
      },
    );
    moodLine(panel, biome.mood);
  }
}

// --- Category tabs -------------------------------------------------------------------

const CATS: Record<Mode, { id: string; label: string }[]> = {
  part: [
    { id: "shape", label: "shape" },
    { id: "carve", label: "carve" },
    { id: "tunnels", label: "tunnels" },
    { id: "look", label: "look" },
    { id: "info", label: "info" },
  ],
  biome: [
    { id: "place", label: "place" },
    { id: "mix", label: "mix" },
    { id: "wax", label: "wax" },
    { id: "game", label: "game" },
    { id: "info", label: "info" },
  ],
  map: [
    { id: "world", label: "world" },
    { id: "layers", label: "layers" },
    { id: "props", label: "props" },
    { id: "build", label: "build" },
  ],
};

function buildCatTabs(): void {
  const bar = $("cats");
  bar.innerHTML = "";
  const catBtns: Record<string, HTMLButtonElement> = {};
  for (const cat of CATS[view.mode])
    catBtns[cat.id] = button(bar, cat.label, () => {
      view.cat[view.mode] = cat.id;
      markOn(catBtns, cat.id);
      buildCatBody();
    });
  if (!CATS[view.mode].some((c) => c.id === view.cat[view.mode]))
    view.cat[view.mode] = CATS[view.mode][0].id;
  markOn(catBtns, view.cat[view.mode]);
}

function buildCatBody(): void {
  const panel = $("cat-body");
  panel.innerHTML = "";
  const cat = view.cat[view.mode];
  if (view.mode === "part") buildPartCat(panel, cat);
  else if (view.mode === "biome") buildBiomeCat(panel, cat);
  else buildMapCat(panel, cat);
}

// --- Part categories --------------------------------------------------------------

function buildPartCat(panel: HTMLElement, cat: string): void {
  const part = currentPart();

  if (cat === "shape") {
    const shape = section(panel, "Shape family");
    const kindBtns: Record<string, HTMLButtonElement> = {};
    for (const k of KINDS)
      kindBtns[k] = button(shape, k, () =>
        edit(() => {
          part.kind = k;
          markOn(kindBtns, k);
        }, 0),
      );
    markOn(kindBtns, part.kind);
    const shapeBox = shape.parentElement!;
    rangePair(
      shapeBox,
      "size min",
      "size max",
      4,
      120,
      1,
      () => ({ a: part.size.min, b: part.size.max }),
      (a, b) =>
        edit(() => {
          part.size.min = a;
          part.size.max = b;
        }),
      int,
    );
    const crust = section(panel, "Crust").parentElement!;
    sliderRow(crust, "noise amp", 0, 0.2, 0.002, part.crust.amp, (v) =>
      edit(() => (part.crust.amp = v)),
    );
    sliderRow(crust, "noise freq", 0.4, 4, 0.05, part.crust.freq, (v) =>
      edit(() => (part.crust.freq = v)),
    );
    sliderRow(crust, "depth", 0.05, 0.4, 0.01, part.crust.depth, (v) =>
      edit(() => (part.crust.depth = v)),
    );
    const seal = section(panel, "Seal (hull tiles)").parentElement!;
    sliderRow(
      seal,
      "no-carve u",
      0,
      6,
      0.5,
      part.noCarveWithin ?? 0,
      (v) =>
        edit(() => {
          if (v <= 0) delete part.noCarveWithin;
          else part.noCarveWithin = v;
        }, 0),
      (v) => (v <= 0 ? "off" : v.toFixed(1)),
    );
    return;
  }

  if (cat === "carve") {
    const eyes = section(panel, "Eyes (caverns)").parentElement!;
    rangePair(
      eyes,
      "count min",
      "count max",
      0,
      40,
      1,
      () => ({ a: part.eyes.min, b: part.eyes.max }),
      (a, b) =>
        edit(() => {
          part.eyes.min = a;
          part.eyes.max = b;
        }),
      int,
    );
    sliderRow(eyes, "radius", 0, 0.35, 0.005, part.eyes.rBase, (v) =>
      edit(() => (part.eyes.rBase = v)),
    );
    sliderRow(eyes, "radius var", 0, 0.35, 0.005, part.eyes.rVar, (v) =>
      edit(() => (part.eyes.rVar = v)),
    );
    sliderRow(eyes, "core eye", 0, 0.5, 0.01, part.coreEye, (v) =>
      edit(() => (part.coreEye = v)),
    );

    const rooms = section(panel, "Chambers (rare rooms)").parentElement!;
    const roomsRow = rooms.querySelector(".row") as HTMLElement;
    const roomsBtn = button(roomsRow, part.chambers ? "on" : "off", (b) =>
      edit(() => {
        if (part.chambers) {
          delete part.chambers;
          b.textContent = "off";
          b.classList.remove("on");
        } else {
          part.chambers = { chance: 0.12, rBase: 0.25, rVar: 0.08 };
          b.textContent = "on";
          b.classList.add("on");
        }
        buildCatBody();
      }, 0),
    );
    roomsBtn.classList.toggle("on", !!part.chambers);
    if (part.chambers) {
      const ch = part.chambers;
      sliderRow(rooms, "chance", 0, 1, 0.02, ch.chance, (v) =>
        edit(() => (ch.chance = v)),
      );
      sliderRow(rooms, "radius", 0.1, 0.45, 0.01, ch.rBase, (v) =>
        edit(() => (ch.rBase = v)),
      );
      sliderRow(rooms, "radius var", 0, 0.2, 0.01, ch.rVar, (v) =>
        edit(() => (ch.rVar = v)),
      );
    }

    const pores = section(panel, "Pores (surface holes)").parentElement!;
    rangePair(
      pores,
      "count min",
      "count max",
      0,
      40,
      1,
      () => ({ a: part.pores.min, b: part.pores.max }),
      (a, b) =>
        edit(() => {
          part.pores.min = a;
          part.pores.max = b;
        }),
      int,
    );
    sliderRow(pores, "radius", 0, 0.15, 0.002, part.pores.rBase, (v) =>
      edit(() => (part.pores.rBase = v)),
    );
    sliderRow(pores, "radius var", 0, 0.15, 0.002, part.pores.rVar, (v) =>
      edit(() => (part.pores.rVar = v)),
    );
    return;
  }

  if (cat === "tunnels") {
    const tun = section(panel, "Tunnels").parentElement!;
    const tunRow = tun.querySelector(".row") as HTMLElement;
    sliderRow(tun, "radius", 0, 0.15, 0.002, part.tunnels.rBase, (v) =>
      edit(() => (part.tunnels.rBase = v)),
    );
    sliderRow(tun, "radius var", 0, 0.1, 0.002, part.tunnels.rVar, (v) =>
      edit(() => (part.tunnels.rVar = v)),
    );
    sliderRow(
      tun,
      "tortuosity",
      0,
      3,
      1,
      part.tunnels.bends,
      (v) => edit(() => (part.tunnels.bends = v)),
      int,
    );
    sliderRow(
      tun,
      "exits",
      0,
      8,
      1,
      part.exits,
      (v) => edit(() => (part.exits = v)),
      int,
    );
    sliderRow(
      tun,
      "dead ends",
      0,
      6,
      1,
      part.deadEnds,
      (v) => edit(() => (part.deadEnds = v)),
      int,
    );
    const narrowBtn = button(tunRow, "narrow", (b) =>
      edit(() => {
        part.narrow = !part.narrow;
        b.classList.toggle("on", part.narrow);
      }, 0),
    );
    narrowBtn.classList.toggle("on", part.narrow);
    const tangleBtn = button(tunRow, "tangle", (b) =>
      edit(() => {
        part.tangle = !part.tangle;
        b.classList.toggle("on", part.tangle);
      }, 0),
    );
    tangleBtn.classList.toggle("on", part.tangle);
    return;
  }

  if (cat === "look") {
    const skin = section(panel, "Skin (biome wax)");
    const skinBtns: Record<string, HTMLButtonElement> = {};
    for (const b of world.biomes)
      skinBtns[b.id] = button(skin, b.id, () => {
        view.skinBiomeId = b.id;
        markOn(skinBtns, b.id);
        refreshSkin();
      });
    markOn(skinBtns, view.skinBiomeId);
    return;
  }

  // info: mood/desc + the gameplay axes
  const axes = section(panel, "Axes (gameplay)").parentElement!;
  const axesRow = axes.querySelector(".row") as HTMLElement;
  const hardBtns: Record<string, HTMLButtonElement> = {};
  const HARD_LABELS = ["0 hands", "1 driller", "2 slow", "3 no-dig"];
  for (const [h, lbl] of HARD_LABELS.entries())
    hardBtns[h] = button(axesRow, lbl, () =>
      edit(() => {
        part.hardness = h as Hardness;
        markOn(hardBtns, String(h));
      }, 0),
    );
  markOn(hardBtns, String(part.hardness));

  const text = section(panel, "Mood & description").parentElement!;
  textRow(
    text,
    "mood",
    part.mood,
    (v) => {
      part.mood = v;
      save();
      buildSubjectUI();
    },
    2,
  );
  textRow(
    text,
    "description",
    part.desc,
    (v) => {
      part.desc = v;
      save();
    },
    5,
  );
}

// --- Biome categories ---------------------------------------------------------------

function buildBiomeCat(panel: HTMLElement, cat: string): void {
  const biome = currentBiome();
  const pl = biome.placement;

  if (cat === "place") {
    const place = section(panel, `Placement · ${pl.mode}`).parentElement!;
    if (pl.mode === "band") {
      rangePair(
        place,
        "band from",
        "band to",
        10,
        520,
        1,
        () => ({ a: pl.rMin, b: pl.rMax }),
        (a, b) =>
          edit(() => {
            pl.rMin = a;
            pl.rMax = b;
          }),
        int,
      );
      sliderRow(
        place,
        "count",
        0,
        200,
        1,
        pl.count,
        (v) => edit(() => (pl.count = v)),
        int,
      );
      sliderRow(place, "spacing", 0, 2, 0.05, pl.guard, (v) =>
        edit(() => (pl.guard = v)),
      );
      const gradeRow = place.querySelector(".row") as HTMLElement;
      const gradeBtns: Record<string, HTMLButtonElement> = {};
      for (const g of ["none", "outward", "inward"])
        gradeBtns[g] = button(gradeRow, `den ${g}`, () =>
          edit(() => {
            if (g === "none") delete pl.densityGrade;
            else pl.densityGrade = g as "outward" | "inward";
            markOn(gradeBtns, g);
          }, 0),
        );
      markOn(gradeBtns, pl.densityGrade ?? "none");
      const sizeBtns: Record<string, HTMLButtonElement> = {};
      for (const g of ["none", "outward", "inward"])
        sizeBtns[g] = button(gradeRow, `size ${g}`, () =>
          edit(() => {
            if (g === "none") delete pl.sizeGrade;
            else pl.sizeGrade = g as "outward" | "inward";
            markOn(sizeBtns, g);
          }, 0),
        );
      markOn(sizeBtns, pl.sizeGrade ?? "none");
      const sightBtn = button(gradeRow, "sightline", (b) =>
        edit(() => {
          if (pl.sightline) delete pl.sightline;
          else pl.sightline = true;
          b.classList.toggle("on", !!pl.sightline);
        }, 0),
      );
      sightBtn.classList.toggle("on", !!pl.sightline);
      sliderRow(
        place,
        "rotate °/s",
        0,
        3,
        0.1,
        pl.rotate?.degPerSec ?? 0,
        (v) =>
          edit(() => {
            if (v <= 0) delete pl.rotate;
            else pl.rotate = { degPerSec: v };
          }),
        (v) => (v <= 0 ? "off" : v.toFixed(1)),
      );
    } else if (pl.mode === "fused") {
      rangePair(
        place,
        "band from",
        "band to",
        4,
        400,
        1,
        () => ({ a: pl.rMin, b: pl.rMax }),
        (a, b) =>
          edit(() => {
            pl.rMin = a;
            pl.rMax = b;
          }),
        int,
      );
      sliderRow(place, "warp amp", 0, 12, 0.5, pl.warpAmp, (v) =>
        edit(() => (pl.warpAmp = v)),
      );
      sliderRow(place, "warp freq", 0.005, 0.1, 0.005, pl.warpFreq, (v) =>
        edit(() => (pl.warpFreq = v)),
      );
      sliderRow(place, "loop frac", 0, 1, 0.05, pl.loopFrac, (v) =>
        edit(() => (pl.loopFrac = v)),
      );
      sliderRow(
        place,
        "side exits",
        0,
        6,
        1,
        pl.sideExits,
        (v) => edit(() => (pl.sideExits = v)),
        int,
      );
    } else if (pl.mode === "hull") {
      sliderRow(
        place,
        "radius",
        40,
        400,
        1,
        pl.radius,
        (v) => edit(() => (pl.radius = v)),
        int,
      );
      sliderRow(place, "thickness", 2, 30, 0.5, pl.thickness, (v) =>
        edit(() => (pl.thickness = v)),
      );
      sliderRow(
        place,
        "rim round",
        2,
        60,
        1,
        pl.rim,
        (v) => edit(() => (pl.rim = v)),
        int,
      );
      sliderRow(
        place,
        "soft spots",
        0,
        3,
        1,
        pl.softSpots,
        (v) => edit(() => (pl.softSpots = v)),
        int,
      );
      sliderRow(place, "spot radius", 2, 20, 0.5, pl.softSpotR, (v) =>
        edit(() => (pl.softSpotR = v)),
      );
      sliderRow(place, "ridge amp", 0, 2, 0.05, pl.ridgeAmp, (v) =>
        edit(() => (pl.ridgeAmp = v)),
      );
      sliderRow(place, "ridge freq", 0.05, 2, 0.05, pl.ridgeFreq, (v) =>
        edit(() => (pl.ridgeFreq = v)),
      );
      sliderRow(
        place,
        "entrance r",
        0,
        3,
        0.1,
        pl.entrance?.r ?? 0,
        (v) =>
          edit(() => {
            if (v < 1.4)
              delete pl.entrance; // the ≥1.4 u cargo law
            else pl.entrance = { r: v };
          }),
        (v) => (v < 1.4 ? "off" : v.toFixed(1)),
      );
    }

    const sizing = section(panel, "Tiles & resolution").parentElement!;
    sliderRow(
      sizing,
      "size base",
      4,
      120,
      1,
      biome.sizeBase,
      (v) => edit(() => (biome.sizeBase = v)),
      int,
    );
    if (pl.mode !== "fused" && pl.mode !== "hull")
      sliderRow(
        sizing,
        "size var",
        0,
        40,
        1,
        biome.sizeVar,
        (v) => edit(() => (biome.sizeVar = v)),
        int,
      );
    const sizingRow = sizing.querySelector(".row") as HTMLElement;
    const resBtns: Record<string, HTMLButtonElement> = {};
    for (const r of RES_CHOICES)
      resBtns[r] = button(sizingRow, `${r}³`, () =>
        edit(() => {
          biome.res = r;
          markOn(resBtns, String(r));
        }, 0),
      );
    markOn(resBtns, String(biome.res));
    return;
  }

  if (cat === "mix") {
    const mix = section(panel, "Part mix (weights)").parentElement!;
    const mixRow = mix.querySelector(".row") as HTMLElement;
    for (const entry of biome.parts)
      sliderRow(mix, entry.part, 0, 8, 0.25, entry.weight, (v) =>
        edit(() => (entry.weight = v)),
      );
    for (const p of world.parts) {
      const has = biome.parts.some((e) => e.part === p.id);
      button(mixRow, `${has ? "−" : "+"} ${p.id}`, () => {
        if (has) {
          if (biome.parts.length === 1) return alert("a biome needs ≥1 part");
          edit(() => {
            biome.parts = biome.parts.filter((e) => e.part !== p.id);
          }, 0);
        } else {
          edit(() => biome.parts.push({ part: p.id, weight: 1 }), 0);
        }
        buildCatBody();
      });
    }
    return;
  }

  if (cat === "wax") {
    const wax = section(panel, "Wax material").parentElement!;
    colorRow(wax, "rind", biome.material.rind, (hex) =>
      editSkin(() => (biome.material.rind = hex)),
    );
    colorRow(wax, "paste", biome.material.paste, (hex) =>
      editSkin(() => (biome.material.paste = hex)),
    );
    const vein = biome.material.vein;
    for (const [i, ch] of (["vein r", "vein g", "vein b"] as const).entries())
      sliderRow(wax, ch, 0, 1, 0.01, vein[i], (v) =>
        editSkin(() => (vein[i] = v)),
      );
    sliderRow(
      wax,
      "vein glow",
      0,
      1.5,
      0.05,
      biome.material.veinStrength,
      (v) => editSkin(() => (biome.material.veinStrength = v)),
    );
    // WG-13: glow from the baked edge attribute instead of interior noise.
    // Remesh, not just re-skin — the attribute is baked at extraction.
    const waxRow = wax.querySelector(".row") as HTMLElement;
    const edgeBtn = button(waxRow, "edge veins", (b) =>
      edit(() => {
        if (biome.material.edgeVeins) delete biome.material.edgeVeins;
        else biome.material.edgeVeins = true;
        b.classList.toggle("on", !!biome.material.edgeVeins);
      }, 0),
    );
    edgeBtn.classList.toggle("on", !!biome.material.edgeVeins);
    return;
  }

  if (cat === "game") {
    biome.budgets ??= { airPockets: 0, softSpots: 0 };
    biome.modifiers ??= {
      lightRange: 1,
      fogDensity: 1,
      drag: 1,
      soundOcclusion: 0.3,
    };
    const bud = biome.budgets;
    const mod = biome.modifiers;
    const flags = section(panel, "Flags").parentElement!;
    const flagsRow = flags.querySelector(".row") as HTMLElement;
    const fishBtn = button(flagsRow, "fish may enter", (b) => {
      biome.fishMayEnter = !biome.fishMayEnter;
      b.classList.toggle("on", biome.fishMayEnter);
      save();
    });
    fishBtn.classList.toggle("on", biome.fishMayEnter);

    const budgets = section(panel, "Budgets (seeded props)").parentElement!;
    const budgetsRow = budgets.querySelector(".row") as HTMLElement;
    sliderRow(
      budgets,
      "air pockets",
      0,
      12,
      1,
      bud.airPockets,
      (v) => {
        bud.airPockets = v;
        save();
      },
      int,
    );
    sliderRow(
      budgets,
      "soft spots",
      0,
      3,
      1,
      bud.softSpots,
      (v) => {
        bud.softSpots = v;
        save();
      },
      int,
    );
    const hazBtn = button(budgetsRow, "hazards", (b) => {
      if (bud.hazards) delete bud.hazards;
      else bud.hazards = { meltFalls: 12, meltPools: 6, vents: 8 };
      b.classList.toggle("on", !!bud.hazards);
      save();
      buildCatBody();
    });
    hazBtn.classList.toggle("on", !!bud.hazards);
    if (bud.hazards) {
      const haz = bud.hazards;
      sliderRow(
        budgets,
        "melt falls",
        0,
        24,
        1,
        haz.meltFalls,
        (v) => {
          haz.meltFalls = v;
          save();
        },
        int,
      );
      sliderRow(
        budgets,
        "melt pools",
        0,
        12,
        1,
        haz.meltPools,
        (v) => {
          haz.meltPools = v;
          save();
        },
        int,
      );
      sliderRow(
        budgets,
        "vents",
        0,
        12,
        1,
        haz.vents,
        (v) => {
          haz.vents = v;
          save();
        },
        int,
      );
    }

    const mods = section(panel, "Modifiers (senses)").parentElement!;
    sliderRow(mods, "light ×", 0.1, 2, 0.05, mod.lightRange, (v) => {
      mod.lightRange = v;
      save();
    });
    sliderRow(mods, "fog ×", 0.2, 4, 0.1, mod.fogDensity, (v) => {
      mod.fogDensity = v;
      save();
    });
    sliderRow(mods, "drag ×", 0.5, 2.5, 0.05, mod.drag, (v) => {
      mod.drag = v;
      save();
    });
    sliderRow(mods, "occlusion", 0, 1, 0.05, mod.soundOcclusion, (v) => {
      mod.soundOcclusion = v;
      save();
    });
    return;
  }

  // info
  const text = section(panel, "Mood & description").parentElement!;
  textRow(
    text,
    "mood",
    biome.mood,
    (v) => {
      biome.mood = v;
      save();
      buildSubjectUI();
    },
    2,
  );
  textRow(
    text,
    "description",
    biome.desc,
    (v) => {
      biome.desc = v;
      save();
    },
    5,
  );
}

// --- Map categories -------------------------------------------------------------------

function buildMapCat(panel: HTMLElement, cat: string): void {
  if (cat === "world") {
    const w = section(panel, "World").parentElement!;
    sliderRow(
      w,
      "world R",
      200,
      620,
      2,
      world.worldR,
      (v) => edit(() => (world.worldR = v)),
      int,
    );
    sliderRow(
      w,
      "boundary R",
      220,
      720,
      2,
      world.boundaryR,
      (v) => edit(() => (world.boundaryR = v)),
      int,
    );
    rangePair(
      w,
      "gold from",
      "gold to",
      0,
      400,
      2,
      () => ({ a: world.goldBand.min, b: world.goldBand.max }),
      (a, b) =>
        edit(() => {
          world.goldBand.min = a;
          world.goldBand.max = b;
        }),
      int,
    );
    sliderRow(
      w,
      "debris",
      0,
      1200,
      20,
      world.debrisCount,
      (v) => edit(() => (world.debrisCount = v)),
      int,
    );
    sliderRow(w, "heart guard", 0, 1.5, 0.02, world.heartGuard, (v) =>
      edit(() => (world.heartGuard = v)),
    );

    if (world.frame) {
      const f = world.frame;
      const fr = section(panel, "Frame (the wheel lie)").parentElement!;
      sliderRow(fr, "squash", 0.2, 1, 0.01, f.squash, (v) =>
        edit(() => (f.squash = v)),
      );
      sliderRow(
        fr,
        "tilt °",
        0,
        45,
        1,
        f.tiltDeg,
        (v) => edit(() => (f.tiltDeg = v)),
        int,
      );
    }
    if (world.spine) {
      const sp = world.spine;
      const sec = section(panel, "Spine (descent route)").parentElement!;
      rangePair(
        sec,
        "step min °",
        "step max °",
        10,
        140,
        2,
        () => ({ a: sp.stepDeg.min, b: sp.stepDeg.max }),
        (a, b) =>
          edit(() => {
            sp.stepDeg.min = a;
            sp.stepDeg.max = b;
          }),
        int,
      );
      sliderRow(sec, "down drift", 0, 1, 0.05, sp.drift, (v) =>
        edit(() => (sp.drift = v)),
      );
    }
    return;
  }

  if (cat === "layers") {
    for (const biome of world.biomes) {
      const pl = biome.placement;
      if (pl.mode === "center") continue;
      const box = section(panel, `· ${biome.id} (${pl.mode})`).parentElement!;
      if (pl.mode === "band" || pl.mode === "fused") {
        rangePair(
          box,
          "from",
          "to",
          4,
          620,
          1,
          () => ({ a: pl.rMin, b: pl.rMax }),
          (a, b) =>
            edit(() => {
              pl.rMin = a;
              pl.rMax = b;
            }),
          int,
        );
        if (pl.mode === "band")
          sliderRow(
            box,
            "count",
            0,
            200,
            1,
            pl.count,
            (v) => edit(() => (pl.count = v)),
            int,
          );
      } else {
        sliderRow(
          box,
          "radius",
          20,
          400,
          1,
          pl.radius,
          (v) => edit(() => (pl.radius = v)),
          int,
        );
        sliderRow(box, "thickness", 2, 30, 0.5, pl.thickness, (v) =>
          edit(() => (pl.thickness = v)),
        );
      }
      sliderRow(
        box,
        "size base",
        4,
        120,
        1,
        biome.sizeBase,
        (v) => edit(() => (biome.sizeBase = v)),
        int,
      );
    }
    return;
  }

  if (cat === "props") {
    // WG-11 marker overlay: per-kind toggles; the HUD carries count vs
    // budget. Proxies mode seeds from a fresh data build, built mode from
    // the world that is actually mounted.
    const box = section(panel, "Seeded props (WG-11)").parentElement!;
    const row = box.querySelector(".row") as HTMLElement;
    const KIND_LABELS: [SeededPropKind, string][] = [
      ["airPocket", "air pockets"],
      ["melt_fall", "melt falls"],
      ["melt_pool", "melt pools"],
      ["thermal_vent", "vents"],
      ["wreck", "wreck"],
    ];
    for (const [kind, label] of KIND_LABELS) {
      const btn = button(row, label, (b) => {
        view.propKinds[kind] = !view.propKinds[kind];
        b.classList.toggle("on", view.propKinds[kind]);
        // Built worlds only redraw the overlay — never tear down the build.
        if (view.built) drawProps(getSeededProps());
        else scheduleRebuild(0);
      });
      btn.classList.toggle("on", view.propKinds[kind]);
    }
    moodLine(
      box,
      "positions are seeded by the generator — same seed, same list on every client",
    );
    return;
  }

  // build
  const build = section(panel, "Real build");
  const meshBtn = button(build, "mesh the world", (b) => {
    if (view.built) {
      b.classList.remove("on");
      b.textContent = "mesh the world";
      scheduleRebuild(0); // back to proxies
    } else {
      b.classList.add("on");
      b.textContent = "back to proxies";
      void buildRealWorld();
    }
  });
  meshBtn.classList.toggle("on", view.built);
  const halfBtn = button(build, "half res", (b) => {
    view.buildHalfRes = !view.buildHalfRes;
    b.classList.toggle("on", view.buildHalfRes);
  });
  halfBtn.classList.toggle("on", view.buildHalfRes);
  const errors = validateWorld(world);
  if (errors.length) {
    const box = section(build.parentElement!, "Rule violations").parentElement!;
    for (const e of errors) {
      const div = document.createElement("div");
      div.className = "mood";
      div.style.borderLeftColor = "#b91c1c";
      div.style.color = "#f8b4b4";
      div.style.fontStyle = "normal";
      div.textContent = e;
      box.appendChild(div);
    }
  }
}

// --- Panel assembly --------------------------------------------------------------------

// WG-17a: the URL always names the exact thing on screen — world, subject,
// seed, difficulty, build — so a rerolled find is shareable by copy-paste.
function syncUrl(): void {
  const q = new URLSearchParams();
  q.set("world", store.active);
  if (view.mode === "part") q.set("part", view.partId);
  else if (view.mode === "biome") q.set("biome", view.biomeId);
  else {
    q.set("map", "1");
    if (view.built) q.set("build", "1");
  }
  q.set("seed", String(view.seed));
  if (view.difficulty !== 1) q.set("d", String(view.difficulty));
  history.replaceState(null, "", `?${q}`);
}

function buildToolUI(): void {
  buildGenerateUI();
  buildSubjectUI();
  buildCatTabs();
  buildCatBody();
  markOn(modeBtns, view.mode);
  // Each mode keeps its own fog density (very different camera distances).
  fogSlider.set(view.fog[view.mode]);
  if (scene.fog) (scene.fog as THREE.FogExp2).density = view.fog[view.mode];
  syncUrl();
}

function switchWorld(key: string): void {
  if (!store.worlds[key]) return;
  store.active = key;
  world = store.worlds[key];
  view.partId = world.parts[0].id;
  view.partSize = 0;
  view.biomeId = world.biomes[0].id;
  view.skinBiomeId = world.biomes[0].id;
  save();
  buildToolUI();
  scheduleRebuild(0);
}

// --- Perf HUD (WG-18) -------------------------------------------------------------

const perf = {
  on: true,
  frames: 0,
  timeAcc: 0,
  fps: 0,
  lastBuildLabel: "last build",
  lastBuildMs: 0,
};

function notePerfBuild(label: string, ms: number): void {
  perf.lastBuildLabel = label;
  perf.lastBuildMs = ms;
}

const fmtTris = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(0)}k`
      : String(Math.round(n));

// Rebuilt every refresh tick (2 Hz): renderer.info plus a scene triangle
// census grouped by the zone tag every world/bench mesh carries.
function refreshPerfHud(): void {
  const el = $("perf");
  if (!perf.on) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  const info = renderer.info;
  const byZone = new Map<string, number>();
  let total = 0;
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    const geo = m.geometry as THREE.BufferGeometry | undefined;
    if (!geo?.attributes?.position) return;
    const tris =
      (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    total += tris;
    const zone = m.userData.zone as string | undefined;
    if (zone) byZone.set(zone, (byZone.get(zone) ?? 0) + tris);
  });
  const lines: [string, string][] = [
    ["fps", perf.fps.toFixed(0)],
    ["draw calls", String(info.render.calls)],
    ["tris drawn", fmtTris(info.render.triangles)],
    ["tris in scene", fmtTris(total)],
    ["programs", String(info.programs?.length ?? 0)],
    ["geom / tex", `${info.memory.geometries} / ${info.memory.textures}`],
    [
      perf.lastBuildLabel,
      perf.lastBuildMs >= 1000
        ? `${(perf.lastBuildMs / 1000).toFixed(1)} s`
        : `${perf.lastBuildMs.toFixed(0)} ms`,
    ],
  ];
  for (const [zone, tris] of [...byZone.entries()].sort((a, b) => b[1] - a[1]))
    lines.push([`· ${zone}`, fmtTris(tris)]);
  el.innerHTML = "";
  for (const [k, v] of lines) {
    const div = document.createElement("div");
    div.className = "hud-line";
    div.innerHTML = `<span class="k"></span><span class="v"></span>`;
    (div.querySelector(".k") as HTMLElement).textContent = k;
    (div.querySelector(".v") as HTMLElement).textContent = v;
    el.appendChild(div);
  }
}

// --- Global UI -------------------------------------------------------------------

const modeBtns: Record<string, HTMLButtonElement> = {};
for (const m of ["part", "biome", "map"] as Mode[])
  modeBtns[m] = button($("modes"), m, () => {
    view.mode = m;
    buildToolUI();
    scheduleRebuild(0);
  });
worldPicker = selectRow(
  $("modes"),
  "table",
  worldOptions(),
  store.active,
  switchWorld,
);
refreshWorldPicker();

const viewToggles = $("view-toggles");
const toggle = (
  label: string,
  initial: boolean,
  onClick: (on: boolean) => void,
) => {
  const btn = button(viewToggles, label, (b) => {
    const on = !b.classList.contains("on");
    b.classList.toggle("on", on);
    onClick(on);
  });
  btn.classList.toggle("on", initial);
  return btn;
};

const walkBtn = button(viewToggles, "▶ walk (F)", () => {
  if (walk.on) exitWalk();
  else enterWalk();
});
walkBtn.classList.add("walk-btn");

toggle("collide", walk.collide, (on) => (walk.collide = on));
toggle("wireframe", view.wire, (on) => {
  view.wire = on;
  applyWire();
});
toggle("grid", gridOn, (on) => {
  gridOn = on;
  gridSmall.visible = on && view.mode !== "map";
  gridLarge.visible = on && view.mode === "map";
});
toggle("fog", view.fogOn, (on) => {
  view.fogOn = on;
  scene.fog = on ? new THREE.FogExp2(WATER, view.fog[view.mode]) : null;
  scene.background = new THREE.Color(on ? WATER : 0x070d12);
  scene.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (mat && "fog" in mat) {
      mat.fog = on;
      mat.needsUpdate = true;
    }
  });
});
toggle("headlamp", view.lamp, (on) => {
  view.lamp = on;
  lamp.visible = on;
});
toggle("perf", perf.on, (on) => {
  perf.on = on;
  refreshPerfHud();
});
toggle("spin", view.spin, (on) => (view.spin = on));
toggle("clip", view.clipOn, (on) => {
  view.clipOn = on;
  updateClip();
});
const clipAxisBtns: Record<string, HTMLButtonElement> = {};
for (const a of ["x", "y", "z"] as const)
  clipAxisBtns[a] = button(viewToggles, `clip ${a}`, () => {
    view.clipAxis = a;
    markOn(clipAxisBtns, a);
    updateClip();
  });
markOn(clipAxisBtns, view.clipAxis);
const flipBtn = button(viewToggles, "flip", (b) => {
  view.clipFlip = !view.clipFlip;
  b.classList.toggle("on", view.clipFlip);
  updateClip();
});
flipBtn.classList.toggle("on", view.clipFlip);

const viewSliders = $("view-sliders");
const fogSlider = sliderRow(
  viewSliders,
  "fog density",
  0,
  0.02,
  0.0002,
  view.fog[view.mode],
  (v) => {
    view.fog[view.mode] = v;
    if (scene.fog) (scene.fog as THREE.FogExp2).density = v;
  },
  (v) => v.toFixed(4),
);
sliderRow(viewSliders, "clip pos", -1, 1, 0.01, view.clipFrac, (v) => {
  view.clipFrac = v;
  updateClip();
});

const actions = $("config-actions");
copyButton(actions, "copy part", () => currentPart());
copyButton(actions, "copy biome", () => currentBiome());
copyButton(actions, "copy world", () => world);
button(actions, "reset world", () => {
  if (!confirm(`discard local edits of "${store.active}"?`)) return;
  store.worlds[store.active] = cloneWorld(WORLD_DEFAULTS[store.active]);
  save();
  location.reload();
});

addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.target instanceof HTMLTextAreaElement) return;
  if (e.code === "KeyF") {
    e.preventDefault();
    if (walk.on) exitWalk();
    else enterWalk();
    return;
  }
  if (walk.on) {
    walk.keys.add(e.code);
    if (e.code === "Space") e.preventDefault();
    return;
  }
  if (e.code === "Space") {
    e.preventDefault();
    view.seed = (Math.random() * 4294967296) >>> 0;
    buildToolUI(); // refresh the seed field
    scheduleRebuild(0);
  }
  if (e.code === "KeyR") scheduleRebuild(0);
});

addEventListener("keyup", (e) => {
  walk.keys.delete(e.code);
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- Loop & init ---------------------------------------------------------------------

const clock = new THREE.Clock();
let elapsed = 0;
let perfTimer = 0;
renderer.setAnimationLoop(() => {
  const raw = clock.getDelta();
  const dt = Math.min(raw, 0.05);
  elapsed += dt;
  updateGouda(elapsed); // vein pulse/shimmer time for every gouda material
  if (walk.on) {
    updateWalk(dt);
  } else {
    controls.autoRotate = view.spin;
    controls.autoRotateSpeed = 0.6;
    controls.update();
  }
  renderer.render(scene, camera);
  perf.frames++;
  perf.timeAcc += raw;
  perfTimer += raw;
  if (perfTimer >= 0.5) {
    perf.fps = perf.timeAcc > 0 ? perf.frames / perf.timeAcc : 0;
    perf.frames = 0;
    perf.timeAcc = 0;
    perfTimer = 0;
    refreshPerfHud();
  }
});

const params = new URLSearchParams(location.search);
const worldParam = params.get("world");
if (worldParam && store.worlds[worldParam]) {
  store.active = worldParam;
  world = store.worlds[worldParam];
  view.partId = world.parts[0].id;
  view.biomeId = world.biomes[0].id;
  view.skinBiomeId = world.biomes[0].id;
}
const partParam = params.get("part");
const biomeParam = params.get("biome");
if (partParam && world.parts.some((p) => p.id === partParam)) {
  view.mode = "part";
  view.partId = partParam;
} else if (biomeParam && world.biomes.some((b) => b.id === biomeParam)) {
  view.mode = "biome";
  view.biomeId = biomeParam;
} else if (params.has("map")) {
  view.mode = "map";
}
if (params.has("seed")) view.seed = Number(params.get("seed")) >>> 0;
if (params.has("d"))
  view.difficulty = Math.min(3, Math.max(1, Number(params.get("d")) || 1));

buildToolUI();
scheduleValidate(); // badge reflects a stored-but-invalid table immediately
void rebuild().then(async () => {
  // ?build=1 deep-links straight into the real full build (map mode).
  if (params.has("build") && view.mode === "map") await buildRealWorld();
  (window as unknown as { __benchReady?: boolean }).__benchReady = true;
  console.log("worldgen: content ready");
});
console.log("worldgen: bench ready");
