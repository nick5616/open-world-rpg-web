// Structure overlay on the ground query (WP12): towers now, WP20's buildings
// later. TS twin of server/pkg/structures (overlay.go, radial.go, tower.go);
// read that package comment for the model. In short:
//
//   height(x, z) = max(terrain(x, z), max over structures covering (x, z) of top(x, z))
//
// so a structure is a solid from its top surface down, and its walls are
// steep parts of the height function that movement climbs like any cliff.
//
// Determinism: prediction (this file) and the zone (Go) must agree to the
// bit, so every formula here mirrors the Go code operation for operation,
// using only IEEE-exact operations (+ - * / Math.sqrt, comparisons). Never
// use Math.tan/sin/cos/hypot here: those are host math and differ in the
// last ulp between V8 and Go. The golden vectors in
// server/pkg/structures/testdata/golden.json pin it (overlay.test.ts).

import type { GroundQuery } from '../../sim/ground';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * One solid on the terrain. Implementations must be pure functions of their
 * construction parameters and have a Go twin in server/pkg/structures that
 * the golden test replays (see client/src/world/structures/README.md for
 * how WP20 adds a structure kind).
 */
export interface Structure {
  /** Horizontal box outside which top() never covers: [minX, minZ, maxX, maxZ]. */
  bounds(): [number, number, number, number];
  /** Top surface height at (x, z), or NaN where the structure doesn't cover the point. */
  top(x: number, z: number): number;
  /** Unit normal at (x, z); only called where top() covers. */
  normal(x: number, z: number): Vec3;
}

const CELL = 64;
const cellOf = (v: number) => Math.floor(v / CELL);
const cellKey = (cx: number, cz: number) => cx * 65536 + cz;

/** Grid-indexed set of structures. Build once with add(), then query. */
export class StructureOverlay {
  private readonly items: Structure[] = [];
  private readonly cells = new Map<number, number[]>();

  add(s: Structure): number {
    const idx = this.items.length;
    this.items.push(s);
    const [x0, z0, x1, z1] = s.bounds();
    for (let cz = cellOf(z0); cz <= cellOf(z1); cz++) {
      for (let cx = cellOf(x0); cx <= cellOf(x1); cx++) {
        const k = cellKey(cx, cz);
        const list = this.cells.get(k);
        if (list) list.push(idx);
        else this.cells.set(k, [idx]);
      }
    }
    return idx;
  }

  get length(): number {
    return this.items.length;
  }

  at(i: number): Structure {
    return this.items[i];
  }

  /** Highest structure surface covering (x, z); out.idx = -1 (and NaN) when none. */
  top(x: number, z: number, out: { h: number; idx: number }): { h: number; idx: number } {
    out.h = NaN;
    out.idx = -1;
    if (this.items.length === 0 || Number.isNaN(x) || Number.isNaN(z)) return out;
    const list = this.cells.get(cellKey(cellOf(x), cellOf(z)));
    if (!list) return out;
    for (const i of list) {
      const t = this.items[i].top(x, z);
      if (!Number.isNaN(t) && (out.idx < 0 || t > out.h)) {
        out.h = t;
        out.idx = i;
      }
    }
    return out;
  }
}

/**
 * Piecewise-linear solid of revolution (Go: structures.Radial). Profile:
 * drop below topY against distance r from the axis; beyond the last
 * breakpoint the wall continues at `tail` (m drop per m) until maxR.
 */
export class RadialStructure implements Structure {
  readonly r: number[];
  readonly drop: number[];
  readonly maxR: number;
  private readonly slope: number[];
  private readonly maxR2: number;

  constructor(
    readonly cx: number,
    readonly cz: number,
    readonly topY: number,
    r: number[],
    drop: number[],
    readonly tail: number,
    maxR: number,
  ) {
    if (r.length === 0 || r.length !== drop.length || !(tail > 0)) throw new Error('structures: bad radial profile');
    this.r = r.slice();
    this.drop = drop.slice();
    this.maxR = Math.max(maxR, r[r.length - 1]);
    this.slope = [];
    for (let i = 0; i < r.length - 1; i++) {
      if (!(r[i + 1] > r[i]) || drop[i + 1] < drop[i]) throw new Error('structures: radial profile must increase in r and not rise');
      this.slope.push((drop[i + 1] - drop[i]) / (r[i + 1] - r[i]));
    }
    this.maxR2 = this.maxR * this.maxR;
  }

  bounds(): [number, number, number, number] {
    return [this.cx - this.maxR, this.cz - this.maxR, this.cx + this.maxR, this.cz + this.maxR];
  }

  /** Drop at radius r; slope written to this.lastSlope (0 on the platform). */
  private lastSlope = 0;
  dropAt(r: number): number {
    if (r <= this.r[0]) {
      this.lastSlope = 0;
      return 0;
    }
    const n = this.r.length;
    for (let i = 0; i < n - 1; i++) {
      if (r <= this.r[i + 1]) {
        this.lastSlope = this.slope[i];
        return this.drop[i] + (r - this.r[i]) * this.slope[i];
      }
    }
    this.lastSlope = this.tail;
    return this.drop[n - 1] + (r - this.r[n - 1]) * this.tail;
  }

  top(x: number, z: number): number {
    const dx = x - this.cx;
    const dz = z - this.cz;
    const d2 = dx * dx + dz * dz;
    if (d2 > this.maxR2) return NaN;
    return this.topY - this.dropAt(Math.sqrt(d2));
  }

  normal(x: number, z: number): Vec3 {
    const dx = x - this.cx;
    const dz = z - this.cz;
    const r = Math.sqrt(dx * dx + dz * dz);
    this.dropAt(r);
    const s = this.lastSlope;
    if (s === 0 || r === 0) return { x: 0, y: 1, z: 0 };
    const nx = (s * dx) / r;
    const nz = (s * dz) / r;
    const l = Math.sqrt(nx * nx + nz * nz + 1);
    return { x: nx / l, y: 1 / l, z: nz / l };
  }
}

/** Ground with the overlay on top of a base ground (Go: structures.Ground). */
export class StructureGround implements GroundQuery {
  private readonly q = { h: NaN, idx: -1 };

  constructor(
    readonly base: GroundQuery,
    readonly overlay: StructureOverlay,
  ) {}

  heightAt(x: number, z: number): number {
    const b = this.base.heightAt(x, z);
    const t = this.overlay.top(x, z, this.q);
    return t.idx >= 0 && t.h > b ? t.h : b;
  }

  /**
   * Water is the base ground's (WP10): structures stand on land, and where a
   * structure top is above the water the swim test (water - ground >= 1.5 m)
   * fails by itself. Go twin: structures.Ground.WaterAt.
   */
  waterAt(x: number, z: number): number {
    return this.base.waterAt ? this.base.waterAt(x, z) : -Infinity;
  }

  /** Index of the structure forming the ground at (x, z), -1 for terrain. */
  structureAt(x: number, z: number): number {
    const t = this.overlay.top(x, z, this.q);
    if (t.idx < 0) return -1;
    const idx = t.idx;
    const h = t.h;
    return h > this.base.heightAt(x, z) ? idx : -1;
  }

  normalAt(x: number, z: number): Vec3 {
    const i = this.structureAt(x, z);
    if (i >= 0) return this.overlay.at(i).normal(x, z);
    return this.base.normalAt?.(x, z) ?? { x: 0, y: 1, z: 0 };
  }

  /** Slope in degrees of the combined surface (climbing reads it; WorldGround has the same method). */
  slopeAt(x: number, z: number): number {
    const n = this.normalAt(x, z);
    return (Math.acos(Math.min(1, Math.max(-1, n.y))) * 180) / Math.PI;
  }
}
