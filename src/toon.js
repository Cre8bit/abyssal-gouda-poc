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

let gradient = null;

// 4 hard light bands. NearestFilter is what makes them BANDS.
export function getToonGradient() {
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
export function inkInjection(strength = 0.7) {
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
export function toonify(root, { ink = 0.7 } = {}) {
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const m = o.material;
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
    o.material = t;
  });
}
