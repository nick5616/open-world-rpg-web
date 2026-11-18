// First-person petting (playtest 5, CR 054): you crouch and lean in over the
// animal (the camera lowers about half a metre, drifts toward it and turns to
// look at it), the weapon and arms step aside, and your own hand and forearm
// glide to the animal's head and stroke down its back, three slow strokes,
// following the head wherever the animal moves it. Runs after
// PlayerController (and FirstPersonEmote) in the same frame, like the emote
// gestures: it only adds to the camera that frame already placed.
//
// Why the hand cannot clip the dog: its target is the head-top / rump-top
// anchor the animal publishes every frame, lifted by petBeat's `lift` plus a
// palm's half thickness; the forearm always keeps a fixed length ending at
// the hand, so it never stretches through the animal.

import { useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { ownSkinHex } from '../net/ownLook';
import { view } from '../state/live';
import { handTarget, petState, type PetBeat, type V3 } from '../world/buildings/petting';

const SLEEVE = 0x3b4a6b;
const FORE_LEN = 0.44;
/** Camera drop and lean at full crouch (m). */
const DROP_M = 0.52;
const LEAN_M = 0.3;
/** Palm half-thickness plus a finger's width, kept above the fur. */
const PALM_CLEAR_M = 0.04;

/** Where the camera ends up: dropped and leaned toward `at` (horizontal), by `k` (0..1). Pure; tested. */
export function crouchCamera(cam: V3, at: V3, k: number, out: V3): V3 {
  const dx = at.x - cam.x;
  const dz = at.z - cam.z;
  const d = Math.hypot(dx, dz) || 1;
  const lean = Math.min(LEAN_M, d * 0.28) * k;
  out.x = cam.x + (dx / d) * lean;
  out.y = cam.y - DROP_M * k;
  out.z = cam.z + (dz / d) * lean;
  return out;
}

const REST = new THREE.Vector3(0.6, -0.95, -0.1);
/** The right shoulder, in camera space: well to the right and behind, so the forearm comes in diagonally and reads as an arm, not a stump. */
const SHOULDER = new THREE.Vector3(1.0, -0.9, 0.15);

function buildHand() {
  const hand = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: ownSkinHex(), roughness: 0.7 });
  const sleeve = new THREE.MeshStandardMaterial({ color: SLEEVE, roughness: 0.8 });
  // Origin: the middle of the palm; the arm runs back along +z, the fingers forward along -z, the palm faces down (-y).
  const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, FORE_LEN - 0.14, 3, 8), sleeve);
  fore.rotation.x = Math.PI / 2;
  fore.position.z = 0.06 + (FORE_LEN - 0.14) / 2 + 0.05;
  const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.042, 0.1, 8), skin);
  wrist.rotation.x = Math.PI / 2;
  wrist.position.z = 0.07;
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.095), skin);
  palm.position.z = -0.01;
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.05, 2, 6), skin);
  thumb.rotation.set(Math.PI / 2, 0, 0.7);
  thumb.position.set(0.06, 0, -0.03);
  const fingers: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(new THREE.CapsuleGeometry(0.0125, 0.06 + (i === 1 || i === 2 ? 0.01 : 0), 2, 6), skin);
    f.rotation.x = Math.PI / 2;
    f.position.set(-0.036 + i * 0.024, -0.004, -0.085);
    fingers.push(f);
    hand.add(f);
  }
  hand.add(fore, wrist, palm, thumb);
  hand.visible = false;
  hand.traverse((o) => {
    o.frustumCulled = false;
  });
  return { hand, fingers };
}

export function FirstPersonPet() {
  const camera = useThree((s) => s.camera);
  const st = useMemo(() => {
    const { hand, fingers } = buildHand();
    return {
      hand,
      fingers,
      k: 0,
      reach: 0,
      lastBeat: null as PetBeat | null,
      lookQ: new THREE.Quaternion(),
      tmp: new THREE.Vector3(),
      tgt: new THREE.Vector3(),
      m: new THREE.Matrix4(),
      zero: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
      dir: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      c: { x: 0, y: 0, z: 0 },
    };
  }, []);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    if (st.hand.parent !== camera) camera.add(st.hand);
    const fp = !view.third && !view.photo;
    const on = petState.active && fp;
    if (on) {
      st.lastBeat = petState.beat;
      st.k = petState.beat.crouch;
      st.reach = petState.beat.reach;
    } else {
      // A cancelled petting lets go over a fraction of a second instead of snapping back.
      const f = Math.exp(-dt / 0.1);
      st.k *= f;
      st.reach *= f;
    }
    const live = fp && st.lastBeat !== null && st.k > 0.004;
    view.fpPet = live;
    if (!live || !st.lastBeat) {
      st.hand.visible = false;
      return;
    }
    // The camera: lower, lean toward the animal, turn to look at it.
    const cam = camera.position;
    crouchCamera(cam, petState.centre, st.k, st.c);
    cam.set(st.c.x, st.c.y, st.c.z);
    const aim = st.tgt.set((petState.head.x + petState.back.x) / 2, (petState.head.y + petState.back.y) / 2, (petState.head.z + petState.back.z) / 2);
    st.m.lookAt(cam, aim, st.up); // a camera's -z toward the aim (Object3D.lookAt would flip it)
    st.lookQ.setFromRotationMatrix(st.m);
    st.dir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const toAim = st.tmp.copy(aim).sub(cam).normalize();
    if (st.dir.dot(toAim) > 0.35) camera.quaternion.slerp(st.lookQ, 0.62 * st.k); // only when you were already looking roughly at it
    camera.updateMatrixWorld(true);
    // The hand: from below the view up to the animal, on its head, down its back.
    const b = st.lastBeat;
    const target = handTarget(petState.head, petState.back, b, st.c);
    const h = st.tmp.set(target.x, target.y + PALM_CLEAR_M, target.z);
    camera.worldToLocal(h);
    h.lerpVectors(REST, h, Math.max(0, Math.min(1, st.reach)));
    st.dir.copy(h).sub(SHOULDER).normalize();
    st.m.lookAt(st.zero, st.dir, st.up);
    st.q.setFromRotationMatrix(st.m);
    st.hand.quaternion.copy(st.q);
    st.hand.position.copy(h);
    // Relaxed fingers that curl a touch as the palm presses on a stroke.
    const press = b.stroke >= 0 ? 0.25 + 0.15 * Math.sin(b.s * Math.PI) : 0.12;
    for (const f of st.fingers) f.rotation.x = Math.PI / 2 - press;
    st.hand.visible = true;
  });
  return null;
}
