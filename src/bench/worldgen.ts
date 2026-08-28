// worldgen.ts — the cheese kit's authoring bench (M2), served at
// /worldgen.html. Edits live WorldRecipe copies (persisted to localStorage,
// one per world table: the classic onion and the Great Wheel MVP map)
// through three views, all driven by the REAL generator in world/gouda.ts:
//
//   part   one CheesePartType at the origin — every PartRecipe field on a
//          slider, instant remesh, any biome's skin
//   biome  a representative wedge of one biome — placement density, sizes,
//          part mix, wax material; fused/hull biomes show real lattice
//          tiles with their inter-tile carve network
//   map    the whole onion as instant proxies (spheres for scattered
//          chunks, boxes for layer tiles, the hull silhouette, the spine
//          and soft spots); or the real full build via buildGoudaWorld()
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
  chunkDistance,
  createGoudaMaterial,
  disposeWorld,
  getGoldPos,
  getSpawnPoint,
  makeChunkData,
  makeFrame,
  meshChunk,
  mulberry32,
  planWorldLayout,
  R0,
  updateGouda,
  worldDistance,
  type Chunk,
  type GenCtx,
  type WorldPlan,
} from "../world/gouda.ts";
import {
  cloneWorld,
  DEFAULT_WORLD,
  pickPart,
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

const STORAGE_KEY = "abyssal.worldgen.v2";
const LEGACY_KEY = "abyssal.worldgen.v1";
const RES_CHOICES = [32, 48, 64, 96];
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
  onion: DEFAULT_WORLD,
  wheel: WHEEL_WORLD,
};
const WORLD_LABELS: Record<string, string> = {
  onion: "classic onion",
  wheel: "great wheel (mvp)",
};

// --- Working config ----------------------------------------------------------

interface Store {
  v: number;
  active: string;
  worlds: Record<string, WorldRecipe>;
}

function freshStore(): Store {
  return {
    v: 2,
    active: "wheel",
    worlds: {
      onion: cloneWorld(DEFAULT_WORLD),
      wheel: cloneWorld(WHEEL_WORLD),
    },
  };
}

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as Store;
      if (data.v === 2 && data.worlds?.onion && data.worlds?.wheel) return data;
    }
    // v1 held a single (classic) world — carry it over as "onion".
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const data = JSON.parse(legacy) as { v?: number; world?: WorldRecipe };
      if (data.v === 1 && data.world?.parts?.length) {
        const store = freshStore();
        store.active = "onion";
        store.worlds.onion = data.world;
        return store;
      }
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
let disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
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
  setLoading(null);
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

function refreshSkin(): void {
  if (!content || view.mode === "map") return;
  const mat = makeSkinMaterial(skinSource());
  content.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && (m.material as THREE.MeshToonMaterial).userData.__toon)
      m.material = mat;
  });
  applyWire();
}

// --- Part view -------------------------------------------------------------------

function partMetrics(part: PartRecipe, s: number, res: number): HudLine[] {
  const lines: HudLine[] = [];
  if (part.tunnels.rBase > 0) {
    const cells = part.tunnels.rBase * res;
    const crisp = cells >= 3.95; // the readable-tunnel rule, r×res ≥ 4
    const radius = part.tunnels.rBase * s;
    lines.push([
      "tunnel r×res",
      `${cells.toFixed(1)} ${crisp ? "✓" : "✗ blobby <4"}`,
      crisp ? "ok" : "bad",
    ]);
    lines.push([
      "tunnel radius",
      `${radius.toFixed(2)} u ${radius >= 1.3 ? "(cargo ✓)" : radius >= 0.9 ? "(rat ✓)" : "(rat ✗)"}`,
      radius >= 0.9 ? "ok" : "bad",
    ]);
  }
  if (part.eyes.rBase > 0)
    lines.push(["eye radius", `${(part.eyes.rBase * s).toFixed(1)} u`]);
  if (part.noCarveWithin != null)
    lines.push(["seal amp cap", `amp ≤ thickness/3/size`]);
  return lines;
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
  const mesh = meshChunk(chunk, view.partRes, makeSkinMaterial(skinSource()));
  chunk.field = null; // the bench never digs; drop the cached voxels
  const tMesh = performance.now();
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
    ...partMetrics(part, s, view.partRes),
  ]);
}

// --- Biome view ------------------------------------------------------------------

function randDirIn(
  rng: () => number,
  cosTheta: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  // Uniform direction inside the +Z cone (the wedge).
  const cosA = 1 - rng() * (1 - cosTheta);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const phi = rng() * Math.PI * 2;
  out.set(Math.cos(phi) * sinA, Math.sin(phi) * sinA, cosA);
  return out;
}

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

  // Wedge chunk placement — same spacing rules as the real placeChunks.
  interface Placed {
    center: THREE.Vector3;
    s: number;
    res: number;
    part: PartRecipe;
    axis: Vec3 | null;
  }
  const placed: Placed[] = [];
  const dir = new THREE.Vector3();
  let want = 1;
  let rMid = 0;

  if (pl.mode === "center") {
    placed.push({
      center: new THREE.Vector3(0, 0, 0),
      s: biome.sizeBase + (biome.sizeVar > 0 ? rng() * biome.sizeVar : 0),
      res: biome.res,
      part: pickPart(world, biome, rng),
      axis: null,
    });
  } else if (pl.mode === "band") {
    rMid = (pl.rMin + pl.rMax) / 2;
    want = Math.max(2, Math.round(pl.count * coneFrac));
    for (let i = 0; i < want; i++) {
      let s =
        biome.sizeVar > 0
          ? biome.sizeBase + rng() * biome.sizeVar
          : biome.sizeBase;
      const part = pickPart(world, biome, rng);
      placing: for (let shrink = 0; shrink < 4; shrink++, s *= 0.9) {
        for (let attempt = 0; attempt < 300; attempt++) {
          randDirIn(rng, cosTheta, dir);
          let u = rng();
          if (pl.densityGrade === "outward") u = Math.sqrt(u);
          else if (pl.densityGrade === "inward") u = 1 - Math.sqrt(1 - u);
          const rad = pl.rMin + u * (pl.rMax - pl.rMin);
          const p = new THREE.Vector3(dir.x * rad, dir.y * rad, dir.z * rad);
          let ok = true;
          for (const other of placed)
            if (p.distanceTo(other.center) < (s + other.s) * pl.guard) {
              ok = false;
              break;
            }
          if (ok) {
            placed.push({ center: p, s, res: biome.res, part, axis: null });
            break placing;
          }
        }
      }
    }
  } else {
    // Shell: the real fibonacci lattice, filtered to the wedge cone.
    rMid = pl.radius;
    const n = pl.count + (view.difficulty - 1) * pl.perDifficulty;
    const GOLDEN = 2.399963229728653;
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = i * GOLDEN;
      const axis = new THREE.Vector3(
        Math.cos(th) * r + (rng() - 0.5) * 0.08,
        y + (rng() - 0.5) * 0.08,
        Math.sin(th) * r + (rng() - 0.5) * 0.08,
      ).normalize();
      if (axis.z < cosTheta) continue;
      const colossal = pl.colossalEvery > 0 && i % pl.colossalEvery === 0;
      const s = colossal
        ? biome.sizeBase +
          biome.sizeVar +
          pl.colossalBonus +
          rng() * pl.colossalVar
        : biome.sizeBase + rng() * biome.sizeVar;
      placed.push({
        center: axis.clone().multiplyScalar(pl.radius + (rng() - 0.5) * 4),
        s,
        res: colossal ? pl.colossalRes : biome.res,
        part: pickPart(world, biome, rng),
        axis: { x: axis.x, y: axis.y, z: axis.z },
      });
    }
    want = placed.length || 1;
  }

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
    const chunk = makeChunkData(rng, c.center, c.s, c.res, c.part, ctx, c.axis);
    const mesh = meshChunk(chunk, c.res, mat);
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

  // The wedge spreads laterally by ~2·r·sin(θ) — frame for that, not just
  // the band's radial depth.
  const sinTheta = Math.sin((view.wedgeDeg * Math.PI) / 180);
  const extent =
    pl.mode === "center"
      ? biome.sizeBase * 2.1
      : pl.mode === "band"
        ? Math.max(
            pl.rMax - pl.rMin + biome.sizeBase * 2 + 30,
            1.6 * pl.rMax * sinTheta,
          )
        : Math.max(
            (biome.sizeBase + biome.sizeVar) * 2.6,
            1.6 * pl.radius * sinTheta,
          );
  clipScale = extent * 0.5;
  gridSmall.position.y = -extent * 0.45;
  frameCamera(Math.min(extent * 1.1, 700));

  setHud(`biome · ${biome.id}`, [
    ["wedge", `${view.wedgeDeg}° (${(coneFrac * 100).toFixed(1)}% of shell)`],
    [
      "chunks",
      `${placed.length} of ${pl.mode === "band" ? pl.count : want} total`,
    ],
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
    spineIn: null,
    spineOut: null,
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
    const mesh = meshChunk(chunk, chunk.res, mat);
    chunk.field = null;
    chunk.center = chunk.center.clone().add(group.position);
    benchChunks.push(chunk);
    disposables.push(mesh.geometry);
    tris += mesh.geometry.attributes.position.count / 3;
    group.add(mesh);
  }
  setLoading(null);
  applyWire();

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
    ...(part ? partMetrics(part, biome.sizeBase, biome.res) : []),
  ]);
}

// --- Map view (the onion arranging itself) -----------------------------------------

const proxyGeo = new THREE.SphereGeometry(1, 14, 10);
const boxGeo = new THREE.BoxGeometry(2, 2, 2);
const shellGeo = new THREE.SphereGeometry(1, 40, 24);

function rebuildMapProxies(): void {
  const t0 = performance.now();
  let plan: WorldPlan;
  try {
    plan = planWorldLayout(view.seed, view.difficulty, world);
  } catch (err) {
    setHud("invalid recipe", [["error", (err as Error).message, "bad"]]);
    return;
  }
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

  // World radii: gold band (gold), world edge + boundary veil (teal).
  const rings: [number, number, number][] = [
    [world.goldBand.min, 0xffd24a, 0.1],
    [world.goldBand.max, 0xffd24a, 0.1],
    [world.worldR, 0x2a7da5, 0.08],
    [world.boundaryR, 0x1d4457, 0.1],
  ];
  for (const [radius, color, opacity] of rings) {
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

  // Spawn approximation (the real point needs the meshed world).
  const spawnMat = new THREE.MeshBasicMaterial({ color: 0x66ff99 });
  disposables.push(spawnMat);
  const spawn = new THREE.Mesh(proxyGeo, spawnMat);
  spawn.position.set(0, 18, world.worldR + 14);
  spawn.scale.setScalar(4);
  group.add(spawn);

  mount(group);
  frameCamera(world.worldR * 2.05);
  clipScale = world.worldR;

  const lines: HudLine[] = [
    ["chunks", String(plan.specs.length)],
    ["planned in", `${(performance.now() - t0).toFixed(0)} ms`],
  ];
  if (plan.spine.length)
    lines.push(["spine", plan.spine.map((p) => p.r.toFixed(0)).join(" → ")]);
  for (const biome of world.biomes)
    lines.push([biome.id, String(counts.get(biome.id) ?? 0)]);
  setHud("map · layout proxies", lines);
}

async function buildRealWorld(): Promise<void> {
  disposeContent();
  const token = buildToken;
  gridLarge.visible = false;

  // Optional res downshift so full-world iteration stays quick.
  const buildWorld = cloneWorld(world);
  if (view.buildHalfRes)
    for (const biome of buildWorld.biomes) {
      biome.res = HALF_RES[biome.res] ?? 32;
      if (biome.placement.mode === "shell")
        biome.placement.colossalRes =
          HALF_RES[biome.placement.colossalRes] ?? 32;
    }

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

  // Gold + spawn markers over the real build.
  const markers = new THREE.Group();
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
  mount(markers);

  setHud("map · real build", [
    ["seed / diff", `${view.seed} / d${view.difficulty}`],
    ["res", view.buildHalfRes ? "half" : "full"],
    ["built in", `${((performance.now() - t0) / 1000).toFixed(1)} s`],
    [
      "gold",
      gold
        ? `${gold.x.toFixed(0)}, ${gold.y.toFixed(0)}, ${gold.z.toFixed(0)}`
        : "—",
    ],
    ["gold radius", gold ? Math.hypot(gold.x, gold.y, gold.z).toFixed(0) : "—"],
    ["walk it", "press F"],
  ]);
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
  sliderRow(axes, "porosity", 0, 1, 0.05, part.porosity, (v) =>
    edit(() => (part.porosity = v), 400),
  );
  sliderRow(axes, "odour", 0, 1, 0.05, part.odour, (v) =>
    edit(() => (part.odour = v), 400),
  );

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
        gradeBtns[g] = button(gradeRow, g, () =>
          edit(() => {
            if (g === "none") delete pl.densityGrade;
            else pl.densityGrade = g as "outward" | "inward";
            markOn(gradeBtns, g);
          }, 0),
        );
      markOn(gradeBtns, pl.densityGrade ?? "none");
    } else if (pl.mode === "shell") {
      sliderRow(
        place,
        "radius",
        20,
        400,
        1,
        pl.radius,
        (v) => edit(() => (pl.radius = v)),
        int,
      );
      sliderRow(
        place,
        "count",
        4,
        96,
        1,
        pl.count,
        (v) => edit(() => (pl.count = v)),
        int,
      );
      sliderRow(
        place,
        "+/difficulty",
        0,
        12,
        1,
        pl.perDifficulty,
        (v) => edit(() => (pl.perDifficulty = v)),
        int,
      );
      sliderRow(
        place,
        "colossal Nth",
        0,
        24,
        1,
        pl.colossalEvery,
        (v) => edit(() => (pl.colossalEvery = v)),
        int,
      );
      sliderRow(
        place,
        "colossal +u",
        0,
        40,
        1,
        pl.colossalBonus,
        (v) => edit(() => (pl.colossalBonus = v)),
        int,
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
    return;
  }

  if (cat === "game") {
    biome.budgets ??= { airPockets: 0, essence: 0, faults: 0, softSpots: 0 };
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
    const airBtn = button(flagsRow, "air-filled", (b) => {
      biome.airFilled = !biome.airFilled;
      if (!biome.airFilled) delete biome.airFilled;
      b.classList.toggle("on", !!biome.airFilled);
      save();
    });
    airBtn.classList.toggle("on", !!biome.airFilled);

    const budgets = section(panel, "Budgets (M3 seeds)").parentElement!;
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
      "essence",
      0,
      20,
      1,
      bud.essence,
      (v) => {
        bud.essence = v;
        save();
      },
      int,
    );
    sliderRow(
      budgets,
      "faults",
      0,
      20,
      1,
      bud.faults,
      (v) => {
        bud.faults = v;
        save();
      },
      int,
    );

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
        if (pl.mode === "shell")
          sliderRow(
            box,
            "count",
            4,
            96,
            1,
            pl.count,
            (v) => edit(() => (pl.count = v)),
            int,
          );
        else
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

function syncUrl(): void {
  const q = new URLSearchParams();
  q.set("world", store.active);
  if (view.mode === "part") q.set("part", view.partId);
  else if (view.mode === "biome") q.set("biome", view.biomeId);
  else q.set("map", "1");
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

// --- Global UI -------------------------------------------------------------------

const modeBtns: Record<string, HTMLButtonElement> = {};
for (const m of ["part", "biome", "map"] as Mode[])
  modeBtns[m] = button($("modes"), m, () => {
    view.mode = m;
    buildToolUI();
    scheduleRebuild(0);
  });
selectRow(
  $("modes"),
  "table",
  Object.keys(WORLD_DEFAULTS).map((k) => ({
    value: k,
    label: WORLD_LABELS[k] ?? k,
  })),
  store.active,
  switchWorld,
);

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
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
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

buildToolUI();
void rebuild().then(async () => {
  // ?build=1 deep-links straight into the real full build (map mode).
  if (params.has("build") && view.mode === "map") await buildRealWorld();
  (window as unknown as { __benchReady?: boolean }).__benchReady = true;
  console.log("worldgen: content ready");
});
console.log("worldgen: bench ready");
