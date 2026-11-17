// Materials of the vertical world (CR 038). Rock and island surfaces are
// MeshStandardMaterial (lit by the sun, the cave light pool and the lantern,
// shadowed by the CSM on islands) with vertex colours, world-space detail
// noise and the baked glow from layerMesh.ts as emissive. Water glows
// turquoise in the dark (the blue caves), lava burns; both are cheap
// ShaderMaterials that write depth so the post-chain fog reaches them.

import * as THREE from 'three';

/** Shared, updated once per frame by the VerticalManager. */
export const verticalUniforms = {
  uTime: { value: 0 },
  /** Gain of the baked crystal / lake / lava glow. */
  uGlowGain: { value: 1 },
  /** Daylight through cenote shafts (sky colour x intensity, linear). */
  uDayGlow: { value: new THREE.Color(0, 0, 0) },
  /** Sky islands: how much of the sky light the undersides catch (dims at night). */
  uSkyFill: { value: 1 },
};

const NOISE = /* glsl */ `
float vtHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vtNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(vtHash(i), vtHash(i + vec3(1,0,0)), f.x), mix(vtHash(i + vec3(0,1,0)), vtHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(vtHash(i + vec3(0,0,1)), vtHash(i + vec3(1,0,1)), f.x), mix(vtHash(i + vec3(0,1,1)), vtHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;

/**
 * Cavern and Depths rock: vertex colour x detail noise, emissive = baked glow
 * x gain + daylight under cenote shafts. `deep` darkens and adds glowing
 * cracks (magma veins) to the Depths' basalt.
 */
export function layerRockMaterial(deep: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: deep ? 0.78 : 0.9, metalness: 0 });
  m.defines = { LS_NO_RIM: '' };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGlowGain = verticalUniforms.uGlowGain;
    sh.uniforms.uDayGlow = verticalUniforms.uDayGlow;
    sh.uniforms.uTime = verticalUniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aGlow;\nvarying vec4 vGlow;\nvarying vec3 vVtWorld;\nvarying vec3 vVtN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;\nvVtWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvVtN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uGlowGain;\nuniform vec3 uDayGlow;\nuniform float uTime;\nvarying vec4 vGlow;\nvarying vec3 vVtWorld;\nvarying vec3 vVtN;\n${NOISE}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float n = vtNoise(vVtWorld * 0.9) * 0.5 + vtNoise(vVtWorld * 3.7) * 0.32 + vtNoise(vVtWorld * 0.21) * 0.18;
  diffuseColor.rgb *= 0.55 + 0.8 * n;
  // CR 043: carved flagstones on the dwarven halls' floors (the mesh marks them with a negative day weight):
  // running-bond slabs, dark joints, a tone per stone, worn in the middle of the paths.
  float stoneW = max(-vGlow.a, 0.0);
  if (stoneW > 0.0) {
    vec2 sp = vVtWorld.xz / vec2(1.9, 1.15);
    float srow = floor(sp.y);
    sp.x += srow * 0.5 + fract(sin(srow * 12.9898) * 43758.5453) * 0.37;
    vec2 scell = floor(sp);
    vec2 sf = fract(sp);
    float sh = fract(sin(dot(scell, vec2(127.1, 311.7))) * 43758.5453);
    float sedge = min(min(sf.x, 1.0 - sf.x) * 1.9, min(sf.y, 1.0 - sf.y) * 1.15);
    float joint = smoothstep(0.015, 0.06, sedge);
    float wear = vtNoise(vVtWorld * 0.55) * 0.5 + vtNoise(vVtWorld * 2.3) * 0.3;
    vec3 tone = diffuseColor.rgb * (0.75 + 0.55 * sh) * (0.8 + 0.35 * wear);
    tone *= 0.9 + 0.12 * smoothstep(0.0, 0.5, sedge);
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(tone * 0.3, tone, joint), stoneW);
  }
  // Pale mineral streaks down the walls.
  float streak = smoothstep(0.66, 0.82, vtNoise(vec3(vVtWorld.x * 0.08, vVtWorld.y * 0.6, vVtWorld.z * 0.08)));
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.35 + 0.01, streak * (1.0 - abs(vVtN.y)) * 0.5);
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  vec3 g = vGlow.rgb * uGlowGain;
  totalEmissiveRadiance += diffuseColor.rgb * g * 2.0 + g * 0.035;
  // The dark itself has a little light (rock reads as rock, never a hole).
  totalEmissiveRadiance += diffuseColor.rgb * 0.45 + vec3(0.002, 0.004, 0.006);
  totalEmissiveRadiance += diffuseColor.rgb * uDayGlow * max(vGlow.a, 0.0);
  ${deep ? `// Magma veins in the basalt: a few glowing cracks low on the walls that breathe.
  float c = vtNoise(vVtWorld * 0.06);
  float crack = smoothstep(0.485, 0.5, c) * (1.0 - smoothstep(0.5, 0.515, c));
  float low = smoothstep(0.85, 0.2, abs(vVtN.y)) * smoothstep(0.55, 0.8, vtNoise(vVtWorld * 0.02 + 3.0));
  totalEmissiveRadiance += vec3(1.0, 0.3, 0.05) * crack * low * (0.8 + 0.3 * sin(uTime * 1.3 + vVtWorld.x * 0.05)) * 1.2;` : ''}
}`,
      );
  };
  m.customProgramCacheKey = () => `vt-rock-${deep ? 1 : 0}-v2`;
  return m;
}

/** Sky island top and underside: vertex colours, detail noise, CSM-shadowed (setup by WorldScene). */
export function islandMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSkyFill = verticalUniforms.uSkyFill;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vVtWorld;\nvarying vec3 vVtN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvVtWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvVtN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uSkyFill;\nvarying vec3 vVtWorld;\nvarying vec3 vVtN;\n${NOISE}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float n = vtNoise(vVtWorld * 0.45) * 0.4 + vtNoise(vVtWorld * 2.3) * 0.3 + vtNoise(vVtWorld * 9.0) * 0.18 + vtNoise(vVtWorld * 31.0) * 0.12;
  diffuseColor.rgb *= 0.6 + 0.75 * n;
  if (vVtN.y > 0.5) {
    // Grass grain: fine streaks and darker clumps (a lawn seen up close, not a felt).
    float blades = vtNoise(vec3(vVtWorld.x * 7.0, 0.0, vVtWorld.z * 1.7)) * vtNoise(vec3(vVtWorld.x * 1.9, 3.0, vVtWorld.z * 7.3));
    diffuseColor.rgb *= 0.78 + 0.5 * blades;
  }
  if (vVtN.y < -0.2) {
    // Underside: layered earth and stone, dark at the tips.
    float strata = 0.82 + 0.3 * sin(vVtWorld.y * 0.7 + n * 4.0);
    diffuseColor.rgb *= strata;
  }
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
// Undersides catch a little sky bounce (they would read black against the sky otherwise).
totalEmissiveRadiance += diffuseColor.rgb * vec3(0.16, 0.19, 0.24) * uSkyFill * smoothstep(-0.2, -0.9, vVtN.y);`,
      );
  };
  m.customProgramCacheKey = () => 'vt-island-v1';
  return m;
}

const WATER_VS = /* glsl */ `
attribute float aDepth;
varying float vDepth;
varying vec3 vWorld;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vDepth = aDepth;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

/** The blue caves: glowing turquoise water, clear in the shallows, ripples and caustic shimmer. */
export function caveWaterMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: verticalUniforms.uTime, uGlowGain: verticalUniforms.uGlowGain, uDayGlow: verticalUniforms.uDayGlow },
    vertexShader: WATER_VS,
    fragmentShader: /* glsl */ `
uniform float uTime;
uniform float uGlowGain;
uniform vec3 uDayGlow;
varying float vDepth;
varying vec3 vWorld;
#include <logdepthbuf_pars_fragment>
${NOISE}
void main() {
  #include <logdepthbuf_fragment>
  vec3 V = normalize(cameraPosition - vWorld);
  float t = uTime;
  vec2 p = vWorld.xz;
  float r1 = vtNoise(vec3(p * 0.18, t * 0.25));
  float r2 = vtNoise(vec3(p * 0.6 + 7.0, t * 0.6));
  vec3 N = normalize(vec3((r1 - 0.5) * 0.35 + (r2 - 0.5) * 0.15, 1.0, (r2 - 0.5) * 0.35 - (r1 - 0.5) * 0.12));
  float fres = pow(clamp(1.0 - dot(N, V), 0.0, 1.0), 3.0);
  float d = clamp(vDepth / 8.0, 0.0, 1.0);
  vec3 shallow = vec3(0.05, 0.42, 0.40);
  vec3 deepc = vec3(0.004, 0.07, 0.14);
  vec3 col = mix(shallow, deepc, sqrt(d));
  // Caustic shimmer: bright threads that drift.
  float c = vtNoise(vec3(p * 0.9, t * 0.8)) * vtNoise(vec3(p * 1.7 + 3.0, -t * 0.6));
  col += vec3(0.12, 0.42, 0.40) * smoothstep(0.34, 0.56, c) * (1.0 - d * 0.7);
  vec3 glow = col * (0.6 + 0.4 * uGlowGain);
  glow += vec3(0.25, 0.45, 0.55) * fres * 0.25;
  float a = mix(0.5, 0.9, d) + fres * 0.1;
  gl_FragColor = vec4(glow, clamp(a, 0.0, 1.0));
}`,
    transparent: true,
    depthWrite: true,
  });
}

/** The Depths' lava: crusted, flowing, bright where it cracks. */
export function lavaMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: verticalUniforms.uTime },
    vertexShader: WATER_VS,
    fragmentShader: /* glsl */ `
uniform float uTime;
varying float vDepth;
varying vec3 vWorld;
#include <logdepthbuf_pars_fragment>
${NOISE}
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = vWorld.xz;
  float t = uTime;
  float flow = vtNoise(vec3(p * 0.07 + vec2(t * 0.05, t * 0.03), t * 0.05));
  float crust = vtNoise(vec3(p * 0.3 - vec2(t * 0.02, 0.0), t * 0.1));
  float cells = smoothstep(0.38, 0.62, crust);
  vec3 hot = vec3(1.25, 0.3, 0.045);
  vec3 cool = vec3(0.05, 0.012, 0.008);
  // Black crust plates drifting on the melt; bright seams between them.
  float plates = smoothstep(0.3, 0.55, crust) * smoothstep(0.25, 0.6, vtNoise(vec3(p * 0.12 + 7.0, t * 0.03)));
  vec3 col = mix(hot * (0.55 + 0.7 * flow), cool, plates);
  col += vec3(1.5, 0.4, 0.05) * pow(max(1.0 - abs(crust - 0.42) * 2.0, 0.0), 14.0) * (1.0 - plates * 0.6);
  gl_FragColor = vec4(col, 1.0);
}`,
  });
}
