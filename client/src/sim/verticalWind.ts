// CR 038: the vertical world's effect on gliders, as the movement step's
// UpdraftField: the descriptor's wind columns (sky lifts, wind columns,
// geysers, currents) lift you, and gliding in the sky over an archipelago
// costs no stamina (freeGlideAt). The Go twin is vertical.Wind
// (server/pkg/vertical/ground.go); the zone maxes it into its field
// (internal/game/night.go). Hand it to stepEnv.setVerticalUpdrafts.
import { inSkyBand, VerticalUpdrafts, type VerticalWorld } from '@lodestone/worldgen';
import type { UpdraftField } from './movement';

export class VerticalWind implements UpdraftField {
  private readonly cols: VerticalUpdrafts;
  constructor(readonly v: VerticalWorld) {
    this.cols = new VerticalUpdrafts(v.updrafts);
  }
  liftAt(x: number, y: number, z: number): number {
    return this.cols.liftAt(x, y, z);
  }
  freeGlideAt(x: number, y: number, z: number): boolean {
    return inSkyBand(this.v, x, y, z);
  }
}
