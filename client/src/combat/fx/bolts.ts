// Lightning bolts, chain arcs and crackle as camera-facing ribbons
// (materials.ts createRibbonMaterial). Adapted from wizard-wars fx/bolt.ts
// (jaggedPolyline, forkFrom), rewritten allocation-free: every bolt slot
// owns a fixed Float32Array of points, re-crackled in place every ~45 ms,
// and all live bolts are written into ONE preallocated BufferGeometry each
// frame (one draw call for every bolt in the game).

import * as THREE from 'three';
import { createRibbonMaterial } from './materials';

const MAX_PTS = 96; // per bolt slot, all polylines together

export interface BoltSlot {
  on: boolean;
  start: number;
  dur: number;
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  segs: number;
  jitter: number;
  forks: number;
  width: number;
  color: THREE.Color;
  alpha: number;
  /** Re-crackle period (s); 0 = drawn once. */
  every: number;
  next: number;
  /** Flicker: random dips in brightness (discharges). */
  flicker: boolean;
  pts: Float32Array;
  /** Polyline starts (point index) and lengths. */
  polyStart: Int16Array;
  polyLen: Int16Array;
  polys: number;
  n: number;
}

export function newBoltSlot(): BoltSlot {
  return { on: false, start: 0, dur: 0, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, segs: 8, jitter: 1, forks: 0, width: 0.1, color: new THREE.Color(), alpha: 1, every: 0.045, next: 0, flicker: true, pts: new Float32Array(MAX_PTS * 3), polyStart: new Int16Array(12), polyLen: new Int16Array(12), polys: 0, n: 0 };
}

/** Writes a jagged polyline a->b into the slot (more wander mid-way). Returns its point count. */
export function jagged(s: BoltSlot, ax: number, ay: number, az: number, bx: number, by: number, bz: number, segments: number, jitter: number, rnd: () => number = Math.random): number {
  if (s.polys >= s.polyStart.length) return 0;
  const room = MAX_PTS - s.n;
  const segs = Math.min(segments, room - 1);
  if (segs < 1) return 0;
  s.polyStart[s.polys] = s.n;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const j = i === 0 || i === segs ? 0 : jitter * Math.sin(t * Math.PI);
    const o = s.n * 3;
    s.pts[o] = ax + (bx - ax) * t + (rnd() - 0.5) * j;
    s.pts[o + 1] = ay + (by - ay) * t + (rnd() - 0.5) * j * 0.6;
    s.pts[o + 2] = az + (bz - az) * t + (rnd() - 0.5) * j;
    s.n++;
  }
  s.polyLen[s.polys++] = segs + 1;
  return segs + 1;
}

/** A short side branch off polyline 0 at a random interior vertex. */
export function fork(s: BoltSlot, length: number, jitter: number, rnd: () => number = Math.random): void {
  const len0 = s.polyLen[0];
  if (s.polys === 0 || len0 < 3) return;
  const i = s.polyStart[0] + 1 + Math.floor(rnd() * (len0 - 2));
  const o = i * 3;
  const x = s.pts[o];
  const y = s.pts[o + 1];
  const z = s.pts[o + 2];
  const nx = s.pts[o + 3] - x;
  const ny = s.pts[o + 4] - y;
  const nz = s.pts[o + 5] - z;
  jagged(s, x, y, z, x + nx * 0.6 * length + (rnd() - 0.5) * length, y + ny * 0.6 * length + (rnd() - 0.5) * length * 0.5, z + nz * 0.6 * length + (rnd() - 0.5) * length, 3, jitter, rnd);
}

/** Re-crackle a slot from its endpoints. */
export function crackle(s: BoltSlot, rnd: () => number = Math.random): void {
  s.n = 0;
  s.polys = 0;
  jagged(s, s.ax, s.ay, s.az, s.bx, s.by, s.bz, s.segs, s.jitter, rnd);
  const L = Math.hypot(s.bx - s.ax, s.by - s.ay, s.bz - s.az);
  for (let k = 0; k < s.forks; k++) fork(s, Math.min(3, L * 0.25), s.jitter * 0.6, rnd);
}

/** The single ribbon mesh every bolt is written into each frame. */
export class RibbonBuffer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly pos: Float32Array;
  private readonly dir: Float32Array;
  private readonly side: Float32Array;
  private readonly width: Float32Array;
  private readonly color: Float32Array;
  private readonly attrs: THREE.BufferAttribute[];
  private segs = 0;

  constructor(readonly capacity: number) {
    const v = capacity * 4;
    this.pos = new Float32Array(v * 3);
    this.dir = new Float32Array(v * 3);
    this.side = new Float32Array(v);
    this.width = new Float32Array(v);
    this.color = new Float32Array(v * 4);
    const idx = new Uint32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      const b = i * 4;
      idx.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], i * 6);
      this.side[b] = -1;
      this.side[b + 1] = 1;
      this.side[b + 2] = -1;
      this.side[b + 3] = 1;
    }
    const g = new THREE.BufferGeometry();
    const mk = (a: Float32Array, n: number) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
    this.attrs = [mk(this.pos, 3), mk(this.dir, 3), mk(this.width, 1), mk(this.color, 4)];
    g.setAttribute('position', this.attrs[0]);
    g.setAttribute('aDir', this.attrs[1]);
    g.setAttribute('aWidth', this.attrs[2]);
    g.setAttribute('aColor', this.attrs[3]);
    g.setAttribute('aSide', new THREE.BufferAttribute(this.side, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    g.setDrawRange(0, 0);
    this.material = createRibbonMaterial();
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 23;
    this.mesh.name = 'fx-bolts';
  }

  begin(): void {
    this.segs = 0;
  }

  /** Adds every polyline of a slot at the given width/alpha. */
  addSlot(s: BoltSlot, width: number, alpha: number): void {
    for (let p = 0; p < s.polys; p++) {
      const st = s.polyStart[p];
      const n = s.polyLen[p];
      // forks are thinner
      const w = p === 0 ? width : width * 0.55;
      for (let i = 0; i + 1 < n; i++) this.seg(s.pts, (st + i) * 3, (st + i + 1) * 3, w, s.color, alpha);
    }
  }

  private seg(pts: Float32Array, a: number, b: number, w: number, c: THREE.Color, alpha: number): void {
    if (this.segs >= this.capacity) return;
    const base = this.segs * 4;
    const dx = pts[b] - pts[a];
    const dy = pts[b + 1] - pts[a + 1];
    const dz = pts[b + 2] - pts[a + 2];
    for (let k = 0; k < 4; k++) {
      const vi = base + k;
      const src = k < 2 ? a : b;
      this.pos[vi * 3] = pts[src];
      this.pos[vi * 3 + 1] = pts[src + 1];
      this.pos[vi * 3 + 2] = pts[src + 2];
      this.dir[vi * 3] = dx;
      this.dir[vi * 3 + 1] = dy;
      this.dir[vi * 3 + 2] = dz;
      this.width[vi] = w;
      this.color[vi * 4] = c.r;
      this.color[vi * 4 + 1] = c.g;
      this.color[vi * 4 + 2] = c.b;
      this.color[vi * 4 + 3] = alpha;
    }
    this.segs++;
  }

  end(): void {
    const n = this.segs;
    this.mesh.geometry.setDrawRange(0, n * 6);
    this.mesh.visible = n > 0;
    if (n === 0) return;
    const sizes = [3, 3, 1, 4];
    for (let i = 0; i < this.attrs.length; i++) {
      const a = this.attrs[i];
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * 4 * sizes[i]);
      a.needsUpdate = true;
    }
  }

  get segments(): number {
    return this.segs;
  }
}
