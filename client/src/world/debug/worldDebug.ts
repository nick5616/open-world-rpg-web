// World debug state and the `window.__lodestoneWorld` handle (debug builds),
// used by the debug panel, the HUD and the traversal benchmark
// (bench/traversal.mjs). Kept apart from WP02's devHandle.ts so the two
// packages never edit the same file.

import { fnv1a64, hex64 } from '@lodestone/worldgen';
import type { WorldRuntime } from '../core/runtime';
import type { TerrainManager } from '../terrain/terrainManager';
import type { ScatterManager } from '../scatter/scatterManager';
import { tileKey } from '../terrain/quadtree';
import { localPlayer } from '../../state/live';
import { DEBUG } from '../../config';

/** renderer.info for the whole last frame (shadow passes + scene + post). */
export const frameInfo = { calls: 0, triangles: 0, geometries: 0, textures: 0, shadowCalls: 0, shadowTris: 0 };

export interface RegenResult {
  chunk: string;
  /** Hash of the chunk buffer the loaded mesh was built from (or null if that tile isn't loaded). */
  stored: string | null;
  /** Fresh build in a generation worker. */
  worker: string;
  /** Fresh build on the main thread's own wasm instance. */
  main: string;
  match: boolean;
  workerMs: number;
}

const percentile = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

class WorldDebug {
  runtime: WorldRuntime | null = null;
  terrain: TerrainManager | null = null;
  scatter: ScatterManager | null = null;
  textureBytes = 0;
  textureMs = 0;
  /** ms from page start to the first frame with the ground under the player drawn. */
  firstPlayableMs: number | null = null;

  attach(r: WorldRuntime, t: TerrainManager, s: ScatterManager) {
    this.runtime = r;
    this.terrain = t;
    this.scatter = s;
    if (DEBUG && typeof window !== 'undefined') (window as unknown as { __lodestoneWorld: unknown }).__lodestoneWorld = handle;
  }
  detach() {
    this.runtime = this.terrain = this.scatter = null;
  }

  /** Regenerate the chunk under the player (lod 0) and compare hashes (spec 14 dev tool). */
  async regenerateCurrentChunk(): Promise<RegenResult | null> {
    const r = this.runtime;
    if (!r) return null;
    const cx = Math.floor(localPlayer.pos.x / 64);
    const cz = Math.floor(localPlayer.pos.z / 64);
    const key = tileKey(cx, cz, 0);
    const stored = this.terrain?.chunkHashOf(key) ?? null;
    const res = await r.pool.submit(`hash:${key}:${performance.now()}`, { type: 'hash', cx, cz, lod: 0 }, -1);
    if (!res || res.type !== 'hash') throw new Error('hash job failed');
    const main = hex64(fnv1a64(r.wg.buildChunkBytes(r.atlas, cx, cz, 0)));
    return { chunk: `(${cx}, ${cz}) lod 0`, stored, worker: res.hash, main, match: res.hash === main && (stored === null || stored === main), workerMs: res.ms };
  }

  stats() {
    const t = this.terrain?.stats;
    const s = this.scatter?.stats;
    const pool = this.runtime?.pool;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    return {
      frame: { ...frameInfo },
      terrain: t && {
        queued: t.queued,
        inFlight: t.inFlight,
        loaded: t.loaded,
        drawn: t.drawn,
        drawnTris: t.drawnTris,
        wanted: t.wanted,
        missingWanted: t.missingWanted,
        cacheHits: t.cacheHits,
        built: t.genMs.length,
        genMs: { mean: t.genMs.reduce((a, b) => a + b, 0) / Math.max(1, t.genMs.length), p95: percentile(t.genMs, 95), max: Math.max(0, ...t.genMs) },
        meshMs: { mean: t.meshMs.reduce((a, b) => a + b, 0) / Math.max(1, t.meshMs.length), p95: percentile(t.meshMs, 95), max: Math.max(0, ...t.meshMs) },
        uploadMsMax: t.uploadMsMax,
        prof: { ...t.prof },
        gpuBytes: this.terrain?.gpuBytes() ?? 0,
      },
      scatter: s && { chunks: s.chunks, instances: s.instances, grassClumps: s.grassClumps, tris: s.tris, rebinMs: s.rebinMs, genMs: { mean: s.genMs.reduce((a, b) => a + b, 0) / Math.max(1, s.genMs.length), p95: percentile(s.genMs, 95), max: Math.max(0, ...s.genMs) } },
      pool: pool && { size: pool.size, done: pool.done },
      load: this.runtime?.timings,
      textures: { bytes: this.textureBytes, ms: this.textureMs },
      firstPlayableMs: this.firstPlayableMs,
      heap: mem ? { used: mem.usedJSHeapSize, total: mem.totalJSHeapSize } : null,
      seed: this.runtime?.seed,
      atlasHash: this.runtime?.atlasHashHex,
      spawn: this.runtime?.spawnPoint(),
    };
  }

  /** Clear the stats windows (the benchmark resets between phases). */
  resetStats() {
    if (this.terrain) {
      this.terrain.stats.genMs.length = 0;
      this.terrain.stats.meshMs.length = 0;
      this.terrain.stats.uploadMsMax = 0;
    }
    if (this.scatter) this.scatter.stats.genMs.length = 0;
  }
}

export const worldDebug = new WorldDebug();

const handle = {
  stats: () => worldDebug.stats(),
  resetStats: () => worldDebug.resetStats(),
  regenerateCurrentChunk: () => worldDebug.regenerateCurrentChunk(),
  groundAt: (x: number, z: number) => worldDebug.runtime?.ground.heightAt(x, z) ?? null,
  sites: () => worldDebug.runtime?.data.sites.map((s) => ({ kind: s.kind, category: s.category, biome: s.biome, x: s.x, y: s.y, z: s.z, radius: s.radius, name: s.name })) ?? [],
  /** Centre of the largest uniform patch of a biome on land (benchmark beauty shots). */
  biomeSpot: (biome: number) => {
    const d = worldDebug.runtime?.data;
    if (!d) return null;
    const N = d.gridN;
    let best = -1;
    let at = { x: 0, z: 0 };
    for (let j = 6; j < N - 6; j++) {
      for (let i = 6; i < N - 6; i++) {
        if (d.biome[j * N + i] !== biome || d.height[j * N + i] < d.seaY + 6) continue;
        let n = 0;
        for (let dj = -5; dj <= 5; dj++) for (let di = -5; di <= 5; di++) if (d.biome[(j + dj) * N + i + di] === biome && d.height[(j + dj) * N + i + di] > d.seaY + 2) n++;
        if (n > best) {
          best = n;
          at = { x: i * d.macroRes, z: j * d.macroRes };
        }
      }
    }
    return at;
  },
  biomeAt: (x: number, z: number) => {
    const d = worldDebug.runtime?.data;
    if (!d) return null;
    const i = Math.max(0, Math.min(d.gridN - 1, Math.round(x / d.macroRes)));
    const j = Math.max(0, Math.min(d.gridN - 1, Math.round(z / d.macroRes)));
    return d.biome[j * d.gridN + i];
  },
};
