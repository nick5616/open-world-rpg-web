/// <reference lib="webworker" />
// Runs the golden table and the detail-chunk benchmark inside a Web Worker.
import { loadWorldgen } from '../../js/src/index';
import { benchmarkChunks, runGolden, stats, type GoldenFile } from '../../js/src/golden';

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
    });
  } catch (err) {
    self.postMessage({ error: String((err as Error)?.stack ?? err) });
  }
};
