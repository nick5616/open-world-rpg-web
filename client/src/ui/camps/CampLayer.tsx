// Camps in the world (playtest 2, CR 025): every known piece within a few
// hundred metres as a low-poly model (models.ts), burning campfires with the
// night layer's flame cards, warm point lights (the nearest few) and glowing
// embers, the positional fire loop (audio loopSources), deadfall branches
// where the content layer lists a firewood patch, and the placement ghost
// (green: the zone would take it; red: it would not) with its footprint.
// Imperative three.js in one useFrame, like ContentLayer.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { CAMPS, CONTENT } from '@lodestone/contracts';
import { localPlayer } from '../../state/live';
import { flameGeometry, flameMat } from '../../systems/NightLayer';
import { loopSources } from '../../audio/bridge';
import type { LoopEmitter } from '../../audio/loopPool';
import { useContent } from '../content/store';
import { PIECE, type CampPiece } from './events';
import { updateGhost } from './ghost';
import { deadfallModel, ghostify, pieceModel, CAMP_MAT } from './models';
import { corners, footprint } from './placement';
import { useCamps } from './store';

const SHOW_M = 260;
const DEADFALL_M = 110;
const MAX_FIRES = 16;
const MAX_LIGHTS = 3;

const ghostOk = new THREE.MeshStandardMaterial({ color: '#7dff8a', emissive: new THREE.Color('#2f9a3a'), emissiveIntensity: 0.6, transparent: true, opacity: 0.55, depthWrite: false });
const ghostBad = new THREE.MeshStandardMaterial({ color: '#ff6a5a', emissive: new THREE.Color('#9a2a20'), emissiveIntensity: 0.6, transparent: true, opacity: 0.55, depthWrite: false });
const emberLit = new THREE.MeshStandardMaterial({ color: '#5a2410', emissive: new THREE.Color('#ff6a20'), emissiveIntensity: 2.2, roughness: 1, flatShading: true });
const lineOk = new THREE.LineBasicMaterial({ color: '#9dffa5', transparent: true, opacity: 0.9, depthTest: false });
const lineBad = new THREE.LineBasicMaterial({ color: '#ff8a7a', transparent: true, opacity: 0.9, depthTest: false });

/** Burning campfires near (x, z) as fire loop emitters (audio). */
function fireEmitters(x: number, z: number): LoopEmitter[] {
  const now = performance.now();
  const out: LoopEmitter[] = [];
  for (const p of Object.values(useCamps.getState().pieces)) {
    if (p.kind !== PIECE.campfire || !p.burning || p.burnEnd <= now) continue;
    if (Math.abs(p.x - x) > 60 || Math.abs(p.z - z) > 60) continue;
    out.push({ id: `camp:${p.id}`, kind: 'campfire', x: p.x, y: p.y + 0.3, z: p.z, space: 0 });
  }
  return out;
}

interface Drawn {
  obj: THREE.Group;
  sig: string;
}

const sigOf = (p: CampPiece) => `${p.kind}:${p.rot}:${p.xCm}:${p.yCm}:${p.zCm}:${p.label}`;

export function CampLayer() {
  const scene = useThree((s) => s.scene);
  const parts = useMemo(() => {
    const root = new THREE.Group();
    root.name = 'camps';
    const flames = new THREE.InstancedMesh(flameGeometry(), flameMat, MAX_FIRES);
    flames.frustumCulled = false;
    flames.count = 0;
    flames.renderOrder = 6;
    const lights: THREE.PointLight[] = [];
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = new THREE.PointLight('#ff9a4a', 0, 16, 1.6);
      l.castShadow = false;
      lights.push(l);
      root.add(l);
    }
    const ghostRoot = new THREE.Group();
    ghostRoot.visible = false;
    const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([0, 1, 2, 3].map(() => new THREE.Vector3())), lineOk);
    outline.renderOrder = 7;
    outline.frustumCulled = false;
    const safe = new THREE.Mesh(new THREE.RingGeometry(CAMPS.fire.safeRadiusM - 0.15, CAMPS.fire.safeRadiusM, 64), new THREE.MeshBasicMaterial({ color: '#ffb35a', transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    safe.rotation.x = -Math.PI / 2;
    safe.visible = false;
    root.add(flames, ghostRoot, outline, safe);
    return { root, flames, lights, ghostRoot, outline, safe, ghostKind: 0, ghostBad: false, drawn: new Map<number, Drawn>(), deadfall: new Map<number, THREE.Group>(), slow: 0 };
  }, []);

  useEffect(() => {
    scene.add(parts.root);
    loopSources.add(fireEmitters);
    return () => {
      scene.remove(parts.root);
      loopSources.delete(fireEmitters);
    };
  }, [scene, parts]);

  const m4 = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const v = useMemo(() => new THREE.Vector3(), []);
  const sc = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  useFrame((state) => {
    const now = performance.now();
    const t = state.clock.elapsedTime;
    const s = useCamps.getState();
    const px = localPlayer.pos.x;
    const pz = localPlayer.pos.z;

    // Pieces: add, rebuild on change, drop when gone or far.
    for (const p of Object.values(s.pieces)) {
      const far = Math.abs(p.x - px) > SHOW_M || Math.abs(p.z - pz) > SHOW_M;
      const d = parts.drawn.get(p.id);
      const sig = sigOf(p);
      if (far) {
        if (d) {
          parts.root.remove(d.obj);
          parts.drawn.delete(p.id);
        }
        continue;
      }
      if (d && d.sig === sig) continue;
      if (d) parts.root.remove(d.obj);
      const obj = pieceModel(p.kind, p.id, p.label || (p.kind === PIECE.signpost ? `${p.owner}'s camp` : ''));
      obj.position.set(p.x, p.y, p.z);
      obj.rotation.y = -p.rot * (Math.PI / 4);
      obj.userData.piece = p.id;
      parts.root.add(obj);
      parts.drawn.set(p.id, { obj, sig });
    }
    for (const [id, d] of parts.drawn) {
      if (!s.pieces[id]) {
        parts.root.remove(d.obj);
        parts.drawn.delete(id);
      }
    }

    // Fires: flames, embers, the nearest lights.
    let nf = 0;
    const burning: CampPiece[] = [];
    for (const p of Object.values(s.pieces)) {
      if (p.kind !== PIECE.campfire) continue;
      const d = parts.drawn.get(p.id);
      const lit = p.burning && p.burnEnd > now;
      const ember = d?.obj.getObjectByName('ember') as THREE.Mesh | undefined;
      if (ember) ember.material = lit ? emberLit : CAMP_MAT.ember;
      if (!lit || !d) continue;
      burning.push(p);
      if (nf < MAX_FIRES) {
        const flick = 0.92 + 0.08 * Math.sin(t * 9 + p.id);
        q.setFromAxisAngle(up, (p.id % 7) * 0.45);
        m4.compose(v.set(p.x, p.y + 0.08, p.z), q, sc.set(0.42, 0.55 * flick, 0.42));
        parts.flames.setMatrixAt(nf++, m4);
      }
    }
    parts.flames.count = nf;
    parts.flames.instanceMatrix.needsUpdate = true;
    burning.sort((a, b) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(b.x - px, b.z - pz));
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = parts.lights[i];
      const p = burning[i];
      if (!p || Math.hypot(p.x - px, p.z - pz) > 80) {
        l.intensity = 0;
        continue;
      }
      l.position.set(p.x, p.y + 0.9, p.z);
      l.intensity = 9 * (0.85 + 0.15 * Math.sin(t * 11 + p.id) * Math.sin(t * 7.3 + p.id * 2));
    }

    // The ghost.
    const g = updateGhost();
    parts.ghostRoot.visible = g.active;
    parts.outline.visible = g.active;
    parts.safe.visible = g.active && g.kind === PIECE.campfire;
    if (g.active) {
      const bad = g.reason !== 0;
      if (parts.ghostKind !== g.kind || parts.ghostBad !== bad) {
        parts.ghostRoot.clear();
        const m = pieceModel(g.kind, 1, '');
        ghostify(m, bad ? ghostBad : ghostOk);
        parts.ghostRoot.add(m);
        parts.ghostKind = g.kind;
        parts.ghostBad = bad;
        parts.outline.material = bad ? lineBad : lineOk;
      }
      parts.ghostRoot.position.set(g.x, g.y, g.z);
      parts.ghostRoot.rotation.y = -g.rot * (Math.PI / 4);
      const f = footprint(g.kind, g.rot, g.x, g.z);
      const pos = parts.outline.geometry.attributes.position as THREE.BufferAttribute;
      corners(f).forEach(([cx, cz], i) => pos.setXYZ(i, cx, g.y + 0.06, cz));
      pos.needsUpdate = true;
      parts.safe.position.set(g.x, g.y + 0.08, g.z);
    } else if (parts.ghostKind) {
      parts.ghostRoot.clear();
      parts.ghostKind = 0;
    }

    // Deadfall branches (the content layer's firewood patches), 2.5 times a second.
    if (t - parts.slow < 0.4) return;
    parts.slow = t;
    const seen = new Set<number>();
    for (const h of Object.values(useContent.getState().patches)) {
      if (!CONTENT.forage.herbs[h.herb - 1]?.item.startsWith('wood:')) continue;
      if (h.readyAt > now || Math.abs(h.x - px) > DEADFALL_M || Math.abs(h.z - pz) > DEADFALL_M) continue;
      seen.add(h.id);
      if (parts.deadfall.has(h.id)) continue;
      const m = deadfallModel(h.id);
      m.position.set(h.x, h.y, h.z);
      parts.root.add(m);
      parts.deadfall.set(h.id, m);
    }
    for (const [id, m] of parts.deadfall) {
      if (!seen.has(id)) {
        parts.root.remove(m);
        parts.deadfall.delete(id);
      }
    }
  });
  return null;
}

