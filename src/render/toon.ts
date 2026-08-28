// toon.ts — shared cel-shading kit, and the ONLY place the game builds a
// toon material.
//
// Two ingredients give the toon look without any extra render passes:
//   1. Stepped lighting: MeshToonMaterial + a shared NearestFilter gradient
//      map quantizes every light response into hard bands.
//   2. Ink rims: a fresnel term darkens grazing angles toward black, which
//      reads as hand-drawn outlines on organic silhouettes — no depth-buffer
//      edge pass needed (and it plays nicely with the fog and bloom).
//
// Everything lit in the game goes through one of two doors, and both end up
// in toonMaterial() so the bands and the ink can never drift apart:
//
//   • GLB models (diver, catfish, bell) → toonify(root), called from the
//     model's OWN template prep, not from whoever mounts it.
//   • Meshes we build in code (the cheese world, the Golden Gouda, props) →
//     toonMaterial(params, { shader }), where `shader` is the model's custom
//     injection. The ink rides on top of it, always, at the same stage.
//
// Never instantiate THREE.MeshToonMaterial outside this file — hand-built
// materials silently use the fallback ramp (no rim). toonMaterial() and
// toonify() are the only interface to prevent drift.
//
// Deliberately NOT toon (they are light sources or volumes, not surfaces):
// lamp bulbs and halos (MeshBasicMaterial/sprites), the particle and beam
// ShaderMaterials, the boundary veil, and the Gouda's levitating bits.
import * as THREE from "three";

// Structural view over the lit material families (standard/physical/
// lambert/phong) — just the fields toonify() reads off them.
interface LitMaterial extends THREE.Material {
  isMeshStandardMaterial?: boolean;
  isMeshPhysicalMaterial?: boolean;
  isMeshLambertMaterial?: boolean;
  isMeshPhongMaterial?: boolean;
  color?: THREE.Color;
  map?: THREE.Texture | null;
  normalMap?: THREE.Texture | null;
  emissive?: THREE.Color;
  emissiveMap?: THREE.Texture | null;
  emissiveIntensity?: number;
}

const TOON_INK = 0.7; // rim strength: 1 = grazing angles go black
const TOON_FLOOR = 40; // darkest band, of 255 — see getToonGradient

// 4 hard light bands (NearestFilter quantizes them). `floor` (default 40/255)
// keeps unlit faces at 16% brightness; objects lit from inside use floor: 0.
const gradients = new Map<number, THREE.DataTexture>();
function getToonGradient(floor: number = TOON_FLOOR): THREE.DataTexture {
  let gradient = gradients.get(floor);
  if (gradient) return gradient;
  gradient = new THREE.DataTexture(
    new Uint8Array([floor, 105, 180, 255]),
    4,
    1,
    THREE.RedFormat,
  );
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;
  gradients.set(floor, gradient);
  return gradient;
}

// Inject ink rim at opaque_fragment (end of fragment shader) so it darkens
// all output including emissive. Earlier injection = glow overwrites rim.
function applyInk(
  shader: THREE.WebGLProgramParametersWithUniforms,
  ink: number = TOON_INK,
): void {
  const s = ink.toFixed(3);
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <opaque_fragment>",
    /* glsl */ `
    {
      // normal and vViewPosition are toon-shader built-ins at this point.
      float inkDot = abs(dot(normalize(normal), normalize(vViewPosition)));
      float ink = smoothstep(0.32, 0.12, inkDot);
      outgoingLight *= mix(1.0, 1.0 - ${s}, ink);
    }
    #include <opaque_fragment>`,
  );
}

export interface ToonOptions {
  ink?: number; // rim strength (default TOON_INK); 0 disables the rim
  floor?: number; // darkest light band, of 255 (default TOON_FLOOR)
  // Custom GLSL injection (runs before ink). Use `key` to prevent cache merges.
  shader?: (shader: THREE.WebGLProgramParametersWithUniforms) => void;
  key?: string; // program cache salt; required whenever `shader` bakes constants
}

// Toon material constructor. Pass `floor`, not `gradientMap`, for cache reuse.
export function toonMaterial(
  params: Omit<THREE.MeshToonMaterialParameters, "gradientMap"> = {},
  { ink = TOON_INK, floor = TOON_FLOOR, shader, key = "" }: ToonOptions = {},
): THREE.MeshToonMaterial {
  const material = new THREE.MeshToonMaterial({
    ...params,
    gradientMap: getToonGradient(floor),
  });
  material.userData.__toon = true;
  if (shader || ink > 0) {
    material.onBeforeCompile = (s) => {
      shader?.(s);
      if (ink > 0) applyInk(s, ink);
    };
    material.customProgramCacheKey = () => `toon:${key}:${ink}`;
  }
  return material;
}

// Convert all lit materials to toon (preserving maps/colors). Idempotent:
// ShaderMaterials and already-toon materials are skipped.
// Call from model template prep (entities/*.ts, world/*.ts), never mount code.
export function toonify(root: THREE.Object3D, options: ToonOptions = {}): void {
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh && !(o as THREE.SkinnedMesh).isSkinnedMesh)
      return;
    const m = (o as THREE.Mesh).material as LitMaterial | undefined;
    if (!m || m.userData.__toon) return;
    if (
      !m.isMeshStandardMaterial &&
      !m.isMeshPhysicalMaterial &&
      !m.isMeshLambertMaterial &&
      !m.isMeshPhongMaterial
    )
      return;

    (o as THREE.Mesh).material = toonMaterial(
      {
        color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
        map: m.map ?? null,
        normalMap: m.normalMap ?? null,
        emissive: m.emissive ? m.emissive.clone() : new THREE.Color(0x000000),
        emissiveMap: m.emissiveMap ?? null,
        emissiveIntensity: m.emissiveIntensity ?? 1,
        transparent: m.transparent,
        opacity: m.opacity,
        alphaTest: m.alphaTest,
        side: m.side,
        vertexColors: m.vertexColors,
      },
      options,
    );
  });
}
