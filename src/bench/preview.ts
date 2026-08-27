// preview.js — model & animation bench for every creature in the game.
// Served at /preview.html (npm run dev → http://localhost:5173/preview.html).
//
// It imports the REAL animation code — createDiverRig()'s procedural swim,
// the same toonify() cel pass, the same baked clips the catfish plays in
// game — so what you see here is exactly what ships. The only thing the
// bench adds is the ability to *stop and stare*: isolate one clip, freeze a
// pose on sliders, slow everything to 0.1×, and orbit around it. (A catfish
// bite is 1.1 s long in play, which is not enough time to tell whether the
// jaw slam reads.)
//
// ── ADDING A NEW MODEL (standing rule — see AGENTS.md) ─────────────────────
// Every model/creature that enters the game MUST get an entry in MODELS
// below, in the same PR that adds it. An entry is:
//   { id, label, url, cam: { dist, height, gridY }, build(gltf) }
// `url` is optional: a model built entirely in code (the Golden Gouda) has
// no GLB to fetch, and build() is handed null instead of a gltf.
// build() returns an instance the bench drives:
//   group           — added to the scene while this model is active
//   update(dt, t)   — dt is already rate-scaled (0 while paused)
//   ui(panel, api)  — model-specific controls; api = { button, sliderRow }
//   focus           — Vector3 the orbit camera tracks (optional)
//   clips           — { mixer, actions } for baked-clip HUD bars (optional)
//   action()        — spacebar hook (optional)
//   lines()/bars()  — HUD text rows / progress bars (optional)
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  prepareDiverTemplate,
  createDiverRig,
  updateDiverRig,
  FP_VIEW,
} from "../entities/diverRig.ts";
import { prepareCatfishTemplate } from "../entities/catfish.ts";
import { toonMaterial } from "../render/toon.ts";
import { createBellVisual } from "../world/bathyscaphe.ts";
import {
  createGoudaVisual,
  prepareGoudaTemplate,
  GOUDA_RADIUS,
} from "../entities/goldenGouda.ts";
import { CARGO } from "../game/cargo.ts";

// The instance contract documented above, as a real type: what build() must
// return for the bench to drive it.
export interface BenchInstance {
  group: THREE.Group;
  update(dt: number, t: number): void;
  ui?(panel: HTMLElement, api: BenchUiApi): void;
  focus?: THREE.Vector3;
  clips?: { mixer: THREE.AnimationMixer; actions: string[] };
  action?(): void;
  lines?(): [string, string][];
  bars?(): [string, number][];
  camLocked?: boolean; // eye cam: stop the orbit auto-spin fighting the view
}

// The tiny UI kit handed to ui(panel, api).
export interface BenchUiApi {
  button: typeof button;
  sliderRow: typeof sliderRow;
  section: typeof section;
}

// One MODELS registry entry.
export interface BenchModelDef {
  id: string;
  label: string;
  url?: string; // omitted for models generated in code
  cam: BenchCamSpec;
  build(gltf: GLTF | null): BenchInstance;
}

export interface BenchCamSpec {
  dist: number;
  height: number;
  gridY: number;
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const BASE = import.meta.env.BASE_URL;

// Mirrored game constants (module-private at their source, so re-stated
// here — keep in sync): catfish.js SCALE / lantern moods, graphics.js
// TORCH_OFFSET / REMOTE_LAMP_INTENSITY.
const CATFISH_SCALE = 4;
const LANTERN_BASE: Record<string, number> = {
  lurk: 55,
  stalk: 18,
  strike: 120,
};
const TORCH_OFFSET = new THREE.Vector3(0, 0.35, -0.14);
const TORCH_INTENSITY = 190;

// Bone-local axes for overlays parented to a bone (the gouda's bit arrows).
const BONE_UP = new THREE.Vector3(0, 1, 0);
const ORIGIN = new THREE.Vector3();

// --- Scene -----------------------------------------------------------------
const scene = new THREE.Scene();
const WATER = 0x04141e;
scene.background = new THREE.Color(WATER);
scene.fog = new THREE.FogExp2(WATER, 0.018);

const camera = new THREE.PerspectiveCamera(
  52,
  innerWidth / innerHeight,
  0.05,
  500,
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
$("stage").appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
// Never leave the camera ON the orbit target (degenerate spherical → NaN
// view while the first model is still downloading).
camera.position.set(5, 2, 6);

// Enough light to read silhouette and deformation, and no more: models are
// meant to be legible here, not atmospheric. (The toon materials still band
// the response into the same 4 steps as in game.)
scene.add(new THREE.HemisphereLight(0x8fd0ff, 0x02121c, 0.9));
const key = new THREE.DirectionalLight(0xbfe4ff, 1.6);
key.position.set(1, 1.4, 1.2);
scene.add(key);
const rim = new THREE.DirectionalLight(0x4f8fb5, 0.9);
rim.position.set(-1.3, 0.3, -1);
scene.add(rim);

// A ground grid purely as a motion reference — a creature swimming against
// an empty background barely looks like it is moving at all.
const grid = new THREE.GridHelper(80, 40, 0x2a5a72, 0x14313f);
grid.material.transparent = true;
grid.material.opacity = 0.35;
scene.add(grid);

// --- Tiny UI kit -----------------------------------------------------------
function button(
  parent: HTMLElement,
  label: string,
  onClick: (btn: HTMLButtonElement) => void,
) {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.addEventListener("click", () => onClick(btn));
  parent.appendChild(btn);
  return btn;
}

function sliderRow(
  parent: HTMLElement,
  name: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onInput: (v: number) => void,
  fmt: (v: number) => string = (v) => v.toFixed(2),
) {
  const row = document.createElement("div");
  row.className = "slider-row";
  row.innerHTML = `<span class="name">${name}</span><input type="range"><span class="val"></span>`;
  const input = row.querySelector("input")!;
  const val = row.querySelector(".val")!;
  Object.assign(input, { min, max, step, value });
  const show = () => (val.textContent = fmt(+input.value));
  input.addEventListener("input", () => {
    show();
    onInput(+input.value);
  });
  show();
  parent.appendChild(row);
  return {
    row,
    set(v: number) {
      input.value = v as unknown as string; // DOM coerces numbers; keep the raw assign
      show();
    },
  };
}

function section(parent: HTMLElement, label: string) {
  const s = document.createElement("div");
  s.className = "section";
  s.innerHTML = `<div class="label">${label}</div><div class="row"></div>`;
  parent.appendChild(s);
  return s.querySelector(".row") as HTMLElement;
}

const api = { button, sliderRow, section };

// Radio behavior across a set of buttons.
function markOn(btns: Record<string, HTMLButtonElement>, active: string) {
  for (const [k, b] of Object.entries(btns))
    b.classList.toggle("on", k === active);
}

// --- Shared bits -----------------------------------------------------------
const gltfCache = new Map<string, Promise<GLTF>>(); // url → Promise<gltf>
function loadGltf(url: string) {
  if (!gltfCache.has(url)) gltfCache.set(url, new GLTFLoader().loadAsync(url));
  return gltfCache.get(url)!;
}

// One prepared diver template shared by the third-person and FP entries.
let diverTemplate: ReturnType<typeof prepareDiverTemplate> | null = null;
function diverTemplateFrom(gltf: GLTF) {
  diverTemplate ??= prepareDiverTemplate(gltf); // cel pass runs inside prep
  return diverTemplate;
}

// Soft round glow sprite (same canvas halo the catfish lantern uses in game).
function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,240,200,0.9)");
  g.addColorStop(0.4, "rgba(255,210,140,0.25)");
  g.addColorStop(1, "rgba(255,190,110,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// --- Model: rat diver (third person, procedural swim) -----------------------
function buildDiver(gltf: GLTF): BenchInstance {
  const template = diverTemplateFrom(gltf);

  const group = new THREE.Group();
  const swim = new THREE.Group(); // travels the path, carries yaw
  const pivot = new THREE.Group(); // body pitch (graphics.js structure)
  swim.add(pivot);
  group.add(swim);
  const rig = createDiverRig(template);
  pivot.add(rig.root);

  // Helmet torch, mounted exactly like graphics.js: the light rig lives at
  // scene level and is pinned to the head's world pose every frame.
  const torch = new THREE.Group();
  const spot = new THREE.SpotLight(
    0xffeec9,
    TORCH_INTENSITY,
    50,
    0.5,
    0.6,
    1.7,
  );
  spot.target.position.set(0, 0, -20);
  torch.add(spot);
  torch.add(spot.target);
  group.add(torch);

  const st = {
    mode: "cruise", // idle | cruise | sprint | manual
    sweep: false, // head look sweep (shows the neck clamp + torch sync)
    speed: 0, // manual mode speed
    lookYaw: 0,
    lookPitch: 0,
    angle: 0,
    yaw: 0,
    bodyPitchSm: 0,
  };
  const vel = new THREE.Vector3();
  const focus = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const R = 7; // swim circle radius

  let modeBtns: Record<string, HTMLButtonElement> = {};
  const setMode = (m: string) => {
    st.mode = m;
    markOn(modeBtns, m);
  };

  return {
    group,
    focus,
    update(dt: number, t: number) {
      let speed;
      if (st.mode === "manual") {
        // Treadmill: body faces -Z at the origin; vel drives effort only.
        speed = st.speed;
        st.yaw = 0;
        vel.set(0, 0, -speed);
        swim.position.set(0, 0, 0);
      } else {
        speed = st.mode === "sprint" ? 9 : st.mode === "cruise" ? 3.5 : 0;
        st.angle += (speed / R) * dt;
        const bob = speed > 0 ? 1 : 0;
        swim.position.set(
          Math.cos(st.angle) * R * bob,
          Math.sin(t * 0.35) * 1.4 * bob,
          Math.sin(st.angle) * R * bob,
        );
        vel.set(
          -Math.sin(st.angle) * speed,
          Math.cos(t * 0.35) * 0.49 * bob,
          Math.cos(st.angle) * speed,
        );
        // Game forward is -Z: face the direction of travel.
        if (speed > 0.1) st.yaw = Math.atan2(-vel.x, -vel.z);
      }

      // Visual pitch stays level at rest and aligns with travel as speed
      // picks up — same easing as updateRemoteDiver in graphics.js.
      const vlen = vel.length();
      const swimPitch = vlen > 0.3 ? Math.asin(vel.y / vlen) : 0;
      const align = Math.min(1, vlen / 2.5);
      st.bodyPitchSm +=
        (swimPitch * align - st.bodyPitchSm) * Math.min(1, dt * 3);
      swim.rotation.y = st.yaw;
      pivot.rotation.x = st.bodyPitchSm;

      const lookYaw = st.yaw + (st.sweep ? Math.sin(t * 0.6) : st.lookYaw);
      const lookPitch =
        st.bodyPitchSm + (st.sweep ? Math.sin(t * 0.85) * 0.4 : st.lookPitch);
      updateDiverRig(rig, dt, {
        bodyYaw: st.yaw,
        bodyPitch: st.bodyPitchSm,
        lookYaw,
        lookPitch,
        vel,
      });

      // Torch beam leaves the helmet along the exact look direction.
      _v.copy(TORCH_OFFSET).applyQuaternion(rig.lookQuat);
      torch.position.copy(rig.headPos).add(_v);
      torch.quaternion.copy(rig.lookQuat);

      focus.copy(swim.position);
    },
    ui(panel: HTMLElement) {
      const modes = section(panel, "Swim");
      modeBtns = {
        idle: button(modes, "idle", () => setMode("idle")),
        cruise: button(modes, "cruise", () => setMode("cruise")),
        sprint: button(modes, "sprint", () => setMode("sprint")),
      };
      markOn(modeBtns, st.mode);
      button(modes, "head sweep", (b) => {
        st.sweep = !st.sweep;
        b.classList.toggle("on", st.sweep);
      });
      button(modes, "torch", (b) => {
        torch.visible = !torch.visible;
        b.classList.toggle("on", torch.visible);
      }).classList.add("on");

      // Touching a slider is a request to stop and look → manual mode.
      const hold = section(panel, "Hold (manual)").parentElement!;
      sliderRow(hold, "effort", 0, 10, 0.1, 0, (v) => {
        st.speed = v;
        setMode("manual");
      });
      sliderRow(hold, "look yaw", -1.2, 1.2, 0.01, 0, (v) => {
        st.lookYaw = v;
        st.sweep = false;
        setMode("manual");
      });
      sliderRow(hold, "look pitch", -1.2, 1.2, 0.01, 0, (v) => {
        st.lookPitch = v;
        st.sweep = false;
        setMode("manual");
      });
      const note = document.createElement("div");
      note.className = "hint";
      note.textContent =
        "swim is fully procedural (diverRig.js) — the GLB's baked NlaTrack clip is deliberately unused in game";
      panel.appendChild(note);
    },
    action() {
      // Space cycles the swim gears.
      setMode(
        st.mode === "idle"
          ? "cruise"
          : st.mode === "cruise"
            ? "sprint"
            : "idle",
      );
    },
    lines: () => [
      ["mode", st.mode],
      ["speed", `${vel.length().toFixed(1)} m/s`],
    ],
    bars: () => [["kick effort", rig.speedSm]],
  };
}

// --- Model: first-person gloves ---------------------------------------------
// The local player's own body: only the gloves + forearms survive prep
// (diverRig.js buildFpGeometry). Use "eye cam" to judge their placement at
// the real in-game FOV.
function buildGloves(gltf: GLTF): BenchInstance {
  const template = diverTemplateFrom(gltf);

  const group = new THREE.Group();
  const pivot = new THREE.Group();
  group.add(pivot);
  const rig = createDiverRig(template, { firstPerson: true });
  // Same material treatment as the game's local body (createLocalBody):
  // double-sided sleeves, suit darkened below world albedo.
  rig.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      const m = o as THREE.Mesh & { material: THREE.MeshStandardMaterial };
      m.material = m.material.clone();
      m.material.side = THREE.DoubleSide;
      m.material.color?.multiplyScalar(0.58);
    }
  });
  pivot.add(rig.root);

  const st = { pitch: 0, speed: 0, eyeCam: false };
  const vel = new THREE.Vector3();
  const focus = new THREE.Vector3(0, -0.3, -0.6);

  const inst: BenchInstance = {
    group,
    focus,
    camLocked: false, // eye cam: stop the orbit auto-spin fighting the view
    update(dt: number) {
      // Screen-anchored FPS-style: the invisible body pitches with the
      // camera via FP_VIEW — identical math to updateLocalBody.
      const bodyPitch = FP_VIEW.base + st.pitch * FP_VIEW.follow;
      pivot.rotation.x = bodyPitch;
      vel.set(0, 0, -st.speed);
      updateDiverRig(rig, dt, {
        bodyYaw: 0,
        bodyPitch,
        lookYaw: 0,
        lookPitch: st.pitch,
        vel,
      });
      // In eye cam the follow-lerp must chase the look target, not the rig.
      if (st.eyeCam) focus.set(0, Math.tan(-st.pitch) * 4, -4);
      else focus.set(0, -0.3, -0.6);
    },
    ui(panel: HTMLElement) {
      const cams = section(panel, "Camera");
      button(cams, "eye cam (fov 72)", (b) => {
        st.eyeCam = !st.eyeCam;
        inst.camLocked = st.eyeCam;
        b.classList.toggle("on", st.eyeCam);
        camera.fov = st.eyeCam ? 72 : 52;
        camera.updateProjectionMatrix();
        if (st.eyeCam) {
          // Park the orbit rig at the player's eyes, looking level -Z: what
          // the frame bottom shows here is what the player sees in game.
          camera.position.set(0, 0, 0.02);
          controls.target.set(0, Math.tan(-st.pitch) * 4, -4);
        } else {
          frameCamera(ACTIVE_DEF.cam);
        }
      });
      const hold = section(panel, "Pose").parentElement!;
      sliderRow(hold, "look pitch", -1.2, 1.2, 0.01, 0, (v) => {
        st.pitch = v;
        if (st.eyeCam) controls.target.set(0, Math.tan(-v) * 4, -4);
      });
      sliderRow(hold, "effort", 0, 10, 0.1, 0, (v) => (st.speed = v));
      const note = document.createElement("div");
      note.className = "hint";
      note.textContent =
        "placement is tuned via configureFpBody() URL params in the shot harness (shots.js)";
      panel.appendChild(note);
    },
    lines: () => [
      ["body pitch", (FP_VIEW.base + st.pitch * FP_VIEW.follow).toFixed(2)],
    ],
    bars: () => [["arm drift", rig.speedSm]],
  };
  return inst;
}

// --- Model: lantern-catfish ---------------------------------------------------
// Baked clips (swim / bite / flicker) exactly as catfish.js plays them, plus
// the lantern light logic so each mood can be judged with its clip.
function buildCatfish(gltf: GLTF): BenchInstance {
  const root = prepareCatfishTemplate(gltf).scene; // same cel pass as in game
  root.scale.setScalar(CATFISH_SCALE);

  const group = new THREE.Group();
  const swim = new THREE.Group();
  swim.add(root);
  group.add(swim);

  // Lantern: bulb bone + light + halo, same lookup as catfish.js spawnOne.
  let bulb: THREE.Object3D | null = null;
  root.traverse((o) => {
    const n = (o.name || "").toLowerCase();
    if (n.includes("forehead") && n.includes("017")) bulb = o;
  });
  const light = new THREE.PointLight(0xffd9a0, 55, 36, 2);
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture(),
      color: 0xffe2b0,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  glow.scale.setScalar(0.8);
  (bulb ?? group).add(light);
  (bulb ?? group).add(glow);
  light.position.set(0, 0.05, 0);
  glow.position.set(0, 0.05, 0);

  // The three baked clips, wired like catfish.js spawnOne.
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const c of gltf.animations) actions.set(c.name, mixer.clipAction(c));
  const swimAct = actions.get("swim");
  const flicker = actions.get("flicker");
  const bite = actions.get("bite");
  swimAct?.play();
  flicker?.play();
  if (bite) {
    // Typings demand a repetitions arg but LoopOnce ignores it at runtime —
    // keep the original 1-arg call rather than invent a value.
    (
      bite.setLoop as (
        mode: THREE.AnimationActionLoopStyles,
      ) => THREE.AnimationAction
    )(THREE.LoopOnce);
    bite.clampWhenFinished = false;
  }

  const st = {
    mood: "lurk", // lantern mood: lurk | stalk | strike
    biteLoop: false,
    biteTimer: 99,
    cruise: false,
    rate: 1,
    angle: 0,
    yaw: 0,
    roll: 0,
  };
  const focus = new THREE.Vector3();
  const R = 14;
  const CRUISE_SPEED = 3.6;

  let moodBtns: Record<string, HTMLButtonElement> = {};
  const setMood = (m: string) => {
    st.mood = m;
    markOn(moodBtns, m);
  };
  const triggerBite = () => {
    bite?.reset().play();
    st.biteTimer = 0;
  };

  return {
    group,
    focus,
    clips: { mixer, actions: [...actions.keys()] },
    update(dt: number, t: number) {
      if (st.cruise) {
        const yawRate = CRUISE_SPEED / R;
        st.angle += yawRate * dt;
        swim.position.set(
          Math.cos(st.angle) * R,
          Math.sin(t * 0.3) * 2,
          Math.sin(st.angle) * R,
        );
        // Model faces +Z; bank into the turn like the game's presentation.
        st.yaw = Math.atan2(-Math.sin(st.angle), Math.cos(st.angle));
        const rollTarget = Math.max(-0.5, Math.min(0.5, -yawRate * 0.4));
        st.roll += (rollTarget - st.roll) * Math.min(1, 2.5 * dt);
      } else {
        swim.position.set(0, 0, 0);
        st.roll += (0 - st.roll) * Math.min(1, 2.5 * dt);
      }
      swim.rotation.set(0, st.yaw, st.roll, "YXZ");

      if (swimAct) swimAct.timeScale = st.rate;
      mixer.update(dt);

      // Auto-replay so the bench never sits on a finished bite.
      st.biteTimer += dt;
      if (st.biteLoop && st.biteTimer > 2.6) triggerBite();

      // Lantern mood — the exact intensity/jitter recipe from catfish.js,
      // with a strike flare riding any playing bite.
      const striking = bite?.isRunning() ?? false;
      const mood = striking ? "strike" : st.mood;
      const jitter =
        0.78 + 0.14 * Math.sin(t * 13.7) + 0.08 * Math.sin(t * 31.3 + 1.2);
      const dropout = mood === "stalk" && Math.sin(t * 2.3) > 0.86 ? 0.15 : 1;
      light.intensity +=
        (LANTERN_BASE[mood] * jitter * dropout - light.intensity) *
        Math.min(1, dt * 10);
      light.color.setHex(mood === "strike" ? 0xfff4e0 : 0xffd9a0);
      glow.material.opacity = 0.35 + (light.intensity / 120) * 0.55;

      focus.copy(swim.position);
    },
    ui(panel: HTMLElement) {
      const clipsRow = section(panel, "Clips");
      for (const [name, act] of actions) {
        if (name === "bite") continue; // one-shot, gets its own trigger
        const b = button(clipsRow, name, () => {
          if (act.isRunning()) act.stop();
          else act.reset().play();
          b.classList.toggle("on", act.isRunning());
        });
        b.classList.toggle("on", act.isRunning());
      }
      button(clipsRow, "bite!", triggerBite);
      button(clipsRow, "loop bite", (b) => {
        st.biteLoop = !st.biteLoop;
        b.classList.toggle("on", st.biteLoop);
      });

      const moods = section(panel, "Lantern mood");
      moodBtns = {
        lurk: button(moods, "lurk", () => setMood("lurk")),
        stalk: button(moods, "stalk", () => setMood("stalk")),
        strike: button(moods, "strike", () => setMood("strike")),
      };
      markOn(moodBtns, st.mood);

      const motion = section(panel, "Motion");
      button(motion, "cruise circle", (b) => {
        st.cruise = !st.cruise;
        b.classList.toggle("on", st.cruise);
      });
      sliderRow(
        motion.parentElement!,
        "swim rate",
        0.2,
        2.5,
        0.05,
        1,
        (v) => (st.rate = v),
        (v) => `${v.toFixed(2)}×`,
      );
    },
    action: triggerBite, // space = bite
    lines: () => [
      ["mood", bite?.isRunning() ? "strike" : st.mood],
      ["lantern", light.intensity.toFixed(0)],
    ],
    bars: () =>
      [...actions].map(([name, act]): [string, number] => [
        `clip · ${name}`,
        act.isRunning()
          ? (act.time % act.getClip().duration) / act.getClip().duration
          : 0,
      ]),
  };
}

// --- Model: tin bell (bathyscaphe) --------------------------------------------
// Static prop: the diving bell berthed at the spawn point (T0.4). No clips —
// the whole builder (scale, hatch flip, cable, cabin lamp + breathing entry
// beacon) is the game's real bathyscaphe.js code; the bench just lets you
// orbit it and toggle the parts. The O₂ recharge zone it marks is main.js
// logic, not part of the model.
function buildBell(gltf: GLTF): BenchInstance {
  const bell = createBellVisual(gltf.scene);

  return {
    group: bell.group,
    update(_dt: number, t: number) {
      bell.update(t);
    },
    ui(panel: HTMLElement) {
      const parts = section(panel, "Berth");
      button(parts, "lamp", (b) => {
        bell.setLamp(!bell.isLampOn());
        b.classList.toggle("on", bell.isLampOn());
      }).classList.add("on");
      button(parts, "cable", (b) => {
        bell.cable.visible = !bell.cable.visible;
        b.classList.toggle("on", bell.cable.visible);
      }).classList.add("on");
      const note = document.createElement("div");
      note.className = "hint";
      note.textContent =
        "in game divers wake INSIDE the chamber at hatch eye height, facing out the doorway (-Z); one bell is berthed per diver. The beacon pulse is the one licensed non-steady light";
      panel.appendChild(note);
    },
    action() {
      // Space toggles the lamp — quickest way to judge the wash on the grid.
      bell.setLamp(!bell.isLampOn());
    },
    lines: () => [
      ["beacon", bell.lamp.intensity.toFixed(0)],
      ["cabin", bell.cabin.intensity.toFixed(0)],
    ],
  };
}

// --- Model: the Golden Gouda ---------------------------------------------------
// This is the ONLY place you can actually look at the wheel without playing a
// whole run to its cavern. Two things to judge here.
//
// The lights: the near lamp has to read as a room light rather than a sun, and
// the long glow has to still be faintly visible at tunnel-mouth distance (the
// only hint the map gives).
//
// The levitation: golden_gouda.glb ships a real skin — 7 bones weighted one
// per floating cheese bit, plus Blender's `neutral_bone` holding the wheel
// itself (see the rig notes in entities/goldenGouda.ts). The bits ARE bones
// here, so this is where you check the rig survived its last export:
// prepareGoudaTemplate() measures it and the bit count below is how many bit
// bones actually own geometry, so a re-export that drops or renames a bone
// shows up here first. "lift" scrubs the travel live — the bits have to
// breathe out of their own sockets and back in, and never so far that they
// read as debris that fell off.
//
// The grid doubles as a ruler: PLAYER_RADIUS is 0.6 and a rat diver is about
// 1.3 u tall, so the wheel should look like an armful, not a boulder.
function buildGouda(gltf: GLTF | null): BenchInstance {
  const gouda = createGoudaVisual(gltf ? prepareGoudaTemplate(gltf) : null);
  let held = false;

  // A stand-in diver at the hold offset: the point of "held" mode is whether
  // the wheel sits in front of a body without the bits clipping through it.
  const stand = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.6, 0.7, 6, 12),
    toonMaterial({ color: 0x2b4756, transparent: true, opacity: 0.5 }),
  );
  stand.position.set(0, CARGO.HOLD_DOWN, CARGO.HOLD_FORWARD);
  stand.visible = false;
  gouda.group.add(stand);

  // The rig, drawn: one arrow per bit bone, parented TO the bone and pointing
  // along its own +Y — the axis that bit rides out on. Parented rather than
  // placed, so each arrow inherits the bone's real animated transform: the
  // arrows spin with the wheel, breathe out with their bit, and pick up the
  // wobble, which is the whole thing you want to look at. Lengths are quoted
  // in world u and divided into bone units (bones live in model space).
  let bonesOn = false;
  const markers: THREE.ArrowHelper[] = [];
  const s = gouda.scale;
  for (const bit of gouda.bits) {
    const arrow = new THREE.ArrowHelper(
      BONE_UP,
      ORIGIN,
      0.45 / s,
      0x5ce8ff,
      0.12 / s,
      0.07 / s,
    );
    arrow.visible = false;
    bit.bone.add(arrow);
    markers.push(arrow);
  }

  return {
    group: gouda.group,
    update(_dt: number, t: number) {
      gouda.update(t, held);
    },
    ui(panel: HTMLElement, api: BenchUiApi) {
      const parts = section(panel, "Haul");
      button(parts, "held", (b) => {
        held = !held;
        stand.visible = held;
        b.classList.toggle("on", held);
      });

      const lev = section(panel, "Levitation");
      api.sliderRow(lev, "lift", 0, 0.3, 0.005, gouda.lift, (v) => {
        gouda.lift = v;
      });
      button(lev, "bones", (b) => {
        bonesOn = !bonesOn;
        for (const arrow of markers) arrow.visible = bonesOn;
        b.classList.toggle("on", bonesOn);
      });

      const note = document.createElement("div");
      note.className = "hint";
      note.textContent =
        `wheel radius ${GOUDA_RADIUS} u — a rat diver is ~1.3 u tall. "held" ` +
        "pins the spin, pulls the levitation travel in so the bits cannot " +
        "push through a chest, and shows a stand-in diver at the carry " +
        "offset. Carrying it forces the carrier's own torch off: this IS the " +
        'party\'s light. "bones" draws each bit bone along its own +Y — the ' +
        "axis that bit rides out on — parented to the bone, so the arrows " +
        "move with the rig";
      panel.appendChild(note);
    },
    action() {
      held = !held;
      stand.visible = held;
    },
    lines: () => [
      ["lamp", gouda.lamp.intensity.toFixed(0)],
      ["glow", gouda.glow.intensity.toFixed(0)],
      ["held", held ? "yes" : "no"],
      ["bits", `${gouda.bits.length} / 7 bit bones`],
      ["lift", `${gouda.lift.toFixed(3)} u`],
    ],
  };
}

// --- Registry ----------------------------------------------------------------
// ⚠ Standing rule: every new game model gets an entry here (see AGENTS.md).
const MODELS: BenchModelDef[] = [
  {
    id: "diver",
    label: "rat diver",
    url: `${BASE}models/ratdiverAbyssalGouda.glb`,
    cam: { dist: 8, height: -0.6, gridY: -2.2 },
    build: buildDiver,
  },
  {
    id: "gloves",
    label: "fp gloves",
    url: `${BASE}models/ratdiverAbyssalGouda.glb`,
    cam: { dist: 2.2, height: -0.5, gridY: -2.2 },
    build: buildGloves,
  },
  {
    id: "catfish",
    label: "catfish",
    url: `${BASE}models/catfish_rigged.glb`,
    cam: { dist: 11, height: 1, gridY: -5 },
    build: buildCatfish,
  },
  {
    id: "bell",
    label: "tin bell",
    url: `${BASE}models/tinBell.glb`,
    cam: { dist: 14, height: 4.5, gridY: 0 },
    build: buildBell,
  },
  {
    id: "gouda",
    label: "golden gouda",
    url: `${BASE}models/golden_gouda.glb`,
    cam: { dist: 4.5, height: 0, gridY: -1.6 },
    build: buildGouda,
  },
];

// --- Bench state ---------------------------------------------------------------
let ACTIVE: BenchInstance | null = null; // active instance
let ACTIVE_DEF = MODELS[0];
const instances = new Map<string, BenchInstance>(); // id → instance
const skeletons = new Map<string, THREE.SkeletonHelper>(); // id → SkeletonHelper
let rate = 1;
let paused = false;
let spin = true;
let showBones = false;
let wire = false;

function frameCamera(cam: BenchCamSpec) {
  camera.fov = 52;
  camera.updateProjectionMatrix();
  camera.position.set(cam.dist, cam.height + cam.dist * 0.45, cam.dist * 1.25);
  controls.target.set(0, cam.height, 0);
}

async function activate(def: BenchModelDef) {
  ACTIVE_DEF = def;
  markOn(modelBtns, def.id);
  if (ACTIVE) scene.remove(ACTIVE.group);
  ACTIVE = null;
  $("loading").style.display = "flex";

  if (!instances.has(def.id)) {
    try {
      // Code-built models (no url) skip the fetch entirely.
      let gltf: GLTF | null = null;
      if (def.url) {
        console.log(`bench: loading ${def.url}`);
        gltf = await loadGltf(def.url);
      }
      console.log(`bench: building ${def.id}`);
      instances.set(def.id, def.build(gltf));
      console.log(`bench: built ${def.id}`);
    } catch (err) {
      console.error(`failed to build ${def.id}`, err);
      $("loading").textContent = `failed to build ${def.id}`;
      return;
    }
  }
  // A slow click-race: only mount if we're still the requested model.
  if (ACTIVE_DEF !== def) return;

  const inst = instances.get(def.id)!;
  ACTIVE = inst;
  scene.add(inst.group);
  $("loading").style.display = "none";

  // Debug helpers re-applied to the fresh instance.
  if (!skeletons.has(def.id)) {
    const sk = new THREE.SkeletonHelper(inst.group);
    skeletons.set(def.id, sk);
    scene.add(sk);
  }
  for (const [id, sk] of skeletons) sk.visible = showBones && id === def.id;
  applyWire();

  grid.position.y = def.cam.gridY;
  frameCamera(def.cam);

  // Per-model panel + HUD skeleton.
  const panel = $("model-ui");
  panel.innerHTML = "";
  inst.ui?.(panel, api);
  $("hud-title").textContent = def.label;
  buildHud(inst);
}

function applyWire() {
  ACTIVE?.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh && !(o as THREE.SkinnedMesh).isSkinnedMesh) return;
    // One mesh can carry several materials (the golden gouda's wheel draws its
    // cel-shaded body and its unlit bits as two geometry groups), so walk the
    // array — assigning through it would set a dead property on the Array.
    for (const mat of Array.isArray(m.material) ? m.material : [m.material])
      (mat as THREE.MeshStandardMaterial).wireframe = wire;
  });
}

// --- Global UI ---------------------------------------------------------------
const modelBtns: Record<string, HTMLButtonElement> = {};
for (const def of MODELS) {
  modelBtns[def.id] = button($("models"), def.label, () => activate(def));
}

$("btn-pause").addEventListener("click", () => {
  paused = !paused;
  $("btn-pause").classList.toggle("on", paused);
  $("btn-pause").textContent = paused ? "resume" : "pause";
});
sliderRow(
  $("global-sliders"),
  "rate",
  0.1,
  2,
  0.1,
  1,
  (v) => (rate = v),
  (v) => `${v.toFixed(1)}×`,
);

const toggles = $("toggles");
const toggle = (
  label: string,
  onClick: (on: boolean) => void,
  initial = false,
) => {
  const btn = button(toggles, label, (b) => {
    const on = !b.classList.contains("on");
    b.classList.toggle("on", on);
    onClick(on);
  });
  btn.classList.toggle("on", initial);
  return btn;
};
toggle("bones", (on) => {
  showBones = on;
  for (const [id, sk] of skeletons) sk.visible = on && id === ACTIVE_DEF.id;
});
toggle("wireframe", (on) => {
  wire = on;
  applyWire();
});
toggle("spin", (on) => (spin = on), true);
toggle(
  "fog",
  (on) => {
    scene.fog = on ? new THREE.FogExp2(WATER, 0.018) : null;
    scene.background = new THREE.Color(on ? WATER : 0x070d12);
    // Fog is a compile-time define: every cached material needs a rebuild.
    scene.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (mat && "fog" in mat) {
        mat.fog = on;
        mat.needsUpdate = true;
      }
    });
  },
  true,
);
toggle("grid", (on) => (grid.visible = on), true);

addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    ACTIVE?.action?.();
  }
  if (e.code === "KeyR") frameCamera(ACTIVE_DEF.cam);
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- HUD -----------------------------------------------------------------------
let hudLines: HTMLElement[] = [];
let hudBars: HTMLElement[] = [];
function buildHud(inst: BenchInstance) {
  const body = $("hud-body");
  body.innerHTML = "";
  hudLines = [];
  hudBars = [];

  // Static stats: what is this model made of?
  let bones = 0;
  let tris = 0;
  inst.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if ((o as THREE.Bone).isBone) bones++;
    if (
      (m.isMesh || (o as THREE.SkinnedMesh).isSkinnedMesh) &&
      m.geometry?.index
    )
      tris += m.geometry.index.count / 3;
  });
  for (const [k, v] of [
    ["bones", String(bones)],
    ["triangles", tris.toLocaleString()],
  ]) {
    const div = document.createElement("div");
    div.className = "hud-line";
    div.innerHTML = `<span class="k">${k}</span><span class="v">${v}</span>`;
    body.appendChild(div);
  }

  for (const [label] of inst.lines?.() ?? []) {
    const div = document.createElement("div");
    div.className = "hud-line";
    div.innerHTML = `<span class="k">${label}</span><span class="v">—</span>`;
    body.appendChild(div);
    hudLines.push(div.querySelector<HTMLElement>(".v")!);
  }
  for (const [label] of inst.bars?.() ?? []) {
    const div = document.createElement("div");
    div.className = "hud-bar";
    div.innerHTML = `<div class="k">${label}</div><div class="track"><div class="fill"></div></div>`;
    body.appendChild(div);
    hudBars.push(div.querySelector<HTMLElement>(".fill")!);
  }
}

let hudTimer = 0;
function readout() {
  if (!ACTIVE) return;
  hudTimer += 1;
  if (hudTimer % 3) return; // 20 Hz is plenty for text
  ACTIVE.lines?.().forEach(([, v], i) => {
    if (hudLines[i]) hudLines[i].textContent = v;
  });
  ACTIVE.bars?.().forEach(([, v], i) => {
    if (hudBars[i])
      hudBars[i].style.width = `${Math.max(0, Math.min(1, v)) * 100}%`;
  });
}

// --- Loop ------------------------------------------------------------------------
const clock = new THREE.Clock();
let elapsed = 0;

// Deep link: /preview.html?m=catfish opens straight on that model (also how
// the screenshot runner captures the bench headlessly).
const startId = new URLSearchParams(location.search).get("m");
activate(MODELS.find((m) => m.id === startId) ?? MODELS[0]);

renderer.setAnimationLoop(() => {
  const raw = Math.min(clock.getDelta(), 0.05);
  const dt = paused ? 0 : raw * rate;
  elapsed += dt;

  ACTIVE?.update(dt, elapsed);

  // Follow the animal — some of them swim a long way.
  if (ACTIVE?.focus) controls.target.lerp(ACTIVE.focus, 1 - Math.exp(-2 * raw));
  controls.autoRotate = spin && !ACTIVE?.camLocked;
  controls.autoRotateSpeed = 0.6;
  controls.update();

  renderer.render(scene, camera);
  readout();
});
