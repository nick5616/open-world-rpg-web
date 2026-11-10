// The pre-playtest-2 enemy look (CombatLayer makeEnemy before the enemy
// models): a capsule body + sphere head per enemy, its own material, an
// aura ring, a billboarded health bar with two own materials, turned to the
// camera every frame. Kept only as the "before" of the crowd benchmark and
// the evidence sheets (gallery.ts ?legacy).

import * as THREE from 'three';
import type { RemoteView } from '../../../net/interpolation';
import { ELEMENT_COLORS, enemyInfo } from '../../events';

const geo = {
  body: new THREE.CapsuleGeometry(0.45, 0.7, 4, 10),
  head: new THREE.SphereGeometry(0.28, 12, 10),
  ring: new THREE.RingGeometry(0.85, 1, 48),
  bar: new THREE.PlaneGeometry(1, 0.09),
};

interface Old {
  root: THREE.Group;
  body: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  bar: THREE.Mesh;
  barBack: THREE.Mesh;
  plate: THREE.Group;
  phase: number;
}

const _q = new THREE.Quaternion();
const _cq = new THREE.Quaternion();

export class LegacyEnemies {
  readonly root = new THREE.Group();
  private map = new Map<number, Old>();

  private make(v: RemoteView): Old {
    const info = enemyInfo(v);
    const root = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: info.color, roughness: 0.7, emissive: new THREE.Color(0x000000) });
    const body = new THREE.Mesh(geo.body, mat);
    const s = info.size;
    body.scale.setScalar(s);
    body.position.y = 0.8 * s;
    body.castShadow = true;
    const quad = info.family === 'beast' || info.family === 'cave';
    if (quad) {
      body.rotation.x = Math.PI / 2;
      body.position.y = 0.55 * s;
    }
    root.add(body);
    const head = new THREE.Mesh(geo.head, mat);
    head.scale.setScalar(s);
    head.position.set(0, quad ? 0.7 * s : 1.55 * s, quad ? -0.6 * s : 0);
    root.add(head);
    if (info.affix > 0 || info.element < 8) {
      const aura = new THREE.Mesh(geo.ring, new THREE.MeshBasicMaterial({ color: ELEMENT_COLORS[info.element] ?? '#ffffff', transparent: true, opacity: info.affix ? 0.9 : 0.45, side: THREE.DoubleSide }));
      aura.rotation.x = -Math.PI / 2;
      aura.position.y = 0.05;
      aura.scale.setScalar(s * 1.1);
      root.add(aura);
    }
    const plate = new THREE.Group();
    plate.position.y = 2.1 * s + 0.2;
    const barBack = new THREE.Mesh(geo.bar, new THREE.MeshBasicMaterial({ color: '#222222', depthTest: false, side: THREE.DoubleSide }));
    const bar = new THREE.Mesh(geo.bar, new THREE.MeshBasicMaterial({ color: '#d04040', depthTest: false, side: THREE.DoubleSide }));
    barBack.renderOrder = bar.renderOrder = 10;
    bar.position.z = 0.001;
    barBack.scale.x = Math.max(1, s * 0.6);
    plate.add(barBack, bar);
    root.add(plate);
    this.root.add(root);
    return { root, body, mat, bar, barBack, plate, phase: Math.random() * 10 };
  }

  update(views: readonly RemoteView[], camera: THREE.Camera, dt: number, now: number): void {
    for (const v of views) {
      if (v.kind !== 2) continue;
      let m = this.map.get(v.id);
      if (!m) {
        m = this.make(v);
        this.map.set(v.id, m);
      }
      const info = enemyInfo(v);
      m.root.position.set(v.x, v.y, v.z);
      m.root.rotation.y = v.yaw;
      m.phase += dt * (2 + v.speed);
      if (info.behavior === 'flyer') m.body.position.y = 0.8 * info.size + Math.sin(m.phase) * 0.15;
      const winding = (v.activity & 8) !== 0;
      m.mat.emissive.set(winding ? '#ff2010' : '#000000');
      m.mat.emissiveIntensity = winding ? 0.6 + 0.4 * Math.sin(now / 60) : 0;
      m.bar.scale.x = Math.max(0.001, (v.healthPct / 100) * m.barBack.scale.x);
      m.bar.position.x = -(m.barBack.scale.x - m.bar.scale.x) / 2;
      // faceCamera (as it was)
      m.root.updateWorldMatrix(true, false);
      m.root.getWorldQuaternion(_q).invert();
      m.plate.quaternion.copy(_q).multiply(camera.getWorldQuaternion(_cq));
    }
  }

  clear(): void {
    for (const m of this.map.values()) {
      this.root.remove(m.root);
      m.mat.dispose();
      (m.bar.material as THREE.Material).dispose();
      (m.barBack.material as THREE.Material).dispose();
    }
    this.map.clear();
  }
}
