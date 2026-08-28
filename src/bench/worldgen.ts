// worldgen.ts — the cheese kit's authoring bench (M2), served at
// /worldgen.html. Edits a live WorldRecipe copy (persisted to localStorage)
// through three views, all driven by the REAL generator in world/gouda.ts:
//
//   part   one CheesePartType at the origin — every PartRecipe field on a
//          slider, instant remesh, any biome's skin, a clip plane to cut
//          the camera inside (M2.1/M2.2)
//   biome  a representative wedge of one biome — placement density, sizes,
//          weighted part mix, wax material (M2.3/M2.4)
//   map    the whole onion as instant per-chunk proxies — bands, counts and
//          world radii; or the real full build via buildGoudaWorld()
//
// "copy" buttons dump the edited entry as JSON to paste into
// world/recipes.ts — that is the commit step; the game only ever plays the
// shipped tables. "reset" returns to DEFAULT_WORLD.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  buildGoudaWorld,
  createGoudaMaterial,
  disposeWorld,
  getGoldPos,
  getSpawnPoint,
  makeChunkData,
  meshChunk,
  mulberry32,
  planWorldLayout,
  R0,
  updateGouda,
} from "../world/gouda.ts";
import {
  cloneWorld,
  DEFAULT_WORLD,
  pickPart,
  type BiomeMaterial,
  type BiomeRecipe,
  type PartKind,
  type PartRecipe,
  type WorldRecipe,
} from "../world/recipes.ts";
import type { Vec3 } from "../state.ts";
import { button, colorRow, markOn, numRow, section, sliderRow } from "./ui.ts";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const STORAGE_KEY = "abyssal.worldgen.v1";
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

// --- Working config ----------------------------------------------------------

function loadWorld(): WorldRecipe {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as { v?: number; world?: WorldRecipe };
      if (
        data.v === 1 &&
        data.world?.parts?.length &&
        data.world.biomes?.length
      )
        return data.world;
    }
  } catch {
    // fall through to defaults
  }
  return cloneWorld(DEFAULT_WORLD);
}

const world = loadWorld();

function save(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, world }));
}

type Mode = "part" | "biome" | "map";

const view = {
  mode: "part" as Mode,
  seed: 7,
  difficulty: 1,
  // part view
  partId: world.parts[0].id,
  partSize: 0, // 0 = derive from the recipe's size range on selection
  partRes: 48,
  skinBiomeId: world.biomes[0].id as string,
  // biome view
  biomeId: world.biomes[0].id as string,
  wedgeDeg: 35,
  // map view
  built: false, // real meshes mounted (vs proxy spheres)
  buildHalfRes: true,
  // shared view options
  clipOn: false,
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
renderer.localClippingEnabled = true;
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

// Everything above clipPlane.constant is cut away (normal points -Y).
const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e9);
let clipScale = 20; // world-u range of the clip slider, set per rebuild

function updateClip(): void {
  clipPlane.constant = view.clipOn ? view.clipFrac * clipScale : 1e9;
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

function setHud(title: string, lines: [string, string][]): void {
  $("hud-title").textContent = title;
  const body = $("hud-body");
  body.innerHTML = "";
  for (const [k, v] of lines) {
    const div = document.createElement("div");
    div.className = "hud-line";
    div.innerHTML = `<span class="k"></span><span class="v"></span>`;
    (div.querySelector(".k") as HTMLElement).textContent = k;
    (div.querySelector(".v") as HTMLElement).textContent = v;
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

// Bench skins are double-sided + clip-enabled so the cut face reads.
function makeSkinMaterial(m: BiomeMaterial): THREE.MeshToonMaterial {
  const mat = createGoudaMaterial(m);
  mat.side = THREE.DoubleSide;
  mat.clippingPlanes = [clipPlane];
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

// --- Part view (M2.1/M2.2) -----------------------------------------------------

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
  ]);
}

// --- Biome view (M2.3/M2.4) ------------------------------------------------------

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
  const rng = mulberry32(view.seed >>> 0);
  const ctx = { difficulty: view.difficulty, blastPoints: [] as Vec3[] };
  const cosTheta = Math.cos((view.wedgeDeg * Math.PI) / 180);
  const coneFrac = (1 - cosTheta) / 2;

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
          const rad = pl.rMin + rng() * (pl.rMax - pl.rMin);
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
      `${placed.length} of ${pl.mode === "band" ? (pl as { count: number }).count : want} total`,
    ],
    ["triangles", Math.round(tris).toLocaleString()],
    ["carve time", `${(performance.now() - t0).toFixed(0)} ms`],
    ["blast walls", String(ctx.blastPoints.length)],
    ["fish may enter", biome.fishMayEnter ? "yes" : "no"],
  ]);
}

// --- Map view (the onion arranging itself) -----------------------------------------

const proxyGeo = new THREE.SphereGeometry(1, 14, 10);
const shellGeo = new THREE.SphereGeometry(1, 40, 24);

function rebuildMapProxies(): void {
  const t0 = performance.now();
  const specs = planWorldLayout(view.seed, view.difficulty, world);
  const group = new THREE.Group();

  const zoneMats = new Map<string, THREE.MeshBasicMaterial>();
  const counts = new Map<string, number>();
  for (const biome of world.biomes) {
    const m = new THREE.MeshBasicMaterial({
      color: biome.material.rind,
      wireframe: true,
      transparent: true,
      opacity: 0.45,
    });
    zoneMats.set(biome.id, m);
    disposables.push(m);
    counts.set(biome.id, 0);
  }

  for (const spec of specs) {
    const proxy = new THREE.Mesh(proxyGeo, zoneMats.get(spec.zone));
    proxy.position.copy(spec.center);
    proxy.scale.setScalar(spec.s * R0);
    group.add(proxy);
    counts.set(spec.zone, (counts.get(spec.zone) ?? 0) + 1);
  }

  // World radii: gold band (gold), world edge + boundary veil (teal).
  const rings: [number, number, number][] = [
    [world.goldBand.min, 0xffd24a, 0.1],
    [world.goldBand.max, 0xffd24a, 0.1],
    [world.worldR, 0x2a7da5, 0.08],
    [world.boundaryR, 0x1d4457, 0.1],
  ];
  for (const [radius, color, opacity] of rings) {
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

  const lines: [string, string][] = [
    ["chunks", String(specs.length)],
    ["planned in", `${(performance.now() - t0).toFixed(0)} ms`],
  ];
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
  await buildGoudaWorld(
    scene,
    (done, total, label) => setLoading(`${done}/${total} · ${label}`),
    { seed: view.seed, difficulty: view.difficulty, world: buildWorld },
  );
  if (token !== buildToken) {
    // A newer rebuild superseded this one mid-build; tear down our world.
    disposeWorld(scene);
    return;
  }
  view.built = true;
  setLoading(null);

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

// --- Tool panel (per mode) ----------------------------------------------------------

function seedControls(panel: HTMLElement): void {
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
}

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
  void lo;
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

const int = (v: number) => v.toFixed(0);

function buildPartUI(panel: HTMLElement): void {
  const part = currentPart();

  const picker = section(panel, "Part");
  const partBtns: Record<string, HTMLButtonElement> = {};
  for (const p of world.parts)
    partBtns[p.id] = button(picker, p.id, () => {
      view.partId = p.id;
      view.partSize = 0;
      buildToolUI();
      scheduleRebuild(0);
    });
  markOn(partBtns, part.id);
  button(picker, "+ duplicate", () => {
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
  button(picker, "delete", () => {
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

  seedControls(panel);

  const mount = section(panel, "Mount").parentElement!;
  const mountRow = mount.querySelector(".row") as HTMLElement;
  sliderRow(
    mount,
    "size u",
    4,
    90,
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
    resBtns[r] = button(mountRow, `${r}³`, () => {
      view.partRes = r;
      markOn(resBtns, String(r));
      scheduleRebuild(0);
    });
  markOn(resBtns, String(view.partRes));

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
    90,
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
  sliderRow(crust, "noise amp", 0, 0.2, 0.005, part.crust.amp, (v) =>
    edit(() => (part.crust.amp = v)),
  );
  sliderRow(crust, "noise freq", 0.4, 4, 0.05, part.crust.freq, (v) =>
    edit(() => (part.crust.freq = v)),
  );
  sliderRow(crust, "depth", 0.05, 0.4, 0.01, part.crust.depth, (v) =>
    edit(() => (part.crust.depth = v)),
  );

  const eyes = section(panel, "Eyes (caverns)").parentElement!;
  rangePair(
    eyes,
    "count min",
    "count max",
    0,
    30,
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

  const skin = section(panel, "Skin (biome wax)");
  const skinBtns: Record<string, HTMLButtonElement> = {};
  for (const b of world.biomes)
    skinBtns[b.id] = button(skin, b.id, () => {
      view.skinBiomeId = b.id;
      markOn(skinBtns, b.id);
      refreshSkin();
    });
  markOn(skinBtns, view.skinBiomeId);

  const out = section(panel, "Export");
  copyButton(out, "copy part JSON", () => currentPart());
}

function buildBiomeUI(panel: HTMLElement): void {
  const biome = currentBiome();

  const picker = section(panel, "Biome");
  const biomeBtns: Record<string, HTMLButtonElement> = {};
  for (const b of world.biomes)
    biomeBtns[b.id] = button(picker, b.id, () => {
      view.biomeId = b.id;
      buildToolUI();
      scheduleRebuild(0);
    });
  markOn(biomeBtns, biome.id);

  seedControls(panel);
  const genBox = $("tool-ui").querySelector(
    ".section:nth-child(2)",
  ) as HTMLElement;
  sliderRow(
    genBox,
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

  const pl = biome.placement;
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
      80,
      1,
      pl.count,
      (v) => edit(() => (pl.count = v)),
      int,
    );
    sliderRow(place, "spacing", 0, 2, 0.05, pl.guard, (v) =>
      edit(() => (pl.guard = v)),
    );
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
  }
  sliderRow(
    place,
    "size base",
    4,
    90,
    1,
    biome.sizeBase,
    (v) => edit(() => (biome.sizeBase = v)),
    int,
  );
  sliderRow(
    place,
    "size var",
    0,
    40,
    1,
    biome.sizeVar,
    (v) => edit(() => (biome.sizeVar = v)),
    int,
  );
  const placeRow = place.querySelector(".row") as HTMLElement;
  const resBtns: Record<string, HTMLButtonElement> = {};
  for (const r of RES_CHOICES)
    resBtns[r] = button(placeRow, `${r}³`, () =>
      edit(() => {
        biome.res = r;
        markOn(resBtns, String(r));
      }, 0),
    );
  markOn(resBtns, String(biome.res));

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
      buildToolUI();
    });
  }

  const wax = section(panel, "Wax material").parentElement!;
  const waxRow = wax.querySelector(".row") as HTMLElement;
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
  sliderRow(wax, "vein glow", 0, 1.5, 0.05, biome.material.veinStrength, (v) =>
    editSkin(() => (biome.material.veinStrength = v)),
  );
  const fishBtn = button(waxRow, "fish may enter", (b) => {
    biome.fishMayEnter = !biome.fishMayEnter;
    b.classList.toggle("on", biome.fishMayEnter);
    save();
  });
  fishBtn.classList.toggle("on", biome.fishMayEnter);

  const out = section(panel, "Export");
  copyButton(out, "copy biome JSON", () => currentBiome());
}

function buildMapUI(panel: HTMLElement): void {
  seedControls(panel);

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

  for (const biome of world.biomes) {
    const pl = biome.placement;
    if (pl.mode === "center") continue;
    const box = section(panel, `· ${biome.id}`).parentElement!;
    if (pl.mode === "band") {
      rangePair(
        box,
        "from",
        "to",
        10,
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
      sliderRow(
        box,
        "count",
        0,
        80,
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
    }
    sliderRow(
      box,
      "size base",
      4,
      90,
      1,
      biome.sizeBase,
      (v) => edit(() => (biome.sizeBase = v)),
      int,
    );
  }

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

  const out = section(panel, "Export");
  copyButton(out, "copy full config", () => world);
}

function syncUrl(): void {
  const q = new URLSearchParams();
  if (view.mode === "part") q.set("part", view.partId);
  else if (view.mode === "biome") q.set("biome", view.biomeId);
  else q.set("map", "1");
  history.replaceState(null, "", `?${q}`);
}

function buildToolUI(): void {
  const panel = $("tool-ui");
  panel.innerHTML = "";
  if (view.mode === "part") buildPartUI(panel);
  else if (view.mode === "biome") buildBiomeUI(panel);
  else buildMapUI(panel);
  markOn(modeBtns, view.mode);
  // Each mode keeps its own fog density (very different camera distances).
  fogSlider.set(view.fog[view.mode]);
  if (scene.fog) (scene.fog as THREE.FogExp2).density = view.fog[view.mode];
  syncUrl();
}

// --- Global UI -------------------------------------------------------------------

const modeBtns: Record<string, HTMLButtonElement> = {};
for (const m of ["part", "biome", "map"] as Mode[])
  modeBtns[m] = button($("modes"), m, () => {
    view.mode = m;
    buildToolUI();
    scheduleRebuild(0);
  });

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
sliderRow(viewSliders, "clip height", -1, 1, 0.01, view.clipFrac, (v) => {
  view.clipFrac = v;
  if (!view.clipOn) return;
  updateClip();
});

const actions = $("config-actions");
copyButton(actions, "copy full config", () => world);
button(actions, "reset to defaults", () => {
  if (!confirm("discard all local worldgen edits?")) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
});

addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === "Space") {
    e.preventDefault();
    view.seed = (Math.random() * 4294967296) >>> 0;
    buildToolUI(); // refresh the seed field
    scheduleRebuild(0);
  }
  if (e.code === "KeyR") scheduleRebuild(0);
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
  controls.autoRotate = view.spin;
  controls.autoRotateSpeed = 0.6;
  controls.update();
  renderer.render(scene, camera);
});

const params = new URLSearchParams(location.search);
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
void rebuild();
console.log("worldgen: bench ready");
