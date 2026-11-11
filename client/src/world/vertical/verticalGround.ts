// The client's movement ground with the vertical world (CR 038): sky
// islands over the terrain, the Underground and the Depths under it, through
// the same VerticalGroundCore the golden table pins against the Go zone
// (server/pkg/vertical). Wraps WP09's cave ground (or the surface ground on a
// wasm without caves); TownGround, doors, camps and chemistry wrap it in
// turn (runtime.ts), so buildings in sky towns are ground like any other.
//
// Layer values come from the LOD 0 layer tiles the renderer streams (pure
// TS, bit-identical to the wasm) and fall back to the wasm `layer_height`
// for chunks not loaded: same bits either way, so prediction never waits.

import {
  inSkyBand,
  layerHeightWasm,
  parseLayerTile,
  tileLayerSource,
  VerticalGroundCore,
  type AtlasHandle,
  type LayerSource,
  type LayerTile,
  type VBase,
  type VCollideResult,
  type VerticalWorld,
  type Worldgen,
} from '@lodestone/worldgen';
import type { CollideResult, GroundQuery } from '../../sim/ground';

/** LOD 0 layer tiles by (layer, cx, cz), shared by collision and the renderer. */
export class VerticalTileStore {
  private readonly tiles = new Map<number, LayerTile>();
  private readonly order: number[] = [];
  readonly src: LayerSource;
  constructor(
    readonly wg: Worldgen,
    readonly atlas: AtlasHandle,
    readonly cap = 600,
  ) {
    const wasm: LayerSource = { height: (s, x, z) => layerHeightWasm(wg, atlas, s, x, z) };
    this.src = tileLayerSource((l, cx, cz) => this.tiles.get(key(l, cx, cz)), wasm);
  }
  has(layer: number, cx: number, cz: number): boolean {
    return this.tiles.has(key(layer, cx, cz));
  }
  get(layer: number, cx: number, cz: number): LayerTile | undefined {
    return this.tiles.get(key(layer, cx, cz));
  }
  /** Add a LOD 0 tile (from a worker job, or parsed bytes). */
  put(t: LayerTile): void {
    const k = key(t.layer, t.cx, t.cz);
    if (!this.tiles.has(k)) this.order.push(k);
    this.tiles.set(k, t);
    while (this.order.length > this.cap) this.tiles.delete(this.order.shift()!);
  }
  putBytes(b: Uint8Array): void {
    this.put(parseLayerTile(b));
  }
  get size(): number {
    return this.tiles.size;
  }
}

const key = (layer: number, cx: number, cz: number) => layer * 4096 + cz * 64 + cx;

export class VerticalGround implements GroundQuery {
  readonly core: VerticalGroundCore;

  constructor(
    readonly base: GroundQuery,
    readonly v: VerticalWorld,
    readonly store: VerticalTileStore,
  ) {
    this.core = new VerticalGroundCore(base as unknown as VBase, v, store.src);
  }

  heightAt(x: number, z: number): number {
    return this.base.heightAt(x, z);
  }

  waterAt(x: number, z: number): number {
    return this.base.waterAt ? this.base.waterAt(x, z) : -Infinity;
  }

  normalAt(x: number, z: number): { x: number; y: number; z: number } {
    return this.base.normalAt?.(x, z) ?? { x: 0, y: 1, z: 0 };
  }

  atLevel(y: number): GroundQuery {
    return this.core.atLevel(y) as unknown as GroundQuery;
  }

  collide(x: number, y: number, z: number, out: CollideResult): CollideResult {
    return this.core.collide(x, y, z, out as VCollideResult, this.base.atLevel ? (this.base.atLevel(y) as never) : null);
  }

  floorAt(x: number, y: number, z: number): number {
    return this.core.floorAt(x, y, z);
  }

  /** 0 surface, 1 sky island, 2 Underground, 3 Depths (gameplay: light, audio, HUD). */
  layerAt(x: number, y: number, z: number): number {
    return this.core.layerAt(x, y, z);
  }

  /** In the sky over an archipelago (or on an island). */
  inSky(x: number, y: number, z: number): boolean {
    return this.core.layerAt(x, y, z) === 1 || inSkyBand(this.v, x, y, z);
  }

  /** Voice occlusion: open air underground counts as cave air. */
  caveAir(x: number, y: number, z: number): boolean {
    const l = this.core.layerAt(x, y, z);
    if (l === 2 || l === 3) return true;
    return this.base.caveAir ? this.base.caveAir(x, y, z) : false;
  }
}
