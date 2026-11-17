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

import { useEffect, useMemo } from 'react';
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { localActions, localPlayer, view } from '../../state/live';
import { makePickaxe } from './pickaxe';
import { combatRuntime } from '../link';
import { useCombatHud } from '../store';
import { moveOf } from '../timeline';
import { lookKey, materialKey, type WeaponKind, type WeaponLook } from './look';
import { weaponMaterial, tickWeaponMaterial } from './material';
import { BOW_MAX_DRAW, bowNock, FIST_WRIST, fistGeometry, forearmGeometry, GRIP_R, OPEN_WRIST, openHandGeometry, setBowDraw, weaponGeometry } from './models';
import { castHooks, castsFromWeapon } from '../fx/castOrigin';
import { dressForearms } from '../armor/fp';
import { ownAppearance } from '../armor/own';
import { makeTorch, torchAnchors } from '../../world/lights/torchModel';
import { useLights } from '../../world/lights/lightStore';

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
  /** Where the right forearm runs to (camera space; R_SHOULDER by default). */
  elbow?: V;
}

// Playtest 2 ("the hand is fucked up here"): each hold keeps the grip at
// 45-80 degrees to the forearm (the handle across the palm, the wrist only a
// little bent toward the little finger), the way a hand can actually close
// on it.
// Playtest 2 ("fix the view": a boss straight ahead was cut in half by the
// blade): at rest nothing crosses the middle 40% of the screen (hands.test.ts
// checks 16:9 to 32:9). The sword is carried low on the right with the
// blade up and leaning a little left, its tip off the top of the screen
// right of centre; the staff stands upright on the right, its head in the
// top-right corner; the wand is held low with its tip beside the crosshair,
// not on it; the spear's point is low, aimed at a foe's waist below the
// crosshair. Swings still sweep across the view (SWINGS below).
export const POSES: Record<WeaponKind, Pose> = {
  sword: { pos: [0.5, -0.24, -0.52], up: [-0.19, 0.92, -0.3], face: [0.2, 0.4, 1], elbow: [0.46, -0.6, 0] },
  spear: { pos: [0.24, -0.2, -0.25], up: [-0.1, -0.32, -1], face: [0, 1, 0.1], offhand: 0.46, elbow: [0.3, -0.75, 0] },
  bow: { pos: [-0.14, -0.1, -0.58], up: [0.35, 0.95, 0.3], face: [0.1, -0.3, 0.95], scale: 0.85 },
  staff: { pos: [0.42, -0.3, -0.52], up: [0.15, 0.88, -0.36], face: [0.3, 0, 1], elbow: [0.5, -0.55, 0.05] },
  wand: { pos: [0.34, -0.27, -0.44], up: [-0.1, 0.95, -0.2], face: [0.3, 1, 0.3], elbow: [0.4, -0.55, 0] },
};
/**
 * CR 033 (playtest 2 bow rework): the bow raised to shoot. Drawing lifts it
 * from POSES.bow to this hold: canted a little left, below the crosshair,
 * the arrow running from the lower right toward it (a few degrees off the
 * view line so you can see it), and a full draw (BOW_MAX_DRAW) brings the
 * string hand back to the anchor under the right cheek (BOW_ANCHOR), where
 * only its top shows at the bottom edge (as your own draw hand would).
 */
export const BOW_AIM: Pose = { pos: [0, -0.13, -0.6], up: [-0.3, 0.95, 0], face: [0.0748, 0.008, 0.5], scale: 0.85 };
/** Where the string hand ends at full draw (camera space): under the right cheek, its top just in view. */
export const BOW_ANCHOR = new THREE.Vector3(0.06, -0.075, -0.1);
/** The drawing arm's elbow while drawing: up and out to the right, level with the hand. */
const BOW_ELBOW = new THREE.Vector3(0.42, -0.14, 0.12);
/** ms the bow stays raised after a shot (a follow-up draw starts from the aim). */
const BOW_LOWER_MS = 420;
const bowElbow = new THREE.Vector3();

/** The swing pivots about the right shoulder region, so a cut sweeps across the view. */
export const PIVOT = new THREE.Vector3(0.22, -0.45, -0.1);
export const R_SHOULDER = new THREE.Vector3(0.3, -0.6, 0.12);
export const L_SHOULDER = new THREE.Vector3(-0.3, -0.6, 0.12);
const STRIDE_M = 2.4;
/** A first-person pickaxe chop (the avatar's mine swing is 520 ms too). */
const MINE_MS = 560;

/**
 * Playtest 2 ("fix the view"): the field of view is vertical, so a wider
 * screen shows more to the sides and the view model, fixed in camera space,
 * drifts toward the middle of it. Past 16:9 the whole rig slides right in
 * proportion (to 32:9), keeping the weapon about as far from the crosshair
 * on an ultrawide as on a 16:9 screen.
 */
export function aspectShift(aspect: number): number {
  return 0.17 * Math.min(1.8, Math.max(0, aspect - 16 / 9));
}

export function poseQuat(p: Pose): THREE.Quaternion {
  const y = new THREE.Vector3(...p.up).normalize();
  const z = new THREE.Vector3(...p.face);
  z.addScaledVector(y, -z.dot(y)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
export const QUATS = Object.fromEntries(Object.entries(POSES).map(([k, p]) => [k, poseQuat(p)])) as Record<WeaponKind, THREE.Quaternion>;
const AIM_QUAT = poseQuat(BOW_AIM);

/**
 * CR 033: the bow's grip in camera space at `raise` (0 rest, 1 aimed):
 * position (relative to PIVOT, like rig.grip) and orientation.
 */
export function bowGrip(raise: number, pos: THREE.Vector3, quat: THREE.Quaternion): void {
  const a = POSES.bow.pos;
  const b = BOW_AIM.pos;
  pos.set(a[0] + (b[0] - a[0]) * raise - PIVOT.x, a[1] + (b[1] - a[1]) * raise - PIVOT.y, a[2] + (b[2] - a[2]) * raise - PIVOT.z);
  quat.copy(QUATS.bow).slerp(AIM_QUAT, raise);
}

/** CR 033: the string hand's position at a draw fraction (camera space, the bow raised): tests and the view model. */
export function bowStringHand(drawFrac: number, out = new THREE.Vector3()): THREE.Vector3 {
  const q = new THREE.Quaternion();
  bowGrip(1, out, q);
  return bowNock(drawFrac * BOW_MAX_DRAW)
    .multiplyScalar(BOW_AIM.scale ?? 1)
    .applyQuaternion(q)
    .add(out)
    .add(PIVOT);
}

/** CR 033: the string after a release (m of draw): it snaps forward past the brace and rings down. */
export function stringAfterRelease(from: number, ms: number): number {
  if (ms < 18) return from * (1 - ms / 18);
  const t = ms - 18;
  return -0.018 * Math.exp(-t / 70) * Math.cos(t / 9);
}

/**
 * A melee swing as three held poses between rest and rest (camera space,
 * grip position and weapon direction like POSES): the wind-up, the cut
 * across the middle of the view, the follow-through. A forehand is cocked
 * over the right shoulder and cuts down to the lower left; a backhand is
 * the mirror, cocked over the left shoulder.
 */
export const SWINGS: Record<'fore' | 'back', [Pose, Pose, Pose]> = {
  fore: [
    { pos: [0.4, -0.12, -0.38], up: [0.35, 0.8, 0.5], face: [-0.6, 0.6, 0.5] },
    { pos: [0.14, -0.14, -0.52], up: [-0.6, 0.2, -0.75], face: [-0.6, 0.6, 0.5] },
    { pos: [-0.12, -0.3, -0.48], up: [-0.7, -0.45, -0.4], face: [-0.6, 0.6, 0.5] },
  ],
  back: [
    { pos: [-0.1, -0.1, -0.42], up: [-0.6, 0.65, 0.3], face: [0.6, 0.6, 0.5] },
    { pos: [0.0, -0.16, -0.5], up: [0.7, 0.3, -0.65], face: [0.6, 0.6, 0.5] },
    { pos: [0.36, -0.32, -0.45], up: [0.75, -0.4, -0.35], face: [0.6, 0.6, 0.5] },
  ],
};
const SWING_Q = { fore: SWINGS.fore.map(poseQuat), back: SWINGS.back.map(poseQuat) };
/** Swing timing (fraction of the move): wind-up ends, the cut passes the middle, the follow-through ends. */
const SWING_T = [0.22, 0.4, 0.6] as const;
const sv = new THREE.Vector3();
const sp = new THREE.Vector3();
const sq = new THREE.Quaternion();

/**
 * The grip's camera-space position and orientation `sw` (0..1) of the way
 * through a melee swing (`dir` 1 forehand, -1 backhand). Staff and wand
 * swing 70% as far.
 */
export function swingPose(kind: WeaponKind, sw: number, dir: number, outPos: THREE.Vector3, outQ: THREE.Quaternion): void {
  const rest = POSES[kind];
  const keys = dir > 0 ? SWINGS.fore : SWINGS.back;
  const qs = dir > 0 ? SWING_Q.fore : SWING_Q.back;
  const k = kind === 'sword' ? 1 : 0.7;
  // a key pulled toward rest by k
  const key = (i: number, p: THREE.Vector3, q: THREE.Quaternion) => {
    p.set(...rest.pos).lerp(sv.set(...keys[i].pos), k);
    q.copy(QUATS[kind]).slerp(qs[i], k);
  };
  const [t1, t2, t3] = SWING_T;
  let a: number;
  let b: number;
  let u: number;
  if (sw < t1) [a, b, u] = [-1, 0, smooth(0, t1, sw)];
  else if (sw < t2) [a, b, u] = [0, 1, ((sw - t1) / (t2 - t1)) ** 1.6];
  else if (sw < t3) [a, b, u] = [1, 2, 1 - (1 - (sw - t2) / (t3 - t2)) ** 1.6];
  else [a, b, u] = [2, -1, smooth(t3, 1, sw)];
  const pa = outPos;
  const qa = outQ;
  if (a < 0) {
    pa.set(...rest.pos);
    qa.copy(QUATS[kind]);
  } else key(a, pa, qa);
  const pb = sp;
  const qb = sq;
  if (b < 0) {
    pb.set(...rest.pos);
    qb.copy(QUATS[kind]);
  } else key(b, pb, qb);
  outPos.lerp(pb, u);
  outQ.slerp(qb, u);
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface Rig {
  root: THREE.Group;
  pivot: THREE.Group;
  grip: THREE.Group;
  weapon: THREE.Mesh;
  rFist: THREE.Mesh;
  lFist: THREE.Mesh;
  rArm: THREE.Mesh;
  lArm: THREE.Mesh;
  /** Playtest 2: the free off hand that rises to cast (sword). */
  castFist: THREE.Mesh;
  castArm: THREE.Mesh;
  /** Weapon tip height (+Y) of the current geometry. */
  tipY: number;
}

/** Off-hand cast pose (camera space): low and out of view at rest, raised toward the crosshair at the push. */
export const CAST_REST = new THREE.Vector3(-0.32, -0.62, -0.3);
export const CAST_UP = new THREE.Vector3(-0.21, -0.17, -0.5);
/** The spell leaves just in front of the raised palm (so the hand stays visible behind it). */
const CAST_FROM = new THREE.Vector3(-0.18, -0.11, -0.64);
const CAST_MS = 520;
/** CR 042: where the off hand holds a lit torch (camera space), and where it hangs when the weapon needs both hands. */
const TORCH_HAND = new THREE.Vector3(-0.3, -0.34, -0.5);
const TORCH_HIP = new THREE.Vector3(-0.36, -0.55, -0.35);
const tipLocal = new THREE.Vector3();

/** The bowstring is thin: the drawing hand closes on it tightly. */
const STRING_R = 0.0075;

export function makeRig(): Rig {
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
  // every hand this rig can need, built now (each bakes its shading, a few
  // tens of ms) so switching weapons mid-fight never waits on one
  for (const k of Object.keys(POSES) as WeaponKind[]) fistGeometry(GRIP_R[k] * (POSES[k].scale ?? 1));
  fistGeometry(STRING_R);
  const rFist = mesh(fistGeometry(GRIP_R.sword));
  const lFist = mesh(fistGeometry(GRIP_R.spear));
  lFist.scale.x = -1; // mirrored: a left hand
  const rArm = mesh(forearmGeometry());
  const lArm = mesh(forearmGeometry());
  lArm.scale.x = -1;
  pivot.position.copy(PIVOT);
  root.add(pivot, rArm, lArm);
  pivot.add(grip);
  grip.add(weapon, rFist, lFist);
  const castFist = mesh(openHandGeometry()); // playtest 2: an open palm pushes the spell out
  castFist.scale.x = -1;
  const castArm = mesh(forearmGeometry());
  castArm.scale.x = -1;
  castFist.visible = castArm.visible = false;
  root.add(castFist, castArm);
  return { root, pivot, grip, weapon, rFist, lFist, rArm, lArm, castFist, castArm, tipY: 0.8 };
}

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
const m4 = new THREE.Matrix4();
const BACK = new THREE.Vector3(-0.25, 0, 1).normalize();


/** Switch the rig to a weapon: its model, scale, hold and the fists that fit its grip. */
export function setRigWeapon(rig: Rig, look: WeaponLook): void {
  const kind = look.weapon ?? 'sword';
  rig.weapon.geometry = weaponGeometry(look, 2);
  rig.weapon.geometry.computeBoundingBox();
  rig.tipY = rig.weapon.geometry.boundingBox?.max.y ?? 0.8;
  const p = POSES[kind];
  rig.weapon.scale.setScalar(p.scale ?? 1);
  rig.grip.quaternion.copy(QUATS[kind]);
  const s = p.scale ?? 1;
  rig.rFist.geometry = fistGeometry(kind === 'bow' ? STRING_R : GRIP_R[kind] * s);
  rig.lFist.geometry = fistGeometry(GRIP_R[kind] * s);
  rig.lFist.visible = rig.lArm.visible = kind === 'spear' || kind === 'bow';
}

/**
 * Roll a fist about its grip axis so its wrist faces the shoulder (the only
 * freedom a hand closed on a handle has), then lay the forearm from the
 * wrist to the shoulder with its wide side across the grip.
 */
export function aimArm(rig: Rig, fist: THREE.Mesh, arm: THREE.Mesh, shoulder: THREE.Vector3): void {
  rig.root.updateMatrixWorld(true);
  const s = v1.copy(shoulder).applyMatrix4(rig.root.matrixWorld);
  fist.parent!.worldToLocal(s);
  s.sub(fist.position);
  // the wrist sits a little off +Z (toward the back of the hand); mirrored for a left hand
  fist.rotation.set(0, Math.atan2(s.x, s.z) - Math.atan2(FIST_WRIST.x * fist.scale.x, FIST_WRIST.z), 0);
  fist.updateMatrixWorld(true);
  placeForearm(rig, fist, arm, shoulder, FIST_WRIST);
}

/** The open casting hand: fingers up and a little forward, palm toward the crosshair, the forearm to the shoulder. */
export function aimOpenHand(rig: Rig, hand: THREE.Mesh, arm: THREE.Mesh, shoulder: THREE.Vector3): void {
  const f = v1.copy(hand.position).sub(shoulder).normalize(); // shoulder to hand
  const y = v2.set(0, 1, 0).addScaledVector(f, 0.4).normalize();
  const z = v3.copy(BACK).addScaledVector(y, -BACK.dot(y)).normalize();
  const x = f.crossVectors(y, z);
  hand.quaternion.setFromRotationMatrix(m4.makeBasis(x, y, z));
  rig.root.updateMatrixWorld(true);
  placeForearm(rig, hand, arm, shoulder, OPEN_WRIST);
}

function placeForearm(rig: Rig, hand: THREE.Mesh, arm: THREE.Mesh, shoulder: THREE.Vector3, wristLocal: THREE.Vector3): void {
  const wrist = v2.copy(wristLocal).applyMatrix4(hand.matrixWorld);
  rig.root.worldToLocal(wrist);
  arm.position.copy(wrist);
  const dir = v1.copy(shoulder).sub(wrist).normalize();
  // the hand's grip axis (thumb to little finger), in root space, across the forearm
  const across = v3.set(0, 1, 0).transformDirection(hand.matrixWorld);
  m4.copy(rig.root.matrixWorld).invert();
  across.transformDirection(m4);
  across.addScaledVector(dir, -across.dot(dir));
  if (across.lengthSq() < 1e-6) across.set(1, 0, 0).addScaledVector(dir, -dir.x);
  across.normalize();
  const z = v2.crossVectors(across, dir);
  arm.quaternion.setFromRotationMatrix(m4.makeBasis(across, dir, z));
}

/** Both hands on the weapon (right on the grip or the string, left on the shaft or the bow) for this frame's grip pose. */
export function poseHands(rig: Rig, kind: WeaponKind, rElbow: THREE.Vector3 = ELBOWS[kind]): void {
  const pose = POSES[kind];
  if (kind !== 'bow') rig.rFist.position.set(0, 0, 0);
  rig.lFist.position.set(0, pose.offhand ?? 0, 0);
  if (kind === 'bow') aimArm(rig, rig.lFist, rig.lArm, L_SHOULDER);
  aimArm(rig, rig.rFist, rig.rArm, rElbow);
  if (kind !== 'bow' && rig.lFist.visible) aimArm(rig, rig.lFist, rig.lArm, L_SHOULDER);
}
const ELBOWS = Object.fromEntries(Object.entries(POSES).map(([k, p]) => [k, p.elbow ? new THREE.Vector3(...p.elbow) : R_SHOULDER])) as Record<WeaponKind, THREE.Vector3>;

export function FirstPersonWeapon() {
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const rig = useMemo(makeRig, []);
  const pick = useMemo(() => {
    const p = makePickaxe();
    rig.grip.add(p);
    return p;
  }, [rig]);
  // CR 042: a lit torch in the off hand (a fist and forearm of its own, aimed at the left shoulder like the others)
  const torch = useMemo(() => {
    const model = makeTorch();
    model.root.scale.setScalar(0.85);
    const mat = weaponMaterial();
    const fist = new THREE.Mesh(fistGeometry(0.03), mat);
    fist.scale.x = -1;
    fist.frustumCulled = false;
    const arm = new THREE.Mesh(forearmGeometry(), mat);
    arm.scale.x = -1;
    arm.frustumCulled = false;
    fist.visible = arm.visible = false;
    rig.root.add(fist, arm, model.root);
    return { model, fist, arm };
  }, [rig]);
  useEffect(() => {
    torchAnchors.fp = torch.model;
    return () => {
      if (torchAnchors.fp === torch.model) torchAnchors.fp = null;
    };
  }, [torch]);
  const st = useMemo(
    () => ({
      key: '',
      kind: 'sword' as WeaponKind,
      mines: -1,
      mineAt: -1e9,
      swingT: 0,
      swingDur: 0,
      swinging: false,
      lastSeq: -1,
      freezeAt: 0,
      dir: -1, // flips per swing: the first is a forehand
      started: -1,
      flickAt: -1e9,
      draw: 0,
      phase: 0,
      // CR 033 bow: raised 0..1, drawing now, the release (time and draw it snapped from), full draw since
      raise: 0,
      drawing: false,
      looseAt: -1e9,
      looseFrom: 0,
      fullAt: 0,
    }),
    [],
  );

  useFrame((_, delta) => {
    const rt = combatRuntime.current;
    if (!rt) return;
    // Playtest 2: third person draws the weapon in the avatar's hand; the
    // view model keeps running hidden (the probe's hitstop measurement).
    // (Backed against a wall the boom collapses into the head: the view model returns.)
    rig.root.visible = (!view.third || view.hideBody) && !view.photo && !view.fpProp && !view.fpGesture && !view.fpInstrument; // playtest 2: photo mode shows the body; a fishing rod in hand
    const now = performance.now();
    tickWeaponMaterial(scene, now);
    dressForearms(rig, ownAppearance()); // CR 034: your body armor's sleeves (swapped only when it changes)

    // The look: weapon from the timeline (as before), material and gem from combat_sync.
    const hud = useCombatHud.getState();
    const lo = hud.loadouts[hud.activeLoadout];
    const kind = rt.weaponName() as WeaponKind;
    const look: WeaponLook = { weapon: POSES[kind] ? kind : 'sword', material: materialKey(lo?.material ?? 0), gem: lo?.gem ?? -1 };
    const key = lookKey(look);
    if (key !== st.key) {
      st.key = key;
      st.kind = look.weapon!;
      setRigWeapon(rig, look);
    }
    // Playtest 2: a mine swing (your own, the same count the third-person body uses) shows the pickaxe chop.
    if (localActions.mineSwings !== st.mines) {
      if (st.mines >= 0) st.mineAt = now;
      st.mines = localActions.mineSwings;
    }
    const mineT = (now - st.mineAt) / MINE_MS;
    const mining = mineT >= 0 && mineT < 1;
    rig.weapon.visible = !mining;
    pick.visible = mining && rig.root.visible;
    const pose = POSES[mining ? 'sword' : st.kind];
    castHooks.selfWeapon = st.kind;

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
      if (!st.swinging) st.flickAt = now;
    }

    // Walk bob (FirstPersonArms' motion, smaller).
    const lp = localPlayer;
    const hs = Math.hypot(lp.vel.x, lp.vel.z);
    if (lp.grounded) st.phase += (hs * Math.min(delta, 0.1) * Math.PI * 2) / STRIDE_M;
    const amp = lp.grounded ? 0.012 * Math.min(hs / 5, 1.6) : 0;
    const aspect = (camera as THREE.PerspectiveCamera).aspect ?? 16 / 9;
    rig.root.position.set(aspectShift(aspect) + Math.cos(st.phase) * amp, -Math.abs(Math.sin(st.phase)) * amp * 1.4, 0);

    // Pose + motion.
    rig.grip.position.set(pose.pos[0] - PIVOT.x, pose.pos[1] - PIVOT.y, pose.pos[2] - PIVOT.z);
    rig.grip.quaternion.copy(QUATS[mining ? 'sword' : st.kind]);
    rig.pivot.rotation.set(0, 0, 0);
    if (mining) {
      // raise the head back over the shoulder, then drive it down and forward into the vein
      const up = smooth(0, 0.35, mineT);
      const strike = smooth(0.35, 0.55, mineT);
      const back = 1 - smooth(0.62, 1, mineT);
      rig.pivot.rotation.x = (0.9 * up - 1.7 * strike) * back;
      rig.pivot.rotation.z = 0.15 * up * back;
    }
    const fwd = v1.set(0, 1, 0).applyQuaternion(rig.grip.quaternion);
    const flick = now - st.flickAt < 260 ? Math.sin(Math.PI * Math.min(1, (now - st.flickAt) / 260)) : 0;
    const held = rt.timeline.heldSteps;
    let rElbow: THREE.Vector3 | undefined;
    if (mining) {
      // the chop above owns the motion
    } else if (st.kind === 'sword' || st.kind === 'staff' || st.kind === 'wand') {
      if (st.swinging) {
        swingPose(st.kind, sw, st.dir, rig.grip.position, rig.grip.quaternion);
        rig.grip.position.sub(PIVOT);
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
      // CR 033: the draw follows the held primary step by step (timeline.drawFrac: 1 at chargeSteps),
      // all the way to BOW_MAX_DRAW with the hand at the cheek; the bow rises to the aim as it starts.
      const target = rt.timeline.drawFrac;
      if (held > 0) {
        if (!st.drawing) st.draw = 0;
        st.drawing = true;
        st.draw += (target - st.draw) * Math.min(1, delta * 30);
        if (target < 1) st.fullAt = 0;
        else if (!st.fullAt) st.fullAt = now;
      } else if (st.drawing) {
        // let go: the string snaps from wherever it was
        st.drawing = false;
        st.looseAt = now;
        st.looseFrom = st.draw;
        st.draw = 0;
        st.fullAt = 0;
      }
      const sinceLoose = now - st.looseAt;
      const up = held > 0 || sinceLoose < BOW_LOWER_MS ? 1 : 0;
      st.raise += (up - st.raise) * Math.min(1, delta * (up ? 16 : 7));
      bowGrip(st.raise, rig.grip.position, rig.grip.quaternion);
      let drawM = st.draw * BOW_MAX_DRAW;
      if (held === 0) drawM = sinceLoose < 400 ? stringAfterRelease(st.looseFrom * BOW_MAX_DRAW, sinceLoose) : 0;
      // the arrow is on the string while drawing (a new one is nocked as the next draw starts)
      setBowDraw(rig.weapon.geometry, drawM, held > 0);
      // full draw: the arms start to tremble, more the longer it is held
      if (st.fullAt) {
        const amp = 0.0012 + Math.min(0.0022, ((now - st.fullAt) / 3000) * 0.0022);
        rig.grip.position.x += amp * (Math.sin(now * 0.053) + 0.6 * Math.sin(now * 0.131 + 1.3));
        rig.grip.position.y += amp * (Math.sin(now * 0.047 + 2.1) + 0.6 * Math.sin(now * 0.117));
      }
      // the release: the bow kicks forward and rolls a little
      const kick = sinceLoose < 220 ? Math.sin(Math.PI * Math.min(1, sinceLoose / 220)) * (0.4 + 0.6 * st.looseFrom) : 0;
      rig.grip.position.z -= 0.025 * kick;
      rig.pivot.rotation.z = -0.05 * kick;
      // right hand on the string at the nock; after the release it follows through toward the ear
      rig.rFist.position.copy(bowNock(held > 0 ? drawM : Math.max(0, drawM) + st.looseFrom * BOW_MAX_DRAW * Math.max(0, 1 - sinceLoose / 260)))
        .multiplyScalar(pose.scale ?? 1);
      if (held === 0 && sinceLoose < 260) rig.rFist.position.x += 0.03 * Math.sin(Math.PI * (sinceLoose / 260));
      rElbow = bowElbow.copy(R_SHOULDER).lerp(BOW_ELBOW, st.raise);
    }
    // Hands: right fist on the grip (or the string), left on the shaft/bow.
    poseHands(rig, st.kind, rElbow);

    // Playtest 2 ("it is confusing where the spells are coming from"): a
    // sword's free off hand rises into view and pushes when you cast; a
    // staff or wand casts out of its tip (castOrigin.ts; the flick above
    // thrusts it); a spear or bow casts from the off hand already on it.
    // CR 042: a lit torch fills the off hand (a spear or bow needs both: the torch then hangs at the hip, unseen, and still lights).
    const torchLit = useLights.getState().torch;
    const twoHanded = st.kind === 'spear' || st.kind === 'bow';
    torch.model.root.visible = torchLit && !twoHanded && rig.root.visible;
    torch.fist.visible = torch.arm.visible = torch.model.root.visible;
    {
      const sway = Math.sin(now / 900) * 0.006;
      const fp = torchLit && !twoHanded ? TORCH_HAND : TORCH_HIP;
      torch.fist.position.set(fp.x + sway, fp.y + Math.sin(now / 1300) * 0.004, fp.z);
      torch.model.root.position.copy(torch.fist.position);
      torch.model.root.rotation.set(torchLit && !twoHanded ? -0.5 : -0.2, 0.08, 0.14);
      if (torch.fist.visible) aimArm(rig, torch.fist, torch.arm, L_SHOULDER);
    }
    const ct = now - castHooks.selfCastAt;
    const handCast = st.kind === 'sword' && ct >= 0 && ct < CAST_MS && !torchLit;
    rig.castFist.visible = rig.castArm.visible = handCast && rig.root.visible;
    if (handCast) {
      const k = smooth(0, 0.3, ct / CAST_MS) * (1 - smooth(0.65, 1, ct / CAST_MS));
      const push = smooth(0.25, 0.45, ct / CAST_MS) * (1 - smooth(0.6, 1, ct / CAST_MS));
      rig.castFist.position.lerpVectors(CAST_REST, CAST_UP, k).z -= 0.08 * push;
      aimOpenHand(rig, rig.castFist, rig.castArm, L_SHOULDER);
    }
  });

  // Where your casts leave in first person (fx engine; castOrigin.ts).
  useEffect(() => {
    castHooks.fpOrigin = (out) => {
      if (view.third && !view.hideBody) return false;
      const kind = st.kind;
      if (castsFromWeapon(kind)) {
        rig.weapon.updateWorldMatrix(true, false);
        tipLocal.set(0, rig.tipY, 0);
        rig.weapon.localToWorld(tipLocal);
      } else if (kind === 'sword') {
        rig.root.updateWorldMatrix(true, false);
        tipLocal.copy(CAST_FROM);
        rig.root.localToWorld(tipLocal);
      } else {
        rig.lFist.updateWorldMatrix(true, false);
        tipLocal.set(0, 0, 0);
        rig.lFist.localToWorld(tipLocal);
      }
      out.x = tipLocal.x;
      out.y = tipLocal.y;
      out.z = tipLocal.z;
      return true;
    };
    return () => {
      castHooks.fpOrigin = null;
    };
  }, [rig, st]);

  return createPortal(<primitive object={rig.root} />, camera);
}
