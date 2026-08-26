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
import * as THREE from "three";
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";
import { buildForest, forestFor } from "./kelp.js";
import { createFauna } from "./fauna.js";
import { createCreature } from "./creature.js";
import { createAngler } from "./angler.js";
import { biolumeFor, biolumeDensity, FIELD_RADIUS, HEART_RADIUS } from "./biolume.js";
import { getCurrents, strengthOf, RADIUS as CURRENT_RADIUS } from "./current.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

// Water look per level: the backdrop colour and how much base light survives.
// There is no distance fog — the bell has to stay visible from anywhere.
const WATER_LOOKS = [
  { color: 0x0b2836, fog: 0.0075, ambient: 2.6 },
  { color: 0x04141e, fog: 0.017, ambient: 0.95 },
  { color: 0x00070c, fog: 0.031, ambient: 0.22 },
];
const WATER_FADE = 0.8; // per-second lerp toward the current level's look
const ALARM_FLASH = 1.1; // seconds for the red flash to bleed out

// Plankton blooms: a visible veil that drowns out light, but never visibility.

const HEMI_BASE = 0.16;
const GLOOM_BASE = 0.08;

const SNOW_COUNT = 2600;
const SNOW_RADIUS = 42;
const BUBBLE_COUNT = 460;
const BUBBLE_RADIUS = 22;
const BURSTS = 5;
const BURST_PARTICLES = 24;

const FLASHLIGHT_INTENSITY = 260;
const SPILL_INTENSITY = 90;
const REMOTE_LAMP_INTENSITY = 420;
const MAX_PIXEL_RATIO = 1.5;

const DIVER_MODEL_URL = `${import.meta.env.BASE_URL}models/diver.glb`;
const DIVER_SCALE = 0.45; // must match the diver model's own scale below

let scene;
let camera;
let renderer;
let composer;
let horrorPass;
let snow;
let bubbles;
let kelpForest;
const kelpTime = { value: 0 };
let kelpLevel = -1;
let bursts; // { points, states: [{origin, age, duration, delay}] }
let fauna;
let sparks; // { points, ages, head } — bioluminescence you stir up moving fast
let creature;
let angler;
let bloom; // the bioluminescent biome: the one place particles are the point
let bloomLevel = -1;
const currentMotes = []; // one mote cloud per flow, so each is visible
let swimSpeed = 0;
let flare; // { group, light, core, halo, dir, travelled, alive }
let resonance; // the triangulation hologram: shell / ring / twins / lock + buoys
let flashlight; // { group, spot, spill, beam, lens, halo, on }
let bellGroup;
let bellLight;
let bellBeacon;
let bellAlarm; // { light, halo, mat, t, strength }
let hemiLight;
let gloomLight;
let volumetric; // the local flashlight's beam materials, for the failing-lamp flicker
let dread = 0; // 0 near the surface, 1 in the dark — drives every horror effect
let elapsed = 0;
let fixedStep = false; // screenshot mode: a deterministic clock
let stepFrame = 0;
let moveFactor = 0;
let resizeFrame = null;
let nextShadowUpdate = 0;

let waterTarget = WATER_LOOKS[0];
const waterColor = new THREE.Color(WATER_LOOKS[0].color);
const waterCurrent = { ambient: WATER_LOOKS[0].ambient, fog: WATER_LOOKS[0].fog };

const players = new Map();
const noise = new ImprovedNoise();
const beamMaterials = []; // all volumetric beam materials (share uTime)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _c1 = new THREE.Color();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _q4 = new THREE.Quaternion();

let diverModelPromise = null;
function loadDiverModel() {
  diverModelPromise ??= new GLTFLoader()
    .loadAsync(DIVER_MODEL_URL)
    .catch(() => null);
  return diverModelPromise;
}

function renderPixelRatio() {
  return Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
}

export function initGraphics(container) {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(WATER_LOOKS[0].color);
  scene.fog = new THREE.FogExp2(WATER_LOOKS[0].color, WATER_LOOKS[0].fog);

  camera = new THREE.PerspectiveCamera(
    72,
    window.innerWidth / window.innerHeight,
    0.1,
    1200,
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
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  container.appendChild(renderer.domElement);

  setupPostProcessing();
  horrorPass.uniforms.uResolution.value.set(
    window.innerWidth,
    window.innerHeight,
  );

  // Natural deep-water base light: faint cool sky vs dead-black below.
  hemiLight = new THREE.HemisphereLight(0x0e2b42, 0x010407, HEMI_BASE);
  scene.add(hemiLight);
  gloomLight = new THREE.DirectionalLight(0x0e3149, GLOOM_BASE);
  gloomLight.position.set(2, 40, 1);
  scene.add(gloomLight);
  applyWaterLook();

  createDivingBell();
  createFlashlight();
  createSnow();
  createKelpForest();
  createBubbles();
  createBursts();
  createFlare();
  createResonance();
  createSparks();
  createBloom();
  createCurrentMotes();
  fauna = createFauna(scene, noise, createHalo);
  creature = createCreature(scene);
  angler = createAngler(scene);

  window.addEventListener("resize", onResize);

  return renderer.domElement;
}

function setupPostProcessing() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.3, // strength: lamps should stay hot POINTS, not glowing balls
    0.5, // radius
    0.82, // threshold
  );
  composer.addPass(bloom);

  horrorPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uDread: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uPixel: { value: 2.4 }, // screen pixels per rendered pixel
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
      uniform float uDread;
      uniform vec2 uResolution;
      uniform float uPixel;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      // Ordered dithering, computed arithmetically — GLSL ES 1.0 cannot index a
      // matrix array with a varying index.
      float bayer2(vec2 a) {
        a = floor(a);
        return fract(a.x / 2.0 + a.y * a.y * 0.75);
      }
      float bayer4(vec2 a) {
        return bayer2(0.5 * a) * 0.25 + bayer2(a);
      }

      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }

      void main() {
        // Snap to a coarser grid before anything else, so the whole image is
        // built out of chunky pixels rather than being blurred afterwards.
        vec2 grid = max(uResolution / uPixel, vec2(1.0));
        vec2 vUvP = (floor(vUv * grid) + 0.5) / grid;

        vec2 c = vUvP - 0.5;
        float r2 = dot(c, c);

        // The faceplate swells with your breathing, harder the deeper you are.
        float breath = 1.0 + sin(uTime * 0.55) * 0.0018 * (1.0 + uDread * 2.5);
        vec2 uv = c * breath + 0.5;

        // Water crawling over the glass: two octaves, so it never reads as a sine.
        vec2 flow = vec2(
          vnoise(uv * 6.0 + vec2(uTime * 0.09, uTime * 0.05)),
          vnoise(uv * 6.0 + vec2(11.3 - uTime * 0.07, 4.1 + uTime * 0.06))
        ) - 0.5;
        flow += (vec2(
          vnoise(uv * 17.0 - uTime * 0.13),
          vnoise(uv * 17.0 + 7.7 + uTime * 0.11)
        ) - 0.5) * 0.45;
        uv += flow * (0.0016 + uDread * 0.0022);

        // Curved glass: colour splits toward the rim...
        float ab = (0.0016 + uDread * 0.005) * r2 * 4.0;
        vec3 col;
        col.r = texture2D(tDiffuse, uv + c * ab).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - c * ab).b;

        // ...and smears radially, sharp in the middle, soft at the edges.
        float smear = r2 * (0.045 + uDread * 0.05);
        col += texture2D(tDiffuse, uv - c * smear).rgb * 0.35;
        col += texture2D(tDiffuse, uv - c * smear * 2.0).rgb * 0.18;
        col /= 1.53;

        // Salt and grease baked onto the visor — it only shows when lit.
        float smudge = vnoise(vUvP * vec2(9.0, 22.0)) * vnoise(vUvP * 31.0 + 3.0);
        col += smudge * dot(col, vec3(0.299, 0.587, 0.114)) * 0.5;

        // Grade: colour drains, shadows go cold, blacks crush to nothing.
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(col, vec3(lum), 0.24 + uDread * 0.34);
        col *= vec3(0.70, 0.94, 1.02);
        col += vec3(0.0, 0.020, 0.016) * (1.0 - smoothstep(0.0, 0.35, lum));
        col = max(col - (0.010 + uDread * 0.012), 0.0);
        col = pow(col, vec3(1.0 + uDread * 0.16));

        // Inside a bloom the water itself turns sickly and green.

        // The dark closes in with depth, and faster inside a bloom.
        float d = length(c);
        col *= smoothstep(0.92 - uDread * 0.32, 0.30 - uDread * 0.10, d);

        // Sensor grain — worst where there is no light for it to work with.
        float grain = hash(vUvP * 900.0 + fract(uTime) * 91.0) - 0.5;
        col += grain * (0.010 + uDread * 0.018);

        // Crush the palette and dither the banding. This is what gives cheap
        // geometry a filmic, oppressive texture rather than clean gradients.
        float steps = 52.0 - uDread * 14.0;
        col = floor(col * steps + bayer4(gl_FragCoord.xy)) / steps;

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
function createBeam({ length, endRadius, tint, strength, falloffPow = 1.6 }) {
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

let haloTexture = null;
function getHaloTexture() {
  if (haloTexture) return haloTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(0.25, "rgba(220,240,255,0.35)");
  grad.addColorStop(0.6, "rgba(180,220,255,0.08)");
  grad.addColorStop(1, "rgba(150,200,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  haloTexture = new THREE.CanvasTexture(canvas);
  return haloTexture;
}

// Soft scatter glow around a lamp — light bleeding into the murk.
function createHalo(size, opacity, color = 0xcfe6ff) {
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
function createVolumetricLight({ length, endRadius, tint, strength }) {
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

function createDivingBell() {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({
    color: 0x232b30,
    roughness: 0.55,
    metalness: 0.75,
  });

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1.6, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    metal,
  );
  dome.position.y = 3.4;
  dome.castShadow = true;
  group.add(dome);

  const cage = new THREE.Mesh(
    new THREE.CylinderGeometry(1.7, 1.9, 3.2, 10, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0x232b30,
      roughness: 0.6,
      metalness: 0.7,
      wireframe: true,
    }),
  );
  cage.position.y = 1.8;
  group.add(cage);

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(2.1, 2.3, 0.35, 12),
    metal,
  );
  base.position.y = 0.15;
  base.castShadow = true;
  group.add(base);

  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0xcfe8ff,
    emissive: 0xbfe0ff,
    emissiveIntensity: 3,
  });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), bulbMat);
    bulb.position.set(Math.cos(a) * 1.55, 3.1, Math.sin(a) * 1.55);
    group.add(bulb);
    const light = new THREE.PointLight(0xbfe0ff, 14, 24, 1.9);
    light.position.copy(bulb.position);
    group.add(light);
    const halo = createHalo(0.9, 0.22);
    halo.position.copy(bulb.position);
    group.add(halo);
    if (i === 2) bellLight = { light, bulb: bulb, halo, mat: bulbMat };
  }

  // Always-on marker: this is what guarantees the bell is never lost.
  bellBeacon = createHalo(1.5, 0.85);
  bellBeacon.material.fog = false; // haze must never hide the way home
  bellBeacon.position.y = 3.6;
  group.add(bellBeacon);

  // Suspension cable running up out of sight — the only way home.
  const cable = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 120, 6),
    new THREE.MeshStandardMaterial({
      color: 0x090e11,
      roughness: 0.95,
      metalness: 0.3,
    }),
  );
  cable.position.y = 64.6;
  cable.frustumCulled = false;
  group.add(cable);

  // Red alarm lamp: dark until it fires, then it floods the water around it.
  const alarmMat = new THREE.MeshStandardMaterial({
    color: 0x220404,
    emissive: 0xff1c08,
    emissiveIntensity: 0,
  });
  const alarmBulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 10, 10),
    alarmMat,
  );
  alarmBulb.position.set(0, 4.85, 0);
  group.add(alarmBulb);
  const alarmLight = new THREE.PointLight(0xff2a10, 0, 90, 1.5);
  alarmLight.position.copy(alarmBulb.position);
  group.add(alarmLight);
  const alarmHalo = createHalo(3.4, 0, 0xff3418);
  alarmHalo.position.copy(alarmBulb.position);
  group.add(alarmHalo);
  bellAlarm = { light: alarmLight, halo: alarmHalo, mat: alarmMat, t: 1, strength: 1 };

  group.position.set(0, 0, 0);
  scene.add(group);
  bellGroup = group;
}

// `strength` is unused now that the flash lives entirely on the bell.
export function flashBellAlarm() {
  bellAlarm.t = 0;
}

// 0 near the surface, 1 in the dark. Drives the shader, the lamp and the water.
export function setDread(value) {
  dread = value;
  horrorPass.uniforms.uDread.value = value;
}

// Plankton density (0..1) where the diver is standing.
// Kelp is real lit geometry, so the torch catches nearby blades while distant
// ones fall to silhouette — that contrast is what sells the depth of a forest.
function createKelpForest() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    emissive: 0x0c1811,
    emissiveIntensity: 0.55,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = kelpTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform float uTime;
         attribute float aSway;
         attribute float aPhase;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         float bend = abs(aSway - 0.5) * 2.0;
         transformed.x += sin(uTime * 0.4 + aPhase) * 1.5 * bend;
         transformed.z += cos(uTime * 0.33 + aPhase * 1.4) * 1.2 * bend;`,
      );
  };

  kelpForest = new THREE.Mesh(new THREE.BufferGeometry(), material);
  kelpForest.frustumCulled = false;
  kelpForest.visible = false;
  scene.add(kelpForest);
}

function rebuildKelp(level) {
  const forest = forestFor(level);
  const d = buildForest(forest.seed, (hex) => _c1.setHex(hex));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(d.position, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(d.normal, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(d.color, 3));
  g.setAttribute("aSway", new THREE.Float32BufferAttribute(d.sway, 1));
  g.setAttribute("aPhase", new THREE.Float32BufferAttribute(d.phase, 1));
  g.setIndex(d.index);
  kelpForest.geometry.dispose();
  kelpForest.geometry = g;
  kelpForest.position.set(forest.x, forest.y, forest.z);
  kelpForest.visible = true;
  kelpLevel = level;
}

export function setDepthLevel(level) {
  if (level !== kelpLevel && level >= 0) rebuildKelp(level);
  updateFields(level);
}

function updateAlarm(delta) {
  if (bellAlarm.t >= 1) return;
  bellAlarm.t = Math.min(bellAlarm.t + delta / ALARM_FLASH, 1);
  const fade = Math.pow(1 - bellAlarm.t, 2.2);
  bellAlarm.light.intensity = 420 * fade;
  bellAlarm.mat.emissiveIntensity = 7 * fade;
  bellAlarm.halo.material.opacity = 0.8 * fade;
}

export function setBellY(y) {
  bellGroup.position.y = y;
}

export function setWaterLevel(level) {
  // Level 1 is the first depth you get thrown out at, and it is the clear one.
  const i = Math.min(Math.max(level - 1, 0), WATER_LOOKS.length - 1);
  waterTarget = WATER_LOOKS[i];
}

function applyWaterLook() {
  scene.fog.density = waterCurrent.fog;
  hemiLight.intensity = HEMI_BASE * waterCurrent.ambient;
  gloomLight.intensity = GLOOM_BASE * waterCurrent.ambient;
}

// Eased so a level change reads as the light dying around you, not a cut.
function updateWater(delta) {
  const k = Math.min(delta * WATER_FADE, 1);
  waterCurrent.ambient += (waterTarget.ambient - waterCurrent.ambient) * k;
  waterCurrent.fog += (waterTarget.fog - waterCurrent.fog) * k;
  waterColor.lerp(_c1.set(waterTarget.color), k);
  scene.background.copy(waterColor);
  scene.fog.color.copy(waterColor);
  applyWaterLook();
}

function createFlashlight() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.045, 0.26, 16),
    new THREE.MeshStandardMaterial({
      color: 0x11181d,
      roughness: 0.4,
      metalness: 0.8,
    }),
  );
  body.rotation.x = Math.PI / 2;
  group.add(body);

  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.036, 16),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xe8f4ff,
      emissiveIntensity: 6,
    }),
  );
  lens.position.z = -0.135;
  group.add(lens);

  // Hot core: tight, shadow-casting.
  const spot = new THREE.SpotLight(
    0xe8f2ff,
    FLASHLIGHT_INTENSITY,
    65,
    0.3,
    0.55,
    1.25,
  );
  spot.position.set(0, 0, -0.1);
  spot.target.position.set(-0.34, 0.28, -29.5);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.camera.near = 0.3;
  spot.shadow.camera.far = 65;
  spot.shadow.bias = -0.0003;
  group.add(spot);
  group.add(spot.target);

  // Wide soft spill — real torches leak a corona around the hotspot.
  const spill = new THREE.SpotLight(
    0xbcd8ee,
    SPILL_INTENSITY,
    30,
    0.85,
    0.9,
    1.9,
  );
  spill.position.set(0, 0, -0.1);
  spill.target = spot.target;
  group.add(spill);

  // Long volumetric beam — core + haze + dispersal halos, visible even
  // with no floor in sight.
  volumetric = createVolumetricLight({
    length: 24,
    endRadius: 3.6,
    tint: 0x8fc6ee,
    strength: 0.22,
  });
  const beam = volumetric.group;
  beam.position.z = -0.12;
  group.add(beam);

  // Scatter halo at the lens. Small — this sits ~0.5 units from the camera,
  // so a "world-size" halo tuned for a distant remote light would look like
  // a giant glowing balloon this close up.
  const halo = createHalo(0.16, 0.2);
  halo.position.z = -0.18;
  group.add(halo);

  group.position.set(0.34, -0.28, -0.5);
  group.rotation.set(0.03, -0.04, 0);
  camera.add(group);

  flashlight = { group, spot, spill, beam, lens, halo, on: true };
}

export function toggleFlashlight() {
  flashlight.on = !flashlight.on;
  flashlight.spot.visible = flashlight.on;
  flashlight.spill.visible = flashlight.on;
  flashlight.beam.visible = flashlight.on;
  flashlight.halo.visible = flashlight.on;
  flashlight.lens.material.emissiveIntensity = flashlight.on ? 6 : 0.05;
  return flashlight.on;
}

// --- Particles ---------------------------------------------------------

// Marine snow, LIT by up to two beam cones (local + remote flashlight).
function createSnow() {
  const positions = new Float32Array(SNOW_COUNT * 3);
  const scales = new Float32Array(SNOW_COUNT);
  const offsets = new Float32Array(SNOW_COUNT);

  for (let i = 0; i < SNOW_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 2 * SNOW_RADIUS;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 2 * SNOW_RADIUS;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 2 * SNOW_RADIUS;
    scales[i] = 0.75 + Math.pow(Math.random(), 2.4) * 1.7;
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
        // Clamped: a mote right at the lens must not balloon into a disc.
        gl_PointSize = min(aScale * uPixelRatio * (34.0 / -mv.z), 6.0);
        vAlpha = smoothstep(42.0, 1.0, -mv.z);
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
        float a = smoothstep(0.5, 0.14, d) * vAlpha * (0.70 + lit * 0.9);
        vec3 col = mix(vec3(0.74, 0.83, 0.90), vec3(0.97, 0.99, 1.0), lit);
        gl_FragColor = vec4(col * (1.0 + lit * 2.0), a);
      }
    `,
  });

  snow = new THREE.Points(geometry, material);
  snow.frustumCulled = false;
  scene.add(snow);
}

const BLOOM_MOTES = 5200; // fewer than before, spread over a far larger region
const CURRENT_MOTES = 900; // per flow

// Shared look for free-floating bioluminescence: a small hot core in a soft
// halo, additive so clusters build into a glow.
function moteMaterial(uniforms, extraVert, extraFrag) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uPixelRatio;
      uniform float uSize;
      uniform float uDim;
      attribute float aSeed;
      varying float vAmt;
      ${extraVert.declarations}
      void main() {
        ${extraVert.body}
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = min((0.5 + aSeed * 0.9) * uPixelRatio * (uSize / -mv.z), 4.0);
        vAmt = amt * uDim * smoothstep(140.0, 1.5, -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAmt;
      void main() {
        float d = distance(gl_PointCoord, vec2(0.5));
        float core = smoothstep(0.22, 0.0, d);
        float halo = smoothstep(0.5, 0.1, d);
        vec3 col = ${extraFrag};
        gl_FragColor = vec4(col, (halo * 0.35 + core * 0.9) * vAmt);
      }
    `,
  });
}

// The bloom: dense at the heart, thinning through a noise-chewed body.
function createBloom() {
  const dirs = new Float32Array(BLOOM_MOTES * 3);
  const rads = new Float32Array(BLOOM_MOTES);
  const seeds = new Float32Array(BLOOM_MOTES);
  for (let i = 0; i < BLOOM_MOTES; i++) {
    const x = Math.random() * 2 - 1;
    const y = Math.random() * 2 - 1;
    const z = Math.random() * 2 - 1;
    const len = Math.hypot(x, y, z) || 1;
    dirs[i * 3] = x / len;
    dirs[i * 3 + 1] = y / len;
    dirs[i * 3 + 2] = z / len;
    rads[i] = Math.pow(Math.random(), 5.0); // crowd the heart hard
    seeds[i] = Math.random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(dirs, 3));
  geometry.setAttribute("aRad", new THREE.BufferAttribute(rads, 1));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

  const material = moteMaterial(
    {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uSize: { value: 30 },
      uDim: { value: 0.42 }, // deliberately faint: presence, not fireworks
      uRadius: { value: FIELD_RADIUS },
      uHeart: { value: HEART_RADIUS / FIELD_RADIUS },
      uAniso: { value: new THREE.Vector3(1, 1, 1) },
      uWarp: { value: 0.3 },
      uSeed: { value: 0 },
    },
    {
      declarations: `
        uniform float uRadius;
        uniform float uHeart;
        uniform vec3 uAniso;
        uniform float uWarp;
        uniform float uSeed;
        attribute float aRad;
        float h31(vec3 q) {
          return fract(sin(dot(q, vec3(127.1, 311.7, 74.7))) * 43758.5453);
        }
        float vn3(vec3 q) {
          vec3 i = floor(q); vec3 f = fract(q);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(h31(i), h31(i + vec3(1.0,0.0,0.0)), f.x),
                mix(h31(i + vec3(0.0,1.0,0.0)), h31(i + vec3(1.0,1.0,0.0)), f.x), f.y),
            mix(mix(h31(i + vec3(0.0,0.0,1.0)), h31(i + vec3(1.0,0.0,1.0)), f.x),
                mix(h31(i + vec3(0.0,1.0,1.0)), h31(i + vec3(1.0,1.0,1.0)), f.x), f.y),
            f.z);
        }`,
      body: `
        vec3 dir = position;
        float reach = 1.0 - uWarp * (1.0 - vn3(dir * 1.7 + uSeed));
        float amt = 0.0;
        vec3 p = dir * aRad * uRadius * uAniso;
        if (aRad <= reach) {
          float heart = 1.0 - smoothstep(0.0, uHeart, aRad);
          float halo = 1.0 - smoothstep(0.0, reach, aRad);
          float clump = 0.4 + 0.9 * vn3(dir * aRad * 3.0 + uSeed + uTime * 0.04);
          amt = clamp(heart * 0.8 + halo * 0.55, 0.0, 1.0) * clump;
          // Everything drifts; a still bloom looks dead.
          p += vec3(
            sin(uTime * 0.30 + aSeed * 6.283),
            cos(uTime * 0.24 + aSeed * 4.1),
            sin(uTime * 0.27 + aSeed * 5.7)
          ) * 2.2;
        }`,
    },
    "mix(vec3(0.16, 0.62, 0.95), vec3(0.80, 0.98, 1.0), core)",
  );

  bloom = new THREE.Points(geometry, material);
  bloom.frustumCulled = false;
  bloom.visible = false;
  scene.add(bloom);
}

// Motes that ride inside a current, so the flow can be seen before it grabs you.
function createCurrentMotes() {
  for (const state of getCurrents()) currentMotes.push(makeMoteCloud());
}

function makeMoteCloud() {
  const positions = new Float32Array(CURRENT_MOTES * 3);
  const seeds = new Float32Array(CURRENT_MOTES);
  const along = new Float32Array(CURRENT_MOTES);
  const offs = new Float32Array(CURRENT_MOTES * 2);
  for (let i = 0; i < CURRENT_MOTES; i++) {
    seeds[i] = Math.random();
    along[i] = Math.random();
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random());
    offs[i * 2] = Math.cos(a) * r;
    offs[i * 2 + 1] = Math.sin(a) * r;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute("aAlong", new THREE.BufferAttribute(along, 1));
  geometry.setAttribute("aOff", new THREE.BufferAttribute(offs, 2));

  const material = moteMaterial(
    {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uSize: { value: 34 },
      uDim: { value: 0.85 },
      uPower: { value: 0 },
    },
    {
      declarations: "uniform float uPower;",
      body: `
        vec3 p = position;
        float amt = uPower;`,
    },
    "mix(vec3(0.20, 0.72, 0.92), vec3(0.85, 1.0, 1.0), core)",
  );

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);
  return points;
}

// Place the bloom for this level, and stream the current's motes along its path.
function updateFields(level) {
  if (level !== bloomLevel && level >= 0) {
    const f = biolumeFor(level);
    bloom.position.set(f.x, f.y, f.z);
    const u = bloom.material.uniforms;
    u.uAniso.value.set(f.ax, f.ay, f.az);
    u.uWarp.value = f.warp;
    u.uSeed.value = f.seed % 1000;
    bloom.visible = true;
    bloomLevel = level;
  }
  bloom.material.uniforms.uTime.value = elapsed;

  const flows = getCurrents();
  for (let f = 0; f < flows.length; f++) streamFlow(flows[f], currentMotes[f]);
}

function streamFlow(flow, points) {
  const power = strengthOf(flow);
  points.visible = power > 0.01 && flow.path.length > 1;
  if (!points.visible) return;

  points.material.uniforms.uPower.value = power;
  points.material.uniforms.uTime.value = elapsed;
  const pos = points.geometry.attributes.position;
  const along = points.geometry.attributes.aAlong;
  const offs = points.geometry.attributes.aOff;
  const last = flow.path.length - 1;

  for (let i = 0; i < CURRENT_MOTES; i++) {
    // Ride the flow, wrapping back to the mouth at the tail.
    let t = along.getX(i) + delta_ * 0.055;
    if (t > 1) t -= 1;
    along.setX(i, t);

    // Interpolate between nodes: snapping to the nearest one piles every mote
    // into 14 clumps instead of a stream.
    const f = t * last;
    const i0 = Math.min(Math.floor(f), last - 1);
    const frac = f - i0;
    const a = flow.path[i0];
    const b = flow.path[i0 + 1];
    const node = {
      x: a.x + (b.x - a.x) * frac,
      y: a.y + (b.y - a.y) * frac,
      z: a.z + (b.z - a.z) * frac,
    };
    const tan = flow.tangents[i0];
    // Any two vectors perpendicular to the tangent will do for the offset.
    const ux = -tan.z;
    const uz = tan.x;
    const ul = Math.hypot(ux, uz) || 1;
    const ox = offs.getX(i) * CURRENT_RADIUS * 0.85;
    const oy = offs.getY(i) * CURRENT_RADIUS * 0.85;
    pos.setXYZ(
      i,
      node.x + (ux / ul) * ox,
      node.y + oy,
      node.z + (uz / ul) * ox,
    );
  }
  pos.needsUpdate = true;
  along.needsUpdate = true;
}

let delta_ = 0;

const SPARK_COUNT = 500;
const SPARK_LIFE = 2.4;

// Disturbed plankton: swimming hard lights you up, which is its own punishment.
function createSparks() {
  const positions = new Float32Array(SPARK_COUNT * 3);
  const ages = new Float32Array(SPARK_COUNT).fill(SPARK_LIFE + 1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aAge", new THREE.BufferAttribute(ages, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uLife: { value: SPARK_LIFE },
    },
    vertexShader: /* glsl */ `
      uniform float uPixelRatio;
      uniform float uLife;
      attribute float aAge;
      varying float vFade;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float life = clamp(1.0 - aAge / uLife, 0.0, 1.0);
        vFade = life * life;
        gl_PointSize = min((1.0 + life * 2.5) * uPixelRatio * (30.0 / -mv.z), 7.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vFade;
      void main() {
        float d = distance(gl_PointCoord, vec2(0.5));
        float a = smoothstep(0.5, 0.05, d) * vFade;
        gl_FragColor = vec4(0.42, 0.78, 1.0, a);
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);
  sparks = { points, ages, head: 0, debt: 0 };
}

// `speed` is 0..1 of top pace; only real effort wakes the water up.
// One creature per depth: called when the bell settles.
export function spawnCreature(y) {
  creature.spawn(_v1.set(0, y, 0));
}

// Screenshot hook: put it a fixed distance ahead, broadside on.
export function placeCreature(pos, bearing, dist) {
  creature.spawn(_v1.set(pos.x, pos.y, pos.z));
  creature.group.position.set(
    pos.x + Math.cos(bearing) * dist,
    pos.y - 4,
    pos.z + Math.sin(bearing) * dist,
  );
}

export function creaturePosition() {
  return creature.position;
}

// --- The Lanternmaw ------------------------------------------------------
// Unlike the ambient creature, the angler needs to know where the divers are,
// so main.js drives it from inside onFrame rather than it ticking on its own.

export function spawnAngler(y) {
  angler.spawn(_v1.set(0, y, 0));
}

export function despawnAngler() {
  angler.despawn();
}

export function updateAngler(delta, ctx) {
  angler.update(delta, elapsed, noise, ctx);
}

export function anglerState() {
  return angler;
}

// Screenshot hook: park it dead ahead in a fixed phase.
export function placeAngler(pos, bearing, dist, phase) {
  angler.place(pos, bearing, dist, phase);
}

export function setSwimSpeed(speed) {
  swimSpeed = speed;
}

function updateSparks(delta) {
  const ages = sparks.ages;
  const pos = sparks.points.geometry.attributes.position;

  for (let i = 0; i < SPARK_COUNT; i++) ages[i] += delta;

  const trigger = Math.max(0, swimSpeed - 0.45) / 0.55;
  sparks.debt += trigger * trigger * 110 * delta;
  while (sparks.debt >= 1) {
    sparks.debt -= 1;
    const i = sparks.head;
    sparks.head = (sparks.head + 1) % SPARK_COUNT;
    // Behind and around you, not in front of your own face.
    _v1.set(
      (Math.random() - 0.5) * 2.4,
      (Math.random() - 0.5) * 2.0,
      (Math.random() - 0.5) * 2.4,
    );
    pos.setXYZ(
      i,
      camera.position.x + _v1.x,
      camera.position.y + _v1.y,
      camera.position.z + _v1.z,
    );
    ages[i] = 0;
  }

  pos.needsUpdate = true;
  sparks.points.geometry.attributes.aAge.needsUpdate = true;
}

const FLARE_SPEED = 20; // metres per second
const FLARE_RANGE = 95;

function createFlare() {
  const group = new THREE.Group();
  const light = new THREE.PointLight(0xcfe4ff, 0, 70, 1.35);
  group.add(light);
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xecf6ff }),
  );
  group.add(core);
  const halo = createHalo(1.5, 0.55, 0xd8ecff);
  halo.material.fog = false;
  group.add(halo);
  group.visible = false;
  scene.add(group);
  flare = { group, light, core, halo, dir: new THREE.Vector3(), travelled: 0, alive: false };
}

// Launch from a position along a direction; it drifts outward and dies.
export function fireFlare(pos, dir) {
  flare.group.position.set(pos.x, pos.y, pos.z);
  flare.dir.set(dir.x, dir.y, dir.z).normalize();
  flare.travelled = 0;
  flare.alive = true;
  flare.group.visible = true;
}

export function flareActive() {
  return flare.alive;
}

function updateFlare(delta) {
  if (!flare.alive) return;
  const step = FLARE_SPEED * delta;
  flare.travelled += step;
  flare.group.position.addScaledVector(flare.dir, step);

  const life = flare.travelled / FLARE_RANGE;
  if (life >= 1) {
    flare.alive = false;
    flare.group.visible = false;
    return;
  }
  // Swells as it goes, then dies — brightest out where you cannot see.
  const swell = Math.sin(Math.PI * Math.min(life * 1.15, 1)) ** 0.7;
  // The point of a flare is what it reveals, so the light carries it and the
  // sprite stays a small hot spark.
  flare.light.intensity = 620 * swell;
  flare.light.distance = 55 + 55 * life;
  flare.halo.material.opacity = 0.5 * swell;
  flare.halo.scale.setScalar(1.5 + life * 2.2);
  flare.core.scale.setScalar(0.8 + swell * 0.4);
}

// --- The Chorus: the triangulation hologram -------------------------------
//
// The solver hands us a shape — a shell, a ring, two twins, or a locked point —
// and this is where that shape gets a body in the water. It is deliberately a
// different colour from every other light in the game (a cold resonant aqua):
// the bell pings amber, the lure lies in amber, but *knowledge* glows aqua, so
// the moment the crew's fix appears you know you are looking at maths, not bait.
const RESO_COLOR = 0x62ffd0;
const RESO_BUOYS = 8;
const _rv = new THREE.Vector3();
const _rq = new THREE.Quaternion();
const _rz = new THREE.Vector3(0, 0, 1);

function resoMat(opacity) {
  return new THREE.MeshBasicMaterial({
    color: RESO_COLOR,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
}

function createBeacon(columnHeight) {
  const group = new THREE.Group();
  // A shaft of light lancing up and down through the water — the single most
  // legible "over here" a diver can be given in a place with no landmarks.
  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.22, columnHeight, 10, 1, true),
    resoMat(0.22),
  );
  group.add(column);
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 12), resoMat(0.9));
  group.add(core);
  const halo = createHalo(6, 0.6, RESO_COLOR);
  halo.material.fog = false;
  halo.material.blending = THREE.AdditiveBlending;
  group.add(halo);
  const light = new THREE.PointLight(RESO_COLOR, 0, 60, 1.4);
  group.add(light);
  group.visible = false;
  scene.add(group);
  return { group, column, core, halo, light };
}

function createResonance() {
  // SHELL — a whole sphere of "somewhere on here". Faint skin + a wire lattice
  // so it reads as a surface, not a fog ball, from inside or out.
  const shell = new THREE.Group();
  const skin = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), resoMat(0.045));
  skin.material.side = THREE.DoubleSide;
  const wire = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 16),
    new THREE.MeshBasicMaterial({
      color: RESO_COLOR,
      wireframe: true,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
  );
  shell.add(skin, wire);
  shell.visible = false;
  scene.add(shell);

  // RING — where two shells kiss. A clean glowing hoop you swim the rim of.
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.02, 8, 96),
    resoMat(0.85),
  );
  ring.visible = false;
  scene.add(ring);

  // TWINS use both beacons at half strength; LOCK uses beacon[0] at full.
  const beacons = [createBeacon(240), createBeacon(240)];

  // Anchored reading buoys — one soft mote wherever a reading was taken, so the
  // crew can see their own baseline and read "we're all bunched up" at a glance.
  const buoys = [];
  for (let i = 0; i < RESO_BUOYS; i++) {
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), resoMat(0.8));
    const halo = createHalo(2.4, 0.4, RESO_COLOR);
    halo.material.fog = false;
    halo.material.blending = THREE.AdditiveBlending;
    g.add(core, halo);
    g.visible = false;
    scene.add(g);
    buoys.push(g);
  }

  resonance = {
    shell,
    skin,
    wire,
    ring,
    beacons,
    buoys,
    stage: 0,
    quality: 0,
    pulse: 0,
  };
}

// Called every frame from the game loop with the solver's output. Positions
// and reveals exactly the geometry for the current rung; the pulsing itself is
// handled in updateResonance so it keeps breathing between solves.
export function setResonance(sol) {
  if (!resonance) return;
  const r = resonance;
  r.stage = sol?.stage ?? 0;
  r.quality = sol?.quality ?? 0;

  r.shell.visible = false;
  r.ring.visible = false;
  for (const b of r.beacons) b.group.visible = false;

  if (!sol || sol.stage === 0) return;

  if (sol.stage === 1) {
    r.shell.visible = true;
    r.shell.position.set(sol.center.x, sol.center.y, sol.center.z);
    r.shell.scale.setScalar(sol.radius);
  } else if (sol.stage === 2) {
    const c = sol.ring.center;
    r.ring.visible = true;
    r.ring.position.set(c.x, c.y, c.z);
    _rv.set(sol.ring.normal.x, sol.ring.normal.y, sol.ring.normal.z).normalize();
    _rq.setFromUnitVectors(_rz, _rv);
    r.ring.quaternion.copy(_rq);
    // Tube scales with the hoop so a vast, uncertain ring reads as a fat, soft
    // band and a tight one as a crisp wire.
    r.ring.scale.setScalar(sol.ring.radius);
  } else if (sol.stage === 3) {
    const pts = sol.points ?? (sol.point ? [sol.point] : []);
    pts.slice(0, 2).forEach((p, i) => {
      const b = r.beacons[i];
      b.group.visible = true;
      b.group.position.set(p.x, p.y, p.z);
    });
  } else if (sol.stage === 4) {
    const b = r.beacons[0];
    b.group.visible = true;
    b.group.position.set(sol.point.x, sol.point.y, sol.point.z);
  }
}

// Drop the anchored reading markers at the given world positions.
export function setResonanceBuoys(anchors) {
  if (!resonance) return;
  resonance.buoys.forEach((g, i) => {
    const a = anchors[i];
    if (a) {
      g.visible = true;
      g.position.set(a.x, a.y, a.z);
    } else {
      g.visible = false;
    }
  });
}

export function clearResonance() {
  if (!resonance) return;
  setResonance(null);
  setResonanceBuoys([]);
}

function updateResonance(delta) {
  if (!resonance) return;
  const r = resonance;
  r.pulse += delta;
  const breathe = 0.5 + 0.5 * Math.sin(r.pulse * 2.2);

  if (r.shell.visible) {
    r.shell.rotation.y += delta * 0.15;
    r.shell.rotation.x += delta * 0.05;
    r.skin.material.opacity = 0.03 + 0.03 * breathe;
    r.wire.material.opacity = 0.09 + 0.06 * breathe;
  }
  if (r.ring.visible) {
    r.ring.rotation.z += delta * 0.4; // spin about its own axis — a live halo
    r.ring.material.opacity = 0.6 + 0.35 * breathe;
  }
  // The sharper the crew's geometry, the harder the beacons burn — a fuzzy fix
  // gives you a nervous, guttering light; a clean one a steady spike.
  const conf = 0.35 + 0.65 * r.quality;
  for (const b of r.beacons) {
    if (!b.group.visible) continue;
    const lock = r.stage === 4;
    const amp = (lock ? 1 : 0.55) * conf;
    b.core.material.opacity = (0.6 + 0.4 * breathe) * amp;
    b.column.material.opacity = (0.12 + 0.12 * breathe) * amp;
    b.halo.material.opacity = (0.35 + 0.3 * breathe) * amp;
    b.halo.scale.setScalar(4 + breathe * 2);
    b.light.intensity = (lock ? 220 : 90) * (0.7 + 0.3 * breathe) * conf;
    b.light.distance = 55;
  }
}

function createBubbles() {
  const positions = new Float32Array(BUBBLE_COUNT * 3);
  for (let i = 0; i < BUBBLE_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 2 * BUBBLE_RADIUS;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 2 * BUBBLE_RADIUS;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 2 * BUBBLE_RADIUS;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: 0x9fdcff,
    size: 0.07,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });

  bubbles = new THREE.Points(geometry, material);
  bubbles.frustumCulled = false;
  scene.add(bubbles);
}

// Occasional bubble bursts: a vent exhales, a cluster races for the surface.
function createBursts() {
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
        gl_FragColor = vec4(0.75, 0.90, 1.0, ring * vAlpha * 0.6);
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  const states = [];
  for (let i = 0; i < BURSTS; i++) {
    states.push({
      origin: new THREE.Vector3(),
      age: -(2 + Math.random() * 10), // negative age = waiting
      duration: 3.2 + Math.random() * 1.6,
    });
  }
  bursts = { points, states };
}

function respawnBurst(state) {
  const angle = Math.random() * Math.PI * 2;
  const dist = 5 + Math.random() * 13;
  state.origin.set(
    camera.position.x + Math.cos(angle) * dist,
    camera.position.y - (6 + Math.random() * 10),
    camera.position.z + Math.sin(angle) * dist,
  );
  state.age = -(3 + Math.random() * 9);
  state.duration = 3.2 + Math.random() * 1.6;
}

function updateBursts(delta) {
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

// Slow-changing current direction (Perlin-driven), with occasional gusts.
function currentDrift() {
  const gust =
    Math.pow(Math.max(0, noise.noise(elapsed * 0.07, 5.5, 0)), 2) * 3;
  return {
    x: noise.noise(elapsed * 0.04, 11.3, 0) * (0.6 + gust),
    z: noise.noise(elapsed * 0.04, 29.1, 0) * (0.6 + gust),
  };
}

function wrapAroundCamera(points, radius, fall, delta, drift, sheets = 0) {
  const positions = points.geometry.attributes.position;
  const c = camera.position;
  const size = radius * 2;
  for (let i = 0; i < positions.count; i++) {
    // Current sheets: horizontal bands where the water runs much harder, so
    // the ocean has structure and direction instead of being uniform soup.
    const band =
      sheets > 0
        ? 1 + sheets * Math.pow(Math.max(0, Math.sin(positions.getY(i) * 0.055)), 6)
        : 1;
    let x = positions.getX(i) + drift.x * delta * band;
    let y = positions.getY(i) + fall * delta * (0.7 + (i % 5) * 0.12);
    let z = positions.getZ(i) + drift.z * delta * band;

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

export function addPlayer(id, color) {
  if (players.has(id)) return players.get(id);

  const group = new THREE.Group();
  const pivot = new THREE.Group();
  group.add(pivot);

  // Placeholder shown until the GLB loads (visor glow included).
  const placeholder = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.32, 0.65, 8, 16),
    new THREE.MeshStandardMaterial({ color: 0x161e23, roughness: 0.6 }),
  );
  body.rotation.x = Math.PI / 2;
  body.castShadow = true;
  placeholder.add(body);
  const visor = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 12, 12),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 2.5,
    }),
  );
  visor.position.set(0, 0.15, -0.5);
  placeholder.add(visor);
  pivot.add(placeholder);

  // Headlamp rig — initially mounted on the pivot; reparented into the
  // hand-held torch once the model loads.
  const spot = new THREE.SpotLight(
    0xdcecff,
    REMOTE_LAMP_INTENSITY,
    50,
    0.42,
    0.55,
    1.7,
  );
  spot.position.set(0, 0.05, -0.6);
  spot.target.position.set(0, 0.05, -20);
  spot.castShadow = true;
  spot.shadow.mapSize.set(512, 512);
  spot.shadow.bias = -0.0003;
  pivot.add(spot);
  pivot.add(spot.target);

  const beam = createVolumetricLight({
    length: 20,
    endRadius: 3.2,
    tint: 0x9fd0f2,
    strength: 0.3,
  }).group;
  beam.position.set(0, 0.05, -0.6);
  pivot.add(beam);

  const halo = createHalo(2.0, 0.3);
  halo.position.set(0, 0.05, -0.7);
  pivot.add(halo);

  const glow = new THREE.PointLight(color, 3, 12, 2);
  pivot.add(glow);

  scene.add(group);
  const player = {
    group,
    pivot,
    mixer: null,
    placeholder,
    spot,
    beam,
    halo,
    glow,
    color,
    bones: null,
    torch: null,
    headGlow: null,
    phase: Math.random() * 10, // desync swim cycles between divers
  };
  players.set(id, player);

  loadDiverModel().then((gltf) => {
    if (!gltf || !players.has(id)) return;

    const model = SkeletonUtils.clone(gltf.scene);
    model.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.frustumCulled = false;
      }
    });
    model.scale.setScalar(DIVER_SCALE);
    model.rotation.y = Math.PI; // face -Z (our forward)
    model.rotation.x = -1.05; // prone swimming lean
    model.position.set(0, -0.3, 0.15);
    pivot.add(model);

    placeholder.visible = false;

    // GLTFLoader sanitizes node names ("Wrist.R" -> "WristR").
    const bone = (...names) => {
      for (const n of names) {
        const b = model.getObjectByName(n);
        if (b) return b;
      }
      return null;
    };
    player.bones = {
      head: bone("Head"),
      neck: bone("Neck"),
      abdomen: bone("Abdomen"),
      torso: bone("Torso"),
      wristR: bone("WristR", "Wrist.R"),
      upperArmR: bone("UpperArmR", "UpperArm.R"),
      lowerArmR: bone("LowerArmR", "LowerArm.R"),
      upperArmL: bone("UpperArmL", "UpperArm.L"),
      upperLegL: bone("UpperLegL", "UpperLeg.L"),
      upperLegR: bone("UpperLegR", "UpperLeg.R"),
      lowerLegL: bone("LowerLegL", "LowerLeg.L"),
      lowerLegR: bone("LowerLegR", "LowerLeg.R"),
      footL: bone("FootL", "Foot.L"),
      footR: bone("FootR", "Foot.R"),
    };

    // Rest-pose rotation.x for every bone the swim cycle offsets, so the
    // cycle can be applied as an absolute value each frame instead of an
    // ever-accumulating delta (see updateDiverRig).
    player.restRotX = {};
    for (const [name, b] of Object.entries(player.bones)) {
      if (b) player.restRotX[name] = b.rotation.x;
    }

    // --- Hand-held torch: real prop following the right hand. ---
    // IMPORTANT: never parent props into the skeleton — the rig's bones
    // carry a ×45 world scale (armature ×100, compensated by inverse bind
    // matrices for the skinned mesh, but inherited raw by any child).
    // The torch lives at scene level; updateDiverRig copies the wrist's
    // world position (and the diver's look orientation) onto it each frame.
    if (player.bones.wristR) {
      const torch = new THREE.Group();
      // The torch lives at scene level (unit scale) so its physical mesh
      // needs its own scale-down to match the shrunk diver — otherwise it
      // renders ~2x too big relative to the hand holding it.
      const torchProp = new THREE.Group();
      torchProp.scale.setScalar(DIVER_SCALE);
      torch.add(torchProp);
      const torchBody = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.06, 0.34, 12),
        new THREE.MeshStandardMaterial({
          color: 0x11181d,
          roughness: 0.4,
          metalness: 0.8,
        }),
      );
      torchBody.rotation.x = Math.PI / 2;
      torchProp.add(torchBody);
      const torchLens = new THREE.Mesh(
        new THREE.CircleGeometry(0.05, 12),
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          emissive: 0xe8f4ff,
          emissiveIntensity: 5,
        }),
      );
      torchLens.position.z = -0.175;
      torchProp.add(torchLens);

      // Reparent the whole lamp rig into the torch (unit scale, scene level;
      // the beam/halo stay full-size — they're environmental light, not prop).
      torch.add(spot);
      spot.position.set(0, 0, -0.1);
      torch.add(spot.target);
      spot.target.position.set(0, 0, -20);
      torch.add(beam);
      beam.position.set(0, 0, -0.15);
      torch.add(halo);
      halo.position.set(0, 0, -0.22);

      scene.add(torch);
      player.torch = torch;
    }

    // --- Colored glow following the diver's helmet (scene level too). ---
    if (player.bones.head) {
      const headGlow = new THREE.Group();
      headGlow.add(createHalo(0.9, 0.55, color));
      glow.position.set(0, 0, 0);
      headGlow.add(glow);
      scene.add(headGlow);
      player.headGlow = headGlow;
    }

    // Base layer: Idle clip (breathing), procedural swim on top.
    const clips = gltf.animations ?? [];
    if (clips.length > 0) {
      const clip =
        clips.find((c) => /\|Idle$/i.test(c.name)) ??
        clips.find((c) => /idle/i.test(c.name)) ??
        clips[0];
      player.mixer = new THREE.AnimationMixer(model);
      const action = player.mixer.clipAction(clip);
      action.timeScale = 0.5;
      action.play();
    }
  });

  return group;
}

// --- Procedural swim: flutter kick + body undulation + torch aimed forward.
// Runs every frame AFTER the mixer so it layers on top of the Idle base.
function updateDiverRig(player, delta) {
  player.mixer?.update(delta);
  const b = player.bones;
  if (!b) return;

  const t = elapsed * 2.4 + player.phase;
  const s = Math.sin;
  const rest = player.restRotX;

  // Flutter kick: thighs anti-phase, knees follow with a lag. Set as an
  // absolute offset from the rest pose (not +=) — accumulating this every
  // rendered frame would blow up to tens of radians within seconds.
  if (b.upperLegL) b.upperLegL.rotation.x = rest.upperLegL + 0.22 * s(t);
  if (b.upperLegR)
    b.upperLegR.rotation.x = rest.upperLegR + 0.22 * s(t + Math.PI);
  if (b.lowerLegL)
    b.lowerLegL.rotation.x = rest.lowerLegL + 0.1 + 0.14 * s(t - 0.7);
  if (b.lowerLegR)
    b.lowerLegR.rotation.x = rest.lowerLegR + 0.1 + 0.14 * s(t + Math.PI - 0.7);
  // Feet counter-flex opposite the calf so they trail relaxed, not splayed.
  if (b.footL) b.footL.rotation.x = rest.footL - 0.16 * s(t - 0.7);
  if (b.footR) b.footR.rotation.x = rest.footR - 0.16 * s(t + Math.PI - 0.7);

  // Gentle body undulation rippling up the spine.
  if (b.abdomen) b.abdomen.rotation.x = rest.abdomen + 0.05 * s(t * 0.5);
  if (b.torso) b.torso.rotation.x = rest.torso + 0.04 * s(t * 0.5 - 0.5);

  // Head up so the diver looks ahead while prone.
  if (b.neck) b.neck.rotation.x = rest.neck - 0.35;
  if (b.head) b.head.rotation.x = rest.head - 0.25;

  // Left arm: relaxed slow sweep.
  if (b.upperArmL) b.upperArmL.rotation.x = rest.upperArmL + 0.12 * s(t * 0.6);

  // Right arm: aim it forward (corrective rotation in world space) so the
  // torch is held out ahead of the diver.
  if (b.upperArmR && b.lowerArmR) {
    b.upperArmR.getWorldPosition(_v1);
    b.lowerArmR.getWorldPosition(_v2);
    _v2.sub(_v1).normalize(); // current upper-arm direction (world)

    // Desired: mostly forward, slightly down-and-in. Forward = pivot -Z.
    player.pivot.getWorldQuaternion(_q1);
    _v3.set(0.15, -0.3, -0.95).applyQuaternion(_q1).normalize();

    _q2.setFromUnitVectors(_v2, _v3); // world-space correction
    b.upperArmR.parent.getWorldQuaternion(_q3);
    _q4.copy(_q3).invert().multiply(_q2).multiply(_q3);
    b.upperArmR.quaternion.premultiply(_q4);
  }

  // Torch: scene-level prop. Follow the wrist's world POSITION, but lock the
  // orientation to the diver's look direction so the beam aims correctly.
  // (Never parented to the bone — bones carry a ×45 world scale.)
  if (player.torch && b.wristR) {
    player.pivot.getWorldQuaternion(_q1);
    b.wristR.getWorldPosition(_v1);
    // Nudge from the wrist joint into the palm, in look-space.
    _v1.add(_v2.set(0.02, -0.02, -0.1).applyQuaternion(_q1));
    player.torch.position.copy(_v1);
    player.torch.quaternion.copy(_q1);
  }

  // Helmet glow follows the head bone's world position.
  if (player.headGlow && b.head) {
    b.head.getWorldPosition(_v1);
    player.headGlow.position.copy(_v1);
  }
}

export function removePlayer(id) {
  const player = players.get(id);
  if (!player) return;
  for (const obj of [player.group, player.torch, player.headGlow]) {
    if (!obj) continue;
    scene.remove(obj);
    obj.traverse((child) => {
      child.geometry?.dispose();
      if (child.material?.dispose) child.material.dispose();
    });
  }
  players.delete(id);
}

export function updatePlayerPosition(id, x, y, z, yaw = null, pitch = null) {
  const player = players.get(id);
  if (!player) return;
  player.group.position.set(x, y, z);
  if (yaw !== null) player.group.rotation.y = yaw;
  if (pitch !== null) player.pivot.rotation.x = pitch;
}

export function setPlayerLight(id, on) {
  const player = players.get(id);
  if (!player) return;
  player.spot.visible = on;
  player.beam.visible = on;
  player.halo.visible = on;
}

export function updateCamera(playerPos, yaw, pitch, speed = 0) {
  camera.position.set(playerPos.x, playerPos.y, playerPos.z);
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  // Breathing roll — a body hanging in water is never perfectly level.
  camera.rotation.z =
    Math.sin(elapsed * 0.62) * 0.013 * (1 + dread * 1.6) +
    Math.sin(elapsed * 0.21) * 0.006;
  moveFactor += (speed - moveFactor) * 0.05;
}

// The dying bell lamp: a slow, smooth pulse (never a sudden dip/strobe) —
// all other lights stay perfectly steady.
function updateBellLight(delta) {
  if (!bellLight) return;
  const t = elapsed;
  const pulse = 0.82 + 0.18 * Math.sin(t * 0.35) + 0.06 * Math.sin(t * 0.13);
  const target = 14 * pulse;
  bellLight.light.intensity +=
    (target - bellLight.light.intensity) * Math.min(delta * 2, 1);
  const lit = bellLight.light.intensity / 14;
  bellLight.mat.emissiveIntensity = 3 * lit;
  bellLight.halo.material.opacity = 0.3 * lit;

  // The beacon grows with range so the bell never shrinks below a visible
  // point, however far you drift — nothing is allowed to hide it.
  bellBeacon.material.opacity = 0.55 + 0.3 * lit;
  const range = camera.position.distanceTo(bellGroup.position);
  bellBeacon.scale.setScalar(Math.max(1.5, range * 0.03));
}

function animateFlashlight() {
  if (!flashlight) return;
  const t = elapsed;
  const bob = 1 + moveFactor * 3;
  flashlight.group.position.x = 0.34 + Math.sin(t * 1.1) * 0.006 * bob;
  flashlight.group.position.y =
    -0.28 + Math.sin(t * 2.3) * 0.008 + Math.sin(t * 3.7) * 0.005 * moveFactor;
  flashlight.group.rotation.z = Math.sin(t * 0.9) * 0.01 * bob;
  flashlight.group.rotation.x = 0.03 + Math.sin(t * 1.7) * 0.008 * bob;

  // Failing lamp: stutters and throws shorter the deeper you go, and blooms
  // scatter what is left of it back into your face.
  const wobble = Math.max(0, noise.noise(t * 7.0, 3.3, 0));
  const dropout = noise.noise(t * 1.3, 71.0, 0) > 0.45 ? 0.72 : 0;
  const stutter =
    Math.max(0.08, 1 - dread * (0.6 * wobble * wobble + dropout));
  flashlight.spot.intensity = FLASHLIGHT_INTENSITY * stutter;
  flashlight.spill.intensity = SPILL_INTENSITY * stutter;
  flashlight.spot.distance = 65;
  flashlight.lens.material.emissiveIntensity = flashlight.on ? 6 * stutter : 0.05;
  flashlight.halo.material.opacity = 0.28 * stutter;
  volumetric.beam.material.uniforms.uIntensity.value = stutter;
  volumetric.haze.material.uniforms.uIntensity.value = stutter;
}

// Feed the snow shader the two beam poses (local + first remote).
function updateSnowLightUniforms() {
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

function applyResize() {
  resizeFrame = null;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const pixelRatio = renderPixelRatio();

  horrorPass.uniforms.uResolution.value.set(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  if (renderer.getPixelRatio() !== pixelRatio) {
    renderer.setPixelRatio(pixelRatio);
    composer.setPixelRatio(pixelRatio);
  }
  renderer.setSize(width, height);
  composer.setSize(width, height);
}

function onResize() {
  if (resizeFrame !== null) return;
  resizeFrame = requestAnimationFrame(applyResize);
}

// Screenshot mode: advance by an exact 1/60 s for SHOT_FREEZE_FRAMES, then
// hold. Rendering continues, so Chrome grabs the same frame every run.
export const SHOT_FREEZE_FRAMES = 90;

export function setFixedStep(on) {
  fixedStep = on;
}

export function renderLoop(onFrame) {
  const clock = new THREE.Clock();

  renderer.setAnimationLoop(() => {
    let delta = Math.min(clock.getDelta(), 0.1);
    elapsed = clock.elapsedTime;

    if (fixedStep) {
      stepFrame++;
      const held = Math.min(stepFrame, SHOT_FREEZE_FRAMES);
      delta = stepFrame <= SHOT_FREEZE_FRAMES ? 1 / 60 : 0;
      elapsed = held / 60;
    }

    snow.material.uniforms.uTime.value = elapsed;
    horrorPass.uniforms.uTime.value = elapsed;
    for (const mat of beamMaterials) mat.uniforms.uTime.value = elapsed;

    const drift = currentDrift();
    wrapAroundCamera(snow, SNOW_RADIUS, -0.22, delta, drift, 7);
    wrapAroundCamera(bubbles, BUBBLE_RADIUS, 0.85, delta, drift);
    updateBursts(delta);
    updateFlare(delta);
    updateResonance(delta);
    delta_ = delta;
    updateSparks(delta);
    fauna.update(camera, elapsed, delta);
    creature.update(delta, elapsed, noise);

    kelpTime.value = elapsed;
    animateFlashlight();
    updateBellLight(delta);
    updateAlarm(delta);
    updateWater(delta);

    if (onFrame) onFrame(delta);

    // After game logic moved players/camera: animate rigs (torch follows the
    // moved wrist), then feed the beam poses to the snow shader.
    for (const player of players.values()) updateDiverRig(player, delta);
    updateSnowLightUniforms();
    if (elapsed >= nextShadowUpdate) {
      renderer.shadowMap.needsUpdate = true;
      nextShadowUpdate = elapsed + 1 / 30;
    }
    composer.render();
  });
}
