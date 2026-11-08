// Updraft columns: the debug implementation of the movement step's
// UpdraftField hook (spec 8: fire's rising heat gives an updraft you can
// ride). The chemistry engine (WP15) will provide its own field from synced
// burn state; until then a column is configured identically on both sides:
// the zone from LODESTONE_ZONE_DEBUG_UPDRAFTS, the client from
// ?updraft=... (or the dev handle), same "x,z,radius,top,lift[;...]" syntax.
// The Go twin is server/pkg/movement/updraft.go.

import type { UpdraftField } from './movement';

export interface UpdraftColumn {
  /** Column center, meters. */
  x: number;
  z: number;
  /** Horizontal radius, meters. */
  radius: number;
  /** World y of the column top: above it there is no lift. */
  top: number;
  /** Lift in m/s (the step clamps to UPDRAFT_MAX_LIFT). */
  lift: number;
}

/** A set of vertical cylinders; inside one (and below its top) you get its lift (max over overlaps). */
export class UpdraftColumns implements UpdraftField {
  constructor(readonly columns: readonly UpdraftColumn[]) {}
  liftAt(x: number, y: number, z: number): number {
    let best = 0;
    for (const c of this.columns) {
      const dx = x - c.x;
      const dz = z - c.z;
      if (dx * dx + dz * dz <= c.radius * c.radius && y <= c.top && c.lift > best) best = c.lift;
    }
    return best;
  }
}

/** Parse "x,z,radius,top,lift;..." (empty or malformed entries are skipped). */
export function parseUpdrafts(spec: string | null | undefined): UpdraftColumn[] {
  if (!spec) return [];
  const out: UpdraftColumn[] = [];
  for (const part of spec.split(';')) {
    const v = part.split(',').map((s) => Number(s.trim()));
    if (v.length !== 5 || v.some((n) => !Number.isFinite(n))) continue;
    out.push({ x: v[0], z: v[1], radius: v[2], top: v[3], lift: v[4] });
  }
  return out;
}
