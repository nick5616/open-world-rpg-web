import { describe, expect, it } from 'vitest';
import { fnv1a64, hex64, parseChunk } from '@lodestone/worldgen';
import { buildTileMesh, CELLS, GRID_VERTS, S, tileGrid, tileIndex, TILE_TRIS, TILE_VERTS } from './tileMesh';
import { hasWasm, rand, testWorld } from '../testing/wasm';

async function tile(cx: number, cz: number, lod: number) {
  const { wg, atlas } = await testWorld();
  const bytes = wg.buildChunkBytes(atlas, cx, cz, lod);
  const c = parseChunk(bytes);
  return { c, mesh: buildTileMesh(c, (x, z) => wg.collisionHeight(atlas, x, z), hex64(fnv1a64(bytes)), atlas.data.seaY), wg, atlas };
}

describe('tile index topology', () => {
  it('splits every cell on the collision diagonal (i+1, j)-(i, j+1)', () => {
    const idx = tileIndex();
    expect(idx.length).toBe(TILE_TRIS * 3);
    for (let cell = 0; cell < CELLS * CELLS; cell++) {
      const i = cell % CELLS;
      const j = Math.floor(cell / CELLS);
      const a = j * S + i;
      const t1 = [...idx.slice(cell * 6, cell * 6 + 3)];
      const t2 = [...idx.slice(cell * 6 + 3, cell * 6 + 6)];
      // Both triangles contain the diagonal b = a + 1, c = a + S.
      for (const t of [t1, t2]) {
        expect(t).toContain(a + 1);
        expect(t).toContain(a + S);
      }
      expect(t1).toContain(a);
      expect(t2).toContain(a + S + 1);
    }
  });
  it('grid coordinates repeat on skirts', () => {
    const g = tileGrid();
    expect(g.length).toBe(TILE_VERTS * 2);
    expect([g[GRID_VERTS * 2], g[GRID_VERTS * 2 + 1]]).toEqual([0, 0]);
  });
});

describe.skipIf(!hasWasm)('tile meshes from real chunks', () => {
  it('a lod-0 tile is the collision surface (same lattice, same diagonal)', async () => {
    const { mesh, wg, atlas } = await tile(30, 35, 0);
    const P = mesh.position;
    const r = rand(7);
    for (let n = 0; n < 2000; n++) {
      const x = 30 * 64 + r() * 64;
      const z = 35 * 64 + r() * 64;
      const i = Math.floor(x - 30 * 64);
      const j = Math.floor(z - 35 * 64);
      const fx = x - Math.floor(x);
      const fz = z - Math.floor(z);
      const y = (ii: number, jj: number) => P[(jj * S + ii) * 3 + 1];
      // Evaluate the mesh's own triangle (diagonal from (i+1, j) to (i, j+1)).
      const h = fx + fz <= 1 ? y(i, j) + (y(i + 1, j) - y(i, j)) * fx + (y(i, j + 1) - y(i, j)) * fz : y(i + 1, j + 1) + (y(i, j + 1) - y(i + 1, j + 1)) * (1 - fx) + (y(i + 1, j) - y(i + 1, j + 1)) * (1 - fz);
      expect(h).toBe(wg.collisionHeight(atlas, x, z));
    }
  });

  it('fully morphed, a tile lies exactly on its parent lattice', async () => {
    const fine = await tile(30, 34, 1);
    const coarse = await tile(28, 32, 2); // the lod-2 tile containing it
    const C = coarse.c.heights;
    const oi = (30 - 28) * 64 / 4; // fine tile origin in coarse samples (4 m spacing)
    const oj = (34 - 32) * 64 / 4;
    const coarseAt = (x: number, z: number) => {
      // Collision-style interpolation on the coarse lattice (spacing 4 m).
      const u = (x - 28 * 64) / 4;
      const v = (z - 32 * 64) / 4;
      const i = Math.min(Math.floor(u), 63);
      const j = Math.min(Math.floor(v), 63);
      const fx = u - i;
      const fz = v - j;
      const h = (ii: number, jj: number) => C[jj * 65 + ii];
      return fx + fz <= 1 ? h(i, j) + (h(i + 1, j) - h(i, j)) * fx + (h(i, j + 1) - h(i, j)) * fz : h(i + 1, j + 1) + (h(i, j + 1) - h(i + 1, j + 1)) * (1 - fx) + (h(i + 1, j) - h(i + 1, j + 1)) * (1 - fz);
    };
    expect(oi).toBe(32);
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const v = j * S + i;
        const x = fine.mesh.position[v * 3];
        const z = fine.mesh.position[v * 3 + 2];
        expect(fine.mesh.morph[v]).toBeCloseTo(coarseAt(x, z), 4);
        if (i % 2 === 0 && j % 2 === 0) expect(fine.mesh.morph[v]).toBe(C[(oj + j / 2) * 65 + oi + i / 2]);
      }
    }
  });

  it('grid faces point up and skirts point outward', async () => {
    const { mesh } = await tile(30, 35, 0);
    const P = mesh.position;
    const idx = tileIndex();
    const v = (k: number) => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]];
    const normal = (t: number) => {
      const [a, b, c] = [v(idx[t * 3]), v(idx[t * 3 + 1]), v(idx[t * 3 + 2])];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    };
    for (let t = 0; t < CELLS * CELLS * 2; t++) expect(normal(t)[1]).toBeGreaterThan(0);
    const skirts = TILE_TRIS - CELLS * CELLS * 2;
    const out = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (let s = 0; s < skirts; s++) {
      const n = normal(CELLS * CELLS * 2 + s);
      // Skirt quads are emitted per step t in edge order west, east, north, south (2 triangles each).
      const [ox, oz] = out[Math.floor(s / 2) % 4];
      expect(n[0] * ox + n[2] * oz).toBeGreaterThan(0);
    }
  });

  it('a lake or river tile has a water surface with positive depth somewhere', async () => {
    const { wg, atlas } = await testWorld();
    // Find a chunk with water near the middle of the world.
    let found = false;
    for (let cz = 20; cz < 44 && !found; cz++) {
      for (let cx = 20; cx < 44 && !found; cx++) {
        const c = parseChunk(wg.buildChunkBytes(atlas, cx, cz, 0));
        if (!c.hasWater) continue;
        const m = buildTileMesh(c, (x, z) => wg.collisionHeight(atlas, x, z), '', atlas.data.seaY);
        expect(m.water).not.toBeNull();
        const vtx = m.water!.vertices;
        let wet = 0;
        for (let k = 3; k < vtx.length; k += 4) if (vtx[k] > 0) wet++;
        expect(wet).toBeGreaterThan(0);
        expect(vtx.every(Number.isFinite)).toBe(true);
        found = true;
      }
    }
    expect(found).toBe(true);
  });
});
