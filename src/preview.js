// preview.js — a rig bench for the Lanternmaw, served at /preview.html.
//
// It imports the real createAngler() rather than reimplementing anything, so
// what you see here is exactly what the game runs: the same travelling wave
// down the tentacles, the same probe-calibrated jaw, the same state machine.
// The only thing the preview adds is the ability to *stop* — a lunge is 0.85 s
// long in play, which is not enough time to tell whether the lip peel reads.
//
// Modes:
//   hunt   — a stand-in diver swims at the lure and the machine runs itself
//   loop   — the reveal→lunge→snap window on repeat, nothing else
//   hold   — one beat frozen, with the four animation values on sliders
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";
import { createAngler, ANGLER_LENGTH, REVEAL_RANGE } from "./angler.js";

const $ = (id) => document.getElementById(id);

// --- Scene -----------------------------------------------------------------
const scene = new THREE.Scene();
const WATER = 0x04141e;
scene.background = new THREE.Color(WATER);
scene.fog = new THREE.FogExp2(WATER, 0.006);

const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.5, 3000);
camera.position.set(ANGLER_LENGTH * 1.35, ANGLER_LENGTH * 0.45, ANGLER_LENGTH * 1.5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
$("stage").appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);

// Enough light to read silhouette and deformation, and no more: the fish is
// meant to be legible here, not atmospheric.
scene.add(new THREE.HemisphereLight(0x8fd0ff, 0x02121c, 0.9));
const key = new THREE.DirectionalLight(0xbfe4ff, 1.5);
key.position.set(1, 1.4, 1.2);
scene.add(key);
const rim = new THREE.DirectionalLight(0x4f8fb5, 0.9);
rim.position.set(-1.3, 0.3, -1);
scene.add(rim);

// A ground grid purely as a motion reference — a 46 m animal lunging against
// an empty background barely looks like it is moving at all.
const grid = new THREE.GridHelper(600, 40, 0x2a5a72, 0x14313f);
grid.position.y = -ANGLER_LENGTH * 0.55;
grid.material.transparent = true;
grid.material.opacity = 0.35;
scene.add(grid);

// --- The animal ------------------------------------------------------------
const angler = createAngler(scene);
const noise = new ImprovedNoise();
angler.setAlarmPeriod(5);

// A stand-in for a diver: the thing the state machine reacts to. Scaled to a
// human against a 46 m fish, which is most of the point.
const diver = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.5, 1.1, 4, 10),
  new THREE.MeshStandardMaterial({ color: 0x7fe3b0, emissive: 0x16412e, roughness: 0.6 }),
);
scene.add(diver);
const diverLight = new THREE.PointLight(0x9fe8ff, 40, 60, 2);
scene.add(diverLight);
const diverPos = { id: "preview", x: 0, y: 0, z: 0, out: false };

// Debug overlays. SkeletonHelper snapshots the bone list at construction, so
// it can only be built once the GLB has actually landed.
let skeleton = null;
let showBones = false;

const mawGhost = new THREE.Mesh(
  new THREE.SphereGeometry(1, 20, 14),
  new THREE.MeshBasicMaterial({ color: 0xff5a3c, wireframe: true, transparent: true, opacity: 0.32 }),
);
mawGhost.visible = false;
scene.add(mawGhost);

// --- Modes -----------------------------------------------------------------
const PHASES = ["lurk", "stalk", "reveal", "lunge", "snap", "sound"];
let mode = "hunt"; // hunt | loop | hold
let held = "reveal";
let rate = 1;
let spin = true;
const scrub = { gape: 0, lureOut: 1, glow: 0, speed: 0.12 };

function startHunt() {
  mode = "hunt";
  angler.place({ x: 0, y: 0, z: 0 }, 0, 105, "lurk");
  // Drop the diver at the origin, well outside notice range, and let it swim.
  diverPos.x = 0;
  diverPos.y = 0;
  diverPos.z = 0;
  diverPos.out = false;
  swallowedAt = 0;
  syncButtons();
}

function startLoop() {
  mode = "loop";
  loopReset();
  syncButtons();
}

function loopReset() {
  angler.place({ x: 0, y: 0, z: 0 }, 0, REVEAL_RANGE * 0.95, "stalk");
  diverPos.x = 0;
  diverPos.y = 0;
  diverPos.z = 0;
  diverPos.out = false;
}

function hold(phase) {
  mode = "hold";
  held = phase;
  // Park it broadside-ish at a readable distance and freeze the beat.
  angler.place({ x: 0, y: 0, z: 0 }, 0, ANGLER_LENGTH * 0.1, phase);
  angler.setPose({ phase, ...poseFor(phase) });
  Object.assign(scrub, poseFor(phase));
  pushSliders();
  syncButtons();
}

// The pose each beat settles at, so the "hold" buttons land on something
// representative instead of frame one of a transition.
function poseFor(phase) {
  switch (phase) {
    case "lurk":
      return { gape: 0, lureOut: 1, glow: 0, speed: 0.12 };
    case "stalk":
      return { gape: 0, lureOut: 0.45, glow: 0.12, speed: 0.4 };
    case "reveal":
      return { gape: 0.75, lureOut: 0.12, glow: 1, speed: 0.5 };
    case "lunge":
      return { gape: 1, lureOut: 0.08, glow: 1, speed: 1 };
    case "snap":
      return { gape: 0.25, lureOut: 0.08, glow: 0.7, speed: 0.6 };
    case "sound":
      return { gape: 0, lureOut: 0.6, glow: 0.15, speed: 0.3 };
    default:
      return { gape: 0, lureOut: 1, glow: 0, speed: 0.2 };
  }
}

// --- UI --------------------------------------------------------------------
const phaseRow = $("phases");
for (const phase of PHASES) {
  const btn = document.createElement("button");
  btn.textContent = phase;
  btn.dataset.phase = phase;
  btn.addEventListener("click", () => hold(phase));
  phaseRow.appendChild(btn);
}

$("btn-hunt").addEventListener("click", startHunt);
$("btn-loop").addEventListener("click", startLoop);

const sliders = {
  gape: $("s-gape"),
  lureOut: $("s-lure"),
  glow: $("s-glow"),
  speed: $("s-speed"),
};
for (const [key_, input] of Object.entries(sliders)) {
  input.addEventListener("input", () => {
    scrub[key_] = +input.value;
    mode = "hold"; // touching a slider is a request to stop and look
    angler.setPose({ ...scrub });
    syncButtons();
  });
}
$("s-rate").addEventListener("input", (e) => {
  rate = +e.target.value;
  $("v-rate").textContent = `${rate.toFixed(1)}×`;
});

function pushSliders() {
  for (const [key_, input] of Object.entries(sliders)) input.value = scrub[key_];
}

const toggle = (id, onClick, initial = false) => {
  const btn = $(id);
  let on = initial;
  btn.classList.toggle("on", on);
  btn.addEventListener("click", () => {
    on = !on;
    btn.classList.toggle("on", on);
    onClick(on);
  });
};
toggle("t-bones", (on) => {
  showBones = on;
  if (skeleton) skeleton.visible = on;
});
toggle("t-maw", (on) => (mawGhost.visible = on));
toggle("t-spin", (on) => (spin = on), true);
toggle("t-wire", (on) => {
  angler.group.traverse((o) => {
    if (o.isMesh) o.material.wireframe = on;
  });
});
toggle("t-fog", (on) => {
  scene.fog = on ? new THREE.FogExp2(WATER, 0.006) : null;
  scene.background = new THREE.Color(on ? WATER : 0x070d12);
  angler.group.traverse((o) => {
    if (o.isMesh) {
      o.material.fog = on;
      o.material.needsUpdate = true;
    }
  });
}, true);

function syncButtons() {
  $("btn-hunt").classList.toggle("on", mode === "hunt");
  $("btn-loop").classList.toggle("on", mode === "loop");
  for (const btn of phaseRow.children) {
    btn.classList.toggle("on", mode === "hold" && btn.dataset.phase === held);
  }
}

addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    startHunt();
  }
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- Loop ------------------------------------------------------------------
const clock = new THREE.Clock();
const _maw = new THREE.Vector3();
let elapsed = 0;
let swallowedAt = 0;
let loopTimer = 0;
let ready = false;

startHunt();

renderer.setAnimationLoop(() => {
  const raw = Math.min(clock.getDelta(), 0.05);
  const delta = raw * rate;
  elapsed += delta;

  if (mode === "hunt" || mode === "loop") {
    // The diver does the one thing the lure is asking for.
    const lure = angler.lurePosition();
    const dx = lure.x - diverPos.x;
    const dy = lure.y - diverPos.y;
    const dz = lure.z - diverPos.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    if (len > 4 && !diverPos.out) {
      const step = (mode === "loop" ? 9 : 5.5) * delta / len;
      diverPos.x += dx * step;
      diverPos.y += dy * step;
      diverPos.z += dz * step;
    }
    angler.update(delta, elapsed, noise, {
      divers: [diverPos],
      onSwallow: () => (swallowedAt = elapsed),
      onEvent: () => {},
    });
    // Restart automatically so the bench never sits on a finished attack.
    if (swallowedAt && elapsed - swallowedAt > 2.4) {
      swallowedAt = 0;
      if (mode === "loop") loopReset();
      else startHunt();
    }
    // A miss still ends the loop: give it a hard reset either way.
    if (mode === "loop") {
      loopTimer += delta;
      if (loopTimer > 14) {
        loopTimer = 0;
        swallowedAt = 0;
        loopReset();
      }
    }
  } else {
    // Held: the state machine is frozen, but the idle layers (tentacle wave,
    // lure bob, body sway) keep running — they are driven by elapsed, not by
    // the phase, which is exactly what makes them worth previewing.
    angler.setPose({ ...scrub });
    angler.update(delta, elapsed, noise, { frozen: true });
  }

  diver.position.set(diverPos.x, diverPos.y, diverPos.z);
  diver.visible = mode !== "hold";
  diverLight.position.copy(diver.position);
  diverLight.intensity = diver.visible ? 40 : 0;

  // Follow the animal, not the origin: it swims a long way during a hunt.
  controls.target.lerp(angler.position, 1 - Math.exp(-3 * raw));
  controls.autoRotate = spin;
  controls.autoRotateSpeed = 0.5;
  controls.update();

  angler.mawPosition(_maw);
  mawGhost.position.copy(_maw);
  mawGhost.scale.setScalar(ANGLER_LENGTH * 0.17 * (0.75 + angler.values().gape * 0.45));

  // The GLB arrives a beat after the page does; everything that depends on
  // having real bones is set up on that first frame.
  if (!ready && angler.group.children.length) {
    ready = true;
    skeleton = new THREE.SkeletonHelper(angler.group);
    skeleton.visible = showBones;
    scene.add(skeleton);
    $("loading")?.remove();
  }

  renderer.render(scene, camera);
  readout();
});

// --- Readout ---------------------------------------------------------------
const jawBone = () => angler.group.getObjectByName("chin001");
const escaBone = () => angler.group.getObjectByName("foreheadL014");
const _tmp = new THREE.Vector3();
let hudTimer = 0;

function readout() {
  hudTimer += 1;
  if (hudTimer % 3) return; // 20 Hz is plenty for text
  const v = angler.values();
  $("phase").textContent = v.phase.toUpperCase();

  const jaw = jawBone();
  $("r-jaw").textContent = jaw
    ? `${(jaw.getWorldPosition(_tmp).y - angler.position.y).toFixed(2)} m`
    : "—";
  const esca = escaBone();
  $("r-esca").textContent = esca
    ? `${(esca.getWorldPosition(_tmp).y - angler.position.y).toFixed(2)} m`
    : "—";
  const d = Math.hypot(
    diverPos.x - angler.position.x,
    diverPos.y - angler.position.y,
    diverPos.z - angler.position.z,
  );
  $("r-dist").textContent = mode === "hold" ? "—" : `${d.toFixed(0)} m`;

  bar("b-gape", v.gape);
  bar("b-lure", 1 - v.lureOut);
  bar("b-glow", v.glow);
  bar("b-pulse", v.pulse);
  $("v-gape").textContent = v.gape.toFixed(2);
  $("v-lure").textContent = v.lureOut.toFixed(2);
  $("v-glow").textContent = v.glow.toFixed(2);
  $("v-speed").textContent = v.speed.toFixed(2);
}

function bar(id, value) {
  $(id).style.width = `${Math.max(0, Math.min(1, value)) * 100}%`;
}
