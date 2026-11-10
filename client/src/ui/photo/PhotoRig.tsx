// Playtest 2 photo mode, the scene half: while photo mode is up the camera
// leaves the player (PhotoCam: fly with WASD, Space / Ctrl or E / Q up and
// down, Shift fast, Alt slow, the mouse looks, Z / C roll), clamped to a
// sphere around your character and above the ground. Your character stands
// still (lookRouter.blockMove: the movement step still runs, so the zone
// sees an idle player) and its body shows. Runs after PlayerController, so
// it overrides the camera that placed; saves a shot right after the frame
// renders (a priority 2 hook after the world's priority 1 render).

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useKeyboard } from '../../input/useKeyboard';
import { lookRouter } from '../../input/lookRouter';
import { view } from '../../state/live';
import { avatarFlags } from '../../net/avatar';
import { useGround } from '../../scene/groundContext';
import { focusDistance, PhotoCam, shotName, type FlyInput } from './photoCamera';
import { photoKeys as extra, photoLive, usePhoto } from './store';

/** Debug/evidence handle: the photo camera's pose. */
export const photoDebug = { cam: null as PhotoCam | null };

export function PhotoRig() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const ground = useGround();
  const held = useKeyboard();
  const st = useMemo(() => ({ cam: new PhotoCam(), on: false, fov: 75, euler: new THREE.Euler(0, 0, 0, 'YXZ'), inp: { forward: false, back: false, left: false, right: false, up: false, down: false, fast: false, slow: false } as FlyInput, focusAt: 0 }), []);
  photoDebug.cam = st.cam;

  useEffect(
    () => () => {
      if (st.on) {
        lookRouter.sink = null;
        lookRouter.blockMove = false;
        view.photo = false;
        avatarFlags.hidePlates = false;
      }
    },
    [st],
  );

  useFrame((_, delta) => {
    const ph = usePhoto.getState();
    if (ph.active !== st.on) {
      st.on = ph.active;
      if (ph.active) {
        st.euler.setFromQuaternion(camera.quaternion, 'YXZ');
        st.cam.reset(camera.position, st.euler.y, st.euler.x, { x: view.feet.x, y: view.feet.y + 1.6, z: view.feet.z });
        st.fov = camera.fov;
        const cam = st.cam;
        lookRouter.sink = (dx, dy) => cam.look(dx, dy);
        lookRouter.blockMove = true;
        view.photo = true;
      } else {
        if (lookRouter.sink) lookRouter.sink = null;
        lookRouter.blockMove = false;
        view.photo = false;
        avatarFlags.hidePlates = false;
        camera.fov = st.fov;
        camera.updateProjectionMatrix();
      }
    }
    if (!st.on) return;
    avatarFlags.hidePlates = ph.hidePlates;
    const h = held.current;
    const inp = st.inp;
    inp.forward = h.forward;
    inp.back = h.back;
    inp.left = h.left;
    inp.right = h.right;
    inp.up = h.jump || extra.up;
    inp.down = h.crouch || extra.down;
    inp.fast = h.sprint;
    inp.slow = extra.slow;
    const cam = st.cam;
    // The anchor follows the character (it stands still, but a knock or the zone can move it).
    cam.anchor.x = view.feet.x;
    cam.anchor.y = view.feet.y + 1.6;
    cam.anchor.z = view.feet.z;
    cam.step(delta, inp, ground);
    cam.roll += ((extra.rollL ? 1 : 0) - (extra.rollR ? 1 : 0)) * Math.min(delta, 0.1) * 0.8;
    cam.roll = Math.max(-0.8, Math.min(0.8, cam.roll));
    camera.position.set(cam.pos.x, cam.pos.y, cam.pos.z);
    st.euler.set(cam.pitch, cam.yaw, cam.roll, 'YXZ');
    camera.quaternion.setFromEuler(st.euler);
    if (Math.abs(camera.fov - ph.fov) > 0.01) {
      camera.fov = ph.fov;
      camera.updateProjectionMatrix();
    }
    const now = performance.now();
    if (now - st.focusAt > 100) {
      st.focusAt = now;
      photoLive.autoFocusM = focusDistance(cam.pos, cam.yaw, cam.pitch, ground);
    }
  });

  // A shot: right after the world rendered this frame (the drawing buffer still holds it).
  useFrame(() => {
    if (!photoLive.captureRequested) return;
    photoLive.captureRequested = false;
    const name = shotName(new Date());
    gl.domElement.toBlob((b) => {
      if (!b) return;
      const url = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      usePhoto.setState((s) => ({ shots: s.shots + 1, lastShotAt: performance.now() }));
    }, 'image/png');
  }, 2);

  return null;
}
