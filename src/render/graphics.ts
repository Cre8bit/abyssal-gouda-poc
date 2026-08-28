// graphics.js — Three.js module: cinematic abyssal first-person rendering.
//
// Lighting model:
//  - Flashlight = hot core spotlight (shadows) + wide soft spill light
//  - Custom volumetric beam: tight core + wide soft haze cone (fresnel-soft,
//    distance falloff, drifting particulate wisps) plus camera-facing
//    dispersal halos spaced along the axis, so the beam's throw and dimming
//    read clearly even with no floor/walls in view
//  - Marine snow is LIT by the beams (uniform-driven cone lighting), so the
//    light visibly diffuses through the thickness of the water
//  - Scatter halo sprites at every lamp
//  - Lights are steady (no flicker); the dying bell lamp only breathes with
//    a slow, smooth pulse
//  - Slow current drift on particles + occasional rising bubble bursts
//  - The world itself is the procedural gouda labyrinth (see gouda.js):
//    marching-cubes chunks with real enterable holes and tunnel systems
import * as THREE from "three";
import {
  buildGoudaWorld,
  disposeWorld,
  updateGouda,
  getSpawnPoint,
} from "../world/gouda.ts";
import { mountBathyscaphe, updateBathyscaphe } from "../world/bathyscaphe.ts";
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  prepareDiverTemplate,
  createDiverRig,
  updateDiverRig,
  fpBodyPitch,
} from "../entities/diverRig.ts";
import { initCatfishSystem } from "../entities/catfish.ts";
import { setGoudaScene } from "../entities/goldenGouda.ts";
import { toonMaterial } from "./toon.ts";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import type { Vec3 } from "../state.ts";

// Shapes inferred from diverRig.ts / gouda.ts (typed in parallel) — derive
// them so this file tracks those modules' own annotations automatically.
type DiverTemplate = ReturnType<typeof prepareDiverTemplate>;
type DiverRig = ReturnType<typeof createDiverRig>;
type WorldProgress = (done: number, total: number, label: string) => void;
interface WorldOptions {
  seed?: number;
  difficulty?: number;
}

// Params for the volumetric beam builders.
interface BeamOptions {
  length: number;
  endRadius: number;
  tint: THREE.ColorRepresentation;
  strength: number;
  falloffPow?: number;
}

interface BurstState {
  origin: THREE.Vector3;
  age: number;
  duration: number;
}

interface BreathState {
  x: number;
  y: number;
  z: number;
  age: number;
  seed: number;
}

interface Flashlight {
  group: THREE.Group;
  spot: THREE.SpotLight;
  spill: THREE.SpotLight;
  fill: THREE.PointLight;
  on: boolean;
}

// Per-remote-player record (see addPlayer).
interface RemotePlayer {
  group: THREE.Group;
  pivot: THREE.Group;
  placeholder: THREE.Group;
  spot: THREE.SpotLight;
  beam: THREE.Group;
  halo: THREE.Sprite;
  glow: THREE.PointLight;
  color: THREE.ColorRepresentation;
  rig: DiverRig | null;
  torch: THREE.Group | null;
  headGlow: THREE.Group | null;
  lookYaw: number;
  lookPitch: number;
  swimYaw: number;
  swimPitch: number;
  bodyPitchSm: number;
  velEst: THREE.Vector3;
  lastPos: THREE.Vector3;
  hasLast: boolean;
  carrying: boolean;
}

// traverse() hands back plain Object3Ds; disposables are found by probing.
type SceneChild = THREE.Object3D & {
  geometry?: THREE.BufferGeometry;
  material?: THREE.Material;
};

// DEEP TEAL-BLUE ABYSS — water, not space. The key anti-space cues:
// the void is never pure black (a faint blue-teal ambient floor — light
// scattered by the water itself), and its hue shifts with depth: a ghost of
// blue-green above, crushing blue-black below.
const ABYSS_COLOR = 0x020c12; // mid-water teal-black
const ABYSS_SHALLOW = new THREE.Color(0x04151d); // looking-up ghost teal
const ABYSS_DEEP = new THREE.Color(0x010407); // crushing blue-black
const _fogColor = new THREE.Color(ABYSS_COLOR);

// ONION FOG — density depends on how deep into the ball the player is.
// At the outer edge the water is almost clear: the whole glowing cheese
// system is visible, floating in the dark. Each layer inward the murk
// closes in, until the heart sits in claustrophobic soup.
// Control points: [radial distance from map center, fog density].
const FOG_BANDS = [
  [0, 0.05], // the heart: ~60 m visibility
  [42, 0.046], // the hollows
  [80, 0.04], // the bulwark (wall #2)
  [120, 0.032], // the galleries
  [158, 0.026], // the crust (wall #1)
  [205, 0.02], // the warrens
  [255, 0.015], // the scree
  [310, 0.01], // the chimneys
  [360, 0.007], // the reef
  [400, 0.005], // the drift: water clears fast
  [900, 0.0038], // spawn: see the whole glowing ball
];
const FOG_DENSITY = FOG_BANDS[FOG_BANDS.length - 1][1]; // initial (spawn is outside)

const SNOW_COUNT = 1500;
const SNOW_RADIUS = 30;
const BUBBLE_COUNT = 160;
const BUBBLE_RADIUS = 22;
const BURSTS = 5;
const BURST_PARTICLES = 24;
const PLANKTON_COUNT = 320;
const PLANKTON_RADIUS = 26;
const BREATH_COUNT = 18; // your own exhaled bubbles

const FLASHLIGHT_INTENSITY = 260;
const SPILL_INTENSITY = 32;
const REMOTE_LAMP_INTENSITY = 190;
const MAX_PIXEL_RATIO = 1.5;

const DIVER_MODEL_URL = `${import.meta.env.BASE_URL}models/ratdiverAbyssalGouda.glb`;
// Helmet torch mount: offset from the head joint to the modeled torch box
// on top of the helmet, expressed in look-space (world units). Measured
// from the mesh itself: torch lens at template (0.003, 0.885, 0.175) vs the
// head joint at (0.009, 0.634, 0.079), flipped and scaled.
const TORCH_OFFSET = new THREE.Vector3(0, 0.35, -0.14);

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let composer: EffectComposer;
let horrorPass: ShaderPass;
let snow: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
let bubbles: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
// { points, states: [{origin, age, duration, delay}] }
let bursts: {
  points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  states: BurstState[];
};
// bioluminescent drifters, blinking cyan in the dark
let plankton: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
// { points, states } — the diver's own exhaled bubbles
let breath: {
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  states: BreathState[];
  cursor: number;
};
let flashlight: Flashlight; // { group, spot, spill, beam, halo, on } — helmet-mounted
let elapsed = 0;
let moveFactor = 0;
let resizeFrame: number | null = null;

const players = new Map<string, RemotePlayer>();
const noise = new ImprovedNoise();
const beamMaterials: THREE.ShaderMaterial[] = []; // all volumetric beam materials (share uTime)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

// The GLB is fetched, parsed, and prepped exactly ONCE — the prepared
// template (rest pose, per-bone axes, head fix) is shared by the local
// first-person body and every remote diver clone.
let diverTemplatePromise: Promise<DiverTemplate | null> | null = null;
function loadDiverTemplate(): Promise<DiverTemplate | null> {
  diverTemplatePromise ??= new GLTFLoader()
    .loadAsync(DIVER_MODEL_URL)
    .then((gltf) => prepareDiverTemplate(gltf)) // cel pass runs inside prep
    .catch((err) => {
      // Degrade loudly, not silently: remote divers keep their placeholder
      // capsule, the local FP gloves just never appear.
      console.warn("diver model failed to load — using placeholders", err);
      return null;
    });
  return diverTemplatePromise;
}

// --- Local first-person body: just your two gloves, visible looking down. ---
// Pure POV: no body is rendered at all. The gloves ride the (invisible) arm
// bones and enter the frame only on a steep look down.
let localBody: {
  group: THREE.Group;
  pivot: THREE.Group;
  rig: DiverRig;
} | null = null; // { group, pivot, rig }
const localState = {
  active: false,
  pos: new THREE.Vector3(),
  yaw: 0,
  pitch: 0,
  swimYaw: 0,
  swimPitch: 0,
  vel: new THREE.Vector3(),
  carrying: false,
};

// Your own suit, as only you see it. The FP arms carry TWO materials (the
// suit, and the flat lining of the shoulder cut — see diverRig's
// capOpenLoops), so this maps over the array rather than assuming one.
//  - Double-sided: a hard bank can swing a sleeve's cut end past the lens,
//    and a culled backface there reads as a hole punched through the arm.
//  - Darkened below the world's albedo so arms and gloves never blow out
//    inside the torch's beam core, with enough left to keep definition.
function dressOwnSuit(
  material: THREE.Material | THREE.Material[],
): THREE.Material | THREE.Material[] {
  const dress = (m: THREE.Material) => {
    const c = m.clone() as THREE.Material & { color?: THREE.Color };
    c.side = THREE.DoubleSide;
    c.color?.multiplyScalar(0.58);
    return c;
  };
  return Array.isArray(material) ? material.map(dress) : dress(material);
}

// No clip planes anywhere anymore: the FP rig renders only the two gloves
// (diverRig.js drops every other triangle at prep time), so nothing can
// ever be sliced open near the camera.
function createLocalBody() {
  loadDiverTemplate().then((template) => {
    if (!template) return;
    const group = new THREE.Group();
    const pivot = new THREE.Group();
    group.add(pivot);
    const rig = createDiverRig(template, { firstPerson: true });
    rig.root.traverse((obj: THREE.Object3D) => {
      if ((obj as THREE.Mesh).isMesh) {
        (obj as THREE.Mesh).material = dressOwnSuit(
          (obj as THREE.Mesh).material,
        );
      }
    });
    pivot.add(rig.root);
    scene.add(group);
    localBody = { group, pivot, rig };
  });
}

// Called by main.js every frame with the freshest simulation state.
export function updateLocalPlayer(
  pos: Vec3,
  yaw: number,
  pitch: number,
  swimYaw: number,
  swimPitch: number,
  vel: Vec3,
  carrying: boolean = false,
): void {
  localState.active = true;
  localState.carrying = carrying;
  localState.pos.set(pos.x, pos.y, pos.z);
  localState.yaw = yaw;
  localState.pitch = pitch;
  localState.swimYaw = swimYaw;
  localState.swimPitch = swimPitch;
  localState.vel.set(vel.x, vel.y, vel.z);
}

function updateLocalBody(delta: number): void {
  if (!localBody || !localState.active) return;

  // The arms are SCREEN-ANCHORED, FPS-style: the invisible body yaws and
  // pitches WITH the camera (not with the swim direction), rigidly, so the
  // shoulders keep one fixed spot in camera space — which is what keeps the
  // FP geometry's only cut permanently behind the lens. The "see more of your
  // arms when you look down" job is done by the pose instead (diverRig's
  // ARM_POSE_FP_DOWN), which can do it without moving the shoulder.
  const bodyPitch = fpBodyPitch(localState.pitch);
  localBody.group.position.copy(localState.pos);
  localBody.group.rotation.y = localState.yaw;
  localBody.pivot.rotation.x = bodyPitch;
  updateDiverRig(localBody.rig, delta, {
    bodyYaw: localState.yaw,
    bodyPitch,
    lookYaw: localState.yaw,
    lookPitch: localState.pitch,
    vel: localState.vel,
    carrying: localState.carrying,
  });
}

function renderPixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
}

export function initGraphics(container: HTMLElement): HTMLCanvasElement {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(ABYSS_COLOR);
  scene.fog = new THREE.FogExp2(ABYSS_COLOR, FOG_DENSITY);

  camera = new THREE.PerspectiveCamera(
    72,
    window.innerWidth / window.innerHeight,
    0.1,
    1000, // far enough to take in the whole ball from the drift
  );
  camera.rotation.order = "YXZ";
  camera.position.set(0, 2, 8);
  scene.add(camera);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
    stencil: false,
  });
  renderer.setPixelRatio(renderPixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1; // yellow cheese, but never blown out
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Shadows update EVERY frame. The old 30 Hz throttle showed a stale shadow
  // on alternate frames — with the light glued to the camera, that reads as
  // constant flicker against the cheese walls.
  renderer.shadowMap.autoUpdate = true;
  container.appendChild(renderer.domElement);

  setupPostProcessing();

  // Natural deep-water base light: cold blue-teal from far above (the memory
  // of a surface kilometres up), near-black blue below. Red is long dead at
  // this depth — only the flashlight brings warmth back.
  scene.add(new THREE.HemisphereLight(0x12303e, 0x010407, 0.2));
  const gloom = new THREE.DirectionalLight(0x2c5566, 0.07);
  gloom.position.set(2, 40, 1);
  scene.add(gloom);

  createFlashlight();
  createLocalBody();
  initCatfishSystem(scene);
  setGoudaScene(scene); // the Golden Gouda mounts itself here when it spawns
  createSnow();
  createBubbles();
  createBursts();
  createPlankton();
  createBreath();

  window.addEventListener("resize", onResize);

  return renderer.domElement;
}

// Generates the gouda labyrinth asynchronously (chunk by chunk) so the
// loading screen can track progress. Call after initGraphics, await before
// spawning the player. opts: { seed, difficulty }.
export function loadWorld(
  onProgress: WorldProgress,
  opts: WorldOptions,
): ReturnType<typeof buildGoudaWorld> {
  return buildGoudaWorld(scene, onProgress, opts).then((world) => {
    // The tin bell berths over the spawn — the O₂ recharge zone gets a body.
    mountBathyscaphe(scene, getSpawnPoint());
    return world;
  });
}

// Tears down the current world and builds a new one (e.g. adopting the
// host's seed after joining).
export function rebuildWorld(
  onProgress: WorldProgress,
  opts: WorldOptions,
): ReturnType<typeof buildGoudaWorld> {
  disposeWorld(scene);
  return buildGoudaWorld(scene, onProgress, opts).then((world) => {
    mountBathyscaphe(scene, getSpawnPoint()); // re-berth over the new spawn
    return world;
  });
}

// Smoothly retunes the fog to the player's current layer. Returns current
// visibility (used for fog-aware culling).
function fogDensityFor(radius: number): number {
  const bands = FOG_BANDS;
  if (radius <= bands[0][0]) return bands[0][1];
  for (let i = 1; i < bands.length; i++) {
    if (radius < bands[i][0]) {
      const [r0, d0] = bands[i - 1];
      const [r1, d1] = bands[i];
      const t = (radius - r0) / (r1 - r0);
      return d0 + (d1 - d0) * t;
    }
  }
  return bands[bands.length - 1][1];
}

function updateAtmosphere(delta: number): number {
  const radius = camera.position.length();
  const target = fogDensityFor(radius);
  const k = Math.min(1, delta * 0.7); // slow, diver-paced transition
  const fog = scene.fog as THREE.FogExp2; // set in initGraphics
  fog.density += (target - fog.density) * k;

  // Depth-graded water column: the fog (and the void behind it) is a ghost
  // of teal when you're high in the water, and crushes toward blue-black as
  // you sink. This vertical hue gradient is what makes the void read as a
  // MEDIUM instead of empty space.
  const y = camera.position.y;
  let t = (y + 120) / 300; // -120 → 0 (deep), +180 → 1 (shallow)
  t = Math.max(0, Math.min(1, t));
  t = t * t * (3 - 2 * t);
  _fogColor.copy(ABYSS_DEEP).lerp(ABYSS_SHALLOW, t);
  fog.color.lerp(_fogColor, k);
  (scene.background as THREE.Color).copy(fog.color);

  return 3 / fog.density; // ~visibility in world units
}

function setupPostProcessing() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.3,
    0.8,
    0.88,
  );
  composer.addPass(bloom);

  horrorPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float uTime;
      varying vec2 vUv;

      void main() {
        // WATER REFRACTION — two overlapping slow wave fields, strong enough
        // to feel (space is rigid; water is never still).
        vec2 uv = vUv;
        uv += vec2(
          sin(uv.y * 14.0 + uTime * 0.45) + sin(uv.y * 31.0 - uTime * 0.7) * 0.5,
          cos(uv.x * 12.0 - uTime * 0.38) + cos(uv.x * 27.0 + uTime * 0.6) * 0.5
        ) * 0.0011;

        // Chromatic dispersion — light splitting through the water/visor,
        // strongest at the edges of the view.
        vec2 toC = vUv - vec2(0.5);
        float d = length(toC);
        vec2 ca = toC * d * 0.006;
        vec3 col;
        col.r = texture2D(tDiffuse, uv - ca).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv + ca).b;

        // HIGHLIGHT COMPRESSOR — nose-to-the-wall the torch core pushes
        // values far past 1.0 and whites out the whole view. Roll everything
        // above 1.0 onto a soft shoulder (caps at ~2.0) so close surfaces
        // stay bright but always keep their detail.
        vec3 over = max(col - 1.0, vec3(0.0));
        col = min(col, vec3(1.0)) + over / (1.0 + over);

        // UNDERWATER GRADE — red is absorbed by the water column: crush the
        // shadows toward teal while the (flashlight-lit) highlights keep
        // their warmth. Split-tone by luminance.
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(col, vec3(lum), 0.08);
        vec3 shadowGrade = col * vec3(0.68, 0.92, 1.05);
        vec3 lightGrade  = col * vec3(1.05, 1.00, 0.88);
        col = mix(shadowGrade, lightGrade, smoothstep(0.06, 0.55, lum));

        // The blue floor: barely-there teal in the darkest values — enough
        // to read as water, kept whisper-faint so the abyss stays BLACK.
        float dark = 1.0 - smoothstep(0.0, 0.16, lum);
        col += vec3(0.0015, 0.005, 0.008) * dark;

        // Heavy diving-mask vignette.
        col *= smoothstep(0.92, 0.30, d);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  composer.addPass(horrorPass);
  composer.addPass(new OutputPass());
}

// --- Shared helpers: volumetric beam + scatter halo ---------------------

// Fresnel-soft additive cone with distance falloff and drifting wisps.
// `falloffPow` shapes how quickly it dims with distance: high (~1.6) for a
// tight bright core, low (~0.6) for a slow-dimming diffuse haze.
function createBeam({
  length,
  endRadius,
  tint,
  strength,
  falloffPow = 1.6,
}: BeamOptions): THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial> {
  const geo = new THREE.CylinderGeometry(0.03, endRadius, length, 32, 8, true);
  geo.translate(0, -length / 2, 0);
  geo.rotateX(Math.PI / 2); // extend along -Z

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 1 },
      uColor: { value: new THREE.Color(tint) },
      uStrength: { value: strength },
      uFalloffPow: { value: falloffPow },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uIntensity;
      uniform vec3 uColor;
      uniform float uStrength;
      uniform float uFalloffPow;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vViewDir;

      void main() {
        float along = 1.0 - vUv.y; // 0 at the lens, 1 at the far end

        // Bright core near the source, dimming with distance travelled.
        float axial = pow(1.0 - along, uFalloffPow);

        // Soft edges: strongest through the middle of the cone (more medium
        // to scatter through), fading at silhouette edges.
        float facing = abs(dot(normalize(vNormal), normalize(vViewDir)));
        float body = pow(facing, 1.35);

        // Drifting particulate wisps — the water is alive inside the beam.
        float wisp = 0.78
          + 0.14 * sin(along * 26.0 - uTime * 1.6 + vUv.x * 12.566)
          + 0.08 * sin(along * 11.0 - uTime * 0.9 + vUv.x * 25.13);

        float a = axial * body * wisp * uStrength * uIntensity;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });

  beamMaterials.push(material);
  return new THREE.Mesh(geo, material);
}

let haloTexture: THREE.CanvasTexture | null = null;
function getHaloTexture(): THREE.CanvasTexture {
  if (haloTexture) return haloTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,252,240,0.9)");
  grad.addColorStop(0.25, "rgba(255,238,200,0.35)");
  grad.addColorStop(0.6, "rgba(235,210,150,0.08)");
  grad.addColorStop(1, "rgba(215,185,120,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  haloTexture = new THREE.CanvasTexture(canvas);
  return haloTexture;
}

// Soft scatter glow around a lamp — light bleeding into the murk.
function createHalo(
  size: number,
  opacity: number,
  color: THREE.ColorRepresentation = 0xf2e6c2,
): THREE.Sprite {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: getHaloTexture(),
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  sprite.scale.setScalar(size);
  return sprite;
}

// A lamp's full volumetric presence: a tight bright core, a wider soft haze
// scattering out past it (so the beam has visible bulk, not a hard edge),
// and camera-facing glow puffs spaced along the axis. The puffs shrink and
// dim with distance, giving a clear read on how far the light throws and
// how much it has dispersed even when no floor or wall is in view to catch it.
function createVolumetricLight({
  length,
  endRadius,
  tint,
  strength,
}: BeamOptions) {
  const group = new THREE.Group();

  const beam = createBeam({ length, endRadius, tint, strength });
  group.add(beam);

  const haze = createBeam({
    length,
    endRadius: endRadius * 2.2,
    tint,
    strength: strength * 0.4,
    falloffPow: 0.6,
  });
  group.add(haze);

  const halos = [0.18, 0.45, 0.78].map((f) => {
    const halo = createHalo(endRadius * (0.55 + f), 0.16 * (1 - f * 0.7), tint);
    halo.position.z = -length * f;
    group.add(halo);
    return halo;
  });

  return { group, beam, haze, halos };
}

// --- World -----------------------------------------------------------------
// The gouda labyrinth itself lives in gouda.js (buildGoudaWorld).

// The local torch is HELMET-MOUNTED now (the model carries it on the
// helmet): parked just above the camera and parented to it, so the light is
// always exactly aligned with where the camera looks.
//
// Unlike remote divers there is NO volumetric beam mesh in your own view —
// from a lamp on your own forehead it just reads as fog on the screen.
// Instead: a wide soft-edged hot cone, a broad spill that washes the whole
// view ("halo where I look"), and a short-range fill so your own hands and
// the wall in front of your face are never pitch black.
function createFlashlight(): void {
  const group = new THREE.Group();

  // Hot core: wide and soft-edged, shadow-casting. Warm dive-torch tint.
  const spot = new THREE.SpotLight(
    0xfff1cd,
    FLASHLIGHT_INTENSITY,
    65,
    0.44,
    0.75,
    1.7,
  );
  spot.position.set(0, 0, -0.1);
  spot.target.position.set(0, -0.1, -29.5);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.camera.near = 0.3;
  spot.shadow.camera.far = 65;
  spot.shadow.bias = -0.0002;
  // Organic marching-cubes surfaces self-shadow badly with a pure depth
  // bias (shimmering acne). normalBias pushes samples along the normal —
  // the standard fix for curved geometry.
  spot.shadow.normalBias = 0.08;
  group.add(spot);
  group.add(spot.target);

  // Broad soft spill — covers most of the field of view, so wherever you
  // look gets at least a soft wash of light. Cooler than the hot core:
  // water scatters the torch's edges toward green-blue.
  const spill = new THREE.SpotLight(
    0xc4d8c2,
    SPILL_INTENSITY,
    35,
    1.05,
    1.0,
    1.6,
  );
  spill.position.set(0, 0, -0.1);
  spill.target = spot.target;
  group.add(spill);

  // Short-range fill: lights your own hands/arms and the wall right in
  // front of your visor, independent of the cones. Kept very dim so your
  // own body barely catches the light and the abyss stays scary.
  const fill = new THREE.PointLight(0xf0e0b4, 0.4, 5, 1.8);
  fill.position.set(0, -0.05, -0.3);
  group.add(fill);

  // (No lens halo sprite on your own lamp: from a light on your own
  // forehead it just reads as a glowing circle stuck to the screen.)

  // Helmet position: slightly above the eyes, nudged forward.
  group.position.set(0, 0.2, -0.12);
  camera.add(group);

  flashlight = { group, spot, spill, fill, on: true };
}

// Shot harness (shots.js, ?light=N): flat inspection light so first-person
// geometry reads clearly in screenshots. Never used in a real session.
export function addShotLight(intensity: number = 1.5): void {
  scene.add(new THREE.HemisphereLight(0xbfd8e0, 0x4a4236, intensity));
}

export function toggleFlashlight(): boolean {
  return setFlashlight(!flashlight.on);
}

// Drive the torch directly. Used by the haul (G4): while you carry the
// Golden Gouda your own lamp is off and the wheel is the party's light — so
// the state has to be forced, not toggled from wherever it happened to be.
export function setFlashlight(on: boolean): boolean {
  flashlight.on = on;
  flashlight.spot.visible = on;
  flashlight.spill.visible = on;
  flashlight.fill.visible = on;
  return flashlight.on;
}

// --- Particles ---------------------------------------------------------

// Marine snow, LIT by up to two beam cones (local + remote flashlight).
function createSnow(): void {
  const positions = new Float32Array(SNOW_COUNT * 3);
  const scales = new Float32Array(SNOW_COUNT);
  const offsets = new Float32Array(SNOW_COUNT);

  for (let i = 0; i < SNOW_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 2 * SNOW_RADIUS;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 2 * SNOW_RADIUS;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 2 * SNOW_RADIUS;
    scales[i] = 0.5 + Math.random() * 1.5;
    offsets[i] = Math.random() * 100;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aScale", new THREE.BufferAttribute(scales, 1));
  geometry.setAttribute("aOffset", new THREE.BufferAttribute(offsets, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uLightPos: { value: [new THREE.Vector3(), new THREE.Vector3()] },
      uLightDir: {
        value: [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, -1)],
      },
      uLightOn: { value: [1.0, 0.0] },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uPixelRatio;
      uniform vec3 uLightPos[2];
      uniform vec3 uLightDir[2];
      uniform float uLightOn[2];
      attribute float aScale;
      attribute float aOffset;
      varying float vAlpha;
      varying float vLit;

      float beamFactor(vec3 wp, vec3 lp, vec3 ld, float on) {
        vec3 toP = wp - lp;
        float along = dot(toP, ld);
        if (along < 0.4 || along > 32.0) return 0.0;
        float coneR = along * 0.42;
        float radial = length(toP - ld * along);
        return smoothstep(coneR, coneR * 0.3, radial)
          * exp(-along * 0.09) * on;
      }

      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.30 + aOffset) * 0.5;
        p.z += cos(uTime * 0.22 + aOffset * 1.7) * 0.5;

        vLit = beamFactor(p, uLightPos[0], uLightDir[0], uLightOn[0])
             + beamFactor(p, uLightPos[1], uLightDir[1], uLightOn[1]);

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = aScale * uPixelRatio * (26.0 / -mv.z);
        vAlpha = smoothstep(30.0, 3.0, -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying float vLit;
      void main() {
        float d = distance(gl_PointCoord, vec2(0.5));
        float lit = min(vLit, 1.2);
        // Barely visible in the dark; blazing motes inside a beam.
        float a = smoothstep(0.5, 0.08, d) * vAlpha * (0.10 + lit * 0.9);
        // Cool grey-blue motes in the dark; warm only inside a torch beam.
        vec3 col = mix(vec3(0.42, 0.50, 0.55), vec3(1.0, 0.95, 0.8), lit);
        gl_FragColor = vec4(col * (1.0 + lit * 2.0), a);
      }
    `,
  });

  snow = new THREE.Points(geometry, material);
  scene.add(snow);
}

function createBubbles(): void {
  const positions = new Float32Array(BUBBLE_COUNT * 3);
  for (let i = 0; i < BUBBLE_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 2 * BUBBLE_RADIUS;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 2 * BUBBLE_RADIUS;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 2 * BUBBLE_RADIUS;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: 0xc9e6d4,
    size: 0.07,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });

  bubbles = new THREE.Points(geometry, material);
  scene.add(bubbles);
}

// Occasional bubble bursts: a vent exhales, a cluster races for the surface.
function createBursts(): void {
  const total = BURSTS * BURST_PARTICLES;
  const positions = new Float32Array(total * 3);
  const seeds = new Float32Array(total);
  const burstIndex = new Float32Array(total);

  for (let i = 0; i < total; i++) {
    seeds[i] = Math.random();
    burstIndex[i] = Math.floor(i / BURST_PARTICLES);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute("aBurst", new THREE.BufferAttribute(burstIndex, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uAlphas: { value: new Array(BURSTS).fill(0) },
    },
    vertexShader: /* glsl */ `
      uniform float uPixelRatio;
      uniform float uAlphas[${BURSTS}];
      attribute float aSeed;
      attribute float aBurst;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = (1.6 + aSeed * 2.4) * uPixelRatio * (22.0 / -mv.z);
        vAlpha = uAlphas[int(aBurst)] * smoothstep(26.0, 3.0, -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        float d = distance(gl_PointCoord, vec2(0.5));
        float ring = smoothstep(0.5, 0.30, d) - smoothstep(0.28, 0.05, d) * 0.55;
        gl_FragColor = vec4(0.92, 0.88, 0.68, ring * vAlpha * 0.6);
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  const states: BurstState[] = [];
  for (let i = 0; i < BURSTS; i++) {
    states.push({
      origin: new THREE.Vector3(),
      age: -(2 + Math.random() * 10), // negative age = waiting
      duration: 3.2 + Math.random() * 1.6,
    });
  }
  bursts = { points, states };
}

// Fire a bubble burst on demand (e.g. a dig tearing gas pockets out of the
// cheese). Steals the burst slot that's furthest from being visible.
export function burstAt(x: number, y: number, z: number): void {
  if (!bursts) return;
  let best: BurstState | null = null;
  for (const s of bursts.states) {
    if (best === null || s.age < best.age) best = s;
  }
  best!.origin.set(x, y, z);
  best!.age = 0;
  best!.duration = 2.2 + Math.random();
}

function respawnBurst(state: BurstState): void {
  // A pocket of gas escaping the cheese somewhere below/around the diver.
  const angle = Math.random() * Math.PI * 2;
  const dist = 5 + Math.random() * 13;
  const x = camera.position.x + Math.cos(angle) * dist;
  const z = camera.position.z + Math.sin(angle) * dist;
  const y = camera.position.y - (4 + Math.random() * 10);
  state.origin.set(x, y, z);
  state.age = -(3 + Math.random() * 9);
  state.duration = 3.2 + Math.random() * 1.6;
}

function updateBursts(delta: number): void {
  const positions = bursts.points.geometry.attributes.position;
  const seeds = bursts.points.geometry.attributes.aSeed;
  const alphas = bursts.points.material.uniforms.uAlphas.value;

  for (let b = 0; b < BURSTS; b++) {
    const state = bursts.states[b];
    state.age += delta;

    if (state.age < 0) {
      alphas[b] = 0;
      continue;
    }
    if (state.age > state.duration) {
      respawnBurst(state);
      alphas[b] = 0;
      continue;
    }

    const p = state.age / state.duration;
    alphas[b] = Math.sin(Math.PI * Math.min(p, 1)) * 0.9;

    for (let i = 0; i < BURST_PARTICLES; i++) {
      const idx = b * BURST_PARTICLES + i;
      const seed = seeds.getX(idx);
      const rise = state.age * (1.4 + seed * 1.3);
      const spread = state.age * (0.15 + seed * 0.35);
      const wob = Math.sin(elapsed * (2.0 + seed * 3.0) + seed * 40.0) * 0.12;
      positions.setXYZ(
        idx,
        state.origin.x + Math.cos(seed * 6.283) * spread + wob,
        state.origin.y + rise,
        state.origin.z + Math.sin(seed * 6.283) * spread - wob,
      );
    }
  }
  positions.needsUpdate = true;
}

// --- Plankton: sparse bioluminescent drifters. Most of the time they're
// nearly invisible; each one blinks awake on its own slow cycle — tiny cyan
// lives in the dark. Nothing says "you are in water" like the water being
// inhabited.
function createPlankton(): void {
  const positions = new Float32Array(PLANKTON_COUNT * 3);
  const seeds = new Float32Array(PLANKTON_COUNT);
  for (let i = 0; i < PLANKTON_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 2 * PLANKTON_RADIUS;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 2 * PLANKTON_RADIUS;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 2 * PLANKTON_RADIUS;
    seeds[i] = Math.random() * 100;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uPixelRatio;
      attribute float aSeed;
      varying float vBlink;
      void main() {
        vec3 p = position;
        // Each drifter wanders on its own little orbit.
        p.x += sin(uTime * 0.21 + aSeed) * 0.9;
        p.y += sin(uTime * 0.17 + aSeed * 2.3) * 0.6;
        p.z += cos(uTime * 0.19 + aSeed * 1.1) * 0.9;

        // Slow personal blink cycle: long dark, brief soft flash.
        float cyc = sin(uTime * (0.10 + fract(aSeed) * 0.14) + aSeed * 7.0);
        vBlink = smoothstep(0.86, 0.985, cyc);

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (1.5 + fract(aSeed * 3.7) * 2.0) * uPixelRatio
          * (30.0 / -mv.z) * (0.6 + vBlink);
        vBlink *= smoothstep(28.0, 6.0, -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vBlink;
      void main() {
        float d = distance(gl_PointCoord, vec2(0.5));
        float a = smoothstep(0.5, 0.05, d) * vBlink;
        gl_FragColor = vec4(vec3(0.35, 0.95, 0.95) * (0.6 + vBlink), a * 0.85);
      }
    `,
  });

  plankton = new THREE.Points(geometry, material);
  scene.add(plankton);
}

// --- Breath bubbles: your own exhale. A slot ring of bubbles; emitBreath()
// (driven by the audio engine's breathing cycle, or a fallback timer)
// releases a small cluster just behind the visor that wobbles surfaceward.
function createBreath(): void {
  const positions = new Float32Array(BREATH_COUNT * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: 0xcfe8e4,
    size: 0.09,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  const states: BreathState[] = [];
  for (let i = 0; i < BREATH_COUNT; i++) {
    states.push({ x: 0, y: -9999, z: 0, age: 99, seed: Math.random() });
  }
  breath = { points, states, cursor: 0 };
}

// Release a cluster of exhale bubbles at the diver's helmet.
export function emitBreath(count: number = 5): void {
  if (!breath) return;
  camera.getWorldPosition(_v1);
  for (let n = 0; n < count; n++) {
    const s = breath.states[breath.cursor];
    breath.cursor = (breath.cursor + 1) % BREATH_COUNT;
    s.x = _v1.x + (Math.random() - 0.5) * 0.25;
    s.y = _v1.y + 0.15 + Math.random() * 0.1;
    s.z = _v1.z + (Math.random() - 0.5) * 0.25;
    s.age = -n * 0.09; // stagger the cluster
    s.seed = Math.random();
  }
}

function updateBreath(delta: number): void {
  const positions = breath.points.geometry.attributes.position;
  for (let i = 0; i < BREATH_COUNT; i++) {
    const s = breath.states[i];
    s.age += delta;
    if (s.age < 0 || s.age > 6) {
      positions.setXYZ(i, 0, -9999, 0);
      continue;
    }
    const wob = Math.sin(elapsed * (3.0 + s.seed * 3.0) + s.seed * 40.0) * 0.06;
    positions.setXYZ(
      i,
      s.x + wob,
      s.y + s.age * (0.9 + s.seed * 0.5),
      s.z - wob,
    );
  }
  positions.needsUpdate = true;
}

// Slow-changing current direction (Perlin-driven), with occasional gusts.
// Returns a reused scratch object — called once per frame from renderLoop.
const _drift = { x: 0, z: 0 };
function currentDrift(): { x: number; z: number } {
  const gust =
    Math.pow(Math.max(0, noise.noise(elapsed * 0.07, 5.5, 0)), 2) * 3;
  _drift.x = noise.noise(elapsed * 0.04, 11.3, 0) * (0.6 + gust);
  _drift.z = noise.noise(elapsed * 0.04, 29.1, 0) * (0.6 + gust);
  return _drift;
}

function wrapAroundCamera(
  points: THREE.Points,
  radius: number,
  fall: number,
  delta: number,
  drift: { x: number; z: number },
): void {
  const positions = points.geometry.attributes.position;
  const c = camera.position;
  const size = radius * 2;
  for (let i = 0; i < positions.count; i++) {
    let x = positions.getX(i) + drift.x * delta;
    let y = positions.getY(i) + fall * delta * (0.7 + (i % 5) * 0.12);
    let z = positions.getZ(i) + drift.z * delta;

    if (x - c.x > radius) x -= size;
    else if (x - c.x < -radius) x += size;
    if (y - c.y > radius) y -= size;
    else if (y - c.y < -radius) y += size;
    if (z - c.z > radius) z -= size;
    else if (z - c.z < -radius) z += size;

    positions.setXYZ(i, x, y, z);
  }
  positions.needsUpdate = true;
}

// --- Remote divers -------------------------------------------------------

export function addPlayer(id: string, color: THREE.ColorRepresentation): void {
  if (players.has(id)) return;

  const group = new THREE.Group();
  const pivot = new THREE.Group();
  group.add(pivot);

  // Placeholder shown until the GLB loads (visor glow included).
  const placeholder = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.32, 0.65, 8, 16),
    toonMaterial({ color: 0x161e23 }),
  );
  body.rotation.x = Math.PI / 2;
  body.castShadow = true;
  placeholder.add(body);
  const visor = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 12, 12),
    toonMaterial({ color, emissive: color, emissiveIntensity: 2.5 }),
  );
  visor.position.set(0, 0.15, -0.5);
  placeholder.add(visor);
  pivot.add(placeholder);

  // Headlamp rig — initially mounted on the pivot; reparented into the
  // helmet torch once the model loads.
  const spot = new THREE.SpotLight(
    0xffeec9,
    REMOTE_LAMP_INTENSITY,
    50,
    0.5,
    0.6,
    1.7,
  );
  spot.position.set(0, 0.05, -0.6);
  spot.target.position.set(0, 0.05, -20);
  spot.castShadow = true;
  spot.shadow.mapSize.set(512, 512);
  spot.shadow.bias = -0.0002;
  spot.shadow.normalBias = 0.08;
  pivot.add(spot);
  pivot.add(spot.target);

  // Fat, readable cone — a remote beam is mostly seen side-on, where a
  // narrow cone collapses into a thin ray.
  const beam = createVolumetricLight({
    length: 22,
    endRadius: 4.6,
    tint: 0xd9c684,
    strength: 0.42,
  }).group;
  beam.position.set(0, 0.05, -0.6);
  pivot.add(beam);

  const halo = createHalo(2.0, 0.3);
  halo.position.set(0, 0.05, -0.7);
  pivot.add(halo);

  const glow = new THREE.PointLight(color, 1.8, 12, 2);
  pivot.add(glow);

  scene.add(group);
  const player: RemotePlayer = {
    group,
    pivot,
    placeholder,
    spot,
    beam,
    halo,
    glow,
    color,
    rig: null,
    torch: null,
    headGlow: null,
    // Look (head/torch) vs lazy body orientation, synced from the peer.
    lookYaw: 0,
    lookPitch: 0,
    swimYaw: 0,
    swimPitch: 0,
    bodyPitchSm: 0,
    // Velocity estimated from interpolated positions — drives the remote
    // diver's kick effort and direction adaptation with no protocol change.
    velEst: new THREE.Vector3(),
    lastPos: new THREE.Vector3(),
    hasLast: false,
    carrying: false,
  };
  players.set(id, player);

  loadDiverTemplate().then((template) => {
    if (!template || !players.has(id)) return;

    const rig = createDiverRig(template);
    pivot.add(rig.root);
    player.rig = rig;
    placeholder.visible = false;

    // --- Helmet torch: the model carries it on the helmet; the LIGHT rig
    // lives at scene level (unit scale, so beam/halo sizes stay world-true)
    // and is snapped to the head's world pose every frame — always aligned
    // with wherever the diver's camera looks.
    const torch = new THREE.Group();
    torch.add(spot);
    spot.position.set(0, 0, 0);
    torch.add(spot.target);
    spot.target.position.set(0, 0, -20);
    torch.add(beam);
    beam.position.set(0, 0, -0.06);
    torch.add(halo);
    halo.position.set(0, 0, -0.1);
    scene.add(torch);
    player.torch = torch;

    // --- Colored glow following the diver's helmet (scene level too). ---
    const headGlow = new THREE.Group();
    headGlow.add(createHalo(0.9, 0.55, color));
    glow.position.set(0, 0, 0);
    headGlow.add(glow);
    scene.add(headGlow);
    player.headGlow = headGlow;
  });
}

// --- Remote diver per-frame update: estimate velocity, run the procedural
// swim (diverRig.js), then pin the helmet torch + glow to the head.
function updateRemoteDiver(player: RemotePlayer, delta: number): void {
  const rig = player.rig;
  if (!rig) return;

  const p = player.group.position;
  if (!player.hasLast) {
    player.lastPos.copy(p);
    player.hasLast = true;
  }
  if (delta > 1e-4) {
    _v1.copy(p).sub(player.lastPos).divideScalar(delta);
    player.velEst.lerp(_v1, Math.min(1, delta * 6));
  }
  player.lastPos.copy(p);

  // Body follows the peer's lazy swim orientation; the head (and torch)
  // aims at their true look — so you SEE them turn their head. Like the
  // local body, the visual pitch stays level at rest and only aligns with
  // the swim direction as they pick up speed.
  const align = Math.min(1, player.velEst.length() / 2.5);
  player.bodyPitchSm +=
    (player.swimPitch * align - player.bodyPitchSm) * Math.min(1, delta * 3);
  player.group.rotation.y = player.swimYaw;
  player.pivot.rotation.x = player.bodyPitchSm;
  updateDiverRig(rig, delta, {
    bodyYaw: player.swimYaw,
    bodyPitch: player.bodyPitchSm,
    lookYaw: player.lookYaw,
    lookPitch: player.lookPitch,
    vel: player.velEst,
    carrying: player.carrying,
  });

  // Torch beam leaves the helmet along the exact look direction.
  // (torch/headGlow are created in the same then() that set `rig`.)
  _v1.copy(TORCH_OFFSET).applyQuaternion(rig.lookQuat);
  player.torch!.position.copy(rig.headPos).add(_v1);
  player.torch!.quaternion.copy(rig.lookQuat);

  player.headGlow!.position.copy(rig.headPos);
}

export function removePlayer(id: string): void {
  const player = players.get(id);
  if (!player) return;
  for (const obj of [player.group, player.torch, player.headGlow]) {
    if (!obj) continue;
    scene.remove(obj);
    obj.traverse((child: SceneChild) => {
      child.geometry?.dispose();
      if (child.material?.dispose) {
        child.material.dispose();
        // The volumetric beam registered its material for the shared uTime
        // update — unregister, or the render loop feeds disposed materials
        // forever (and the array grows with every join).
        const bi = beamMaterials.indexOf(
          child.material as THREE.ShaderMaterial,
        );
        if (bi !== -1) beamMaterials.splice(bi, 1);
      }
      // Lights own GPU-side shadow maps (the spot's 512² depth target) that
      // material/geometry disposal doesn't touch.
      if ((child as unknown as THREE.Light).isLight)
        (child as unknown as THREE.Light).dispose();
    });
  }
  players.delete(id);
}

export function updatePlayerPosition(
  id: string,
  x: number,
  y: number,
  z: number,
  yaw: number | null = null,
  pitch: number | null = null,
  swimYaw: number | null = null,
  swimPitch: number | null = null,
): void {
  const player = players.get(id);
  if (!player) return;
  player.group.position.set(x, y, z);
  // Look (head + torch) and lazy body orientation are tracked separately;
  // updateRemoteDiver applies them so the head visibly turns on the body.
  if (yaw !== null) player.lookYaw = yaw;
  if (pitch !== null) player.lookPitch = pitch;
  player.swimYaw = swimYaw ?? yaw ?? player.swimYaw;
  player.swimPitch = swimPitch ?? pitch ?? player.swimPitch;
}

// Their replicated STATUS.CARRYING bit, pushed in by main.ts the same way
// their flashlight is — the rig holds the wheel with both arms while it is
// set, so the wheel you see in their hands is the one holdPose() put there.
export function setPlayerCarrying(id: string, carrying: boolean): void {
  const player = players.get(id);
  if (player) player.carrying = carrying;
}

export function setPlayerLight(id: string, on: boolean): void {
  const player = players.get(id);
  if (!player) return;
  player.spot.visible = on;
  player.beam.visible = on;
  player.halo.visible = on;
}

export function updateCamera(
  playerPos: Vec3,
  yaw: number,
  pitch: number,
  speed: number = 0,
  roll: number = 0,
): void {
  // BUOYANCY — a visual-only sway layered on the simulated position. Water
  // never holds you perfectly still: a slow vertical heave, a hint of side
  // drift, and a breathing roll. Fades as swim speed takes over.
  const idle = 1 - Math.min(1, moveFactor * 2.5);
  const heave =
    Math.sin(elapsed * 0.45) * 0.05 + Math.sin(elapsed * 0.9) * 0.02;
  const surgeX = Math.sin(elapsed * 0.31 + 1.7) * 0.03;
  camera.position.set(
    playerPos.x + surgeX * idle,
    playerPos.y + heave * idle,
    playerPos.z + Math.cos(elapsed * 0.27) * 0.03 * idle,
  );
  camera.rotation.y = yaw;
  camera.rotation.x = pitch + Math.sin(elapsed * 0.5) * 0.0035 * idle;
  // Subtle bank into turns + buoyant roll (order YXZ: applied last).
  camera.rotation.z = roll + Math.sin(elapsed * 0.23) * 0.004 * idle;
  moveFactor += (speed - moveFactor) * 0.05;
}

// Helmet-mounted = much steadier than the old hand-held sway: just a faint
// breathing bob, growing slightly with swim speed.
function animateFlashlight(): void {
  if (!flashlight) return;
  const t = elapsed;
  const bob = 1 + moveFactor * 2;
  flashlight.group.position.x = Math.sin(t * 1.1) * 0.003 * bob;
  flashlight.group.position.y =
    0.2 + Math.sin(t * 2.3) * 0.004 + Math.sin(t * 3.7) * 0.003 * moveFactor;
  flashlight.group.rotation.x = Math.sin(t * 1.7) * 0.004 * bob;
}

// Feed the snow shader the two beam poses (local + first remote).
function updateSnowLightUniforms(): void {
  const u = snow.material.uniforms;

  flashlight.spot.getWorldPosition(u.uLightPos.value[0]);
  flashlight.spot.target.getWorldPosition(_v1);
  u.uLightDir.value[0].copy(_v1).sub(u.uLightPos.value[0]).normalize();
  u.uLightOn.value[0] = flashlight.on ? 1 : 0;

  let remoteLit = 0;
  for (const player of players.values()) {
    if (!player.spot.visible) continue;
    player.spot.getWorldPosition(u.uLightPos.value[1]);
    player.spot.target.getWorldPosition(_v2);
    u.uLightDir.value[1].copy(_v2).sub(u.uLightPos.value[1]).normalize();
    remoteLit = 1;
    break;
  }
  u.uLightOn.value[1] = remoteLit;
}

function applyResize(): void {
  resizeFrame = null;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const pixelRatio = renderPixelRatio();

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  if (renderer.getPixelRatio() !== pixelRatio) {
    renderer.setPixelRatio(pixelRatio);
    composer.setPixelRatio(pixelRatio);
  }
  renderer.setSize(width, height);
  composer.setSize(width, height);
}

function onResize(): void {
  if (resizeFrame !== null) return;
  resizeFrame = requestAnimationFrame(applyResize);
}

export function renderLoop(onFrame?: (delta: number) => void): void {
  const clock = new THREE.Clock();

  renderer.setAnimationLoop(() => {
    const delta = Math.min(clock.getDelta(), 0.1);
    elapsed = clock.elapsedTime;

    snow.material.uniforms.uTime.value = elapsed;
    plankton.material.uniforms.uTime.value = elapsed;
    horrorPass.uniforms.uTime.value = elapsed;
    for (const mat of beamMaterials) mat.uniforms.uTime.value = elapsed;

    const drift = currentDrift();
    // Snow SINKS slowly — suspension, not a starfield falling past a ship.
    wrapAroundCamera(snow, SNOW_RADIUS, -0.09, delta, drift);
    wrapAroundCamera(bubbles, BUBBLE_RADIUS, 0.85, delta, drift);
    wrapAroundCamera(plankton, PLANKTON_RADIUS, -0.015, delta, drift);
    updateBursts(delta);
    updateBreath(delta);

    animateFlashlight();

    if (onFrame) onFrame(delta);

    // After game logic moved players/camera: layer fog, bioluminescent pulse,
    // fog-aware culling, rig animation (helmet torch follows the moved head),
    // then feed the beam poses to the snow shader.
    const visibility = updateAtmosphere(delta);
    updateGouda(elapsed, camera.position, visibility);
    updateBathyscaphe(elapsed);
    updateLocalBody(delta);
    for (const player of players.values()) updateRemoteDiver(player, delta);
    updateSnowLightUniforms();
    composer.render();
  });
}
