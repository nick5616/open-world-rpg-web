// Your armor in first person (CR 034): the view model's forearms
// (weapons/FirstPersonWeapon.tsx) wear the body armor's sleeves, bracers
// or vambraces (model.ts buildFpForearm) instead of the plain navy sleeve.
// Swapped only when your appearance changes; the geometry is the shared
// cached one (released when you change again).

import type * as THREE from 'three';
import { forearmGeometry } from '../weapons/models';
import { weaponMaterial } from '../weapons/material';
import { acquireArmor, releaseArmor } from './model';
import { armorMaterial } from './material';

interface Arms {
  rArm: THREE.Mesh;
  lArm: THREE.Mesh;
  castArm: THREE.Mesh;
}

const worn = new WeakMap<Arms, number>();

/** Dress the view model's forearms for appearance `ap` (no-op while it stays the same). */
export function dressForearms(rig: Arms, ap: number): void {
  const prev = worn.get(rig) ?? 0;
  if (prev === ap && worn.has(rig)) return;
  worn.set(rig, ap);
  const fp = ap ? acquireArmor(ap).fp : null;
  if (prev) releaseArmor(prev);
  for (const m of [rig.rArm, rig.lArm, rig.castArm]) {
    m.geometry = fp ?? forearmGeometry();
    m.material = fp ? armorMaterial() : weaponMaterial();
  }
}
