// The 3D half of combat (WP13): enemies drawn from the interpolation buffer
// (EntityKind enemy, typeId -> look), telegraph decals, projectiles, area
// spells, beams, hit sparks, floating damage numbers and the first-person
// weapon with its swing. Mounted inside the world canvas by NetPlay.
//
// Everything is imperative three.js in one useFrame (no React state per
// frame), with small pooled geometries and materials: a camp is a handful
// of meshes, a boss fight a few dozen, far inside the draw-call budget.

import { useEffect, useMemo } from 'react';
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { HITSTOP_MS } from '@lodestone/contracts';
import { drawnRemotes } from '../net/netStore';
import type { RemoteView } from '../net/interpolation';
import { combatRuntime } from './link';
import { ELEMENT_COLORS, enemyInfo } from './events';
import { fxQueue, type Fx } from './store';

const geo = {
  body: new THREE.CapsuleGeometry(0.45, 0.7, 4, 10),
  head: new THREE.SphereGeometry(0.28, 12, 10),
  ring: new THREE.RingGeometry(0.85, 1, 48),
  disc: new THREE.CircleGeometry(1, 48),
  sphere: new THREE.SphereGeometry(1, 10, 8),
  bar: new THREE.PlaneGeometry(1, 0.09),
  spark: new THREE.OctahedronGeometry(0.12, 0),
};

interface EnemyMesh {
  root: THREE.Group;
  body: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  bar: THREE.Mesh;
  barBack: THREE.Mesh;
  plate: THREE.Group;
  label: THREE.Sprite | null;
  aura: THREE.Mesh | null;
  flash: number;
  phase: number;
}

function makeEnemy(v: RemoteView): EnemyMesh {
  const info = enemyInfo(v);
  const root = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: info.color, roughness: 0.7, emissive: new THREE.Color(0x000000) });
  const body = new THREE.Mesh(geo.body, mat);
  const s = info.size;
  body.scale.setScalar(s);
  body.position.y = 0.8 * s;
  body.castShadow = true;
  if (info.family === 'beast' || info.family === 'cave') {
    body.rotation.x = Math.PI / 2; // four-legged silhouette
    body.position.y = 0.55 * s;
  }
  root.add(body);
  const head = new THREE.Mesh(geo.head, mat);
  head.scale.setScalar(s);
  head.position.set(0, info.family === 'beast' || info.family === 'cave' ? 0.7 * s : 1.55 * s, info.family === 'beast' || info.family === 'cave' ? -0.6 * s : 0);
  root.add(head);
  let aura: THREE.Mesh | null = null;
  if (info.affix > 0 || info.element < 8) {
    const c = ELEMENT_COLORS[info.element] ?? '#ffffff';
    aura = new THREE.Mesh(geo.ring, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: info.affix ? 0.9 : 0.45, side: THREE.DoubleSide }));
    aura.rotation.x = -Math.PI / 2;
    aura.position.y = 0.05;
    aura.scale.setScalar(s * (info.affix === 7 ? 1.6 : 1.1));
    root.add(aura);
  }
  // Playtest 1: the bar (and a named enemy's label) sit in a plate that is
  // turned to face the camera every frame (billboard), double-sided, so it
  // reads from any angle (it used to be turned with the body and vanished
  // from behind).
  const plate = new THREE.Group();
  plate.position.y = 2.1 * s + 0.2;
  const barBack = new THREE.Mesh(geo.bar, new THREE.MeshBasicMaterial({ color: '#222222', depthTest: false, side: THREE.DoubleSide }));
  const bar = new THREE.Mesh(geo.bar, new THREE.MeshBasicMaterial({ color: info.affix === 7 ? '#ff4040' : info.affix ? '#ffb020' : '#d04040', depthTest: false, side: THREE.DoubleSide }));
  barBack.renderOrder = bar.renderOrder = 10;
  bar.position.z = 0.001;
  barBack.scale.x = Math.max(1, s * 0.6);
  plate.add(barBack, bar);
  let label: THREE.Sprite | null = null;
  if (v.name) {
    label = labelSprite(v.name, info.affix === 7 ? '#ff8080' : info.affix ? '#ffd27a' : '#f1f3f5');
    label.position.y = 0.26;
    plate.add(label);
  }
  root.add(plate);
  return { root, body, mat, bar, barBack, plate, label, aura, flash: 0, phase: Math.random() * 10 };
}

/** A name label (sprites always face the camera). */
function labelSprite(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.font = '600 26px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText(text, 128, 24, 250);
  g.fillStyle = color;
  g.fillText(text, 128, 24, 250);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(1.6, 0.3, 1);
  sp.renderOrder = 11;
  return sp;
}

const _q = new THREE.Quaternion();

/**
 * Turns `plate` (a child of a rotated parent) to face the camera: its world
 * rotation becomes the camera's, whatever the parent's yaw (billboard).
 * Exported for tests.
 */
export function faceCamera(plate: THREE.Object3D, camera: THREE.Camera): void {
  const parent = plate.parent;
  if (parent) {
    parent.updateWorldMatrix(true, false);
    parent.getWorldQuaternion(_q).invert();
    plate.quaternion.copy(_q).multiply(camera.getWorldQuaternion(new THREE.Quaternion()));
  } else plate.quaternion.copy(camera.quaternion);
}

/** The newest melee swing (set from the FX queue, read by the weapon). */
const swing = { at: 0, dur: 0 };

interface Live {
  fx: Fx;
  obj: THREE.Object3D;
  until: number;
}

function numberSprite(text: string, color: string, big: boolean): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.font = `bold ${big ? 44 : 34}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,0.8)';
  g.strokeText(text, 64, 32);
  g.fillStyle = color;
  g.fillText(text, 64, 32);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(1.2, 0.6, 1);
  sp.renderOrder = 20;
  return sp;
}

const NUMBER_COLORS: Record<string, string> = { dealt: '#ffffff', crit: '#ffd84a', weak: '#ffa030', resist: '#9aa0a8', taken: '#ff5050', heal: '#60ff80', miss: '#9aa0a8' };

function telegraphMesh(f: Extract<Fx, { t: 'telegraph' }>): THREE.Object3D {
  const mat = new THREE.MeshBasicMaterial({ color: '#ff3020', transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
  let m: THREE.Mesh;
  switch (f.shape) {
    case 0: {
      // cone: a sector
      const g = new THREE.CircleGeometry(f.reach, 32, -((f.arc / 2) * Math.PI) / 180, (f.arc * Math.PI) / 180);
      m = new THREE.Mesh(g, mat);
      m.rotation.set(-Math.PI / 2, 0, f.yaw + Math.PI / 2);
      break;
    }
    case 3: {
      const g = new THREE.PlaneGeometry(f.width, f.reach);
      g.translate(0, f.reach / 2, 0);
      m = new THREE.Mesh(g, mat);
      m.rotation.set(-Math.PI / 2, 0, f.yaw);
      break;
    }
    default:
      m = new THREE.Mesh(geo.disc, mat);
      m.scale.setScalar(Math.max(0.5, f.radius));
      m.rotation.x = -Math.PI / 2;
  }
  m.position.set(f.x, f.y + 0.08, f.z);
  m.renderOrder = 5;
  return m;
}

/** The first-person weapon and its swing (parented to the camera). */
function Weapon() {
  const group = useMemo(() => new THREE.Group(), []);
  const parts = useMemo(() => {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 0.9), new THREE.MeshStandardMaterial({ color: '#d8dde4', metalness: 0.8, roughness: 0.25 }));
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.8, 6), new THREE.MeshStandardMaterial({ color: '#6b4a2a', roughness: 0.8 }));
    const bow = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.02, 6, 24, Math.PI * 0.9), new THREE.MeshStandardMaterial({ color: '#7a5230', roughness: 0.7 }));
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.05, 0), new THREE.MeshStandardMaterial({ color: '#8fd4ff', emissive: '#4fb4ff', emissiveIntensity: 0.8 }));
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshStandardMaterial({ color: '#c9a27e' }));
    return { blade, shaft, bow, gem, hand };
  }, []);
  const camera = useThree((s) => s.camera);
  const state = useMemo(() => ({ swingT: 0, swingDur: 0, swinging: false, lastSeq: -1, freezeAt: 0, measured: false }), []);
  useEffect(() => {
    group.position.set(0.3, -0.32, -0.45);
    group.add(parts.hand);
    return () => void group.clear();
  }, [group, parts]);
  useFrame((_, delta) => {
    const rt = combatRuntime.current;
    if (!rt) return;
    const now = performance.now();
    const w = rt.weaponName();
    parts.blade.visible = w === 'sword';
    parts.shaft.visible = w === 'spear' || w === 'staff';
    parts.bow.visible = w === 'bow';
    parts.gem.visible = w === 'staff' || w === 'wand';
    for (const p of [parts.blade, parts.shaft, parts.bow, parts.gem]) if (!p.parent) group.add(p);
    parts.blade.position.set(0, 0.02, -0.45);
    parts.shaft.rotation.x = Math.PI / 2;
    parts.shaft.position.set(0, 0, w === 'spear' ? -0.6 : -0.3);
    parts.shaft.scale.set(1, w === 'staff' ? 0.7 : 1, 1);
    parts.gem.position.set(0, 0, w === 'staff' ? -0.95 : -0.4);
    parts.bow.rotation.set(0, Math.PI / 2, Math.PI / 2);
    parts.bow.position.set(-0.05, 0.05, -0.3);
    // Swing: driven by the newest started melee move; hitstop freezes it.
    const frozen = now < rt.hitstopUntil;
    if (frozen && !state.freezeAt) state.freezeAt = now;
    if (!frozen && state.freezeAt) {
      rt.probe.hitstopMeasured(now - state.freezeAt);
      state.freezeAt = 0;
    }
    if (swing.at > state.lastSeq) {
      state.lastSeq = swing.at;
      state.swingT = 0;
      state.swingDur = swing.dur;
      state.swinging = true;
    }
    if (!frozen) state.swingT += delta * 1000;
    const a = Math.min(1, state.swingT / Math.max(1, state.swingDur));
    const sw = state.swinging ? Math.sin(a * Math.PI) : 0;
    group.rotation.set(-0.35 + sw * 0.9, sw * 0.8, -sw * 0.5);
    if (a >= 1) state.swinging = false;
  });
  return createPortal(<primitive object={group} />, camera);
}

export function CombatLayer() {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const root = useMemo(() => new THREE.Group(), []);
  const enemies = useMemo(() => new Map<number, EnemyMesh>(), []);
  const live = useMemo<Live[]>(() => [], []);

  useEffect(() => {
    scene.add(root);
    return () => {
      scene.remove(root);
      root.clear();
      enemies.clear();
    };
  }, [scene, root, enemies]);

  useFrame((_, delta) => {
    const rt = combatRuntime.current;
    const now = performance.now();
    rt?.update(delta * 1000);
    const views = drawnRemotes.views.filter((v) => v.kind === 2);
    rt?.noteBossHealth(views);
    const frozen = rt ? now < rt.hitstopUntil : false;

    // Enemies.
    const seen = new Set<number>();
    for (const v of views) {
      seen.add(v.id);
      let m = enemies.get(v.id);
      if (!m) {
        m = makeEnemy(v);
        enemies.set(v.id, m);
        root.add(m.root);
      }
      const info = enemyInfo(v);
      if (!frozen || m.flash <= 0) {
        m.root.position.set(v.x, v.y, v.z);
        m.root.rotation.y = v.yaw;
      }
      m.phase += delta * (2 + v.speed);
      if (info.behavior === 'flyer') m.body.position.y = 0.8 * info.size + Math.sin(m.phase) * 0.15;
      const winding = (v.activity & 8) !== 0;
      const dead = v.healthPct === 0;
      m.mat.emissive.set(winding ? '#ff2010' : m.flash > 0 ? '#ffffff' : '#000000');
      m.mat.emissiveIntensity = winding ? 0.6 + 0.4 * Math.sin(now / 60) : m.flash > 0 ? 1 : 0;
      m.flash = Math.max(0, m.flash - delta);
      m.root.scale.setScalar(dead ? Math.max(0.01, m.root.scale.x - delta * 2) : 1);
      m.bar.scale.x = Math.max(0.001, (v.healthPct / 100) * m.barBack.scale.x);
      m.bar.position.x = -(m.barBack.scale.x - m.bar.scale.x) / 2;
      m.plate.visible = !dead;
      faceCamera(m.plate, camera);
    }
    for (const [id, m] of enemies) {
      if (!seen.has(id)) {
        root.remove(m.root);
        m.mat.dispose();
        (m.bar.material as THREE.Material).dispose();
        (m.barBack.material as THREE.Material).dispose();
        if (m.label) {
          (m.label.material as THREE.SpriteMaterial).map?.dispose();
          (m.label.material as THREE.SpriteMaterial).dispose();
        }
        enemies.delete(id);
      }
    }

    // New FX.
    while (fxQueue.length) {
      const f = fxQueue.shift()!;
      let obj: THREE.Object3D | null = null;
      let until = now + 400;
      switch (f.t) {
        case 'spark': {
          obj = new THREE.Mesh(geo.spark, new THREE.MeshBasicMaterial({ color: f.color }));
          obj.position.set(f.x, f.y, f.z);
          until = now + 200;
          for (const [, m] of enemies) if (m.root.position.distanceTo(new THREE.Vector3(f.x, f.y - 1, f.z)) < 2.5) m.flash = HITSTOP_MS / 1000;
          break;
        }
        case 'number': {
          const n = f.n;
          obj = numberSprite(String(n.value), NUMBER_COLORS[n.kind] ?? '#fff', n.kind === 'crit');
          obj.position.set(n.x, n.y, n.z);
          until = now + 900;
          break;
        }
        case 'telegraph':
          obj = telegraphMesh(f);
          until = now + f.windupMs + 250;
          break;
        case 'projectile':
          obj = new THREE.Mesh(geo.sphere, new THREE.MeshBasicMaterial({ color: f.color }));
          obj.scale.setScalar(f.radius);
          obj.position.set(f.x, f.y, f.z);
          until = now + f.life * 1000;
          break;
        case 'area': {
          const m = new THREE.Mesh(geo.disc, new THREE.MeshBasicMaterial({ color: f.color, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
          m.rotation.x = -Math.PI / 2;
          m.position.set(f.x, f.y + 0.1, f.z);
          m.scale.setScalar(Math.max(0.3, f.radius));
          obj = m;
          until = now + f.durationMs;
          break;
        }
        case 'beam': {
          const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(f.x, f.y, f.z), new THREE.Vector3(f.x2, f.y2, f.z2)]);
          obj = new THREE.Line(g, new THREE.LineBasicMaterial({ color: f.color }));
          until = now + f.durationMs;
          break;
        }
        case 'swing':
          swing.at = f.at;
          swing.dur = f.durationMs + 120;
          break;
      }
      if (obj) {
        root.add(obj);
        live.push({ fx: f, obj, until });
      }
    }

    // Animate and expire FX.
    for (let i = live.length - 1; i >= 0; i--) {
      const l = live[i];
      const f = l.fx;
      if (now >= l.until) {
        root.remove(l.obj);
        live.splice(i, 1);
        continue;
      }
      if (f.t === 'projectile') {
        const t = (now - f.at) / 1000;
        l.obj.position.set(f.x + f.vx * t, f.y + f.vy * t - 0.5 * f.gravity * t * t, f.z + f.vz * t);
      } else if (f.t === 'number') {
        l.obj.position.y += delta * 1.2;
        ((l.obj as THREE.Sprite).material as THREE.SpriteMaterial).opacity = Math.max(0, (l.until - now) / 400);
      } else if (f.t === 'telegraph') {
        const k = Math.min(1, (now - f.at) / Math.max(1, f.windupMs));
        const mat = (l.obj as THREE.Mesh).material as THREE.MeshBasicMaterial;
        mat.opacity = 0.2 + 0.45 * k;
      } else if (f.t === 'spark') {
        l.obj.scale.setScalar(1 + (now - f.at) / 60);
      } else if (f.t === 'area') {
        const mat = (l.obj as THREE.Mesh).material as THREE.MeshBasicMaterial;
        mat.opacity = 0.35 * Math.max(0, (l.until - now) / Math.max(1, f.durationMs));
      }
    }
  });

  return <Weapon />;
}
