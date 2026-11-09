// The 3D half of combat (WP13): enemies drawn from the interpolation buffer
// (EntityKind enemy, typeId -> look), telegraph decals, projectiles, area
// spells, beams, hit sparks, floating damage numbers and the first-person
// weapon with its swing. Mounted inside the world canvas by NetPlay.
//
// Everything is imperative three.js in one useFrame (no React state per
// frame), with small pooled geometries and materials: a camp is a handful
// of meshes, a boss fight a few dozen, far inside the draw-call budget.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { HITSTOP_MS } from '@lodestone/contracts';
import { drawnRemotes } from '../net/netStore';
import type { RemoteView } from '../net/interpolation';
import { combatRuntime } from './link';
import { ELEMENT_COLORS, enemyInfo } from './events';
import { fxQueue, type Fx } from './store';
// The newest melee swing (set from the FX queue below, read by the weapon).
import { FirstPersonWeapon, swing } from './weapons/FirstPersonWeapon';

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
  const barBack = new THREE.Mesh(geo.bar, new THREE.MeshBasicMaterial({ color: '#222222', depthTest: false }));
  const bar = new THREE.Mesh(geo.bar, new THREE.MeshBasicMaterial({ color: info.affix === 7 ? '#ff4040' : info.affix ? '#ffb020' : '#d04040', depthTest: false }));
  barBack.renderOrder = bar.renderOrder = 10;
  barBack.position.y = bar.position.y = 2.1 * s + 0.2;
  barBack.scale.x = Math.max(1, s * 0.6);
  root.add(barBack, bar);
  return { root, body, mat, bar, barBack, aura, flash: 0, phase: Math.random() * 10 };
}


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

/** The first-person weapon and its swing: weapons/FirstPersonWeapon.tsx (pt/ux). */
const Weapon = FirstPersonWeapon;

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
      m.bar.quaternion.copy(camera.quaternion);
      m.barBack.quaternion.copy(camera.quaternion);
    }
    for (const [id, m] of enemies) {
      if (!seen.has(id)) {
        root.remove(m.root);
        m.mat.dispose();
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
