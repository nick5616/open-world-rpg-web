// The client's movement ground with caves (WP09): the surface ground (WP05's
// terrain with WP12's structure overlay: towers keep working) plus cave
// floors, walls and mouth holes from the shared cell store, through the
// same CaveGroundCore the golden tests pin against the Go zone
// (server/pkg/caves.Ground). The movement step views it at the player's
// level (`atLevel`, client/src/sim/caves.ts), so prediction and the server
// agree underground exactly as they do on the surface.

import { CaveGroundCore, caveRock, type CaveCellSource, type CaveCollideResult, type CaveOpening } from '@lodestone/worldgen';
import type { GroundQuery } from '../../sim/ground';
import type { CaveCellStore } from './caveStore';

export class CaveGround implements GroundQuery {
  readonly core: CaveGroundCore;

  /** The store without synchronous builds (missing cells read as rock). */
  private readonly loaded: CaveCellSource;

  constructor(
    readonly surface: GroundQuery,
    openings: readonly CaveOpening[],
    readonly store: CaveCellStore,
    /** The bare terrain (no structures): the in-cave test. */
    terrain: GroundQuery = surface,
  ) {
    const water = surface.waterAt ? (x: number, z: number) => surface.waterAt!(x, z) : undefined;
    this.core = new CaveGroundCore((x, z) => surface.heightAt(x, z), openings, store, water, (x, z) => terrain.heightAt(x, z));
    this.loaded = { cell: (cx, cy, cz) => (store.has(cx, cy, cz) ? store.cell(cx, cy, cz) : undefined) };
  }

  /** Open cave air at (x, y, z) from the loaded cells (voice occlusion; see GroundQuery.caveAir). */
  caveAir(x: number, y: number, z: number): boolean {
    return this.core.inCave(x, y, z) && !caveRock(this.loaded, x, y, z);
  }

  /** The surface (non-step callers: rendering, overlays, spawns). */
  heightAt(x: number, z: number): number {
    return this.surface.heightAt(x, z);
  }

  waterAt(x: number, z: number): number {
    return this.core.waterAt(x, z);
  }

  normalAt(x: number, z: number): { x: number; y: number; z: number } {
    return this.surface.normalAt?.(x, z) ?? { x: 0, y: 1, z: 0 };
  }

  /** The step's view at feet height y (cave floors in caves). */
  atLevel(y: number): GroundQuery {
    return this.core.atLevel(y);
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
