// Unit tests for the binary state codec — run with: node tools/test-protocol.mjs
// (node ≥ 23.6 / 22.18 strips the .ts types natively — no build step needed)
import {
  encodeState,
  decodeState,
  seqNewer,
  wrapAngle,
  STATE_PACKET_BYTES,
} from "../src/net/protocol.ts";

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`✗ ${name}`);
  } else {
    console.log(`✓ ${name}`);
  }
}
const close = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

// --- Roundtrip ---
const state = {
  x: -123.456,
  y: 42.5,
  z: 388.25,
  yaw: 1.234,
  pitch: -0.789,
  sy: 0.5,
  sp: -0.25,
  light: true,
  status: 0b0101,
};
const buf = encodeState(state, 7);
check("packet is 24 bytes", buf.byteLength === STATE_PACKET_BYTES);
const d = decodeState(buf);
check("decodes", d !== null);
check("seq", d!.seq === 7);
check("light", d!.light === true);
check("status", d!.status === 0b0101);
check("x (f32)", close(d!.x, state.x, 1e-2));
check("y (f32)", close(d!.y, state.y, 1e-2));
check("z (f32)", close(d!.z, state.z, 1e-2));
check("yaw quantized", close(d!.yaw, state.yaw));
check("pitch quantized", close(d!.pitch, state.pitch));
check("sy quantized", close(d!.sy, state.sy));
check("sp quantized", close(d!.sp, state.sp));

// --- Yaw accumulates unbounded in input.js: must wrap cleanly ---
const spun = decodeState(encodeState({ ...state, yaw: 10 * Math.PI + 0.3 }, 1));
check("unbounded yaw wraps to ±π", close(spun!.yaw, wrapAngle(0.3)));
const negSpun = decodeState(encodeState({ ...state, yaw: -7 * Math.PI }, 2));
check("negative spins wrap", close(Math.abs(negSpun!.yaw), Math.PI, 1e-2));

// --- Light off / empty status ---
const dark = decodeState(encodeState({ ...state, light: false, status: 0 }, 3));
check("light off", dark!.light === false && dark!.status === 0);
// Status must never clobber the light bit.
const full = decodeState(
  encodeState({ ...state, light: false, status: 0x7f }, 4),
);
check(
  "status 0x7f keeps light off",
  full!.light === false && full!.status === 0x7f,
);

// --- decodeState accepts views (binarypack may hand back Uint8Array) ---
const asView = new Uint8Array(buf);
check("decodes Uint8Array views", decodeState(asView)?.seq === 7);
const offsetView = new Uint8Array(buf.byteLength + 8);
offsetView.set(new Uint8Array(buf), 8);
check(
  "decodes views at non-zero offset",
  decodeState(offsetView.subarray(8))?.seq === 7,
);

// --- Garbage rejected ---
check("short buffer rejected", decodeState(new ArrayBuffer(10)) === null);
const wrongType = new Uint8Array(STATE_PACKET_BYTES);
wrongType[0] = 9;
check("unknown type rejected", decodeState(wrongType) === null);

// --- Sequence wraparound ---
check("2 newer than 1", seqNewer(2, 1));
check("1 not newer than 2", !seqNewer(1, 2));
check("equal is not newer", !seqNewer(5, 5));
check("wrap: 3 newer than 65530", seqNewer(3, 65530));
check("wrap: 65530 not newer than 3", !seqNewer(65530, 3));

if (failures) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll protocol tests passed.");
