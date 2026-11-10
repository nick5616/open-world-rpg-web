// Playtest 2 emotes in first person: you don't see your own body, so an
// emote gives a brief camera nod (a bow dips the view, a laugh shakes it, a
// shrug tilts it, sitting lowers the eye until you move) and a hand gesture
// in the corner of the view (a wave, a salute, a point, a raised fist).
// Runs after PlayerController in the same frame (mounted after it) and only
// adds to the camera it placed; third person and photo mode show the body
// instead.

import { useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { localPlayer, view } from '../../state/live';
import { emoteById } from './emotes';
import { localEmote } from './store';

const SKIN = 0xc9a27e;
const SLEEVE = 0x3b4a6b;

/** Camera offsets for emote id at t seconds in (pure; tests use it). */
export function emoteNod(id: number, t: number): { pitch: number; roll: number; drop: number } {
  const env = (a: number, b: number) => Math.max(0, Math.min(1, t / a)) * Math.max(0, Math.min(1, (b - t) / 0.35));
  switch (id) {
    case 2: // bow
      return { pitch: -0.42 * Math.sin(Math.PI * Math.min(1, t / 1.6)), roll: 0, drop: 0.08 * Math.sin(Math.PI * Math.min(1, t / 1.6)) };
    case 3: // cheer
      return { pitch: 0.1 * env(0.3, 2.4), roll: 0, drop: -0.05 * Math.abs(Math.sin(t * 8)) * env(0.2, 2.4) };
    case 7: // laugh
      return { pitch: 0.12 * env(0.3, 2.4) + 0.025 * Math.sin(t * 22) * env(0.2, 2.4), roll: 0, drop: 0 };
    case 8: // shrug
      return { pitch: 0, roll: 0.09 * env(0.3, 1.6), drop: -0.03 * env(0.3, 1.6) };
    case 6: // dance
      return { pitch: 0.03 * Math.sin(t * 7.2), roll: 0.05 * Math.sin(t * 3.6), drop: 0.05 * Math.abs(Math.sin(t * 7.2)) };
    case 5: // sit
    case 10: // rest by the fire
      return { pitch: -0.05, roll: 0, drop: 0.75 * Math.min(1, t / 0.45) };
    case 9: // salute
      return { pitch: 0.03 * env(0.3, 2), roll: 0, drop: 0 };
  }
  return { pitch: 0, roll: 0, drop: 0 };
}

export function FirstPersonEmote() {
  const camera = useThree((s) => s.camera);
  const st = useMemo(() => {
    const hand = new THREE.Group();
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.28, 3, 8), new THREE.MeshStandardMaterial({ color: SLEEVE, roughness: 0.8 }));
    fore.position.y = -0.2;
    const palm = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.7 }));
    palm.scale.set(1, 1.3, 0.6);
    hand.add(fore, palm);
    hand.visible = false;
    return { hand, seen: 0, id: 0, at: 0, x: 0, z: 0 };
  }, []);

  useFrame(() => {
    const now = performance.now();
    if (localEmote.n !== st.seen) {
      st.seen = localEmote.n;
      st.id = localEmote.id;
      st.at = localEmote.at;
      st.x = localPlayer.pos.x;
      st.z = localPlayer.pos.z;
    }
    if (st.hand.parent !== camera) camera.add(st.hand);
    const def = st.id ? emoteById(st.id) : null;
    const t = (now - st.at) / 1000;
    const moved = Math.hypot(localPlayer.pos.x - st.x, localPlayer.pos.z - st.z) > 0.6;
    const live = !!def && (def.loop ? !moved : t < def.durS);
    if (!live) st.id = 0;
    const fp = !view.third && !view.photo;
    st.hand.visible = false;
    if (!live || !fp) return;
    const n = emoteNod(st.id, t);
    camera.position.y -= n.drop;
    camera.rotateX(n.pitch);
    camera.rotateZ(n.roll);
    // The hand, in the camera's frame (x right, y up, -z forward).
    const h = st.hand;
    const rise = Math.min(1, t / 0.25) * Math.min(1, Math.max(0, (def!.durS || 99) - t) / 0.3);
    switch (st.id) {
      case 1: // wave
        h.visible = true;
        h.position.set(0.32, -0.42 + 0.3 * rise, -0.6);
        h.rotation.set(0, 0, 0.5 * Math.sin(t * 10));
        break;
      case 9: // salute
        h.visible = true;
        h.position.set(0.18, -0.35 + 0.42 * rise, -0.42);
        h.rotation.set(0.2, 0, 1.15);
        break;
      case 4: // point
        h.visible = true;
        h.position.set(0.22, -0.42 + 0.2 * rise, -0.55);
        h.rotation.set(-1.45, 0, 0.05);
        break;
      case 3: // cheer
        h.visible = true;
        h.position.set(0.3, -0.45 + 0.42 * rise + 0.05 * Math.sin(t * 8), -0.55);
        h.rotation.set(0.1, 0, 0.15);
        break;
    }
  });
  return null;
}
