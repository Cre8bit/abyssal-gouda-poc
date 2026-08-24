#!/usr/bin/env node
// angler-harness.mjs — runs the Lanternmaw's rig and state machine outside the
// browser, with no renderer, so the parts that are easy to get silently wrong
// can be checked as numbers instead of squinted at in a screenshot:
//
//   · every bone name in angler.js actually exists in the GLB
//   · the auto-probed jaw direction really opens the mouth downward
//   · the maw volume tracks the animation instead of sitting inside the skull
//   · lurk → stalk → reveal → lunge → snap → sound runs in order and on time
//   · a diver swimming at the lure gets eaten; one on the bell does not
//
// Run with:  node tools/angler-harness.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- Browser shims --------------------------------------------------------
// GLTFLoader wants `self` and an image decoder; angler.js wants a canvas for
// the lure's halo gradient. None of it affects the geometry under test.
globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
globalThis.ProgressEvent ??= class ProgressEvent {
  constructor(type, init = {}) {
    Object.assign(this, { type }, init);
  }
};
globalThis.document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      createRadialGradient: () => ({ addColorStop() {} }),
      fillRect() {},
      set fillStyle(_) {},
    }),
  }),
};

// The module reads its model URL from import.meta.env, which only exists under
// Vite — serve the repo over http and rewrite that one expression.
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/public/`;

const shimmed = path.join(ROOT, "tools", ".angler.harness.mjs");
fs.writeFileSync(
  shimmed,
  fs
    .readFileSync(path.join(ROOT, "src", "angler.js"), "utf8")
    .replace("import.meta.env.BASE_URL", JSON.stringify(base)),
);

const THREE = await import("three");
const { createAngler, ANGLER_LENGTH, NOTICE_RANGE, REVEAL_RANGE } = await import(
  `./${path.basename(shimmed)}`
);

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

const scene = new THREE.Scene();
const angler = createAngler(scene);
const noise = { noise: (a, b, c) => Math.sin(a * 3.1 + b * 1.7 + c) * 0.5 };

// createAngler loads the GLB asynchronously; give it a moment to land.
await new Promise((r) => setTimeout(r, 2500));

const skinned = scene.getObjectByProperty("isSkinnedMesh", true);
check("model loaded", !!skinned);
if (!skinned) process.exit(1);

// --- 1. The rig ------------------------------------------------------------
console.log("\nrig");
const bones = new Map();
scene.traverse((o) => o.isBone && bones.set(o.name, o));
check("54 joints present", bones.size === 54, `got ${bones.size}`);
check("esca bulb", bones.has("foreheadL014"));
check("jaw hinge", bones.has("jaw") && bones.has("chin001"));
check("illicium is 11 bones", [...bones.keys()].filter((n) => /^foreheadL0(0[4-9]|1[0-4])$/.test(n)).length === 11);
scene.updateMatrixWorld(true);
const worldScale = skinned.getWorldScale(new THREE.Vector3()).x;
check("model is ~46 m", Math.abs(worldScale - ANGLER_LENGTH) < 0.01, `${worldScale.toFixed(2)} m`);

// --- 2. Does the mouth actually open? -------------------------------------
console.log("\njaw");
angler.spawn(new THREE.Vector3(0, 0, 0));
const chin = bones.get("chin001");

const sample = (divers, steps, dt = 1 / 60) => {
  for (let i = 0; i < steps; i++) {
    angler.update(dt, i * dt, noise, { divers, onSwallow: (id) => eaten.add(id), onEvent: (k) => beats.push(k) });
  }
  scene.updateMatrixWorld(true);
};
const eaten = new Set();
const beats = [];

// Closed: hold it lurking, far from anyone.
sample([], 30);
const closedY = chin.getWorldPosition(new THREE.Vector3()).y - angler.position.y;
const closedMaw = angler.mawPosition(new THREE.Vector3()).clone();

// Open: park it mid-reveal by walking a diver in.
const bait = { id: "bait", x: 0, y: 0, z: 0, out: false };
const drive = (dist) => {
  const dir = new THREE.Vector3(
    Math.sin(angler.group.rotation.y),
    0,
    Math.cos(angler.group.rotation.y),
  );
  bait.x = angler.position.x + dir.x * dist;
  bait.y = angler.position.y;
  bait.z = angler.position.z + dir.z * dist;
  bait.out = false;
};

drive(REVEAL_RANGE * 0.8);
for (let i = 0; i < 40; i++) {
  drive(REVEAL_RANGE * 0.8);
  angler.update(1 / 60, 10 + i / 60, noise, { divers: [bait], onSwallow: () => {}, onEvent: () => {} });
}
scene.updateMatrixWorld(true);
const openY = chin.getWorldPosition(new THREE.Vector3()).y - angler.position.y;
const openMaw = angler.mawPosition(new THREE.Vector3()).clone();

check("jaw drops when it gapes", openY < closedY - 0.5, `${closedY.toFixed(2)} m → ${openY.toFixed(2)} m`);
check(
  "maw volume follows the animation",
  openMaw.distanceTo(closedMaw) > 0.5,
  `moved ${openMaw.distanceTo(closedMaw).toFixed(2)} m`,
);
check(
  "maw sits ahead of the body, not inside it",
  openMaw.distanceTo(angler.position) > ANGLER_LENGTH * 0.15,
  `${openMaw.distanceTo(angler.position).toFixed(1)} m from centre`,
);

// --- 3. The attack ---------------------------------------------------------
console.log("\nattack");
// Park it 90 m out and pointed at the origin — a real spawn is 110-180 m away
// and the swim alone would eat most of the test budget.
angler.place({ x: 0, y: 0, z: 0 }, 0, 90, "lurk");
beats.length = 0;
eaten.clear();
check("starts as a decoy", angler.isDecoy());

const swimmer = { id: "diver", x: 0, y: 0, z: 0, out: false };
const rider = { id: "rider", x: 0, y: 0, z: 0, out: true }; // hooked to the bell
let t = 0;
let sawHunting = false;
for (let i = 0; i < 60 * 45 && !eaten.has("diver"); i++) {
  t += 1 / 60;
  // The diver does exactly what the lure is asking: swims straight at it.
  const lure = angler.lurePosition();
  const d = new THREE.Vector3(lure.x - swimmer.x, lure.y - swimmer.y, lure.z - swimmer.z);
  const len = d.length() || 1;
  if (len > 3) d.multiplyScalar(4.5 / len / 60);
  else d.set(0, 0, 0);
  swimmer.x += d.x;
  swimmer.y += d.y;
  swimmer.z += d.z;
  rider.x = swimmer.x;
  rider.y = swimmer.y;
  rider.z = swimmer.z; // same spot, but marked safe
  angler.update(1 / 60, t, noise, {
    divers: [swimmer, rider],
    onSwallow: (id) => eaten.add(id),
    onEvent: (k) => beats.push(k),
  });
  if (angler.isHunting()) sawHunting = true;
}

check("the beats fire in order", beats.join(">") === "notice>reveal>lunge", beats.join(" > "));
check("the face is revealed before the bite", sawHunting);
check("it swallows the diver who took the bait", eaten.has("diver"), `after ${t.toFixed(1)}s`);
check("a diver on the bell is never taken", !eaten.has("rider"));
check("the disguise drops once it commits", !angler.isDecoy());

// --- 4. Network playback ---------------------------------------------------
console.log("\nnetwork");
const wire = angler.netState();
check("pose is 9 numbers", wire.length === 9 && wire.every(Number.isFinite), JSON.stringify(wire));

const client = createAngler(new THREE.Scene());
client.applyNet(wire);
for (let i = 0; i < 90; i++) client.update(1 / 60, i / 60, noise, {});
check("a client is remote and never simulates", client.isRemote());
check(
  "a client converges on the host's position",
  client.position.distanceTo(angler.position) < 1,
  `${client.position.distanceTo(angler.position).toFixed(2)} m apart`,
);

try {
  fs.rmSync(shimmed, { force: true });
} catch {
  /* read-only mounts (CI, containers) — the file is gitignored either way */
}
server.close();
console.log(`\n${failures ? `${failures} FAILED` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
