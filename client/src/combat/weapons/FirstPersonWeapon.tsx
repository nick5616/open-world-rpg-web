// The first-person weapon (pt/ux, replaces WP13's box/cylinder/torus
// placeholder in CombatLayer): the equipped weapon's procedural model
// (models.ts) in a plausible hold, with a right fist and forearm (the same
// skin and sleeve colours as FirstPersonArms), a left hand on the spear
// shaft and on the bow's grip, and the motion:
//   - melee swings from the FX queue (`swing`, set by CombatLayer when a
//     melee move starts), frozen by hitstop exactly as before: the probe's
//     hitstopMeasured() is still called on unfreeze (WP13 feel tests);
//   - the bow's string and nocked arrow follow the held secondary button
//     (timeline.heldSteps), loose on release, a quick draw for a tap;
//   - staff and wand flick forward on every cast or bolt;
//   - a small walk bob.
// Parented to the camera through a portal; one shared material (material.ts);
// 3 to 5 draw calls (weapon, fists, forearms).

import { useMemo } from 'react';
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { localPlayer, view } from '../../state/live';
import { combatRuntime } from '../link';
import { useCombatHud } from '../store';
import { moveOf } from '../timeline';
import { lookKey, materialKey, type WeaponKind, type WeaponLook } from './look';
import { weaponMaterial, tickWeaponMaterial } from './material';
import { BOW_MAX_DRAW, bowNock, fistGeometry, forearmGeometry, setBowDraw, weaponGeometry } from './models';

/** The newest melee swing (CombatLayer writes it from the FX queue; the weapon reads it). */
export const swing = { at: 0, dur: 0 };

type V = [number, number, number];
interface Pose {
  /** Grip position in camera space (m). */
  pos: V;
  /** Where the weapon's +Y (grip to tip) points, camera space. */
  up: V;
  /** Where its +Z (blade flat / bow's string side) faces, roughly. */
  face: V;
  scale?: number;
  /** Off hand on the weapon at this local +Y (spear). */
  offhand?: number;
}

const POSES: Record<WeaponKind, Pose> = {
  sword: { pos: [0.24, -0.22, -0.44], up: [-0.32, 0.64, -0.7], face: [-0.3, 0.45, 1] },
  spear: { pos: [0.22, -0.28, -0.22], up: [-0.13, 0.12, -1], face: [0, 1, 0.1], offhand: 0.46 },
  bow: { pos: [-0.14, -0.1, -0.58], up: [0.35, 0.95, 0.3], face: [0.1, -0.3, 0.95], scale: 0.85 },
  staff: { pos: [0.27, -0.28, -0.46], up: [-0.15, 1, -0.65], face: [0.3, 0, 1] },
  wand: { pos: [0.22, -0.2, -0.38], up: [-0.3, 0.62, -1], face: [0.3, 1, 0.3] },
};
/** The swing pivots about the right shoulder region, so a cut sweeps across the view. */
const PIVOT = new THREE.Vector3(0.22, -0.45, -0.1);
const R_SHOULDER = new THREE.Vector3(0.3, -0.6, 0.12);
const L_SHOULDER = new THREE.Vector3(-0.3, -0.6, 0.12);
const STRIDE_M = 2.4;

function poseQuat(p: Pose): THREE.Quaternion {
  const y = new THREE.Vector3(...p.up).normalize();
  const z = new THREE.Vector3(...p.face);
  z.addScaledVector(y, -z.dot(y)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
const QUATS = Object.fromEntries(Object.entries(POSES).map(([k, p]) => [k, poseQuat(p)])) as Record<WeaponKind, THREE.Quaternion>;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Rig {
  root: THREE.Group;
  pivot: THREE.Group;
  grip: THREE.Group;
  weapon: THREE.Mesh;
  rFist: THREE.Mesh;
  lFist: THREE.Mesh;
  rArm: THREE.Mesh;
  lArm: THREE.Mesh;
}

function makeRig(): Rig {
  const mat = weaponMaterial();
  const mesh = (g: THREE.BufferGeometry) => {
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false; // camera-attached, and the bow's buffer moves
    return m;
  };
  const root = new THREE.Group();
  const pivot = new THREE.Group();
  const grip = new THREE.Group();
  const weapon = mesh(weaponGeometry({ weapon: 'sword', material: '', gem: -1 }, 2));
  const rFist = mesh(fistGeometry());
  const lFist = mesh(fistGeometry());
  lFist.scale.x = -1; // mirrored: a left hand
  const rArm = mesh(forearmGeometry());
  const lArm = mesh(forearmGeometry());
  lArm.scale.x = -1;
  pivot.position.copy(PIVOT);
  root.add(pivot, rArm, lArm);
  pivot.add(grip);
  grip.add(weapon, rFist, lFist);
  return { root, pivot, grip, weapon, rFist, lFist, rArm, lArm };
}

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);

/** Turn a fist about its grip axis so its wrist (+Z) faces the shoulder; place the forearm from wrist to shoulder. */
function aimArm(rig: Rig, fist: THREE.Mesh, arm: THREE.Mesh, shoulder: THREE.Vector3): void {
  rig.root.updateMatrixWorld(true);
  const s = v1.copy(shoulder).applyMatrix4(rig.root.matrixWorld);
  fist.parent!.worldToLocal(s);
  s.sub(fist.position);
  fist.rotation.set(0, Math.atan2(s.x, s.z), 0);
  fist.updateMatrixWorld(true);
  const wrist = v2.set(0, -0.004, 0.05).applyMatrix4(fist.matrixWorld);
  rig.root.worldToLocal(wrist);
  arm.position.copy(wrist);
  const dir = v1.copy(shoulder).sub(wrist).normalize();
  arm.quaternion.setFromUnitVectors(up, dir);
}

export function FirstPersonWeapon() {
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const rig = useMemo(makeRig, []);
  const st = useMemo(
    () => ({
      key: '',
      kind: 'sword' as WeaponKind,
      swingT: 0,
      swingDur: 0,
      swinging: false,
      lastSeq: -1,
      freezeAt: 0,
      dir: -1, // flips per swing: the first is a forehand
      started: -1,
      flickAt: -1e9,
      quickAt: -1e9,
      heldAt: -1e9,
      draw: 0,
      phase: 0,
    }),
    [],
  );

  useFrame((_, delta) => {
    const rt = combatRuntime.current;
    if (!rt) return;
    // Playtest 2: third person draws the weapon in the avatar's hand; the
    // view model keeps running hidden (the probe's hitstop measurement).
    // (Backed against a wall the boom collapses into the head: the view model returns.)
    rig.root.visible = !view.third || view.hideBody;
    const now = performance.now();
    tickWeaponMaterial(scene, now);

    // The look: weapon from the timeline (as before), material and gem from combat_sync.
    const hud = useCombatHud.getState();
    const lo = hud.loadouts[hud.activeLoadout];
    const kind = rt.weaponName() as WeaponKind;
    const look: WeaponLook = { weapon: POSES[kind] ? kind : 'sword', material: materialKey(lo?.material ?? 0), gem: lo?.gem ?? -1 };
    const key = lookKey(look);
    if (key !== st.key) {
      st.key = key;
      st.kind = look.weapon!;
      rig.weapon.geometry = weaponGeometry(look, 2);
      const p = POSES[st.kind];
      rig.weapon.scale.setScalar(p.scale ?? 1);
      rig.grip.quaternion.copy(QUATS[st.kind]);
      rig.lFist.visible = rig.lArm.visible = st.kind === 'spear' || st.kind === 'bow';
    }
    const pose = POSES[st.kind];

    // Swing: driven by the newest started melee move; hitstop freezes it.
    const frozen = now < rt.hitstopUntil;
    if (frozen && !st.freezeAt) st.freezeAt = now;
    if (!frozen && st.freezeAt) {
      rt.probe.hitstopMeasured(now - st.freezeAt);
      st.freezeAt = 0;
    }
    if (swing.at > st.lastSeq) {
      st.lastSeq = swing.at;
      st.swingT = 0;
      st.swingDur = swing.dur;
      st.swinging = true;
      st.dir = -st.dir;
    }
    if (!frozen) st.swingT += delta * 1000;
    const a = Math.min(1, st.swingT / Math.max(1, st.swingDur));
    if (st.swinging && a >= 1) st.swinging = false;
    const sw = st.swinging ? a : 1;

    // Anything that started (bolt, cast, arrow) since last frame: a flick.
    const started = rt.probe.counts.started;
    if (st.started < 0) st.started = started;
    if (started !== st.started) {
      st.started = started;
      if (!st.swinging) {
        if (st.kind === 'bow' && now - st.heldAt > 160) st.quickAt = now;
        st.flickAt = now;
      }
    }

    // Walk bob (FirstPersonArms' motion, smaller).
    const lp = localPlayer;
    const hs = Math.hypot(lp.vel.x, lp.vel.z);
    if (lp.grounded) st.phase += (hs * Math.min(delta, 0.1) * Math.PI * 2) / STRIDE_M;
    const amp = lp.grounded ? 0.012 * Math.min(hs / 5, 1.6) : 0;
    rig.root.position.set(Math.cos(st.phase) * amp, -Math.abs(Math.sin(st.phase)) * amp * 1.4, 0);

    // Pose + motion.
    rig.grip.position.set(pose.pos[0] - PIVOT.x, pose.pos[1] - PIVOT.y, pose.pos[2] - PIVOT.z);
    rig.pivot.rotation.set(0, 0, 0);
    const fwd = v1.set(0, 1, 0).applyQuaternion(rig.grip.quaternion);
    const flick = now - st.flickAt < 260 ? Math.sin(Math.PI * Math.min(1, (now - st.flickAt) / 260)) : 0;
    const held = rt.timeline.heldSteps;
    if (held > 0) st.heldAt = now;
    if (st.kind === 'sword' || st.kind === 'staff' || st.kind === 'wand') {
      if (st.swinging) {
        const u1 = smooth(0, 0.22, sw);
        const u2 = smooth(0.18, 0.6, sw);
        const back = 1 - smooth(0.62, 1, sw);
        const k = st.kind === 'sword' ? 1 : 0.7;
        rig.pivot.rotation.set((0.35 * u1 - 1.05 * u2) * back * k, st.dir * (-0.45 * u1 + 1.5 * u2) * back * k, st.dir * (-0.3 * u1 + 0.6 * u2) * back * k);
      } else if (st.kind !== 'sword' && flick > 0) {
        rig.grip.position.addScaledVector(fwd, 0.07 * flick);
        rig.pivot.rotation.x = -0.18 * flick;
      }
    } else if (st.kind === 'spear') {
      const m = moveOf(rt.timeline.weapon(), 'charged');
      const charge = Math.min(1, held / Math.max(1, m?.chargeSteps ?? 36));
      const thrust = st.swinging ? smooth(0, 0.3, sw) * (1 - smooth(0.45, 1, sw)) : 0;
      rig.grip.position.addScaledVector(fwd, 0.4 * thrust - 0.14 * charge);
      rig.pivot.rotation.y = st.swinging ? 0.12 * st.dir * thrust : 0;
    } else if (st.kind === 'bow') {
      const m = moveOf(rt.timeline.weapon(), 'charged');
      const target = Math.min(1, held / Math.max(1, m?.chargeSteps ?? 60));
      // ease toward the held draw; a release snaps the string forward
      st.draw = target > st.draw ? st.draw + (target - st.draw) * Math.min(1, delta * 14) : target;
      let draw = st.draw;
      let nocked = held > 0;
      const q = now - st.quickAt;
      if (q < 140) {
        draw = 0.55 * Math.sin((Math.PI / 2) * (q / 140));
        nocked = true;
      }
      setBowDraw(rig.weapon.geometry, draw * BOW_MAX_DRAW, nocked);
      rig.grip.position.addScaledVector(fwd.set(0, 0, -1), 0.03 * flick);
      rig.pivot.rotation.z = -0.04 * flick;
      // right hand on the string at the nock point
      rig.rFist.position.copy(bowNock(draw * BOW_MAX_DRAW)).multiplyScalar(pose.scale ?? 1);
    }
    if (st.kind !== 'bow') rig.rFist.position.set(0, 0, 0);
    if (pose.offhand) rig.lFist.position.set(0, pose.offhand, 0);
    else rig.lFist.position.set(0, 0, 0);

    // Hands: right fist on the grip (or the string), left on the shaft/bow.
    if (st.kind === 'bow') {
      aimArm(rig, rig.lFist, rig.lArm, L_SHOULDER);
      aimArm(rig, rig.rFist, rig.rArm, R_SHOULDER);
    } else {
      aimArm(rig, rig.rFist, rig.rArm, R_SHOULDER);
      if (rig.lFist.visible) aimArm(rig, rig.lFist, rig.lArm, L_SHOULDER);
    }
  });

  return createPortal(<primitive object={rig.root} />, camera);
}
