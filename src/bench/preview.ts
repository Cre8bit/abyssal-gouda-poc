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
// Entry: { id, label, url, cam: { dist, height, gridY }, build(gltf) }
// url optional (code-built models). build() returns:
//   group, update(dt, t), ui(panel, api), focus, clips, action(), lines(), bars()
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
  fpBodyPitch,
  configureFpBody,
} from "../entities/diverRig.ts";
import { prepareCatfishTemplate } from "../entities/catfish.ts";
import { toonMaterial } from "../render/toon.ts";
import { createBellVisual } from "../world/bathyscaphe.ts";
import {
  createGoudaVisual,
  prepareGoudaTemplate,
  GOUDA_RADIUS,
} from "../entities/goldenGouda.ts";
import { CARGO, holdPose } from "../game/cargo.ts";
import { applyFpBodyParams } from "./shots.ts";

declare global {
  interface Window {
    /** Live FP arm-pose tuning hook — see buildGloves(). */
    fpBody?: typeof configureFpBody;
  }
}

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

// Mirrored game constants — keep in sync with source modules
const CATFISH_SCALE = 4;
const LANTERN_BASE: Record<string, number> = {
  lurk: 55,
  stalk: 18,
  strike: 120,
};
const TORCH_OFFSET = new THREE.Vector3(0, 0.35, -0.14);
const TORCH_INTENSITY = 190;

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
// Avoid degenerate orbit while model loads
camera.position.set(5, 2, 6);

// Silhouette-readable lighting (toon: 4 band steps like in game)
scene.add(new THREE.HemisphereLight(0x8fd0ff, 0x02121c, 0.9));
const key = new THREE.DirectionalLight(0xbfe4ff, 1.6);
key.position.set(1, 1.4, 1.2);
scene.add(key);
const rim = new THREE.DirectionalLight(0x4f8fb5, 0.9);
rim.position.set(-1.3, 0.3, -1);
scene.add(rim);

// Motion reference: creature motion barely visible without grid
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

let diverTemplate: ReturnType<typeof prepareDiverTemplate> | null = null;
function diverTemplateFrom(gltf: GLTF) {
  diverTemplate ??= prepareDiverTemplate(gltf); // cel pass runs inside prep
  return diverTemplate;
}

// Canvas radial gradient sprite for lantern glow
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
  const swim = new THREE.Group(); // path + yaw
  const pivot = new THREE.Group(); // pitch
  swim.add(pivot);
  group.add(swim);
  const rig = createDiverRig(template);
  pivot.add(rig.root);

  // Helmet torch: scene-level light pinned to head each frame
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
    carrying: false, // both arms around the Golden Gouda
  };
  const vel = new THREE.Vector3();
  const focus = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _hold = { x: 0, y: 0, z: 0 };
  // Cargo at game/cargo.ts offset — tests arm contact
  const cargo = new THREE.Mesh(
    new THREE.SphereGeometry(GOUDA_RADIUS, 16, 12),
    toonMaterial({ color: 0xffc23d, transparent: true, opacity: 0.55 }),
  );
  cargo.visible = false;
  group.add(cargo);
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
        // Face direction of travel (game forward is -Z)
        if (speed > 0.1) st.yaw = Math.atan2(-vel.x, -vel.z);
      }

      // Pitch aligns with travel speed (same easing as graphics.js)
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
        carrying: st.carrying,
      });
      // Cargo at game/cargo.ts position — test carry pose
      cargo.visible = st.carrying;
      holdPose(ORIGIN, st.yaw, lookPitch, _hold);
      cargo.position.set(_hold.x, _hold.y, _hold.z).add(swim.position);

      // Torch along look direction
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
      button(modes, "carrying", (b) => {
        st.carrying = !st.carrying;
        b.classList.toggle("on", st.carrying);
      });

      // Slider touch → manual mode (stop and look)
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
        "Swim is procedural (diverRig.ts); GLB's baked NlaTrack clip unused in game";
      panel.appendChild(note);
    },
    action() {
      // Space: cycle swim gears (idle → cruise → sprint → idle)
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
      ["carrying", st.carrying ? "yes" : "no"],
    ],
    bars: () => [
      ["kick effort", rig.speedSm],
      ["carry blend", rig.carrySm],
    ],
  };
}

// --- Model: first-person gloves ---------------------------------------------
// Local player body: gloves + forearms (prep: diverRig.ts buildFpGeometry)
const AXIS_X = new THREE.Vector3(1, 0, 0);
const FOV_TAN = Math.tan((72 / 2) * (Math.PI / 180)); // camera vertical FOV
const ASPECT = 16 / 9; // …the shape the game is actually played at

// Is a point in camera space out of shot? (See the "cut vs frame" readout.)
function cutVerdict(p: THREE.Vector3): string {
  if (p.z > 0.02) return "✓ behind the lens";
  const half = Math.abs(p.z) * FOV_TAN;
  if (p.y < -half) return "✓ below the frame";
  if (Math.abs(p.x) > half * ASPECT) return "✓ off the side";
  return "✗ IN FRAME";
}

function buildGloves(gltf: GLTF): BenchInstance {
  const template = diverTemplateFrom(gltf);
  // URL params like ?m=gloves&uy=… or console: fpBody({ uy: 0.4, fy: 1.1 })
  applyFpBodyParams(new URLSearchParams(location.search));
  window.fpBody = configureFpBody;

  const group = new THREE.Group();
  const pivot = new THREE.Group();
  group.add(pivot);
  const rig = createDiverRig(template, { firstPerson: true });
  // Same material as game local body: double-sided, darkened suit
  rig.root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    const mesh = o as THREE.Mesh;
    // Arms may have 2 materials (suit + cut lining) — iterate all
    const dress = (m: THREE.Material) => {
      const c = m.clone() as THREE.Material & { color?: THREE.Color };
      c.side = THREE.DoubleSide;
      c.color?.multiplyScalar(0.58);
      return c;
    };
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(dress)
      : dress(mesh.material);
  });
  pivot.add(rig.root);

  const st = { pitch: 0, speed: 0, eyeCam: false, carrying: false };
  const vel = new THREE.Vector3();
  const focus = new THREE.Vector3(0, -0.3, -0.6);
  // Cargo at FP_HOLD offset; pivot-locked for carry pose (fpBodyPitch)
  const cargo = new THREE.Mesh(
    new THREE.SphereGeometry(GOUDA_RADIUS, 16, 12),
    toonMaterial({ color: 0xffc23d }),
  );
  cargo.position.set(0, -CARGO.FP_HOLD_DOWN, -CARGO.FP_HOLD_FORWARD);
  cargo.visible = false;
  pivot.add(cargo);

  // Joint camera-space positions: shoulder (cut), wrist (frame edge)
  const shoulder = rig.bones.get("R_Upperarm");
  const elbow = rig.bones.get("R_Forearm");
  const wrist = rig.bones.get("R_Hand");
  // Camera space: undo look pitch from world position
  const camSpace = (o: THREE.Object3D | undefined, out: THREE.Vector3) => {
    if (!o) return null;
    o.getWorldPosition(out);
    return out.applyAxisAngle(AXIS_X, -st.pitch);
  };
  const _shoulderPos = new THREE.Vector3();
  const _elbowPos = new THREE.Vector3();
  const _wristPos = new THREE.Vector3();
  // Paw aim: rest-pose forearm→hand direction, transformed to wrist frame
  const _pawAxis = new THREE.Vector3(0, 0, -1);
  const _q = new THREE.Quaternion();
  if (elbow && wrist) {
    rig.root.updateMatrixWorld(true);
    _pawAxis
      .copy(wrist.getWorldPosition(_wristPos))
      .sub(elbow.getWorldPosition(_elbowPos))
      .normalize()
      .applyQuaternion(wrist.getWorldQuaternion(_q).invert());
  }
  const _pawDir = new THREE.Vector3();

  const inst: BenchInstance = {
    group,
    focus,
    camLocked: false,
    update(dt: number) {
      // FPS body pitch synchronized with camera look
      const bodyPitch = fpBodyPitch(st.pitch);
      pivot.rotation.x = bodyPitch;
      vel.set(0, 0, -st.speed);
      updateDiverRig(rig, dt, {
        bodyYaw: 0,
        bodyPitch,
        lookYaw: 0,
        lookPitch: st.pitch,
        vel,
        carrying: st.carrying,
      });
      cargo.visible = st.carrying;
      // Eye cam: follow-lerp chases look target, not rig
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
          // Orbit camera at eye level, -Z view matches in-game
          camera.position.set(0, 0, 0.02);
          controls.target.set(0, Math.tan(-st.pitch) * 4, -4);
        } else {
          frameCamera(ACTIVE_DEF.cam);
        }
      });
      button(cams, "carrying", (b) => {
        st.carrying = !st.carrying;
        b.classList.toggle("on", st.carrying);
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
        "Pose tuned via configureFpBody() URL params (bench/shots.ts). Carrying " +
        "shows cargo at game/cargo.ts offset + carry pose blend—arms must contact wheel at every pitch";
      panel.appendChild(note);
    },
    lines: () => {
      const sh = camSpace(shoulder, _shoulderPos);
      const shZ = sh ? sh.z : 0;
      const el = camSpace(elbow, _elbowPos);
      const aim = wrist
        ? _pawDir
            .copy(_pawAxis)
            .applyQuaternion(wrist.getWorldQuaternion(_q))
            .applyAxisAngle(AXIS_X, -st.pitch)
        : null;
      const wr = camSpace(wrist, _wristPos);
      // Frame edge at wrist depth (72° FOV)
      const edge = wr
        ? Math.abs(wr.z) * Math.tan((72 / 2) * (Math.PI / 180))
        : 0;
      return [
        // Position in camera space (positive = behind lens)
        [
          "shoulder (cam)",
          sh ? `${sh.x.toFixed(2)} ${sh.y.toFixed(2)} ${shZ.toFixed(2)}` : "—",
        ],
        // Cut must be unseeable (behind lens or off frustum)
        ["cut vs frame", sh ? cutVerdict(sh) : "—"],
        // Wrist position and frame edge at that depth
        [
          "wrist (cam)",
          wr ? `${wr.x.toFixed(2)} ${wr.y.toFixed(2)} ${wr.z.toFixed(2)}` : "—",
        ],
        [
          "elbow (cam)",
          el ? `${el.x.toFixed(2)} ${el.y.toFixed(2)} ${el.z.toFixed(2)}` : "—",
        ],
        [
          "paw aim (cam)",
          aim
            ? `${aim.x.toFixed(2)} ${aim.y.toFixed(2)} ${aim.z.toFixed(2)}`
            : "—",
        ],
        ["frame edge @ wrist", (-edge).toFixed(2)],
        ["body pitch", fpBodyPitch(st.pitch).toFixed(2)],
        ["carrying", st.carrying ? "yes" : "no"],
      ];
    },
    bars: () => [
      ["arm drift", rig.speedSm],
      ["carry blend", rig.carrySm],
    ],
  };
  return inst;
}

// --- Model: lantern-catfish ---------------------------------------------------
// Baked clips (swim/bite/flicker) + lantern mood logic from catfish.ts
function buildCatfish(gltf: GLTF): BenchInstance {
  const root = prepareCatfishTemplate(gltf).scene;
  root.scale.setScalar(CATFISH_SCALE);

  const group = new THREE.Group();
  const swim = new THREE.Group();
  swim.add(root);
  group.add(swim);

  // Lantern: bulb bone + light + halo (same as catfish.ts spawnOne)
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

  // Baked animation clips (swim, flicker, bite)
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

      // Auto-replay bite
      st.biteTimer += dt;
      if (st.biteLoop && st.biteTimer > 2.6) triggerBite();

      // Lantern mood: intensity/jitter recipe + strike flare
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
// Prop: berthed bell + cabin lamps, entry beacon. No animation; uses bathyscaphe.ts builder.
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
      // Space: toggle lamp (visual feedback on grid)
      bell.setLamp(!bell.isLampOn());
    },
    lines: () => [
      ["beacon", bell.lamp.intensity.toFixed(0)],
      ["cabin", bell.cabin.intensity.toFixed(0)],
    ],
  };
}

// --- Model: the Golden Gouda ---------------------------------------------------
// Cargo wheel: cel-shaded body + 7 levitating bit bones. Test lights and levitation.
// Wheel radius ~1.3m (fits in diver arm reach). Use "bones" to debug bit armature.
function buildGouda(gltf: GLTF | null): BenchInstance {
  const gouda = createGoudaVisual(gltf ? prepareGoudaTemplate(gltf) : null);
  let held = false;

  // Diver stand-in at cargo hold offset (test carry pose)
  const stand = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.6, 0.7, 6, 12),
    toonMaterial({ color: 0x2b4756, transparent: true, opacity: 0.5 }),
  );
  stand.position.set(0, CARGO.HOLD_DOWN, CARGO.HOLD_FORWARD);
  stand.visible = false;
  gouda.group.add(stand);

  // Bone arrows: parented to bit bones, follow animated transform
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
      api.sliderRow(lev, "drift", 0, 0.5, 0.005, gouda.drift, (v) => {
        gouda.drift = v;
      });
      api.sliderRow(lev, "orbit ×", 0, 6, 0.1, gouda.orbit, (v) => {
        gouda.orbit = v;
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
        'move with the rig. "lift" is travel out of the socket along that ' +
        'axis, "drift" is the slow float away from the wheel\'s centre, and ' +
        '"orbit ×" scales how fast each bit revolves about the wheel — turn ' +
        "it up to see minutes of the field's motion in seconds";
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
      ["drift", `${gouda.drift.toFixed(3)} u`],
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
  // Slow click-race: only mount if still requested model
  if (ACTIVE_DEF !== def) return;
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
    // Multi-material meshes (e.g. gouda: body+bits) — wireframe all
    for (const mat of Array.isArray(m.material) ? m.material : [m.material])
      (mat as THREE.MeshStandardMaterial).wireframe = wire;
  });
}

// --- Global UI ---------------------------------------------------------------
// Model selector buttons; pause/resume; global animation rate slider; toggles
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
    // Fog is compile-time define; materials cached without it need rebuild
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
// Readout: bone count, tri count, model-specific live stats + progress bars
let hudLines: HTMLElement[] = [];
let hudBars: HTMLElement[] = [];
function buildHud(inst: BenchInstance) {
  const body = $("hud-body");
  body.innerHTML = "";
  hudLines = [];
  hudBars = [];

  // Static: bone/triangle count from the active model
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
  if (hudTimer % 3) return; // 20 Hz refresh for text
  ACTIVE.lines?.().forEach(([, v], i) => {
    if (hudLines[i]) hudLines[i].textContent = v;
  });
  ACTIVE.bars?.().forEach(([, v], i) => {
    if (hudBars[i])
      hudBars[i].style.width = `${Math.max(0, Math.min(1, v)) * 100}%`;
  });
}

// --- Loop ------------------------------------------------------------------------
// Main animation frame loop: update models, sync camera, refresh HUD
const clock = new THREE.Clock();
let elapsed = 0;

// Deep link: ?m=id opens on that model (used by screenshot runner too)
const startId = new URLSearchParams(location.search).get("m");
activate(MODELS.find((m) => m.id === startId) ?? MODELS[0]);

renderer.setAnimationLoop(() => {
  const raw = Math.min(clock.getDelta(), 0.05);
  const dt = paused ? 0 : raw * rate;
  elapsed += dt;

  ACTIVE?.update(dt, elapsed);

  // Camera follows focus point (lerp; some models swim far)
  if (ACTIVE?.focus) controls.target.lerp(ACTIVE.focus, 1 - Math.exp(-2 * raw));
  controls.autoRotate = spin && !ACTIVE?.camLocked;
  controls.autoRotateSpeed = 0.6;
  controls.update();

  renderer.render(scene, camera);
  readout();
});
