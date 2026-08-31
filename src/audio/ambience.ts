// audio.js — procedural abyssal sound engine. ZERO assets: every sound is
// synthesized in Web Audio, so the game stays a tiny static bundle.
//
// The soundscape of oppressive depth:
//  - PRESSURE DRONE: two detuned sub-oscillators + filtered brown noise —
//    the weight of the water column. Swells as you sink into the labyrinth.
//  - REGULATOR BREATHING: an endless inhale-hiss / exhale-bubble cycle.
//    Quickens with effort. The exhale drives the visible bubble stream.
//  - HULL CREAKS & DISTANT MOANS: random far-off groans routed through a
//    feedback-delay cave reverb. The labyrinth is alive, and it's big.
//  - EVENTS: squelchy gouda digs, bubble bursts, catfish snaps, torch clicks.
//  - GLOBAL MUFFLE: one master low-pass — highs die underwater; it closes
//    down further the deeper you go.
//
// Everything is one static node graph + short-lived event nodes. CPU cost is
// negligible next to rendering, and nothing here touches the WebRTC voice
// path (voice.js keeps its own context and HRTF panners).

let ctx: AudioContext | null = null;
let master: GainNode,
  muffle: BiquadFilterNode,
  reverbSend: GainNode,
  reverbOut: GainNode;
let droneGain: GainNode, subGain: GainNode;
let breathBus: GainNode;
let noiseBuffer: AudioBuffer | null = null; // 2 s of white noise, shared by everything
let brownBuffer: AudioBuffer | null = null; // 2 s of brown noise — the low rumble bed

let breathTimer = 0;
let breathPeriod = 5.2;
let creakTimer = 8; // first creak comes early — set the tone
let ghostTimer = 6; // sparse tonal swells replace any constant drone note
let bedTime = 0;
let effortSm = 0;
let onExhale: (() => void) | null = null;

export function isAudioReady() {
  return ctx !== null;
}

export function setExhaleListener(fn: () => void) {
  onExhale = fn;
}

function makeNoise(color: "white" | "brown") {
  const len = ctx!.sampleRate * 2;
  const buf = ctx!.createBuffer(1, len, ctx!.sampleRate);
  const data = buf.getChannelData(0);
  if (color === "brown") {
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
  } else {
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  return buf;
}

function loopNoise(buffer: AudioBuffer) {
  const src = ctx!.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.start();
  return src;
}

// Must be called from a user gesture (click/keydown) — browsers require it.
// Idempotent: safe to call on every gesture.
export function initAbyssAudio() {
  if (ctx) {
    if (ctx.state === "suspended") ctx.resume();
    return;
  }
  ctx = new (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext
  )();

  // --- Master chain: everything → muffle low-pass → compressor → out.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 4;
  comp.connect(ctx.destination);

  muffle = ctx.createBiquadFilter();
  muffle.type = "lowpass";
  muffle.frequency.value = 2400;
  muffle.Q.value = 0.4;
  muffle.connect(comp);

  master = ctx.createGain();
  master.gain.value = 0.6;
  master.connect(muffle);

  // --- Cave reverb: a cheap feedback-delay loop, darkened each pass.
  reverbSend = ctx.createGain();
  reverbSend.gain.value = 1;
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.31;
  const fb = ctx.createGain();
  fb.gain.value = 0.52;
  const dark = ctx.createBiquadFilter();
  dark.type = "lowpass";
  dark.frequency.value = 850;
  reverbSend.connect(delay);
  delay.connect(dark);
  dark.connect(fb);
  fb.connect(delay);
  reverbOut = ctx.createGain();
  reverbOut.gain.value = 0.5;
  dark.connect(reverbOut);
  reverbOut.connect(master);

  noiseBuffer = makeNoise("white");
  brownBuffer = makeNoise("brown");

  // --- Water-mass bed: NO steady oscillators (constant tones read as an
  // engine room). Just deep filtered noise whose color and level breathe on
  // slow, incommensurate LFOs — the ocean shifting its weight. All tonal
  // content comes from the sparse GHOST TONES scheduled in update().
  droneGain = ctx.createGain();
  droneGain.gain.value = 0.05;
  droneGain.connect(master);

  const mass = loopNoise(brownBuffer);
  const massFilter = ctx.createBiquadFilter();
  massFilter.type = "lowpass";
  massFilter.frequency.value = 100;
  const massGain = ctx.createGain();
  massGain.gain.value = 0.6;
  mass.connect(massFilter);
  massFilter.connect(massGain);
  massGain.connect(droneGain);

  // The bed slowly opens and closes (filter) and swells and fades (gain).
  const bedLfo1 = ctx.createOscillator();
  bedLfo1.frequency.value = 0.023;
  const bedLfo1Gain = ctx.createGain();
  bedLfo1Gain.gain.value = 45;
  bedLfo1.connect(bedLfo1Gain);
  bedLfo1Gain.connect(massFilter.frequency);
  bedLfo1.start();
  const bedLfo2 = ctx.createOscillator();
  bedLfo2.frequency.value = 0.037;
  const bedLfo2Gain = ctx.createGain();
  bedLfo2Gain.gain.value = 0.18;
  bedLfo2.connect(bedLfo2Gain);
  bedLfo2Gain.connect(massGain.gain);
  bedLfo2.start();

  // Extra sub for the deep layers (gain driven by depth in update).
  subGain = ctx.createGain();
  subGain.gain.value = 0;
  subGain.connect(master);
  const sub = ctx.createOscillator();
  sub.type = "sine";
  sub.frequency.value = 28;
  sub.connect(subGain);
  sub.start();

  // --- Breathing bus (events are scheduled onto it). ---
  breathBus = ctx.createGain();
  breathBus.gain.value = 0.85;
  breathBus.connect(master);
}

// --- One-shot helpers ------------------------------------------------------

interface NoiseBurstOpts {
  duration: number;
  type?: BiquadFilterType;
  from: number;
  to: number;
  q?: number;
  gain: number;
  color?: "white" | "brown";
  dest?: AudioNode;
  reverb?: number;
  attack?: number;
}

function noiseBurst({
  duration,
  type = "bandpass",
  from,
  to,
  q = 1,
  gain,
  color = "white",
  dest = master,
  reverb = 0,
  attack = 0.01,
}: NoiseBurstOpts) {
  const t = ctx!.currentTime;
  const src = ctx!.createBufferSource();
  src.buffer = color === "brown" ? brownBuffer : noiseBuffer;
  src.loop = true;
  const f = ctx!.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + duration);
  const g = ctx!.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  src.connect(f);
  f.connect(g);
  g.connect(dest);
  if (reverb > 0) {
    const send = ctx!.createGain();
    send.gain.value = reverb;
    g.connect(send);
    send.connect(reverbSend);
  }
  src.start(t);
  src.stop(t + duration + 0.05);
}

interface ToneOpts {
  duration: number;
  type?: OscillatorType;
  from: number;
  to?: number;
  gain: number;
  dest?: AudioNode;
  reverb?: number;
  attack?: number;
  vibrato?: number;
}

function tone({
  duration,
  type = "sine",
  from,
  to = from,
  gain,
  dest = master,
  reverb = 0,
  attack = 0.02,
  vibrato = 0,
}: ToneOpts) {
  const t = ctx!.currentTime;
  const osc = ctx!.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + duration);
  const g = ctx!.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(g);
  g.connect(dest);
  if (reverb > 0) {
    const send = ctx!.createGain();
    send.gain.value = reverb;
    g.connect(send);
    send.connect(reverbSend);
  }
  if (vibrato > 0) {
    const lfo = ctx!.createOscillator();
    lfo.frequency.value = 3.3;
    const lg = ctx!.createGain();
    lg.gain.value = vibrato;
    lfo.connect(lg);
    lg.connect(osc.frequency);
    lfo.start(t);
    lfo.stop(t + duration + 0.05);
  }
  osc.start(t);
  osc.stop(t + duration + 0.05);
}

// --- The breathing cycle -----------------------------------------------------

function exhale(effort: number) {
  // Bubbles leaving the regulator: a descending gurgle plus a few rising
  // pitch-blips (individual bubbles breaking away).
  noiseBurst({
    duration: 1.05,
    from: 950,
    to: 320,
    q: 1.4,
    gain: 0.028 + effort * 0.02,
    dest: breathBus,
    attack: 0.05,
  });
  const nBlips = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < nBlips; i++) {
    setTimeout(
      () => {
        if (!ctx) return;
        const f0 = 500 + Math.random() * 700;
        tone({
          duration: 0.09,
          from: f0,
          to: f0 * 1.9,
          gain: 0.006 + Math.random() * 0.005,
          dest: breathBus,
          attack: 0.005,
        });
      },
      120 + i * (130 + Math.random() * 120),
    );
  }
  onExhale?.();
}

function inhale(effort: number) {
  noiseBurst({
    duration: 0.9,
    from: 400,
    to: 650,
    q: 1.1,
    gain: 0.012 + effort * 0.01,
    dest: breathBus,
    attack: 0.25,
  });
}

// --- Ghost tones: the mysterious replacement for a constant drone note. ---
// Every so often a single soft tone swells out of the dark over several
// seconds, drifts slightly flat, and dissolves into the cave reverb. Random
// pitch from a sparse low set — never a chord, never a rhythm, never long
// enough to read as machinery.
function ghostTone(depth01: number) {
  const set = [55, 69, 82, 98, 110, 147];
  const f0 =
    set[(Math.random() * set.length) | 0] * (0.99 + Math.random() * 0.02);
  tone({
    duration: 8 + Math.random() * 7,
    from: f0,
    to: f0 * (0.93 + Math.random() * 0.05),
    gain: 0.005 + depth01 * 0.006,
    reverb: 1.8,
    attack: 3.5,
    vibrato: Math.random() < 0.35 ? 1.2 : 0,
  });
}

// --- Random abyss voices ------------------------------------------------------

function distantVoice(depth01: number) {
  const roll = Math.random();
  if (roll < 0.45) {
    // Hull-creak: a strained metallic groan, close-ish. Pressure works on
    // the suit.
    const f0 = 70 + Math.random() * 60;
    tone({
      duration: 0.5 + Math.random() * 0.5,
      type: "sawtooth",
      from: f0,
      to: f0 * (0.7 + Math.random() * 0.2),
      gain: 0.008,
      reverb: 0.9,
      attack: 0.08,
      vibrato: 6,
    });
  } else if (roll < 0.8) {
    // Distant moan — something enormous, far away, reverb-drowned.
    const f0 = 55 + Math.random() * 35;
    tone({
      duration: 3 + Math.random() * 2.5,
      from: f0,
      to: f0 * 0.72,
      gain: 0.012 + depth01 * 0.012,
      reverb: 1.6,
      attack: 0.9,
      vibrato: 2.5,
    });
  } else {
    // A far rockfall / cheese-shift: low rumble tumbling away.
    noiseBurst({
      duration: 1.6,
      type: "lowpass",
      from: 220,
      to: 60,
      gain: 0.028,
      color: "brown",
      reverb: 1.2,
      attack: 0.15,
    });
  }
}

// --- Public events -------------------------------------------------------------

// Digging into gouda: a wet squelchy crunch — the cheese gives, bubbles
// squeeze out, a low thump as the carve collapses.
export function playDig() {
  if (!ctx) return;
  noiseBurst({
    duration: 0.34,
    from: 1300,
    to: 160,
    q: 1.1,
    gain: 0.07,
    color: "brown",
    reverb: 0.5,
    attack: 0.008,
  });
  tone({
    duration: 0.22,
    from: 260,
    to: 80,
    gain: 0.038,
    attack: 0.005,
  }); // the squelch
  tone({
    duration: 0.4,
    from: 62,
    to: 40,
    gain: 0.055,
    reverb: 0.6,
    attack: 0.01,
  }); // the thump
  // Bubbles escaping the fresh wound.
  for (let i = 0; i < 4; i++) {
    setTimeout(
      () => {
        if (!ctx) return;
        const f0 = 400 + Math.random() * 800;
        tone({
          duration: 0.08,
          from: f0,
          to: f0 * 2.1,
          gain: 0.008,
          attack: 0.004,
        });
      },
      60 + i * 90,
    );
  }
}

// The driller biting rind: a motor winding up under a broadband grind, and
// a spit of gas out of the wound. Runs ~0.6 s — just over the dig cooldown,
// so held fire reads as one continuous chew.
export function playDrill() {
  if (!ctx) return;
  // The motor, loaded and labouring.
  tone({
    duration: 0.62,
    type: "sawtooth",
    from: 105,
    to: 168,
    gain: 0.03,
    attack: 0.07,
    vibrato: 14,
  });
  tone({
    duration: 0.55,
    type: "square",
    from: 58,
    to: 88,
    gain: 0.02,
    attack: 0.08,
    vibrato: 20,
  });
  // The bit chewing: bright grind over a low tear.
  noiseBurst({
    duration: 0.6,
    from: 900,
    to: 2400,
    q: 0.9,
    gain: 0.045,
    reverb: 0.35,
    attack: 0.06,
  });
  noiseBurst({
    duration: 0.55,
    type: "lowpass",
    from: 340,
    to: 130,
    gain: 0.05,
    color: "brown",
    reverb: 0.6,
    attack: 0.04,
  });
  // Gas boiling out of the cut, faster and thicker than a hand dig.
  for (let i = 0; i < 6; i++) {
    setTimeout(
      () => {
        if (!ctx) return;
        const f0 = 450 + Math.random() * 900;
        tone({
          duration: 0.07,
          from: f0,
          to: f0 * 2.3,
          gain: 0.007,
          attack: 0.004,
        });
      },
      40 + i * 65,
    );
  }
}

// A catfish snapping at you: sharp jaw-clap + guttural growl.
export function playBite() {
  if (!ctx) return;
  noiseBurst({
    duration: 0.08,
    from: 2500,
    to: 400,
    q: 2,
    gain: 0.09,
    attack: 0.002,
  });
  tone({
    duration: 0.5,
    type: "sawtooth",
    from: 65,
    to: 38,
    gain: 0.045,
    reverb: 0.7,
    attack: 0.01,
    vibrato: 9,
  });
}

export function playClick() {
  if (!ctx) return;
  tone({
    duration: 0.03,
    type: "square",
    from: 1400,
    gain: 0.012,
    attack: 0.002,
  });
}

// Teleport: a rushing whoosh, disorienting.
export function playWhoosh() {
  if (!ctx) return;
  noiseBurst({
    duration: 1.1,
    from: 200,
    to: 1400,
    q: 0.8,
    gain: 0.04,
    reverb: 0.8,
    attack: 0.3,
  });
}

// --- Per-frame update ------------------------------------------------------------
// opts: { speed (0..1), radius (dist from map center), sprinting }
export function updateAbyssAudio(
  delta: number,
  {
    speed = 0,
    radius = 420,
    sprinting = false,
  }: { speed?: number; radius?: number; sprinting?: boolean } = {},
) {
  if (!ctx || ctx.state !== "running") return;

  // Depth into the labyrinth, 0 at the drift edge → 1 at the heart.
  const depth01 = Math.max(0, Math.min(1, 1 - radius / 420));

  // Effort follows speed; sprinting spikes it.
  const effortTarget = Math.min(1, speed + (sprinting ? 0.45 : 0));
  effortSm += (effortTarget - effortSm) * Math.min(1, delta * 0.8);

  // Water-mass bed and sub swell with depth; the world muffles down. The
  // sub rises and falls on its own slow cycle so it never reads as an
  // idling engine.
  bedTime += delta;
  droneGain.gain.value = 0.025 + depth01 * 0.045;
  subGain.gain.value =
    depth01 * depth01 * 0.03 * (0.55 + 0.45 * Math.sin(bedTime * 0.09));
  muffle.frequency.value = 2400 - depth01 * 1500; // 2400 Hz → 900 Hz
  reverbOut.gain.value = 0.28 + depth01 * 0.32; // tighter spaces echo more

  // (No swim sound at all: movement is felt through the breathing pace and
  // exhale bubbles. The water speaks only through the bed and ghost tones.)

  // Ghost tones: sparse tonal swells out of the dark, closer together (and
  // slightly louder) the deeper you are.
  ghostTimer -= delta;
  if (ghostTimer <= 0) {
    ghostTone(depth01);
    ghostTimer = 16 + Math.random() * 26 - depth01 * 8;
  }

  // Breathing cycle: 6 s calm → ~4 s at full effort.
  breathPeriod = 6.0 - effortSm * 2.0;
  breathTimer += delta;
  if (breathTimer >= breathPeriod) {
    breathTimer = 0;
    exhale(effortSm);
    // Inhale comes just after the exhale settles.
    const eff = effortSm;
    setTimeout(() => ctx && inhale(eff), 1400 - effortSm * 500);
  }

  // Random distant voices of the abyss — more frequent (and closer) deep in.
  creakTimer -= delta;
  if (creakTimer <= 0) {
    distantVoice(depth01);
    creakTimer = 10 + Math.random() * 24 - depth01 * 6;
  }
}
