#!/usr/bin/env node
// runner.mjs — screenshot runner. Sits idle until Claude writes
// shots/request.json, then drives a headless Chrome over the named vantage
// points and writes the PNGs plus shots/status.json.
//
// Run it in its own terminal tab:  npm run runner
// Stop it with Ctrl+C. Nothing is installed and nothing listens on a port.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHOTS = path.join(ROOT, "shots");
const REQUEST = path.join(SHOTS, "request.json");
const STATUS = path.join(SHOTS, "status.json");

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SIZE = process.env.SHOT_SIZE ?? "1440,810";
const BUDGET = 6000; // ms of page time Chrome runs before it grabs the frame
const POLL = 1000;

// Vite steps to the next free port when another project already holds 5173, so
// a fixed guess can quietly screenshot somebody else's app instead — which looks
// exactly like a successful run. Find the port serving THIS game.
const MARKER = 'id="scene-container"';
async function findGame() {
  if (process.env.SHOT_URL) return process.env.SHOT_URL;
  for (let port = 5173; port <= 5180; port++) {
    const base = `http://localhost:${port}`;
    try {
      const html = await fetch(base, { signal: AbortSignal.timeout(1200) }).then((r) => r.text());
      if (html.includes(MARKER)) return base;
    } catch {
      /* nothing listening there */
    }
  }
  return null;
}

// Lines worth handing back: page errors, and anything about shaders or GL.
const INTERESTING =
  /CONSOLE|Uncaught|Unhandled|THREE\.|shader|GL ERROR|ERR_CONNECTION|net::/i;

function capture(name, base, file) {
  return new Promise((resolve) => {
    const proc = spawn(CHROME, [
      "--headless=new",
      "--no-sandbox",
      "--hide-scrollbars",
      "--mute-audio",
      "--enable-unsafe-swiftshader", // software WebGL, so no GPU is needed
      "--enable-logging=stderr",
      "--v=0",
      `--window-size=${SIZE}`,
      `--virtual-time-budget=${BUDGET}`,
      `--screenshot=${file}`,
      `${base}/?shot=${encodeURIComponent(name)}`,
    ]);
    let err = "";
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", (e) => resolve(`spawn failed: ${e.message}`));
    proc.on("close", () => resolve(err));
  });
}

// status.json is written LAST and in one go, so "run went up" can only ever
// mean every PNG is finished and closed.
async function writeStatus(payload) {
  await writeFile(STATUS, JSON.stringify(payload, null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let run = 0;
await mkdir(SHOTS, { recursive: true });
await writeStatus({ run, state: "idle" });

if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME}`);
  console.error("Set CHROME_PATH to override.");
  process.exit(1);
}

console.log(`runner ready · waiting for shots/request.json`);
console.log("Ctrl+C to stop.\n");

for (;;) {
  if (existsSync(REQUEST)) {
    let shots = [];
    try {
      shots = JSON.parse(await readFile(REQUEST, "utf8")).shots ?? [];
    } catch (e) {
      await rm(REQUEST, { force: true });
      await writeStatus({ run, state: "done", error: `bad request: ${e.message}` });
      continue;
    }
    await rm(REQUEST, { force: true });

    run++;
    const base = await findGame();
    if (!base) {
      await writeStatus({
        run,
        state: "done",
        error: "no dev server on 5173-5180 is serving this game — is `npm run dev` up?",
      });
      console.log(`run ${run}: no game found\n`);
      continue;
    }
    await writeStatus({ run, state: "capturing", base, shots });
    console.log(`run ${run} · ${base}: ${shots.join(", ")}`);

    const files = [];
    const logs = [];
    for (const name of shots) {
      const file = path.join(SHOTS, `${name}.png`);
      await rm(file, { force: true });
      const stderr = await capture(name, base, file);
      const ok = existsSync(file);
      files.push({ name, file: path.relative(ROOT, file), ok });
      // On success, keep only the interesting lines. On failure, hand back the
      // raw tail too — a silent failure is the one outcome that wastes time.
      const lines = ok
        ? stderr.split("\n").filter((l) => INTERESTING.test(l))
        : stderr.split("\n").filter(Boolean).slice(-8);
      if (lines.length) logs.push({ shot: name, ok, lines: lines.slice(0, 15) });
      console.log(`  ${ok ? "✔" : "✘"} ${name}`);
    }

    await writeStatus({ run, state: "done", files, logs });
    console.log(`run ${run} done\n`);
  }
  await sleep(POLL);
}
