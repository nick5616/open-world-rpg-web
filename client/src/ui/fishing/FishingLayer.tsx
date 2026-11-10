// Playtest 2 fishing in the world: every line in the water near you (yours
// from the fishing state, other players' from their emote record: Event
// 1090 id 20 carries the bobber), a float that bobs, dips on a nibble and
// goes under on the bite, then tugs about with the fish and comes in as you
// reel; the line sags from the rod's tip (an avatar's rod, or in first
// person a rod held in front of the camera). Also runs the fishing state's
// per-frame tick and finds where a cast would land (for the [E] prompt).

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { localPlayer, view } from '../../state/live';
import { useGround } from '../../scene/groundContext';
import { liveAvatars, SELF_AVATAR } from '../../net/avatar';
import { EMOTE_FISHING } from '../../net/avatarAnim';
import { emoteRecords } from '../emotes/store';
import { castPoint } from './fish';
import { fishingTick, fishLive, floatState, useFishing } from './store';

const MAX_LINES = 8;

/** Debug builds: the ground the fishing layer sees (the water search below). */
export const fishDebug = { ground: null as null | { heightAt(x: number, z: number): number; waterAt?(x: number, z: number): number } };

/**
 * Debug/evidence: a dry spot within r m of (cx, cz) with deep water 9-15 m
 * away in some direction (the stand point, the yaw to face it, the water).
 */
export function findFishingSpot(cx: number, cz: number, r = 600): { x: number; z: number; yaw: number; wx: number; wz: number } | null {
  const g = fishDebug.ground;
  if (!g?.waterAt) return null;
  for (let rad = 0; rad <= r; rad += 8) {
    const n = Math.max(1, Math.round((rad * Math.PI * 2) / 8));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const x = cx + Math.cos(a) * rad;
      const z = cz + Math.sin(a) * rad;
      const h = g.heightAt(x, z);
      const w = g.waterAt(x, z);
      if (Number.isFinite(w) && w > h - 0.1) continue; // wet
      // flat enough to stand
      if (Math.abs(g.heightAt(x + 1, z) - h) > 0.5 || Math.abs(g.heightAt(x, z + 1) - h) > 0.5) continue;
      for (let d = 0; d < 16; d++) {
        const yaw = (d / 16) * Math.PI * 2;
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        let ok = true;
        for (const m of [9, 12, 15]) {
          const wx = x + fx * m;
          const wz = z + fz * m;
          const ww = g.waterAt(wx, wz);
          if (!Number.isFinite(ww) || ww - g.heightAt(wx, wz) < 0.8 || ww > h + 1 || ww < h - 6) ok = false;
        }
        if (ok) return { x, z, yaw, wx: x + fx * 12, wz: z + fz * 12 };
      }
    }
  }
  return null;
}
const SEGS = 14;

interface LineObj {
  line: THREE.Line;
  pos: Float32Array;
  float: THREE.Group;
  ring: THREE.Mesh;
}

function makeLine(): LineObj {
  const pos = new Float32Array((SEGS + 1) * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x2b2a26, transparent: true, opacity: 0.85 }));
  line.frustumCulled = false;
  const float = new THREE.Group();
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe03131, roughness: 0.5 }));
  const bottom = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xf8f9fa, roughness: 0.5 }));
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.12, 4), new THREE.MeshStandardMaterial({ color: 0x343a40 }));
  stick.position.y = 0.08;
  float.add(top, bottom, stick);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.26, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  line.visible = float.visible = ring.visible = false;
  return { line, pos, float, ring };
}

/** A rod held in front of the first-person camera (camera space). */
function makeFpRod(): { group: THREE.Group; tip: THREE.Vector3 } {
  const group = new THREE.Group();
  const len = 1.5;
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.014, len, 6), new THREE.MeshStandardMaterial({ color: 0x7a5530, roughness: 0.7 }));
  rod.geometry.translate(0, len / 2, 0);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.22, 8), new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.9 }));
  grip.position.y = 0.05;
  const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 12), new THREE.MeshStandardMaterial({ color: 0xadb5bd, metalness: 0.6, roughness: 0.4 }));
  reel.rotation.z = Math.PI / 2;
  reel.position.set(-0.03, 0.18, 0);
  const holder = new THREE.Group();
  holder.add(rod, grip, reel);
  holder.position.set(0.3, -0.38, -0.45);
  holder.rotation.set(-1.0, 0.12, -0.15);
  group.add(holder);
  group.visible = false;
  return { group, tip: new THREE.Vector3(0, len, 0).applyEuler(holder.rotation).add(holder.position) };
}

const tmp = new THREE.Vector3();
const tip = new THREE.Vector3();

function sag(o: LineObj, a: THREE.Vector3, b: { x: number; y: number; z: number }, slack: number): void {
  const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const drop = Math.min(1.5, d * 0.07) * slack;
  for (let i = 0; i <= SEGS; i++) {
    const t = i / SEGS;
    o.pos[i * 3] = a.x + (b.x - a.x) * t;
    o.pos[i * 3 + 1] = a.y + (b.y - a.y) * t - drop * 4 * t * (1 - t);
    o.pos[i * 3 + 2] = a.z + (b.z - a.z) * t;
  }
  (o.line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
}

export function FishingLayer() {
  const camera = useThree((s) => s.camera);
  const ground = useGround();
  const st = useMemo(() => {
    const group = new THREE.Group();
    const lines: LineObj[] = [];
    for (let i = 0; i < MAX_LINES; i++) {
      const o = makeLine();
      lines.push(o);
      group.add(o.line, o.float, o.ring);
    }
    return { group, lines, fp: makeFpRod(), targetAt: 0, t0: performance.now() };
  }, []);

  useEffect(
    () => () => {
      st.group.removeFromParent();
      st.fp.group.removeFromParent();
      view.fpProp = false;
    },
    [st],
  );

  fishDebug.ground = ground;
  useFrame((state, delta) => {
    const now = performance.now();
    if (st.group.parent !== state.scene) state.scene.add(st.group);
    if (st.fp.group.parent !== camera) camera.add(st.fp.group);
    fishingTick(delta * 1000, localPlayer.pos, now);
    const s = useFishing.getState();
    // Where a cast would land (the prompt), a few times a second.
    if (s.phase === 'idle' && now - st.targetAt > 150) {
      st.targetAt = now;
      fishLive.target = castPoint(ground, view.eye, localPlayer.yaw, localPlayer.pitch);
    }
    const tsec = (now - st.t0) / 1000;
    let n = 0;
    // Your line.
    const mine = s.phase === 'waiting' || s.phase === 'hooking' || s.phase === 'fight' || s.phase === 'landing';
    const fpRod = mine && !view.third && !view.photo;
    st.fp.group.visible = fpRod;
    view.fpProp = fpRod; // the first-person weapon steps aside for the rod
    if (mine) {
      const o = st.lines[n++];
      const b = s.bobber;
      let y = b.y + 0.02 + Math.sin(tsec * 2.4) * 0.015;
      let x = b.x;
      let z = b.z;
      let ringA = 0;
      if (s.phase === 'waiting' || s.phase === 'hooking') {
        const f = s.phase === 'hooking' ? 'bite' : floatState(s, now);
        if (f === 'nibble') y -= 0.05;
        if (f === 'bite') {
          y -= 0.16;
          ringA = 0.6;
        }
      } else {
        // The fight: the float is under, darting about, coming in as you reel.
        const f = fishLive.fight;
        const k = f ? f.progress : 0.5;
        const pull = f ? f.pull : 0;
        const fx = view.feet.x + (b.x - view.feet.x) * (1 - 0.65 * k);
        const fz = view.feet.z + (b.z - view.feet.z) * (1 - 0.65 * k);
        x = fx + Math.sin(tsec * (3 + 6 * pull)) * (0.3 + 0.9 * pull);
        z = fz + Math.cos(tsec * (2.3 + 5 * pull)) * (0.3 + 0.9 * pull);
        y = b.y - 0.1 - 0.08 * pull;
        ringA = 0.25 + 0.4 * pull;
      }
      o.float.position.set(x, y, z);
      o.float.visible = true;
      o.ring.position.set(x, b.y + 0.01, z);
      const rs = 1 + ((tsec * 1.6) % 1) * 2;
      o.ring.scale.set(rs, rs, rs);
      (o.ring.material as THREE.MeshBasicMaterial).opacity = ringA * (1 - ((tsec * 1.6) % 1));
      o.ring.visible = ringA > 0;
      if (fpRod) {
        tip.copy(st.fp.tip);
        camera.localToWorld(tip);
      } else {
        const av = liveAvatars.get(SELF_AVATAR);
        if (!av || !av.rodTip(tip)) tip.set(view.feet.x - Math.sin(localPlayer.yaw) * 1.4, view.feet.y + 2.1, view.feet.z - Math.cos(localPlayer.yaw) * 1.4);
      }
      tmp.set(x, y + 0.08, z);
      sag(o, tip, tmp, s.phase === 'fight' ? 0.15 + 0.5 * (1 - (fishLive.fight?.tension ?? 0)) : 1);
      o.line.visible = true;
    }
    // Other players' lines (their fishing pose record carries the bobber).
    for (const [id, r] of emoteRecords()) {
      if (n >= MAX_LINES) break;
      if (id < 0 || r.id !== EMOTE_FISHING) continue;
      const av = liveAvatars.get(id);
      if (!av || av.anim.currentEmote !== EMOTE_FISHING) continue; // they walked off (the pose ended)
      const o = st.lines[n++];
      const y = r.y + 0.02 + Math.sin(tsec * 2.4 + id) * 0.015;
      o.float.position.set(r.x, y, r.z);
      o.float.visible = true;
      o.ring.visible = false;
      if (av.rodTip(tip)) {
        tmp.set(r.x, y + 0.08, r.z);
        sag(o, tip, tmp, 1);
        o.line.visible = true;
      } else o.line.visible = false;
    }
    for (let i = n; i < MAX_LINES; i++) {
      const o = st.lines[i];
      o.line.visible = o.float.visible = o.ring.visible = false;
    }
  });

  return null;
}
