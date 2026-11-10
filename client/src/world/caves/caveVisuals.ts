// Cave materials and geometry (WP09, spec 7 "Light and sound underground",
// spec 12 "bloom for gems"). Underground there is no sun or sky light, so
// what you see by is emissive: gems and fungi glow (nearly free), and up to
// 8 pooled point lights borrow their colors near the camera.

import * as THREE from 'three';

/** Gem colors by gem id (worldgen GEM_NAMES order) and their glow. */
export const GEM_COLORS: readonly [string, string][] = [
  ['#e0115f', '#ff3a6e'], // ruby
  ['#1f5fd6', '#4d8cff'], // sapphire
  ['#ffc23d', '#ffd36b'], // topaz
  ['#2fbf68', '#4dff98'], // emerald
  ['#6fe8d0', '#9ffff0'], // aquamarine
  ['#ff9f3a', '#ffc070'], // sunstone
  ['#2c2838', '#7a4dff'], // onyx: dark stone, violet glint
  ['#9b5de5', '#c38bff'], // amethyst
  ['#efe6ff', '#b8f0ff'], // opal
  ['#cfdcff', '#e8f0ff'], // moonstone
];

/** Ore looks by ore id (copper, iron, silver, sunsteel, starmetal, voidglass): color, metalness, glow. */
export const ORE_LOOKS: readonly { color: string; emissive: string; glow: number }[] = [
  { color: '#c06a2f', emissive: '#000000', glow: 0 },
  { color: '#8c939d', emissive: '#000000', glow: 0 },
  { color: '#e3e8ee', emissive: '#203040', glow: 0.15 },
  { color: '#ffd27a', emissive: '#ffb030', glow: 0.9 }, // sunsteel: holds daylight
  { color: '#a8c8ff', emissive: '#6080ff', glow: 0.5 },
  { color: '#2a1040', emissive: '#a040ff', glow: 1.0 }, // voidglass
];

/** Element tints for fungi and deco crystals (fire, ice, lightning, earth, wind, light, dark, void). */
export const ELEMENT_GLOW = ['#ff7a3a', '#7fd8ff', '#ffe14a', '#8cff6a', '#b8fff0', '#fff2b0', '#b06aff', '#e04aff'] as const;

/**
 * Hexagonal bipyramid, the cut-gem silhouette.
 * adapted from wizard-wars client/src/utils/rupeeGeometry.ts
 */
export function rupeeGeometry(radius = 0.5, height = 0.85): THREE.BufferGeometry {
  const segments = 6;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pos.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
  }
  pos.push(0, height * 0.55, 0, 0, -height * 0.45, 0);
  for (let i = 0; i < segments; i++) {
    const a = i, b = (i + 1) % segments;
    idx.push(segments, a, b, segments + 1, b, a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  // Non-indexed so every facet has its own flat normal (three's flatShading
  // would do it per fragment; this keeps instanced draws simple).
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

/** A long gem crystal: the bipyramid stretched along +y (clusters stand on the wall normal). */
export function crystalGeometry(): THREE.BufferGeometry {
  const g = rupeeGeometry(0.16, 0.9);
  g.translate(0, 0.32, 0);
  return g;
}

/** Lumpy ore nugget: a low-poly icosahedron with seeded vertex jitter, flat-shaded. */
export function nuggetGeometry(seed = 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.22, 0).toNonIndexed();
  const p = g.attributes.position as THREE.BufferAttribute;
  let s = seed * 2654435761;
  const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const jit = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!jit.has(k)) jit.set(k, 0.75 + r() * 0.5);
    const f = jit.get(k)!;
    p.setXYZ(i, p.getX(i) * f, p.getY(i) * f * 0.8, p.getZ(i) * f);
  }
  g.computeVertexNormals();
  return g;
}

/** Glowing mushroom: stem + cap, merged into one geometry (cap vertices tagged for the glow). */
export function mushroomGeometry(): THREE.BufferGeometry {
  const stem = new THREE.CylinderGeometry(0.035, 0.05, 0.22, 6).translate(0, 0.11, 0).toNonIndexed();
  const cap = new THREE.SphereGeometry(0.13, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.55, 1).translate(0, 0.21, 0).toNonIndexed();
  const merged = new THREE.BufferGeometry();
  const ps = [stem.attributes.position.array as Float32Array, cap.attributes.position.array as Float32Array];
  const pos = new Float32Array(ps[0].length + ps[1].length);
  pos.set(ps[0]);
  pos.set(ps[1], ps[0].length);
  const glow = new Float32Array(pos.length / 3);
  glow.fill(0.25, 0, ps[0].length / 3);
  glow.fill(1, ps[0].length / 3);
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('aGlow', new THREE.BufferAttribute(glow, 1));
  merged.computeVertexNormals();
  return merged;
}

/** Boulder for arches and rims: jittered icosahedron. */
export function boulderGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 0.82 + 0.3 * Math.abs(Math.sin(x * 4.1 + y * 2.3) * Math.cos(z * 3.7 - y * 1.9));
    p.setXYZ(i, x * n, y * n * 0.85, z * n);
  }
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

/**
 * Cave rock: dark, rough, flat-shaded (faceted, like the rest of the
 * low-poly world, and it makes the 2 m surface-nets shape read under a
 * single light), varied by a cheap 3D value noise in world space
 * (triplanar-free: the noise is volumetric, so walls never stretch), banded
 * strata, damp floors, and colder, darker stone in deeper bands (the
 * per-vertex band byte the generator writes).
 */
export function caveRockMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x8c8176, roughness: 0.93, metalness: 0.0, flatShading: true });
  m.defines = { LS_NO_RIM: '' }; // caves stay lit by the lantern alone (style/styleShader.ts)
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aBand;\nvarying vec3 vCaveWorld;\nvarying vec3 vCaveN;\nvarying float vBand;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCaveWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvCaveN = normal;\nvBand = aBand;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vCaveWorld;
varying vec3 vCaveN;
varying float vBand;
float caveHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float caveNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(caveHash(i), caveHash(i + vec3(1,0,0)), f.x), mix(caveHash(i + vec3(0,1,0)), caveHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(caveHash(i + vec3(0,0,1)), caveHash(i + vec3(1,0,1)), f.x), mix(caveHash(i + vec3(0,1,1)), caveHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float n = caveNoise(vCaveWorld * 1.7) * 0.45 + caveNoise(vCaveWorld * 5.3) * 0.35 + caveNoise(vCaveWorld * 0.4) * 0.2;
  float strata = 0.5 + 0.5 * sin(vCaveWorld.y * 1.3 + caveNoise(vCaveWorld * 0.35) * 5.0);
  vec3 col = diffuseColor.rgb * (0.55 + 0.6 * n) * (0.85 + 0.25 * strata);
  float band = clamp(vBand * 127.0 / 2.0, 0.0, 1.0);
  col = mix(col, col * vec3(0.62, 0.68, 0.82), band);
  float floorW = smoothstep(0.55, 0.9, vCaveN.y);
  col = mix(col, col * vec3(0.78, 0.72, 0.62), floorW * 0.6);
  diffuseColor.rgb = col;
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.45, smoothstep(0.55, 0.9, vCaveN.y) * 0.5 + clamp(vBand * 127.0 / 2.0, 0.0, 1.0) * 0.25);`,
      );
  };
  m.customProgramCacheKey = () => 'lodestone-cave-rock-1';
  return m;
}

/** Gem crystal: the wizard-wars "glow" character, opaque so instanced clusters never sort. */
export function gemMaterial(gem: number): THREE.MeshPhysicalMaterial {
  // adapted from wizard-wars client/src/utils/crystalMaterial.ts (crystalGlow)
  const [color, glow] = GEM_COLORS[gem] ?? GEM_COLORS[0];
  return new THREE.MeshPhysicalMaterial({
    color,
    emissive: glow,
    emissiveIntensity: 1.25,
    roughness: 0.18,
    metalness: 0.4,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    ior: 1.7,
    reflectivity: 0.8,
  });
}

export function oreMaterial(ore: number): THREE.MeshStandardMaterial {
  const o = ORE_LOOKS[ore] ?? ORE_LOOKS[0];
  return new THREE.MeshStandardMaterial({ color: o.color, emissive: o.emissive, emissiveIntensity: o.glow, metalness: 0.85, roughness: 0.32, flatShading: true });
}

/** Bioluminescent mushrooms: emissive by instance color, caps brighter than stems (aGlow). */
export function fungusMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.6, emissive: 0xffffff, emissiveIntensity: 1.4 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;\nvarying vec3 vTint;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;\n#ifdef USE_INSTANCING_COLOR\nvTint = instanceColor;\n#else\nvTint = vec3(1.0);\n#endif');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;\nvarying vec3 vTint;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = vTint * emissive * vGlow;');
  };
  m.customProgramCacheKey = () => 'lodestone-cave-fungus-1';
  return m;
}

/** Small deco shards: emissive, element-tinted per instance. */
export function shardMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.25, metalness: 0.2, flatShading: true });
}

export function archRockMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x8a8278, roughness: 0.95, flatShading: true });
}
