// Playtest 2 ("the hand is fucked up here. not like what a right hand should
// do"): the first-person fists close on each weapon the way a hand can. The
// grip crosses the palm at a workable angle to the forearm, the wrist is
// only a little bent, the right hand is a right hand (and the left a mirror),
// the forearm leaves from the wrist, and the fingers wrap each grip's own
// radius.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { aimOpenHand, CAST_REST, CAST_UP, L_SHOULDER, makeRig, PIVOT, POSES, poseHands, setRigWeapon } from './FirstPersonWeapon';
import { BOW_MAX_DRAW, bowNock, FIST_WRIST, fistGeometry, GRIP_R, OPEN_WRIST, openHandGeometry, weaponGeometry } from './models';
import { WEAPON_KINDS, type WeaponKind } from './look';

const deg = (r: number) => THREE.MathUtils.radToDeg(r);

function posed(kind: WeaponKind) {
  const rig = makeRig();
  const cam = new THREE.Group(); // stands in for the camera
  cam.add(rig.root);
  setRigWeapon(rig, { weapon: kind, material: '', gem: -1 });
  const p = POSES[kind];
  rig.grip.position.set(p.pos[0] - PIVOT.x, p.pos[1] - PIVOT.y, p.pos[2] - PIVOT.z);
  if (kind === 'bow') rig.rFist.position.copy(bowNock(0.7 * BOW_MAX_DRAW)).multiplyScalar(p.scale ?? 1);
  poseHands(rig, kind);
  cam.updateMatrixWorld(true);
  return rig;
}

/** The angle between a fist's grip axis and its forearm (wrist toward the hand), and the bend at the wrist. */
function wristAngles(fist: THREE.Mesh, arm: THREE.Mesh) {
  const axis = new THREE.Vector3(0, 1, 0).transformDirection(fist.matrixWorld);
  const toShoulder = new THREE.Vector3(0, 1, 0).transformDirection(arm.matrixWorld);
  const wristDir = FIST_WRIST.clone().normalize().transformDirection(fist.matrixWorld);
  return { grip: deg(axis.angleTo(toShoulder.clone().negate())), bend: deg(wristDir.angleTo(toShoulder)) };
}

describe('first-person hands (playtest 2)', () => {
  it.each(WEAPON_KINDS)('%s: the grip crosses the palm at a workable angle and the wrist is barely bent', (kind) => {
    const rig = posed(kind);
    const r = wristAngles(rig.rFist, rig.rArm);
    // a fist can hold a handle from roughly 35 degrees (wrist toward the
    // little finger, handle along the palm crease) to square across it
    expect(r.grip).toBeGreaterThan(34);
    expect(r.grip).toBeLessThan(100);
    expect(r.bend).toBeLessThan(40);
    if (rig.lFist.visible) {
      const l = wristAngles(rig.lFist, rig.lArm);
      expect(l.grip).toBeGreaterThan(34);
      expect(l.grip).toBeLessThan(100);
      expect(l.bend).toBeLessThan(55);
    }
  });

  it.each(WEAPON_KINDS)('%s: the forearm leaves from the wrist of the fist', (kind) => {
    const rig = posed(kind);
    for (const [fist, arm] of [
      [rig.rFist, rig.rArm],
      [rig.lFist, rig.lArm],
    ] as const) {
      if (!fist.visible) continue;
      const wrist = FIST_WRIST.clone().applyMatrix4(fist.matrixWorld);
      expect(new THREE.Vector3().setFromMatrixPosition(arm.matrixWorld).distanceTo(wrist)).toBeLessThan(1e-6);
    }
  });

  it('the right fist is a right hand and the left a mirror of it (the left forearm too)', () => {
    const rig = posed('spear');
    expect(rig.rFist.matrixWorld.determinant()).toBeGreaterThan(0);
    expect(rig.lFist.matrixWorld.determinant()).toBeLessThan(0);
    expect(rig.lArm.matrixWorld.determinant()).toBeLessThan(0);
    // right hand: with the grip up (+Y, thumb side) and the forearm behind
    // (+Z), the back of the hand faces right (+X) and the thumb lies on the
    // left (-X), over the fingers
    const g = fistGeometry(GRIP_R.sword);
    const pos = g.getAttribute('position');
    let backX = -1;
    let thumbX = 1;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (z > 0.015 && z < 0.045 && Math.abs(y) < 0.02) backX = Math.max(backX, x); // the back of the hand, behind the grip
      if (y > 0.012 && y < 0.03 && z > -0.01 && z < 0.01) thumbX = Math.min(thumbX, x); // the thumb across the fingers
    }
    expect(backX).toBeGreaterThan(0.02);
    expect(thumbX).toBeLessThan(-0.03);
  });

  it("the fingers close round each grip's own radius (no handle through the fingers, none loose in them)", () => {
    for (const kind of WEAPON_KINDS) {
      const r = GRIP_R[kind];
      const g = fistGeometry(r);
      const pos = g.getAttribute('position');
      // the fist's inside nearest the grip axis, around the fingers' band
      let inner = Infinity;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (Math.abs(y) > 0.03) continue;
        const x = pos.getX(i);
        const z = pos.getZ(i);
        if (z > 0 || x > 0) continue; // the front-left quarter: only fingers wrap there
        inner = Math.min(inner, Math.hypot(x, z));
      }
      expect(inner).toBeGreaterThan(r * 0.92);
      expect(inner).toBeLessThan(r + 0.004);
      // and the weapon's handle really is about that thick where the hand goes
      // (the bow's riser sits off the axis, its back in the palm)
      if (kind === 'bow') continue;
      const w = weaponGeometry({ weapon: kind, material: '', gem: -1 }, 2).getAttribute('position');
      let handle = 0;
      for (let i = 0; i < w.count; i++) if (Math.abs(w.getY(i)) < 0.02) handle = Math.max(handle, Math.min(Math.hypot(w.getX(i), w.getZ(i)), 0.05));
      expect(handle).toBeGreaterThan(r * 0.7);
      expect(handle).toBeLessThan(r * 1.35);
    }
  });

  it("the sword's casting hand opens, palm toward the crosshair, fingers up, its forearm from the wrist", () => {
    const rig = posed('sword');
    rig.castFist.position.lerpVectors(CAST_REST, CAST_UP, 1);
    aimOpenHand(rig, rig.castFist, rig.castArm, L_SHOULDER);
    rig.root.updateMatrixWorld(true);
    expect(rig.castFist.geometry).toBe(openHandGeometry());
    const fingers = new THREE.Vector3(0, 1, 0).transformDirection(rig.castFist.matrixWorld);
    const palm = new THREE.Vector3(0, 0, -1).transformDirection(rig.castFist.matrixWorld);
    expect(fingers.y).toBeGreaterThan(0.8);
    expect(palm.z).toBeLessThan(-0.8); // facing forward, away from the eye
    expect(palm.x).toBeGreaterThan(0); // and in toward the centre of the view
    const wrist = OPEN_WRIST.clone().applyMatrix4(rig.castFist.matrixWorld);
    expect(new THREE.Vector3().setFromMatrixPosition(rig.castArm.matrixWorld).distanceTo(wrist)).toBeLessThan(1e-6);
  });

  it('hands are small and cached', () => {
    expect(fistGeometry(GRIP_R.staff)).toBe(fistGeometry(GRIP_R.staff));
    expect(fistGeometry(GRIP_R.staff)).not.toBe(fistGeometry(GRIP_R.wand));
    expect(fistGeometry(GRIP_R.sword).index!.count / 3).toBeLessThan(1400);
    expect(fistGeometry(GRIP_R.sword, 1).index!.count / 3).toBeLessThan(400); // third-person fists, two per full rig
    expect(openHandGeometry().index!.count / 3).toBeLessThan(1400);
  });
});
