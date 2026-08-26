// catfish.js — the lantern-catfish: a predator haunting the open water.
//
// Loads models/catfish_rigged.glb (skinned + three baked clips: "swim" loop,
// "bite" one-shot, "flicker" loop) and runs a small state machine per fish:
//
//   LURK   — cruises the clear water around the cheese ball (or a labyrinth
//            pocket), lantern glowing warm — from far away you see only the
//            bulb, a soft light bobbing in the dark
//   STALK  — a player spotted: closes in, lantern dimmed to a nervous
//            blinking flicker
//   STRIKE — winds up and lunges, plays the bite clip, lantern flares
//
// NETWORKING (host-authoritative): the HOST simulates every fish and
// broadcasts compact states (~8 Hz, see main.js). Joiners call
// applyCatfishState() and run "puppets" that interpolate toward the host's
// states and mirror the bite/lantern moments. Solo players simulate locally.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  findOpenSpot,
  resolveCollision,
  getSpawnPoint,
  WORLD_R,
} from "./gouda.js";
import { toonify } from "./toon.js";

const MODEL_URL = `${import.meta.env.BASE_URL}models/catfish_rigged.glb`;

const SCALE = 4; // model is ~1 unit long
const FISH_RADIUS = 1.1; // collision clearance
const LURK_SPEED = 1.7;
const STALK_SPEED = 3.6;
const LUNGE_SPEED = 11.0;
const STALK_RANGE = 30; // notices a player
const LOSE_RANGE = 40; // gives up
const STRIKE_RANGE = 6;
const BITE_HIT_RANGE = 3.4;
const BITE_COOLDOWN = 3.5; // seconds between lunges
const BITE_DURATION = 1.0; // matches the baked clip
const BITE_SNAP_T = 0.38; // jaws slam shut at this point of the clip
const WAYPOINT_EPS = 3;
const TURN_RATE = 1.8; // rad/s yaw ease (heavy, deliberate turns)
const SAFE_RADIUS = 75; // no-hunt bubble around the player spawn point
const SPAWN_MIN = 95; // fish first appear between these distances from
const SPAWN_MAX = 240; // spawn — visible bulbs in the distance, not a threat
const STATE_ID = { lurk: 0, stalk: 1, strike: 2 };
const STATE_NAME = ["lurk", "stalk", "strike"];

let scene = null;
let templatePromise = null;
const fishes = [];
let hooks = {}; // { onBite(fishPos) }
let authority = true; // false = puppet mode (a host feeds us states)
let pendingPuppets = 0; // puppet count requested before the template loaded
// Spawn generation: bumped by every spawn/despawn. The async template load
// checks it before adding fish, so a world rebuild that despawns while a
// previous spawnCatfish() is still loading can't double the school.
let spawnGen = 0;

function loadTemplate() {
  templatePromise ??= new GLTFLoader()
    .loadAsync(MODEL_URL)
    .then((gltf) => {
      gltf.scene.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh) {
          o.castShadow = true;
          o.frustumCulled = false; // skinned bounds don't follow the bones
        }
      });
      toonify(gltf.scene, { ink: 0.8 }); // heavy ink — it's the monster
      return gltf;  
    })
    .catch((err) => {
      console.warn("catfish model failed to load", err);
      return null;
    });
  return templatePromise;
}

// Soft round glow sprite for the lantern (self-contained tiny halo).
let glowTex = null;
function lanternGlowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,240,200,0.9)");
  g.addColorStop(0.4, "rgba(255,210,140,0.25)");
  g.addColorStop(1, "rgba(255,190,110,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

export function initCatfishSystem(sceneRef) {
  scene = sceneRef;
  loadTemplate(); // start fetching early
}

export function despawnCatfish() {
  spawnGen++;
  for (const f of fishes) {
    scene?.remove(f.group);
    // The skinned clone SHARES the template's geometry/materials (they are
    // reused by the next spawn — don't dispose them). Only the per-fish
    // resources go: the glow sprite's material (its texture is the shared
    // cached halo), the lantern light, and the mixer's binding caches.
    f.glow.material.dispose();
    f.light.dispose();
    f.mixer.stopAllAction();
    f.mixer.uncacheRoot(f.mixer.getRoot());
  }
  fishes.length = 0;
}

export function spawnCatfish(count, gameHooks = {}) {
  hooks = gameHooks;
  const gen = ++spawnGen;
  loadTemplate().then((gltf) => {
    if (gen !== spawnGen) return; // a rebuild superseded this spawn
    if (!gltf || !scene || !authority) return;
    // Mostly OPEN-WATER hunters (visible from the drift as distant bulbs);
    // every 4th one haunts a pocket inside the labyrinth.
    for (let i = 0; i < count; i++)
      spawnOne(gltf, i % 4 === 3 ? "maze" : "open");
  });
}

function distToSpawn(p) {
  const s = getSpawnPoint();
  return Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z);
}

// A wander point in the clear ring around the ball (outside the crust,
// inside the soft leash the player is held by) — never inside the safe
// bubble around the player spawn.
function openWaterSpot(near = null) {
  const p = new THREE.Vector3();
  for (let tries = 0; tries < 12; tries++) {
    if (near) {
      p.set(
        near.x + (Math.random() - 0.5) * 50,
        near.y + (Math.random() - 0.5) * 34,
        near.z + (Math.random() - 0.5) * 50,
      );
    } else {
      // First placement: a ring around the spawn — close enough that a
      // lone diver sees bulbs bobbing in the distance, far enough that the
      // spawn itself stays safe.
      const s = getSpawnPoint();
      const a = Math.random() * Math.PI * 2;
      const d = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
      p.set(
        s.x + Math.cos(a) * d,
        s.y + (Math.random() - 0.5) * 70,
        s.z + Math.sin(a) * d,
      );
    }
    const r = Math.max(WORLD_R * 0.92, Math.min(WORLD_R + 18, p.length() || 1));
    p.normalize().multiplyScalar(r);
    if (distToSpawn(p) > SAFE_RADIUS) break; // outside the bubble — done
  }
  return { x: p.x, y: p.y, z: p.z };
}

function spawnOne(gltf, habitat = "open") {
  const root = cloneSkinned(gltf.scene);
  const group = new THREE.Group();
  root.scale.setScalar(SCALE);
  group.add(root);

  // Lantern: find the bulb bone (glTF "forehead.L.017"; three strips dots).
  let bulb = null;
  root.traverse((o) => {
    const n = (o.name || "").toLowerCase();
    if (n.includes("forehead") && n.includes("017")) bulb = o;
  });
  const light = new THREE.PointLight(0xffd9a0, 55, 36, 2);
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: lanternGlowTexture(),
      color: 0xffe2b0,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  glow.scale.setScalar(0.8); // bulb-local; rescaled per-frame with distance
  if (bulb) {
    bulb.add(light);
    bulb.add(glow);
    light.position.set(0, 0.05, 0); // just past the bulb tip
    glow.position.set(0, 0.05, 0);
  } else {
    group.add(light);
    group.add(glow);
    light.position.set(0, 0.5 * SCALE, 0.5 * SCALE);
  }

  // Animation clips
  const mixer = new THREE.AnimationMixer(root);
  const clip = (n) => THREE.AnimationClip.findByName(gltf.animations, n);
  const swim = mixer.clipAction(clip("swim"));
  swim.play();
  const flicker = mixer.clipAction(clip("flicker"));
  flicker.play();
  const bite = mixer.clipAction(clip("bite"));
  bite.setLoop(THREE.LoopOnce);
  bite.clampWhenFinished = false;

  const spot = habitat === "open" ? openWaterSpot() : findOpenSpot();
  const pos = { x: spot.x, y: spot.y, z: spot.z };
  group.position.set(pos.x, pos.y, pos.z);
  scene.add(group);

  fishes.push({
    group,
    mixer,
    swim,
    bite,
    light,
    glow,
    pos,
    vel: { x: 0, y: 0, z: 0 },
    yaw: Math.random() * Math.PI * 2,
    pitch: 0,
    roll: 0,
    animSpeed: 1,
    state: "lurk",
    habitat,
    waypoint: habitat === "open" ? openWaterSpot(pos) : nextWaypoint(pos),
    cooldown: Math.random() * BITE_COOLDOWN,
    bitTimer: -1, // time since bite started; -1 = not biting
    seed: Math.random() * 100,
    net: null, // puppet interpolation target
  });
}

function nextWaypoint(from) {
  return findOpenSpot(from, 12, 32);
}

function wanderPoint(f) {
  return f.habitat === "open" ? openWaterSpot(f.pos) : nextWaypoint(f.pos);
}

// ---------------------------------------------------------------------------
// Network sync (host-authoritative)
// ---------------------------------------------------------------------------

export function setCatfishAuthority(a) {
  authority = a;
}

// Compact per-fish state for the host to broadcast.
export function getCatfishState() {
  return fishes.map((f) => [
    +f.pos.x.toFixed(2),
    +f.pos.y.toFixed(2),
    +f.pos.z.toFixed(2),
    +f.yaw.toFixed(3),
    +f.pitch.toFixed(3),
    STATE_ID[f.state] ?? 0,
  ]);
}

// Joiners: adopt the host's fish as interpolated puppets.
export function applyCatfishState(arr) {
  if (!Array.isArray(arr)) return;
  authority = false;
  if (fishes.length !== arr.length && pendingPuppets !== arr.length) {
    // (Re)build the school to match the host's count.
    pendingPuppets = arr.length;
    despawnCatfish();
    const gen = spawnGen; // despawn just bumped it — adopt that generation
    loadTemplate().then((gltf) => {
      if (gen !== spawnGen) return; // superseded by a newer spawn/despawn
      if (!gltf || !scene || pendingPuppets === 0) return;
      const n = pendingPuppets;
      pendingPuppets = 0;
      for (let i = 0; i < n; i++) spawnOne(gltf, "open");
    });
  }
  for (let i = 0; i < fishes.length && i < arr.length; i++) {
    const [x, y, z, yaw, pitch, st] = arr[i];
    const f = fishes[i];
    if (!f.net) {
      // first packet: snap into place
      f.pos.x = x; f.pos.y = y; f.pos.z = z;
      f.yaw = yaw; f.pitch = pitch;
    }
    f.net = { x, y, z, yaw, pitch, state: STATE_NAME[st] ?? "lurk" };
  }
}

// ---------------------------------------------------------------------------
// Per-frame update
// ---------------------------------------------------------------------------

const _dir = new THREE.Vector3();

function shortestArc(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// playerPos: the LOCAL player (bite shoves apply to them only).
// others: other players' positions — fish hunt whoever is nearest.
export function updateCatfishSystem(delta, playerPos, elapsed = 0, others = []) {
  for (const f of fishes) {
    const localDist = Math.hypot(
      playerPos.x - f.pos.x,
      playerPos.y - f.pos.y,
      playerPos.z - f.pos.z,
    );

    const yawRate = authority
      ? simulate(f, delta, playerPos, localDist, others)
      : puppet(f, delta, playerPos, localDist);

    // ---- shared presentation ----
    // Bank into turns — a heavy body rolling through the water, not a turret.
    const rollTarget = Math.max(-0.5, Math.min(0.5, -yawRate * 0.4));
    f.roll += (rollTarget - f.roll) * Math.min(1, 2.5 * delta);
    f.group.position.set(f.pos.x, f.pos.y, f.pos.z);
    f.group.rotation.set(f.pitch, f.yaw, f.roll, "YXZ");

    // Swim effort follows travel speed, smoothed so it never pops.
    const vlen = Math.hypot(f.vel.x, f.vel.y, f.vel.z);
    const targetAnim = 0.55 + vlen * 0.28;
    f.animSpeed += (targetAnim - f.animSpeed) * Math.min(1, 3 * delta);
    f.swim.timeScale = f.animSpeed;
    f.mixer.update(delta);

    // ---- lantern mood ----
    const t = elapsed + f.seed;
    const jitter =
      0.78 + 0.14 * Math.sin(t * 13.7) + 0.08 * Math.sin(t * 31.3 + 1.2);
    let base;
    if (f.state === "strike") base = 120; // white-hot flare
    else if (f.state === "stalk") base = 18; // dimmed, sneaking
    else base = 55;
    // occasional dropouts while stalking — a light that blinks in the murk
    const dropout =
      f.state === "stalk" && Math.sin(t * 2.3) > 0.86 ? 0.15 : 1;
    f.light.intensity +=
      (base * jitter * dropout - f.light.intensity) * Math.min(1, delta * 10);
    f.light.color.setHex(f.state === "strike" ? 0xfff4e0 : 0xffd9a0);
    f.glow.material.opacity = 0.35 + (f.light.intensity / 120) * 0.55;
    // The bulb reads at long range: the glow sprite grows with distance so a
    // far-off fish is exactly what it should be — a lone light in the dark.
    const gs = Math.min(3.2, 0.7 + localDist * 0.012);
    f.glow.scale.setScalar(gs);
  }
}

// Host/solo simulation. Returns the yaw rate (rad/s) for banking.
function simulate(f, delta, playerPos, localDist, others) {
  // Nearest player is the prey.
  let prey = playerPos;
  let dist = localDist;
  for (const p of others) {
    const d = Math.hypot(p.x - f.pos.x, p.y - f.pos.y, p.z - f.pos.z);
    if (d < dist) {
      dist = d;
      prey = p;
    }
  }
  f.cooldown = Math.max(0, f.cooldown - delta);

  // ---- state transitions ----
  // The spawn bubble is sanctuary: prey inside it is invisible to the fish.
  const preySafe = distToSpawn(prey) < SAFE_RADIUS;
  if (f.state === "lurk" && dist < STALK_RANGE && !preySafe) f.state = "stalk";
  else if (f.state === "stalk" && (dist > LOSE_RANGE || preySafe)) {
    f.state = "lurk";
    f.waypoint = wanderPoint(f);
  }
  if (f.state === "stalk" && dist < STRIKE_RANGE && f.cooldown === 0) {
    f.state = "strike";
    f.bitTimer = 0;
    f.bite.reset().play();
  }

  // ---- steering target + speed ----
  let tx, ty, tz, speed;
  if (f.state === "lurk") {
    const w = f.waypoint;
    if (Math.hypot(w.x - f.pos.x, w.y - f.pos.y, w.z - f.pos.z) < WAYPOINT_EPS)
      f.waypoint = wanderPoint(f);
    tx = f.waypoint.x; ty = f.waypoint.y; tz = f.waypoint.z;
    speed = LURK_SPEED;
  } else if (f.state === "stalk") {
    tx = prey.x; ty = prey.y; tz = prey.z;
    speed = STALK_SPEED;
  } else {
    // strike: brief coiled wind-up, then the lunge
    tx = prey.x; ty = prey.y; tz = prey.z;
    speed = f.bitTimer < 0.16 ? 0.4 : LUNGE_SPEED;
    f.bitTimer += delta;
    // snap moment of the bite clip — check for a hit on the LOCAL player once
    if (
      f.bitTimer > BITE_SNAP_T &&
      f.bitTimer - delta <= BITE_SNAP_T &&
      localDist < BITE_HIT_RANGE
    ) {
      hooks.onBite?.({ ...f.pos });
    }
    if (f.bitTimer > BITE_DURATION) {
      f.bitTimer = -1;
      f.cooldown = BITE_COOLDOWN;
      f.state = "stalk";
    }
  }

  // ---- move with water inertia ----
  _dir.set(tx - f.pos.x, ty - f.pos.y, tz - f.pos.z);
  const dlen = _dir.length();
  if (dlen > 1e-4) _dir.divideScalar(dlen);
  const k = 1 - Math.exp(-2.5 * delta);
  f.vel.x += (_dir.x * speed - f.vel.x) * k;
  f.vel.y += (_dir.y * speed - f.vel.y) * k;
  f.vel.z += (_dir.z * speed - f.vel.z) * k;
  f.pos.x += f.vel.x * delta;
  f.pos.y += f.vel.y * delta;
  f.pos.z += f.vel.z * delta;

  // slide along the cheese like the player does
  const hit = resolveCollision(f.pos, FISH_RADIUS);
  if (hit) {
    const into = f.vel.x * hit.x + f.vel.y * hit.y + f.vel.z * hit.z;
    if (into < 0) {
      f.vel.x -= hit.x * into;
      f.vel.y -= hit.y * into;
      f.vel.z -= hit.z * into;
    }
    // lurkers that keep grinding a wall pick a fresh pocket
    if (f.state === "lurk" && Math.hypot(f.vel.x, f.vel.y, f.vel.z) < 0.3)
      f.waypoint = wanderPoint(f);
  }

  // ---- orientation: model faces +Z ----
  let yawRate = 0;
  const sp = Math.hypot(f.vel.x, f.vel.z);
  if (sp > 0.05) {
    const targetYaw = Math.atan2(f.vel.x, f.vel.z);
    const dYaw = shortestArc(f.yaw, targetYaw) * Math.min(1, TURN_RATE * delta);
    f.yaw += dYaw;
    yawRate = dYaw / Math.max(delta, 1e-4);
  }
  const vlen = Math.hypot(f.vel.x, f.vel.y, f.vel.z);
  const targetPitch = vlen > 0.05 ? -Math.asin(f.vel.y / vlen) : 0;
  f.pitch += (targetPitch - f.pitch) * Math.min(1, 2 * delta);
  return yawRate;
}

// Joiner-side puppet: interpolate toward the host's state and mirror the
// bite/lantern beats. Returns yaw rate for banking.
function puppet(f, delta, playerPos, localDist) {
  const n = f.net;
  if (!n) return 0;

  // Bite beats: play the clip when the host says the fish is striking, and
  // apply the shove locally if WE are the one in front of the jaws.
  if (n.state === "strike" && f.state !== "strike") {
    f.bitTimer = 0;
    f.bite.reset().play();
  }
  if (f.bitTimer >= 0) {
    const was = f.bitTimer;
    f.bitTimer += delta;
    if (
      f.bitTimer > BITE_SNAP_T &&
      was <= BITE_SNAP_T &&
      localDist < BITE_HIT_RANGE
    ) {
      hooks.onBite?.({ ...f.pos });
    }
    if (f.bitTimer > BITE_DURATION) f.bitTimer = -1;
  }
  f.state = n.state;

  // Position: exponential chase of the last received state (host sends ~8 Hz).
  const k = 1 - Math.exp(-8 * delta);
  const px = f.pos.x;
  const py = f.pos.y;
  const pz = f.pos.z;
  f.pos.x += (n.x - f.pos.x) * k;
  f.pos.y += (n.y - f.pos.y) * k;
  f.pos.z += (n.z - f.pos.z) * k;
  if (delta > 1e-4) {
    f.vel.x = (f.pos.x - px) / delta;
    f.vel.y = (f.pos.y - py) / delta;
    f.vel.z = (f.pos.z - pz) / delta;
  }

  const dYaw = shortestArc(f.yaw, n.yaw) * k;
  f.yaw += dYaw;
  f.pitch += (n.pitch - f.pitch) * k;
  return dYaw / Math.max(delta, 1e-4);
}
