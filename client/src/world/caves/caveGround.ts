// The client's movement ground with caves (WP09): WP05's WorldGround (the
// heightfield via collision_height) plus cave floors, walls and mouth holes
// from the shared cell store, through the same CaveGroundCore the golden
// tests pin against the Go zone (server/pkg/caves.Ground). Prediction and the
// server therefore agree underground exactly as they do on the surface.

import { CaveGroundCore, type AtlasHandle, type CaveCollideResult, type CaveOpening, type Worldgen } from '@lodestone/worldgen';
import { WorldGround } from '../core/ground';
import type { CaveCellStore } from './caveStore';

export class CaveGround extends WorldGround {
  readonly core: CaveGroundCore;

  constructor(wg: Worldgen, atlas: AtlasHandle, openings: readonly CaveOpening[], readonly store: CaveCellStore) {
    super(wg, atlas);
    this.core = new CaveGroundCore((x, z) => super.heightAt(x, z), openings, store);
  }

  floorAt(x: number, y: number, z: number): number {
    return this.core.floorAt(x, y, z);
  }

  collide(x: number, y: number, z: number, out: CaveCollideResult): CaveCollideResult {
    return this.core.collide(x, y, z, out);
  }

  /** In a mouth hole or underground (lighting, audio, interest). */
  inCave(x: number, y: number, z: number): boolean {
    return this.core.inCave(x, y, z);
  }
}
