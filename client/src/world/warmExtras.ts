// Objects for the shader warm-up (warmup.ts) whose materials are not in the
// scene yet when the world loads but appear during play (WP19b).
//
// One tiny object per program variant, with the attributes and flags the
// real objects use, so their programs land in three's program cache (programs
// are shared by cache key, not by material instance): the real material
// finds its program compiled when it is first drawn. compileAsync compiles
// them with the scene's lights and never draws them. The materials are kept
// (module scope) so the cached programs are not released.
//
// The traversal benchmark (`npm run bench -w client`) lists every program
// linked during the walk and the flight, with its cache key: anything listed
// there belongs here (WP19b found the town decal program, linked on first
// sight of a town, and the cave rock program, linked when the flight passed a
// cave mouth).

import * as THREE from 'three';
import { makeTownMaterials, townTexture } from './buildings/townMaterial';
import { caveRockMaterial } from './caves/caveVisuals';
import { weaponMaterial } from '../combat/weapons/material';
import { spellFxWarmObjects } from '../combat/fx/warm';
import { enemyWarmObjects } from '../combat/enemies/warm';
import { armorMaterial } from '../combat/armor/material';
import { ambientLifeWarmObjects } from './life/ambientLife';

let kept: THREE.Object3D[] | null = null;

/** A one-triangle geometry with the attributes of a town mesh (townMaterial.geometryOf). */
function townGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array([0, 127, 0, 0, 127, 0, 0, 127, 0]), 3, true));
  g.setAttribute('aTexUv', new THREE.BufferAttribute(new Float32Array(6), 2));
  g.setAttribute('aLG', new THREE.BufferAttribute(new Float32Array(6), 2, false));
  g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(9), 3, true));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  return g;
}

export function warmExtras(): THREE.Object3D[] {
  if (kept) return kept;
  const out: THREE.Object3D[] = [];
  // WP20 towns: built when a town's manifest arrives (often after load).
  const town = makeTownMaterials(townTexture(new Uint8Array(4), 1, 1));
  const tg = townGeometry();
  out.push(new THREE.Mesh(tg, town.solid), new THREE.Mesh(tg, town.decal));
  // WP09 cave cell meshes: built when the player nears a cave (the material
  // is a CaveManager field; its program is shared by cache key).
  out.push(new THREE.Mesh(tg, caveRockMaterial()));
  // Remote players (net/avatar.ts): plain standard meshes, a double-sided
  // glider and a sprite nameplate, created when someone comes into view.
  const box = new THREE.BoxGeometry(0.1, 0.1, 0.1);
  out.push(
    new THREE.Mesh(box, new THREE.MeshStandardMaterial({ roughness: 0.7 })),
    new THREE.Mesh(box, new THREE.MeshStandardMaterial({ roughness: 0.8, side: THREE.DoubleSide })),
    new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.Texture(), depthTest: false, transparent: true })),
  );
  // pt/ux weapon models (combat/weapons): one shared material, on your own
  // first-person weapon and on every remote player's (vertex colours + `surf`).
  const wg = townGeometry();
  wg.setAttribute('surf', new THREE.BufferAttribute(new Float32Array(9), 3));
  out.push(new THREE.Mesh(wg, weaponMaterial()));
  // Enemy health bars and nameplates (combat layer, playtest 1): double-sided
  // unlit bars drawn over everything, and an additive glow decal.
  out.push(
    new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: '#222222', depthTest: false, side: THREE.DoubleSide })),
    new THREE.Mesh(box, new THREE.MeshBasicMaterial({ alphaMap: new THREE.Texture(), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })),
  );
  // Playtest 2 spell FX (combat/fx/warm.ts): particles, ribbons, every custom
  // spell shader, lit spikes, sprites and cores, so the first cast never compiles.
  out.push(...spellFxWarmObjects());
  // Playtest 2 enemy models (combat/enemies/warm.ts): the instanced part materials
  // (opaque, jelly, spectral, tinted), bars, auras and the damage-number glyphs.
  out.push(...enemyWarmObjects());
  // Playtest 2 visible armor (CR 034, combat/armor): the armor material on the
  // skinned full-rig outfit, and plain (the mid silhouette, first-person sleeves).
  const ag = townGeometry();
  ag.setAttribute('surf', new THREE.BufferAttribute(new Float32Array(9), 3));
  out.push(new THREE.Mesh(ag, armorMaterial()));
  const sg = ag.clone();
  sg.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(12), 4));
  sg.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(12).fill(0.25), 4));
  const bone = new THREE.Bone();
  const skinned = new THREE.SkinnedMesh(sg, armorMaterial());
  skinned.add(bone);
  skinned.bind(new THREE.Skeleton([bone], [new THREE.Matrix4()]), new THREE.Matrix4());
  skinned.castShadow = true;
  out.push(skinned);
  // Playtest 2 immersion pass (world/life): birds, butterflies, leaves (instanced
  // wing shader), fireflies and motes (points): drawn only when the biome and hour
  // call for them, so possibly first seen long after load.
  out.push(...ambientLifeWarmObjects());
  for (const o of out) o.frustumCulled = false;
  kept = out;
  return out;
}
