// The terrain edit overlay (CR 040), TypeScript twin of server/pkg/worldedit
// overlay.go: a signed height delta per 1 m lattice vertex in steps of
// STEP_M, on top of the generated heights (which never change). Every host
// adds the delta to the f32 lattice value before the collision
// interpolation, so the edited surface is bitwise identical in Go, here and
// in Rust:
//
//   h' = fround(h + d * 0.25)            (0.25 is a power of two: exact in f64)
//   surface = the collision formula of worldgen/README.md "Collision"
//
// The golden contracts/golden/world_edits.json (written by the Go twin from
// the real world) is replayed in overlay.test.ts.

export const STEP_M = 0.25;
export const MAX_DELTA = 24;
export const BLOCK = 64;
export const WORLD_BLOCKS = 64;

/** A lifted lattice height: the generated f32 value plus the delta. */
export const lift = (h: number, d: number): number => Math.fround(h + d * STEP_M);

/**
 * The collision interpolation over one cell's four corner heights (f64
 * arithmetic in worldgen's exact operation order; JS has no fused multiply-add).
 */
export function surface(h00: number, h10: number, h01: number, h11: number, fx: number, fz: number): number {
  if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
  return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
}

/** Decode a TerrainEdits payload / database column: n x (u16 LE local index z*64 + x, i8 delta). */
export function decodeEntries(b: Uint8Array): { i: number; d: number }[] {
  const out: { i: number; d: number }[] = [];
  for (let o = 0; o + 3 <= b.length; o += 3) {
    const i = b[o] | (b[o + 1] << 8);
    if (i >= BLOCK * BLOCK) continue;
    out.push({ i, d: (b[o + 2] << 24) >> 24 });
  }
  return out;
}

export function encodeEntries(es: { i: number; d: number }[]): Uint8Array {
  const out = new Uint8Array(es.length * 3);
  es.forEach((e, k) => {
    out[k * 3] = e.i & 255;
    out[k * 3 + 1] = e.i >> 8;
    out[k * 3 + 2] = e.d & 255;
  });
  return out;
}

export type OverlayListener = (minX: number, minZ: number, maxX: number, maxZ: number) => void;

export class TerrainOverlay {
  private readonly blocks = new Map<number, Int8Array>();
  /** Blocks with at least one edit; the zero-cost fast path of every ground query. */
  private live = 0;
  /** Bumped by every change (workers compare it to know whether to rebuild a tile). */
  version = 0;
  /** Called with the vertex bounds (inclusive) of every change. */
  readonly listeners = new Set<OverlayListener>();

  get any(): boolean {
    return this.live > 0;
  }

  private static key(bx: number, bz: number): number {
    return bz * WORLD_BLOCKS + bx;
  }

  delta(vx: number, vz: number): number {
    const bx = vx >> 6;
    const bz = vz >> 6;
    if (bx < 0 || bz < 0 || bx >= WORLD_BLOCKS || bz >= WORLD_BLOCKS) return 0;
    const b = this.blocks.get(TerrainOverlay.key(bx, bz));
    return b ? b[(vz & 63) * BLOCK + (vx & 63)] : 0;
  }

  /** Corner deltas of the cell at (x0, z0) into out (00, 10, 01, 11); true when any is non-zero. */
  cell(x0: number, z0: number, out: Int8Array): boolean {
    out[0] = this.delta(x0, z0);
    out[1] = this.delta(x0 + 1, z0);
    out[2] = this.delta(x0, z0 + 1);
    out[3] = this.delta(x0 + 1, z0 + 1);
    return (out[0] | out[1] | out[2] | out[3]) !== 0;
  }

  /** Set absolute deltas; each entry is a vertex of chunk (cx, cz). Returns true when anything changed. */
  setEntries(cx: number, cz: number, entries: { i: number; d: number }[]): boolean {
    if (cx < 0 || cz < 0 || cx >= WORLD_BLOCKS || cz >= WORLD_BLOCKS) return false;
    const k = TerrainOverlay.key(cx, cz);
    let b = this.blocks.get(k);
    let changed = false;
    let n = b ? this.count(b) : 0;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const e of entries) {
      const d = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, e.d));
      const old = b ? b[e.i] : 0;
      if (old === d) continue;
      if (!b) {
        b = new Int8Array(BLOCK * BLOCK);
        this.blocks.set(k, b);
      }
      b[e.i] = d;
      n += (d !== 0 ? 1 : 0) - (old !== 0 ? 1 : 0);
      changed = true;
      const x = cx * BLOCK + (e.i & 63);
      const z = cz * BLOCK + (e.i >> 6);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    if (!changed) return false;
    if (b && n === 0) this.blocks.delete(k);
    this.live = this.blocks.size;
    this.version++;
    for (const l of this.listeners) l(minX, minZ, maxX, maxZ);
    return true;
  }

  /** Set one vertex (solo play, tests). */
  setVertex(vx: number, vz: number, d: number): void {
    this.setEntries(vx >> 6, vz >> 6, [{ i: (vz & 63) * BLOCK + (vx & 63), d }]);
  }

  /** Apply a TerrainEdits message. */
  applyWire(cx: number, cz: number, data: Uint8Array): boolean {
    return this.setEntries(cx, cz, decodeEntries(data));
  }

  /** Every non-zero vertex in the closed box, as flat [x, z, d] triples (worker jobs). */
  collect(minX: number, minZ: number, maxX: number, maxZ: number): Int32Array | null {
    if (!this.live) return null;
    const out: number[] = [];
    for (let bz = Math.max(0, minZ >> 6); bz <= Math.min(WORLD_BLOCKS - 1, maxZ >> 6); bz++) {
      for (let bx = Math.max(0, minX >> 6); bx <= Math.min(WORLD_BLOCKS - 1, maxX >> 6); bx++) {
        const b = this.blocks.get(TerrainOverlay.key(bx, bz));
        if (!b) continue;
        for (let i = 0; i < b.length; i++) {
          if (!b[i]) continue;
          const x = bx * BLOCK + (i & 63);
          const z = bz * BLOCK + (i >> 6);
          if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) out.push(x, z, b[i]);
        }
      }
    }
    return out.length ? Int32Array.from(out) : null;
  }

  /** Number of edited vertices (HUD, debug). */
  vertices(): number {
    let n = 0;
    for (const b of this.blocks.values()) n += this.count(b);
    return n;
  }

  private count(b: Int8Array): number {
    let n = 0;
    for (let i = 0; i < b.length; i++) if (b[i]) n++;
    return n;
  }
}
