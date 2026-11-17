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
// CR 040: terrain the players dug and filled, added to the generated lattice (twin of server/pkg/worldedit).
import { lift, surface, TerrainOverlay } from '../edits/overlay';

/** Chunk ids -64..127 are valid (worldgen README); clamp so a fly-mode excursion past the sea can't hit -1e9. */
const MIN = -4096;
const MAX = 8191.999;

export class WorldGround implements GroundQuery {
  private readonly fn: (atlasPtr: number, x: number, z: number) => number;
  /** CR 040: the edit overlay; empty means exactly the generated collision surface. */
  readonly edits = new TerrainOverlay();
  private readonly corner = new Int8Array(4);

  constructor(
    private readonly wg: Worldgen,
    private readonly atlas: AtlasHandle,
  ) {
    this.fn = wg.exports.collision_height;
  }

  heightAt(x: number, z: number): number {
    const cx = x < MIN ? MIN : x > MAX ? MAX : x;
    const cz = z < MIN ? MIN : z > MAX ? MAX : z;
    if (this.edits.any) {
      const x0 = Math.floor(cx);
      const z0 = Math.floor(cz);
      const d = this.corner;
      if (this.edits.cell(x0, z0, d)) {
        // The generated f32 lattice corners (collision_height at an integer returns the lattice value), lifted by the deltas.
        const f = this.fn;
        const p = this.atlas.ptr;
        return surface(lift(f(p, x0, z0), d[0]), lift(f(p, x0 + 1, z0), d[1]), lift(f(p, x0, z0 + 1), d[2]), lift(f(p, x0 + 1, z0 + 1), d[3]), cx - x0, cz - z0);
      }
    }
    return this.fn(this.atlas.ptr, cx, cz);
  }

  /** The generated lattice height at integer vertex (x, z), ignoring edits (the dig planner, tile builds). */
  baseAt(x: number, z: number): number {
    return this.fn(this.atlas.ptr, x, z);
  }

  /**
   * Water surface (WP10: swimming): the wasm water_height, the same function
   * the zone's worldhost.Terrain.WaterAt answers, so client and zone agree on
   * where you swim. Clamped like heightAt.
   */
  waterAt(x: number, z: number): number {
    const cx = x < MIN ? MIN : x > MAX ? MAX : x;
    const cz = z < MIN ? MIN : z > MAX ? MAX : z;
    return this.wg.waterHeight(this.atlas, cx, cz);
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
