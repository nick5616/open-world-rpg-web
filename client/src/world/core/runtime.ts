// WorldRuntime: everything the world needs before the first frame.
//
//  1. Fetch and compile worldgen.wasm once (content-hashed asset URL, so the
//     browser caches it forever), share the compiled Module with workers.
//  2. The atlas: from IndexedDB (key genVersion:seed, verified by hash), or
//     built in a worker (~0.4 s) and cached. Spec 5 lets a client regenerate
//     the atlas instead of downloading it; the bytes are identical (golden
//     tests). Solo has no server to download from, so it always regenerates.
//  3. A main-thread worldgen instance holding the atlas, for the ground query
//     (collision_height, ~2 us) and debug hash checks.
//  4. The worker pool, each worker with its own copy of the atlas.

import { caveGraphBytes, hex64, loadWorldgen, parseCaveGraph, type AtlasData, type AtlasHandle, type CaveGraph, type Worldgen } from '@lodestone/worldgen';
import wasmUrl from '../../../../worldgen/pkg/worldgen.wasm?url';
import { ATLAS_STORE, cacheGet, cachePut, worldDb } from './cacheDb';
import { poolSize, WorkerPool, type WorkerLike } from './workerPool';
import type { InitMsg, ResultMsg } from './protocol';
import { WorldGround } from './ground';
// WP12: towers stand on the terrain as a structure overlay on the ground query
// (client/src/world/structures/README.md); prediction and the zone use the same.
import { StructureGround } from '../structures/overlay';
import { towersFromAtlas, type TowerSet } from '../structures/towers';
import { CaveGround } from '../caves/caveGround';
import { CaveCellStore } from '../caves/caveStore';
import type { GroundQuery } from '../../sim/ground';

export interface LoadTimings {
  wasmMs: number;
  atlasMs: number;
  atlasSource: 'cache' | 'built';
  poolMs: number;
  totalMs: number;
}

const newWorker = (): WorkerLike => new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module', name: 'worldgen' }) as unknown as WorkerLike;

export class WorldRuntime {
  /** What movement walks and climbs: terrain + structures (towers), with caves under it (WP09) when the wasm has them. */
  readonly ground: GroundQuery;
  /** Terrain plus structures (WP12): the surface the caves sit under. */
  readonly structureGround: StructureGround;
  /** The bare terrain (collision_height), for things that must ignore structures. */
  readonly terrainGround: WorldGround;
  readonly towers: TowerSet;
  /** WP09: the cave graph (systems, openings, veins) and the cave cells shared by collision and rendering. */
  readonly caveGraph: CaveGraph | null = null;
  readonly caveStore: CaveCellStore | null = null;
  readonly data: AtlasData;
  readonly atlasHashHex: string;

  private constructor(
    readonly wg: Worldgen,
    readonly atlas: AtlasHandle,
    readonly pool: WorkerPool,
    readonly seed: string,
    readonly timings: LoadTimings,
  ) {
    this.data = atlas.data;
    this.atlasHashHex = hex64(atlas.hash);
    this.terrainGround = new WorldGround(wg, atlas);
    this.towers = towersFromAtlas(this.data, this.terrainGround);
    this.structureGround = new StructureGround(this.terrainGround, this.towers.overlay);
    // WP09: caves under the surface when the wasm has the cave exports (a
    // pre-WP09 build keeps the surface ground).
    let ground: GroundQuery = this.structureGround;
    try {
      this.caveGraph = parseCaveGraph(caveGraphBytes(wg, atlas));
      this.caveStore = new CaveCellStore(wg, atlas);
      ground = new CaveGround(this.structureGround, this.caveGraph.openings, this.caveStore);
    } catch (err) {
      console.warn('[world] no caves (worldgen.wasm without cave exports?)', err);
    }
    this.ground = ground;
  }

  get genVersion(): number {
    return this.wg.genVersion;
  }
  get seaY(): number {
    return this.data.seaY;
  }

  /** Spawn on land: the atlas spawn (best meadow/forest settlement near the middle, worldgen README). */
  spawnPoint(): { x: number; z: number } {
    return { x: this.data.spawn.x, z: this.data.spawn.z };
  }

  static async load(seed: string, opts: { meshCache: boolean; onStatus?: (s: string) => void }): Promise<WorldRuntime> {
    const t0 = performance.now();
    opts.onStatus?.('Loading generator');
    const [module, db] = await Promise.all([WebAssembly.compileStreaming(fetch(wasmUrl)).catch(async () => WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer())), worldDb()]);
    const wg = await loadWorldgen(module);
    const t1 = performance.now();

    opts.onStatus?.('Shaping the world');
    const key = `${wg.genVersion}:${seed}`;
    let bytes: Uint8Array | null = null;
    let source: LoadTimings['atlasSource'] = 'cache';
    if (db) {
      const rec = await cacheGet<{ key: string; hash: string; bytes: Uint8Array }>(db, ATLAS_STORE, key).catch(() => undefined);
      // Verify the cached bytes by hash: a truncated write must never become the world.
      if (rec && hex64(wg.hash(rec.bytes)) === rec.hash) bytes = rec.bytes;
    }
    if (!bytes) {
      source = 'built';
      const built = await buildAtlasInWorker(module, seed);
      bytes = built.bytes;
      if (db) cachePut(db, ATLAS_STORE, { key, hash: built.hash, bytes }).catch(() => {});
    }
    const atlas = wg.loadAtlas(bytes);
    const t2 = performance.now();

    opts.onStatus?.('Starting workers');
    const pool = new WorkerPool(newWorker, poolSize(navigator.hardwareConcurrency));
    const init: InitMsg = { type: 'init', module, atlas: bytes, atlasHash: hex64(atlas.hash), meshCache: opts.meshCache && !!db };
    await pool.start(init);
    const t3 = performance.now();
    if (db && opts.meshCache) {
      // Keep the mesh cache under its cap; runs in a worker, at low priority.
      pool.submit('evict', { type: 'evict', cap: 500 * 1024 * 1024 }, 1e9).catch(() => {});
    }
    return new WorldRuntime(wg, atlas, pool, seed, { wasmMs: t1 - t0, atlasMs: t2 - t1, atlasSource: source, poolMs: t3 - t2, totalMs: t3 - t0 });
  }

  dispose(): void {
    this.pool.terminate();
    this.atlas.free();
  }
}

/** One-off worker: building the atlas takes ~0.4 s, too long for the main thread. */
function buildAtlasInWorker(module: WebAssembly.Module, seed: string): Promise<{ bytes: Uint8Array; hash: string }> {
  return new Promise((resolve, reject) => {
    const w = newWorker();
    w.onmessage = (e: MessageEvent<ResultMsg>) => {
      const m = e.data;
      if (m.type === 'ready') w.postMessage({ type: 'atlas', id: 1, seed });
      else if (m.type === 'atlas') {
        w.terminate();
        resolve({ bytes: m.bytes, hash: m.hash });
      } else if (m.type === 'error') {
        w.terminate();
        reject(new Error(m.message));
      }
    };
    w.onerror = (e) => reject(new Error(e.message));
    w.postMessage({ type: 'init', module, meshCache: false } satisfies InitMsg);
  });
}
