// The enemy materials (playtest 2 enemy models): ONE patched, flat-shaded
// MeshStandardMaterial for every opaque enemy part, a translucent "jelly"
// variant (slime bodies) and a "spectral" one (summoned allies: glowing,
// see-through, in their element colour). Every enemy mesh is an
// InstancedMesh (renderer.ts), so each material is one program (plus its
// instance-colour variant for debris and the far LOD):
//
//   glow  (vertex)    emissive strength baked into the part (eyes, runes,
//                     embers, crystal cores): coloured by the vertex colour
//   iFx   (instance)  x hit flash (white), y wind-up tell (pulsing red-orange,
//                     the readable "it is about to strike" cue on top of the
//                     pose), z dissolve (death: blocky low-poly break-up with
//                     a hot edge), w glow boost (wind-ups make eyes flare)
//
// plus a soft rim term so silhouettes read against dark ground and at
// night (Breath of the Wild style); jelly adds a fresnel edge and light from
// within. Created once, never disposed; every program is in the WP19b
// warm-up (warm.ts).

import * as THREE from 'three';

export type EnemyMatKind = 'opaque' | 'jelly' | 'spectral';

export const enemyUniforms = {
  uTime: { value: 0 },
  uTell: { value: new THREE.Color('#ff4a1a') },
  uGlowGain: { value: 2.2 },
  uRim: { value: 0.22 },
};

const mats = new Map<string, THREE.MeshStandardMaterial>();

function patch(m: THREE.MeshStandardMaterial, kind: EnemyMatKind): void {
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
          // blocky break-up: one random value per ~16 cm cell of the part
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
          'totalEmissiveRadiance += vColor.rgb * vEGlow * uGlowGain * max(0.0, 1.0 + vEFx.w);',
          'totalEmissiveRadiance += vec3(1.0, 0.97, 0.92) * vEFx.x;',
          // the tell: strongest on the rim, so the silhouette flickers warm without repainting the body
          'totalEmissiveRadiance += uTell * vEFx.y * (0.35 + 1.6 * eRim) * (0.6 + 0.4 * sin(uTime * 20.0));',
          // the hot break-up edge (w < 0: none)
          'if (vEFx.z > 0.001 && vEFx.w > -0.5) totalEmissiveRadiance += uTell * 2.5 * (1.0 - smoothstep(0.0, 0.12, eN - vEFx.z));',
          kind === 'jelly' ? 'totalEmissiveRadiance += diffuseColor.rgb * (0.28 + 0.9 * eRim);' : '',
          kind === 'spectral' ? 'totalEmissiveRadiance += diffuseColor.rgb * (0.55 + 1.6 * eRim) * (0.85 + 0.15 * sin(uTime * 3.0 + vELocal.y * 4.0));' : '',
        ].join('\n'),
      );
  };
  m.customProgramCacheKey = () => `lodestone-enemy-${kind}-v1`;
}

/** The material of a kind (shared by every enemy part of that kind). */
export function enemyMat(kind: EnemyMatKind): THREE.MeshStandardMaterial {
  let m = mats.get(kind);
  if (m) return m;
  if (kind === 'jelly') m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.25, metalness: 0, transparent: true, opacity: 0.74 });
  else if (kind === 'spectral') m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.4, metalness: 0, transparent: true, opacity: 0.5, depthWrite: false });
  else m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.82, metalness: 0 });
  m.name = `lodestone-enemy-${kind}`;
  patch(m, kind);
  mats.set(kind, m);
  return m;
}

export const enemyMaterial = (): THREE.MeshStandardMaterial => enemyMat('opaque');
export const jellyMaterial = (): THREE.MeshStandardMaterial => enemyMat('jelly');
export const spectralMaterial = (): THREE.MeshStandardMaterial => enemyMat('spectral');

// Overlays (health bars, auras): unlit, instanced with a colour per instance.
let barBack: THREE.MeshBasicMaterial | null = null;
let barFill: THREE.MeshBasicMaterial | null = null;
let auraStrong: THREE.MeshBasicMaterial | null = null;
let auraSoft: THREE.MeshBasicMaterial | null = null;

export function barMaterials(): { back: THREE.MeshBasicMaterial; fill: THREE.MeshBasicMaterial } {
  // depthWrite: the post chain's distance fog reads the depth buffer; a bar that left the
  // depth of the far ground behind it would be fogged pale (they still draw over everything)
  barBack ??= new THREE.MeshBasicMaterial({ color: '#16181c', transparent: true, opacity: 0.85, depthTest: false, depthWrite: true, side: THREE.DoubleSide, fog: false });
  // (transparent too, so it sorts with the back by renderOrder: opaque objects draw before every transparent one)
  barFill ??= new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthTest: false, depthWrite: true, side: THREE.DoubleSide, fog: false });
  return { back: barBack, fill: barFill };
}

export function auraMaterials(): { strong: THREE.MeshBasicMaterial; soft: THREE.MeshBasicMaterial } {
  auraStrong ??= new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
  auraSoft ??= new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
  return { strong: auraStrong, soft: auraSoft };
}
