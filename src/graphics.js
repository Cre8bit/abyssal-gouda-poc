// graphics.js — Three.js module: cinematic abyssal first-person rendering.
//
// Lighting model:
//  - Flashlight = hot core spotlight (shadows) + wide soft spill light
//  - Custom volumetric beam shader: fresnel-soft cone with distance falloff
//    and drifting particulate wisps, visible even in open water
//  - Marine snow is LIT by the beams (uniform-driven cone lighting), so the
//    light visibly diffuses through the thickness of the water
//  - Scatter halo sprites at every lamp
//  - Gentle Perlin-noise flicker with rare soft dips (no strobing)
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

const ABYSS_COLOR = 0x00070a;
const FOG_DENSITY = 0.05;

const TERRAIN_SIZE = 340;
const SNOW_COUNT = 1500;
const SNOW_RADIUS = 30;
const BUBBLE_COUNT = 160;
const BUBBLE_RADIUS = 22;
const BURSTS = 5;
const BURST_PARTICLES = 24;

const FLASHLIGHT_INTENSITY = 650;
const SPILL_INTENSITY = 90;
const REMOTE_LAMP_INTENSITY = 420;

const DIVER_MODEL_URL = `${import.meta.env.BASE_URL}models/diver.glb`;

let scene;
let camera;
let renderer;
let composer;
let horrorPass;
let snow;
let bubbles;
let bursts; // { points, states: [{origin, age, duration, delay}] }
let flashlight; // { group, spot, spill, beam, lens, halo, on }
let bellLight;
let elapsed = 0;
let moveFactor = 0;
let flickerMult = 1;
let dipTimer = 0;
let dipDuration = 0;
let dipDepth = 0;

const players = new Map();
const noise = new ImprovedNoise();
const beamMaterials = []; // all volumetric beam materials (share uTime)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

let diverModelPromise = null;
function loadDiverModel() {
  diverModelPromise ??= new GLTFLoader()
    .loadAsync(DIVER_MODEL_URL)
    .catch(() => null);
  return diverModelPromise;
}

export function terrainHeight(x, z) {
  let h = 0;
  h += noise.noise(x * 0.011, z * 0.011, 0.5) * 10;
  h += noise.noise(x * 0.045, z * 0.045, 17.7) * 2.4;
  h += noise.noise(x * 0.16, z * 0.16, 31.4) * 0.5;
  return h - 4;
}

export function initGraphics(container) {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(ABYSS_COLOR);
  scene.fog = new THREE.FogExp2(ABYSS_COLOR, FOG_DENSITY);

  camera = new THREE.PerspectiveCamera(
    72,
    window.innerWidth / window.innerHeight,
    0.1,
    150,
  );
  camera.rotation.order = "YXZ";
  camera.position.set(0, 2, 8);
  scene.add(camera);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  setupPostProcessing();

  // Natural deep-water base light: faint cool sky vs dead-black floor.
  scene.add(new THREE.HemisphereLight(0x0e2b42, 0x010407, 0.16));
  const gloom = new THREE.DirectionalLight(0x0e3149, 0.08);
  gloom.position.set(2, 40, 1);
  scene.add(gloom);

  createTerrain();
  scatterRocks();
  createDivingBell();
  createFlashlight();
  createSnow();
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
    0.45,
    0.6,
    0.75,
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

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

      float rand(vec2 co) {
        return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
      }

      void main() {
        vec2 uv = vUv;
        uv += vec2(
          sin(uv.y * 42.0 + uTime * 0.9),
          cos(uv.x * 34.0 - uTime * 0.7)
        ) * 0.0011;

        vec3 col = texture2D(tDiffuse, uv).rgb;

        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(col, vec3(lum), 0.22);
        col *= vec3(0.74, 0.94, 1.07);

        float d = distance(vUv, vec2(0.5));
        col *= smoothstep(0.88, 0.32, d);

        float g = rand(vUv * 900.0 + fract(uTime * 13.7) * 100.0) - 0.5;
        col += g * (0.04 + (1.0 - lum) * 0.035);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  composer.addPass(horrorPass);
}

// --- Shared helpers: volumetric beam + scatter halo ---------------------

// Fresnel-soft additive cone with distance falloff and drifting wisps.
function createBeam({ length, endRadius, tint, strength }) {
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
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vViewDir;

      void main() {
        float along = 1.0 - vUv.y; // 0 at the lens, 1 at the far end

        // Bright core near the source, exponential-ish falloff with distance.
        float axial = pow(1.0 - along, 1.6);

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
function createHalo(size, opacity) {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: getHaloTexture(),
      color: 0xcfe6ff,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  sprite.scale.setScalar(size);
  return sprite;
}

// --- World -----------------------------------------------------------------

function createTerrain() {
  const segments = 170;
  const geometry = new THREE.PlaneGeometry(
    TERRAIN_SIZE,
    TERRAIN_SIZE,
    segments,
    segments,
  );
  geometry.rotateX(-Math.PI / 2);

  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  }
  geometry.computeVertexNormals();

  const terrain = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color: 0x14252e,
      roughness: 0.95,
      metalness: 0.02,
    }),
  );
  terrain.receiveShadow = true;
  scene.add(terrain);
}

function scatterRocks() {
  const material = new THREE.MeshStandardMaterial({
    color: 0x1b2a33,
    roughness: 1,
  });
  for (let i = 0; i < 70; i++) {
    const size = 0.4 + Math.random() * 2.6;
    const rock = new THREE.Mesh(
      new THREE.DodecahedronGeometry(size, 0),
      material,
    );
    const x = (Math.random() - 0.5) * 220;
    const z = (Math.random() - 0.5) * 220;
    rock.position.set(x, terrainHeight(x, z) + size * 0.25, z);
    rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    rock.scale.y = 0.45 + Math.random() * 0.6;
    rock.castShadow = true;
    rock.receiveShadow = true;
    scene.add(rock);
  }
}

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

  const x = 0;
  const z = -14;
  group.position.set(x, terrainHeight(x, z) + 0.2, z);
  scene.add(group);
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
  const spill = new THREE.SpotLight(0xbcd8ee, SPILL_INTENSITY, 30, 0.85, 0.9, 1.9);
  spill.position.set(0, 0, -0.1);
  spill.target = spot.target;
  group.add(spill);

  // Long volumetric beam — visible even with no floor in sight.
  const beam = createBeam({
    length: 24,
    endRadius: 3.6,
    tint: 0x8fc6ee,
    strength: 0.22,
  });
  beam.position.z = -0.12;
  group.add(beam);

  // Scatter halo at the lens.
  const halo = createHalo(2.4, 0.28);
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
  const x = camera.position.x + Math.cos(angle) * dist;
  const z = camera.position.z + Math.sin(angle) * dist;
  state.origin.set(x, terrainHeight(x, z) + 0.3, z);
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
  const gust = Math.pow(Math.max(0, noise.noise(elapsed * 0.07, 5.5, 0)), 2) * 3;
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

  const placeholder = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.32, 0.65, 8, 16),
    new THREE.MeshStandardMaterial({ color: 0x161e23, roughness: 0.6 }),
  );
  body.rotation.x = Math.PI / 2;
  body.castShadow = true;
  placeholder.add(body);
  pivot.add(placeholder);

  const visor = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 12, 12),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 2.5,
    }),
  );
  visor.position.set(0, 0.15, -0.5);
  pivot.add(visor);

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

  const beam = createBeam({
    length: 20,
    endRadius: 3.2,
    tint: 0x9fd0f2,
    strength: 0.3,
  });
  beam.position.set(0, 0.05, -0.6);
  pivot.add(beam);

  const halo = createHalo(2.0, 0.3);
  halo.position.set(0, 0.05, -0.7);
  pivot.add(halo);

  pivot.add(new THREE.PointLight(color, 3, 12, 2));

  scene.add(group);
  const player = { group, pivot, mixer: null, placeholder, spot, beam, halo };
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
    model.scale.setScalar(0.45);
    model.rotation.y = Math.PI;
    model.rotation.x = -1.15;
    model.position.set(0, -0.35, 0.15);
    pivot.add(model);

    placeholder.visible = false;

    const clips = gltf.animations ?? [];
    if (clips.length > 0) {
      const clip =
        clips.find((c) => /swim|float/i.test(c.name)) ??
        clips.find((c) => /idle/i.test(c.name)) ??
        clips[0];
      player.mixer = new THREE.AnimationMixer(model);
      const action = player.mixer.clipAction(clip);
      action.timeScale = 0.6;
      action.play();
    }
  });

  return group;
}

export function removePlayer(id) {
  const player = players.get(id);
  if (!player) return;
  scene.remove(player.group);
  player.group.traverse((obj) => {
    obj.geometry?.dispose();
    if (obj.material?.dispose) obj.material.dispose();
  });
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
  moveFactor += (speed - moveFactor) * 0.05;
}

// --- Flicker: subtle Perlin breathing + rare soft dips (no strobe). ---
function updateFlicker(delta) {
  const t = elapsed;

  // Constant gentle breathing, ±3%.
  let mult = 0.985 + noise.noise(t * 0.55, 3.7, 0) * 0.03;

  // Rare dips: roughly one every ~25s, soft envelope, mild depth.
  if (dipTimer <= 0 && Math.random() < delta * 0.04) {
    dipDuration = 0.35 + Math.random() * 0.5;
    dipTimer = dipDuration;
    dipDepth = 0.2 + Math.random() * 0.3;
  }
  if (dipTimer > 0) {
    dipTimer -= delta;
    const p = 1 - dipTimer / dipDuration;
    const envelope = Math.sin(Math.PI * Math.min(Math.max(p, 0), 1));
    // Tiny tremble inside the dip, smoothed by the envelope.
    const tremble = 1 + noise.noise(t * 6.0, 8.8, 0) * 0.25;
    mult *= 1 - dipDepth * envelope * tremble;
  }

  flickerMult = Math.max(mult, 0.05);

  if (flashlight.on) {
    flashlight.spot.intensity = FLASHLIGHT_INTENSITY * flickerMult;
    flashlight.spill.intensity = SPILL_INTENSITY * flickerMult;
    flashlight.lens.material.emissiveIntensity = 6 * flickerMult;
    flashlight.beam.material.uniforms.uIntensity.value = flickerMult;
    flashlight.halo.material.opacity = 0.28 * flickerMult;
  }

  // The dying bell light: mostly steady, occasionally browns out.
  if (bellLight) {
    const b = noise.noise(t * 0.9, 40.2, 0);
    const target = b > -0.25 ? 1 : 0.12;
    bellLight.light.intensity +=
      (14 * target - bellLight.light.intensity) * Math.min(delta * 12, 1);
    const lit = bellLight.light.intensity / 14;
    bellLight.mat.emissiveIntensity = 3 * lit;
    bellLight.halo.material.opacity = 0.3 * lit;
  }
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
}

// Feed the snow shader the two beam poses (local + first remote).
function updateSnowLightUniforms() {
  const u = snow.material.uniforms;

  flashlight.spot.getWorldPosition(u.uLightPos.value[0]);
  flashlight.spot.target.getWorldPosition(_v1);
  u.uLightDir.value[0]
    .copy(_v1)
    .sub(u.uLightPos.value[0])
    .normalize();
  u.uLightOn.value[0] = flashlight.on ? flickerMult : 0;

  let remoteLit = 0;
  for (const player of players.values()) {
    if (!player.spot.visible) continue;
    player.spot.getWorldPosition(u.uLightPos.value[1]);
    player.spot.target.getWorldPosition(_v2);
    u.uLightDir.value[1]
      .copy(_v2)
      .sub(u.uLightPos.value[1])
      .normalize();
    remoteLit = 1;
    break;
  }
  u.uLightOn.value[1] = remoteLit;
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
}

export function renderLoop(onFrame) {
  const clock = new THREE.Clock();

  renderer.setAnimationLoop(() => {
    const delta = Math.min(clock.getDelta(), 0.1);
    elapsed = clock.elapsedTime;

    snow.material.uniforms.uTime.value = elapsed;
    horrorPass.uniforms.uTime.value = elapsed;
    for (const mat of beamMaterials) mat.uniforms.uTime.value = elapsed;

    const drift = currentDrift();
    wrapAroundCamera(snow, SNOW_RADIUS, -0.22, delta, drift);
    wrapAroundCamera(bubbles, BUBBLE_RADIUS, 0.85, delta, drift);
    updateBursts(delta);

    animateFlashlight();
    updateFlicker(delta);

    for (const player of players.values()) player.mixer?.update(delta);

    if (onFrame) onFrame(delta);

    updateSnowLightUniforms(); // after game logic moved the camera
    composer.render();
  });
}
