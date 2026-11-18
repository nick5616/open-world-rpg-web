import { describe, expect, it } from 'vitest';
import { parseChunk } from '@lodestone/worldgen';
import { WorldGround } from '../core/ground';
import { hasWasm, testWorld } from '../testing/wasm';
import { buildTileMesh, S } from '../terrain/tileMesh';
import { MAX_DELTA } from './overlay';
import { applyTileEdits, bedrockShare, editedOutside } from './tileEdits';

describe.skipIf(!hasWasm)('terrain edits in a tile build', () => {
  it('an edited LOD 0 tile is exactly the edited collision surface, seams included', async () => {
    const { wg, atlas } = await testWorld();
    const ground = new WorldGround(wg, atlas);
    // A pit on the border between chunks (27, 32) and (27, 31): the shared edge row z = 2048.
    for (let z = 2044; z <= 2052; z++) for (let x = 1736; x <= 1744; x++) ground.edits.setVertex(x, z, -((x % 3) + 3));
    for (const [cx, cz] of [[27, 32], [27, 31]]) {
      const edits = ground.edits.collect(cx * 64 - 2, cz * 64 - 2, cx * 64 + 66, cz * 64 + 66)!;
      expect(edits.length).toBeGreaterThan(0);
      const chunk = parseChunk(wg.buildChunkBytes(atlas, cx, cz, 0));
      const base = (x: number, z: number) => wg.collisionHeight(atlas, x, z);
      const before = chunk.splatA.slice();
      expect(applyTileEdits(chunk, edits)).toBeGreaterThan(0);
      const tile = buildTileMesh(chunk, editedOutside(base, edits), 'x', atlas.data.seaY);
      let checked = 0;
      for (let j = 0; j < S; j++) {
        for (let i = 0; i < S; i++) {
          const x = cx * 64 + i;
          const z = cz * 64 + j;
          expect(tile.position[(j * S + i) * 3 + 1], `vertex ${x},${z}`).toBe(ground.heightAt(x, z));
          checked++;
        }
      }
      expect(checked).toBe(S * S);
      // The pit turned to bare soil: every touched vertex has dirt dominant, weights still sum to 255.
      let soil = 0;
      for (let v = 0; v < S * S; v++) if (chunk.splatA[v * 4 + 1] !== before[v * 4 + 1]) soil++;
      expect(soil).toBeGreaterThan(0);
      for (let v = 0; v < S * S; v++) {
        const sum = chunk.splatA[v * 4] + chunk.splatA[v * 4 + 1] + chunk.splatA[v * 4 + 2] + chunk.splatA[v * 4 + 3] + chunk.splatB[v * 4] + chunk.splatB[v * 4 + 1];
        expect(sum).toBe(255);
      }
      // Bounds follow the pit (culling stays correct).
      expect(tile.minY).toBeLessThanOrEqual(Math.min(...Array.from(chunk.heights)) + 1e-3);
    }
  });

  it('a coarse tile only takes the edits on its lattice', async () => {
    const { wg, atlas } = await testWorld();
    const chunk = parseChunk(wg.buildChunkBytes(atlas, 26, 30, 1)); // lod 1: 2 m spacing, 128 m tile
    const x0 = chunk.cx * 64;
    const z0 = chunk.cz * 64;
    const n = applyTileEdits(chunk, Int32Array.from([x0 + 2, z0 + 4, -6, x0 + 3, z0 + 4, -6, x0 + 100, z0 + 10, 4]));
    expect(n).toBe(2); // the odd-x vertex is not on the 2 m lattice
  });

  // Playtest 5 ("the underground has an invisible floor"): a pit's bottom at the dig cap is drawn as bedrock.
  it('the bottom of a dig is bedrock: dirt grades into rock down to the cap', async () => {
    const { wg, atlas } = await testWorld();
    const chunk = parseChunk(wg.buildChunkBytes(atlas, 27, 32, 0));
    const x0 = chunk.cx * 64;
    const z0 = chunk.cz * 64;
    expect(applyTileEdits(chunk, Int32Array.from([x0 + 5, z0 + 5, -2, x0 + 9, z0 + 5, -MAX_DELTA / 2, x0 + 13, z0 + 5, -MAX_DELTA]))).toBe(3);
    const at = (x: number) => 5 * S + (x - x0);
    const rock = (x: number) => chunk.splatA[at(x) * 4 + 2];
    const dirt = (x: number) => chunk.splatA[at(x) * 4 + 1];
    expect(rock(x0 + 5), 'a shallow dig is soil').toBe(0);
    expect(dirt(x0 + 5)).toBeGreaterThan(200);
    expect(rock(x0 + 9), 'half way is part rock').toBeGreaterThan(0);
    expect(rock(x0 + 9)).toBeLessThan(dirt(x0 + 9) + rock(x0 + 9));
    expect(rock(x0 + 13), 'the cap is all rock').toBe(255);
    expect(dirt(x0 + 13)).toBe(0);
    for (const x of [5, 9, 13]) {
      const v = at(x0 + x) * 4;
      expect(chunk.splatA[v] + chunk.splatA[v + 1] + chunk.splatA[v + 2] + chunk.splatA[v + 3] + chunk.splatB[v] + chunk.splatB[v + 1]).toBe(255);
    }
  });

  it('bedrockShare: none above a third of the cap, all at it', () => {
    expect(bedrockShare(0)).toBe(0);
    expect(bedrockShare(4)).toBe(0);
    expect(bedrockShare(-MAX_DELTA / 3)).toBe(0);
    expect(bedrockShare(-MAX_DELTA / 2)).toBeGreaterThan(0);
    expect(bedrockShare(-MAX_DELTA)).toBe(1);
  });
});
