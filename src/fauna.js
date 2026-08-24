// fauna.js — the things that make the water feel inhabited: schools of small
// fish that shoal and drift, and far-off lights you can never reach.
import * as THREE from "three";

const SCHOOLS = 4;
const PER_SCHOOL = 80;
const FISH_TOTAL = SCHOOLS * PER_SCHOOL;
const SCHOOL_LEASH = 70; // re-seed a school once it drifts past this
const SCHOOL_NEAR = 24; // never re-seed one closer than this

const LURE_COUNT = 9;
const LURE_MIN = 130;
const LURE_MAX = 420;

const JELLY_COUNT = 5;
const JELLY_LEASH = 80;


const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);

function makeJellyfish() {
  const group = new THREE.Group();
  const bell = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
    new THREE.MeshStandardMaterial({
      color: 0x9fc4d8,
      emissive: 0x2a5570,
      emissiveIntensity: 0.9,
      transparent: true,
      opacity: 0.34,
      roughness: 0.25,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  group.add(bell);

  // A few trailing streamers, tapering away to nothing.
  const strands = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const line = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.005, 4.5, 4),
      new THREE.MeshStandardMaterial({
        color: 0x8fb6cc,
        emissive: 0x1d3d52,
        emissiveIntensity: 0.7,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      }),
    );
    line.position.set(Math.cos(a) * 0.55, -2.3, Math.sin(a) * 0.55);
    strands.add(line);
  }
  group.add(strands);
  return group;
}

export function createFauna(scene, noise, haloFactory) {
  // --- Fish: one instanced sliver of a body, oriented along its heading. ---
  const body = new THREE.OctahedronGeometry(1, 0);
  body.scale(0.06, 0.03, 0.40); // slivers, not lozenges: baitfish seen edge-on
  const fish = new THREE.InstancedMesh(
    body,
    new THREE.MeshStandardMaterial({
      color: 0x6c7a85,
      roughness: 0.34,
      metalness: 0.5,
      // Just enough self-glow to register unlit; the torch does the rest.
      emissive: 0x151d24,
    }),
    FISH_TOTAL,
  );
  fish.frustumCulled = false;
  fish.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(fish);

  const schools = [];
  for (let i = 0; i < SCHOOLS; i++) {
    schools.push({
      centre: new THREE.Vector3(),
      seed: Math.random() * 100,
      radius: 3 + Math.random() * 5,
      seeded: false,
    });
  }

  const offsets = [];
  for (let i = 0; i < FISH_TOTAL; i++) {
    offsets.push({
      phase: Math.random() * Math.PI * 2,
      speed: 0.7 + Math.random() * 0.9,
      tilt: (Math.random() - 0.5) * 0.9,
      band: 0.35 + Math.random() * 0.9,
    });
  }

  // --- Lures: pinpricks of light out in the dark, fog-free so distance never
  // erases them. Nothing is ever there when you swim over. ---
  const lures = [];
  const placeLure = (sprite, camera) => {
    const a = Math.random() * Math.PI * 2;
    const d = LURE_MIN + Math.random() * (LURE_MAX - LURE_MIN);
    sprite.position.set(
      Math.cos(a) * d,
      (camera ? camera.position.y : 0) + (Math.random() - 0.5) * 160,
      Math.sin(a) * d,
    );
  };
  for (let i = 0; i < LURE_COUNT; i++) {
    const warm = i % 4 === 0;
    const sprite = haloFactory(2.4, 0, warm ? 0xff6a4a : 0xbfe6ff);
    sprite.material.fog = false;
    placeLure(sprite, null);
    scene.add(sprite);
    lures.push({
      sprite,
      seed: Math.random() * 100,
      period: 9 + Math.random() * 22,
      offset: Math.random() * 30,
      peak: warm ? 0.62 : 0.46,
    });
  }

  // --- Jellyfish: slow, faintly lit, and completely indifferent to you. ---
  const jellies = [];
  for (let i = 0; i < JELLY_COUNT; i++) {
    const group = makeJellyfish();
    const scale = 0.7 + Math.random() * 1.5;
    group.scale.setScalar(scale);
    scene.add(group);
    jellies.push({
      group,
      seed: Math.random() * 100,
      pulse: 0.5 + Math.random() * 0.5,
      seeded: false,
    });
  }

  function reseedJelly(jelly, camera) {
    const a = Math.random() * Math.PI * 2;
    const d = 18 + Math.random() * (JELLY_LEASH - 30);
    jelly.group.position.set(
      camera.position.x + Math.cos(a) * d,
      camera.position.y + (Math.random() - 0.5) * 40,
      camera.position.z + Math.sin(a) * d,
    );
    jelly.seeded = true;
  }

  function reseedSchool(school, camera) {
    const a = Math.random() * Math.PI * 2;
    const d = SCHOOL_NEAR + Math.random() * (SCHOOL_LEASH - SCHOOL_NEAR - 10);
    school.centre.set(
      camera.position.x + Math.cos(a) * d,
      camera.position.y + (Math.random() - 0.5) * 30,
      camera.position.z + Math.sin(a) * d,
    );
    school.seeded = true;
  }

  function update(camera, elapsed, delta) {
    let index = 0;
    for (const school of schools) {
      if (!school.seeded) reseedSchool(school, camera);

      // The school wanders on its own noise track, unhurried.
      const t = elapsed * 0.06 + school.seed;
      school.centre.x += noise.noise(t, school.seed, 0) * 2.4 * delta;
      school.centre.y += noise.noise(0, t, school.seed) * 0.9 * delta;
      school.centre.z += noise.noise(school.seed, 0, t) * 2.4 * delta;
      if (school.centre.distanceTo(camera.position) > SCHOOL_LEASH) {
        reseedSchool(school, camera);
      }

      for (let i = 0; i < PER_SCHOOL; i++, index++) {
        const o = offsets[index];
        const a = o.phase + elapsed * o.speed * 0.5;
        const r = school.radius * o.band;
        _v.set(
          school.centre.x + Math.cos(a) * r,
          school.centre.y + Math.sin(a * 0.7 + o.tilt) * r * 0.45,
          school.centre.z + Math.sin(a) * r,
        );
        // Face along the tangent of the circling path.
        _q.setFromUnitVectors(
          UP,
          _v
            .clone()
            .sub(school.centre)
            .cross(UP)
            .normalize()
            .lerp(UP, 0.05)
            .normalize(),
        );
        _m.compose(_v, _q, _s);
        fish.setMatrixAt(index, _m);
      }
    }
    fish.instanceMatrix.needsUpdate = true;

    // Jellyfish rise gently, breathe, and drift out of your life again.
    for (const jelly of jellies) {
      if (!jelly.seeded) reseedJelly(jelly, camera);
      const p = jelly.group.position;
      p.y += (0.10 + 0.05 * Math.sin(elapsed * jelly.pulse + jelly.seed)) * delta;
      p.x += noise.noise(elapsed * 0.05 + jelly.seed, 0, 0) * 0.5 * delta;
      p.z += noise.noise(0, elapsed * 0.05 + jelly.seed, 0) * 0.5 * delta;
      // The bell contracts and relaxes as it swims.
      const squeeze = 1 + 0.16 * Math.sin(elapsed * jelly.pulse * 2.2 + jelly.seed);
      jelly.group.scale.y = jelly.group.scale.x / squeeze;
      if (p.distanceTo(camera.position) > JELLY_LEASH) reseedJelly(jelly, camera);
    }

    for (const lure of lures) {
      // Reposition only while invisible, so one never pops in place.
      if (lure.sprite.material.opacity <= 0.001 && Math.random() < 0.01) {
        placeLure(lure.sprite, camera);
      }
      // Slow independent breathing: each one surfaces and is gone again.
      const cycle = ((elapsed + lure.offset) % lure.period) / lure.period;
      const bell = Math.sin(Math.PI * cycle);
      lure.sprite.material.opacity = lure.peak * Math.pow(Math.max(bell, 0), 1.6);
      lure.sprite.position.y += Math.sin(elapsed * 0.3 + lure.seed) * 0.02;
    }
  }

  return { update };
}
