// The one material every weapon, hand and forearm shares (pt/ux weapons):
// a MeshStandardMaterial with vertex colours whose metalness, roughness and
// glow come per vertex from the `surf` attribute (builder.ts), so steel,
// wood, leather and a glowing gem sit in one draw call. Two cheap additions
// in the shader:
//  - a sky/ground reflection for metal (the scene has no environment map,
//    and without one metal renders nearly black away from the sun's
//    highlight); its colours follow the scene's hemisphere light;
//  - glow: an emissive term from the vertex colour, with a slow shimmer
//    running along the weapon (sunsteel, gems) and a rim on glowing edges.
//
// One program for all of them, compiled when the first weapon is drawn (at
// zone join, never mid-fight). Created once, never disposed.

import * as THREE from 'three';

export const weaponUniforms = {
  uTime: { value: 0 },
  uSky: { value: new THREE.Color('#cfe3ff') },
  uGround: { value: new THREE.Color('#4a5a3a') },
  uEnv: { value: 0.9 },
};

let mat: THREE.MeshStandardMaterial | null = null;

export function weaponMaterial(): THREE.MeshStandardMaterial {
  if (mat) return mat;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 1, roughness: 1 });
  m.name = 'lodestone-weapon';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, weaponUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 surf;\nvarying vec3 vSurf;\nvarying float vAlong;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurf = surf;\nvAlong = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurf;\nvarying float vAlong;\nuniform float uTime;\nuniform vec3 uSky;\nuniform vec3 uGround;\nuniform float uEnv;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * vSurf.y;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * vSurf.x;')
      .replace(
        '#include <emissivemap_fragment>',
        [
          'vec3 wV = normalize(vViewPosition);',
          'vec3 wUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);',
          'vec3 wR = reflect(-wV, normal);',
          'float wH = dot(wR, wUp);',
          'float wFres = pow(1.0 - clamp(dot(normal, wV), 0.0, 1.0), 3.0);',
          'vec3 wEnv = mix(uGround, uSky, smoothstep(-0.35, 0.55, wH));',
          'float wGloss = 1.0 - 0.7 * roughnessFactor;',
          'totalEmissiveRadiance += diffuseColor.rgb * wEnv * uEnv * metalnessFactor * wGloss * (0.45 + 0.55 * wFres);',
          'float wPulse = 0.82 + 0.18 * sin(uTime * 2.6 - vAlong * 7.0) + 0.1 * sin(uTime * 5.3 + vAlong * 19.0);',
          'totalEmissiveRadiance += diffuseColor.rgb * vSurf.z * (wPulse + 1.6 * wFres);',
        ].join('\n'),
      );
  };
  m.customProgramCacheKey = () => 'lodestone-weapon-v1';
  mat = m;
  return m;
}

let hemi: THREE.HemisphereLight | null = null;
let lastLook = -1e9;

/**
 * Per frame (cheap): advance the shimmer and follow the scene's hemisphere
 * light so metal reflects the sky it is under (dimmer at night).
 */
export function tickWeaponMaterial(scene: THREE.Scene, nowMs: number): void {
  weaponUniforms.uTime.value = nowMs / 1000;
  if (nowMs - lastLook > 2000 || (hemi && !hemi.parent)) {
    lastLook = nowMs;
    hemi = null;
    scene.traverse((o) => {
      if (!hemi && (o as THREE.HemisphereLight).isHemisphereLight) hemi = o as THREE.HemisphereLight;
    });
  }
  const h = hemi as THREE.HemisphereLight | null;
  if (h) {
    weaponUniforms.uSky.value.copy(h.color);
    weaponUniforms.uGround.value.copy(h.groundColor);
    weaponUniforms.uEnv.value = 0.85 * Math.min(1.5, h.intensity);
  }
}
