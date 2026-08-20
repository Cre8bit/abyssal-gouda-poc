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
  { color: 0x0b2c3a, ambient: 1.8 },
  { color: 0x05161e, ambient: 0.7 },
  { color: 0x000406, ambient: 0.18 },
];
const WATER_FADE = 0.8; // per-second lerp toward the current level's look
const ALARM_FLASH = 1.1; // seconds for the red flash to bleed out

// Plankton blooms: a visible veil that drowns out light, but never visibility.
const PLANKTON_COUNT = 2400;
const PLANKTON_RADIUS = 26;

const HEMI_BASE = 0.16;
const GLOOM_BASE = 0.08;

const SNOW_COUNT = 1500;
const SNOW_RADIUS = 30;
const BUBBLE_COUNT = 160;
const BUBBLE_RADIUS = 22;
const BURSTS = 5;
const BURST_PARTICLES = 24;

const FLASHLIGHT_INTENSITY = 650;
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
let plankton;
let bursts; // { points, states: [{origin, age, duration, delay}] }
let flashlight; // { group, spot, spill, beam, lens, halo, on }
let bellGroup;
let bellLight;
let bellBeacon;
let bellAlarm; // { light, halo, mat, t, strength }
let hemiLight;
let gloomLight;
let volumetric; // the local flashlight's beam materials, for the failing-lamp flicker
let dread = 0; // 0 near the surface, 1 in the dark — drives every horror effect
let murk = 0; // plankton density where the camera is
let elapsed = 0;
let moveFactor = 0;
let resizeFrame = null;
let nextShadowUpdate = 0;

let waterTarget = WATER_LOOKS[0];
const waterColor = new THREE.Color(WATER_LOOKS[0].color);
const waterCurrent = { ambient: WATER_LOOKS[0].ambient };

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
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  container.appendChild(renderer.domElement);

  setupPostProcessing();

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
  createPlankton();
  createBubbles();
  createBursts();

  window.addEventListener("resize", onResize);

  return renderer.domElement;
}

function setupPostProcessing() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.55,
    0.8,
    0.7,
  );
  composer.addPass(bloom);

  horrorPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uDread: { value: 0 },
      uMurk: { value: 0 },
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
      uniform float uMurk;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
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
        vec2 c = vUv - 0.5;
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
        uv += flow * (0.0016 + uDread * 0.0022 + uMurk * 0.004);

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
        float smudge = vnoise(vUv * vec2(9.0, 22.0)) * vnoise(vUv * 31.0 + 3.0);
        col += smudge * dot(col, vec3(0.299, 0.587, 0.114)) * 0.5;

        // Grade: colour drains, shadows go cold, blacks crush to nothing.
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(col, vec3(lum), 0.24 + uDread * 0.34 + uMurk * 0.20);
        col *= vec3(0.70, 0.94, 1.02);
        col += vec3(0.0, 0.020, 0.016) * (1.0 - smoothstep(0.0, 0.35, lum));
        col = max(col - (0.010 + uDread * 0.012), 0.0);
        col = pow(col, vec3(1.0 + uDread * 0.16));

        // Inside a bloom the water itself turns sickly and green.
        col = mix(
          col,
          col * vec3(0.55, 0.82, 0.62) + vec3(0.012, 0.030, 0.020),
          uMurk * 0.75
        );

        // The dark closes in with depth, and faster inside a bloom.
        float d = length(c);
        col *= smoothstep(0.92 - uDread * 0.32 - uMurk * 0.16, 0.30 - uDread * 0.10, d);

        // Sensor grain — worst where there is no light for it to work with.
        float grain = hash(vUv * 900.0 + fract(uTime) * 91.0) - 0.5;
        col += grain * (0.012 + uDread * 0.045 + uMurk * 0.020);

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
    const halo = createHalo(1.6, 0.3);
    halo.position.copy(bulb.position);
    group.add(halo);
    if (i === 2) bellLight = { light, bulb: bulb, halo, mat: bulbMat };
  }

  // Always-on marker: this is what guarantees the bell is never lost.
  bellBeacon = createHalo(1.5, 0.85);
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
export function setPlankton(value) {
  murk = value;
  plankton.material.uniforms.uDensity.value = value;
  plankton.visible = value > 0.001;
  horrorPass.uniforms.uMurk.value = value;
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
  hemiLight.intensity = HEMI_BASE * waterCurrent.ambient;
  gloomLight.intensity = GLOOM_BASE * waterCurrent.ambient;
}

// Eased so a level change reads as the light dying around you, not a cut.
function updateWater(delta) {
  const k = Math.min(delta * WATER_FADE, 1);
  waterCurrent.ambient += (waterTarget.ambient - waterCurrent.ambient) * k;
  waterColor.lerp(_c1.set(waterTarget.color), k);
  scene.background.copy(waterColor);
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
    0.5,
    1.7,
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
  const halo = createHalo(0.3, 0.28);
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
        vec3 col = mix(vec3(0.45, 0.55, 0.62), vec3(0.95, 0.98, 1.0), lit);
        gl_FragColor = vec4(col * (1.0 + lit * 2.0), a);
      }
    `,
  });

  snow = new THREE.Points(geometry, material);
  scene.add(snow);
}

// A dense mote veil that materialises inside a bloom — purely something to
// look at and to drown the lamps in, since nothing here costs you visibility.
function createPlankton() {
  const positions = new Float32Array(PLANKTON_COUNT * 3);
  const scales = new Float32Array(PLANKTON_COUNT);
  const offsets = new Float32Array(PLANKTON_COUNT);

  for (let i = 0; i < PLANKTON_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 2 * PLANKTON_RADIUS;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 2 * PLANKTON_RADIUS;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 2 * PLANKTON_RADIUS;
    scales[i] = 0.4 + Math.random() * 1.4;
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
      uDensity: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uPixelRatio;
      attribute float aScale;
      attribute float aOffset;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.5 + aOffset) * 0.35;
        p.y += cos(uTime * 0.4 + aOffset * 1.3) * 0.25;
        p.z += cos(uTime * 0.45 + aOffset * 1.7) * 0.35;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = aScale * uPixelRatio * (34.0 / -mv.z);
        vAlpha = smoothstep(26.0, 1.5, -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uDensity;
      varying float vAlpha;
      void main() {
        float d = distance(gl_PointCoord, vec2(0.5));
        float a = smoothstep(0.5, 0.10, d) * vAlpha * uDensity * 0.55;
        gl_FragColor = vec4(0.40, 0.55, 0.43, a);
      }
    `,
  });

  plankton = new THREE.Points(geometry, material);
  scene.add(plankton);
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

function wrapAroundCamera(points, radius, fall, delta, drift) {
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
  const choke = 1 - murk * 0.72;
  const stutter =
    Math.max(0.08, 1 - dread * (0.6 * wobble * wobble + dropout)) * choke;
  flashlight.spot.intensity = FLASHLIGHT_INTENSITY * stutter;
  flashlight.spill.intensity = SPILL_INTENSITY * stutter;
  flashlight.spot.distance = 65 * (1 - dread * 0.35) * (1 - murk * 0.6);
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

export function renderLoop(onFrame) {
  const clock = new THREE.Clock();

  renderer.setAnimationLoop(() => {
    const delta = Math.min(clock.getDelta(), 0.1);
    elapsed = clock.elapsedTime;

    snow.material.uniforms.uTime.value = elapsed;
    plankton.material.uniforms.uTime.value = elapsed;
    horrorPass.uniforms.uTime.value = elapsed;
    for (const mat of beamMaterials) mat.uniforms.uTime.value = elapsed;

    const drift = currentDrift();
    wrapAroundCamera(snow, SNOW_RADIUS, -0.22, delta, drift);
    if (plankton.visible) {
      wrapAroundCamera(plankton, PLANKTON_RADIUS, -0.06, delta, drift);
    }
    wrapAroundCamera(bubbles, BUBBLE_RADIUS, 0.85, delta, drift);
    updateBursts(delta);

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
