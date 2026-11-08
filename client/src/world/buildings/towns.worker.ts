/// <reference lib="webworker" />
// One-off towns worker (WP20): builds the world's towns buffer with its own
// worldgen instance while the world loads (towns_build takes ~0.15-1 s in
// wasm, too long for the main thread), then exits. The bytes are a pure
// function of the atlas, so every client builds the same layer the zone
// does (golden tests).

import { loadWorldgen, townsBytes } from '@lodestone/worldgen';

declare const self: DedicatedWorkerGlobalScope;

export interface TownsJob {
  module: WebAssembly.Module;
  atlas: Uint8Array;
}

export type TownsResult = { ok: true; bytes: Uint8Array; ms: number } | { ok: false; message: string };

self.onmessage = async (e: MessageEvent<TownsJob>) => {
  try {
    const wg = await loadWorldgen(e.data.module);
    const atlas = wg.loadAtlas(e.data.atlas);
    const t0 = performance.now();
    const bytes = townsBytes(wg, atlas);
    const ms = performance.now() - t0;
    atlas.free();
    self.postMessage({ ok: true, bytes, ms } satisfies TownsResult, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, message: String(err) } satisfies TownsResult);
  }
};
