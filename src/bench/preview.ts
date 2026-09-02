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
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import {
  prepareDiverTemplate,
  createDiverRig,
  updateDiverRig,
  applyArmPoseSides,
  blendArmPose,
  fpBodyPitch,
  configureFpBody,
  gripPlacements,
  holdAnchor,
  solveHeldAnchor,
  PHASE_EASE,
  PHASE_EASE_DEFAULT,
  type ArmPose,
  type CarryKind,
  type DiverRig,
  type GripKind,
} from "../entities/diverRig.ts";
import { prepareCatfishTemplate } from "../entities/catfish.ts";
import { toonMaterial } from "../render/toon.ts";
import { createBellVisual } from "../world/bathyscaphe.ts";
import {
  createGoudaVisual,
  prepareGoudaTemplate,
  GOUDA_RADIUS,
} from "../entities/goldenGouda.ts";
import {
  createDrillerVisual,
  prepareDrillerTemplate,
  DRILLER_LENGTH,
} from "../entities/driller.ts";
import {
  createLightStickVisual,
  prepareLightStickTemplate,
  LIGHT_STICK_LENGTH,
} from "../entities/lightStick.ts";
import { CARGO, holdPose } from "../game/cargo.ts";
import { applyFpBodyParams } from "./shots.ts";
import { button, markOn, section, sliderRow } from "./ui.ts";

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

// The hold cycle both diver entries share: nothing → the wheel → the tool.
const CARRY_CYCLE: CarryKind[] = ["none", "gouda", "driller", "lightStick"];
const nextCarry = (c: CarryKind) =>
  CARRY_CYCLE[(CARRY_CYCLE.indexOf(c) + 1) % CARRY_CYCLE.length];
// The light stick's throw, as a bench-side driver: name the phase each frame
// and diverRig blends between its authored states. This is the shape a game
// system will have — a timeline of [state, seconds], nothing more.
const THROW_SEQ: [string, number][] = [
  ["grab", 0.45],
  ["hold", 0.9],
  ["throw", 0.55],
];
function makeThrow() {
  let step = -1; // -1 = idle, resting in "hold"
  let timer = 0;
  return {
    start() {
      step = 0;
      timer = 0;
    },
    get running() {
      return step >= 0;
    },
    phase(dt: number): string {
      if (step < 0) return "hold";
      timer += dt;
      if (timer >= THROW_SEQ[step][1]) {
        timer = 0;
        step += 1;
        if (step >= THROW_SEQ.length) step = -1;
      }
      return step < 0 ? "hold" : THROW_SEQ[step][0];
    },
  };
}

// Deep link: ?hold=gouda|driller|lightStick opens with something in the paws.
const startCarry = ((): CarryKind => {
  const p = new URLSearchParams(location.search).get("hold") as CarryKind;
  return CARRY_CYCLE.includes(p) ? p : "none";
})();

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

// UI kit shared with the worldgen bench — see ui.ts.
const api = { button, sliderRow, section };

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
    carry: startCarry, // what's in the paws
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
  // The driller rides its paw anchor — same node the game hangs it from.
  const driller = createDrillerVisual();
  driller.group.visible = false;
  holdAnchor(rig, "driller")?.add(driller.group);
  // …and so does the light stick, through its own grip's paw anchor.
  const stick = createLightStickVisual();
  stick.group.visible = false;
  holdAnchor(rig, "lightStick")?.add(stick.group);
  const thrower = makeThrow();
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
        carry: st.carry,
        carryPhase: thrower.phase(dt),
      });
      // Cargo at game/cargo.ts position — test carry pose
      cargo.visible = st.carry === "gouda";
      driller.group.visible = st.carry === "driller";
      driller.update(t, true);
      stick.group.visible = st.carry === "lightStick";
      stick.update(t, true);
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
      const carryBtn = button(modes, "hold: none", (b) => {
        st.carry = nextCarry(st.carry);
        b.textContent = `hold: ${st.carry}`;
        b.classList.toggle("on", st.carry !== "none");
      });
      carryBtn.textContent = `hold: ${st.carry}`;
      button(modes, "throw stick", () => {
        st.carry = "lightStick";
        carryBtn.textContent = "hold: lightStick";
        carryBtn.classList.add("on");
        thrower.start();
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
      ["holding", st.carry],
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

  const st = {
    pitch: 0,
    speed: 0,
    eyeCam: false,
    carry: startCarry,
  };
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
  // The driller rides the FP paw anchor, exactly as it does in game.
  const driller = createDrillerVisual();
  driller.group.visible = false;
  holdAnchor(rig, "driller")?.add(driller.group);
  const stick = createLightStickVisual();
  stick.group.visible = false;
  holdAnchor(rig, "lightStick")?.add(stick.group);
  const thrower = makeThrow();

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
    update(dt: number, t: number) {
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
        carry: st.carry,
        carryPhase: thrower.phase(dt),
      });
      cargo.visible = st.carry === "gouda";
      driller.group.visible = st.carry === "driller";
      driller.update(t, true);
      stick.group.visible = st.carry === "lightStick";
      stick.update(t, true);
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
      const carryBtn = button(cams, "hold: none", (b) => {
        st.carry = nextCarry(st.carry);
        b.textContent = `hold: ${st.carry}`;
        b.classList.toggle("on", st.carry !== "none");
      });
      carryBtn.textContent = `hold: ${st.carry}`;
      button(cams, "throw stick", () => {
        st.carry = "lightStick";
        carryBtn.textContent = "hold: lightStick";
        carryBtn.classList.add("on");
        thrower.start();
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
        ["holding", st.carry],
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

// --- Model: the driller ---------------------------------------------------
// Prop: static mesh, no skin/animation. Test scale-fit and the carry pose.
function buildDriller(gltf: GLTF | null): BenchInstance {
  const driller = createDrillerVisual(
    gltf ? prepareDrillerTemplate(gltf) : null,
  );
  let held = false;
  let drilling = false;

  // Diver stand-in at cargo hold offset (test carry pose)
  const stand = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.6, 0.7, 6, 12),
    toonMaterial({ color: 0x2b4756, transparent: true, opacity: 0.5 }),
  );
  stand.position.set(0, CARGO.HOLD_DOWN, CARGO.HOLD_FORWARD);
  stand.visible = false;
  driller.group.add(stand);

  return {
    group: driller.group,
    update(_dt: number, t: number) {
      if (drilling) driller.strike(); // held fire: one bite per frame
      driller.update(t, held);
    },
    ui(panel: HTMLElement) {
      const parts = section(panel, "Haul");
      button(parts, "held", (b) => {
        held = !held;
        stand.visible = held;
        b.classList.toggle("on", held);
      });
      button(parts, "drilling", (b) => {
        drilling = !drilling;
        b.classList.toggle("on", drilling);
      });
      const note = document.createElement("div");
      note.className = "hint";
      note.textContent =
        `driller length ${DRILLER_LENGTH} u — one per run, seeded in the ` +
        'drift wreck (M3.1). "held" shows a stand-in diver at the carry ' +
        "offset (same HOLD_* rig the Golden Gouda rides); the model has no " +
        'rig of its own, just a bounding-box scale-fit. "drilling" holds the ' +
        "bit's throttle open — in game one dig does that for half a second.";
      panel.appendChild(note);
    },
    action() {
      held = !held;
      stand.visible = held;
    },
    lines: () => [
      ["held", held ? "yes" : "no"],
      ["bit", driller.bit ? "found" : "MISSING"],
      ["spin", `${driller.spinRate().toFixed(1)} rad/s`],
    ],
  };
}

// --- Arm-joint gizmo rig, shared by the pose editor below ------------------
// Each posable joint owns 2-3 ArmPose fields (see diverRig.ts's
// applyArmPoseSides). A gizmo proxy is kept in lockstep with those fields via
// a fixed `base` quaternion — rest∘(template axes → standard basis) — chosen
// so a LOCAL-space TransformControls rotate handle's X/Y/Z rings correspond
// exactly to the joint's aX/aY/aZ template axes: dragging one ring right-
// multiplies a standard-axis rotation onto the proxy, and decomposing the
// proxy's rotation (relative to `base`) via THREE.Euler in the same order
// pose()/poseAdd() compose in recovers the field values directly. Order and
// the L/R sign flip mirror applyArmPoseSides exactly.
type ArmJointKind = "upperarm" | "forearm" | "hand";
const ARM_JOINT_ORDER: Record<ArmJointKind, THREE.EulerOrder> = {
  upperarm: "YXZ",
  forearm: "YXZ",
  hand: "XYZ",
};
const ARM_JOINT_COLOR: Record<ArmJointKind, number> = {
  upperarm: 0x5ce8ff,
  forearm: 0x8fe05c,
  hand: 0xffc23d,
};
const TARGET_SELECTED = 0xff5c8a;
const TOOL_COLOR = 0xffffff;

interface ArmJoint {
  kind: ArmJointKind;
  side: "L" | "R";
  proxy: THREE.Object3D;
  marker: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  base: THREE.Quaternion;
}
// The held tool itself: no proxy/basis remap needed — the gizmo drives
// `driller.group`'s own position/rotation directly (translate AND rotate,
// unlike the arm joints, which are rotate-only about template axes).
interface ToolJoint {
  kind: "tool";
  marker: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
}
type GizmoTarget = ArmJoint | ToolJoint;
function targetColor(t: GizmoTarget): number {
  return t.kind === "tool" ? TOOL_COLOR : ARM_JOINT_COLOR[t.kind];
}

// ArmPose fields → this joint's rest-relative Euler (and back). Order/signs
// match applyArmPoseSides's pose()/poseAdd() composition exactly.
function jointEuler(
  kind: ArmJointKind,
  side: "L" | "R",
  p: ArmPose,
): THREE.Euler {
  const s = side === "L" ? -1 : 1;
  const order = ARM_JOINT_ORDER[kind];
  if (kind === "upperarm") return new THREE.Euler(p.ux, s * p.uy, 0, order);
  if (kind === "forearm")
    return new THREE.Euler(p.fx, s * p.fy, s * p.fz, order);
  return new THREE.Euler(p.hx, s * p.hy, s * p.hz, order);
}
function jointWritePose(
  kind: ArmJointKind,
  side: "L" | "R",
  e: THREE.Euler,
  out: ArmPose,
): void {
  const s = side === "L" ? -1 : 1;
  if (kind === "upperarm") {
    out.ux = e.x;
    out.uy = s * e.y;
  } else if (kind === "forearm") {
    out.fx = e.x;
    out.fy = s * e.y;
    out.fz = s * e.z;
  } else {
    out.hx = e.x;
    out.hy = s * e.y;
    out.hz = s * e.z;
  }
}
// Copy just the fields `kind` owns from one pose to another (mirroring).
function jointCopyFields(kind: ArmJointKind, from: ArmPose, to: ArmPose): void {
  if (kind === "upperarm") {
    to.ux = from.ux;
    to.uy = from.uy;
  } else if (kind === "forearm") {
    to.fx = from.fx;
    to.fy = from.fy;
    to.fz = from.fz;
  } else {
    to.hx = from.hx;
    to.hy = from.hy;
    to.hz = from.hz;
  }
}

function buildArmJoints(rig: DiverRig): ArmJoint[] {
  const specs: { bone: string; side: "L" | "R"; kind: ArmJointKind }[] = [
    { bone: "L_Upperarm", side: "L", kind: "upperarm" },
    { bone: "R_Upperarm", side: "R", kind: "upperarm" },
    { bone: "L_Forearm", side: "L", kind: "forearm" },
    { bone: "R_Forearm", side: "R", kind: "forearm" },
    { bone: "L_Hand", side: "L", kind: "hand" },
    { bone: "R_Hand", side: "R", kind: "hand" },
  ];
  const joints: ArmJoint[] = [];
  for (const s of specs) {
    const bone = rig.bones.get(s.bone);
    const d = rig.data.get(s.bone);
    if (!bone || !d || !bone.parent) continue;
    const basis = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(d.aX, d.aY, d.aZ),
    );
    const base = d.rest.clone().multiply(basis);
    const proxy = new THREE.Group();
    proxy.position.copy(bone.position);
    bone.parent.add(proxy);
    const material = new THREE.MeshBasicMaterial({
      color: ARM_JOINT_COLOR[s.kind],
      depthTest: false,
      transparent: true,
    });
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 12, 8),
      material,
    );
    marker.visible = false;
    bone.add(marker);
    joints.push({ side: s.side, kind: s.kind, proxy, marker, material, base });
  }
  return joints;
}

// --- Mode: the held-prop pose editor ------------------------------------------
// Author what a diver's arms do around a prop, by hand, against the real rig.
// One editor serves every held prop: hand it a prop factory and the grip it
// belongs to, and it opens ON THE POSE THAT ALREADY SHIPS (diverRig's
// gripPlacements()) — a pose editor that started from a T-pose would show none
// of the work already done. Per-side ArmPose sliders lock the arms
// (applyArmPoseSides overrides whatever updateDiverRig's swim blend just
// wrote), a "mirror L/R" toggle collapses them to one symmetric set when the
// arms don't need to differ, "gizmo select" grabs any of the 6 posable joints
// — or the prop — straight off the model with a handle instead of hunting
// sliders, and 6 more sliders place the prop in the diver's own root frame.
//
// Grips with several named STATES (the light stick's belt grab → hold →
// throw) get one tab per state, a "snap to paw" that drops the prop into the
// hand wherever this state's arm just put it, and a "play" button that walks
// the states in sequence through the same smoothstep blend updateDiverRig
// runs — prop riding the paw anchor exactly as it does in game, so what plays
// here is the animation that ships.
interface ToolXf {
  px: number;
  py: number;
  pz: number;
  rx: number;
  ry: number;
  rz: number;
}

interface EditorState {
  key: string;
  label: string;
  L: ArmPose;
  R: ArmPose;
  tool: ToolXf;
  /** What diverRig ships for this state — the "shipped" reset. */
  shipped: { L: ArmPose; R: ArmPose; tool: ToolXf };
  /** This state's placement in the paw's frame, re-solved when it's edited. */
  anchor: THREE.Object3D;
}

interface PoseEditorSpec {
  id: string; // MODELS id — the DOM listeners below check it
  kind: GripKind; // which grip's placements to open on
  makeProp(): { group: THREE.Group; update(t: number, held: boolean): void };
  open?: string; // state to open on (default: the first)
  /** [state key, seconds to dwell] — the loop "play" walks. */
  play?: [string, number][];
  /** A state whose placement is a fixture on the body: ghost the prop there. */
  ghost?: string;
}

const zeroPose = (): ArmPose => ({
  uy: 0,
  ux: 0,
  fy: 0,
  fx: 0,
  fz: 0,
  hx: 0,
  hy: 0,
  hz: 0,
});

const _xfP = new THREE.Vector3();
const _xfQ = new THREE.Quaternion();
const _xfS = new THREE.Vector3();
const _xfE = new THREE.Euler();
const _xfM = new THREE.Matrix4();

function toolXfFrom(m: THREE.Matrix4 | null): ToolXf {
  if (!m) return { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };
  m.decompose(_xfP, _xfQ, _xfS);
  _xfE.setFromQuaternion(_xfQ);
  return { px: _xfP.x, py: _xfP.y, pz: _xfP.z, rx: _xfE.x, ry: _xfE.y, rz: _xfE.z }; // prettier-ignore
}
function toolMatrix(t: ToolXf, out: THREE.Matrix4): THREE.Matrix4 {
  return out.compose(
    _xfP.set(t.px, t.py, t.pz),
    _xfQ.setFromEuler(_xfE.set(t.rx, t.ry, t.rz)),
    _xfS.set(1, 1, 1),
  );
}
const sameArmPose = (a: ArmPose, b: ArmPose) =>
  (Object.keys(a) as (keyof ArmPose)[]).every(
    (k) => Math.abs(a[k] - b[k]) < 1e-9,
  );

function buildPoseEditor(gltf: GLTF, spec: PoseEditorSpec): BenchInstance {
  const template = diverTemplateFrom(gltf);
  const rig = createDiverRig(template);
  const prop = spec.makeProp();
  rig.root.add(prop.group);

  const group = new THREE.Group();
  group.add(rig.root);

  // Open on what ships. Every state carries its own copy AND the original,
  // so "shipped" is a reset and not a reload of the page.
  const states: EditorState[] = gripPlacements(spec.kind).map((p) => {
    const tool = toolXfFrom(p.tool);
    return {
      key: p.key,
      label: p.label,
      L: { ...p.left },
      R: { ...p.right },
      tool,
      shipped: { L: { ...p.left }, R: { ...p.right }, tool: { ...tool } },
      anchor: new THREE.Object3D(),
    };
  });
  const stateOf = (key: string) => states.find((s) => s.key === key);
  let active = (spec.open && stateOf(spec.open)) || states[0];
  // The shipped grips are asymmetric wherever a prop is held one-handed, so
  // the mirror default follows what we opened on rather than forcing it.
  let mirror = sameArmPose(active.L, active.R);

  // The prop's live paw anchor — the same node holdAnchor() hangs a game prop
  // from, driven here from the states being edited instead of the constants.
  const live = new THREE.Object3D();
  rig.bones.get("R_Hand")?.add(live);
  let anchorsDirty = true;

  // A second, dimmed prop pinned at the belt state, so the holster stays
  // visible while the other states are being posed.
  const ghost = spec.ghost ? spec.makeProp() : null;
  let ghostDimmed = false;
  if (ghost) {
    ghost.group.visible = false;
    rig.root.add(ghost.group);
  }

  const vel = new THREE.Vector3();
  const blendL = zeroPose();
  const blendR = zeroPose();
  let exportStr = '(click "Export")';

  const armJoints = buildArmJoints(rig);
  const toolMaterial = new THREE.MeshBasicMaterial({
    color: TOOL_COLOR,
    depthTest: false,
    transparent: true,
  });
  const toolMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 12, 8),
    toolMaterial,
  );
  toolMarker.visible = false;
  prop.group.add(toolMarker);
  const toolJoint: ToolJoint = {
    kind: "tool",
    marker: toolMarker,
    material: toolMaterial,
  };
  const targets: GizmoTarget[] = [...armJoints, toolJoint];

  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.size = 0.7;
  const gizmoHelper = gizmo.getHelper();
  gizmoHelper.visible = false;
  scene.add(gizmoHelper);

  let gizmoOn = false;
  let toolMode: "translate" | "rotate" = "translate";
  let selected: GizmoTarget | null = null;
  let dragging = false;
  let hoveredMarker: THREE.Mesh | null = null;
  let constrainAxis: "x" | "y" | "z" | null = null;

  // --- Playback of the state sequence ---------------------------------------
  let playing = false;
  let stepIdx = 0;
  let from = active;
  let to = active;
  let phaseU = 1;
  let dwell = 0;

  gizmo.addEventListener("dragging-changed", (e) => {
    dragging = !!e.value;
    controls.enabled = !dragging;
  });

  const sliderHandles = new Map<string, ReturnType<typeof sliderRow>>();
  const refreshSliders = () => {
    for (const [key, handle] of sliderHandles) {
      const [side, field] = key.split(".") as ["L" | "R", keyof ArmPose];
      handle.set((side === "L" ? active.L : active.R)[field]);
    }
  };
  const toolSliderHandles = new Map<keyof ToolXf, ReturnType<typeof sliderRow>>(); // prettier-ignore
  const refreshToolSliders = () => {
    for (const [key, handle] of toolSliderHandles) handle.set(active.tool[key]);
  };

  function syncProxyFromPose(j: ArmJoint) {
    const p = j.side === "L" ? active.L : active.R;
    j.proxy.quaternion
      .copy(j.base)
      .multiply(
        new THREE.Quaternion().setFromEuler(jointEuler(j.kind, j.side, p)),
      );
  }
  function syncPoseFromProxy(j: ArmJoint) {
    const e = new THREE.Euler().setFromQuaternion(
      j.base.clone().invert().multiply(j.proxy.quaternion),
      ARM_JOINT_ORDER[j.kind],
    );
    const mine = j.side === "L" ? active.L : active.R;
    jointWritePose(j.kind, j.side, e, mine);
    if (mirror) {
      jointCopyFields(j.kind, mine, j.side === "L" ? active.R : active.L);
    }
    anchorsDirty = true;
    refreshSliders();
  }
  function syncToolFromGizmo() {
    active.tool.px = prop.group.position.x;
    active.tool.py = prop.group.position.y;
    active.tool.pz = prop.group.position.z;
    active.tool.rx = prop.group.rotation.x;
    active.tool.ry = prop.group.rotation.y;
    active.tool.rz = prop.group.rotation.z;
    anchorsDirty = true;
    refreshToolSliders();
  }
  function setToolMode(m: "translate" | "rotate") {
    toolMode = m;
    if (selected?.kind === "tool") gizmo.setMode(m);
  }
  function selectTarget(t: GizmoTarget | null) {
    if (selected) {
      selected.material.color.setHex(targetColor(selected));
      // Reset marker scale when deselecting (unless still hovered)
      if (selected.marker !== hoveredMarker) selected.marker.scale.setScalar(1);
    }
    selected = t;
    constrainAxis = null; // Reset axis constraint when switching targets
    if (!t) {
      gizmo.detach();
      gizmoHelper.visible = false;
      return;
    }
    if (t.kind === "tool") {
      gizmo.setSpace("world");
      gizmo.showX = gizmo.showY = gizmo.showZ = true;
      gizmo.setMode(toolMode);
      gizmo.attach(prop.group);
    } else {
      syncProxyFromPose(t);
      gizmo.setSpace("local");
      gizmo.setMode("rotate"); // arm joints only rotate, about their own template axes
      gizmo.showZ = t.kind !== "upperarm"; // upperarm has no roll axis
      gizmo.attach(t.proxy);
    }
    gizmoHelper.visible = true;
    t.material.color.setHex(TARGET_SELECTED);
  }

  // Drop the prop into the paw at this state's arm pose — position AND
  // orientation, i.e. straight into the hand bone's own frame, which is the
  // starting point every grip is a rotation away from.
  function snapToPaw() {
    const hand = rig.bones.get("R_Hand");
    if (!hand) return;
    applyArmPoseSides(rig, active.L, active.R);
    rig.root.updateMatrixWorld(true);
    // A prop transform is read in the rig-root frame, so the paw's own place
    // in that frame IS the transform that lands the prop in the paw.
    _xfM.copy(rig.root.matrixWorld).invert().multiply(hand.matrixWorld);
    _xfM.decompose(_xfP, _xfQ, _xfS);
    _xfE.setFromQuaternion(_xfQ);
    active.tool.px = _xfP.x;
    active.tool.py = _xfP.y;
    active.tool.pz = _xfP.z;
    active.tool.rx = _xfE.x;
    active.tool.ry = _xfE.y;
    active.tool.rz = _xfE.z;
    anchorsDirty = true;
    refreshToolSliders();
  }

  // Re-solve every state's placement in the paw's frame. Cheap, and only run
  // when something was actually dragged.
  function resolveAnchors() {
    for (const st of states) {
      solveHeldAnchor(rig, st.L, st.R, toolMatrix(st.tool, _xfM), st.anchor);
    }
    anchorsDirty = false;
  }

  function setPlaying(on: boolean) {
    if (on === playing) return;
    playing = on;
    if (on) {
      selectTarget(null);
      resolveAnchors();
      stepIdx = 0;
      const seq = spec.play!;
      from = stateOf(seq[seq.length - 1][0]) ?? active;
      to = stateOf(seq[0][0]) ?? active;
      phaseU = 0;
      dwell = 0;
      live.add(prop.group);
      prop.group.position.set(0, 0, 0);
      prop.group.rotation.set(0, 0, 0);
    } else {
      rig.root.add(prop.group);
    }
  }

  function advance(dt: number) {
    const seq = spec.play!;
    const rate = PHASE_EASE[to.key] ?? PHASE_EASE_DEFAULT;
    if (phaseU < 1) {
      phaseU = Math.min(1, phaseU + dt * rate);
      return;
    }
    dwell += dt;
    if (dwell < seq[stepIdx][1]) return;
    stepIdx = (stepIdx + 1) % seq.length;
    from = to;
    to = stateOf(seq[stepIdx][0]) ?? to;
    phaseU = 0;
    dwell = 0;
  }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pickable = () => targets.map((j) => j.marker);
  const setNdc = (ev: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
  };

  // Hover feedback on markers
  renderer.domElement.addEventListener("pointermove", (ev) => {
    if (ACTIVE_DEF.id !== spec.id || !gizmoOn || playing) return;
    setNdc(ev);
    const hits = raycaster.intersectObjects(pickable());
    const hovered = hits.length > 0 ? (hits[0].object as THREE.Mesh) : null;
    if (hoveredMarker !== hovered) {
      if (hoveredMarker && hoveredMarker !== selected?.marker) {
        hoveredMarker.scale.setScalar(1);
      }
      hoveredMarker = hovered;
      if (hoveredMarker && hoveredMarker !== selected?.marker) {
        hoveredMarker.scale.setScalar(1.5);
      }
    }
  });

  renderer.domElement.addEventListener("pointerdown", (ev) => {
    if (ACTIVE_DEF.id !== spec.id || !gizmoOn || gizmo.dragging || playing)
      return;
    setNdc(ev);
    const hit = raycaster.intersectObjects(pickable())[0];
    selectTarget(hit ? targets.find((j) => j.marker === hit.object)! : null);
  });

  // Keyboard controls for gizmo mode switching and axis constraints
  const handleGizmoKeys = (e: KeyboardEvent) => {
    if (ACTIVE_DEF.id !== spec.id || !gizmoOn) return;
    if (e.target instanceof HTMLInputElement) return; // Don't override text input

    const lower = e.key.toLowerCase();

    if (lower === "escape" && selected) {
      e.preventDefault();
      selectTarget(null);
      return;
    }

    if (!selected) return;

    if (lower === "t" && selected.kind === "tool") {
      e.preventDefault();
      setToolMode("translate");
    } else if (lower === "r" && selected.kind === "tool") {
      e.preventDefault();
      setToolMode("rotate");
    } else if (lower === "x" || lower === "y" || lower === "z") {
      e.preventDefault();
      constrainAxis =
        constrainAxis === lower ? null : (lower as "x" | "y" | "z");
      // Update gizmo constraints
      if (selected.kind === "tool") {
        gizmo.showX = constrainAxis === null || constrainAxis === "x";
        gizmo.showY = constrainAxis === null || constrainAxis === "y";
        gizmo.showZ = constrainAxis === null || constrainAxis === "z";
      }
    }
  };

  document.addEventListener("keydown", handleGizmoKeys);

  // The export block: what gets pasted back into diverRig.ts. One state
  // editors keep the flat shape; multi-state ones key it by state.
  function exportPayload(st: EditorState) {
    const same = sameArmPose(st.L, st.R);
    return {
      ...(same ? { armPose: { ...st.L } } : { armPoseL: { ...st.L }, armPoseR: { ...st.R } }), // prettier-ignore
      tool: {
        position: [st.tool.px, st.tool.py, st.tool.pz],
        rotation: [st.tool.rx, st.tool.ry, st.tool.rz],
      },
    };
  }

  return {
    group,
    update(dt: number, t: number) {
      // The ghost holster: the prop, dimmed, wherever the belt state puts it.
      if (ghost) {
        const belt = stateOf(spec.ghost!);
        if (belt) {
          ghost.group.position.set(belt.tool.px, belt.tool.py, belt.tool.pz);
          ghost.group.rotation.set(belt.tool.rx, belt.tool.ry, belt.tool.rz);
        }
        if (!ghostDimmed && ghost.group.children.length) {
          dimProp(ghost.group);
          ghostDimmed = true;
        }
        ghost.update(t, true);
      }

      const toolDragging = selected?.kind === "tool" && dragging;
      if (!playing && selected && dragging) {
        if (selected.kind === "tool") syncToolFromGizmo();
        else syncPoseFromProxy(selected);
      }
      updateDiverRig(rig, dt, {
        bodyYaw: 0,
        bodyPitch: 0,
        lookYaw: 0,
        lookPitch: 0,
        vel,
        carry: "none",
      });

      if (playing) {
        if (anchorsDirty) resolveAnchors();
        advance(dt);
        const k = phaseU * phaseU * (3 - 2 * phaseU); // same smoothstep the rig runs
        applyArmPoseSides(
          rig,
          blendArmPose(from.L, to.L, k, blendL),
          blendArmPose(from.R, to.R, k, blendR),
        );
        live.position.lerpVectors(from.anchor.position, to.anchor.position, k);
        live.quaternion.slerpQuaternions(
          from.anchor.quaternion,
          to.anchor.quaternion,
          k,
        );
        live.scale.lerpVectors(from.anchor.scale, to.anchor.scale, k);
      } else {
        applyArmPoseSides(rig, active.L, active.R); // locks the arms, overriding the swim blend
        for (const j of armJoints) {
          if (j === selected && dragging) continue;
          syncProxyFromPose(j);
        }
        if (!toolDragging) {
          const x = active.tool;
          prop.group.position.set(x.px, x.py, x.pz);
          prop.group.rotation.set(x.rx, x.ry, x.rz);
        }
      }
      prop.update(t, true); // held: no idle world-bob fighting the sliders
    },
    ui(panel: HTMLElement, api: BenchUiApi) {
      function renderPanel() {
        panel.innerHTML = "";
        sliderHandles.clear();
        toolSliderHandles.clear();

        // State tabs — only worth the room when the grip has more than one.
        if (states.length > 1) {
          const sec = api.section(panel, "State");
          const btns: Record<string, HTMLButtonElement> = {};
          for (const st of states) {
            btns[st.key] = api.button(sec, st.label, () => {
              active = st;
              setPlaying(false);
              selectTarget(null);
              markOn(btns, st.key);
              renderPanel();
            });
          }
          markOn(btns, active.key);
          if (spec.play) {
            api
              .button(sec, "play", (b) => {
                setPlaying(!playing);
                b.classList.toggle("on", playing);
              })
              .classList.toggle("on", playing);
          }
        }

        const editSec = api.section(panel, "Editing");
        api
          .button(editSec, "mirror L/R", (b) => {
            mirror = !mirror;
            if (mirror) Object.assign(active.R, active.L);
            anchorsDirty = true;
            b.classList.toggle("on", mirror);
            renderPanel();
          })
          .classList.toggle("on", mirror);
        api
          .button(editSec, "gizmo select", (b) => {
            gizmoOn = !gizmoOn;
            if (!gizmoOn) selectTarget(null);
            for (const j of targets) j.marker.visible = gizmoOn;
            b.classList.toggle("on", gizmoOn);
            renderPanel();
          })
          .classList.toggle("on", gizmoOn);
        if (ghost) {
          api
            .button(editSec, "belt ghost", (b) => {
              ghost.group.visible = !ghost.group.visible;
              b.classList.toggle("on", ghost.group.visible);
            })
            .classList.toggle("on", ghost.group.visible);
        }

        const toolModeBtns: Record<string, HTMLButtonElement> = {
          translate: api.button(editSec, "tool: move (T)", () => {
            setToolMode("translate");
            markOn(toolModeBtns, "translate");
          }),
          rotate: api.button(editSec, "tool: rotate (R)", () => {
            setToolMode("rotate");
            markOn(toolModeBtns, "rotate");
          }),
        };
        markOn(toolModeBtns, toolMode);

        // Gizmo size slider
        const gizmoSec = api.section(panel, "Gizmo");
        api.sliderRow(
          gizmoSec,
          "size",
          0.3,
          1.5,
          0.05,
          gizmo.size,
          (v) => {
            gizmo.size = v;
          },
          (v) => `${v.toFixed(2)}`,
        );

        // Reset buttons
        const resetBtnContainer = document.createElement("div");
        resetBtnContainer.className = "row";
        gizmoSec.appendChild(resetBtnContainer);
        api.button(resetBtnContainer, "shipped", () => {
          Object.assign(active.L, active.shipped.L);
          Object.assign(active.R, active.shipped.R);
          Object.assign(active.tool, active.shipped.tool);
          mirror = sameArmPose(active.L, active.R);
          anchorsDirty = true;
          renderPanel();
          for (const j of armJoints) syncProxyFromPose(j);
        });
        api.button(resetBtnContainer, "reset arm", () => {
          Object.assign(active.L, zeroPose());
          Object.assign(active.R, zeroPose());
          anchorsDirty = true;
          refreshSliders();
          for (const j of armJoints) syncProxyFromPose(j);
        });
        api.button(resetBtnContainer, "reset tool", () => {
          Object.assign(active.tool, toolXfFrom(null));
          anchorsDirty = true;
          refreshToolSliders();
        });
        api.button(resetBtnContainer, "snap to paw", () => snapToPaw());

        const addSide = (label: string, side: "L" | "R", p: ArmPose) => {
          const sec = api.section(panel, label);
          const fields: (keyof ArmPose)[] = [
            "uy",
            "ux",
            "fy",
            "fx",
            "fz",
            "hx",
            "hy",
            "hz",
          ];
          for (const f of fields) {
            const h = api.sliderRow(
              sec,
              f,
              -Math.PI,
              Math.PI,
              0.01,
              p[f],
              (v) => {
                p[f] = v;
                anchorsDirty = true;
                if (mirror) {
                  const other = side === "L" ? active.R : active.L;
                  other[f] = v;
                  sliderHandles.get(`${side === "L" ? "R" : "L"}.${f}`)?.set(v);
                }
              },
            );
            sliderHandles.set(`${side}.${f}`, h);
          }
        };
        if (mirror) addSide(`Arm Pose · ${active.label}`, "L", active.L);
        else {
          addSide(`Left Arm · ${active.label}`, "L", active.L);
          addSide(`Right Arm · ${active.label}`, "R", active.R);
        }

        const exportSec = api.section(panel, "Export");
        const dump = () =>
          states.length > 1
            ? Object.fromEntries(states.map((s) => [s.key, exportPayload(s)]))
            : exportPayload(active);
        api.button(exportSec, "Export", () => {
          const full = dump();
          exportStr = JSON.stringify(full);
          console.log(`${spec.kind} pose:\n` + JSON.stringify(full, null, 2));
        });
        api.button(exportSec, "copy", () => {
          const text = JSON.stringify(dump(), null, 2);
          exportStr = "copied";
          void navigator.clipboard?.writeText(text).catch(() => {
            console.log(text); // clipboard is origin-gated; the log always works
          });
        });

        const toolSec = api.section(panel, `Prop Transform · ${active.label}`);
        const toolFields: [keyof ToolXf, string, number, number][] = [
          ["px", "pos x", -2, 2],
          ["py", "pos y", -2, 2],
          ["pz", "pos z", -2, 2],
          ["rx", "rot x", -Math.PI, Math.PI],
          ["ry", "rot y", -Math.PI, Math.PI],
          ["rz", "rot z", -Math.PI, Math.PI],
        ];
        for (const [key, label, min, max] of toolFields) {
          const h = api.sliderRow(
            toolSec,
            label,
            min,
            max,
            0.01,
            active.tool[key],
            (v) => {
              active.tool[key] = v;
              anchorsDirty = true;
            },
          );
          toolSliderHandles.set(key, h);
        }

        const note = document.createElement("div");
        note.className = "hint";
        note.textContent =
          "opens on the pose that ships (diverRig's GRIPS) — edit it and " +
          '"Export"/"copy" the block back into diverRig.ts. "shipped" puts ' +
          'this state back. "snap to paw" drops the prop into the hand ' +
          "bone's own frame wherever this arm pose left it — rotate from there" +
          (states.length > 1
            ? '. The state tabs are the grip\'s animation states; "play" walks ' +
              "them through the rig's own blend, prop on the paw anchor"
            : "") +
          '. "mirror L/R" keeps both arms symmetric. "gizmo select" shows ' +
          "clickable handles at each joint and the prop — T=translate, " +
          "R=rotate (prop only), X/Y/Z=lock axis, ESC=deselect. " +
          "Click any slider's number to type an exact value.";
        panel.appendChild(note);
      }
      renderPanel();
    },
    // Fixed row set: the HUD binds these by index when the model mounts.
    lines: () => [
      ["state", playing ? `${from.label} → ${to.label}` : active.label],
      ["blend", playing ? phaseU.toFixed(2) : "—"],
      [
        "gizmo",
        gizmoOn && selected
          ? `${selected.kind}${selected.kind === "tool" ? ` (${toolMode})` : ""}${constrainAxis ? ` [${constrainAxis.toUpperCase()}]` : ""}`
          : "—",
      ],
      ["export", exportStr],
    ],
  };
}

// Fade a prop clone down to a hint of itself (the belt ghost) and snuff any
// light it carries — a holster marker must not relight the scene. Materials
// are cloned first: the real prop shares them.
function dimProp(root: THREE.Object3D): void {
  root.traverse((o) => {
    const light = o as THREE.Light;
    if (light.isLight) light.visible = false;
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    m.material = mats.map((mat) => {
      const c = mat.clone();
      c.transparent = true;
      c.opacity = 0.3;
      c.depthWrite = false;
      return c;
    });
  });
}

// --- Model: the light stick ------------------------------------------------
// Prop: static mesh, no rig. Test the scale-fit (the "length" slider is the
// LIGHT_STICK_LENGTH knob, live) and the burn.
function buildLightStick(gltf: GLTF | null): BenchInstance {
  const stick = createLightStickVisual(
    gltf ? prepareLightStickTemplate(gltf) : null,
  );
  let held = false;
  let length = LIGHT_STICK_LENGTH;

  // Diver stand-in at the carry offset, to read the baton against a body.
  const stand = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.6, 0.7, 6, 12),
    toonMaterial({ color: 0x2b4756, transparent: true, opacity: 0.5 }),
  );
  stand.position.set(0, CARGO.HOLD_DOWN, CARGO.HOLD_FORWARD);
  stand.visible = false;
  stick.group.add(stand);

  return {
    group: stick.group,
    update(_dt: number, t: number) {
      stick.update(t, held);
    },
    ui(panel: HTMLElement, api: BenchUiApi) {
      const parts = api.section(panel, "Haul");
      api.button(parts, "held", (b) => {
        held = !held;
        stand.visible = held;
        b.classList.toggle("on", held);
      });
      api
        .button(parts, "lit", (b) => {
          stick.setLit(!stick.isLit());
          b.classList.toggle("on", stick.isLit());
        })
        .classList.toggle("on", stick.isLit());

      const size = api.section(panel, "Size");
      api.sliderRow(size, "length", 0.15, 1, 0.01, length, (v) => {
        length = v;
        stick.setLength(v);
      });

      const note = document.createElement("div");
      note.className = "hint";
      note.textContent =
        `light stick length ${LIGHT_STICK_LENGTH} u — a rat diver is ~1.3 u ` +
        'tall, and the driller is 0.8. "length" is that constant, live: park ' +
        "it where the baton reads as one paw's worth and paste the number " +
        'into LIGHT_STICK_LENGTH. "lit" strikes or snuffs the burn — the tip ' +
        "mesh is unlit and carries the point light, so the cel ramp can never " +
        'blow it out. Pose the diver around it in "light stick poses".';
      panel.appendChild(note);
    },
    action() {
      stick.setLit(!stick.isLit());
    },
    lines: () => [
      ["held", held ? "yes" : "no"],
      ["vial", stick.vial ? "found" : "MISSING"],
      ["length", `${length.toFixed(2)} u`],
      ["burn", stick.burn().toFixed(2)],
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
  {
    id: "driller",
    label: "driller",
    url: `${BASE}models/drill_tool.glb`,
    cam: { dist: 3, height: 0, gridY: -1 },
    build: buildDriller,
  },
  {
    id: "light-stick",
    label: "light stick",
    url: `${BASE}models/light_stick.glb`,
    cam: { dist: 1.6, height: 0, gridY: -0.6 },
    build: buildLightStick,
  },
  {
    id: "driller-pose",
    label: "driller hold pose",
    url: `${BASE}models/ratdiverAbyssalGouda.glb`,
    cam: { dist: 3, height: -0.3, gridY: -1.6 },
    build: (gltf) =>
      buildPoseEditor(gltf!, {
        id: "driller-pose",
        kind: "driller",
        makeProp: () => createDrillerVisual(),
      }),
  },
  {
    id: "stick-pose",
    label: "light stick poses",
    url: `${BASE}models/ratdiverAbyssalGouda.glb`,
    cam: { dist: 3, height: -0.3, gridY: -1.6 },
    build: (gltf) =>
      buildPoseEditor(gltf!, {
        id: "stick-pose",
        kind: "lightStick",
        // No light: a lamp this close would put every band of the diver on
        // white, and this bench is about where the paws are.
        makeProp: () => {
          const stick = createLightStickVisual();
          stick.setLightOn(false);
          return stick;
        },
        open: "hold",
        // The throw cycle: reach to the belt, carry it, whip it away, and
        // (after the paw comes back empty) reach for the next one.
        play: [
          ["grab", 0.35],
          ["hold", 1.1],
          ["throw", 0.5],
        ],
        ghost: "grab",
      }),
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

// Deep-link camera, for headless capture and for linking someone a view:
// ?yaw= swings the default vantage about the model (degrees, + = leftward),
// ?dist= scales how far back it sits, ?spin=0 stops the idle orbit so two
// shots of the same URL frame the same thing.
const QUERY = new URLSearchParams(location.search);
const qNum = (k: string) => {
  const v = Number(QUERY.get(k));
  return QUERY.has(k) && Number.isFinite(v) ? v : null;
};
const CAM_UP = new THREE.Vector3(0, 1, 0);

function frameCamera(cam: BenchCamSpec) {
  camera.fov = 52;
  camera.updateProjectionMatrix();
  const dist = qNum("dist") ?? cam.dist;
  const eye = new THREE.Vector3(dist, 0, dist * 1.25);
  eye.applyAxisAngle(CAM_UP, ((qNum("yaw") ?? 0) * Math.PI) / 180);
  camera.position.set(eye.x, cam.height + dist * 0.45, eye.z);
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
spin = qNum("spin") !== 0;
toggle("spin", (on) => (spin = on), spin);
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
