// Ice sheets and earth pillars on the movement ground (WP15): the TS twin
// of chem/overlay.go. Spec 8: ice freezes a walkable sheet; earth raises a
// climbable pillar (80 degree walls, climbed by WP10's rules like towers).
// The wrapper reads whichever ChemView is live (chemRuntime.view); with no
// view, no ice and no pillars it is the inner ground unchanged, so every
// movement golden stays bit-identical.

import type { CollideResult, GroundQuery } from '../../sim/ground';
import { cellAt, cellId, inWorld, type Pillar } from './sim';
import type { ChemView } from './sync';

/** The overlay applies to feet at most this far under its surface (never to a cave below). */
const BELOW = 3;

export const chemRuntime = { view: null as ChemView | null };

interface Surface {
  version: number;
  view: ChemView | null;
  sheets: Map<number, number>;
  pillars: readonly Pillar[];
}

let surface: Surface = { version: -1, view: null, sheets: new Map(), pillars: [] };

function current(): Surface {
  const v = chemRuntime.view;
  if (!v) return { version: -1, view: null, sheets: surface.sheets.size ? new Map() : surface.sheets, pillars: [] };
  if (surface.view !== v || surface.version !== v.surfaceVersion) {
    const sheets = new Map<number, number>();
    v.forEachActive((id, st, y) => {
      if (st === 3) sheets.set(id, y);
    });
    surface = { version: v.surfaceVersion, view: v, sheets, pillars: [...v.pillars()] };
  }
  return surface;
}

/** A pillar's surface at (x, z), or null (overlay.go PillarHeight). */
export function pillarHeight(p: Pillar, x: number, z: number): number | null {
  const dx = Math.abs(x - p.x);
  const dz = Math.abs(z - p.z);
  const d = Math.max(dx, dz);
  if (d <= p.half) return p.baseY + p.height;
  if (d < p.half + p.run) return p.baseY + (p.height * (p.half + p.run - d)) / p.run;
  return null;
}

/** The overlay's surface at (x, z) for feet at y, or null. */
export function overlayHeight(x: number, y: number, z: number): number | null {
  const s = current();
  if (s.sheets.size === 0 && s.pillars.length === 0) return null;
  let best: number | null = null;
  if (s.sheets.size) {
    const ix = cellAt(x);
    const iz = cellAt(z);
    if (inWorld(ix, iz)) {
      const h = s.sheets.get(cellId(ix, iz));
      if (h !== undefined && y >= h - BELOW) best = h;
    }
  }
  for (const p of s.pillars) {
    if (y < p.baseY - BELOW) continue;
    const h = pillarHeight(p, x, z);
    if (h !== null && (best === null || h > best)) best = h;
  }
  return best;
}

function overlayActive(): boolean {
  const s = current();
  return s.sheets.size > 0 || s.pillars.length > 0;
}

/** Wrap a ground with the chemistry overlay (WorldRuntime.ground). */
export class ChemGround implements GroundQuery {
  constructor(
    readonly inner: GroundQuery,
    private readonly level = Infinity,
  ) {
    // Only grounds with walls collide (movement takes "has collide" as "has caves").
    if (!inner.collide) (this as { collide?: unknown }).collide = undefined;
  }

  heightAt(x: number, z: number): number {
    const h = this.inner.heightAt(x, z);
    if (!overlayActive()) return h;
    const oh = overlayHeight(x, this.level, z);
    return oh !== null && oh > h ? oh : h;
  }
  normalAt(x: number, z: number): { x: number; y: number; z: number } {
    return this.inner.normalAt ? this.inner.normalAt(x, z) : { x: 0, y: 1, z: 0 };
  }
  waterAt(x: number, z: number): number {
    return this.inner.waterAt ? this.inner.waterAt(x, z) : -Infinity;
  }
  atLevel(y: number): GroundQuery {
    const lv = this.inner.atLevel ? this.inner.atLevel(y) : this.inner;
    if (!overlayActive()) return lv;
    return new ChemGround(lv, y);
  }
  collide(x: number, y: number, z: number, out: CollideResult): CollideResult {
    if (this.inner.collide) return this.inner.collide(x, y, z, out);
    out.x = x;
    out.y = y;
    out.z = z;
    out.pushX = out.pushZ = 0;
    out.ceiling = false;
    return out;
  }
  caveAir(x: number, y: number, z: number): boolean {
    return this.inner.caveAir?.(x, y, z) ?? false;
  }
}
