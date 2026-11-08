/* global self */
// Web Worker half of the Chromium host: same loader and formula the client
// uses (@lodestone/worldgen), same shared check as the Node host.
import { loadWorldgen, chunkSurfaceHeight, hex64 } from '@lodestone/worldgen';
import { runCheck } from '../check.mjs';

self.onmessage = async (e) => {
  try {
    const { input, wasmUrl } = e.data;
    const wg = await loadWorldgen(await (await fetch(wasmUrl)).arrayBuffer());
    const out = runCheck(wg, { chunkSurfaceHeight, hex64 }, input);
    out.userAgent = self.navigator.userAgent;
    self.postMessage(out);
  } catch (err) {
    self.postMessage({ error: String(err?.stack ?? err) });
  }
};
