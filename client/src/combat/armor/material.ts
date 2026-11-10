// The one armor material (playtest 2 visible armor, CR 034): every worn
// piece on every avatar, on the skinned full rig, the mid-LOD silhouette
// and your first-person sleeves. Like the weapon material (weapons/
// material.ts) it is a MeshStandardMaterial with vertex colours whose
// metalness, roughness and glow come per vertex from `surf`
// (weapons/builder.ts), with the same sky/ground reflection on metal, plus:
//  - glow (surf.z > 0): an emissive term with a slow shimmer (sunsteel, the
//    trim of relic-and-up pieces, gem inlays) and a rim on glowing edges;
//  - holo (surf.z < 0, Bitchin'): the surface runs through the spectrum with
//    the view angle and time, strongest on the trim (|surf.z| = strength).
// The graphics styles (toon bands, rim light, retro snap: world/style)
// reach it like every other lit material. One program per variant (plain,
// skinned; their shadow passes), compiled in the WP19b warm-up
// (world/warmExtras.ts). Created once, never disposed.

import * as THREE from 'three';
import { installStyleChunks } from '../../world/style/styleShader';
import { weaponUniforms } from '../weapons/material';

installStyleChunks();

let mat: THREE.MeshStandardMaterial | null = null;

export function armorMaterial(): THREE.MeshStandardMaterial {
  if (mat) return mat;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 1, roughness: 1, flatShading: false });
  m.name = 'lodestone-armor';
  const styleHook = THREE.Material.prototype.onBeforeCompile; // the style uniforms (styleShader.ts)
  m.onBeforeCompile = (shader, renderer) => {
    styleHook.call(m, shader, renderer);
    Object.assign(shader.uniforms, weaponUniforms); // the weapons' sky, ground and clock (ticked every frame)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 surf;\nvarying vec3 vSurf;\nvarying vec3 vAPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurf = surf;\nvAPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurf;\nvarying vec3 vAPos;\nuniform float uTime;\nuniform vec3 uSky;\nuniform vec3 uGround;\nuniform float uEnv;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * vSurf.y;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * vSurf.x;')
      .replace(
        '#include <emissivemap_fragment>',
        [
          'vec3 aV = normalize(vViewPosition);',
          'vec3 aUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);',
          'float aFres = pow(1.0 - clamp(dot(normal, aV), 0.0, 1.0), 3.0);',
          'float aHolo = max(0.0, -vSurf.z);',
          'float aGlow = max(0.0, vSurf.z);',
          'if (aHolo > 0.0) {',
          '  float aH = fract(dot(vAPos, vec3(2.3, 3.1, 1.7)) + aFres * 0.9 + uTime * 0.22);',
          '  vec3 aRainbow = clamp(abs(mod(aH * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);',
          // an iridescent sheen: strongest at grazing angles, the face keeps the metal's colour
          '  float aSheen = min(aHolo, 1.0) * (0.3 + 0.7 * pow(1.0 - clamp(dot(normal, aV), 0.0, 1.0), 1.5));',
          '  diffuseColor.rgb = mix(diffuseColor.rgb, aRainbow, 0.65 * aSheen);',
          '  totalEmissiveRadiance += aRainbow * aSheen * 0.35;',
          '}',
          'vec3 aR = reflect(-aV, normal);',
          'vec3 aEnv = mix(uGround, uSky, smoothstep(-0.35, 0.55, dot(aR, aUp)));',
          'totalEmissiveRadiance += diffuseColor.rgb * aEnv * uEnv * metalnessFactor * (1.0 - 0.7 * roughnessFactor) * (0.4 + 0.5 * aFres);',
          'float aPulse = 0.85 + 0.15 * sin(uTime * 2.2 - vAPos.y * 6.0);',
          'totalEmissiveRadiance += diffuseColor.rgb * aGlow * (aPulse + 1.4 * aFres);',
        ].join('\n'),
      );
  };
  m.customProgramCacheKey = () => 'lodestone-armor-v1';
  mat = m;
  return m;
}
