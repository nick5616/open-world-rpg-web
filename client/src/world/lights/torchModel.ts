// The torch (CR 042): a procedural model shared by your first-person off hand
// (combat/weapons/FirstPersonWeapon.tsx), your body in third person and every
// other player's hand (net/avatar.ts). Built once as geometry + material
// (shared); each holder gets a cheap Group of four meshes and two sprites.
//
// Local space: +Y up the haft, the grip at the origin, the head 0.3 m up, the
// flame a little above it. The LightRig animates `flame` (a squash and sway) and
// reads its world position for the pooled point light.

import * as THREE from 'three';
import { flameTexture, glowMaterial, haloTexture } from './glowTextures';

export interface TorchModel {
  root: THREE.Group;
  /** The flame group at the head: the light's anchor, animated by the LightRig. */
  flame: THREE.Group;
  /** The additive halo around the flame (its opacity breathes with the light). */
  halo: THREE.Sprite;
}

/** Where the LightRig finds your first-person torch (set by FirstPersonWeapon while it is mounted). */
export const torchAnchors = { fp: null as TorchModel | null };

let haft: THREE.BufferGeometry | null = null;
let wrap: THREE.BufferGeometry | null = null;
let head: THREE.BufferGeometry | null = null;
let ember: THREE.BufferGeometry | null = null;
let woodMat: THREE.MeshStandardMaterial | null = null;
let clothMat: THREE.MeshStandardMaterial | null = null;
let pitchMat: THREE.MeshStandardMaterial | null = null;
let emberMat: THREE.MeshBasicMaterial | null = null;
let flameMat: THREE.SpriteMaterial | null = null;
let haloMat: THREE.SpriteMaterial | null = null;

function shared() {
  haft ??= new THREE.CylinderGeometry(0.017, 0.024, 0.42, 7).translate(0, 0.09, 0);
  wrap ??= new THREE.CylinderGeometry(0.03, 0.03, 0.07, 7).translate(0, 0.27, 0);
  head ??= new THREE.CylinderGeometry(0.044, 0.026, 0.09, 8).translate(0, 0.335, 0);
  ember ??= new THREE.IcosahedronGeometry(0.03, 0).translate(0, 0.385, 0);
  woodMat ??= new THREE.MeshStandardMaterial({ color: '#6b4a2b', roughness: 0.9, flatShading: true });
  clothMat ??= new THREE.MeshStandardMaterial({ color: '#4a3b2a', roughness: 1, flatShading: true });
  pitchMat ??= new THREE.MeshStandardMaterial({ color: '#241b14', roughness: 0.95, flatShading: true });
  emberMat ??= new THREE.MeshBasicMaterial({ color: '#ff9a3a', toneMapped: false });
  flameMat ??= glowMaterial(flameTexture(), '#ffffff', 0.95);
  haloMat ??= glowMaterial(haloTexture(), '#ff9a40', 0.5);
}

/** A new torch (hidden until its holder lights it: set `root.visible`). */
export function makeTorch(): TorchModel {
  shared();
  const root = new THREE.Group();
  root.name = 'torch';
  const m = (g: THREE.BufferGeometry, mat: THREE.Material) => {
    const x = new THREE.Mesh(g, mat);
    x.frustumCulled = false;
    return x;
  };
  root.add(m(haft!, woodMat!), m(wrap!, clothMat!), m(head!, pitchMat!), m(ember!, emberMat!));
  const flame = new THREE.Group();
  flame.position.set(0, 0.43, 0);
  const f = new THREE.Sprite(flameMat!);
  f.scale.set(0.2, 0.3, 1);
  f.position.y = 0.05;
  f.renderOrder = 6;
  const halo = new THREE.Sprite(haloMat!.clone());
  halo.scale.setScalar(0.9);
  halo.renderOrder = 5;
  flame.add(halo, f);
  root.add(flame);
  root.visible = false;
  return { root, flame, halo };
}

/** Objects with the torch's program variants, for the shader warm-up (world/warmup.ts). */
export function torchWarmObjects(): THREE.Object3D[] {
  shared();
  return [new THREE.Mesh(ember!, emberMat!), new THREE.Mesh(haft!, woodMat!), new THREE.Sprite(flameMat!)];
}
