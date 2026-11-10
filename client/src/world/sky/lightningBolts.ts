// Lightning bolts (playtest 2, CR 030): a jagged, branching channel from the
// cloud base down to where the bolt struck, as camera-facing ribbons in one
// additive HDR mesh (bloom makes it glow), flickering for ~0.45 s. The path
// is seeded by the strike id, so everyone who sees a bolt sees the same
// shape. The flash on the world (sky, fog, hemisphere light) is WorldScene's.

import * as THREE from 'three';
import type { Bolt } from '../../systems/weather/runtime';

const MAX_BOLTS = 4;
const MAIN_SEGS = 22;
const BRANCH_SEGS = 7;
const BRANCHES = 3;
const SEGS = MAIN_SEGS + BRANCHES * BRANCH_SEGS;
const LIFE_MS = 450;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

interface Path {
  id: number;
  /** Segment endpoints: SEGS pairs of points (x, y, z) and a width each. */
  pts: Float32Array;
  w: Float32Array;
}

function buildPath(b: Bolt): Path {
  const r = rng(b.id * 2654435761 + 12345);
  const pts = new Float32Array(SEGS * 6);
  const w = new Float32Array(SEGS);
  const top = b.y + 340 + r() * 120;
  const sx = b.x + (r() - 0.5) * 120;
  const sz = b.z + (r() - 0.5) * 120;
  const main: [number, number, number][] = [];
  for (let i = 0; i <= MAIN_SEGS; i++) {
    const f = i / MAIN_SEGS;
    const jit = i === 0 || i === MAIN_SEGS ? 0 : (1 - f * 0.7) * 26;
    main.push([sx + (b.x - sx) * f + (r() - 0.5) * jit, top + (b.y - top) * f, sz + (b.z - sz) * f + (r() - 0.5) * jit]);
  }
  let s = 0;
  for (let i = 0; i < MAIN_SEGS; i++, s++) {
    pts.set([...main[i], ...main[i + 1]], s * 6);
    w[s] = 1;
  }
  for (let bI = 0; bI < BRANCHES; bI++) {
    const from = main[2 + Math.floor(r() * (MAIN_SEGS - 8))];
    let p = from;
    const dx = (r() - 0.5) * 2;
    const dz = (r() - 0.5) * 2;
    for (let i = 0; i < BRANCH_SEGS; i++, s++) {
      const q: [number, number, number] = [p[0] + dx * 14 + (r() - 0.5) * 10, p[1] - 10 - r() * 14, p[2] + dz * 14 + (r() - 0.5) * 10];
      pts.set([...p, ...q], s * 6);
      w[s] = 0.45 * (1 - i / BRANCH_SEGS);
      p = q;
    }
  }
  return { id: b.id, pts, w };
}

/** Brightness over a bolt's life: a stroke, a dark gap, a restrike, the fade. */
export function boltBrightness(ms: number): number {
  if (ms < 0 || ms > LIFE_MS) return 0;
  if (ms < 60) return 1;
  if (ms < 110) return 0.2;
  if (ms < 190) return 0.95;
  return 0.75 * Math.exp(-(ms - 190) / 90);
}

export class LightningBolts {
  readonly object: THREE.Mesh;
  private readonly pos = new Float32Array(MAX_BOLTS * SEGS * 4 * 3);
  private readonly col = new Float32Array(MAX_BOLTS * SEGS * 4 * 3);
  private readonly paths = new Map<number, Path>();
  private readonly mat: THREE.MeshBasicMaterial;

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const idx = new Uint32Array(MAX_BOLTS * SEGS * 6);
    for (let q = 0; q < MAX_BOLTS * SEGS; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3], q * 6);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.object = new THREE.Mesh(geo, this.mat);
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.name = 'lightning';
    this.object.renderOrder = 5;
  }

  /** Per frame: ribbons for the live bolts (width in m, HDR intensity, style tint). */
  update(camera: THREE.Camera, bolts: Bolt[], now: number, width = 1.4, intensity = 7): void {
    const live = bolts.filter((b) => now - b.at < LIFE_MS).slice(-MAX_BOLTS);
    this.object.visible = live.length > 0;
    if (!live.length) {
      this.paths.clear();
      return;
    }
    const cam = camera.position;
    const pos = this.pos;
    const col = this.col;
    pos.fill(0);
    col.fill(0);
    let q = 0;
    for (const b of live) {
      let p = this.paths.get(b.id);
      if (!p) {
        p = buildPath(b);
        this.paths.set(b.id, p);
      }
      const br = boltBrightness(now - b.at) * intensity * (b.hit ? 1.3 : 1);
      for (let s = 0; s < SEGS; s++, q++) {
        const o = s * 6;
        const ax = p.pts[o], ay = p.pts[o + 1], az = p.pts[o + 2];
        const bx = p.pts[o + 3], by = p.pts[o + 4], bz = p.pts[o + 5];
        // Side vector: across the segment, facing the camera; wider far away so a distant bolt still reads.
        const dx = bx - ax, dy = by - ay, dz = bz - az;
        const mx = (ax + bx) / 2 - cam.x, my = (ay + by) / 2 - cam.y, mz = (az + bz) / 2 - cam.z;
        let sx = dy * mz - dz * my;
        let sy = dz * mx - dx * mz;
        let sz = dx * my - dy * mx;
        const sl = Math.hypot(sx, sy, sz) || 1;
        const dist = Math.hypot(mx, my, mz);
        const ww = width * p.w[s] * Math.max(1, dist / 260);
        sx = (sx / sl) * ww;
        sy = (sy / sl) * ww;
        sz = (sz / sl) * ww;
        const v = q * 12;
        pos.set([ax - sx, ay - sy, az - sz, ax + sx, ay + sy, az + sz, bx - sx, by - sy, bz - sz, bx + sx, by + sy, bz + sz], v);
        const c = br * (0.55 + 0.45 * p.w[s]);
        for (let k = 0; k < 4; k++) col.set([c * 0.85, c * 0.9, c * 1.15], v + k * 3);
      }
    }
    for (const id of this.paths.keys()) if (!live.some((b) => b.id === id)) this.paths.delete(id);
    const g = this.object.geometry;
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.mat.dispose();
  }
}
