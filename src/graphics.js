// graphics.js — Three.js module: realistic abyssal first-person rendering.
// Procedural rocky terrain, handheld flashlight with volumetric beam,
// marine snow shader, diving-bell landmark, glowing remote divers.
import * as THREE from "three";
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";

const ABYSS_COLOR = 0x010a12;
const FOG_DENSITY = 0.05;

const TERRAIN_SIZE = 340;
const SNOW_COUNT = 1400;
const SNOW_RADIUS = 28;
const BUBBLE_COUNT = 200;
const BUBBLE_RADIUS = 22;

let scene;
let camera;
let renderer;
let snow;
let bubbles;
let flashlight; // { group, spot, beam, lens, on }
let elapsed = 0;
let moveFactor = 0; // 0..1, drives flashlight bob

const players = new Map(); // id -> { group, pivot }
const noise = new ImprovedNoise();

// --- Procedural terrain height (shared with gameplay for collision). ---
export function terrainHeight(x, z) {
  let h = 0;
  h += noise.noise(x * 0.011, z * 0.011, 0.5) * 10; // large dunes/ridges
  h += noise.noise(x * 0.045, z * 0.045, 17.7) * 2.4; // medium bumps
  h += noise.noise(x * 0.16, z * 0.16, 31.4) * 0.5; // small detail
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
  renderer.toneMappingExposure = 1.2;
  container.appendChild(renderer.domElement);

  // Almost no natural light this deep — just enough to silhouette shapes.
  scene.add(new THREE.AmbientLight(0x11324a, 0.28));
  const gloom = new THREE.DirectionalLight(0x14405e, 0.18);
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

// --- Rocky sea floor from a noise heightfield. ---
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
      color: 0x1a2f3a,
      roughness: 0.96,
      metalness: 0.02,
    }),
  );
  scene.add(terrain);
}

function scatterRocks() {
  const material = new THREE.MeshStandardMaterial({
    color: 0x22333d,
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
    scene.add(rock);
  }
}

// --- Diving bell landmark: a lit structure players can navigate by. ---
function createDivingBell() {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({
    color: 0x2a3338,
    roughness: 0.55,
    metalness: 0.75,
  });

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1.6, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    metal,
  );
  dome.position.y = 3.4;
  group.add(dome);

  const cage = new THREE.Mesh(
    new THREE.CylinderGeometry(1.7, 1.9, 3.2, 10, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0x2a3338,
      roughness: 0.6,
      metalness: 0.7,
      wireframe: true,
    }),
  );
  cage.position.y = 1.8;
  group.add(cage);

  const base = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.3, 0.35, 12), metal);
  base.position.y = 0.15;
  group.add(base);

  // Work lights around the dome.
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
    const light = new THREE.PointLight(0xbfe0ff, 20, 26, 1.8);
    light.position.copy(bulb.position);
    group.add(light);
  }

  const x = 0;
  const z = -14;
  group.position.set(x, terrainHeight(x, z) + 0.2, z);
  scene.add(group);
}

// --- Handheld flashlight: visible body in view + spot + volumetric beam. ---
function createFlashlight() {
  const group = new THREE.Group();

  // Torch body, held low-right like the reference shot.
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

  // The actual light. Physical units — needs to be strong to cut the dark.
  const spot = new THREE.SpotLight(0xe6f2ff, 550, 60, 0.42, 0.55, 1.8);
  spot.position.set(0, 0, -0.1);
  spot.target.position.set(-0.34, 0.28, -29.5); // converge on the crosshair
  group.add(spot);
  group.add(spot.target);

  // Fake volumetric beam: faint additive open cone in the water.
  const beamGeo = new THREE.CylinderGeometry(0.03, 2.6, 14, 24, 1, true);
  beamGeo.translate(0, -7, 0);
  beamGeo.rotateX(Math.PI / 2); // extend along -Z
  const beam = new THREE.Mesh(
    beamGeo,
    new THREE.MeshBasicMaterial({
      color: 0x9fd4ff,
      transparent: true,
      opacity: 0.05,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  beam.position.z = -0.12;
  group.add(beam);

  // Held in the lower-right of the view, angled slightly inward.
  group.position.set(0.34, -0.28, -0.5);
  group.rotation.set(0.03, -0.04, 0);
  camera.add(group);

  flashlight = { group, spot, beam, lens, on: true };
}

export function toggleFlashlight() {
  flashlight.on = !flashlight.on;
  flashlight.spot.visible = flashlight.on;
  flashlight.beam.visible = flashlight.on;
  flashlight.lens.material.emissiveIntensity = flashlight.on ? 6 : 0.1;
  return flashlight.on;
}

// --- Marine snow: soft drifting specks (custom point shader). ---
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
        float a = smoothstep(0.5, 0.08, d) * vAlpha * 0.45;
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
    opacity: 0.35,
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

// --- Remote divers: dark suit + headlamp with a VISIBLE beam cone, so the
// --- other player can be spotted from far away by their light.
export function addPlayer(id, color) {
  if (players.has(id)) return players.get(id);

  const group = new THREE.Group();
  const pivot = new THREE.Group(); // pitches with where they look
  group.add(pivot);

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.32, 0.65, 8, 16),
    new THREE.MeshStandardMaterial({ color: 0x1c262c, roughness: 0.6 }),
  );
  body.rotation.x = Math.PI / 2; // horizontal swimming posture
  pivot.add(body);

  // Glowing visor.
  const visor = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 12, 12),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 2.5,
    }),
  );
  visor.position.set(0, 0.12, -0.55);
  pivot.add(visor);

  // Their headlamp: real spotlight + additive beam cone visible from the side.
  const spot = new THREE.SpotLight(0xdcecff, 350, 45, 0.45, 0.6, 1.8);
  spot.position.set(0, 0.05, -0.6);
  spot.target.position.set(0, 0.05, -20);
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

  // Soft glow so they're findable at close-mid range even from behind.
  pivot.add(new THREE.PointLight(color, 6, 14, 1.9));

  scene.add(group);
  players.set(id, { group, pivot });
  return group;
}

export function removePlayer(id) {
  const player = players.get(id);
  if (!player) return;
  scene.remove(player.group);
  player.group.traverse((obj) => {
    obj.geometry?.dispose();
    obj.material?.dispose();
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

// First-person camera + flashlight bob. `speed` is 0..1 (how fast we swim).
export function updateCamera(playerPos, yaw, pitch, speed = 0) {
  camera.position.set(playerPos.x, playerPos.y, playerPos.z);
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  moveFactor += (speed - moveFactor) * 0.05;
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

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// Starts the render loop. `onFrame(delta)` is called every frame.
export function renderLoop(onFrame) {
  const clock = new THREE.Clock();

  renderer.setAnimationLoop(() => {
    const delta = Math.min(clock.getDelta(), 0.1);
    elapsed = clock.elapsedTime;

    snow.material.uniforms.uTime.value = elapsed;
    wrapAroundCamera(snow, SNOW_RADIUS, -0.22, delta);
    wrapAroundCamera(bubbles, BUBBLE_RADIUS, 0.85, delta);
    animateFlashlight();

    if (onFrame) onFrame(delta);
    renderer.render(scene, camera);
  });
}
