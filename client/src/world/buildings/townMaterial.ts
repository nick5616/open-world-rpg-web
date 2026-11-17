// The one material of the towns layer (WP20): MeshStandardMaterial patched
// to sample the towns texture array (layer per vertex) and to emit light per
// vertex, so buildings, interiors, windows, lanterns and fires of a whole
// town are one material and one draw call each (spec 12: <= 400 per frame).
//
// Per-vertex `aLG` = (layer, glow). glow 1..127: a window that lights up at
// night (warm, scaled by uNight); 128..255: always on (fire, lantern glass,
// crystals: texel colour x vertex tint). The texture's alpha masks which
// texels may emit (glass panes, not their frames). The surface stays opaque.

import * as THREE from 'three';
import type { MeshData } from './meshBuilder';
import { TEX } from './textures';

/** The fire picture's layer (props.ts flame): its always-on quads sway and flicker (playtest 2 immersion pass). */
const FIRE_LAYER = TEX.fire.toFixed(1);

export interface TownMaterials {
  /** Buildings, interiors, structures, bridges: lit, casts and receives shadows. */
  solid: THREE.MeshStandardMaterial;
  /** Roads, plazas, paving: same shader, polygon offset over the terrain. */
  decal: THREE.MeshStandardMaterial;
  texture: THREE.DataArrayTexture;
  uniforms: { uNight: { value: number }; uGlow: { value: number }; uTownTime: { value: number }; uCaveFill: { value: number } };
  dispose(): void;
}

export function townTexture(pixels: Uint8Array, size: number, layers: number): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(pixels, size, size, layers);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function patch(m: THREE.MeshStandardMaterial, tex: THREE.DataArrayTexture, u: TownMaterials['uniforms']): void {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.tTown = { value: tex };
    shader.uniforms.uNight = u.uNight;
    shader.uniforms.uGlow = u.uGlow;
    shader.uniforms.uTownTime = u.uTownTime;
    shader.uniforms.uCaveFill = u.uCaveFill;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aTexUv;\nattribute vec2 aLG;\nuniform float uTownTime;\nvarying vec2 vTexUv;\nvarying vec3 vTexAff;\nflat varying float vLayer;\nvarying float vGlowV;\nvarying float vFirePh;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vTexUv = aTexUv;
vLayer = aLG.x;
vGlowV = aLG.y;
vFirePh = -1.0;
// Playtest 2 immersion pass: town flames (hearths, braziers, campfires, torches) lick and sway
// instead of standing still; the tips move most, the base stays on the logs.
if (aLG.y > 127.5 && abs(aLG.x - ${FIRE_LAYER}) < 0.5) {
  float top = clamp(aTexUv.y, 0.0, 1.0);
  float ph = dot(floor(position.xz * 2.0), vec2(1.73, 2.31));
  vFirePh = fract(ph * 0.1) * 6.2831;
  transformed.x += sin(uTownTime * 5.7 + ph) * 0.05 * top;
  transformed.z += cos(uTownTime * 4.9 + ph * 1.37) * 0.05 * top;
  transformed.y += (0.07 * sin(uTownTime * 7.3 + ph * 0.7) + 0.02) * top;
}`,
      )
      // Playtest 2 Retro style: uv * w and w, so the fragment can undo the
      // perspective correction (affine texture wobble, styleShader.ts lsRetro.z).
      .replace('#include <project_vertex>', '#include <project_vertex>\nvTexAff = vec3(aTexUv * gl_Position.w, gl_Position.w);');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform highp sampler2DArray tTown;\nuniform float uNight;\nuniform float uGlow;\nuniform float uTownTime;\nuniform float uCaveFill;\nvarying vec2 vTexUv;\nvarying vec3 vTexAff;\nflat varying float vLayer;\nvarying float vGlowV;\nvarying float vFirePh;\nvec4 townTexel;',
      )
      .replace(
        '#include <map_fragment>',
        `{
  vec2 tuv = vTexUv;
  // a flame's picture wavers sideways, more toward the tips
  if (vFirePh >= 0.0) tuv.x += sin(tuv.y * 7.0 - uTownTime * 6.0 + vFirePh) * 0.04 * tuv.y;
  // Retro: affine interpolation (faded in past 2 m, where a big floor quad
  // would otherwise swim wildly) and texel-snapped sampling (nearest look,
  // with the smooth uv's gradients so mip selection stays put).
  if (lsRetro.z > 0.0 && vTexAff.z > 0.05) tuv = mix(tuv, vTexAff.xy / vTexAff.z, lsRetro.z * smoothstep(2.0, 6.0, length(vViewPosition)));
  if (lsRetro.w > 0.0) {
    vec2 ts = vec2(textureSize(tTown, 0).xy);
    townTexel = textureGrad(tTown, vec3((floor(tuv * ts) + 0.5) / ts, floor(vLayer + 0.5)), dFdx(vTexUv), dFdy(vTexUv));
  } else {
    townTexel = texture(tTown, vec3(tuv, floor(vLayer + 0.5)));
  }
}
diffuseColor.rgb *= townTexel.rgb;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
// CR 043: a dwarven hall has no sun; its stone carries a warm fill of its own (baked, no light).
totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.82, 0.62) * uCaveFill;
{
  float g = floor(vGlowV + 0.5);
  if (g > 0.5) {
    float always = step(127.5, g);
    float k = (g - 128.0 * always) / 16.0;
    vec3 warm = vec3(1.0, 0.62, 0.3);
    vec3 col = mix(warm, townTexel.rgb * vColor.rgb, always);
    // flames breathe a little (±8 %, 1-2 Hz: a flicker, never a strobe)
    float fl = vFirePh >= 0.0 ? 0.94 + 0.05 * sin(uTownTime * 8.3 + vFirePh) + 0.03 * sin(uTownTime * 13.1 + vFirePh * 2.0) : 1.0;
    totalEmissiveRadiance += col * k * townTexel.a * mix(uNight, 1.0, always) * uGlow * fl;
  }
}`,
      );
  };
  m.customProgramCacheKey = () => 'lodestone-town-v4';
}

export function makeTownMaterials(tex: THREE.DataArrayTexture): TownMaterials {
  const uniforms = { uNight: { value: 0 }, uGlow: { value: 1 }, uTownTime: { value: 0 }, uCaveFill: { value: 0 } };
  const solid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, color: 0xffffff });
  solid.name = 'town-solid';
  patch(solid, tex, uniforms);
  const decal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  decal.name = 'town-decal';
  patch(decal, tex, uniforms);
  return {
    solid,
    decal,
    texture: tex,
    uniforms,
    dispose: () => {
      solid.dispose();
      decal.dispose();
      tex.dispose();
    },
  };
}

/** BufferGeometry over a worker-built MeshData (no copies: the typed arrays become the attributes). */
export function geometryOf(m: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3, true));
  g.setAttribute('aTexUv', new THREE.BufferAttribute(m.uv, 2));
  g.setAttribute('aLG', new THREE.BufferAttribute(m.lg, 2, false));
  g.setAttribute('color', new THREE.BufferAttribute(m.color, 3, true));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  g.computeBoundingSphere();
  return g;
}
