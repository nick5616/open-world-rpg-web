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
// Playtest 2 polish: the iron sword read dark navy unless the sun caught
// it. The reflection was a fifth of the sky's light on a blade facing the
// camera (a Fresnel term that left 45% face-on, a 0.7 gain, a roughness
// darkening) and took the zenith's saturated blue for a view that reflects
// the horizon. Now (METAL_GLSL, shared with the armor material):
//  - the reflection sees ground, a pale horizon and the zenith (a little
//    paler than the hemisphere's sky colour), by the reflected direction; a rougher metal sees a softer, averaged sky
//    (blurred, not darker);
//  - metal reflects its own colour face-on (F0) and goes toward white at
//    grazing angles (Schlick), so a blade facing you is as bright as it is
//    at an angle, minus nothing;
//  - metalness stops at METAL_MAX: a fifth of the colour stays diffuse, so
//    metal also takes the sun from the side, campfires, cave lights and the
//    styles' light bands like everything else (no black faces at night or
//    underground, where the sky reflection is near zero);
//  - its strength follows the hemisphere light (dimmer at dusk and night,
//    near zero underground), at ENV_GAIN of it;
//  - plus a broad reflection of the scene's own lights (the sun, the moon,
//    campfires, the cave's lights: SHEEN of each, widest toward the
//    reflected direction), so a blade underground shines in the torchlight
//    instead of reflecting the (absent) sky's navy.
// metalEnv() is the same reflection on the CPU (material.test.ts).
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

/** Metalness never goes past this: the rest of the colour stays diffuse (lit by every light). */
export const METAL_MAX = 0.8;
/** Reflection strength per unit of hemisphere light intensity. */
export const ENV_GAIN = 0.75;
/** The broad reflection of the scene's lights (sun, moon, fires, cave lights), per unit of light. */
export const SHEEN = 0.08;
const LUMA = [0.2126, 0.7152, 0.0722] as const;

/**
 * GLSL (inside main, at the emissive stage): metalness capped, and the sky
 * reflection added to totalEmissiveRadiance. Needs vSurf (x metal, y rough),
 * normal, vViewPosition, uSky / uGround / uEnv; declares names prefixed mt.
 * A material may define MT_GAIN (default 1) to scale the reflection and the
 * sheen (armor: its plate is about half metal and already lit diffusely).
 */
export const METAL_GLSL = {
  roughness: 'float roughnessFactor = roughness * vSurf.y;',
  metalness: `#ifndef MT_GAIN\n#define MT_GAIN 1.0\n#endif\nfloat mtMetal = metalness * vSurf.x;\nfloat metalnessFactor = min(mtMetal, ${METAL_MAX.toFixed(3)});`,
  reflection: [
    'vec3 mtV = normalize(vViewPosition);',
    'vec3 mtUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);',
    'float mtH = dot(reflect(-mtV, normal), mtUp);',
    'float mtRough = clamp(roughnessFactor, 0.0, 1.0);',
    'float mtFres = pow(1.0 - clamp(dot(normal, mtV), 0.0, 1.0), 5.0);',
    `vec3 mtGrey = vec3(dot(uSky, vec3(${LUMA.join(', ')})));`,
    'vec3 mtHorizon = mix(uSky, mtGrey, 0.6);',
    'vec3 mtSky = mix(mtHorizon, mix(uSky, mtGrey, 0.3), smoothstep(0.05, 0.75, mtH));',
    'vec3 mtEnv = mix(uGround, mtSky, smoothstep(-0.3 - 0.3 * mtRough, 0.06 + 0.3 * mtRough, mtH));',
    'mtEnv = mix(mtEnv, 0.4 * uGround + 0.6 * mtHorizon, 0.5 * mtRough);',
    'vec3 mtF = mix(diffuseColor.rgb, vec3(1.0), mtFres * (1.0 - 0.8 * mtRough));',
    'totalEmissiveRadiance += mtF * mtEnv * uEnv * mtMetal * MT_GAIN * (1.0 - 0.3 * mtRough);',
  ].join('\n'),
  /** After lights_fragment_end: a broad reflection of the scene's own lights (the sun, the moon, fires, cave lights). */
  sheen: [
    '#include <lights_fragment_end>',
    '{',
    '  vec3 mtR = reflect(-geometryViewDir, geometryNormal);',
    '  vec3 mtLit = vec3(0.0);',
    '  IncidentLight mtL;',
    '  #if NUM_DIR_LIGHTS > 0',
    '  for (int i = 0; i < NUM_DIR_LIGHTS; i++) {',
    '    getDirectionalLightInfo(directionalLights[i], mtL);',
    '    mtLit += mtL.color * (0.2 + 0.8 * pow(max(dot(mtR, mtL.direction), 0.0), 3.0)) * clamp(0.5 + 0.5 * dot(geometryNormal, mtL.direction), 0.0, 1.0);',
    '  }',
    '  #endif',
    '  #if NUM_POINT_LIGHTS > 0',
    '  for (int i = 0; i < NUM_POINT_LIGHTS; i++) {',
    '    getPointLightInfo(pointLights[i], geometryPosition, mtL);',
    '    mtLit += mtL.color * (0.2 + 0.8 * pow(max(dot(mtR, mtL.direction), 0.0), 3.0)) * clamp(0.5 + 0.5 * dot(geometryNormal, mtL.direction), 0.0, 1.0);',
    '  }',
    '  #endif',
    `  reflectedLight.indirectSpecular += mtF * mtLit * mtMetal * MT_GAIN * ${SHEEN.toFixed(3)};`,
    '}',
  ].join('\n'),
};

type RGB = readonly [number, number, number];
const mix3 = (a: RGB, b: RGB, t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * The reflection METAL_GLSL adds (linear RGB), on the CPU: `up` is the
 * reflected direction's height (-1 straight down .. 1 straight up), `facing`
 * the cosine between the normal and the view direction.
 */
export function metalEnv(base: RGB, metal: number, rough: number, up: number, facing: number, sky: RGB, ground: RGB, env: number): [number, number, number] {
  const r = Math.min(1, Math.max(0, rough));
  const fres = Math.pow(1 - Math.min(1, Math.max(0, facing)), 5);
  const l = sky[0] * LUMA[0] + sky[1] * LUMA[1] + sky[2] * LUMA[2];
  const horizon = mix3(sky, [l, l, l], 0.6);
  const skyC = mix3(horizon, mix3(sky, [l, l, l], 0.3), smooth(0.05, 0.75, up));
  let e = mix3(ground, skyC, smooth(-0.3 - 0.3 * r, 0.06 + 0.3 * r, up));
  e = mix3(e, mix3(ground, horizon, 0.6), 0.5 * r);
  const f = mix3(base, [1, 1, 1], fres * (1 - 0.8 * r));
  const k = env * metal * (1 - 0.3 * r);
  return [f[0] * e[0] * k, f[1] * e[1] * k, f[2] * e[2] * k];
}

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
      .replace('#include <roughnessmap_fragment>', METAL_GLSL.roughness)
      .replace('#include <metalnessmap_fragment>', METAL_GLSL.metalness)
      .replace('#include <lights_fragment_end>', METAL_GLSL.sheen)
      .replace(
        '#include <emissivemap_fragment>',
        [
          METAL_GLSL.reflection,
          'float wFres = pow(1.0 - clamp(dot(normal, mtV), 0.0, 1.0), 3.0);',
          'float wPulse = 0.82 + 0.18 * sin(uTime * 2.6 - vAlong * 7.0) + 0.1 * sin(uTime * 5.3 + vAlong * 19.0);',
          'totalEmissiveRadiance += diffuseColor.rgb * vSurf.z * (wPulse + 1.6 * wFres);',
        ].join('\n'),
      );
  };
  m.customProgramCacheKey = () => 'lodestone-weapon-v2';
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
    weaponUniforms.uEnv.value = ENV_GAIN * Math.min(1.6, h.intensity);
  }
}
