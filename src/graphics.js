// graphics.js — Three.js module: abyssal first-person underwater rendering.
// Custom GLSL shaders for marine snow and floor caustics, diver headlamp,
// dense fog, bubbles, and glowing remote players.
import * as THREE from "three";

const ABYSS_COLOR = 0x02090f; // near-black deep blue
const FOG_DENSITY = 0.045;

const SNOW_COUNT = 1200;
const SNOW_RADIUS = 30; // volume half-size around the camera
const BUBBLE_COUNT = 250;
const BUBBLE_RADIUS = 25;

let scene;
let camera;
let renderer;
let snow;
let bubbles;
let causticsMaterial;

const players = new Map(); // id -> THREE.Group

export function initGraphics(container) {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(ABYSS_COLOR);
  scene.fog = new THREE.FogExp2(ABYSS_COLOR, FOG_DENSITY);

  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    120,
  );
  camera.rotation.order = "YXZ"; // yaw, then pitch — first-person convention
  camera.position.set(0, 2, 0);
  scene.add(camera);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  container.appendChild(renderer.domElement);

  // --- Lighting: almost nothing filters down here. ---
  scene.add(new THREE.AmbientLight(0x0b2233, 0.5));
  const moonlight = new THREE.DirectionalLight(0x1e4a66, 0.35);
  moonlight.position.set(3, 30, 2);
  scene.add(moonlight);

  // Diver headlamp: a warm-white cone parented to the camera.
  const headlamp = new THREE.SpotLight(0xd8ecff, 60, 45, 0.55, 0.65, 1.7);
  headlamp.position.set(0, -0.15, 0.1);
  headlamp.target.position.set(0, -0.5, -10);
  camera.add(headlamp);
  camera.add(headlamp.target);

  // --- Sea floor (lit by the headlamp). ---
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400, 64, 64),
    new THREE.MeshStandardMaterial({ color: 0x0a1c26, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2;
  scene.add(floor);

  createCaustics();
  createSnow();
  createBubbles();
  scatterRocks();

  window.addEventListener("resize", onResize);

  return renderer.domElement;
}

// --- Faint animated caustic shimmer on the floor (custom shader). ---
function createCaustics() {
  causticsMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vViewZ;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying float vViewZ;

      void main() {
        vec2 p = vUv * 60.0;
        float c = 0.0;
        for (int i = 0; i < 3; i++) {
          float t = uTime * (0.25 + float(i) * 0.11);
          p += vec2(sin(p.y * 0.65 + t), cos(p.x * 0.55 - t)) * 0.4;
          c += 1.0 / max(length(fract(p) - 0.5), 0.06);
        }
        c = pow(c * 0.075, 3.2);
        // Fade with distance so it dissolves into the dark.
        float fade = smoothstep(45.0, 8.0, vViewZ);
        vec3 col = vec3(0.10, 0.35, 0.45) * c;
        gl_FragColor = vec4(col, c * 0.20 * fade);
      }
    `,
  });

  const plane = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), causticsMaterial);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -1.98;
  scene.add(plane);
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
        gl_PointSize = aScale * uPixelRatio * (30.0 / -mv.z);
        vAlpha = smoothstep(30.0, 4.0, -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        float d = distance(gl_PointCoord, vec2(0.5));
        float a = smoothstep(0.5, 0.08, d) * vAlpha * 0.5;
        gl_FragColor = vec4(0.72, 0.82, 0.88, a);
      }
    `,
  });

  snow = new THREE.Points(geometry, material);
  scene.add(snow);
}

// --- Rising bubbles (reuses the snow shader style, tinted cyan). ---
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
    size: 0.08,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });

  bubbles = new THREE.Points(geometry, material);
  scene.add(bubbles);
}

// --- A few rocks so the headlamp has something to reveal. ---
function scatterRocks() {
  const material = new THREE.MeshStandardMaterial({
    color: 0x14242e,
    roughness: 1,
  });
  for (let i = 0; i < 40; i++) {
    const size = 0.4 + Math.random() * 2.2;
    const rock = new THREE.Mesh(
      new THREE.DodecahedronGeometry(size, 0),
      material,
    );
    rock.position.set(
      (Math.random() - 0.5) * 160,
      -2 + size * 0.3,
      (Math.random() - 0.5) * 160,
    );
    rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    rock.scale.y = 0.5 + Math.random() * 0.5;
    scene.add(rock);
  }
}

// Keep a particle field wrapped around the camera so it never runs out.
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

// --- Players (remote divers): glowing capsule + directional cone + light. ---
export function addPlayer(id, color) {
  if (players.has(id)) return players.get(id);

  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 0.7, 8, 16),
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.4,
      emissive: color,
      emissiveIntensity: 0.25,
    }),
  );
  body.rotation.x = Math.PI / 2; // horizontal, swimming posture
  group.add(body);

  // "Headlamp" cone hinting at facing direction.
  const lamp = new THREE.Mesh(
    new THREE.ConeGeometry(0.12, 0.3, 12),
    new THREE.MeshStandardMaterial({
      color: 0xfff2cc,
      emissive: 0xffe9a8,
      emissiveIntensity: 1.5,
    }),
  );
  lamp.rotation.x = -Math.PI / 2;
  lamp.position.set(0, 0.1, -0.75);
  group.add(lamp);

  // Dim glow so the other diver is findable in the dark.
  group.add(new THREE.PointLight(color, 4, 16, 1.8));

  scene.add(group);
  players.set(id, group);
  return group;
}

export function removePlayer(id) {
  const group = players.get(id);
  if (!group) return;
  scene.remove(group);
  group.traverse((obj) => {
    obj.geometry?.dispose();
    obj.material?.dispose();
  });
  players.delete(id);
}

export function updatePlayerPosition(id, x, y, z, yaw = null) {
  const group = players.get(id);
  if (!group) return;
  group.position.set(x, y, z);
  if (yaw !== null) group.rotation.y = yaw;
}

// First-person camera: the camera IS the local diver's eyes.
export function updateCamera(playerPos, yaw, pitch) {
  camera.position.set(playerPos.x, playerPos.y, playerPos.z);
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// Starts the render loop. `onFrame(delta)` is called every frame
// before rendering — main.js hooks the game logic in there.
export function renderLoop(onFrame) {
  const clock = new THREE.Clock();

  renderer.setAnimationLoop(() => {
    const delta = Math.min(clock.getDelta(), 0.1);
    const elapsed = clock.elapsedTime;

    snow.material.uniforms.uTime.value = elapsed;
    causticsMaterial.uniforms.uTime.value = elapsed;
    wrapAroundCamera(snow, SNOW_RADIUS, -0.25, delta); // snow sinks
    wrapAroundCamera(bubbles, BUBBLE_RADIUS, 0.9, delta); // bubbles rise

    if (onFrame) onFrame(delta);
    renderer.render(scene, camera);
  });
}
