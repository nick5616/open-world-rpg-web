// Terrain splat material (spec 12): MeshStandardMaterial (so sun, sky
// ambient, cascaded shadows and every later light work unchanged) with the
// map/normal/roughness chunks replaced by a splat blend over texture arrays:
//
//   - the generator's six weights (grass, dirt, rock, snow, sand, mud) pick
//     layers; biome splits grass into meadow grass / forest floor and rock
//     into highland rock / cliff / badlands cliff;
//   - rock on slopes steeper than ~50 degrees is sampled triplanar so cliffs
//     don't stretch (Golus-style whiteout normal blend);
//   - layers are height-blended (color alpha = height), so pebbles poke
//     through sand and grass fills rock cracks instead of a muddy crossfade;
//   - textureGrad everywhere: layers are sampled inside per-pixel branches,
//     where implicit derivatives are undefined (wrong mips at splat borders);
//   - until the arrays have loaded, flat per-layer mean colours (pbrMaterial
//     rule: no half-textured frames).
//
// Geomorphing (see tileMesh.ts): k = max(uK, edge factor) blends each vertex
// toward its coarser-lattice height and normal. uK animates 1 -> 0 when a
// tile replaces its parent; uEdge forces k = 1 on edges that border a coarser
// tile, so the shared edge is the coarser edge exactly. Both are per tile, so
// each tile has its own (cheap) material instance; they all share one
// compiled program through customProgramCacheKey.

import * as THREE from 'three';

/** Must equal tools/textures/sets.json terrain.layers. */
export const TERRAIN_LAYERS = ['grass-meadow', 'dirt', 'rock-highland', 'snow', 'sand', 'mud', 'forest-floor', 'rock-cliff', 'rock-badlands'] as const;
const NL = TERRAIN_LAYERS.length;

export interface TerrainShared {
  tColor: { value: THREE.Texture | null };
  tNormal: { value: THREE.Texture | null };
  tOrm: { value: THREE.Texture | null };
  uTexReady: { value: number };
  uFlat: { value: THREE.Color[] };
  /** World-space wetness 0..1 (rain, later); darkens albedo, lowers roughness (spec 12 "wet materials"). */
  uWet: { value: number };
}

export function makeTerrainShared(): TerrainShared {
  // Rough guesses until the manifest's measured means arrive.
  const flat = ['#5d6b3a', '#6b5440', '#5c5a55', '#e8ecf0', '#d8c8a8', '#5b4a38', '#4f4a30', '#7b746c', '#b07a62'].map((c) => new THREE.Color(c));
  return { tColor: { value: null }, tNormal: { value: null }, tOrm: { value: null }, uTexReady: { value: 0 }, uFlat: { value: flat }, uWet: { value: 0 } };
}

export interface TerrainTileUniforms {
  uK: { value: number };
  uEdge: { value: THREE.Vector4 };
}

const VERT_PARS = /* glsl */ `
attribute float aMorph;
attribute vec4 aNrm;
attribute vec4 aNrmC;
attribute vec4 aSplatA;
attribute vec4 aSplatB;
attribute vec4 aBiome;
attribute vec2 aGrid;
uniform float uK;
uniform vec4 uEdge;
varying vec4 vSplatA;
varying vec4 vSplatB;
varying vec4 vBiome;
varying vec3 vWPos;
varying vec3 vWNrm;
`;

const VERT_NORMAL = /* glsl */ `
float morphK = uK;
if (aGrid.x < 0.5) morphK = max(morphK, uEdge.x);
if (aGrid.x > 63.5) morphK = max(morphK, uEdge.y);
if (aGrid.y < 0.5) morphK = max(morphK, uEdge.z);
if (aGrid.y > 63.5) morphK = max(morphK, uEdge.w);
vec3 objectNormal = normalize(mix(aNrm.xyz, aNrmC.xyz, morphK));
`;

const VERT_BEGIN = /* glsl */ `
vec3 transformed = vec3(position.x, mix(position.y, aMorph, morphK), position.z);
vSplatA = aSplatA;
vSplatB = aSplatB;
vBiome = aBiome;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNrm = objectNormal;
`;

const FRAG_PARS = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray tColor;
uniform sampler2DArray tNormal;
uniform sampler2DArray tOrm;
uniform float uTexReady;
uniform vec3 uFlat[${NL}];
uniform float uWet;
varying vec4 vSplatA;
varying vec4 vSplatB;
varying vec4 vBiome;
varying vec3 vWPos;
varying vec3 vWNrm;
vec3 terrainN;
float terrainRough;
float terrainAO;

// Cheap value noise for macro variation (breaks texture tiling at distance).
float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1, 0)), u.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), u.x), u.y);
}
vec3 unpackN(vec3 c) { return c * 2.0 - 1.0; }
`;

// Layer indices (TERRAIN_LAYERS order).
const FRAG_MAP = /* glsl */ `
vec3 Ng = normalize(vWNrm);
float grass = vSplatA.x, dirt = vSplatA.y, rock = vSplatA.z, snow = vSplatA.w;
float sand = vSplatB.x, mud = vSplatB.y, moist = vSplatB.z, highl = vSplatB.w;
float forest = vBiome.x, badl = vBiome.y, wetl = vBiome.z;
// Cliff mask: slope > ~50 deg (cos 50 = 0.643) fades in between 46 and 56 deg.
float cliff = 1.0 - smoothstep(0.56, 0.70, Ng.y);
float w[${NL}];
w[0] = grass * (1.0 - forest);
w[1] = dirt;
w[2] = rock * (1.0 - cliff);
w[3] = snow;
w[4] = sand;
w[5] = mud;
w[6] = grass * forest;
w[7] = rock * cliff * (1.0 - badl);
w[8] = rock * cliff * badl;
// Steep ground is rock whatever the splat says (overhang-ish edges of river cuts).
float steep = 1.0 - smoothstep(0.42, 0.55, Ng.y);
for (int i = 0; i < ${NL}; i++) if (i != 7 && i != 8) w[i] *= 1.0 - steep;
w[7] += steep * (1.0 - badl);
w[8] += steep * badl;

float camDist = length(vWPos - cameraPosition);
vec3 albedo = vec3(0.0);
terrainN = Ng;
terrainRough = 0.9;
terrainAO = 1.0;

if (uTexReady < 0.5) {
  float ws = 0.0;
  for (int i = 0; i < ${NL}; i++) { albedo += w[i] * uFlat[i]; ws += w[i]; }
  albedo /= max(ws, 1e-3);
} else {
  // Planar UVs: 1 texture repeat per 4 m; cliffs 1 per 9 m (triplanar).
  vec2 uv = vWPos.xz * 0.25;
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec3 tp = vWPos / 9.0;
  vec3 dpx = dFdx(tp), dpy = dFdy(tp);
  vec3 tw = pow(abs(Ng), vec3(4.0));
  tw /= tw.x + tw.y + tw.z;

  vec4 col[${NL}];
  float hs[${NL}];
  float hmax = -1.0;
  for (int i = 0; i < ${NL}; i++) {
    hs[i] = -10.0;
    col[i] = vec4(0.0);
    if (w[i] < 0.004) continue;
    vec4 c;
    if (i >= 7) {
      c = textureGrad(tColor, vec3(tp.zy, float(i)), dpx.zy, dpy.zy) * tw.x
        + textureGrad(tColor, vec3(tp.xz, float(i)), dpx.xz, dpy.xz) * tw.y
        + textureGrad(tColor, vec3(tp.xy, float(i)), dpx.xy, dpy.xy) * tw.z;
    } else {
      c = textureGrad(tColor, vec3(uv, float(i)), dx, dy);
    }
    col[i] = c;
    hs[i] = w[i] + c.a * 0.6;
    hmax = max(hmax, hs[i]);
  }
  // Height blend: only layers within 0.25 of the tallest survive.
  float bs = 0.0;
  float b[${NL}];
  for (int i = 0; i < ${NL}; i++) { b[i] = max(hs[i] - hmax + 0.25, 0.0); bs += b[i]; }
  vec3 nsum = vec3(0.0);
  vec3 orm = vec3(0.0);
  for (int i = 0; i < ${NL}; i++) {
    if (b[i] <= 0.0) continue;
    float bi = b[i] / bs;
    albedo += col[i].rgb * bi;
    if (i >= 7) {
      orm += (textureGrad(tOrm, vec3(tp.zy, float(i)), dpx.zy, dpy.zy).rgb * tw.x
            + textureGrad(tOrm, vec3(tp.xz, float(i)), dpx.xz, dpy.xz).rgb * tw.y
            + textureGrad(tOrm, vec3(tp.xy, float(i)), dpx.xy, dpy.xy).rgb * tw.z) * bi;
      #ifdef TERRAIN_NORMALS
      vec3 tnX = unpackN(textureGrad(tNormal, vec3(tp.zy, float(i)), dpx.zy, dpy.zy).rgb);
      vec3 tnY = unpackN(textureGrad(tNormal, vec3(tp.xz, float(i)), dpx.xz, dpy.xz).rgb);
      vec3 tnZ = unpackN(textureGrad(tNormal, vec3(tp.xy, float(i)), dpx.xy, dpy.xy).rgb);
      // Whiteout blend (Golus, "Normal Mapping for a Triplanar Shader").
      tnX = vec3(tnX.xy + Ng.zy, abs(tnX.z) * Ng.x);
      tnY = vec3(tnY.xy + Ng.xz, abs(tnY.z) * Ng.y);
      tnZ = vec3(tnZ.xy + Ng.xy, abs(tnZ.z) * Ng.z);
      nsum += normalize(tnX.zyx * tw.x + tnY.xzy * tw.y + tnZ.xyz * tw.z) * bi;
      #else
      nsum += Ng * bi;
      #endif
    } else {
      orm += textureGrad(tOrm, vec3(uv, float(i)), dx, dy).rgb * bi;
      #ifdef TERRAIN_NORMALS
      vec3 tn = unpackN(textureGrad(tNormal, vec3(uv, float(i)), dx, dy).rgb);
      // Planar xz frame: u = +x, image-up (green) = -z (flipY is off for KTX2).
      vec3 T = normalize(vec3(1.0, 0.0, 0.0) - Ng * Ng.x);
      vec3 B = cross(Ng, T);
      nsum += (T * tn.x + B * tn.y + Ng * tn.z) * bi;
      #else
      nsum += Ng * bi;
      #endif
    }
  }
  terrainN = normalize(nsum);
  terrainAO = mix(1.0, orm.r, 0.8);
  terrainRough = orm.g;
  // Far away, fade normal detail (it only shimmers) and add macro variation.
  float far = smoothstep(120.0, 600.0, camDist);
  terrainN = normalize(mix(terrainN, Ng, far * 0.7));
}

// Grass colour from moisture and biome: dry is straw, wet is deep green.
float gw = (w[0] + w[6] * 0.5) / max(w[0] + w[1] + w[2] + w[3] + w[4] + w[5] + w[6] + w[7] + w[8], 1e-3);
vec3 lush = mix(vec3(1.02, 1.12, 0.62), vec3(0.78, 1.08, 0.62), wetl);
vec3 dry = vec3(1.28, 1.08, 0.62);
vec3 grassTint = mix(dry, lush, smoothstep(0.15, 0.6, moist + wetl * 0.3));
grassTint = mix(grassTint, grassTint * vec3(0.92, 0.98, 1.02), highl);
grassTint = mix(grassTint, vec3(1.25, 1.0, 0.65), badl);
albedo *= mix(vec3(1.0), grassTint, gw);
float macro = tNoise(vWPos.xz * 0.012) * 0.6 + tNoise(vWPos.xz * 0.05) * 0.4;
albedo *= 0.82 + 0.36 * macro;
// Wet ground: darker, glossier.
albedo *= 1.0 - 0.35 * uWet;
terrainRough = mix(terrainRough, terrainRough * 0.35, uWet);
diffuseColor.rgb *= albedo;
`;

const FRAG_ROUGH = /* glsl */ `
float roughnessFactor = clamp(roughness * terrainRough, 0.04, 1.0);
`;
const FRAG_METAL = /* glsl */ `
float metalnessFactor = 0.0;
`;
const FRAG_NORMAL = /* glsl */ `
normal = normalize((viewMatrix * vec4(terrainN, 0.0)).xyz);
`;
const FRAG_AO = /* glsl */ `
reflectedLight.indirectDiffuse *= terrainAO;
reflectedLight.indirectSpecular *= terrainAO;
`;

export interface TerrainMaterial extends THREE.MeshStandardMaterial {
  userData: { tile: TerrainTileUniforms };
}

/** One per tile; all share one program. */
export function createTerrainMaterial(shared: TerrainShared, normalMaps: boolean): TerrainMaterial {
  const tile: TerrainTileUniforms = { uK: { value: 0 }, uEdge: { value: new THREE.Vector4() } };
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 }) as TerrainMaterial;
  m.userData.tile = tile;
  if (normalMaps) m.defines = { TERRAIN_NORMALS: '' };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, tile);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <beginnormal_vertex>', VERT_NORMAL)
      .replace('#include <begin_vertex>', VERT_BEGIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <metalnessmap_fragment>', FRAG_METAL)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <aomap_fragment>', FRAG_AO);
  };
  m.customProgramCacheKey = () => `lodestone-terrain-1${normalMaps ? 'n' : ''}`;
  return m;
}

/** Use the measured mean colour of each layer as its flat fallback (manifest from the texture build). */
export function applyManifestMeans(shared: TerrainShared, mean: Record<string, [number, number, number]>): void {
  TERRAIN_LAYERS.forEach((id, i) => {
    const c = mean[id];
    // Means are of sRGB bytes; the shader works in linear.
    if (c) shared.uFlat.value[i].setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
  });
}
