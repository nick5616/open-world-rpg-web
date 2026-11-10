// Playtest 2 ("the hand is fucked up here. not like what a right hand should
// do"): the first-person fists close on each weapon the way a hand can. The
// grip crosses the palm at a workable angle to the forearm, the wrist is
// only a little bent, the right hand is a right hand (and the left a mirror),
// the forearm leaves from the wrist, and the fingers wrap each grip's own
// radius.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { aimOpenHand, aspectShift, BOW_AIM, BOW_ANCHOR, bowGrip, bowStringHand, CAST_REST, CAST_UP, L_SHOULDER, makeRig, PIVOT, POSES, poseHands, setRigWeapon, stringAfterRelease, swingPose } from './FirstPersonWeapon';
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

  // CR 033 ("they don't pull all the way back"): a full draw takes the string to BOW_MAX_DRAW with
  // the hand at the cheek anchor, the arrow along the view and its head still past the riser.
  it('bow: a full draw pulls the string hand back to the cheek, the arrow along the view', () => {
    const cam = new THREE.Group();
    const rig = makeRig();
    cam.add(rig.root);
    setRigWeapon(rig, { weapon: 'bow', material: '', gem: -1 });
    bowGrip(1, rig.grip.position, rig.grip.quaternion);
    const s = BOW_AIM.scale ?? 1;
    rig.rFist.position.copy(bowNock(BOW_MAX_DRAW)).multiplyScalar(s);
    poseHands(rig, 'bow', new THREE.Vector3(0.42, -0.14, 0.12));
    cam.updateMatrixWorld(true);
    const hand = new THREE.Vector3().setFromMatrixPosition(rig.rFist.matrixWorld);
    expect(hand.distanceTo(bowStringHand(1))).toBeLessThan(1e-6);
    expect(hand.distanceTo(BOW_ANCHOR)).toBeLessThan(0.04);
    // drawn ~0.4 m back from the rest of the string (it was 0.2: a third of the way)
    expect(bowStringHand(1).distanceTo(bowStringHand(0))).toBeGreaterThan(0.35);
    // at the cheek: in front of the near plane (0.05), its top in a 75 degree view, its middle near the bottom edge
    expect(-hand.z).toBeGreaterThan(0.075);
    expect(-hand.z).toBeLessThan(0.11);
    const below = Math.abs(hand.y / hand.z) / Math.tan(THREE.MathUtils.degToRad(37.5));
    expect(below).toBeGreaterThan(0.75); // near the bottom edge
    expect(Math.abs(hand.y + 0.045) / -hand.z / Math.tan(THREE.MathUtils.degToRad(37.5))).toBeLessThan(1);
    // the arrow points within a few degrees of the crosshair, its head past the riser
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(rig.weapon.matrixWorld);
    expect(deg(fwd.angleTo(new THREE.Vector3(0, 0, -1)))).toBeLessThan(10);
    const riser = new THREE.Vector3().setFromMatrixPosition(rig.weapon.matrixWorld);
    expect(hand.z - 0.74 * s).toBeLessThan(riser.z - 0.1);
    // the string hand can hold it: workable grip and wrist
    const r = wristAngles(rig.rFist, rig.rArm);
    expect(r.grip).toBeGreaterThan(34);
    expect(r.grip).toBeLessThan(100);
    expect(r.bend).toBeLessThan(55);
    // the release rings the string down to rest
    expect(stringAfterRelease(BOW_MAX_DRAW, 0)).toBe(BOW_MAX_DRAW);
    expect(stringAfterRelease(BOW_MAX_DRAW, 18)).toBeLessThan(0);
    expect(Math.abs(stringAfterRelease(BOW_MAX_DRAW, 400))).toBeLessThan(0.001);
  });

  it('hands are small and cached', () => {
    expect(fistGeometry(GRIP_R.staff)).toBe(fistGeometry(GRIP_R.staff));
    expect(fistGeometry(GRIP_R.staff)).not.toBe(fistGeometry(GRIP_R.wand));
    // playtest 2 ("fix this fucked up hand"): three-phalanx fingers, a rounded palm and wrist (was < 1400)
    expect(fistGeometry(GRIP_R.sword).index!.count / 3).toBeLessThan(2000);
    expect(fistGeometry(GRIP_R.sword, 1).index!.count / 3).toBeLessThan(400); // third-person fists, two per full rig
    expect(openHandGeometry().index!.count / 3).toBeLessThan(1500);
  });

  it('the skin is shaded by its own shape: creases and the curl into the palm darker than the back of the hand', () => {
    const g = fistGeometry(GRIP_R.sword);
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const col = g.getAttribute('color');
    let backSum = 0;
    let backN = 0;
    let darkest = 1;
    for (let i = 0; i < pos.count; i++) {
      const lum = (col.getX(i) + col.getY(i) + col.getZ(i)) / 3;
      darkest = Math.min(darkest, lum);
      // the back of the hand: on the +X side, facing out
      if (pos.getX(i) > GRIP_R.sword + 0.012 && nor.getX(i) > 0.8) {
        backSum += lum;
        backN++;
      }
    }
    expect(backN).toBeGreaterThan(10);
    expect(darkest).toBeLessThan((backSum / backN) * 0.75);
  });

  it("the staff is held in the right hand alone (no off hand stacked on it); the spear's two hands don't overlap", () => {
    expect(posed('staff').lFist.visible).toBe(false);
    expect(posed('wand').lFist.visible).toBe(false);
    expect(posed('sword').lFist.visible).toBe(false);
    const rig = posed('spear');
    const r = new THREE.Vector3().setFromMatrixPosition(rig.rFist.matrixWorld);
    const l = new THREE.Vector3().setFromMatrixPosition(rig.lFist.matrixWorld);
    expect(r.distanceTo(l)).toBeGreaterThan(0.2);
  });
});

/**
 * Where a posed rig lands on screen: every vertex of the weapon, hands and
 * forearms (and points along every triangle edge, so a long thin blade
 * can't slip through the box between its vertices), projected.
 */
function screenPoints(rig: ReturnType<typeof makeRig>, aspect: number, fov: number): THREE.Vector2[] {
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.05, 100);
  cam.updateProjectionMatrix();
  rig.root.parent!.updateMatrixWorld(true);
  const out: THREE.Vector2[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (const m of [rig.weapon, rig.rFist, rig.lFist, rig.rArm, rig.lArm, rig.castFist, rig.castArm]) {
    if (!m.visible) continue;
    const pos = m.geometry.getAttribute('position');
    const idx = m.geometry.index!;
    for (let t = 0; t < idx.count; t += 3)
      for (let e = 0; e < 3; e++) {
        a.fromBufferAttribute(pos, idx.getX(t + e)).applyMatrix4(m.matrixWorld);
        b.fromBufferAttribute(pos, idx.getX(t + ((e + 1) % 3))).applyMatrix4(m.matrixWorld);
        for (let k = 0; k < 4; k++) {
          p.lerpVectors(a, b, k / 4);
          if (p.z > -0.05) continue; // behind the near plane
          p.project(cam);
          out.push(new THREE.Vector2(p.x, p.y));
        }
      }
  }
  return out;
}

const inBox = (pts: THREE.Vector2[], half: number) => pts.filter((q) => Math.abs(q.x) < half && Math.abs(q.y) < half).length;

describe('first-person view (playtest 2, "fix the view")', () => {
  // a boss straight ahead was cut in half by the sword at rest
  const SCREENS: [string, number][] = [
    ['16:9', 16 / 9],
    ['21:9', 2560 / 1080],
  ];
  for (const kind of ['sword', 'spear', 'staff', 'wand'] as WeaponKind[])
    for (const [name, aspect] of SCREENS)
      it(`${kind} at rest on ${name} leaves the middle of the screen clear`, () => {
        const rig = posed(kind);
        rig.root.position.x = aspectShift(aspect);
        // the middle 40% of the screen (width and height) at the normal field of view
        expect(inBox(screenPoints(rig, aspect, 75), 0.4)).toBe(0);
        // and the middle 25% at the widest a dash or a gallop kicks it (75 + 16 degrees)
        expect(inBox(screenPoints(rig, aspect, 91), 0.25)).toBe(0);
      });

  it.each([1, -1])('a sword swing (dir %i) still sweeps through the middle of the view', (dir) => {
    const rig = posed('sword');
    let crossed = 0;
    for (let sw = 0.3; sw <= 0.5; sw += 0.05) {
      swingPose('sword', sw, dir, rig.grip.position, rig.grip.quaternion);
      rig.grip.position.sub(PIVOT);
      poseHands(rig, 'sword');
      crossed += inBox(screenPoints(rig, 16 / 9, 75), 0.15);
    }
    expect(crossed).toBeGreaterThan(50);
  });
});
