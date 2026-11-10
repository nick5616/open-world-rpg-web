// In-world content (playtest 2, CR 023): lore tablets (a standing stone
// with a glowing rune until read), herb patches (one instanced mesh of
// small leafy clumps tinted by herb, hidden while regrowing), the sealed
// vaults' parts (levers, pressure stones, braziers with fire when lit, the
// weeping font, the vault door with its sigil, the chest) and world event
// markers (a red-gold beam; a wagon for the caravan; a crater and a
// glowing shard for a starfall). Imperative three.js in one useFrame,
// small shared geometries; only things within a few hundred metres exist.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { CONTENT } from '@lodestone/contracts';
import { localPlayer } from '../../state/live';
import { questBeamResources } from '../quests/QuestLayer';
import { EVENT_PHASE, type VaultPart } from './events';
import { useContent } from './store';

const TABLET_M = 220;
const HERB_M = 110;
const MAX_HERBS = 400;

const G = {
  tablet: new THREE.BoxGeometry(0.9, 1.3, 0.22),
  rune: new THREE.PlaneGeometry(0.42, 0.42),
  leaf: new THREE.ConeGeometry(0.14, 0.5, 5),
  post: new THREE.CylinderGeometry(0.12, 0.16, 1.1, 8),
  handle: new THREE.BoxGeometry(0.12, 0.8, 0.12),
  plate: new THREE.CylinderGeometry(0.9, 1.0, 0.18, 20),
  bowl: new THREE.CylinderGeometry(0.55, 0.3, 0.45, 14),
  stand: new THREE.CylinderGeometry(0.14, 0.2, 1.0, 8),
  flame: new THREE.ConeGeometry(0.32, 0.9, 10),
  door: new THREE.BoxGeometry(2.6, 3.4, 0.5),
  sigil: new THREE.RingGeometry(0.5, 0.75, 24),
  chest: new THREE.BoxGeometry(1.1, 0.6, 0.7),
  lid: new THREE.BoxGeometry(1.15, 0.18, 0.75),
  wagon: new THREE.BoxGeometry(2.2, 1.0, 3.6),
  wheel: new THREE.CylinderGeometry(0.55, 0.55, 0.18, 14),
  cover: new THREE.CylinderGeometry(1.15, 1.15, 3.4, 12, 1, true, 0, Math.PI),
  crater: new THREE.RingGeometry(2.5, 6, 32),
  shard: new THREE.OctahedronGeometry(0.9, 0),
};
const M = {
  stone: new THREE.MeshStandardMaterial({ color: '#8b8778', roughness: 0.9 }),
  darkStone: new THREE.MeshStandardMaterial({ color: '#5d5a52', roughness: 0.95 }),
  wood: new THREE.MeshStandardMaterial({ color: '#7a5634', roughness: 0.85 }),
  iron: new THREE.MeshStandardMaterial({ color: '#4a4c52', roughness: 0.5, metalness: 0.6 }),
  cloth: new THREE.MeshStandardMaterial({ color: '#d8ccb0', roughness: 0.95, side: THREE.DoubleSide }),
  rune: new THREE.MeshBasicMaterial({ color: '#7fd8ff', transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
  runeRead: new THREE.MeshBasicMaterial({ color: '#8a7a5a', transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
  flame: new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
  water: new THREE.MeshStandardMaterial({ color: '#3d7fb0', roughness: 0.2, metalness: 0.1 }),
  ice: new THREE.MeshStandardMaterial({ color: '#cfefff', roughness: 0.1, emissive: new THREE.Color('#5fa8d0'), emissiveIntensity: 0.4 }),
  sigil: new THREE.MeshBasicMaterial({ color: '#ffd76a', transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
  plateOn: new THREE.MeshStandardMaterial({ color: '#7d8a6a', roughness: 0.8, emissive: new THREE.Color('#9fe08a'), emissiveIntensity: 0.5 }),
  gold: new THREE.MeshStandardMaterial({ color: '#c9a24a', roughness: 0.4, metalness: 0.7 }),
  crater: new THREE.MeshBasicMaterial({ color: '#2a1d16', transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }),
  shard: new THREE.MeshStandardMaterial({ color: '#b8a6ff', emissive: new THREE.Color('#8b6dff'), emissiveIntensity: 1.2, roughness: 0.2 }),
  herb: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.8 }),
};

function vaultPartObject(p: VaultPart, element?: string): THREE.Object3D {
  const g = new THREE.Group();
  switch (p.kind) {
    case 'lever': {
      const post = new THREE.Mesh(G.post, M.darkStone);
      post.position.y = 0.55;
      const h = new THREE.Mesh(G.handle, M.iron);
      h.name = 'handle';
      h.position.y = 1.1;
      const glyph = new THREE.Mesh(G.rune, new THREE.MeshBasicMaterial({ color: ['#ffd76a', '#cfd8ff', '#ffffff'][p.glyph] ?? '#fff', side: THREE.DoubleSide }));
      glyph.position.set(0, 0.7, 0.17);
      glyph.scale.setScalar(0.5);
      g.add(post, h, glyph);
      break;
    }
    case 'plate': {
      const m = new THREE.Mesh(G.plate, M.stone);
      m.name = 'plate';
      m.position.y = 0.09;
      g.add(m);
      break;
    }
    case 'brazier':
    case 'font': {
      const st = new THREE.Mesh(G.stand, M.darkStone);
      st.position.y = 0.5;
      const b = new THREE.Mesh(G.bowl, p.kind === 'font' ? M.stone : M.iron);
      b.position.y = 1.15;
      g.add(st, b);
      if (p.kind === 'brazier') {
        const f = new THREE.Mesh(G.flame, M.flame);
        f.name = 'flame';
        f.position.y = 1.75;
        g.add(f);
      } else {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 14), M.water);
        w.name = 'water';
        w.position.y = 1.36;
        g.add(w);
      }
      void element;
      break;
    }
    case 'door': {
      const d = new THREE.Mesh(G.door, M.darkStone);
      d.name = 'door';
      d.position.y = 1.7;
      const s = new THREE.Mesh(G.sigil, M.sigil);
      s.name = 'sigil';
      s.position.set(0, 1.9, 0.27);
      g.add(d, s);
      break;
    }
    case 'chest': {
      const c = new THREE.Mesh(G.chest, M.wood);
      c.position.y = 0.3;
      const lid = new THREE.Mesh(G.lid, M.gold);
      lid.name = 'lid';
      lid.position.set(0, 0.68, 0);
      g.add(c, lid);
      break;
    }
  }
  g.position.set(p.x, p.y, p.z);
  g.traverse((o) => {
    o.castShadow = true;
  });
  return g;
}

function applyPart(o: THREE.Object3D, p: VaultPart, phase: number, t: number): void {
  switch (p.kind) {
    case 'lever': {
      const h = o.getObjectByName('handle');
      if (h) h.rotation.x = p.on ? 0.9 : -0.6;
      break;
    }
    case 'plate': {
      const m = o.getObjectByName('plate') as THREE.Mesh | undefined;
      if (m) {
        m.position.y = p.on ? 0.03 : 0.09;
        m.material = p.on ? M.plateOn : M.stone;
      }
      break;
    }
    case 'brazier': {
      const f = o.getObjectByName('flame');
      if (f) {
        f.visible = p.on;
        f.scale.set(1, 0.85 + 0.25 * Math.sin(t * 9 + p.id), 1);
      }
      break;
    }
    case 'font': {
      const w = o.getObjectByName('water') as THREE.Mesh | undefined;
      if (w) w.material = p.on ? M.ice : M.water;
      break;
    }
    case 'door': {
      const d = o.getObjectByName('door');
      const s = o.getObjectByName('sigil');
      if (d) d.position.y = phase === 0 ? 1.7 : -1.6;
      if (s) {
        s.visible = phase === 0;
        s.rotation.z = t * 0.6;
      }
      break;
    }
    case 'chest': {
      const lid = o.getObjectByName('lid');
      if (lid) {
        lid.rotation.x = phase === 2 ? -1.1 : 0;
        lid.position.z = phase === 2 ? -0.3 : 0;
      }
      break;
    }
  }
}

export function ContentLayer() {
  const scene = useThree((s) => s.scene);
  const root = useMemo(() => new THREE.Group(), []);
  const herbs = useMemo(() => {
    const m = new THREE.InstancedMesh(G.leaf, M.herb, MAX_HERBS * 3);
    m.count = 0;
    m.frustumCulled = false;
    return m;
  }, []);
  useEffect(() => {
    scene.add(root);
    scene.add(herbs);
    return () => {
      scene.remove(root);
      scene.remove(herbs);
    };
  }, [scene, root, herbs]);

  // Keyed objects: "t:<site>", "v:<site>:<part>", "e:<id>".
  const objs = useMemo(() => new Map<string, THREE.Object3D>(), []);
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3(), p: new THREE.Vector3(), c: new THREE.Color(), e: new THREE.Euler() }), []);
  const herbColors = useMemo(() => CONTENT.forage.herbs.map((h) => new THREE.Color(h.color)), []);
  const herbAt = useMemo(() => ({ v: -1 }), []);

  useFrame(({ clock }) => {
    const s = useContent.getState();
    const t = clock.elapsedTime;
    const px = localPlayer.pos.x;
    const pz = localPlayer.pos.z;
    const now = performance.now();
    const want = new Set<string>();
    // Lore tablets.
    for (const tb of Object.values(s.tablets)) {
      if (Math.hypot(tb.x - px, tb.z - pz) > TABLET_M) continue;
      const k = `t:${tb.site}`;
      want.add(k);
      let o = objs.get(k);
      if (!o) {
        const g = new THREE.Group();
        const slab = new THREE.Mesh(G.tablet, M.stone);
        slab.position.y = 0.6;
        slab.rotation.z = 0.04;
        slab.castShadow = true;
        const rune = new THREE.Mesh(G.rune, M.rune);
        rune.name = 'rune';
        rune.position.set(0, 0.85, 0.12);
        g.add(slab, rune);
        g.position.set(tb.x, tb.y - 0.05, tb.z);
        g.rotation.y = (tb.site * 1.7) % (Math.PI * 2);
        o = g;
        objs.set(k, o);
        root.add(o);
      }
      const rune = o.getObjectByName('rune') as THREE.Mesh | undefined;
      if (rune) {
        rune.material = tb.read || s.sync.tablets.includes(tb.id) ? M.runeRead : M.rune;
        rune.scale.setScalar(tb.read ? 1 : 1 + 0.08 * Math.sin(t * 2 + tb.site));
      }
    }
    // Vault parts.
    for (const v of Object.values(s.vaults)) {
      if (Math.hypot(v.x - px, v.z - pz) > 260) continue;
      for (const p of v.parts) {
        const k = `v:${v.site}:${p.id}`;
        want.add(k);
        let o = objs.get(k);
        if (!o) {
          o = vaultPartObject(p, v.element);
          o.rotation.y = Math.atan2(v.x - p.x, v.z - p.z);
          objs.set(k, o);
          root.add(o);
        }
        applyPart(o, p, v.phase, t);
      }
    }
    // World events.
    const beam = questBeamResources();
    for (const e of Object.values(s.events)) {
      const k = `e:${e.id}`;
      if (e.phase !== EVENT_PHASE.active && now - e.at > 6000) continue;
      want.add(k);
      let o = objs.get(k);
      if (!o) {
        const g = new THREE.Group();
        const bm = new THREE.Mesh(beam.geo, beam.mat.clone());
        (bm.material as THREE.MeshBasicMaterial).color.set(e.kind === 'wildhunt' ? '#9f8cff' : '#ff7b54');
        bm.name = 'beam';
        bm.scale.set(1.6, 1, 1.6);
        bm.renderOrder = 4;
        bm.frustumCulled = false;
        g.add(bm);
        if (e.kind === 'caravan') {
          const wagon = new THREE.Group();
          const body = new THREE.Mesh(G.wagon, M.wood);
          body.position.y = 1.0;
          const cover = new THREE.Mesh(G.cover, M.cloth);
          cover.rotation.x = Math.PI / 2;
          cover.rotation.z = Math.PI / 2;
          cover.position.y = 1.5;
          wagon.add(body, cover);
          for (const [x, z] of [[-1.15, 1.2], [1.15, 1.2], [-1.15, -1.2], [1.15, -1.2]]) {
            const w = new THREE.Mesh(G.wheel, M.wood);
            w.rotation.z = Math.PI / 2;
            w.position.set(x, 0.55, z);
            wagon.add(w);
          }
          wagon.traverse((x) => (x.castShadow = true));
          g.add(wagon);
        }
        if (e.kind === 'starfall') {
          const cr = new THREE.Mesh(G.crater, M.crater);
          cr.rotation.x = -Math.PI / 2;
          cr.position.y = 0.06;
          const sh = new THREE.Mesh(G.shard, M.shard);
          sh.name = 'shard';
          sh.position.y = 1.2;
          sh.scale.set(1, 1.6, 1);
          g.add(cr, sh);
        }
        o = g;
        objs.set(k, o);
        root.add(o);
      }
      o.position.set(e.x, e.y, e.z);
      const bm = o.getObjectByName('beam') as THREE.Mesh | undefined;
      if (bm) {
        const d = Math.hypot(e.x - px, e.z - pz);
        const mat = bm.material as THREE.MeshBasicMaterial;
        mat.opacity = e.phase === EVENT_PHASE.active ? Math.min(0.55, Math.max(0.08, (d - 20) / 120)) : 0.1;
      }
      const sh = o.getObjectByName('shard');
      if (sh) sh.rotation.y = t * 0.8;
    }
    for (const [k, o] of objs) {
      if (!want.has(k)) {
        root.remove(o);
        o.traverse((x) => {
          if (x instanceof THREE.Mesh && x.name === 'beam') (x.material as THREE.Material).dispose();
        });
        objs.delete(k);
      }
    }
    // Herb patches: three leaves per ready patch nearby (rebuilt 2.5 times a second).
    if (t - herbAt.v < 0.4) return;
    herbAt.v = t;
    let n = 0;
    for (const h of Object.values(s.patches)) {
      if (n >= MAX_HERBS * 3) break;
      if (h.readyAt > now || Math.abs(h.x - px) > HERB_M || Math.abs(h.z - pz) > HERB_M) continue;
      if (CONTENT.forage.herbs[h.herb - 1]?.item.startsWith('wood:')) continue; // CR 025: deadfall is drawn as branches (ui/camps/CampLayer.tsx)
      const col = herbColors[h.herb - 1] ?? herbColors[0];
      for (let i = 0; i < 3; i++) {
        const a = h.id * 2.3 + i * 2.1;
        tmp.p.set(h.x + Math.cos(a) * 0.22, h.y + 0.2, h.z + Math.sin(a) * 0.22);
        tmp.e.set(Math.cos(a) * 0.35, 0, Math.sin(a) * 0.35);
        tmp.q.setFromEuler(tmp.e);
        tmp.s.setScalar(0.8 + 0.25 * ((i + h.id) % 3));
        tmp.m.compose(tmp.p, tmp.q, tmp.s);
        herbs.setMatrixAt(n, tmp.m);
        herbs.setColorAt(n, col);
        n++;
      }
    }
    {
      herbs.count = n;
      herbs.instanceMatrix.needsUpdate = true;
      if (herbs.instanceColor) herbs.instanceColor.needsUpdate = true;
    }
  });
  return null;
}
