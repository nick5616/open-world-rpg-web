/// <reference lib="webworker" />
// Runs the golden table and the detail-chunk benchmark inside a Web Worker.
import { loadWorldgen } from '../../js/src/index';
import { benchmarkChunks, runGolden, stats, type GoldenFile } from '../../js/src/golden';
import { benchmarkCaves } from '../../js/src/caveGolden';

self.onmessage = async (e: MessageEvent<{ bench: number }>) => {
  try {
    const [wasm, golden] = await Promise.all([
      fetch('/pkg/worldgen.wasm').then((r) => r.arrayBuffer()),
      fetch('/golden/golden.json').then((r) => r.json() as Promise<GoldenFile>),
    ]);
    const wg = await loadWorldgen(wasm);
    const now = () => performance.now();
    const golden_ = runGolden(wg, golden, now, navigator.userAgent);
    const bench = benchmarkChunks(wg, golden.worlds[0].spec, e.data.bench, now);
    // WP09: cave cell budget (spec 5: <= 12 ms in a worker), fresh instance so
    // the one-time cave graph build is measured too.
    const wg2 = await loadWorldgen(wasm);
    const caveAtlas = wg2.buildAtlas(golden.worlds[0].spec);
    const cb = benchmarkCaves(wg2, caveAtlas, now);
    caveAtlas.free();
    self.postMessage({
      host: 'chromium-worker',
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      crossOriginIsolated: self.crossOriginIsolated,
      worlds: golden_.worlds,
      chunks: golden_.chunks,
      collisions: golden_.collisions,
      failures: golden_.failures,
      atlasMs: golden_.atlasMs,
      goldenChunkMs: stats(golden_.chunkMs),
      bench,
      caveCells: golden_.caveCells,
      caveQueries: golden_.caveQueries,
      goldenCaveMs: stats(golden_.caveMs),
      caveBench: { graphMs: cb.graphMs, cells: cb.cells, withMesh: cb.withMesh, ms: stats(cb.ms) },
    });
  } catch (err) {
    self.postMessage({ error: String((err as Error)?.stack ?? err) });
  }
};
