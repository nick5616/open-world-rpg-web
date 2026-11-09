// A tiny procedural mesh builder for the weapon models (pt/ux "weapons don't
// look like weapons"). Everything a weapon is made of (blade, guard, wrap,
// gem, wood) is lofted from cross-section rings into ONE indexed
// BufferGeometry with per-vertex colour and a per-vertex `surf` attribute
// (metalness, roughness, glow) that the shared weapon material reads
// (material.ts), so each weapon is a single draw call.
//
// Rings are lists of points; consecutive rings are stitched with quads.
// Smooth lofts share ring vertices (averaged normals); flat lofts give every
// quad its own vertices (faceted, for bevelled metal). The builder's matrix
// places a part (crossguard across the blade, a gem on a face, ...).

import * as THREE from 'three';

export type V3 = [number, number, number];

/** A surface: colour plus PBR terms; `glow` drives the emissive term. */
export interface Surface {
  color: THREE.Color;
  metal: number;
  rough: number;
  glow: number;
}

export function surf(color: THREE.ColorRepresentation, metal: number, rough: number, glow = 0): Surface {
  return { color: new THREE.Color(color), metal, rough, glow };
}

/** Same surface, colour scaled (cheap vertex-colour shading for grain, bands, edges). */
export function shade(s: Surface, k: number, glowK = 1): Surface {
  return { color: s.color.clone().multiplyScalar(k), metal: s.metal, rough: s.rough, glow: s.glow * glowK };
}

export type SurfaceAt = Surface | ((ring: number, k: number) => Surface);

export interface LoftOpts {
  /** Rings are closed loops (tubes); false = open strips. Default true. */
  closed?: boolean;
  /** Shared vertices with averaged normals (default) or faceted quads. */
  smooth?: boolean;
  capStart?: boolean;
  capEnd?: boolean;
}

/** Deterministic hash noise in [0, 1) (no Math.random: geometry is reproducible). */
export function hash(...n: number[]): number {
  let h = 2166136261;
  for (const v of n) {
    h ^= Math.floor(v * 1000) | 0;
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const tmp = new THREE.Vector3();

export class MeshBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private srf: number[] = [];
  private idx: number[] = [];
  /** Where new parts go (applied to every point added). */
  matrix = new THREE.Matrix4();
  /** Named vertex ranges (e.g. the bow string's nock vertices). */
  readonly marks = new Map<string, number[]>();
  private marking: string | null = null;

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  /** Run `fn` with the matrix multiplied by `m`, then restore it. */
  with(m: THREE.Matrix4, fn: () => void): void {
    const saved = this.matrix.clone();
    this.matrix.multiply(m);
    fn();
    this.matrix.copy(saved);
  }

  /** Record the vertices `fn` adds under `name` (dynamic parts). */
  mark(name: string, fn: () => void): void {
    const start = this.vertexCount;
    const prev = this.marking;
    this.marking = name;
    fn();
    this.marking = prev;
    const list = this.marks.get(name) ?? [];
    for (let i = start; i < this.vertexCount; i++) list.push(i);
    this.marks.set(name, list);
  }

  private vert(p: THREE.Vector3, n: THREE.Vector3, s: Surface): number {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.col.push(s.color.r, s.color.g, s.color.b);
    this.srf.push(s.metal, s.rough, s.glow);
    return this.vertexCount - 1;
  }

  private tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /**
   * Stitch rings (each the same length) into a surface. Ring winding: points
   * go counter-clockwise when seen from where the rings advance TO, so the
   * outward normals face away from the ring centre.
   */
  loft(rings: V3[][], sf: SurfaceAt, opts: LoftOpts = {}): void {
    const closed = opts.closed ?? true;
    const smooth = opts.smooth ?? true;
    const n = rings[0].length;
    const at = (r: number, k: number) => (typeof sf === 'function' ? sf(r, k) : sf);
    const P = rings.map((ring) => ring.map((p) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(this.matrix)));
    const segs = closed ? n : n - 1;
    if (smooth) {
      const normals = P.map((ring) => ring.map(() => new THREE.Vector3()));
      const face = new THREE.Vector3();
      const e1 = new THREE.Vector3();
      const e2 = new THREE.Vector3();
      for (let r = 0; r < P.length - 1; r++) {
        for (let k = 0; k < segs; k++) {
          const k2 = (k + 1) % n;
          const a = P[r][k];
          const b = P[r][k2];
          const c = P[r + 1][k2];
          const d = P[r + 1][k];
          e1.subVectors(c, a);
          e2.subVectors(d, b);
          face.crossVectors(e1, e2);
          if (face.lengthSq() < 1e-14) {
            e1.subVectors(b, a);
            e2.subVectors(d, a);
            face.crossVectors(e1, e2);
          }
          for (const [rr, kk] of [
            [r, k],
            [r, k2],
            [r + 1, k2],
            [r + 1, k],
          ])
            normals[rr][kk].add(face);
        }
      }
      const base = this.vertexCount;
      for (let r = 0; r < P.length; r++)
        for (let k = 0; k < n; k++) {
          const nn = normals[r][k];
          if (nn.lengthSq() < 1e-20) nn.set(0, 1, 0);
          this.vert(P[r][k], nn.normalize(), at(r, k));
        }
      for (let r = 0; r < P.length - 1; r++)
        for (let k = 0; k < segs; k++) {
          const k2 = (k + 1) % n;
          const a = base + r * n + k;
          const b = base + r * n + k2;
          const c = base + (r + 1) * n + k2;
          const d = base + (r + 1) * n + k;
          this.tri(a, b, c);
          this.tri(a, c, d);
        }
    } else {
      const face = new THREE.Vector3();
      const e1 = new THREE.Vector3();
      const e2 = new THREE.Vector3();
      for (let r = 0; r < P.length - 1; r++)
        for (let k = 0; k < segs; k++) {
          const k2 = (k + 1) % n;
          const a = P[r][k];
          const b = P[r][k2];
          const c = P[r + 1][k2];
          const d = P[r + 1][k];
          e1.subVectors(c, a);
          e2.subVectors(d, b);
          face.crossVectors(e1, e2);
          if (face.lengthSq() < 1e-14) {
            e1.subVectors(b, a);
            e2.subVectors(d, a);
            face.crossVectors(e1, e2);
          }
          face.normalize();
          const ia = this.vert(a, face, at(r, k));
          const ib = this.vert(b, face, at(r, k2));
          const ic = this.vert(c, face, at(r + 1, k2));
          const id = this.vert(d, face, at(r + 1, k));
          this.tri(ia, ib, ic);
          this.tri(ia, ic, id);
        }
    }
    if (opts.capStart) this.cap(P[0], at(0, 0), true);
    if (opts.capEnd) this.cap(P[P.length - 1], at(P.length - 1, 0), false);
  }

  /** A flat fan over a closed ring (already transformed). */
  private cap(ring: THREE.Vector3[], s: Surface, start: boolean): void {
    const c = new THREE.Vector3();
    for (const p of ring) c.add(p);
    c.divideScalar(ring.length);
    const nrm = new THREE.Vector3();
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      nrm.add(tmp.subVectors(a, c).cross(new THREE.Vector3().subVectors(b, c)));
    }
    if (start) nrm.negate();
    if (nrm.lengthSq() < 1e-20) return;
    nrm.normalize();
    const ic = this.vert(c, nrm, s);
    const ids = ring.map((p) => this.vert(p, nrm, s));
    for (let k = 0; k < ring.length; k++) {
      const a = ids[k];
      const b = ids[(k + 1) % ring.length];
      if (start) this.tri(ic, b, a);
      else this.tri(ic, a, b);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('surf', new THREE.Float32BufferAttribute(this.srf, 3));
    g.setIndex(this.idx);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// ---- ring helpers ----

/** A ring around the Y axis at height y (counter-clockwise seen from +Y). */
export function circle(y: number, r: number, segs: number, opts: { rx?: number; rz?: number; cx?: number; cz?: number; phase?: number; rAt?: (a: number) => number } = {}): V3[] {
  const out: V3[] = [];
  for (let k = 0; k < segs; k++) {
    const a = opts.phase !== undefined ? opts.phase + (k / segs) * Math.PI * 2 : (k / segs) * Math.PI * 2;
    const rr = opts.rAt ? opts.rAt(a) : r;
    out.push([(opts.cx ?? 0) + Math.cos(a) * rr * (opts.rx ?? 1), y, (opts.cz ?? 0) - Math.sin(a) * rr * (opts.rz ?? 1)]);
  }
  return out;
}

/** Lathe: rings around +Y from a (y, r) profile, bottom to top. */
export function lathe(b: MeshBuilder, profile: [number, number][], segs: number, sf: SurfaceAt, opts: LoftOpts & { rx?: number; rz?: number } = {}): void {
  b.loft(
    profile.map(([y, r]) => circle(y, Math.max(r, 1e-5), segs, { rx: opts.rx, rz: opts.rz })),
    sf,
    opts,
  );
}

/**
 * Sweep a 2D section (u along `side`, v along the path normal) along a path.
 * `scale(i)` scales the section at station i; `side` is the fixed axis the
 * section's u runs along (kept perpendicular to the path).
 */
export function sweep(b: MeshBuilder, path: V3[], section: [number, number][], sf: SurfaceAt, opts: LoftOpts & { side?: V3; scale?: (i: number) => [number, number] } = {}): void {
  const side = new THREE.Vector3(...(opts.side ?? [1, 0, 0]));
  const rings: V3[][] = [];
  const T = new THREE.Vector3();
  const N = new THREE.Vector3();
  const S = new THREE.Vector3();
  for (let i = 0; i < path.length; i++) {
    const p0 = path[Math.max(0, i - 1)];
    const p1 = path[Math.min(path.length - 1, i + 1)];
    T.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]).normalize();
    // S: `side` made perpendicular to T; N completes the frame.
    S.copy(side).addScaledVector(T, -side.dot(T));
    if (S.lengthSq() < 1e-10) S.set(0, 0, 1).addScaledVector(T, -T.z);
    S.normalize();
    N.crossVectors(T, S);
    const [su, sv] = opts.scale ? opts.scale(i) : [1, 1];
    const c = path[i];
    rings.push(section.map(([u, v]) => [c[0] + S.x * u * su + N.x * v * sv, c[1] + S.y * u * su + N.y * v * sv, c[2] + S.z * u * su + N.z * v * sv]));
  }
  b.loft(rings, sf, opts);
}

/** Catmull-Rom resample of control points into `n` stations. */
export function curve(points: V3[], n: number): V3[] {
  const c = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
  return c.getSpacedPoints(n - 1).map((p) => [p.x, p.y, p.z]);
}

/** A helix around +Y from y0 to y1 (a wrap strap's centre line). */
export function helix(y0: number, y1: number, r: number, turns: number, perTurn: number, phase = 0): V3[] {
  const n = Math.max(2, Math.round(turns * perTurn) + 1);
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = phase + t * turns * Math.PI * 2;
    out.push([Math.cos(a) * r, y0 + (y1 - y0) * t, -Math.sin(a) * r]);
  }
  return out;
}

/** A regular polygon section (u, v) of `n` points (counter-clockwise). */
export function polygon(n: number, ru: number, rv = ru, phase = Math.PI / n): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = phase + (k / n) * Math.PI * 2;
    out.push([Math.cos(a) * ru, Math.sin(a) * rv]);
  }
  return out;
}

/** Matrix helpers. */
export const M = {
  t: (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z),
  rx: (a: number) => new THREE.Matrix4().makeRotationX(a),
  ry: (a: number) => new THREE.Matrix4().makeRotationY(a),
  rz: (a: number) => new THREE.Matrix4().makeRotationZ(a),
  s: (x: number, y = x, z = x) => new THREE.Matrix4().makeScale(x, y, z),
  of: (...ms: THREE.Matrix4[]) => ms.reduce((a, m) => a.multiply(m), new THREE.Matrix4()),
};
