// The client GroundQuery (client/src/sim/ground.ts) over worldgen's
// collision_height: exactly the function WP07's Go zone server runs on the
// same wasm, so prediction and server validation agree to the bit
// (worldgen/README.md "Collision"; WP07 checks 10,000 points).
//
// It calls the wasm export directly: no allocation, ~2 us per query, and it
// works everywhere at once (no waiting for chunks to stream in), which is
// what lets the player stand on terrain before its mesh has arrived.

import type { AtlasHandle, Worldgen } from '@lodestone/worldgen';
import type { GroundQuery } from '../../sim/ground';

/** Chunk ids -64..127 are valid (worldgen README); clamp so a fly-mode excursion past the sea can't hit -1e9. */
const MIN = -4096;
const MAX = 8191.999;

export class WorldGround implements GroundQuery {
  private readonly fn: (atlasPtr: number, x: number, z: number) => number;

  constructor(
    private readonly wg: Worldgen,
    private readonly atlas: AtlasHandle,
  ) {
    this.fn = wg.exports.collision_height;
  }

  heightAt(x: number, z: number): number {
    const cx = x < MIN ? MIN : x > MAX ? MAX : x;
    const cz = z < MIN ? MIN : z > MAX ? MAX : z;
    return this.fn(this.atlas.ptr, cx, cz);
  }

  normalAt(x: number, z: number): { x: number; y: number; z: number } {
    const n = this.wg.groundNormal(this.atlas, x, z).normal;
    return { x: n[0], y: n[1], z: n[2] };
  }

  /** Slope in degrees at (x, z) (climbing, spec 8, will want it). */
  slopeAt(x: number, z: number): number {
    return this.wg.groundNormal(this.atlas, x, z).slopeDeg;
  }
}
