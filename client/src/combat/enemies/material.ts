// The enemy materials (playtest 2 enemy models): ONE patched, flat-shaded
// MeshStandardMaterial for every opaque enemy part, and one translucent
// "jelly" variant (slime bodies). Every enemy mesh is an InstancedMesh
// (renderer.ts), so each material is exactly one program:
//
//   glow  (vertex)    emissive strength baked into the part (eyes, runes,
//                     embers, crystal cores): coloured by the vertex colour
//   iFx   (instance)  x hit flash (white), y wind-up tell (pulsing red-orange,
//                     the readable "it is about to strike" cue on top of the
//                     pose), z dissolve (death: blocky low-poly break-up with
//                     a hot edge), w glow boost (wind-ups make eyes flare)
//
// plus a soft rim term so silhouettes read against dark ground and at
// night (Breath of the Wild style), and for jelly a fresnel edge and a
// little light from within. Created once, never disposed; both programs are
// in the WP19b warm-up (warm.ts).

import * as THREE from 'three';

export const enemyUniforms = {
  uTime: { value: 0 },
  uTell: { value: new THREE.Color('#ff4a1a') },
  uGlowGain: { value: 2.2 },
  uRim: { value: 0.22 },
};

let opaque: THREE.MeshStandardMaterial | null = null;
let jelly: THREE.MeshStandardMaterial | null = null;

function patch(m: THREE.MeshStandardMaterial, isJelly: boolean): void {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, enemyUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nattribute vec4 iFx;\nvarying float vEGlow;\nvarying vec4 vEFx;\nvarying vec3 vELocal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEGlow = glow;\nvEFx = iFx;\nvELocal = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uTell;\nuniform float uGlowGain;\nuniform float uRim;\nvarying float vEGlow;\nvarying vec4 vEFx;\nvarying vec3 vELocal;')
      .replace(
        '#include <clipping_planes_fragment>',
        [
          '#include <clipping_planes_fragment>',
          // blocky break-up: one random value per 16 cm cell of the part
          'float eN = fract(sin(dot(floor(vELocal * 6.0 + 0.5), vec3(12.9898, 78.233, 37.719))) * 43758.5453);',
          'if (vEFx.z > 0.001 && eN < vEFx.z) discard;',
        ].join('\n'),
      )
      .replace(
        '#include <emissivemap_fragment>',
        [
          '#include <emissivemap_fragment>',
          'vec3 eV = normalize(vViewPosition);',
          'float eRim = pow(1.0 - clamp(abs(dot(normal, eV)), 0.0, 1.0), 3.0);',
          'totalEmissiveRadiance += diffuseColor.rgb * eRim * uRim;',
          'totalEmissiveRadiance += vColor.rgb * vEGlow * uGlowGain * (1.0 + vEFx.w);',
          'totalEmissiveRadiance += vec3(1.0, 0.97, 0.92) * vEFx.x;',
          'totalEmissiveRadiance += uTell * vEFx.y * (0.55 + 0.45 * sin(uTime * 20.0));',
          'if (vEFx.z > 0.001) totalEmissiveRadiance += uTell * 2.5 * (1.0 - smoothstep(0.0, 0.12, eN - vEFx.z));',
          isJelly ? 'totalEmissiveRadiance += diffuseColor.rgb * (0.28 + 0.9 * eRim);' : '',
        ].join('\n'),
      );
  };
  m.customProgramCacheKey = () => (isJelly ? 'lodestone-enemy-jelly-v1' : 'lodestone-enemy-v1');
}

/** The opaque enemy material (shared by every enemy part). */
export function enemyMaterial(): THREE.MeshStandardMaterial {
  if (opaque) return opaque;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.82, metalness: 0 });
  m.name = 'lodestone-enemy';
  patch(m, false);
  opaque = m;
  return m;
}

/** Translucent jelly (slime bodies). */
export function jellyMaterial(): THREE.MeshStandardMaterial {
  if (jelly) return jelly;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.25, metalness: 0, transparent: true, opacity: 0.74 });
  m.name = 'lodestone-enemy-jelly';
  patch(m, true);
  jelly = m;
  return m;
}

// Overlays (health bars, auras): unlit, instanced with a colour per instance.
let barBack: THREE.MeshBasicMaterial | null = null;
let barFill: THREE.MeshBasicMaterial | null = null;
let auraStrong: THREE.MeshBasicMaterial | null = null;
let auraSoft: THREE.MeshBasicMaterial | null = null;

export function barMaterials(): { back: THREE.MeshBasicMaterial; fill: THREE.MeshBasicMaterial } {
  barBack ??= new THREE.MeshBasicMaterial({ color: '#16181c', transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false });
  // (transparent too, so it sorts with the back by renderOrder: opaque objects draw before every transparent one)
  barFill ??= new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false });
  return { back: barBack, fill: barFill };
}

export function auraMaterials(): { strong: THREE.MeshBasicMaterial; soft: THREE.MeshBasicMaterial } {
  auraStrong ??= new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
  auraSoft ??= new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
  return { strong: auraStrong, soft: auraSoft };
}
