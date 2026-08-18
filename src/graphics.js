// graphics.js — Three.js module: horror-grade abyssal first-person rendering.
// Real shadow-casting flashlight with flicker, post-processing (bloom +
// film grain + vignette + water wobble), procedural terrain, and a rigged
// low-poly diver model (GLB) for remote players.
import * as THREE from "three";
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

const ABYSS_COLOR = 0x000608; // almost pure black
const FOG_DENSITY = 0.055;

const TERRAIN_SIZE = 340;
const SNOW_COUNT = 1400;
const SNOW_RADIUS = 28;
const BUBBLE_COUNT = 200;
const BUBBLE_RADIUS = 22;

const FLASHLIGHT_INTENSITY = 600;
const REMOTE_LAMP_INTENSITY = 380;

// Rigged low-poly diver (Quaternius "Astronaut", CC0).
// If the file is missing, remote players fall back to a procedural diver.
const DIVER_MODEL_URL = `${import.meta.env.BASE_URL}models/diver.glb`;

let scene;
let camera;
let renderer;
let composer;
let horrorPass;
let snow;
let bubbles;
let flashlight; // { group, spot, beam, lens, on }
let bellLight; // flickering work light on the diving bell
let elapsed = 0;
let moveFactor = 0;
let flickerTimer = 0;

const players = new Map(); // id -> { group, pivot, mixer, placeholder, spot, beam }
const noise = new ImprovedNoise();

let diverModelPromise = null;
function loadDiverModel() {
  diverModelPromise ??= new GLTFLoader()
    .loadAsync(DIVER_MODEL_URL)
    .catch(() => null); // fall back silently if the GLB isn't there
  return diverModelPromise;
}

// --- Procedural terrain height (shared with gameplay for collision). ---
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
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  setupPostProcessing();

  // Near-total darkness: your flashlight is your world.
  scene.add(new THREE.AmbientLight(0x0a1f30, 0.12));
  const gloom = new THREE.DirectionalLight(0x0e3149, 0.09);
  gloom.position.set(2, 40, 1);
  scene.add(gloom);

  createTerrain();
  scatterRocks();
  createDivingBell();
  createFlashlight();
  createSnow();
  createBubbles();

  window.addEventListener("resize", onResize);

  return renderer.domElement;
}

// --- Post: bloom (lights glow in the water) + horror grade shader. ---
function setupPostProcessing() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.5, // strength — subtle halo around lights
    0.5, // radius
    0.8, // threshold — only bright things bloom
  );
  composer.addPass(bloom);

  composer.addPass(new OutputPass()); // tone mapping + sRGB

  // Final grade: film grain, heavy vignette, cold color push, water wobble.
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
        // Subtle refraction wobble, like looking through moving water.
        vec2 uv = vUv;
        uv += vec2(
          sin(uv.y * 42.0 + uTime * 0.9),
          cos(uv.x * 34.0 - uTime * 0.7)
        ) * 0.0011;

        vec3 col = texture2D(tDiffuse, uv).rgb;

        // Cold, desaturated grade — kill the reds, push blue-green.
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(col, vec3(lum), 0.25);
        col *= vec3(0.72, 0.94, 1.08);

        // Heavy claustrophobic vignette.
        float d = distance(vUv, vec2(0.5));
        col *= smoothstep(0.85, 0.30, d);

        // Animated film grain (stronger in the dark).
        float g = rand(vUv * 900.0 + fract(uTime * 13.7) * 100.0) - 0.5;
        col += g * (0.05 + (1.0 - lum) * 0.04);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  composer.addPass(horrorPass);
}

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
      color: 0x16262f,
      roughness: 0.96,
      metalness: 0.02,
    }),
  );
  terrain.receiveShadow = true;
  scene.add(terrain);
}

function scatterRocks() {
  const material = new THREE.MeshStandardMaterial({
    color: 0x1d2c35,
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
    // One of the work lights is dying — classic horror beacon.
    if (i === 2) bellLight = { light, bulb };
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

  const spot = new THREE.SpotLight(
    0xe6f2ff,
    FLASHLIGHT_INTENSITY,
    60,
    0.4,
    0.6,
    1.8,
  );
  spot.position.set(0, 0, -0.1);
  spot.target.position.set(-0.34, 0.28, -29.5); // converge on the crosshair
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.camera.near = 0.3;
  spot.shadow.camera.far = 60;
  spot.shadow.bias = -0.0003;
  group.add(spot);
  group.add(spot.target);

  const beamGeo = new THREE.CylinderGeometry(0.03, 2.6, 14, 24, 1, true);
  beamGeo.translate(0, -7, 0);
  beamGeo.rotateX(Math.PI / 2);
  const beam = new THREE.Mesh(
    beamGeo,
    new THREE.MeshBasicMaterial({
      color: 0x9fd4ff,
      transparent: true,
      opacity: 0.045,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  beam.position.z = -0.12;
  group.add(beam);

  group.position.set(0.34, -0.28, -0.5);
  group.rotation.set(0.03, -0.04, 0);
  camera.add(group);

  flashlight = { group, spot, beam, lens, on: true };
}

export function toggleFlashlight() {
  flashlight.on = !flashlight.on;
  flashlight.spot.visible = flashlight.on;
  flashlight.beam.visible = flashlight.on;
  flashlight.lens.material.emissiveIntensity = flashlight.on ? 6 : 0.05;
  return flashlight.on;
}

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
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uPixelRatio;
      attribute float aScale;
      attribute float aOffset;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.30 + aOffset) * 0.5;
        p.z += cos(uTime * 0.22 + aOffset * 1.7) * 0.5;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = aScale * uPixelRatio * (26.0 / -mv.z);
        vAlpha = smoothstep(28.0, 3.0, -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        float d = distance(gl_PointCoord, vec2(0.5));
        float a = smoothstep(0.5, 0.08, d) * vAlpha * 0.4;
        gl_FragColor = vec4(0.70, 0.80, 0.86, a);
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
    opacity: 0.3,
    depthWrite: false,
  });

  bubbles = new THREE.Points(geometry, material);
  scene.add(bubbles);
}

function wrapAroundCamera(points, radius, fall, delta) {
  const positions = points.geometry.attributes.position;
  const c = camera.position;
  const size = radius * 2;
  for (let i = 0; i < positions.count; i++) {
    let x = positions.getX(i);
    let y = positions.getY(i) + fall * delta * (0.7 + (i % 5) * 0.12);
    let z = positions.getZ(i);

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

// --- Remote divers: rigged GLB model (fallback: procedural diver). ---
export function addPlayer(id, color) {
  if (players.has(id)) return players.get(id);

  const group = new THREE.Group();
  const pivot = new THREE.Group(); // pitches with where they look
  group.add(pivot);

  // Procedural placeholder shown until (or instead of) the GLB.
  const placeholder = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.32, 0.65, 8, 16),
    new THREE.MeshStandardMaterial({ color: 0x161e23, roughness: 0.6 }),
  );
  body.rotation.x = Math.PI / 2;
  body.castShadow = true;
  placeholder.add(body);
  pivot.add(placeholder);

  // Glowing visor — their "face" in the dark.
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

  // Their headlamp: real shadow-casting spotlight + visible beam cone.
  const spot = new THREE.SpotLight(
    0xdcecff,
    REMOTE_LAMP_INTENSITY,
    45,
    0.45,
    0.6,
    1.8,
  );
  spot.position.set(0, 0.05, -0.6);
  spot.target.position.set(0, 0.05, -20);
  spot.castShadow = true;
  spot.shadow.mapSize.set(512, 512);
  spot.shadow.bias = -0.0003;
  pivot.add(spot);
  pivot.add(spot.target);

  const beamGeo = new THREE.CylinderGeometry(0.05, 2.4, 13, 20, 1, true);
  beamGeo.translate(0, -6.5, 0);
  beamGeo.rotateX(Math.PI / 2);
  const beam = new THREE.Mesh(
    beamGeo,
    new THREE.MeshBasicMaterial({
      color: 0xaddcff,
      transparent: true,
      opacity: 0.07,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  beam.position.set(0, 0.05, -0.6);
  pivot.add(beam);

  // Faint glow so they're findable at close range even from behind.
  pivot.add(new THREE.PointLight(color, 3, 12, 2));

  scene.add(group);
  const player = { group, pivot, mixer: null, placeholder, spot, beam };
  players.set(id, player);

  // Swap in the rigged diver model when it's available.
  loadDiverModel().then((gltf) => {
    if (!gltf || !players.has(id)) return;

    const model = SkeletonUtils.clone(gltf.scene);
    model.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.frustumCulled = false; // skinned meshes can mis-cull
      }
    });
    model.scale.setScalar(0.45);
    model.rotation.y = Math.PI; // face -Z (our forward)
    model.rotation.x = -1.15; // lean into a swimming posture
    model.position.set(0, -0.35, 0.15);
    pivot.add(model);

    placeholder.visible = false;

    // Play a swim-ish animation if the rig has one.
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

// Toggle a remote diver's headlamp (synced over the network).
export function setPlayerLight(id, on) {
  const player = players.get(id);
  if (!player) return;
  player.spot.visible = on;
  player.beam.visible = on;
}

export function updateCamera(playerPos, yaw, pitch, speed = 0) {
  camera.position.set(playerPos.x, playerPos.y, playerPos.z);
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  moveFactor += (speed - moveFactor) * 0.05;
}

function animateFlashlight(delta) {
  if (!flashlight) return;
  const t = elapsed;
  const bob = 1 + moveFactor * 3;
  flashlight.group.position.x = 0.34 + Math.sin(t * 1.1) * 0.006 * bob;
  flashlight.group.position.y =
    -0.28 + Math.sin(t * 2.3) * 0.008 + Math.sin(t * 3.7) * 0.005 * moveFactor;
  flashlight.group.rotation.z = Math.sin(t * 0.9) * 0.01 * bob;
  flashlight.group.rotation.x = 0.03 + Math.sin(t * 1.7) * 0.008 * bob;

  // Horror flicker: rare, brief, unsettling.
  if (flickerTimer <= 0 && Math.random() < delta * 0.12) {
    flickerTimer = 0.2 + Math.random() * 0.35;
  }
  let mult = 1;
  if (flickerTimer > 0) {
    flickerTimer -= delta;
    mult = 0.25 + Math.abs(Math.sin(t * 47)) * Math.random() * 0.75;
  }
  if (flashlight.on) {
    flashlight.spot.intensity = FLASHLIGHT_INTENSITY * mult;
    flashlight.lens.material.emissiveIntensity = 6 * mult;
    flashlight.beam.material.opacity = 0.045 * mult;
  }

  // The dying work light on the diving bell.
  if (bellLight) {
    const b = Math.sin(t * 3.1) * Math.sin(t * 7.7) * Math.sin(t * 1.3);
    const on = b > -0.2 ? 1 : 0.05;
    bellLight.light.intensity = 14 * on;
    bellLight.bulb.material.emissiveIntensity = 3 * on;
  }
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
    wrapAroundCamera(snow, SNOW_RADIUS, -0.22, delta);
    wrapAroundCamera(bubbles, BUBBLE_RADIUS, 0.85, delta);
    animateFlashlight(delta);

    for (const player of players.values()) player.mixer?.update(delta);

    if (onFrame) onFrame(delta);
    composer.render();
  });
}
