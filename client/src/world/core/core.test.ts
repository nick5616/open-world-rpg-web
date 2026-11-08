import { describe, expect, it } from 'vitest';
import { poolSize, WorkerPool, type WorkerLike } from './workerPool';
import { lruVictims, meshKey } from './cacheDb';
import type { JobMsg, ResultMsg } from './protocol';
import { WorldGround } from './ground';
import { hasWasm, rand, testWorld } from '../testing/wasm';
import { chunkSurfaceHeight, parseChunk } from '@lodestone/worldgen';

/** A fake worker that records jobs and answers when told to. */
class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  jobs: JobMsg[] = [];
  postMessage(msg: unknown): void {
    const m = msg as { type: string };
    if (m.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready', genVersion: 1 } } as MessageEvent));
    else this.jobs.push(msg as JobMsg);
  }
  finish(): void {
    const j = this.jobs.shift()!;
    const r: ResultMsg = { type: 'hash', id: j.id, hash: `h${j.id}`, ms: 1 };
    this.onmessage?.({ data: r } as MessageEvent);
  }
  terminate(): void {}
}

async function pool(n: number) {
  const workers: FakeWorker[] = [];
  const p = new WorkerPool(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  }, n);
  await p.start({ type: 'init', module: {} as WebAssembly.Module, meshCache: false });
  return { p, workers };
}

describe('poolSize', () => {
  it('is min(hardwareConcurrency - 2, 4), at least 1', () => {
    expect(poolSize(16)).toBe(4);
    expect(poolSize(6)).toBe(4);
    expect(poolSize(4)).toBe(2);
    expect(poolSize(2)).toBe(1);
    expect(poolSize(undefined)).toBe(2);
  });
});

describe('WorkerPool', () => {
  it('runs the most urgent job first and dedupes by key', async () => {
    const { p, workers } = await pool(1);
    const w = workers[0];
    const first = p.submit('a', { type: 'hash', cx: 0, cz: 0, lod: 0 }, 5); // dispatched at once (idle worker)
    p.submit('b', { type: 'hash', cx: 1, cz: 0, lod: 0 }, 50);
    p.submit('c', { type: 'hash', cx: 2, cz: 0, lod: 0 }, 10);
    const again = p.submit('b', { type: 'hash', cx: 1, cz: 0, lod: 0 }, 1); // re-prioritised, same promise
    expect(p.queued).toBe(2);
    w.finish();
    expect((await first)?.type).toBe('hash');
    // 'b' was bumped to priority 1, so it beats 'c'.
    expect((w.jobs[0] as { cx: number }).cx).toBe(1);
    w.finish();
    expect(await again).toMatchObject({ type: 'hash' });
    w.finish();
    expect(p.queued).toBe(0);
    expect(p.done.hash.n).toBe(3);
  });

  it('cancels queued work (resolves null) but not jobs in flight', async () => {
    const { p, workers } = await pool(1);
    const a = p.submit('a', { type: 'hash', cx: 0, cz: 0, lod: 0 }, 1);
    const b = p.submit('b', { type: 'hash', cx: 1, cz: 0, lod: 0 }, 2);
    const c = p.submit('c', { type: 'hash', cx: 2, cz: 0, lod: 0 }, 3);
    p.cancel('a'); // in flight: ignored
    expect(p.retain((k) => k !== 'b')).toBe(1);
    expect(await b).toBeNull();
    workers[0].finish();
    expect(await a).not.toBeNull();
    workers[0].finish();
    expect(await c).not.toBeNull();
  });

  it('keeps every worker busy', async () => {
    const { p, workers } = await pool(3);
    for (let i = 0; i < 5; i++) p.submit(`k${i}`, { type: 'hash', cx: i, cz: 0, lod: 0 }, i);
    expect(workers.map((w) => w.jobs.length)).toEqual([1, 1, 1]);
    expect(p.inFlight).toBe(3);
    expect(p.queued).toBe(2);
  });
});

describe('mesh cache LRU', () => {
  it('evicts oldest first until under the cap', () => {
    const rows = [
      { key: 'a', t: 3, bytes: 100 },
      { key: 'b', t: 1, bytes: 100 },
      { key: 'c', t: 2, bytes: 100 },
    ];
    expect(lruVictims(rows, 300)).toEqual([]);
    expect(lruVictims(rows, 250)).toEqual(['b']);
    expect(lruVictims(rows, 100)).toEqual(['b', 'c']);
  });
  it('keys include world, genVersion, format, lod and chunk', () => {
    expect(meshKey('abc', 1, 2, -3, 4)).toMatch(/^abc:1:\d+:2:-3:4$/);
  });
});

describe.skipIf(!hasWasm)('WorldGround', () => {
  it('is the wasm collision_height, bit for bit, and matches chunk surfaces', async () => {
    const { wg, atlas } = await testWorld();
    const g = new WorldGround(wg, atlas);
    const r = rand(42);
    const chunk = parseChunk(wg.buildChunkBytes(atlas, 30, 35, 0));
    for (let i = 0; i < 2000; i++) {
      const x = 30 * 64 + r() * 64;
      const z = 35 * 64 + r() * 64;
      const h = g.heightAt(x, z);
      expect(h).toBe(wg.collisionHeight(atlas, x, z));
      expect(h).toBe(chunkSurfaceHeight(chunk, x, z));
    }
    // Far outside the domain it clamps instead of returning -1e9.
    expect(g.heightAt(-1e6, 5e6)).toBeGreaterThan(-1000);
    const n = g.normalAt(1920, 2272);
    expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 6);
  });

  it('spawns the solo player on land', async () => {
    const { wg, atlas } = await testWorld();
    const s = atlas.data.spawn;
    expect(wg.collisionHeight(atlas, s.x, s.z)).toBeGreaterThan(atlas.data.seaY + 1);
  });
});
