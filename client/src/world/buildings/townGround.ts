// The client's movement ground with buildings (WP20): the surface/cave
// ground (WP05 terrain, WP12 towers, WP09 caves) plus the town collision
// boxes, through the same TownGroundCore the golden tests pin against the
// Go zone (server/pkg/towns.Ground). The movement step views it at the
// player's level (atLevel, client/src/sim/caves.ts), where building floors
// within a step of the feet are ground and walls push the body out, so
// prediction and the server agree inside buildings as on open terrain.

import { TownGroundCore, type TownCollision } from '@lodestone/worldgen';
import type { CollideResult, GroundQuery } from '../../sim/ground';

export class TownGround implements GroundQuery {
  readonly core: TownGroundCore;

  constructor(
    readonly base: GroundQuery,
    readonly collision: TownCollision,
  ) {
    this.core = new TownGroundCore(base, collision);
  }

  /** The base surface (non-step callers: rendering, overlays, spawns). */
  heightAt(x: number, z: number): number {
    return this.base.heightAt(x, z);
  }

  waterAt(x: number, z: number): number {
    return this.core.waterAt(x, z);
  }

  normalAt(x: number, z: number): { x: number; y: number; z: number } {
    return this.base.normalAt?.(x, z) ?? { x: 0, y: 1, z: 0 };
  }

  /** The step's view at feet height y: building floors and walls on top of the base view. */
  atLevel(y: number): GroundQuery {
    return this.core.atLevel(y) as GroundQuery;
  }

  /** Ground under feet at height y (spawns, NPC/prop placement). */
  floorAt(x: number, y: number, z: number): number {
    return this.core.floorAt(x, y, z);
  }

  collide(x: number, y: number, z: number, out: CollideResult): CollideResult {
    return this.core.atLevel(y).collide(x, y, z, out);
  }
}
