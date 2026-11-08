// A GroundQuery straight on worldgen.wasm (WP10): heightAt = collision_height,
// waterAt = water_height, i.e. the exact functions the zone's
// worldhost.Terrain evaluates (its cached fast path is bitwise equal). Used by
// the movement goldens, the Node acceptance client and the debug
// ?ground=worldgen mode. WP05's streamed terrain should answer the same
// queries from LOD 0 chunks with chunkSurfaceHeight / chunkWaterHeight (same
// bits, no wasm call per query).
//
// Cost: ~1.7 us per collision_height and a few us per water_height from JS;
// a walking step asks ~10 of them, a replay of 30 steps well under 1 ms.

import type { AtlasHandle, Worldgen } from '@lodestone/worldgen';
import type { GroundQuery } from './ground';

export class WorldgenGround implements GroundQuery {
  constructor(
    readonly wg: Worldgen,
    readonly atlas: AtlasHandle,
  ) {}
  heightAt(x: number, z: number): number {
    return this.wg.collisionHeight(this.atlas, x, z);
  }
  waterAt(x: number, z: number): number {
    return this.wg.waterHeight(this.atlas, x, z);
  }
}

/** Instantiate the wasm from bytes and build the world for a seed (atlas ~0.4 s). */
export async function loadWorldgenGround(wasm: BufferSource, seed: bigint | string | number): Promise<WorldgenGround> {
  const { loadWorldgen } = await import('@lodestone/worldgen');
  const wg = await loadWorldgen(wasm);
  return new WorldgenGround(wg, wg.buildAtlas(wg.specFromSeed(BigInt(seed))));
}
