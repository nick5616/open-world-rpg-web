// Where scatter must not stand (WP20): building plots, fences, town walls,
// plazas, streets, roads, farm fields and structure footprints. Scatter is
// generated per chunk by WP01 without knowing about towns, and the towns
// layer may not change chunk bytes (genVersion), so the client hides the
// trees, rocks and tufts that would poke through a floor or stand in a road
// (WP05 scatter manager: hide by stable id). A uniform 8 m grid over simple
// shapes: oriented boxes, capsules (road segments) and discs.

import type { Towns } from '@lodestone/worldgen';
import { boxAt, BK } from './kit';
import { PK } from './props';

type Shape = { t: 0; cx: number; cz: number; c: number; s: number; hx: number; hz: number } | { t: 1; ax: number; az: number; bx: number; bz: number; r: number } | { t: 2; x: number; z: number; r: number };

const G = 8;
const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

export class Clearance {
  private readonly shapes: Shape[] = [];
  private readonly grid = new Map<number, number[]>();
  private readonly chunks = new Set<number>();

  constructor(t: Towns) {
    const pad = 1.0;
    for (const s of t.settlements) {
      for (let i = s.boxFirst; i < s.boxFirst + s.boxCount; i++) {
        const b = boxAt(t, i);
        if (b.kind === BK.furniture || b.kind === BK.upper || b.kind === BK.roof) continue;
        this.add({ t: 0, cx: b.cx, cz: b.cz, c: b.c, s: b.s, hx: b.hx + pad, hz: b.hz + pad });
      }
      this.add({ t: 2, x: s.x, z: s.z, r: s.square + 1.5 });
      for (let i = s.propFirst; i < s.propFirst + s.propCount; i++) {
        const p = t.props[i];
        if (p.kind === PK.crops) this.add({ t: 0, cx: p.x, cz: p.z, c: Math.cos(p.yaw), s: Math.sin(p.yaw), hx: Math.max(4, p.scale) / 2 + 0.5, hz: 5 });
        else if (p.kind === PK.lantern || p.kind === PK.well || p.kind === PK.board) this.add({ t: 2, x: p.x, z: p.z, r: 1.2 });
      }
    }
    // Buildings outside the box walk above (stalls) are covered by their props' boxes.
    for (const r of t.roads) {
      const p = r.points;
      for (let i = 0; i + 1 < p.length / 3; i++) this.add({ t: 1, ax: p[i * 3], az: p[i * 3 + 2], bx: p[i * 3 + 3], bz: p[i * 3 + 5], r: r.width / 2 + 0.8 });
    }
    for (const st of t.structures) {
      for (let i = st.boxFirst; i < st.boxFirst + st.boxCount; i++) {
        const b = boxAt(t, i);
        this.add({ t: 0, cx: b.cx, cz: b.cz, c: b.c, s: b.s, hx: b.hx + pad, hz: b.hz + pad });
      }
      for (let i = st.pieceFirst; i < st.pieceFirst + st.pieceCount; i++) {
        const pc = t.pieces[i];
        if (pc.kind === 0 || pc.kind === 6 || pc.kind === 11 || pc.kind === 9 || pc.kind === 12) this.add({ t: 0, cx: pc.x, cz: pc.z, c: pc.c, s: pc.s, hx: 3.2, hz: 3.2 });
      }
    }
  }

  private add(sh: Shape): void {
    const idx = this.shapes.length;
    this.shapes.push(sh);
    let x0: number, x1: number, z0: number, z1: number;
    if (sh.t === 0) {
      const r = Math.hypot(sh.hx, sh.hz);
      [x0, x1, z0, z1] = [sh.cx - r, sh.cx + r, sh.cz - r, sh.cz + r];
    } else if (sh.t === 1) {
      [x0, x1, z0, z1] = [Math.min(sh.ax, sh.bx) - sh.r, Math.max(sh.ax, sh.bx) + sh.r, Math.min(sh.az, sh.bz) - sh.r, Math.max(sh.az, sh.bz) + sh.r];
    } else [x0, x1, z0, z1] = [sh.x - sh.r, sh.x + sh.r, sh.z - sh.r, sh.z + sh.r];
    for (let j = Math.floor(z0 / G); j <= Math.floor(z1 / G); j++)
      for (let i = Math.floor(x0 / G); i <= Math.floor(x1 / G); i++) {
        const k = key(i, j);
        const l = this.grid.get(k);
        if (l) l.push(idx);
        else this.grid.set(k, [idx]);
        this.chunks.add(key(Math.floor((i * G) / 64), Math.floor((j * G) / 64)));
      }
  }

  /** Some shape overlaps lod-0 chunk (cx, cz). */
  touchesChunk(cx: number, cz: number): boolean {
    return this.chunks.has(key(cx, cz));
  }

  blocked(x: number, z: number): boolean {
    const l = this.grid.get(key(Math.floor(x / G), Math.floor(z / G)));
    if (!l) return false;
    for (const i of l) {
      const sh = this.shapes[i];
      if (sh.t === 0) {
        const dx = x - sh.cx;
        const dz = z - sh.cz;
        if (Math.abs(dx * sh.c + dz * sh.s) <= sh.hx && Math.abs(dz * sh.c - dx * sh.s) <= sh.hz) return true;
      } else if (sh.t === 1) {
        const vx = sh.bx - sh.ax;
        const vz = sh.bz - sh.az;
        const L2 = vx * vx + vz * vz || 1;
        const f = Math.max(0, Math.min(1, ((x - sh.ax) * vx + (z - sh.az) * vz) / L2));
        if (Math.hypot(x - sh.ax - vx * f, z - sh.az - vz * f) <= sh.r) return true;
      } else if (Math.hypot(x - sh.x, z - sh.z) <= sh.r) return true;
    }
    return false;
  }
}
