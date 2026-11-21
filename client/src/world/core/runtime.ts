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
import { wasmUrlFor } from './wasmFor';
import { ATLAS_STORE, cacheGet, cachePut, worldDb } from './cacheDb';
import { poolSize, WorkerPool, type WorkerLike } from './workerPool';
import type { InitMsg, ResultMsg } from './protocol';
import { WorldGround } from './ground';
// WP12: towers stand on the terrain as a structure overlay on the ground query
// (client/src/world/structures/README.md); prediction and the zone use the same.
import { StructureGround } from '../structures/overlay';
import { towersFromAtlas, type TowerSet } from '../structures/towers';
import { CaveGround } from '../caves/caveGround';
// WP20: buildings, bridges and structures as town collision boxes (client/src/world/buildings/README.md).
import { parseTowns, TownCollision, type Towns } from '@lodestone/worldgen';
import { appendPalaceBoxes, palaceColumns, palaceSites } from '../palace/palaceSites';
import { TownGround } from '../buildings/townGround';
// Playtest: building doors that open and close (client/src/world/buildings/README.md "Doors").
import { DoorStates, TownDoors } from '@lodestone/worldgen';
import { DoorGround } from '../buildings/doorGround';
import type { TownsResult } from '../buildings/towns.worker';
import { CaveCellStore } from '../caves/caveStore';
// CR 038: the vertical world (sky islands, the Underground, the Depths) over and under the caves.
import { hasVertical, parseVertical, verticalBytes, type VerticalWorld } from '@lodestone/worldgen';
import { VerticalGround, VerticalTileStore } from '../vertical/verticalGround';
import { setVerticalUpdrafts } from '../../sim/stepEnv';
import { VerticalWind } from '../../sim/verticalWind';
import type { GroundQuery } from '../../sim/ground';
// WP15: ice sheets and earth pillars on top (client/src/systems/chem/ground.ts; pass-through when there are none).
import { ChemGround } from '../../systems/chem/ground';
import { RiftGround } from '../../rift/riftGround';
// CR 025: solid camp pieces (chest, workbench, signpost) on top of the doors (ui/camps/collide.ts; pass-through without pieces).
import { CampGround } from '../../ui/camps/collide';

export interface LoadTimings {
  wasmMs: number;
  atlasMs: number;
  atlasSource: 'cache' | 'built';
  poolMs: number;
  totalMs: number;
  /** WP20: towns_build in its worker (overlaps the pool start). */
  townsMs?: number;
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
  /** WP09's cave ground (inCave, floors, walls) under the towns layer; null without caves. */
  readonly caveGround: CaveGround | null = null;
  /** CR 038: the vertical world (descriptor), its LOD 0 layer tiles (collision + rendering) and ground; null before genVersion 3. */
  readonly vertical: VerticalWorld | null = null;
  readonly verticalStore: VerticalTileStore | null = null;
  readonly verticalGround: VerticalGround | null = null;
  /** WP20: the world's towns layer (settlements, buildings, roads, structures, NPCs) and its collision. */
  readonly towns: Towns | null = null;
  readonly townCollision: TownCollision | null = null;
  /** Building doors (closable doorways) and their states; null without towns. */
  readonly doors: TownDoors | null = null;
  readonly doorStates: DoorStates | null = null;
  readonly data: AtlasData;
  readonly atlasHashHex: string;

  private constructor(
    readonly wg: Worldgen,
    readonly atlas: AtlasHandle,
    readonly pool: WorkerPool,
    readonly seed: string,
    readonly timings: LoadTimings,
    /** The generator this world runs on (archived builds for older genVersions: ./wasmFor). */
    readonly wasmUrl: string,
    townsBytes: Uint8Array | null = null,
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
      this.caveGround = new CaveGround(this.structureGround, this.caveGraph.openings, this.caveStore, this.terrainGround);
      ground = this.caveGround;
    } catch (err) {
      console.warn('[world] no caves (worldgen.wasm without cave exports?)', err);
    }
    // CR 038: sky islands over, the Underground and the Depths under (same core as the zone: server/pkg/vertical).
    if (hasVertical(wg)) {
      try {
        this.vertical = parseVertical(verticalBytes(wg, atlas));
        this.verticalStore = new VerticalTileStore(wg, atlas);
        this.verticalGround = new VerticalGround(ground, this.vertical, this.verticalStore);
        ground = this.verticalGround;
        // The wind columns and the free sky glide join every step's updraft (as the zone's night.go does).
        setVerticalUpdrafts(new VerticalWind(this.vertical, palaceColumns(palaceSites(this.vertical))));
      } catch (err) {
        console.warn('[world] no vertical world', err);
      }
    }
    // WP20: buildings on top (floors within a step, walls, ceilings), same core as the zone.
    if (townsBytes) {
      try {
        this.towns = parseTowns(townsBytes);
        appendPalaceBoxes(this.towns, palaceSites(this.vertical)); // CR 044: the sky palaces are buildings (the zone does the same)
        this.townCollision = new TownCollision(this.towns.boxes);
        ground = new TownGround(ground, this.townCollision);
        this.doors = new TownDoors(this.towns);
        this.doorStates = new DoorStates(this.doors.count);
        ground = new DoorGround(ground, this.doors, this.doorStates);
        ground = new CampGround(ground);
      } catch (err) {
        console.warn('[world] towns unavailable', err);
      }
    }
    this.ground = new ChemGround(new RiftGround(ground)); // CR 040: the arena while in a rift (rift/riftGround.ts)
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

  static async load(seed: string, opts: { meshCache: boolean; onStatus?: (s: string) => void; genVersion?: string }): Promise<WorldRuntime> {
    const t0 = performance.now();
    opts.onStatus?.('Loading generator');
    const wasmUrl = wasmUrlFor(opts.genVersion);
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
    const townsP = buildTownsInWorker(module, bytes);
    const pool = new WorkerPool(newWorker, poolSize(navigator.hardwareConcurrency));
    const init: InitMsg = { type: 'init', module, atlas: bytes, atlasHash: hex64(atlas.hash), meshCache: opts.meshCache && !!db };
    await pool.start(init);
    const t3 = performance.now();
    if (db && opts.meshCache) {
      // Keep the mesh cache under its cap; runs in a worker, at low priority.
      pool.submit('evict', { type: 'evict', cap: 500 * 1024 * 1024 }, 1e9).catch(() => {});
    }
    opts.onStatus?.('Raising towns');
    const towns = await townsP;
    const t4 = performance.now();
    return new WorldRuntime(wg, atlas, pool, seed, { wasmMs: t1 - t0, atlasMs: t2 - t1, atlasSource: source, poolMs: t3 - t2, totalMs: t4 - t0, townsMs: towns?.ms }, wasmUrl, towns?.bytes ?? null);
  }

  dispose(): void {
    if (this.vertical) setVerticalUpdrafts(null);
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

/** One-off worker: towns_build takes ~0.15-1 s; null (no towns, a warning) on failure or a pre-WP20 wasm. */
function buildTownsInWorker(module: WebAssembly.Module, atlas: Uint8Array): Promise<{ bytes: Uint8Array; ms: number } | null> {
  return new Promise((resolve) => {
    let w: Worker;
    try {
      w = new Worker(new URL('../buildings/towns.worker.ts', import.meta.url), { type: 'module', name: 'towns' });
    } catch (err) {
      console.warn('[world] towns worker unavailable', err);
      resolve(null);
      return;
    }
    w.onmessage = (e: MessageEvent<TownsResult>) => {
      w.terminate();
      if (e.data.ok) resolve({ bytes: e.data.bytes, ms: e.data.ms });
      else {
        console.warn('[world] towns_build failed', e.data.message);
        resolve(null);
      }
    };
    w.onerror = (e) => {
      console.warn('[world] towns worker error', e.message);
      w.terminate();
      resolve(null);
    };
    w.postMessage({ module, atlas });
  });
}
