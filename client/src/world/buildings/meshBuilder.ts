// A tiny growable mesh builder for the towns layer (WP20). Pure TS (no
// three.js), so the same code runs in the buildings worker and in vitest.
//
// Every vertex carries: position, a flat face normal (i8), a texture
// coordinate in "tile" space (repeats; the town material samples a texture
// array, so tiles wrap without atlas seams), a layer + glow byte pair and an
// RGB tint. Faces are flat-shaded on purpose: low-poly reads cleanly at
// distance and costs no smoothing pass.
//
// Winding is never hand-tuned: polygons take an outward hint and are flipped
// to face it, so a builder only says "this face looks along +u".

export interface MeshData {
  position: Float32Array;
  normal: Int8Array;
  uv: Float32Array;
  /** Per vertex: texture layer, glow (0 none, 1-126 night-only window light, 127 daylight pane, 128-255 always-on fire). */
  lg: Uint8Array;
  color: Uint8Array;
  index: Uint32Array;
  vertexCount: number;
  indexCount: number;
}

export type V3 = [number, number, number];

/**
 * Glow class 127: a window's inner pane, which shows the bright sky outside
 * by day and goes dark at night (townMaterial.ts). Night-lit windows use
 * 1..126, always-on light 128..255.
 */
export const GLOW_DAYLIGHT = 127;

/** A local building/prop frame: x = cx + u c - v s, z = cz + u s + v c (worldgen geom.rs Obb). */
export interface Frame {
  cx: number;
  cz: number;
  c: number;
  s: number;
}

export const at = (f: Frame, u: number, y: number, v: number): V3 => [f.cx + u * f.c - v * f.s, y, f.cz + u * f.s + v * f.c];
/** World direction of local (du, dv) (horizontal). */
export const dirOf = (f: Frame, du: number, dy: number, dv: number): V3 => [du * f.c - dv * f.s, dy, du * f.s + dv * f.c];
export const local = (f: Frame, x: number, z: number): [number, number] => {
  const dx = x - f.cx;
  const dz = z - f.cz;
  return [dx * f.c + dz * f.s, dz * f.c - dx * f.s];
};
export const frameOf = (cx: number, cz: number, yaw: number): Frame => ({ cx, cz, c: Math.cos(yaw), s: Math.sin(yaw) });
/** The same frame turned by `a` radians (from +u toward +v). */
export const turned = (f: Frame, a: number): Frame => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { cx: f.cx, cz: f.cz, c: f.c * c - f.s * s, s: f.s * c + f.c * s };
};
/** Frame moved to local (u, v). */
export const moved = (f: Frame, u: number, v: number): Frame => {
  const p = at(f, u, 0, v);
  return { cx: p[0], cz: p[2], c: f.c, s: f.s };
};

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export interface Paint {
  layer: number;
  /** Metres per texture repeat (0: the caller passes explicit uvs). */
  tile: number;
  glow: number;
  color: V3;
}

export class MeshBuilder {
  private pos: Float32Array;
  private nrm: Int8Array;
  private tex: Float32Array;
  private lgs: Uint8Array;
  private col: Uint8Array;
  private idx: Uint32Array;
  vertexCount = 0;
  indexCount = 0;

  /** Current paint (layer, tile size, glow, tint 0..1). */
  layer = 0;
  tile = 2;
  glow = 0;
  color: V3 = [1, 1, 1];
  /** Auto-uv origin height: wall textures line up with the building's floor. */
  originY = 0;
  /** Tangent used for horizontal faces (floors line up with their building). */
  flatU: V3 = [1, 0, 0];

  constructor(capacity = 1024) {
    this.pos = new Float32Array(capacity * 3);
    this.nrm = new Int8Array(capacity * 3);
    this.tex = new Float32Array(capacity * 2);
    this.lgs = new Uint8Array(capacity * 2);
    this.col = new Uint8Array(capacity * 3);
    this.idx = new Uint32Array(capacity * 2);
  }

  paint(layer: number, tile: number, color: V3 = [1, 1, 1], glow = 0): this {
    this.layer = layer;
    this.tile = tile;
    this.color = color;
    this.glow = glow;
    return this;
  }

  save(): Paint {
    return { layer: this.layer, tile: this.tile, glow: this.glow, color: this.color };
  }

  restore(p: Paint): this {
    return this.paint(p.layer, p.tile, p.color, p.glow);
  }

  private grow(nv: number, ni: number): void {
    if (this.vertexCount + nv > this.pos.length / 3) {
      const cap = Math.max((this.pos.length / 3) * 2, this.vertexCount + nv);
      const g = <T extends Float32Array | Int8Array | Uint8Array>(a: T, k: number, C: new (n: number) => T): T => {
        const b = new C(cap * k);
        b.set(a);
        return b;
      };
      this.pos = g(this.pos, 3, Float32Array);
      this.nrm = g(this.nrm, 3, Int8Array);
      this.tex = g(this.tex, 2, Float32Array);
      this.lgs = g(this.lgs, 2, Uint8Array);
      this.col = g(this.col, 3, Uint8Array);
    }
    if (this.indexCount + ni > this.idx.length) {
      const b = new Uint32Array(Math.max(this.idx.length * 2, this.indexCount + ni));
      b.set(this.idx);
      this.idx = b;
    }
  }

  private vert(p: V3, n: V3, u: number, v: number): number {
    const i = this.vertexCount++;
    this.pos[i * 3] = p[0];
    this.pos[i * 3 + 1] = p[1];
    this.pos[i * 3 + 2] = p[2];
    this.nrm[i * 3] = Math.round(n[0] * 127);
    this.nrm[i * 3 + 1] = Math.round(n[1] * 127);
    this.nrm[i * 3 + 2] = Math.round(n[2] * 127);
    this.tex[i * 2] = u;
    this.tex[i * 2 + 1] = v;
    this.lgs[i * 2] = this.layer;
    this.lgs[i * 2 + 1] = this.glow;
    const c = this.color;
    this.col[i * 3] = Math.max(0, Math.min(255, Math.round(c[0] * 255)));
    this.col[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(c[1] * 255)));
    this.col[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(c[2] * 255)));
    return i;
  }

  /**
   * Convex polygon (fan). `outward` orients it (the winding is flipped to face
   * it); `uvs` are explicit tile coordinates, else planar: along the face's
   * horizontal tangent and up its slope, in metres / tile.
   */
  poly(pts: V3[], outward?: V3, uvs?: [number, number][]): void {
    const n0 = pts.length;
    if (n0 < 3) return;
    let n = norm(cross(sub3(pts[1], pts[0]), sub3(pts[2], pts[0])));
    // Degenerate first corner: use Newell's normal.
    if (!Number.isFinite(n[0]) || Math.hypot(n[0], n[1], n[2]) < 0.5) {
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let i = 0; i < n0; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n0];
        nx += (a[1] - b[1]) * (a[2] + b[2]);
        ny += (a[2] - b[2]) * (a[0] + b[0]);
        nz += (a[0] - b[0]) * (a[1] + b[1]);
      }
      n = norm([nx, ny, nz]);
    }
    let flip = false;
    if (outward && dot(n, outward) < 0) {
      flip = true;
      n = [-n[0], -n[1], -n[2]];
    }
    this.grow(n0, (n0 - 2) * 3);
    let t: V3;
    if (Math.abs(n[1]) > 0.985) t = this.flatU;
    else t = norm([-n[2], 0, n[0]]); // horizontal tangent: up x n
    const b = cross(n, t);
    const k = this.tile > 0 ? 1 / this.tile : 1;
    const base = this.vertexCount;
    for (let i = 0; i < n0; i++) {
      const p = pts[i];
      if (uvs) this.vert(p, n, uvs[i][0], uvs[i][1]);
      else {
        const q: V3 = [p[0], p[1] - this.originY, p[2]];
        this.vert(p, n, dot(q, t) * k, dot(q, b) * k);
      }
    }
    for (let i = 1; i < n0 - 1; i++) {
      if (flip) this.tri(base, base + i + 1, base + i);
      else this.tri(base, base + i, base + i + 1);
    }
  }

  private tri(a: number, b: number, c: number): void {
    this.idx[this.indexCount++] = a;
    this.idx[this.indexCount++] = b;
    this.idx[this.indexCount++] = c;
  }

  /** Quad a-b-c-d (any winding) facing `outward`. */
  quad(a: V3, b: V3, c: V3, d: V3, outward?: V3, uvs?: [number, number][]): void {
    this.poly([a, b, c, d], outward, uvs);
  }

  /**
   * Box in frame f: u in [u0, u1], v in [v0, v1], y in [y0, y1]. `top` /
   * `bottom` false skips those faces; `sides` false skips the four sides.
   */
  box(f: Frame, u0: number, u1: number, y0: number, y1: number, v0: number, v1: number, opts: { top?: boolean; bottom?: boolean; sides?: boolean; topPaint?: Paint } = {}): void {
    this.slopedBox(f, u0, u1, v0, v1, y0, y1, y1, opts);
  }

  /**
   * The collision box shape (worldgen Box3): a rectangle in frame f, solid
   * from y0 up to a top that runs from t1 at u = u0 to t2 at u = u1.
   * `skip` names faces to leave out: '-u', '+u', '-v', '+v', 'top', 'bottom'.
   */
  slopedBox(
    f: Frame,
    u0: number,
    u1: number,
    v0: number,
    v1: number,
    y0: number,
    t1: number,
    t2: number,
    opts: { top?: boolean; bottom?: boolean; sides?: boolean; topPaint?: Paint; skip?: string[]; sidePaint?: Partial<Record<'-u' | '+u' | '-v' | '+v', Paint>> } = {},
  ): void {
    const skip = opts.skip ?? [];
    const p = (u: number, y: number, v: number) => at(f, u, y, v);
    const keep = this.save();
    const side = (name: '-u' | '+u' | '-v' | '+v', pts: V3[], out: V3) => {
      if (opts.sides === false || skip.includes(name)) return;
      const sp = opts.sidePaint?.[name];
      if (sp) this.restore(sp);
      this.poly(pts, out);
      if (sp) this.restore(keep);
    };
    side('-u', [p(u0, y0, v0), p(u0, y0, v1), p(u0, t1, v1), p(u0, t1, v0)], dirOf(f, -1, 0, 0));
    side('+u', [p(u1, y0, v0), p(u1, t2, v0), p(u1, t2, v1), p(u1, y0, v1)], dirOf(f, 1, 0, 0));
    side('-v', [p(u0, y0, v0), p(u0, t1, v0), p(u1, t2, v0), p(u1, y0, v0)], dirOf(f, 0, 0, -1));
    side('+v', [p(u0, y0, v1), p(u1, y0, v1), p(u1, t2, v1), p(u0, t1, v1)], dirOf(f, 0, 0, 1));
    if (opts.top !== false && !skip.includes('top')) {
      if (opts.topPaint) this.restore(opts.topPaint);
      const fu = this.flatU;
      this.flatU = dirOf(f, 1, 0, 0);
      this.poly([p(u0, t1, v0), p(u1, t2, v0), p(u1, t2, v1), p(u0, t1, v1)], [0, 1, 0]);
      this.flatU = fu;
      if (opts.topPaint) this.restore(keep);
    }
    if (opts.bottom !== false && !skip.includes('bottom') && opts.bottom) {
      const fu = this.flatU;
      this.flatU = dirOf(f, 1, 0, 0);
      this.poly([p(u0, y0, v0), p(u1, y0, v0), p(u1, y0, v1), p(u0, y0, v1)], [0, -1, 0]);
      this.flatU = fu;
    }
  }

  /** Vertical n-gon prism centred at local (u, v), radius r (circumscribed), from y0 to y1. */
  cyl(f: Frame, u: number, v: number, y0: number, y1: number, r: number, sides = 6, opts: { top?: boolean; r1?: number; a0?: number } = {}): void {
    const r1 = opts.r1 ?? r;
    const a0 = opts.a0 ?? 0;
    const ring = (rr: number, y: number) => {
      const out: V3[] = [];
      for (let i = 0; i < sides; i++) {
        const a = a0 + (i / sides) * Math.PI * 2;
        out.push(at(f, u + Math.cos(a) * rr, y, v + Math.sin(a) * rr));
      }
      return out;
    };
    const lo = ring(r, y0);
    const hi = ring(r1, y1);
    const c = at(f, u, (y0 + y1) / 2, v);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      const m: V3 = [(lo[i][0] + lo[j][0]) / 2 - c[0], 0, (lo[i][2] + lo[j][2]) / 2 - c[2]];
      if (r1 <= 1e-4) this.poly([lo[i], lo[j], hi[i]], m);
      else this.poly([lo[i], lo[j], hi[j], hi[i]], m);
    }
    if (opts.top !== false && r1 > 1e-4) {
      const fu = this.flatU;
      this.flatU = dirOf(f, 1, 0, 0);
      this.poly(hi, [0, 1, 0]);
      this.flatU = fu;
    }
  }

  /** Horizontal cylinder (n-gon) along local u from u0 to u1 at (y, v). */
  hcyl(f: Frame, u0: number, u1: number, y: number, v: number, r: number, sides = 6, caps = true): void {
    const ring = (u: number) => {
      const out: V3[] = [];
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        out.push(at(f, u, y + Math.sin(a) * r, v + Math.cos(a) * r));
      }
      return out;
    };
    const a = ring(u0);
    const b = ring(u1);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      const mid = (i + 0.5) / sides;
      const out = dirOf(f, 0, Math.sin(mid * Math.PI * 2), Math.cos(mid * Math.PI * 2));
      this.poly([a[i], a[j], b[j], b[i]], out);
    }
    if (caps) {
      this.poly(a, dirOf(f, -1, 0, 0));
      this.poly(b, dirOf(f, 1, 0, 0));
    }
  }

  /** Append another builder's geometry. */
  append(o: MeshBuilder): void {
    const d = o.data(false);
    this.grow(d.vertexCount, d.indexCount);
    const base = this.vertexCount;
    this.pos.set(d.position, base * 3);
    this.nrm.set(d.normal, base * 3);
    this.tex.set(d.uv, base * 2);
    this.lgs.set(d.lg, base * 2);
    this.col.set(d.color, base * 3);
    for (let i = 0; i < d.indexCount; i++) this.idx[this.indexCount + i] = d.index[i] + base;
    this.vertexCount += d.vertexCount;
    this.indexCount += d.indexCount;
  }

  /** The built arrays, trimmed (copies when `copy`, else views). */
  data(copy = true): MeshData {
    const v = this.vertexCount;
    const i = this.indexCount;
    const cut = <T extends Float32Array | Int8Array | Uint8Array | Uint32Array>(a: T, n: number): T => (copy ? (a.slice(0, n) as T) : (a.subarray(0, n) as T));
    return { position: cut(this.pos, v * 3), normal: cut(this.nrm, v * 3), uv: cut(this.tex, v * 2), lg: cut(this.lgs, v * 2), color: cut(this.col, v * 3), index: cut(this.idx, i), vertexCount: v, indexCount: i };
  }
}

/** Buffers of a MeshData, for postMessage transfer lists. */
export function meshTransferables(m: MeshData): ArrayBuffer[] {
  return [m.position.buffer, m.normal.buffer, m.uv.buffer, m.lg.buffer, m.color.buffer, m.index.buffer] as ArrayBuffer[];
}

export const EMPTY_MESH = (): MeshData => new MeshBuilder(1).data();
