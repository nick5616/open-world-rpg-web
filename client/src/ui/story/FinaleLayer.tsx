// The Heartfall in the world (playtest 2, CR 035): where the Lodestone
// broke and the Hush waits. A ring of broken obsidian pillars around a
// sigil on the ground, the Heart (a cracked dark crystal) floating over the
// middle, and during the fight: the wells of dawn (gold columns, one player
// each), the shroud (a dark shell over the Hush while it lasts), the
// endless night's warning (the ring burns red). After the victory the
// Heart turns gold and a beam of dawn stands over it. Imperative three.js
// in one useFrame; built only within a few hundred metres.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { nightRuntime } from '../../systems/night';
import { drawnRemotes } from '../../net/netStore';
import { FINALE } from './events';
import { useStory } from './store';

const SHOW_M = 420;
const PILLARS = 12;

function build(): { root: THREE.Group; parts: Parts } {
  const root = new THREE.Group();
  root.name = 'heartfall';
  const stone = new THREE.MeshStandardMaterial({ color: '#1d1724', roughness: 0.35, metalness: 0.2, emissive: new THREE.Color('#2a1640'), emissiveIntensity: 0.35 });
  const pillars: THREE.Mesh[] = [];
  for (let i = 0; i < PILLARS; i++) {
    const h = 4 + ((i * 37) % 5) * 1.2;
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.3, h, 1.3), stone);
    m.userData.h = h;
    m.userData.tilt = (((i * 53) % 7) - 3) * 0.05;
    m.castShadow = true;
    pillars.push(m);
    root.add(m);
  }
  const sigilMat = new THREE.MeshBasicMaterial({ color: '#8f5bff', transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
  const sigil = new THREE.Group();
  for (const [a, b] of [[0.97, 1.0], [0.62, 0.64], [0.3, 0.315]]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(a, b, 96), sigilMat);
    ring.rotation.x = -Math.PI / 2;
    sigil.add(ring);
  }
  root.add(sigil);
  const heartMat = new THREE.MeshStandardMaterial({ color: '#251633', roughness: 0.15, metalness: 0.3, emissive: new THREE.Color('#6a2bd9'), emissiveIntensity: 0.9 });
  const heart = new THREE.Mesh(new THREE.OctahedronGeometry(2.1, 0), heartMat);
  heart.scale.set(1, 1.6, 1);
  root.add(heart);
  const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.8, 0), heartMat);
  root.add(shard);
  const glow = new THREE.PointLight('#8f5bff', 2.5, 40, 2);
  root.add(glow);
  const wellMat = new THREE.MeshBasicMaterial({ color: '#ffd76a', transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const wells: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 9, 32, 1, true), wellMat);
    w.visible = false;
    wells.push(w);
    root.add(w);
  }
  const shellMat = new THREE.MeshBasicMaterial({ color: '#0a0610', transparent: true, opacity: 0.45, depthWrite: false });
  const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), shellMat);
  shell.visible = false;
  root.add(shell);
  const dawnMat = new THREE.MeshBasicMaterial({ color: '#ffcf6a', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const dawn = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 3.2, 120, 24, 1, true), dawnMat);
  root.add(dawn);
  return { root, parts: { pillars, sigil, sigilMat, heart, heartMat, shard, glow, wells, wellMat, shell, dawn, dawnMat } };
}

interface Parts {
  pillars: THREE.Mesh[];
  sigil: THREE.Group;
  sigilMat: THREE.MeshBasicMaterial;
  heart: THREE.Mesh;
  heartMat: THREE.MeshStandardMaterial;
  shard: THREE.Mesh;
  glow: THREE.PointLight;
  wells: THREE.Mesh[];
  wellMat: THREE.MeshBasicMaterial;
  shell: THREE.Mesh;
  dawn: THREE.Mesh;
  dawnMat: THREE.MeshBasicMaterial;
}

export function FinaleLayer() {
  const scene = useThree((s) => s.scene);
  const { root, parts } = useMemo(build, []);
  useEffect(() => {
    root.visible = false;
    scene.add(root);
    return () => {
      scene.remove(root);
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
      });
    };
  }, [scene, root]);
  useFrame((state) => {
    const st = useStory.getState();
    const rt = nightRuntime.runtime;
    const hf = st.sync?.heartfall ?? (st.finale ? [st.finale.x, st.finale.z, st.finale.r] : null);
    if (!rt || !hf || !(hf[2] > 0)) {
      root.visible = false;
      return;
    }
    const [x, z, r] = hf;
    const cam = state.camera.position;
    if (Math.hypot(cam.x - x, cam.z - z) > SHOW_M) {
      root.visible = false;
      return;
    }
    root.visible = true;
    const g = rt.terrainGround;
    const y = g.heightAt(x, z);
    const t = state.clock.elapsedTime;
    const f = st.finale;
    const phase = f?.phase ?? FINALE.idle;
    const won = phase === FINALE.won || (st.sync?.beaten ?? 0) > 0;
    parts.pillars.forEach((p, i) => {
      const a = (i / PILLARS) * Math.PI * 2;
      const px = x + Math.cos(a) * (r + 1.5);
      const pz = z + Math.sin(a) * (r + 1.5);
      const h = p.userData.h as number;
      p.position.set(px, g.heightAt(px, pz) + h / 2 - 0.4, pz);
      p.rotation.set(p.userData.tilt as number, -a, (p.userData.tilt as number) * 0.6);
    });
    parts.sigil.position.set(x, y + 0.06, z);
    parts.sigil.scale.setScalar(r);
    const nightSoon = phase === FINALE.night && (f?.nightMs ?? 0) > 0;
    parts.sigilMat.color.set(nightSoon ? '#ff3b2a' : won ? '#ffd76a' : '#8f5bff');
    parts.sigilMat.opacity = nightSoon ? 0.5 + 0.35 * Math.sin(t * 9) : 0.45 + 0.1 * Math.sin(t * 1.3);
    const fighting = phase === FINALE.fight || phase === FINALE.choir || phase === FINALE.night || phase === FINALE.intro;
    parts.heart.position.set(x, y + (fighting ? 12 : 7) + Math.sin(t * 0.8) * 0.4, z);
    parts.heart.rotation.y = t * 0.25;
    parts.shard.position.set(x + Math.cos(t * 0.6) * 3.4, y + 6.5 + Math.sin(t * 1.1), z + Math.sin(t * 0.6) * 3.4);
    parts.heartMat.emissive.set(won ? '#ffb347' : '#6a2bd9');
    parts.heartMat.color.set(won ? '#ffe2a0' : '#251633');
    parts.heartMat.emissiveIntensity = won ? 1.6 : fighting ? 1.3 + 0.4 * Math.sin(t * 3) : 0.8;
    parts.glow.color.set(won ? '#ffcf6a' : '#8f5bff');
    parts.glow.position.copy(parts.heart.position);
    parts.glow.intensity = won ? 4 : 2.5;
    // Wells of dawn.
    const wells = f?.wells ?? [];
    parts.wells.forEach((w, i) => {
      const wl = wells[i];
      w.visible = !!wl;
      if (!wl) return;
      w.position.set(wl.x, g.heightAt(wl.x, wl.z) + 4.4, wl.z);
      w.scale.set(wl.r, 1, wl.r);
    });
    parts.wellMat.opacity = 0.28 + 0.12 * Math.sin(t * 4);
    // The shroud over the Hush.
    const boss = f?.boss ? drawnRemotes.views.find((v) => v.id === f.boss) : undefined;
    parts.shell.visible = !!boss && (f?.shroud ?? 0) > 0;
    if (boss && parts.shell.visible) {
      parts.shell.position.set(boss.x, boss.y + 2.6, boss.z);
      parts.shell.scale.setScalar(3.6 + 0.15 * Math.sin(t * 5));
    }
    // Dawn.
    parts.dawn.position.set(x, y + 60, z);
    parts.dawnMat.opacity = won ? 0.22 + 0.05 * Math.sin(t * 1.5) : 0;
    parts.dawn.visible = won;
  });
  return null;
}
