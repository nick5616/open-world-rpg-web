/// <reference lib="webworker" />
// Generation worker: one worldgen.wasm instance (instances are
// single-threaded, worldgen/README.md host rule 4) plus the atlas copied into
// its memory. Builds terrain tiles, scatter and grass, and keeps the
// IndexedDB mesh cache, all off the main thread. Results go back as
// transferred ArrayBuffers.

import { caveCellBytes, caveGraphBytes, fnv1a64, hex64, loadWorldgen, parseCaveGraph, parseChunk, type AtlasHandle, type CaveOpening, type Worldgen } from '@lodestone/worldgen';
import { holeIndex } from '../caves/holes';
import { buildTileMesh, tileBytes, tileTransferables, type TileMeshData } from '../terrain/tileMesh';
import { generateGrass } from '../scatter/grassGen';
import { evictMeshes, meshGet, meshKey, meshPut, worldDb } from './cacheDb';
import { SCATTER_STRIDE, type InitMsg, type JobMsg, type ResultMsg } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let wg: Worldgen | null = null;
let atlas: AtlasHandle | null = null;
let atlasHash = '';
let seaY = 0;
let useCache = false;
let db: IDBDatabase | null = null;

const post = (m: ResultMsg, transfer: Transferable[] = []) => self.postMessage(m, transfer);

/** Inverse of worldgen's SplitMix64 finalizer (rng.rs unmix64): recovers the packed (layer, a, b, index) tuple. */
function unmixLayer(z: bigint): number {
  const M = (1n << 64n) - 1n;
  z ^= (z >> 31n) ^ (z >> 62n);
  z = (z * 0x319642b2d24d8ec3n) & M;
  z ^= (z >> 27n) ^ (z >> 54n);
  z = (z * 0x96de1b173f119089n) & M;
  z ^= (z >> 30n) ^ (z >> 60n);
  return Number(z >> 56n);
}

async function init(m: InitMsg) {
  wg = await loadWorldgen(m.module);
  if (m.atlas) {
    atlas = wg.loadAtlas(m.atlas);
    atlasHash = m.atlasHash ?? hex64(atlas.hash);
    seaY = atlas.data.seaY;
  }
  useCache = m.meshCache;
  if (useCache) db = await worldDb();
  post({ type: 'ready', genVersion: wg.genVersion });
}

/** Cave openings for mouth holes, built on first use (the first cave call builds the world's cave graph, ~40 ms, once per worker). */
let openings: CaveOpening[] | null = null;
function caveOpenings(): CaveOpening[] {
  if (openings) return openings;
  try {
    openings = parseCaveGraph(caveGraphBytes(wg!, atlas!)).openings;
  } catch {
    openings = []; // a pre-WP09 wasm: no caves, no holes
  }
  return openings;
}

async function tileJob(id: number, cx: number, cz: number, lod: number) {
  const key = meshKey(atlasHash, wg!.genVersion, lod, cx, cz);
  if (db) {
    try {
      const hit = await meshGet<TileMeshData>(db, key);
      if (hit) {
        post({ type: 'tile', id, tile: hit, genMs: 0, meshMs: 0, cached: true }, tileTransferables(hit));
        return;
      }
    } catch {
      db = null; // a closed or upgraded connection: run uncached rather than fail
    }
  }
  const t0 = performance.now();
  const bytes = wg!.buildChunkBytes(atlas!, cx, cz, lod);
  const t1 = performance.now();
  const chunk = parseChunk(bytes);
  const hash = hex64(fnv1a64(bytes));
  // Heights just outside the tile (edge normals): the same lattice function,
  // evaluated at integer meters where collision_height returns the f32
  // lattice value itself.
  const tile = buildTileMesh(chunk, (x, z) => wg!.collisionHeight(atlas!, x, z), hash, seaY);
  // WP09: drop the triangles a cave mouth replaces (lod 0-1 tiles near a mouth).
  const holes = holeIndex(caveOpenings(), cx, cz, lod);
  if (holes) tile.holes = holes;
  const t2 = performance.now();
  if (db) {
    // Store before transferring (transfer detaches the buffers). The clone is
    // synchronous inside put(); the write completes in the background.
    meshPut(db, key, tile, tileBytes(tile)).catch(() => {});
  }
  post({ type: 'tile', id, tile, genMs: t1 - t0, meshMs: t2 - t1, cached: false }, tileTransferables(tile));
}

async function scatterJob(id: number, cx: number, cz: number) {
  const t0 = performance.now();
  const c = wg!.buildChunk(atlas!, cx, cz, 0);
  const n = c.scatter.count;
  const records = new Float32Array(n * SCATTER_STRIDE);
  const ids = new BigUint64Array(n);
  for (let i = 0; i < n; i++) {
    const id64 = c.scatter.id(i);
    ids[i] = id64;
    const o = i * SCATTER_STRIDE;
    records[o] = unmixLayer(id64);
    records[o + 1] = c.scatter.kind(i);
    records[o + 2] = c.scatter.variant(i);
    records[o + 3] = c.scatter.x(i);
    records[o + 4] = c.scatter.y(i);
    records[o + 5] = c.scatter.z(i);
    records[o + 6] = c.scatter.yaw(i);
    records[o + 7] = c.scatter.scale(i);
  }
  post({ type: 'scatter', id, scatter: { cx, cz, records, ids }, genMs: performance.now() - t0 }, [records.buffer, ids.buffer]);
}

function grassJob(id: number, cx: number, cz: number, density: number) {
  const t0 = performance.now();
  const c = wg!.buildChunk(atlas!, cx, cz, 0);
  const instances = generateGrass(c, density);
  post({ type: 'grass', id, grass: { cx, cz, instances }, genMs: performance.now() - t0 }, [instances.buffer]);
}

async function handle(m: JobMsg) {
  switch (m.type) {
    case 'atlas': {
      const t0 = performance.now();
      const a = wg!.buildAtlas(wg!.specFromSeed(BigInt(m.seed)));
      const bytes = a.bytes();
      const hash = hex64(a.hash);
      a.free();
      post({ type: 'atlas', id: m.id, bytes, hash, ms: performance.now() - t0 }, [bytes.buffer]);
      return;
    }
    case 'tile':
      return tileJob(m.id, m.cx, m.cz, m.lod);
    case 'scatter':
      return scatterJob(m.id, m.cx, m.cz);
    case 'grass':
      return grassJob(m.id, m.cx, m.cz, m.density);
    case 'hash': {
      const t0 = performance.now();
      const bytes = wg!.buildChunkBytes(atlas!, m.cx, m.cz, m.lod);
      post({ type: 'hash', id: m.id, hash: hex64(fnv1a64(bytes)), ms: performance.now() - t0 });
      return;
    }
    case 'cave': {
      const t0 = performance.now();
      const bytes = caveCellBytes(wg!, atlas!, m.cx, m.cy, m.cz, m.edits);
      post({ type: 'cave', id: m.id, cx: m.cx, cy: m.cy, cz: m.cz, bytes, genMs: performance.now() - t0 }, [bytes.buffer]);
      return;
    }
    case 'evict': {
      const r = db ? await evictMeshes(db, m.cap) : { bytes: 0, deleted: 0 };
      post({ type: 'evict', id: m.id, ...r });
      return;
    }
  }
}

self.onmessage = async (e: MessageEvent<InitMsg | JobMsg>) => {
  const m = e.data;
  try {
    if (m.type === 'init') await init(m);
    else await handle(m);
  } catch (err) {
    const id = m.type === 'init' ? -1 : m.id;
    post({ type: 'error', id, message: String((err as Error)?.stack ?? err) });
    // A trap leaves the wasm instance unusable (worldgen/README.md host rule 5).
    if (err instanceof WebAssembly.RuntimeError) self.close();
  }
};
