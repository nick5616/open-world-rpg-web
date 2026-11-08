// Materials for instanced scatter. One shader family, three jobs:
//
//  - Distance LOD cross-fade: each InstancedMesh draws one LOD; the vertex
//    shader computes the instance's distance and a fade from that mesh's
//    band (uFade: fade-in start/end, fade-out start/end); the fragment
//    shader dithers against it. Neighbouring LODs use complementary bands,
//    so a tree swaps meshes without a pop, and the farthest band shrinks
//    trees in at the edge of the scatter distance (spec 12 "fade-in at the
//    far edge"). Distances are per frame on the GPU, so bands are smooth even
//    though the CPU re-bins instances only every few meters.
//  - Wind: instances bend downwind by the shared field (wind.ts), more toward
//    the top (position.y is normalized height); foliage also flutters.
//  - Tint: instanceColor only applies where aFoliage = 1, so trunks keep
//    their bark colour while each tree kind gets its leaf colour.

import * as THREE from 'three';
import { WIND_GLSL, windUniforms } from '../wind';

const DITHER = /* glsl */ `
float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[idx] + 0.5) / 16.0;
}
`;

export interface ScatterMaterialOptions {
  /** fade-in start/end, fade-out start/end (meters). */
  fade: THREE.Vector4;
  /** Sway amplitude at the top, as a fraction of instance height per m/s of wind. */
  sway: number;
  flutter: number;
  /** Grass: normals are up-ish and both faces are drawn. */
  doubleSided?: boolean;
  roughness?: number;
}

export interface ScatterMaterial extends THREE.MeshStandardMaterial {
  userData: { fade: { value: THREE.Vector4 } };
}

export function createScatterMaterial(o: ScatterMaterialOptions): ScatterMaterial {
  const fade = { value: o.fade.clone() };
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: o.roughness ?? 0.85, metalness: 0, side: o.doubleSided ? THREE.DoubleSide : THREE.FrontSide }) as ScatterMaterial;
  m.userData.fade = fade;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms, { uFade: fade, uSway: { value: o.sway }, uFlutter: { value: o.flutter } });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        ${WIND_GLSL}
        uniform vec4 uFade;
        uniform float uSway;
        uniform float uFlutter;
        attribute float aFoliage;
        varying float vFade;`,
      )
      .replace(
        '#include <color_vertex>',
        `#if defined( USE_COLOR_ALPHA )
          vColor = vec4( 1.0 );
        #elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
          vColor = vec3( 1.0 );
        #endif
        #ifdef USE_COLOR
          vColor *= color;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, aFoliage);
        #endif`,
      )
      .replace(
        '#include <project_vertex>',
        `vec3 iPos = vec3(instanceMatrix[3]);
        float iDist = distance(iPos, cameraPosition);
        vFade = smoothstep(uFade.x, uFade.y, iDist) * (1.0 - smoothstep(uFade.z, uFade.w, iDist));
        vec4 mvPosition = instanceMatrix * vec4(transformed, 1.0);
        float iH = length(vec3(instanceMatrix[1]));
        float hk = clamp(transformed.y, 0.0, 1.5);
        vec2 w = windAt(iPos.xz);
        float g = windGust(iPos.xz + mvPosition.xz * 0.3);
        vec2 bend = w * uSway * hk * hk * iH;
        bend += aFoliage * uFlutter * iH * vec2(sin(uWindTime * 7.0 + mvPosition.x * 2.1 + mvPosition.y * 1.3), cos(uWindTime * 6.1 + mvPosition.z * 2.3)) * g * hk;
        mvPosition.xz += bend;
        mvPosition.y -= dot(bend, bend) * 0.3 / max(iH, 0.1);
        // Fully faded instances collapse to a point: no fragments, no overdraw.
        if (vFade <= 0.0) mvPosition.xyz = iPos;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vFade;\n${DITHER}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\nif (vFade < 0.999 && bayer4(gl_FragCoord.xy) >= vFade) discard;`);
  };
  m.customProgramCacheKey = () => `lodestone-scatter-1-${o.doubleSided ? 'ds' : 'fs'}`;
  return m;
}

/**
 * Billboard impostors for trees beyond the mesh distance: one camera-facing
 * (cylindrical) quad per instance, textured from an impostor atlas rendered
 * at load (impostors.ts), lit with the sun and sky ambient.
 */
export function createBillboardMaterial(atlas: THREE.Texture, tile: number, tiles: number, fade: THREE.Vector4, light: { uSunDir: { value: THREE.Vector3 }; uLightColor: { value: THREE.Color }; uAmbient: { value: THREE.Color } }): ScatterMaterial {
  const fadeU = { value: fade.clone() };
  const m = new THREE.ShaderMaterial({
    uniforms: { ...windUniforms, ...light, uAtlas: { value: atlas }, uTile: { value: tile }, uTiles: { value: tiles }, uFade: fadeU },
    vertexShader: /* glsl */ `
      ${WIND_GLSL}
      uniform vec4 uFade;
      varying vec2 vUv;
      varying float vFade;
      varying vec3 vTint;
      void main() {
        vec3 iPos = vec3(instanceMatrix[3]);
        float sx = length(vec3(instanceMatrix[0]));
        float sy = length(vec3(instanceMatrix[1]));
        float d = distance(iPos, cameraPosition);
        vFade = smoothstep(uFade.x, uFade.y, d) * (1.0 - smoothstep(uFade.z, uFade.w, d));
        vec3 toCam = cameraPosition - iPos;
        toCam.y = 0.0;
        vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), normalize(toCam + vec3(1e-4, 0.0, 0.0))));
        // Impostors were rendered with the tree ~1.1 units wide: keep the aspect.
        vec3 p = iPos + right * position.x * sx * 1.1 + vec3(0.0, position.y * sy * 1.1, 0.0);
        p.xz += windAt(iPos.xz) * 0.012 * position.y * sy * position.y;
        vUv = vec2(position.x + 0.5, position.y);
        #ifdef USE_INSTANCING_COLOR
          vTint = instanceColor;
        #else
          vTint = vec3(1.0);
        #endif
        if (vFade <= 0.0) p = iPos;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform float uTile;
      uniform float uTiles;
      uniform vec3 uSunDir;
      uniform vec3 uLightColor;
      uniform vec3 uAmbient;
      varying vec2 vUv;
      varying float vFade;
      varying vec3 vTint;
      ${DITHER}
      void main() {
        vec4 c = texture2D(uAtlas, vec2((uTile + vUv.x) / uTiles, vUv.y));
        if (c.a < 0.5) discard;
        if (vFade < 0.999 && bayer4(gl_FragCoord.xy) >= vFade) discard;
        // At impostor distance the trunk is a few pixels: tinting the whole card is fine.
        vec3 albedo = c.rgb * mix(vec3(1.0), vTint, 0.85);
        float sun = 0.55 + 0.45 * max(uSunDir.y, 0.0);
        vec3 lit = albedo * (uAmbient * 0.9 + uLightColor * sun * 0.55);
        gl_FragColor = vec4(lit, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  (m as unknown as ScatterMaterial).userData = { fade: fadeU };
  return m as unknown as ScatterMaterial;
}
