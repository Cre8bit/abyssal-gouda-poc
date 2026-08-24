// creature.js — one creature per depth. It patrols slowly on its own noise
// track and never attacks; the horror is entirely in hearing it and not being
// able to place it. Built from primitives, so the model can be swapped later.
import * as THREE from "three";

export const CREATURE_LENGTH = 78; // 3x the old silhouette
const PATROL_RADIUS = 150; // how far from the bell it roams
const SPEED = 4.5;

const _target = new THREE.Vector3();

export function createCreature(scene) {
  // Faintly self-lit and fog-exempt: pure black is invisible against black
  // water, so its bulk has to sit just above the darkest value in the scene.
  const skin = new THREE.MeshStandardMaterial({
    color: 0x0e1c26,
    roughness: 0.95,
    metalness: 0,
    emissive: 0x081018,
    emissiveIntensity: 0.7,
    fog: false,
  });

  const group = new THREE.Group();
  const half = CREATURE_LENGTH * 0.5;

  const trunk = new THREE.Mesh(new THREE.SphereGeometry(1, 22, 16), skin);
  trunk.scale.set(half * 0.17, half * 0.21, half);
  group.add(trunk);

  const head = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), skin);
  head.scale.set(half * 0.2, half * 0.19, half * 0.26);
  head.position.z = -half * 0.92;
  group.add(head);

  const tail = new THREE.Mesh(new THREE.ConeGeometry(1, 2.6, 4), skin);
  tail.scale.set(half * 0.1, half * 0.34, half * 0.04);
  tail.rotation.z = Math.PI / 2;
  tail.position.z = half * 1.02;
  group.add(tail);

  const ridge = new THREE.Mesh(new THREE.ConeGeometry(1, 2, 3), skin);
  ridge.scale.set(half * 0.02, half * 0.11, half * 0.4);
  ridge.position.y = half * 0.16;
  group.add(ridge);

  // Two dim eyes: the only part that ever catches your torch.
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x243038,
    emissive: 0x6fd4c4,
    emissiveIntensity: 1.1,
  });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(half * 0.032, 8, 8), eyeMat);
    eye.position.set(side * half * 0.13, half * 0.05, -half * 1.03);
    group.add(eye);
  }

  group.visible = false;
  scene.add(group);

  const state = {
    group,
    heading: 0,
    seed: Math.random() * 100,
    centre: new THREE.Vector3(),
  };

  // Called each time the bell settles at a new depth.
  function spawn(centre) {
    state.centre.copy(centre);
    const a = Math.random() * Math.PI * 2;
    const d = PATROL_RADIUS * (0.5 + Math.random() * 0.5);
    group.position.set(
      centre.x + Math.cos(a) * d,
      centre.y + (Math.random() - 0.5) * 60,
      centre.z + Math.sin(a) * d,
    );
    state.heading = Math.random() * Math.PI * 2;
    group.visible = true;
  }

  function update(delta, elapsed, noise) {
    if (!group.visible) return;

    // Wander, but lean back toward the patrol centre so it never leaves for good.
    state.heading += noise.noise(elapsed * 0.07, state.seed, 0) * 0.5 * delta;
    const away = group.position.distanceTo(state.centre);
    if (away > PATROL_RADIUS) {
      const home = Math.atan2(
        state.centre.z - group.position.z,
        state.centre.x - group.position.x,
      );
      state.heading += angleTo(state.heading, home) * 0.6 * delta;
    }

    const climb = noise.noise(0, elapsed * 0.05, state.seed) * 0.35;
    group.position.x += Math.cos(state.heading) * SPEED * delta;
    group.position.y += climb * SPEED * delta;
    group.position.z += Math.sin(state.heading) * SPEED * delta;

    _target.set(
      group.position.x + Math.cos(state.heading),
      group.position.y + climb,
      group.position.z + Math.sin(state.heading),
    );
    group.lookAt(_target);
    // Its body works as it swims — a slow lateral beat down the length.
    group.rotateZ(Math.sin(elapsed * 0.9 + state.seed) * 0.1);
    group.rotateY(Math.PI); // the head leads, and the mesh points along -Z
  }

  return { spawn, update, position: group.position, group };
}

// Shortest signed turn from a to b.
function angleTo(a, b) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}
