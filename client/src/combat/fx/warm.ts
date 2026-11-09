// Spell FX objects for the WP19b shader warm-up (world/warmExtras.ts): one
// tiny object per program the FX use (particles, ribbons, every custom
// shader, the lit spike and boulder materials, sprites, cores), so the first
// cast never compiles a program mid-fight. The live pools are in the scene
// (SpellFxLayer) and compile with it; these cover a layer that mounts after
// the warm-up and solo play. Kept for the session (cached programs stay).

import * as THREE from 'three';
import { ParticlePool } from './particles';
import { RibbonBuffer } from './bolts';
import { materialWarmList } from './materials';
import { createSpikeMaterial, SPIKE_STYLES } from './transients';
import { GEO, glowTexture } from './core';

let kept: THREE.Object3D[] | null = null;

export function spellFxWarmObjects(): THREE.Object3D[] {
  if (kept) return kept;
  const out: THREE.Object3D[] = [new ParticlePool(4, true).points, new ParticlePool(4, false).points, new RibbonBuffer(1).mesh];
  const plane = new THREE.PlaneGeometry(1, 1);
  for (const m of materialWarmList()) out.push(new THREE.Mesh(m.type === 'ShaderMaterial' ? plane : plane, m));
  for (const s of SPIKE_STYLES) {
    const im = new THREE.InstancedMesh(GEO.cone5, createSpikeMaterial(s), 1);
    im.count = 1;
    out.push(im);
  }
  out.push(
    new THREE.Mesh(GEO.sphereLow, new THREE.MeshBasicMaterial({ color: '#ffffff' })),
    new THREE.Mesh(GEO.dodeca, new THREE.MeshStandardMaterial({ color: '#7a6040', roughness: 0.95, flatShading: true, emissive: '#2a1808', emissiveIntensity: 0.25 })),
    new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })),
    new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false })),
    new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: new THREE.Texture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })),
  );
  for (const o of out) o.frustumCulled = false;
  kept = out;
  return out;
}
