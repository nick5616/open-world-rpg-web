// Distant terrain straight from the atlas heightmap (spec 12: "distant
// terrain uses the atlas heightmap directly"): one 129 x 129 mesh over the
// whole 4 km world, coloured per node from biome, slope, altitude and water,
// available the moment the atlas is, so the first frame already shows the
// far mountains ("if you can see it, you can go there").
//
// It discards every fragment over a chunk that a streamed tile covers
// (coverage texture from the terrain manager), so the two never z-fight and
// never leave a gap. It sits 3 m low so the step at that border reads as the
// near tile's skirt, never as a hole to the sky. Forest nodes are tinted as
// canopy: beyond the scatter distance there are no tree meshes, and a brown
// forest floor at 3 km would look bald.

import * as THREE from 'three';
import type { AtlasData } from '@lodestone/worldgen';
import { DOMAIN_CHUNKS, DOMAIN_MIN } from './quadtree';
import type { TerrainShared } from './terrainMaterial';

const LOWER_M = 3;

export function createHorizonMesh(d: AtlasData, shared: TerrainShared, coverage: THREE.Texture): THREE.Mesh {
  const N = d.gridN;
  const res = d.macroRes;
  const g = new THREE.PlaneGeometry(res * (N - 1), res * (N - 1), N - 1, N - 1);
  g.rotateX(-Math.PI / 2);
  g.translate((res * (N - 1)) / 2, 0, (res * (N - 1)) / 2);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const flat = shared.uFlat.value; // linear means per layer (TERRAIN_LAYERS order)
  const grass = flat[0].clone().multiply(new THREE.Color(0.95, 1.1, 0.6));
  const canopy = new THREE.Color(0.05, 0.085, 0.035);
  const c = new THREE.Color();
  const H = (i: number, j: number) => d.height[Math.max(0, Math.min(N - 1, j)) * N + Math.max(0, Math.min(N - 1, i))];
  for (let v = 0; v < pos.count; v++) {
    // PlaneGeometry vertex order after rotation: rows along +z, columns along +x.
    const i = Math.round(pos.getX(v) / res);
    const j = Math.round(pos.getZ(v) / res);
    const k = j * N + i;
    const h = d.height[k];
    pos.setY(v, h - LOWER_M);
    const slope = Math.hypot(H(i + 1, j) - H(i - 1, j), H(i, j + 1) - H(i, j - 1)) / (2 * res);
    const biome = d.biome[k];
    const flags = d.nodeParams[k * 4 + 3];
    const moist = d.moist[k] / 255;
    switch (biome) {
      case 1: c.copy(canopy); break; // forest: tree canopy
      case 2: c.copy(grass).lerp(flat[2], 0.45); break; // highlands
      case 3: c.copy(flat[3]); break; // snowpeak
      case 4: c.copy(flat[8]).lerp(flat[1], 0.3); break; // badlands
      case 5: c.copy(grass).multiplyScalar(0.75).lerp(flat[5], 0.25); break; // wetland
      default: c.copy(grass).lerp(new THREE.Color(0.5, 0.42, 0.2), Math.max(0, 0.45 - moist)); // meadow, drier = straw
    }
    if (slope > 0.9) c.lerp(flat[7], Math.min(1, (slope - 0.9) * 2));
    if (h < d.seaY + 2.5 && h > d.seaY - 3) c.lerp(flat[4], 0.7); // beaches
    if (flags & 6 && d.water[k] > h) c.setRGB(0.02, 0.06, 0.08); // lake / river
    colors[v * 3] = c.r;
    colors[v * 3 + 1] = c.g;
    colors[v * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uCoverage = { value: coverage };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vHWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHWorld = (modelMatrix * vec4(position, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vHWorld;\nuniform sampler2D uCoverage;')
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        vec2 cc = vHWorld / 64.0 - float(${DOMAIN_MIN});
        if (texture2D(uCoverage, cc / float(${DOMAIN_CHUNKS})).r > 0.5) discard;`,
      );
  };
  m.customProgramCacheKey = () => 'lodestone-horizon-1';
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'horizon';
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}
