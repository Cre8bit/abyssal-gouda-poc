// plankton.js — procedural low-visibility blooms: a patchy horizontal slab at
// each level's depth. Density is 0 in clear water, 1 deep inside a bloom.
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";
import { LEVEL_DROP } from "./bell.js";

const noise = new ImprovedNoise();

const SCALE = 0.0028; // horizontal size of a bloom
const THRESHOLD = 0.1908; // sampled so blooms cover ~20% of the area
const EDGE = 0.2; // width of the soft rim, centred on THRESHOLD
const BAND_HALF = 22; // vertical half-thickness of the slab
const BAND_FADE = 16; // soft top and bottom

export function planktonDensity(x, y, z, level) {
  // Each level draws its blooms from a different slice, so no two repeat.
  const w = level * 7.31;
  const n =
    (noise.noise(x * SCALE, z * SCALE, w) +
      0.35 * noise.noise(x * SCALE * 2.2, z * SCALE * 2.2, w + 3.1)) /
    1.35;

  const across = smoothstep(THRESHOLD - EDGE / 2, THRESHOLD + EDGE / 2, n);
  if (across <= 0) return 0;

  const dy = Math.abs(y - -level * LEVEL_DROP);
  const through = 1 - smoothstep(BAND_HALF, BAND_HALF + BAND_FADE, dy);
  return across * through;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
