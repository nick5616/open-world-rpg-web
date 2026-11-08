// The world's chemistry materials (WP15): TS twin of chem/material.go
// TerrainMaterial. A pure function of the bare terrain (collision_height,
// water_height: bit-identical to the zone's), the atlas macro grids and the
// seed, cached per cell.

import type { AtlasData } from '@lodestone/worldgen';
import { biomeMaterial, CELL_M, cellCenter, cellId, inWorld, MAT_NONE, MAT_WATER, seedWords, type ChemSource } from './sim';

export interface Heights {
  heightAt(x: number, z: number): number;
  waterAt?(x: number, z: number): number;
}

export class TerrainMaterial implements ChemSource {
  private cache = new Map<number, number>();
  private readonly seedW: [number, number];
  private readonly gridN: number;
  private readonly macroRes: number;
  private readonly biome: Uint8Array;
  private readonly node: Uint8Array;

  constructor(
    readonly t: Heights,
    readonly seed: bigint,
    atlas: Pick<AtlasData, 'gridN' | 'biome' | 'nodeParams' | 'worldSize'>,
  ) {
    this.seedW = seedWords(seed);
    this.gridN = atlas.gridN;
    // The zone derives the node spacing from the grid size (chem/material.go parseAtlasGrids).
    this.macroRes = Math.floor(atlas.worldSize / (atlas.gridN - 1));
    this.biome = atlas.biome;
    this.node = atlas.nodeParams;
  }

  material(ix: number, iz: number): number {
    if (!inWorld(ix, iz)) return MAT_NONE;
    const id = cellId(ix, iz);
    const c = this.cache.get(id);
    if (c !== undefined) return c;
    const v = this.compute(ix, iz);
    if (this.cache.size > 1 << 20) this.cache.clear();
    this.cache.set(id, v);
    return v;
  }

  private compute(ix: number, iz: number): number {
    const x = cellCenter(ix);
    const z = cellCenter(iz);
    const w = this.t.waterAt ? this.t.waterAt(x, z) : -Infinity;
    if (w > this.t.heightAt(x, z) + 0.05) return MAT_WATER;
    let biome = 0;
    if (this.gridN > 0 && this.macroRes > 0) {
      const i = Math.min(this.gridN - 1, Math.floor((ix * CELL_M + CELL_M / 2 + Math.floor(this.macroRes / 2)) / this.macroRes));
      const j = Math.min(this.gridN - 1, Math.floor((iz * CELL_M + CELL_M / 2 + Math.floor(this.macroRes / 2)) / this.macroRes));
      const n = j * this.gridN + i;
      if (4 * n + 3 < this.node.length && (this.node[4 * n + 3] & 8) !== 0) return MAT_NONE;
      if (n < this.biome.length) biome = this.biome[n];
    }
    return biomeMaterial(this.seedW, ix, iz, biome);
  }

  height(ix: number, iz: number): number {
    return this.t.heightAt(cellCenter(ix), cellCenter(iz));
  }

  water(ix: number, iz: number): number {
    return this.t.waterAt ? this.t.waterAt(cellCenter(ix), cellCenter(iz)) : -Infinity;
  }
}
