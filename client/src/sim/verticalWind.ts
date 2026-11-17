// CR 038: the vertical world's effect on gliders, as the movement step's
// UpdraftField: the descriptor's wind columns (sky lifts, wind columns,
// geysers, currents) lift you, and gliding in the sky over an archipelago
// costs no stamina (freeGlideAt). The Go twin is vertical.Wind
// (server/pkg/vertical/ground.go); the zone maxes it into its field
// (internal/game/night.go). Hand it to stepEnv.setVerticalUpdrafts.
import { inSkyBand, VerticalUpdrafts, type VerticalWorld } from '@lodestone/worldgen';
import type { UpdraftField } from './movement';

/** A palace atrium's shaft (CR 044; Go: palace.Wind). */
export interface ExtraColumn {
  x: number;
  z: number;
  r: number;
  top: number;
  lift: number;
}

export class VerticalWind implements UpdraftField {
  private readonly cols: VerticalUpdrafts;
  constructor(
    readonly v: VerticalWorld,
    private readonly extra: ExtraColumn[] = [],
  ) {
    this.cols = new VerticalUpdrafts(v.updrafts);
  }
  liftAt(x: number, y: number, z: number): number {
    let best = this.cols.liftAt(x, y, z);
    for (const c of this.extra) {
      const dx = x - c.x;
      const dz = z - c.z;
      if (dx * dx + dz * dz <= c.r * c.r && y <= c.top && c.lift > best) best = c.lift;
    }
    return best;
  }
  freeGlideAt(x: number, y: number, z: number): boolean {
    return inSkyBand(this.v, x, y, z);
  }
}
