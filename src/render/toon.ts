// toon.js — shared cel-shading kit for the whole game.
//
// Two ingredients give the toon look without any extra render passes:
//   1. Stepped lighting: MeshToonMaterial + a shared NearestFilter gradient
//      map quantizes every light response into hard bands.
//   2. Ink rims: a fresnel term darkens grazing angles toward black, which
//      reads as hand-drawn outlines on organic silhouettes — no depth-buffer
//      edge pass needed (and it plays nicely with the fog and bloom).
//
// The gouda world builds its own toon materials (it has heavy custom shader
// injection — see gouda.js); GLB models (divers, catfish) are converted here
// with toonify().
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

let gradient: THREE.DataTexture | null = null;

// 4 hard light bands. NearestFilter is what makes them BANDS.
export function getToonGradient(): THREE.DataTexture {
  if (gradient) return gradient;
  const data = new Uint8Array([40, 105, 180, 255]);
  gradient = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;
  return gradient;
}

// GLSL snippet: darken outgoingLight at grazing view angles (ink outline).
// `normal` and `vViewPosition` are toon-shader built-ins at this point.
export function inkInjection(strength: number = 0.7): string {
  const s = strength.toFixed(3);
  return /* glsl */ `
    {
      float inkDot = abs(dot(normalize(normal), normalize(vViewPosition)));
      float ink = smoothstep(0.32, 0.12, inkDot);
      outgoingLight *= mix(1.0, 1.0 - ${s}, ink);
    }
    #include <opaque_fragment>`;
}

// Convert every lit material under `root` to a MeshToonMaterial that keeps
// its maps/colors, plus the ink rim. ShaderMaterials/sprites are untouched.
export function toonify(
  root: THREE.Object3D,
  { ink = 0.7 }: { ink?: number } = {},
): void {
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

    const t = new THREE.MeshToonMaterial({
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
      gradientMap: getToonGradient(),
    });
    t.userData.__toon = true;
    t.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <opaque_fragment>",
        inkInjection(ink),
      );
    };
    t.customProgramCacheKey = () => `toon-ink-${ink}`;
    (o as THREE.Mesh).material = t;
  });
}
