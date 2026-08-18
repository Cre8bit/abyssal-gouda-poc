// graphics.js — Three.js module: scene, underwater atmosphere, players, bubbles.
import * as THREE from "three";

const OCEAN_COLOR = 0x006994;
const BUBBLE_COUNT = 400;
const BUBBLE_AREA = 60; // spawn area (x/z) around origin
const BUBBLE_HEIGHT = 30;

let scene;
let camera;
let renderer;
let bubbles;

const players = new Map(); // id -> THREE.Mesh

export function initGraphics(container) {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(OCEAN_COLOR);
  // Dense exponential fog for underwater depth.
  scene.fog = new THREE.FogExp2(OCEAN_COLOR, 0.06);

  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.1,
    200,
  );
  camera.position.set(0, 4, 10);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // Lighting: soft ambient + directional "sunlight from the surface".
  scene.add(new THREE.AmbientLight(0x88bbcc, 0.8));
  const sun = new THREE.DirectionalLight(0xaaddff, 1.2);
  sun.position.set(5, 20, 5);
  scene.add(sun);

  // Sea floor.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 300),
    new THREE.MeshStandardMaterial({ color: 0x03485f, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2;
  scene.add(floor);

  createBubbles();

  window.addEventListener("resize", onResize);

  return renderer.domElement;
}

function createBubbles() {
  const positions = new Float32Array(BUBBLE_COUNT * 3);
  for (let i = 0; i < BUBBLE_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * BUBBLE_AREA;
    positions[i * 3 + 1] = Math.random() * BUBBLE_HEIGHT - 2;
    positions[i * 3 + 2] = (Math.random() - 0.5) * BUBBLE_AREA;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: 0xbfefff,
    size: 0.12,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });

  bubbles = new THREE.Points(geometry, material);
  scene.add(bubbles);
}

function animateBubbles(delta) {
  const positions = bubbles.geometry.attributes.position;
  for (let i = 0; i < BUBBLE_COUNT; i++) {
    let y = positions.getY(i) + delta * (0.8 + (i % 5) * 0.15);
    if (y > BUBBLE_HEIGHT - 2) y = -2; // recycle at the sea floor
    positions.setY(i, y);
  }
  positions.needsUpdate = true;
}

export function addPlayer(id, color) {
  if (players.has(id)) return players.get(id);

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 32, 32),
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.3,
      metalness: 0.1,
    }),
  );
  mesh.position.set(0, 0, 0);
  scene.add(mesh);
  players.set(id, mesh);
  return mesh;
}

export function removePlayer(id) {
  const mesh = players.get(id);
  if (!mesh) return;
  scene.remove(mesh);
  mesh.geometry.dispose();
  mesh.material.dispose();
  players.delete(id);
}

export function updatePlayerPosition(id, x, y, z) {
  const mesh = players.get(id);
  if (mesh) mesh.position.set(x, y, z);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// Positions the camera behind the player, rotated by yaw and pitch.
export function updateCamera(playerPos, yaw, pitch) {
  const dist = 6;
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw);
  const cp = Math.cos(pitch),
    sp = Math.sin(pitch);
  camera.position.x = playerPos.x + sy * cp * dist;
  camera.position.y = playerPos.y + sp * dist + 1.5;
  camera.position.z = playerPos.z + cy * cp * dist;
  camera.lookAt(playerPos.x, playerPos.y + 0.5, playerPos.z);
}

// Starts the render loop. `onFrame(delta)` is called every frame
// before rendering — main.js hooks the game logic in there.
export function renderLoop(onFrame) {
  const clock = new THREE.Clock();

  renderer.setAnimationLoop(() => {
    const delta = clock.getDelta();
    animateBubbles(delta);
    if (onFrame) onFrame(delta);
    renderer.render(scene, camera);
  });
}
