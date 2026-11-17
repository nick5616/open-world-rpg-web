// Draws building pieces (CR 041): one InstancedMesh per (kind, door state)
// with the merged vertex-coloured models of models.ts, an unlit glow mesh
// for coals and lantern glass, the night layer's flame cards, and a fixed
// pool of point lights for the nearest glowing pieces (the count never
// changes: no recompiles). Works on its own (the dev lab uses it without
// React). `sync` rebuilds instance data when the pieces or the viewer
// moved; `frame` only moves the light pool and the glow's gentle sway.

import * as THREE from 'three';
import { flameGeometry, flameMat } from '../../systems/NightLayer';
import type { CampPiece } from '../camps/events';
import { isBuild, rotCS } from './geometry';
import { pieceGeo, type PieceGeo } from './models';

export const BUILD_SHOW_M = 220;
const MAX_FLAMES = 40;
export const BUILD_LIGHTS = 2;

interface Group {
  geo: PieceGeo;
  solid: THREE.InstancedMesh;
  glow: THREE.InstancedMesh | null;
  cap: number;
}

interface Spot {
  x: number;
  y: number;
  z: number;
  d: number;
}

export class BuildRenderer {
  readonly root = new THREE.Group();
  readonly lights: THREE.PointLight[] = [];
  readonly solidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.02 });
  readonly glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true });
  private readonly flames: THREE.InstancedMesh;
  private readonly groups = new Map<string, Group>();
  private spots: Spot[] = [];
  /** How many pieces were drawn at the last sync. */
  drawn = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(withLights = true) {
    this.root.name = 'build';
    this.flames = new THREE.InstancedMesh(flameGeometry(), flameMat, MAX_FLAMES);
    this.flames.frustumCulled = false;
    this.flames.count = 0;
    this.flames.renderOrder = 6;
    this.root.add(this.flames);
    if (withLights)
      for (let i = 0; i < BUILD_LIGHTS; i++) {
        const l = new THREE.PointLight('#ffa755', 0, 14, 1.6);
        l.castShadow = false;
        this.lights.push(l);
        this.root.add(l);
      }
  }

  private group(kind: number, open: boolean, n: number): Group {
    const key = `${kind}:${open ? 1 : 0}`;
    let g = this.groups.get(key);
    if (g && g.cap >= n) return g;
    if (g) {
      this.root.remove(g.solid);
      g.solid.dispose();
      if (g.glow) {
        this.root.remove(g.glow);
        g.glow.dispose();
      }
    }
    const geo = g?.geo ?? pieceGeo(kind, open);
    let cap = 16;
    while (cap < n) cap *= 2;
    const solid = new THREE.InstancedMesh(geo.solid, this.solidMat, cap);
    solid.frustumCulled = false;
    solid.castShadow = true;
    solid.receiveShadow = true;
    solid.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(solid);
    let glow: THREE.InstancedMesh | null = null;
    if (geo.glow) {
      glow = new THREE.InstancedMesh(geo.glow, this.glowMat, cap);
      glow.frustumCulled = false;
      this.root.add(glow);
    }
    g = { geo, solid, glow, cap };
    this.groups.set(key, g);
    return g;
  }

  /** Rebuild every instance for the building pieces within BUILD_SHOW_M of (px, pz). */
  sync(pieces: Iterable<CampPiece>, px: number, pz: number): void {
    const by = new Map<string, CampPiece[]>();
    let n = 0;
    for (const p of pieces) {
      if (!isBuild(p.kind) || Math.abs(p.x - px) > BUILD_SHOW_M || Math.abs(p.z - pz) > BUILD_SHOW_M) continue;
      const open = (p.state & 1) === 1;
      const k = `${p.kind}:${open ? 1 : 0}`;
      const l = by.get(k);
      if (l) l.push(p);
      else by.set(k, [p]);
      n++;
    }
    this.drawn = n;
    for (const [k, g] of this.groups) {
      if (!by.has(k)) {
        g.solid.count = 0;
        if (g.glow) g.glow.count = 0;
      }
    }
    const flames: { x: number; y: number; z: number; s: number; id: number }[] = [];
    const spots: Spot[] = [];
    for (const [k, list] of by) {
      const [kind, open] = k.split(':').map(Number);
      const g = this.group(kind, open === 1, list.length);
      list.forEach((p, i) => {
        this.q.setFromAxisAngle(this.up, -p.rot * (Math.PI / 4));
        this.m.compose(this.v.set(p.x, p.y, p.z), this.q, this.s.set(1, 1, 1));
        g.solid.setMatrixAt(i, this.m);
        g.glow?.setMatrixAt(i, this.m);
        const w = p.cond >= 60 ? 1 : 0.55 + (0.45 * p.cond) / 60;
        g.solid.setColorAt(i, this.c.setRGB(w, w * 0.98, w * 0.94));
        const [cs, sn] = rotCS(p.rot);
        const world = (u: number, v: number) => [p.x + u * cs - v * sn, p.z + u * sn + v * cs];
        for (const f of g.geo.flames) {
          const [fx, fz] = world(f[0], f[2]);
          flames.push({ x: fx, y: p.y + f[1], z: fz, s: f[3], id: p.id });
        }
        if (g.geo.light) {
          const [lx, lz] = world(g.geo.light[0], g.geo.light[2]);
          spots.push({ x: lx, y: p.y + g.geo.light[1], z: lz, d: 0 });
        }
      });
      g.solid.count = list.length;
      g.solid.instanceMatrix.needsUpdate = true;
      if (g.solid.instanceColor) g.solid.instanceColor.needsUpdate = true;
      if (g.glow) {
        g.glow.count = list.length;
        g.glow.instanceMatrix.needsUpdate = true;
      }
    }
    flames.sort((a, b) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(b.x - px, b.z - pz));
    let nf = 0;
    for (const f of flames.slice(0, MAX_FLAMES)) {
      this.q.setFromAxisAngle(this.up, (f.id % 7) * 0.45);
      this.m.compose(this.v.set(f.x, f.y, f.z), this.q, this.s.set(f.s, f.s * 1.35, f.s));
      this.flames.setMatrixAt(nf++, this.m);
    }
    this.flames.count = nf;
    this.flames.instanceMatrix.needsUpdate = true;
    this.spots = spots;
  }

  /** Per frame: the light pool (nearest glowing pieces) and the glow's sway. `dark` 0 (noon) to 1 (night); `calm` keeps the sway tiny (Reduce flashing). */
  frame(t: number, px: number, py: number, pz: number, dark: number, calm: boolean): void {
    const amp = calm ? 0.025 : 0.06;
    this.glowMat.color.setScalar(1 + amp * Math.sin(t * 1.7) + amp * 0.5 * Math.sin(t * 3.1));
    if (this.lights.length === 0) return;
    for (const s of this.spots) s.d = Math.hypot(s.x - px, s.z - pz) + Math.abs(s.y - py) * 0.5;
    const near = this.spots.length > BUILD_LIGHTS ? [...this.spots].sort((a, b) => a.d - b.d).slice(0, BUILD_LIGHTS) : this.spots;
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const s = near[i];
      if (!s || s.d > 60) {
        l.intensity = 0;
        continue;
      }
      l.position.set(s.x, s.y, s.z);
      l.intensity = (3 + 8 * dark) * (0.94 + amp * Math.sin(t * 1.9 + i * 2));
    }
  }

  dispose(): void {
    for (const g of this.groups.values()) {
      g.solid.dispose();
      g.glow?.dispose();
    }
    this.groups.clear();
    this.solidMat.dispose();
    this.glowMat.dispose();
  }
}

// ---- the ghost ----

const ghostOk = new THREE.MeshStandardMaterial({ color: '#7dff8a', emissive: new THREE.Color('#2f9a3a'), emissiveIntensity: 0.55, transparent: true, opacity: 0.55, depthWrite: false });
const ghostBad = new THREE.MeshStandardMaterial({ color: '#ff6a5a', emissive: new THREE.Color('#9a2a20'), emissiveIntensity: 0.55, transparent: true, opacity: 0.55, depthWrite: false });

/** A see-through copy of a piece, green or red (shared geometry, not instanced). */
export function ghostMesh(kind: number, ok: boolean, open = false): THREE.Mesh {
  const m = new THREE.Mesh(pieceGeo(kind, open).solid, ok ? ghostOk : ghostBad);
  m.renderOrder = 7;
  m.frustumCulled = false;
  return m;
}
