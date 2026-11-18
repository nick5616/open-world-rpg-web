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
          // Playtest 5: every tree has its own green (hashed from where it stands): some yellower, some bluer and darker.
          vec2 ip = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
          float vh1 = fract(sin(dot(ip, vec2(12.9898, 78.233))) * 43758.5453);
          float vh2 = fract(sin(dot(ip, vec2(39.346, 11.135))) * 24634.6345);
          vec3 treeVar = vec3(0.86 + 0.28 * vh1, 0.93 + 0.13 * vh2, 0.72 + 0.42 * vh2 * (1.0 - vh1));
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb * treeVar, aFoliage);
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
        bend *= mix(1.0, uWindSweep.x, 0.5); // playtest 2 styles (wind.ts uWindSweep)
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
  m.customProgramCacheKey = () => `lodestone-scatter-2-${o.doubleSided ? 'ds' : 'fs'}`;
  return m;
}

// ---------------------------------------------------------------------------
// Rich vegetation (playtest 3, CR 045). The same family, plus: an alpha-tested
// leaf atlas, bark (aFoliage 0 vertices sample a tiling bark texture and get a
// derivative bump), leaf translucency (sun shining through leaves toward the
// camera; the sun and sky come from the same uniforms as the impostors),
// soft crown normals lit from both sides, branch-level wind (aCard.y), and a
// triplanar stone with moss/snow caps for rocks. No lights are added: the
// translucency is an emissive term from the one sun direction.

export interface RichLight {
  uSunDir: { value: THREE.Vector3 };
  uLightColor: { value: THREE.Color };
  uAmbient: { value: THREE.Color };
}

export interface RichOptions extends ScatterMaterialOptions {
  light: RichLight;
  mode: 'tree' | 'rock' | 'grass';
  atlas?: THREE.Texture;
  bark?: THREE.Texture;
  stone?: THREE.Texture;
  /** Leaf translucency strength (0 off). */
  translucency?: number;
  /** Branch sway (fraction of instance height per m/s of wind, scaled by aCard.y^2). */
  branch?: number;
  bump?: number;
  moss?: number;
  snow?: number;
}

/** Shared by the instanced rich materials and the dense-grass material (which has no instanceMatrix). */
export function applyRichShader(shader: { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string }, o: RichOptions): void {
  const tree = o.mode === 'tree';
  const rock = o.mode === 'rock';
  Object.assign(shader.uniforms, {
    uSunDir: o.light.uSunDir,
    uLightColor: o.light.uLightColor,
    uTrans: { value: o.translucency ?? 0 },
    uBranch: { value: o.branch ?? 0 },
    uBump: { value: o.bump ?? 0 },
    uMoss: { value: o.moss ?? 0 },
    uSnow: { value: o.snow ?? 0 },
    uBark: { value: o.bark ?? null },
    uStone: { value: o.stone ?? null },
  });
  shader.vertexShader = shader.vertexShader
    .replace(
      'varying float vFade;',
      `varying float vFade;
      attribute vec2 aBarkUv;
      attribute vec2 aCard;
      uniform float uBranch;
      varying vec2 vBarkUv;
      varying float vBark;
      varying float vAO;
      varying vec3 vObjP;
      varying vec3 vObjN;`,
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vBarkUv = aBarkUv;
      vBark = step(0.25, aBarkUv.x);
      vAO = dot(color.rgb, vec3(0.3333));
      ${
        rock
          ? `vObjN = normal;
      vObjP = transformed * vec3(length(vec3(instanceMatrix[0])), length(vec3(instanceMatrix[1])), length(vec3(instanceMatrix[2])));`
          : 'vObjN = normal; vObjP = transformed;'
      }`,
    );
  if (tree) {
    shader.vertexShader = shader.vertexShader.replace(
      'vec2 bend = w * uSway * hk * hk * iH;',
      `vec2 bend = w * uSway * hk * hk * iH;
        bend += w * uBranch * aCard.y * aCard.y * iH * (0.55 + 0.45 * sin(uWindTime * 1.9 + aCard.x + iPos.x * 0.3));`,
    );
  }
  const F = /* glsl */ `
    uniform sampler2D uBark;
    uniform sampler2D uStone;
    uniform vec3 uSunDir;
    uniform vec3 uLightColor;
    uniform float uTrans;
    uniform float uBump;
    uniform float uMoss;
    uniform float uSnow;
    varying vec2 vBarkUv;
    varying float vBark;
    varying float vAO;
    varying vec3 vObjP;
    varying vec3 vObjN;
    float surfH = 0.0;
    vec3 perturbSurf(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDirection) {
      // normalize() of a zero vector is undefined (NaN on Mesa / NVIDIA GL): a sub-pixel or
      // edge-on triangle has zero screen derivatives, and det = 0 zeroes the result below.
      vec3 sx = dFdx(surfPos);
      vec3 sy = dFdy(surfPos);
      sx /= max(length(sx), 1e-12);
      sy /= max(length(sy), 1e-12);
      vec3 r1 = cross(sy, surfNorm);
      vec3 r2 = cross(surfNorm, sx);
      float det = dot(sx, r1) * faceDirection;
      vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
      vec3 bent = abs(det) * surfNorm - grad;
      float bl = length(bent);
      return bl > 1e-6 ? bent / bl : surfNorm;
    }
  `;
  let mapFrag: string;
  if (rock) {
    mapFrag = `
      vec3 bw = pow(abs(vObjN), vec3(4.0));
      bw /= (bw.x + bw.y + bw.z + 1e-4);
      vec3 sp = vObjP * 0.42;
      vec3 stoneC = texture2D(uStone, sp.zy).rgb * bw.x + texture2D(uStone, sp.xz).rgb * bw.y + texture2D(uStone, sp.xy).rgb * bw.z;
      float lum = dot(stoneC, vec3(0.3333));
      surfH = lum;
      float upN = normalize(vObjN).y;
      float capAmt = smoothstep(0.42, 0.78, upN + (lum - 0.3) * 1.1);
      vec3 albedo = stoneC * 2.1;
      albedo = mix(albedo, vec3(0.05, 0.12, 0.022) * (0.5 + lum * 4.0), capAmt * uMoss);
      albedo = mix(albedo, vec3(0.62, 0.66, 0.72), smoothstep(0.25, 0.6, upN + (lum - 0.3) * 0.9) * uSnow);
      diffuseColor *= vec4(albedo, 1.0);
    `;
  } else {
    mapFrag = `
      #ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D(map, vMapUv, -0.4);
        if (vBark > 0.5) {
          vec3 bk = texture2D(uBark, vBarkUv).rgb;
          surfH = dot(bk, vec3(0.3333));
          ${
            tree
              ? `// Playtest 5: bark depth and grime. Grooves (dark texels) go darker, ridges catch light, and the base of the
          // trunk is damp: darker, greener, a little moss on the side facing away from the sun.
          bk *= 0.62 + 0.9 * smoothstep(0.04, 0.34, surfH);
          float baseK = 1.0 - smoothstep(0.0, 0.1, vObjP.y);
          bk = mix(bk, bk * vec3(0.5, 0.66, 0.34), baseK * 0.75);`
              : ''
          }
          sampledDiffuseColor = vec4(bk, 1.0);
        }
        diffuseColor *= sampledDiffuseColor;
      #endif
    `;
  }
  const normalBegin = tree || o.mode === 'grass' ? THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0') : '#include <normal_fragment_begin>';
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
${F}`)
    .replace('#include <map_fragment>', mapFrag)
    .replace('#include <normal_fragment_begin>', normalBegin)
    .replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
      #ifndef FLAT_SHADED
        if (uBump > 0.0 && surfH > 0.0) {
          float near = 1.0 - smoothstep(25.0, 70.0, length(vViewPosition));
          normal = perturbSurf(-vViewPosition, normal, vec2(dFdx(surfH), dFdy(surfH)) * uBump * near, faceDirection);
        }
      #endif`,
    )
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      ${
        tree || o.mode === 'grass'
          ? `if (uTrans > 0.0 && vBark < 0.5) {
        vec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
        vec3 vd = normalize(vViewPosition);
        // Looking toward the sun through a leaf: light comes out of its far side.
        float sunUp = clamp(uSunDir.y * 3.0 + 0.1, 0.0, 1.0);
        float tr = pow(clamp(dot(vd, -sunV), 0.0, 1.0), 2.5) * sunUp;
        // Playtest 5: subsurface. Leaves on the side facing away from the sun glow yellow-green with the light that came through
        // them even when you are not looking at the sun, and sun-facing interior leaves stay in shade (occlusion from the baked tone).
        float away = clamp(0.5 - 0.5 * dot(normalize(normal), sunV), 0.0, 1.0);
        vec3 sss = diffuseColor.rgb * vec3(1.12, 1.0, 0.42);
        totalEmissiveRadiance += diffuseColor.rgb * uLightColor * (tr * uTrans * vAO * vAO);
        totalEmissiveRadiance += sss * uLightColor * (away * away * sunUp * uTrans * 0.38 * smoothstep(0.25, 0.8, vAO));
      }`
          : ''
      }`,
    );
}

export function createRichMaterial(o: RichOptions): ScatterMaterial {
  const m = createScatterMaterial({ ...o, doubleSided: o.doubleSided ?? o.mode !== 'rock' });
  if (o.atlas) {
    m.map = o.atlas;
    m.alphaTest = 0.42;
  }
  const base = m.onBeforeCompile;
  m.onBeforeCompile = (shader, r) => {
    base.call(m, shader, r);
    applyRichShader(shader as never, o);
  };
  m.customProgramCacheKey = () => `lodestone-rich-1-${o.mode}-${o.doubleSided ?? o.mode !== 'rock' ? 'ds' : 'fs'}-${o.translucency ? 't' : ''}${o.bump ? 'b' : ''}`;
  return m;
}

/**
 * Billboard impostors for trees beyond the mesh distance: one camera-facing
 * (cylindrical) quad per instance, textured from an impostor atlas rendered
 * at load (impostors.ts), lit with the sun and sky ambient.
 */
export function createBillboardMaterial(atlas: THREE.Texture, tile: number, tiles: number, fade: THREE.Vector4, light: { uSunDir: { value: THREE.Vector3 }; uLightColor: { value: THREE.Color }; uAmbient: { value: THREE.Color } }, views = 1): ScatterMaterial {
  const fadeU = { value: fade.clone() };
  const m = new THREE.ShaderMaterial({
    uniforms: { ...windUniforms, ...light, uAtlas: { value: atlas }, uTile: { value: tile }, uTiles: { value: tiles }, uFade: fadeU, uViews: { value: views } },
    vertexShader: /* glsl */ `
      ${WIND_GLSL}
      uniform vec4 uFade;
      uniform float uViews;
      varying vec2 vUv;
      varying float vFade;
      varying vec3 vTint;
      varying float vView;
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
        // Which baked view: the camera's direction in the tree's own frame (the instance yaw), as a fraction of the view ring.
        vView = 0.0;
        if (uViews > 1.5) {
          vec3 ax = vec3(instanceMatrix[0]);
          vec3 az = vec3(instanceMatrix[2]);
          vec3 tc = cameraPosition - iPos;
          vec2 d = vec2(dot(tc, ax) / max(dot(ax, ax), 1e-6), dot(tc, az) / max(dot(az, az), 1e-6));
          d /= max(length(d), 1e-5);
          float th = atan(-d.x, d.y + 1e-6);
          vView = fract(th / 6.2831853) * uViews;
        }
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
      uniform float uViews;
      uniform vec3 uSunDir;
      uniform vec3 uLightColor;
      uniform vec3 uAmbient;
      varying vec2 vUv;
      varying float vFade;
      varying vec3 vTint;
      varying float vView;
      ${DITHER}
      void main() {
        // Two neighbouring baked views, picked per pixel by dither so the cut-out alpha stays a clean edge.
        float v0 = floor(vView);
        float fv = vView - v0;
        float row = v0;
        if (uViews > 1.5 && bayer4(gl_FragCoord.xy + vec2(2.0, 1.0)) < fv) row = mod(v0 + 1.0, uViews);
        vec4 c = texture2D(uAtlas, vec2((uTile + vUv.x) / uTiles, (row + vUv.y) / max(uViews, 1.0)));
        if (c.a < 0.5) discard;
        if (vFade < 0.999 && bayer4(gl_FragCoord.xy) >= vFade) discard;
        // At impostor distance the trunk is a few pixels: tinting the whole card is fine.
        vec3 albedo = c.rgb * mix(vec3(1.0), vTint, 0.85);
        float sun = 0.55 + 0.45 * max(uSunDir.y, 0.0);
        // Matched by eye to the LOD1 meshes under the standard material at the 200 m swap.
        vec3 lit = albedo * (uAmbient * 0.42 + uLightColor * sun * 0.38);
        gl_FragColor = vec4(lit, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  (m as unknown as ScatterMaterial).userData = { fade: fadeU };
  return m as unknown as ScatterMaterial;
}
