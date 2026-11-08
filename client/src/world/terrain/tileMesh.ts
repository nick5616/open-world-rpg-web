// Builds a terrain tile's vertex buffers from a worldgen chunk buffer. Runs in
// the generation workers (pure TS, no three.js), so the main thread only
// wraps transferred ArrayBuffers in BufferAttributes.
//
// Geometry contract (worldgen/README.md "Collision"): each lattice cell is
// split along the diagonal from (i+1, j) to (i, j+1), the same diagonal the
// wasm collision_height uses, so a lod-0 tile *is* the collision surface:
// feet never float or sink near the player.
//
// Geomorphing: every vertex also carries the height and normal it would have
// on the next-coarser lattice (2x spacing). The shader blends toward them by
// a per-tile factor, so a tile that just replaced its parent can start out
// looking exactly like the parent and ease into its own shape (no pop), and
// an edge next to a coarser tile can sit exactly on the coarser tile's edge
// (no crack). Odd vertices take the coarse value by interpolating along the
// coarse cell's edge or diagonal (the same diagonal), i.e. the fully morphed
// fine mesh is exactly the coarse mesh.
//
// Skirts: one extra ring of vertices per edge dropped below the surface.
// Edge stitching makes seams exact in steady state; skirts cover the brief
// moments where it can't (a neighbour two levels coarser while a tile is
// still loading, or two neighbours animating out of step).

import type { ChunkData } from '@lodestone/worldgen';

export const S = 65; // samples per edge
export const CELLS = S - 1;
export const GRID_VERTS = S * S; // 4225
export const SKIRT_VERTS = 4 * S;
export const TILE_VERTS = GRID_VERTS + SKIRT_VERTS; // 4485
/** Grid + skirt triangles per tile. */
export const TILE_TRIS = CELLS * CELLS * 2 + 4 * CELLS * 2; // 8704

// Skirt vertex blocks, in this order after the grid.
const SK_W = GRID_VERTS;
const SK_E = SK_W + S;
const SK_N = SK_E + S;
const SK_S = SK_N + S;

/** Biome ids (worldgen BIOMES order). */
const FOREST = 1;
const HIGHLANDS = 2;
const SNOWPEAK = 3;
const BADLANDS = 4;
const WETLAND = 5;

export interface WaterMeshData {
  /** x, y (water surface), z, depth (surface minus ground; <= 0 means under the bank) per vertex. */
  vertices: Float32Array;
  index: Uint32Array;
}

export interface TileMeshData {
  cx: number;
  cz: number;
  lod: number;
  minY: number;
  maxY: number;
  /** World-space x, y, z (y = this lattice). Absolute coordinates: f32 keeps ~1 mm at 8 km. */
  position: Float32Array;
  /** Height on the next-coarser lattice. */
  morph: Float32Array;
  /** Normal (xyz, w unused), snorm8. */
  normal: Int8Array;
  /** Coarse-lattice normal, snorm8. */
  normalC: Int8Array;
  /** grass, dirt, rock, snow weights (unorm8). */
  splatA: Uint8Array;
  /** sand, mud, moisture, highlands. */
  splatB: Uint8Array;
  /** forest, badlands, wetland, snowpeak (one-hot per sample; interpolates into soft biome borders). */
  biome: Uint8Array;
  water: WaterMeshData | null;
  /** FNV-1a 64 of the source chunk buffer (hex): the debug tool compares regenerations against it. */
  chunkHash: string;
}

/** Heights outside the tile (for edge normals), in world meters. Must be the same height function. */
export type OutsideHeight = (x: number, z: number) => number;

const packN = (out: Int8Array, o: number, nx: number, ny: number, nz: number) => {
  const l = Math.hypot(nx, ny, nz);
  out[o] = Math.round((nx / l) * 127);
  out[o + 1] = Math.round((ny / l) * 127);
  out[o + 2] = Math.round((nz / l) * 127);
  out[o + 3] = 0;
};

/** Skirt depth: deep enough to hide any seam at this level's spacing. */
export const skirtDepth = (step: number): number => 2 + step * 3;

export function buildTileMesh(c: ChunkData, outside: OutsideHeight, chunkHash: string, seaY: number): TileMeshData {
  const step = c.step;
  const x0 = c.cx * 64;
  const z0 = c.cz * 64;
  const H = c.heights;
  // Height at lattice (i, j), reaching outside the tile through `outside`.
  const h = (i: number, j: number): number => (i >= 0 && j >= 0 && i < S && j < S ? H[j * S + i] : Math.fround(outside(x0 + i * step, z0 + j * step)));

  const position = new Float32Array(TILE_VERTS * 3);
  const morph = new Float32Array(TILE_VERTS);
  const normal = new Int8Array(TILE_VERTS * 4);
  const normalC = new Int8Array(TILE_VERTS * 4);
  const splatA = new Uint8Array(TILE_VERTS * 4);
  const splatB = new Uint8Array(TILE_VERTS * 4);
  const biome = new Uint8Array(TILE_VERTS * 4);

  // Coarse normals at even vertices (spacing 2 * step), interpolated at odd ones below.
  const cn = new Float32Array(S * S * 3);
  for (let j = 0; j < S; j += 2) {
    for (let i = 0; i < S; i += 2) {
      const o = (j * S + i) * 3;
      cn[o] = -(h(i + 2, j) - h(i - 2, j)) / (4 * step);
      cn[o + 1] = 1;
      cn[o + 2] = -(h(i, j + 2) - h(i, j - 2)) / (4 * step);
    }
  }
  const coarse = (i: number, j: number, k: number): number => {
    // Same rule for heights (k = -1) and coarse-normal components (k = 0..2).
    const v = (ii: number, jj: number) => (k < 0 ? h(ii, jj) : cn[(jj * S + ii) * 3 + k]);
    const io = i & 1;
    const jo = j & 1;
    if (!io && !jo) return v(i, j);
    if (io && !jo) return (v(i - 1, j) + v(i + 1, j)) * 0.5;
    if (!io && jo) return (v(i, j - 1) + v(i, j + 1)) * 0.5;
    return (v(i + 1, j - 1) + v(i - 1, j + 1)) * 0.5; // on the (i+1, j)-(i, j+1) diagonal
  };

  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const v = j * S + i;
      const y = H[v];
      position[v * 3] = x0 + i * step;
      position[v * 3 + 1] = y;
      position[v * 3 + 2] = z0 + j * step;
      morph[v] = coarse(i, j, -1);
      packN(normal, v * 4, -(h(i + 1, j) - h(i - 1, j)) / (2 * step), 1, -(h(i, j + 1) - h(i, j - 1)) / (2 * step));
      packN(normalC, v * 4, coarse(i, j, 0), coarse(i, j, 1), coarse(i, j, 2));
      const a = v * 4;
      splatA[a] = c.splatA[a];
      splatA[a + 1] = c.splatA[a + 1];
      splatA[a + 2] = c.splatA[a + 2];
      splatA[a + 3] = c.splatA[a + 3];
      const b = c.splatB[a + 2];
      splatB[a] = c.splatB[a];
      splatB[a + 1] = c.splatB[a + 1];
      splatB[a + 2] = c.splatB[a + 3]; // moisture
      splatB[a + 3] = b === HIGHLANDS ? 255 : 0;
      biome[a] = b === FOREST ? 255 : 0;
      biome[a + 1] = b === BADLANDS ? 255 : 0;
      biome[a + 2] = b === WETLAND ? 255 : 0;
      biome[a + 3] = b === SNOWPEAK ? 255 : 0;
    }
  }

  // Skirts copy their edge vertex (attributes, normal) and drop it.
  const depth = skirtDepth(step);
  const copy = (dst: number, src: number) => {
    position[dst * 3] = position[src * 3];
    position[dst * 3 + 1] = position[src * 3 + 1] - depth;
    position[dst * 3 + 2] = position[src * 3 + 2];
    morph[dst] = morph[src] - depth;
    for (let k = 0; k < 4; k++) {
      normal[dst * 4 + k] = normal[src * 4 + k];
      normalC[dst * 4 + k] = normalC[src * 4 + k];
      splatA[dst * 4 + k] = splatA[src * 4 + k];
      splatB[dst * 4 + k] = splatB[src * 4 + k];
      biome[dst * 4 + k] = biome[src * 4 + k];
    }
  };
  for (let t = 0; t < S; t++) {
    copy(SK_W + t, t * S); // i = 0, j = t
    copy(SK_E + t, t * S + CELLS); // i = 64
    copy(SK_N + t, t); // j = 0, i = t
    copy(SK_S + t, CELLS * S + t); // j = 64
  }

  return {
    cx: c.cx,
    cz: c.cz,
    lod: c.lod,
    minY: c.minHeight - depth,
    maxY: c.maxHeight,
    position,
    morph,
    normal,
    normalC,
    splatA,
    splatB,
    biome,
    water: c.hasWater ? buildWaterMesh(c, seaY) : null,
    chunkHash,
  };
}

/**
 * Water surface inside a tile: lakes, rivers and the sea alike, so the depth
 * attribute (surface minus ground, per vertex) gives exact shoreline fades;
 * the global sea plane only draws where no tile is loaded. A cell is kept if
 * any corner has water above the ground. Dry corners take the highest
 * neighbouring water level instead of the buffer's "sea level under dry
 * land", so a river surface runs flat into its bank (hidden under it)
 * instead of diving down to sea level at every shoreline.
 *
 * Water is flat, so it is meshed coarser than the ground (2 samples per cell
 * on lod 0, 4 beyond): a quarter / a sixteenth of the triangles. Open sea
 * tiles were otherwise ~8k triangles each for a plane.
 */
export function buildWaterMesh(c: ChunkData, _seaY: number): WaterMeshData | null {
  const K = c.lod === 0 ? 2 : 4;
  const step = c.step;
  const x0 = c.cx * 64;
  const z0 = c.cz * 64;
  const W = c.water;
  const G = c.heights;
  const inland = (v: number) => W[v] > G[v];
  const level = new Float32Array(S * S);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const v = j * S + i;
      if (inland(v)) {
        level[v] = W[v];
        continue;
      }
      let best = -Infinity;
      for (let dj = -K; dj <= K; dj++) {
        for (let di = -K; di <= K; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= S || jj >= S) continue;
          const n = jj * S + ii;
          if (inland(n)) best = Math.max(best, W[n]);
        }
      }
      level[v] = best === -Infinity ? W[v] : best;
    }
  }
  const remap = new Int32Array(S * S).fill(-1);
  const verts: number[] = [];
  const idx: number[] = [];
  const vert = (i: number, j: number) => {
    const v = j * S + i;
    if (remap[v] < 0) {
      remap[v] = verts.length / 4;
      verts.push(x0 + i * step, level[v], z0 + j * step, level[v] - G[v]);
    }
    return remap[v];
  };
  for (let j = 0; j < CELLS; j += K) {
    for (let i = 0; i < CELLS; i += K) {
      let wet = false;
      for (let jj = j; jj <= j + K && !wet; jj++) for (let ii = i; ii <= i + K && !wet; ii++) wet = inland(jj * S + ii);
      if (!wet) continue;
      const va = vert(i, j);
      const vb = vert(i + K, j);
      const vc = vert(i, j + K);
      const vd = vert(i + K, j + K);
      idx.push(va, vc, vb, vb, vc, vd);
    }
  }
  if (!idx.length) return null;
  return { vertices: new Float32Array(verts), index: new Uint32Array(idx) };
}

let sharedIndex: Uint16Array | null = null;
let sharedGrid: Uint8Array | null = null;

/**
 * Triangle indices shared by every tile (same topology): grid cells split on
 * the collision diagonal, counter-clockwise seen from above, then outward
 * facing skirt quads.
 */
export function tileIndex(): Uint16Array {
  if (sharedIndex) return sharedIndex;
  const out = new Uint16Array(TILE_TRIS * 3);
  let o = 0;
  for (let j = 0; j < CELLS; j++) {
    for (let i = 0; i < CELLS; i++) {
      const a = j * S + i;
      const b = a + 1;
      const c = a + S;
      const d = c + 1;
      out.set([a, c, b, b, c, d], o);
      o += 6;
    }
  }
  // quad(t0, t1, s0, s1): surface edge t0 -> t1, skirt copies s0, s1 below.
  // Front faces must point away from the tile; the order per edge below was
  // chosen so (s0 - t0) x (t1 - t0) is outward (checked in tileMesh.test.ts).
  const quad = (t0: number, t1: number, s0: number, s1: number) => {
    out.set([t0, s0, t1, t1, s0, s1], o);
    o += 6;
  };
  for (let t = 0; t < CELLS; t++) {
    quad(t * S, (t + 1) * S, SK_W + t, SK_W + t + 1); // west: +z along the edge
    quad((t + 1) * S + CELLS, t * S + CELLS, SK_E + t + 1, SK_E + t); // east: -z
    quad(t + 1, t, SK_N + t + 1, SK_N + t); // north: -x
    quad(CELLS * S + t, CELLS * S + t + 1, SK_S + t, SK_S + t + 1); // south: +x
  }
  sharedIndex = out;
  return out;
}

/** (i, j) lattice coordinates per vertex, shared by every tile; skirts repeat their edge vertex. */
export function tileGrid(): Uint8Array {
  if (sharedGrid) return sharedGrid;
  const g = new Uint8Array(TILE_VERTS * 2);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      g[(j * S + i) * 2] = i;
      g[(j * S + i) * 2 + 1] = j;
    }
  }
  for (let t = 0; t < S; t++) {
    g.set([0, t], (SK_W + t) * 2);
    g.set([CELLS, t], (SK_E + t) * 2);
    g.set([t, 0], (SK_N + t) * 2);
    g.set([t, CELLS], (SK_S + t) * 2);
  }
  sharedGrid = g;
  return g;
}

/** Transferable buffers of a tile (worker -> main thread). */
export function tileTransferables(t: TileMeshData): ArrayBuffer[] {
  const out = [t.position, t.morph, t.normal, t.normalC, t.splatA, t.splatB, t.biome].map((a) => a.buffer as ArrayBuffer);
  if (t.water) out.push(t.water.vertices.buffer as ArrayBuffer, t.water.index.buffer as ArrayBuffer);
  return out;
}

/** Bytes of GPU vertex data for one tile (for memory accounting). */
export const tileBytes = (t: TileMeshData): number =>
  t.position.byteLength + t.morph.byteLength + t.normal.byteLength + t.normalC.byteLength + t.splatA.byteLength + t.splatB.byteLength + t.biome.byteLength + (t.water ? t.water.vertices.byteLength + t.water.index.byteLength : 0);
