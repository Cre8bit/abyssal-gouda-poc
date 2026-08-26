#!/usr/bin/env node
// runner.mjs — screenshot runner. Sits idle until Claude writes
// shots/request.json, then drives a headless Chrome over the named vantage
// points and writes the PNGs plus shots/status.json.
//
// Run it in its own terminal tab:  npm run runner
// Stop it with Ctrl+C. Nothing is installed; one headless Chrome stays warm
// across runs (DevTools endpoint on 127.0.0.1, ephemeral port) and each shot
// is a fresh tab — no per-shot browser cold start. The browser is released
// after SHOT_IDLE_MS without a request and relaunched on demand.
//
// request.json: { "shots": [<entry>, ...] } where an entry is either a shot
// name ("fp-down-60") or { "name": "fp-down-60", "params": { "pitch": -1.2 } }
// — params become extra query-string overrides (see src/shots.js).
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
const BASE = process.env.SHOT_URL ?? "http://localhost:5173";
const SIZE = process.env.SHOT_SIZE ?? "1440,810";
const BUDGET = Number(process.env.SHOT_BUDGET ?? 30000); // max ms per shot
const SEED = process.env.SHOT_SEED ?? "7"; // same labyrinth every run
const CONCURRENCY = Math.max(1, Number(process.env.SHOT_CONCURRENCY ?? 3));
const IDLE_MS = Number(process.env.SHOT_IDLE_MS ?? 120000);
const POLL = 1000;

const [WIDTH, HEIGHT] = SIZE.split(",").map(Number);

// Lines worth handing back: page errors, and anything about shaders or GL.
const INTERESTING =
  /error|Uncaught|Unhandled|THREE\.|shader|GL ERROR|ERR_CONNECTION|net::/i;

function shotUrl(entry) {
  const name = typeof entry === "string" ? entry : entry.name;
  const q = new URLSearchParams({ shot: name, seed: SEED });
  if (typeof entry === "object" && entry.params) {
    for (const [k, v] of Object.entries(entry.params)) q.set(k, String(v));
  }
  return { name, url: `${BASE}/?${q.toString()}`, file: fileName(entry) };
}

// Parameterized variants of the same shot get distinct filenames.
function fileName(entry) {
  if (typeof entry === "string") return entry;
  const parts = Object.entries(entry.params ?? {}).map(
    ([k, v]) => `${k}${String(v).replace(/[^\w.-]+/g, "_")}`,
  );
  return [entry.name, ...parts].join("_");
}

// --- minimal DevTools-protocol client over Node's built-in WebSocket -------

class CDP {
  #id = 0;
  #pending = new Map();
  #listeners = new Set();

  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else {
        for (const fn of this.#listeners) fn(msg);
      }
    });
    ws.addEventListener("close", () => {
      for (const p of this.#pending.values())
        p.reject(new Error("browser disconnected"));
      this.#pending.clear();
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new CDP(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot reach ${url}`)), {
        once: true,
      });
    });
  }

  get open() {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  onEvent(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
}

// Resolves true when the event arrives, false on wall-clock timeout.
function waitForEvent(cdp, sessionId, method, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, timeoutMs);
    const off = cdp.onEvent((msg) => {
      if (msg.sessionId === sessionId && msg.method === method) {
        clearTimeout(timer);
        off();
        resolve(true);
      }
    });
  });
}

// --- warm browser lifecycle -------------------------------------------------

let browser = null; // { proc, cdp }
let lastUse = 0;

async function launchBrowser() {
  const proc = spawn(CHROME, [
    "--headless=new",
    "--no-sandbox",
    "--hide-scrollbars",
    "--mute-audio",
    "--enable-unsafe-swiftshader", // software WebGL, so no GPU is needed
    `--window-size=${SIZE}`,
    "--remote-debugging-port=0",
    "about:blank",
  ]);
  const wsUrl = await new Promise((resolve, reject) => {
    let err = "";
    const onData = (d) => {
      err += d;
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        proc.stderr.off("data", onData);
        resolve(m[1]);
      }
    };
    proc.stderr.on("data", onData);
    proc.on("error", (e) => reject(new Error(`spawn failed: ${e.message}`)));
    proc.on("exit", (code) =>
      reject(
        new Error(
          `Chrome exited (${code}): ${err.split("\n").filter(Boolean).slice(-4).join(" | ")}`,
        ),
      ),
    );
    setTimeout(() => reject(new Error("timed out waiting for DevTools endpoint")), 15000);
  });
  const cdp = await CDP.connect(wsUrl);
  const b = { proc, cdp };
  proc.on("exit", () => {
    if (browser === b) browser = null;
  });
  return b;
}

async function ensureBrowser() {
  if (!browser || !browser.cdp.open) {
    browser?.proc.kill();
    browser = await launchBrowser();
    console.log("  browser launched");
  }
  lastUse = Date.now();
  return browser;
}

function killBrowser(reason) {
  if (!browser) return;
  browser.proc.kill();
  browser = null;
  if (reason) console.log(`  browser released (${reason})`);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    killBrowser();
    process.exit(0);
  });
}
process.on("exit", () => killBrowser());

// --- capture ----------------------------------------------------------------

// One shot = one fresh tab in the warm browser: navigate, wait for shot mode
// to raise window.__shotReady (world built, pose applied, a few frames
// rendered — see src/shots.js), screenshot, close the tab. Page console and
// errors are collected per tab via CDP events. BUDGET caps the whole wait.
async function captureShot(cdp, url, file) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const lines = [];
  const off = cdp.onEvent((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args
        .map((a) => a.value ?? a.description ?? a.type)
        .join(" ");
      lines.push(`console.${msg.params.type}: ${text}`);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      lines.push(`Uncaught: ${d.exception?.description ?? d.text}`);
    } else if (msg.method === "Log.entryAdded") {
      const e = msg.params.entry;
      lines.push(`${e.source}.${e.level}: ${e.text}`);
    }
  });
  try {
    await Promise.all([
      cdp.send("Page.enable", {}, sessionId),
      cdp.send("Runtime.enable", {}, sessionId),
      cdp.send("Log.enable", {}, sessionId),
      cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false },
        sessionId,
      ),
    ]);
    const loaded = waitForEvent(cdp, sessionId, "Page.loadEventFired", BUDGET);
    await cdp.send("Page.navigate", { url }, sessionId);
    await loaded;
    const ready = await cdp
      .send(
        "Runtime.evaluate",
        {
          expression: `new Promise((res) => {
            const t0 = performance.now();
            (function poll() {
              if (window.__shotReady) return res(true);
              if (performance.now() - t0 > ${BUDGET}) return res(false);
              setTimeout(poll, 100);
            })();
          })`,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      )
      .catch((e) => ({ error: e.message }));
    if (ready?.result?.value !== true)
      lines.push(
        `runner: shot never signalled ready (${ready?.error ?? "timed out"}); captured anyway`,
      );
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
    await writeFile(file, Buffer.from(data, "base64"));
    return lines;
  } finally {
    off();
    cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

async function processRun(shots) {
  const { cdp } = await ensureBrowser();
  const results = new Array(shots.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, shots.length) },
    async () => {
      while (next < shots.length) {
        const i = next++;
        const { name, url, file: base } = shotUrl(shots[i]);
        const file = path.join(SHOTS, `${base}.png`);
        await rm(file, { force: true });
        let lines = [];
        try {
          lines = await captureShot(cdp, url, file);
        } catch (e) {
          lines.push(`runner: ${e.message}`);
        }
        const ok = existsSync(file);
        // On success, keep only the interesting lines. On failure, hand back
        // the tail too — a silent failure is the one outcome that wastes time.
        const kept = ok
          ? lines.filter((l) => INTERESTING.test(l))
          : lines.slice(-8);
        results[i] = {
          file: { name, file: path.relative(ROOT, file), ok },
          log: kept.length ? { shot: base, ok, lines: kept.slice(0, 15) } : null,
        };
        console.log(`  ${ok ? "✔" : "✘"} ${base}`);
      }
    },
  );
  await Promise.all(workers);
  lastUse = Date.now();
  return results;
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

console.log(`runner ready · ${BASE} · waiting for shots/request.json`);
console.log("Ctrl+C to stop.\n");

for (;;) {
  if (existsSync(REQUEST)) {
    let shots;
    try {
      shots = JSON.parse(await readFile(REQUEST, "utf8")).shots ?? [];
    } catch (e) {
      await rm(REQUEST, { force: true });
      await writeStatus({
        run,
        state: "done",
        error: `bad request: ${e.message}`,
      });
      continue;
    }
    await rm(REQUEST, { force: true });

    run++;
    await writeStatus({ run, state: "capturing", shots });
    console.log(`run ${run}: ${shots.map((s) => fileName(s)).join(", ")}`);

    let results;
    try {
      results = await processRun(shots);
    } catch (e) {
      killBrowser("run failed");
      await writeStatus({ run, state: "done", error: e.message });
      console.log(`run ${run} failed: ${e.message}\n`);
      continue;
    }
    const files = results.map((r) => r.file);
    const logs = results.map((r) => r.log).filter(Boolean);

    await writeStatus({ run, state: "done", files, logs });
    console.log(`run ${run} done\n`);
  } else if (browser && Date.now() - lastUse > IDLE_MS) {
    killBrowser("idle");
  }
  await sleep(POLL);
}
