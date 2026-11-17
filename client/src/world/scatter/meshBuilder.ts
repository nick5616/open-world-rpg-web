// Small procedural-mesh accumulator for the rich vegetation (playtest 3):
// tapered tubes (trunks, limbs, stems), alpha-card quads (leaf clusters,
// fronds, flower heads) and free triangles, written into one indexed
// BufferGeometry with the attribute set the scatter shaders read:
//
//   position, normal, color (vertex colour: shade/AO baked in)
//   uv        leaf-atlas coordinates (tubes point at the atlas' solid texel so
//             the alpha-tested shadow pass sees solid wood)
//   aBarkUv   bark texture coordinates (tubes only, offset by 0.5 so x > 0.25
//             marks bark; cards and blades have (0, 0) and sample the atlas)
//   aFoliage  0 wood / stone (bark texture, not tinted), 1 leaves (instance
//             tint, flutter, translucency)
//   aCard     x: per-card wind phase, y: branch flex 0..1 (how far out on the
//             branch hierarchy the vertex is: drives branch sway)

import * as THREE from 'three';
import { SOLID_UV } from './natureTextures';

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}
export type Rng = () => number;
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export interface CardOpts {
  /** [u0, v0, u1, v1] atlas rectangle (cellUv). */
  uv: [number, number, number, number];
  /** Width and height in geometry units. */
  w: number;
  h: number;
  /** Normal for lighting (soft "crown normal", not the quad's own). */
  normal: THREE.Vector3;
  /** Vertex colour at the stem end and at the tip. */
  c0: THREE.Color;
  c1: THREE.Color;
  phase: number;
  flex0: number;
  flex1: number;
  /** Tip width as a fraction of the base width (1 = rectangle). */
  taper?: number;
  mirror?: boolean;
  foliage?: number;
}

export class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  bark: number[] = [];
  fol: number[] = [];
  card: number[] = [];
  idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  vertex(p: THREE.Vector3, n: THREE.Vector3, c: THREE.Color, u: number, v: number, bu: number, bv: number, fol: number, phase: number, flex: number): number {
    const i = this.vertexCount;
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.col.push(c.r, c.g, c.b);
    this.uv.push(u, v);
    this.bark.push(bu, bv);
    this.fol.push(fol);
    this.card.push(phase, flex);
    return i;
  }

  /**
   * A tapered tube along `pts` (>= 2 points) with radius `radii[i]` at each.
   * `lobe` adds root buttresses: radius x (1 + amount * cos(k theta)), fading
   * with the point index.
   */
  tube(
    pts: THREE.Vector3[],
    radii: number[],
    o: { seg: number; c0: THREE.Color; c1: THREE.Color; flex0?: number; flex1?: number; vScale?: number; uRep?: number; lobe?: { amount: number; k: number; fade: number }; phase?: number; capTop?: boolean },
  ): void {
    const n = pts.length;
    const seg = o.seg;
    const t = new THREE.Vector3();
    const nn = new THREE.Vector3();
    const bb = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    t.subVectors(pts[1], pts[0]).normalize();
    nn.set(Math.abs(t.x) < 0.8 ? 1 : 0, Math.abs(t.x) < 0.8 ? 0 : 1, 0).cross(t).normalize();
    bb.crossVectors(t, nn);
    const base = this.vertexCount;
    let len = 0;
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      const t2 = tmp.subVectors(b, a).normalize();
      // Parallel transport of the frame.
      const axis = new THREE.Vector3().crossVectors(t, t2);
      if (axis.lengthSq() > 1e-10) {
        axis.normalize();
        const ang = Math.acos(THREE.MathUtils.clamp(t.dot(t2), -1, 1));
        nn.applyAxisAngle(axis, ang);
        bb.applyAxisAngle(axis, ang);
      }
      t.copy(t2);
      if (i > 0) len += pts[i].distanceTo(pts[i - 1]);
      const f = i / (n - 1);
      col.lerpColors(o.c0, o.c1, f);
      const flex = lerp(o.flex0 ?? 0, o.flex1 ?? 0, f);
      const lobeAmt = o.lobe ? o.lobe.amount * Math.exp(-i / o.lobe.fade) : 0;
      for (let j = 0; j <= seg; j++) {
        const th = (j / seg) * Math.PI * 2;
        const dir = new THREE.Vector3().addScaledVector(nn, Math.cos(th)).addScaledVector(bb, Math.sin(th));
        const r = radii[i] * (1 + (o.lobe ? lobeAmt * Math.cos(th * o.lobe.k) : 0));
        const p = new THREE.Vector3().copy(pts[i]).addScaledVector(dir, r);
        this.vertex(p, dir, col, SOLID_UV[0], SOLID_UV[1], 0.5 + (j / seg) * (o.uRep ?? 2), 0.5 + len * (o.vScale ?? 14), 0, o.phase ?? 0, flex);
      }
    }
    const row = seg + 1;
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < seg; j++) {
        const a = base + i * row + j;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        this.idx.push(a, c, b, b, c, d);
      }
    }
    if (o.capTop) {
      // Close the tip with a point so a cut branch reads solid.
      const tipN = pts[n - 1].clone().sub(pts[n - 2]).normalize();
      const apex = pts[n - 1].clone().addScaledVector(tipN, radii[n - 1] * 0.8);
      const ai = this.vertex(apex, tipN, o.c1, SOLID_UV[0], SOLID_UV[1], 0.5, 0.5 + len * (o.vScale ?? 14), 0, o.phase ?? 0, o.flex1 ?? 0);
      const last = base + (n - 1) * row;
      for (let j = 0; j < seg; j++) this.idx.push(last + j, ai, last + j + 1);
    }
  }

  /** A quad standing on `origin`, extending along `up`, `side` across (both unit, ~perpendicular). */
  cardQuad(origin: THREE.Vector3, up: THREE.Vector3, side: THREE.Vector3, o: CardOpts): void {
    const [u0, v0, u1, v1] = o.uv;
    const tw = (o.taper ?? 1) * 0.5 * o.w;
    const bw = 0.5 * o.w;
    const base = this.vertexCount;
    const tip = origin.clone().addScaledVector(up, o.h);
    const fol = o.foliage ?? 1;
    const ua = o.mirror ? u1 : u0;
    const ub = o.mirror ? u0 : u1;
    const P = (p: THREE.Vector3, s: number, c: THREE.Color, u: number, v: number, flex: number) => this.vertex(p.clone().addScaledVector(side, s), o.normal, c, u, v, 0, 0, fol, o.phase, flex);
    P(origin, -bw, o.c0, ua, v0, o.flex0);
    P(origin, bw, o.c0, ub, v0, o.flex0);
    P(tip, tw, o.c1, ub, v1, o.flex1);
    P(tip, -tw, o.c1, ua, v1, o.flex1);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** A free triangle (rocks use per-face normals). */
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, n: THREE.Vector3, ca: THREE.Color, cb: THREE.Color, cc: THREE.Color, fol: number, bark: [number, number][]): void {
    const i = this.vertexCount;
    this.vertex(a, n, ca, SOLID_UV[0], SOLID_UV[1], bark[0][0], bark[0][1], fol, 0, 0);
    this.vertex(b, n, cb, SOLID_UV[0], SOLID_UV[1], bark[1][0], bark[1][1], fol, 0, 0);
    this.vertex(c, n, cc, SOLID_UV[0], SOLID_UV[1], bark[2][0], bark[2][1], fol, 0, 0);
    this.idx.push(i, i + 1, i + 2);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aBarkUv', new THREE.Float32BufferAttribute(this.bark, 2));
    g.setAttribute('aFoliage', new THREE.Float32BufferAttribute(this.fol, 1));
    g.setAttribute('aCard', new THREE.Float32BufferAttribute(this.card, 2));
    g.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Unit vector at a random direction, biased by `up` (0 uniform, 1 mostly up). */
export function randDir(r: Rng, up = 0): THREE.Vector3 {
  const y = lerp(r() * 2 - 1, r() * 0.9 + 0.1, up);
  const a = r() * Math.PI * 2;
  const s = Math.sqrt(Math.max(0, 1 - y * y));
  return new THREE.Vector3(Math.cos(a) * s, y, Math.sin(a) * s);
}

/** Any unit vector perpendicular to `d`, random around it. */
export function perp(d: THREE.Vector3, r: Rng): THREE.Vector3 {
  const a = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const p = new THREE.Vector3().crossVectors(d, a).normalize();
  const q = new THREE.Vector3().crossVectors(d, p).normalize();
  const t = r() * Math.PI * 2;
  return p.multiplyScalar(Math.cos(t)).addScaledVector(q, Math.sin(t)).normalize();
}
