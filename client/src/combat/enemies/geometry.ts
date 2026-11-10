// Low-poly part builder for the enemy models (playtest 2: "every enemy is a
// capsule + sphere doll"). A part is a few primitives (boxes, icospheres,
// cones, cylinders, lathes) placed, coloured and merged into ONE indexed-free
// BufferGeometry with exactly three attributes:
//   position, normal  (normals are ignored: the material is flat shaded,
//                      so every facet reads as a painted low-poly plane)
//   color             per-vertex colour, baked with a small per-face
//                      lightness jitter (seeded, deterministic) and a soft
//                      bottom-to-top gradient: the hand-painted look of
//                      Valheim / Breath of the Wild props without textures
//   glow              0..1 per vertex: emissive strength (eyes, runes,
//                      embers, crystals). enemyMaterial() turns it into
//                      emissive light, so glowing bits cost no extra draw
// No external assets (nothing in CREDITS.md).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type V3 = [number, number, number];

export interface PrimOpts {
  pos?: V3;
  rot?: V3;
  scale?: V3 | number;
  /** Emissive strength 0..1 (eyes, runes). */
  glow?: number;
  /** Per-face lightness jitter (default 0.06). */
  jitter?: number;
  /** Bottom-to-top darkening of this primitive (default 0.18). */
  shade?: number;
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();
const _hsl = { h: 0, s: 0, l: 0 };

/**
 * Accumulates coloured primitives for one part. `build()` merges them.
 * Primitive geometries are created here and released after the merge.
 */
export class PartBuilder {
  private list: THREE.BufferGeometry[] = [];
  constructor(
    private readonly rand: () => number = rng(1),
    /** Spectral bodies: every colour pulled toward this one (the summon's element). */
    private readonly tint: THREE.Color | null = null,
  ) {}

  get empty(): boolean {
    return this.list.length === 0;
  }

  add(g: THREE.BufferGeometry, color: THREE.ColorRepresentation, o: PrimOpts = {}): this {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    for (const k of Object.keys(geo.attributes)) if (k !== 'position') geo.deleteAttribute(k);
    const sc = o.scale ?? 1;
    _s.set(...(typeof sc === 'number' ? ([sc, sc, sc] as V3) : sc));
    _q.setFromEuler(_e.set(...(o.rot ?? [0, 0, 0])));
    _p.set(...(o.pos ?? [0, 0, 0]));
    _m.compose(_p, _q, _s);
    geo.applyMatrix4(_m);
    geo.computeVertexNormals();
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const n = pos.count;
    const col = new Float32Array(n * 3);
    const glow = new Float32Array(n).fill(o.glow ?? 0);
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const h = Math.max(1e-4, bb.max.y - bb.min.y);
    const jit = o.jitter ?? 0.06;
    const shade = o.shade ?? 0.18;
    _c.set(color);
    if (this.tint) _c.lerp(this.tint, 0.78);
    _c.getHSL(_hsl);
    // one jitter per triangle: the facets read as painted planes
    for (let t = 0; t < n; t += 3) {
      const dl = (this.rand() - 0.5) * 2 * jit;
      for (let k = 0; k < 3 && t + k < n; k++) {
        const v = t + k;
        const y = (pos.getY(v) - bb.min.y) / h;
        const f = 1 - shade * (1 - y);
        _c.setHSL(_hsl.h, _hsl.s, Math.min(1, Math.max(0, _hsl.l * (1 + dl))));
        col[v * 3] = _c.r * f;
        col[v * 3 + 1] = _c.g * f;
        col[v * 3 + 2] = _c.b * f;
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('glow', new THREE.BufferAttribute(glow, 1));
    this.list.push(geo);
    return this;
  }

  // ── Primitive shortcuts ───────────────────────────────────────────────────

  box(w: number, h: number, d: number, color: THREE.ColorRepresentation, o?: PrimOpts): this {
    return this.add(new THREE.BoxGeometry(w, h, d), color, o);
  }

  /** Faceted ball (icosahedron, detail 0 or 1). */
  ball(r: number, color: THREE.ColorRepresentation, o?: PrimOpts & { detail?: number }): this {
    return this.add(new THREE.IcosahedronGeometry(r, o?.detail ?? 1), color, o);
  }

  /** Low sphere with explicit segments (domes, heads). */
  sphere(r: number, ws: number, hs: number, color: THREE.ColorRepresentation, o?: PrimOpts & { thetaLen?: number }): this {
    return this.add(new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, o?.thetaLen ?? Math.PI), color, o);
  }

  /** Cone along +Y (base at -h/2). */
  cone(r: number, h: number, seg: number, color: THREE.ColorRepresentation, o?: PrimOpts): this {
    return this.add(new THREE.ConeGeometry(r, h, seg), color, o);
  }

  cyl(rTop: number, rBot: number, h: number, seg: number, color: THREE.ColorRepresentation, o?: PrimOpts): this {
    return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg), color, o);
  }

  /** Revolved profile [radius, y][] around +Y. */
  lathe(profile: [number, number][], seg: number, color: THREE.ColorRepresentation, o?: PrimOpts): this {
    return this.add(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(0.0001, r), y)), seg), color, o);
  }

  /** Mirrored pair across X (eyes, horns, ears): `o.pos` is the +X one. */
  pair(make: (b: PartBuilder, o: PrimOpts) => void, o: PrimOpts): this {
    const p = o.pos ?? [0, 0, 0];
    const r = o.rot ?? [0, 0, 0];
    make(this, { ...o, pos: [p[0], p[1], p[2]], rot: [r[0], r[1], r[2]] });
    make(this, { ...o, pos: [-p[0], p[1], p[2]], rot: [r[0], -r[1], -r[2]] });
    return this;
  }

  /** Merge into one non-indexed geometry (position, normal, color, glow). */
  build(name = ''): THREE.BufferGeometry {
    const g = this.list.length === 1 ? this.list[0] : mergeGeometries(this.list, false)!;
    if (g !== this.list[0]) for (const x of this.list) x.dispose();
    this.list = [];
    g.name = name;
    g.computeBoundingSphere();
    return g;
  }
}

/** Colour helpers for palettes. */
export function shadeHex(hex: THREE.ColorRepresentation, dl: number, ds = 0): string {
  _c.set(hex);
  _c.getHSL(_hsl);
  _c.setHSL(_hsl.h, Math.min(1, Math.max(0, _hsl.s + ds)), Math.min(1, Math.max(0, _hsl.l + dl)));
  return `#${_c.getHexString()}`;
}

export function mixHex(a: THREE.ColorRepresentation, b: THREE.ColorRepresentation, t: number): string {
  const x = new THREE.Color(a);
  x.lerp(new THREE.Color(b), t);
  return `#${x.getHexString()}`;
}

/** Number of triangles in a non-indexed geometry. */
export function triCount(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}
