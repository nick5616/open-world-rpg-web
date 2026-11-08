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

export interface TownMaterials {
  /** Buildings, interiors, structures, bridges: lit, casts and receives shadows. */
  solid: THREE.MeshStandardMaterial;
  /** Roads, plazas, paving: same shader, polygon offset over the terrain. */
  decal: THREE.MeshStandardMaterial;
  texture: THREE.DataArrayTexture;
  uniforms: { uNight: { value: number }; uGlow: { value: number } };
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
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aTexUv;\nattribute vec2 aLG;\nvarying vec2 vTexUv;\nflat varying float vLayer;\nvarying float vGlowV;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTexUv = aTexUv;\nvLayer = aLG.x;\nvGlowV = aLG.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform highp sampler2DArray tTown;\nuniform float uNight;\nuniform float uGlow;\nvarying vec2 vTexUv;\nflat varying float vLayer;\nvarying float vGlowV;\nvec4 townTexel;',
      )
      .replace('#include <map_fragment>', 'townTexel = texture(tTown, vec3(vTexUv, floor(vLayer + 0.5)));\ndiffuseColor.rgb *= townTexel.rgb;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float g = floor(vGlowV + 0.5);
  if (g > 0.5) {
    float always = step(127.5, g);
    float k = (g - 128.0 * always) / 16.0;
    vec3 warm = vec3(1.0, 0.62, 0.3);
    vec3 col = mix(warm, townTexel.rgb * vColor.rgb, always);
    totalEmissiveRadiance += col * k * townTexel.a * mix(uNight, 1.0, always) * uGlow;
  }
}`,
      );
  };
  m.customProgramCacheKey = () => 'lodestone-town-v1';
}

export function makeTownMaterials(tex: THREE.DataArrayTexture): TownMaterials {
  const uniforms = { uNight: { value: 0 }, uGlow: { value: 1 } };
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
