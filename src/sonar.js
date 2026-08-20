// sonar.js — every sound in the game, synthesised at runtime from oscillators
// and noise buffers. Nothing is downloaded.

let ctx = null;
let master = null;
let drone = null;
let ambience = null;
let ambienceFilter = null;
let noiseBuffer = null;
let droneDepth = -1;

const PING_REF = 22; // metres at which the ping is half as loud

export function initSonar() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  noiseBuffer = makeNoiseBuffer();
  startDrone();
  startAmbience();
  ctx.resume();
}

// Four seconds of white noise, looped and filtered into everything watery.
function makeNoiseBuffer() {
  const length = ctx.sampleRate * 4;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function noiseSource(loop = false) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = loop;
  return src;
}

// --- Beds -----------------------------------------------------------------

// Pressure hum: three detuned saws crushed by a lowpass, each on its own LFO.
function startDrone() {
  const gain = ctx.createGain();
  gain.gain.value = 0.02;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 170;
  filter.Q.value = 3;
  filter.connect(gain);
  gain.connect(master);

  [36, 41.5, 55].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05 + i * 0.031;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 2.5;
    lfo.connect(lfoDepth).connect(osc.detune);
    lfo.start();

    osc.connect(filter);
    osc.start();
  });

  drone = gain;
}

// Moving water: looped noise under a slow filter sweep, kept very low.
function startAmbience() {
  const gain = ctx.createGain();
  gain.gain.value = 0.055;

  ambienceFilter = ctx.createBiquadFilter();
  ambienceFilter.type = "lowpass";
  ambienceFilter.frequency.value = 240;
  ambienceFilter.Q.value = 0.7;

  const sweep = ctx.createOscillator();
  sweep.frequency.value = 0.037;
  const sweepDepth = ctx.createGain();
  sweepDepth.gain.value = 90;
  sweep.connect(sweepDepth).connect(ambienceFilter.frequency);
  sweep.start();

  const src = noiseSource(true);
  src.connect(ambienceFilter).connect(gain).connect(master);
  src.start();

  ambience = gain;
}

// Louder and murkier the deeper you are — the abyss pressing in.
export function setDroneDepth(dread) {
  if (!drone || Math.abs(dread - droneDepth) < 0.01) return;
  droneDepth = dread;
  drone.gain.setTargetAtTime(0.02 + dread * 0.09, ctx.currentTime, 2);
  ambience.gain.setTargetAtTime(0.055 + dread * 0.03, ctx.currentTime, 2);
}

// --- The bell -------------------------------------------------------------

// `dist` in metres and `pan` in [-1, 1]: full volume at the hull, fading and
// growing muffled with distance, which is what makes it usable as a bearing.
export function playPing(dist = 0, pan = 0) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const level = PING_REF / (PING_REF + dist);
  if (level < 0.02) return;

  const bus = ctx.createStereoPanner();
  bus.pan.value = Math.max(-1, Math.min(1, pan));

  // Water eats the high end first, so distance reads as muffling too.
  const muffle = ctx.createBiquadFilter();
  muffle.type = "lowpass";
  muffle.frequency.value = 200 + 700 * level;
  muffle.Q.value = 1;
  bus.connect(muffle).connect(master);

  for (const [delay, amp, freq] of [
    [0, 0.42, 260],
    [0.31, 0.17, 232],
    [0.68, 0.07, 208],
  ]) {
    pingVoice(bus, now + delay, amp * level, freq);
  }
  subThump(bus, now, 0.4 * level);
}

function pingVoice(bus, at, amp, freq) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, at);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.62, at + 0.55);

  const shape = ctx.createBiquadFilter();
  shape.type = "lowpass";
  shape.frequency.value = 480;
  shape.Q.value = 6;

  osc.connect(shape).connect(envelope(at, amp, 0.012, 0.95)).connect(bus);
  osc.start(at);
  osc.stop(at + 1);
}

// Sub-bass thud under the ping — the part that reads as dread.
function subThump(bus, at, amp) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(64, at);
  osc.frequency.exponentialRampToValueAtTime(28, at + 0.5);
  osc.connect(envelope(at, amp, 0.02, 0.7)).connect(bus);
  osc.start(at);
  osc.stop(at + 0.75);
}

// The bell falling: water rush over a groaning cable, then the hull slamming
// to a stop at the bottom.
export function playDescent(duration) {
  if (!ctx) return;
  const at = ctx.currentTime;

  const rush = ctx.createBiquadFilter();
  rush.type = "lowpass";
  rush.frequency.setValueAtTime(180, at);
  rush.frequency.linearRampToValueAtTime(900, at + duration * 0.8);
  rush.frequency.linearRampToValueAtTime(240, at + duration);
  rush.Q.value = 1.5;

  const src = noiseSource();
  const swell = ctx.createGain();
  swell.gain.setValueAtTime(0.0001, at);
  swell.gain.exponentialRampToValueAtTime(0.24, at + duration * 0.7);
  swell.gain.exponentialRampToValueAtTime(0.0001, at + duration + 0.25);
  src.connect(rush).connect(swell).connect(master);
  src.start(at);
  src.stop(at + duration + 0.3);

  // Cable groan sliding down under the rush.
  const groan = ctx.createOscillator();
  groan.type = "sawtooth";
  groan.frequency.setValueAtTime(78, at);
  groan.frequency.exponentialRampToValueAtTime(34, at + duration);
  const groanShape = ctx.createBiquadFilter();
  groanShape.type = "lowpass";
  groanShape.frequency.value = 260;
  groanShape.Q.value = 4;
  groan
    .connect(groanShape)
    .connect(envelope(at, 0.16, duration * 0.5, duration + 0.2))
    .connect(master);
  groan.start(at);
  groan.stop(at + duration + 0.3);

  playImpact(at + duration);
}

// The dead stop: a struck-hull clang with a short filtered noise slap.
function playImpact(at) {
  const clang = ctx.createOscillator();
  clang.type = "triangle";
  clang.frequency.setValueAtTime(120, at);
  clang.frequency.exponentialRampToValueAtTime(46, at + 0.9);
  clang.connect(envelope(at, 0.4, 0.004, 1.2)).connect(master);
  clang.start(at);
  clang.stop(at + 1.3);

  const slap = noiseSource();
  const body = ctx.createBiquadFilter();
  body.type = "bandpass";
  body.frequency.value = 320;
  body.Q.value = 0.9;
  slap.connect(body).connect(envelope(at, 0.3, 0.003, 0.45)).connect(master);
  slap.start(at);
  slap.stop(at + 0.5);
}

// Distant metal shifting somewhere out in the dark.
export function playCreak() {
  if (!ctx) return;
  const at = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  const base = 40 + Math.random() * 55;
  osc.frequency.setValueAtTime(base, at);
  osc.frequency.linearRampToValueAtTime(base * (0.7 + Math.random() * 0.5), at + 1.8);

  const throat = ctx.createBiquadFilter();
  throat.type = "bandpass";
  throat.frequency.value = 140 + Math.random() * 160;
  throat.Q.value = 7;

  const pan = ctx.createStereoPanner();
  pan.pan.value = Math.random() * 2 - 1;

  osc
    .connect(throat)
    .connect(envelope(at, 0.1, 0.5, 2.0))
    .connect(pan)
    .connect(master);
  osc.start(at);
  osc.stop(at + 2.1);
}

// Attack/decay gain node — every voice here shares the same shape.
function envelope(at, amp, attack, release) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(Math.max(amp, 0.0002), at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + release);
  return gain;
}
