// Solid camp pieces on the movement ground (playtest 2 camps, CR 025): the
// TS half of a TS/Go twin (server/pkg/camps/camps.go; pinned bit for bit by
// server/pkg/camps/testdata/camps.json, replayed in camps.test.ts).
//
// A solid piece (chest, workbench, signpost) is one box in the towns layout
// (9 numbers: x, z, cos, sin, hx, hz, bottom, top, top), pushed out of after
// the town collision and the closed doors with the per-box arithmetic of
// towns.Doors.After: two passes over the boxes near the body in ascending
// piece id. Every input is exact on both sides: positions are the wire's
// centimetres / 100, rotations are 45 degree steps from one cos/sin table,
// and the box only adds the generated footprint and height.
//
// CampGround wraps the world's ground (WorldRuntime.ground, inside the
// chemistry overlay): its level views add the pieces' push-out when any
// solid piece exists; with none it hands out the inner views unchanged, so
// every movement golden stays bit-identical.

import { MAX_STEP_UP_M, PLAYER_CAPSULE_RADIUS } from '@lodestone/contracts';
import type { CollideResult, GroundQuery } from '../../sim/ground';
import { boxesOf, isBuild, pieceDef as defOf, shapeOf, surfaceOf } from '../build/geometry';

const STEP = MAX_STEP_UP_M;
const R = PLAYER_CAPSULE_RADIUS;
const HEAD = 1.9; // towns.HeadM / TOWN_HEAD_M
const CELL = 8;
/** cos(45 degrees) as both sides spell it. */
export const S45 = Math.SQRT1_2;
const ROT: readonly (readonly [number, number])[] = [
  [1, 0],
  [S45, S45],
  [0, 1],
  [-S45, S45],
  [-1, 0],
  [-S45, -S45],
  [0, -1],
  [S45, -S45],
];
/** How far a piece's box reaches under its base. */
export const BASE_DEPTH = 0.5;

export function rotCS(k: number): readonly [number, number] {
  return ROT[k & 7];
}

export const cm2m = (cm: number): number => cm / 100;

export function pieceDef(kind: number) {
  return defOf(kind)!;
}

/** Collides: a solid camp piece, or a building piece with boxes or a walkable surface (CR 041). */
export function isSolid(kind: number): boolean {
  const sh = shapeOf(kind);
  if (sh) return sh.boxes.length > 0 || !!sh.surface;
  return !!pieceDef(kind)?.solid;
}

/** A solid piece's collision box (towns layout). */
export function campBox(kind: number, rot: number, x: number, y: number, z: number): number[] {
  const p = pieceDef(kind);
  const [c, s] = rotCS(rot);
  const top = y + p.height;
  return [x, z, c, s, p.w / 2, p.d / 2, y - BASE_DEPTH, top, top];
}

export interface SolidPiece {
  id: number;
  kind: number;
  rot: number;
  x: number;
  y: number;
  z: number;
  /** Building pieces: bit 0 open (doors and gates). */
  state?: number;
}

const cellKey = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);
const cellOf = (v: number) => Math.floor(v / CELL);

/** The solid pieces' boxes in ascending id order with a grid index (camps.go Set). */
export class CampSet {
  readonly ids: number[] = [];
  readonly f: number[] = [];
  /** Walkable surfaces (CR 041), 8 numbers each: x, z, cos, sin, hx, hz, y at u = -hx, y at u = +hx. */
  readonly sf: number[] = [];
  private readonly cells = new Map<number, number[]>();
  private readonly scells = new Map<number, number[]>();

  constructor(pieces: readonly SolidPiece[]) {
    const ps = pieces.filter((p) => isSolid(p.kind)).sort((a, b) => a.id - b.id);
    const add = (id: number, b: number[]) => {
      const i = this.ids.length;
      this.ids.push(id);
      this.f.push(...b);
      const r = Math.sqrt(b[4] * b[4] + b[5] * b[5]);
      for (let cz = cellOf(b[1] - r); cz <= cellOf(b[1] + r); cz++)
        for (let cx = cellOf(b[0] - r); cx <= cellOf(b[0] + r); cx++) {
          const k = cellKey(cx, cz);
          const l = this.cells.get(k);
          if (l) l.push(i);
          else this.cells.set(k, [i]);
        }
    };
    for (const p of ps) {
      if (isBuild(p.kind)) {
        const bp = { kind: p.kind, rot: p.rot, x: Math.round(p.x * 100), y: Math.round(p.y * 100), z: Math.round(p.z * 100), state: p.state ?? 0 };
        for (const b of boxesOf(bp)) add(p.id, b);
        const sf = surfaceOf(bp);
        if (sf) {
          const i = this.sf.length / 8;
          this.sf.push(sf.x, sf.z, sf.cs, sf.sn, sf.hx, sf.hz, sf.ya, sf.yb);
          const r = Math.hypot(sf.hx, sf.hz);
          for (let cz = cellOf(sf.z - r); cz <= cellOf(sf.z + r); cz++)
            for (let cx = cellOf(sf.x - r); cx <= cellOf(sf.x + r); cx++) {
              const k = cellKey(cx, cz);
              const l = this.scells.get(k);
              if (l) l.push(i);
              else this.scells.set(k, [i]);
            }
        }
        continue;
      }
      add(p.id, campBox(p.kind, p.rot, p.x, p.y, p.z));
    }
  }

  get size(): number {
    return this.ids.length;
  }

  get hasSurfaces(): boolean {
    return this.sf.length > 0;
  }

  /** The highest walkable surface at (x, z) a body with feet at y can step onto (top <= y + step), else null (camps.go SurfaceAt). */
  surfaceAt(x: number, z: number, y: number): number | null {
    if (this.sf.length === 0) return null;
    const l = this.scells.get(cellKey(cellOf(x), cellOf(z)));
    if (!l) return null;
    let best = 0;
    let found = false;
    for (const i of l) {
      const o = i * 8;
      const f = this.sf;
      const dx = x - f[o];
      const dz = z - f[o + 1];
      const u = dx * f[o + 2] + dz * f[o + 3];
      const v = dz * f[o + 2] - dx * f[o + 3];
      if (u < -f[o + 4] || u > f[o + 4] || v < -f[o + 5] || v > f[o + 5]) continue;
      const top = f[o + 6] + ((u + f[o + 4]) / (2 * f[o + 4])) * (f[o + 7] - f[o + 6]);
      if (top <= y + STEP && (!found || top > best)) {
        best = top;
        found = true;
      }
    }
    return found ? best : null;
  }

  /** Any box or surface indexed within m of (x, z) (camps.go Near). */
  near(x: number, z: number, m: number): boolean {
    for (let cz = cellOf(z - m); cz <= cellOf(z + m); cz++)
      for (let cx = cellOf(x - m); cx <= cellOf(x + m); cx++) {
        const k = cellKey(cx, cz);
        if (this.cells.has(k) || this.scells.has(k)) return true;
      }
    return false;
  }

  /** Boxes indexed in [x-m, x+m] x [z-m, z+m], ascending, deduplicated. */
  candidates(x: number, z: number, m: number): number[] {
    const out: number[] = [];
    for (let cz = cellOf(z - m); cz <= cellOf(z + m); cz++)
      for (let cx = cellOf(x - m); cx <= cellOf(x + m); cx++) {
        const l = this.cells.get(cellKey(cx, cz));
        if (l) for (const i of l) out.push(i);
      }
    out.sort((a, b) => a - b);
    let n = 0;
    for (let i = 0; i < out.length; i++) if (i === 0 || out[i] !== out[i - 1]) out[n++] = out[i];
    out.length = n;
    return out;
  }

  /**
   * Push the body (feet at the result r of the collision under the pieces)
   * out of the boxes (camps.go Set.After): pushes add to r's, y and the
   * ceiling flag pass through; no push: r's values unchanged.
   */
  after(r: CollideResult, out: CollideResult): CollideResult {
    out.x = r.x;
    out.y = r.y;
    out.z = r.z;
    out.pushX = r.pushX;
    out.pushZ = r.pushZ;
    out.ceiling = r.ceiling;
    const cands = this.candidates(r.x, r.z, R + 1);
    if (cands.length === 0) return out;
    const f = this.f;
    const lim = r.y + STEP;
    const head = r.y + HEAD;
    const r2 = R * R;
    let px = r.x;
    let pz = r.z;
    let dpx = 0;
    let dpz = 0;
    let pushed = false;
    for (let pass = 0; pass < 2; pass++) {
      for (const i of cands) {
        const o = i * 9;
        const y1 = f[o + 7];
        const y2 = f[o + 8];
        const top = y1 > y2 ? y1 : y2;
        if (!(top > lim && f[o + 6] < head)) continue;
        const c = f[o + 2];
        const s = f[o + 3];
        const hx = f[o + 4];
        const hz = f[o + 5];
        const dx = px - f[o];
        const dz = pz - f[o + 1];
        const u = dx * c + dz * s;
        const v = dz * c - dx * s;
        const cu = u < -hx ? -hx : u > hx ? hx : u;
        const cv = v < -hz ? -hz : v > hz ? hz : v;
        const du = u - cu;
        const dv = v - cv;
        const d2 = du * du + dv * dv;
        if (d2 >= r2) continue;
        let pu: number;
        let pv: number;
        if (d2 > 0) {
          const d = Math.sqrt(d2);
          const k = (R - d) / d;
          pu = du * k;
          pv = dv * k;
        } else {
          const ex = hx - (u < 0 ? -u : u);
          const ez = hz - (v < 0 ? -v : v);
          if (ex <= ez) {
            pu = (u >= 0 ? 1 : -1) * (ex + R);
            pv = 0;
          } else {
            pu = 0;
            pv = (v >= 0 ? 1 : -1) * (ez + R);
          }
        }
        const wx = pu * c - pv * s;
        const wz = pu * s + pv * c;
        px = px + wx;
        pz = pz + wz;
        dpx = dpx + wx;
        dpz = dpz + wz;
        pushed = true;
      }
    }
    if (!pushed) return out;
    out.x = px;
    out.z = pz;
    out.pushX = dpx + r.pushX;
    out.pushZ = dpz + r.pushZ;
    return out;
  }
}

/** The live solid set (ui/camps/store.ts replaces it whenever pieces change). */
export const campRuntime = { set: new CampSet([]) };

class CampLevel implements GroundQuery {
  private readonly tmp: CollideResult = { x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false };

  constructor(
    readonly lv: GroundQuery,
    readonly set: CampSet,
    /** The view's feet height: floors above y + the step are not stood on (camps.With). */
    readonly y: number,
  ) {}

  heightAt(x: number, z: number): number {
    const h = this.lv.heightAt(x, z);
    if (this.set.hasSurfaces) {
      const t = this.set.surfaceAt(x, z, this.y);
      if (t !== null && t > h) return t;
    }
    return h;
  }
  normalAt(x: number, z: number): { x: number; y: number; z: number } {
    return this.lv.normalAt ? this.lv.normalAt(x, z) : { x: 0, y: 1, z: 0 };
  }
  waterAt(x: number, z: number): number {
    return this.lv.waterAt ? this.lv.waterAt(x, z) : -Infinity;
  }
  collide(x: number, y: number, z: number, out: CollideResult): CollideResult {
    const r = this.lv.collide!(x, y, z, this.tmp);
    return this.set.after(r, out);
  }
}

/** The world's ground with the solid camp pieces (WorldRuntime.ground). */
export class CampGround implements GroundQuery {
  constructor(readonly inner: GroundQuery) {
    // Only grounds with walls collide (movement takes "has collide" as "has walls").
    if (!inner.collide) (this as { collide?: unknown }).collide = undefined;
  }

  heightAt(x: number, z: number): number {
    return this.inner.heightAt(x, z);
  }
  normalAt(x: number, z: number): { x: number; y: number; z: number } {
    return this.inner.normalAt ? this.inner.normalAt(x, z) : { x: 0, y: 1, z: 0 };
  }
  waterAt(x: number, z: number): number {
    return this.inner.waterAt ? this.inner.waterAt(x, z) : -Infinity;
  }
  /** The step's view at feet height y: the inner view, plus the solid pieces when there are any. */
  atLevel(y: number): GroundQuery {
    const lv = this.inner.atLevel ? this.inner.atLevel(y) : this.inner;
    const set = campRuntime.set;
    if ((set.size === 0 && !set.hasSurfaces) || !lv.collide) return lv;
    return new CampLevel(lv, set, y);
  }
  collide(x: number, y: number, z: number, out: CollideResult): CollideResult {
    return this.atLevel(y).collide!(x, y, z, out);
  }
  floorAt(x: number, y: number, z: number): number {
    const f = (this.inner as { floorAt?: (x: number, y: number, z: number) => number }).floorAt;
    return f ? f.call(this.inner, x, y, z) : this.inner.heightAt(x, z);
  }
  caveAir(x: number, y: number, z: number): boolean {
    return this.inner.caveAir?.(x, y, z) ?? false;
  }
}
