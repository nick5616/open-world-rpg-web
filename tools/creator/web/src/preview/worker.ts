// Preview worker: owns one worldgen.wasm instance (instances are single-
// threaded, worldgen/README.md host rule 4) and builds atlases off the main
// thread so sliders stay responsive while a ~400 ms atlas_build runs.
//
// Preview requests are latest-wins: while an atlas builds, newer requests
// replace the pending one, so dragging a slider costs at most one stale
// build, never a queue of them.
import { loadWorldgen, type Worldgen } from '@lodestone/worldgen';
import type { WorldSpec } from '@lodestone/contracts';
import wasmUrl from '../../../../../worldgen/pkg/worldgen.wasm?url';
import { atlasStats, renderAtlas } from './render';
import type { ToWorker, FromWorker } from './protocol';

const PX = 768;
let wg: Worldgen | null = null;
const ready = (async () => {
  wg = await loadWorldgen(await (await fetch(wasmUrl)).arrayBuffer());
  post({ type: 'ready', genVersion: wg.genVersion });
})().catch((e: unknown) => post({ type: 'error', id: -1, message: `worldgen.wasm failed to load: ${String(e)}` }));

function post(m: FromWorker, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(m, transfer);
}

let pending: { id: number; spec: WorldSpec } | null = null;
let busy = false;

function preview(job: { id: number; spec: WorldSpec }) {
  const t0 = performance.now();
  const atlas = wg!.buildAtlas(job.spec);
  const atlasMs = performance.now() - t0;
  try {
    const data = atlas.data;
    const canvas = new OffscreenCanvas(PX, PX);
    renderAtlas(canvas.getContext('2d')!, data, PX);
    const bitmap = canvas.transferToImageBitmap();
    post({ type: 'preview', id: job.id, bitmap, stats: atlasStats(data, atlas.hash, atlasMs) }, [bitmap]);
  } finally {
    atlas.free();
  }
}

function loop() {
  const job = pending;
  pending = null;
  if (job) {
    try {
      preview(job);
    } catch (e) {
      post({ type: 'error', id: job.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  if (pending) setTimeout(loop, 0);
  else busy = false;
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  await ready;
  const m = e.data;
  if (m.type === 'fromSeed') {
    try {
      post({ type: 'spec', id: m.id, spec: wg!.specFromSeed(m.seed) });
    } catch (err) {
      post({ type: 'error', id: m.id, message: String(err) });
    }
  } else if (m.type === 'preview') {
    pending = { id: m.id, spec: m.spec };
    if (!busy) {
      busy = true;
      setTimeout(loop, 0);
    }
  }
};
