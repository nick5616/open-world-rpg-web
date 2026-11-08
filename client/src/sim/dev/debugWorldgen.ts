// Debug-only generated ground in the browser (WP10): `?ground=worldgen` makes
// the play screen walk on worldgen.wasm's collision surface and water (the
// exact functions the zone simulates on) with a crude heightfield patch as
// the visual, so traversal can be tried and captured before WP05's streamed
// terrain lands. WP05 replaces this with chunk-backed ground + real
// rendering; nothing outside dev tooling depends on it.

import { DEBUG } from '../../config';
import { loadWorldgenGround, type WorldgenGround } from '../worldgenGround';

export function wantsWorldgenGround(): boolean {
  if (!DEBUG || typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get('ground') === 'worldgen';
}

const cache = new Map<string, Promise<WorldgenGround>>();

/** Fetch worldgen.wasm (dev server serves the built file from worldgen/pkg) and build the atlas for seed. */
export function browserWorldgenGround(seed: bigint | string): Promise<WorldgenGround> {
  const key = String(seed);
  let p = cache.get(key);
  if (!p) {
    // Resolved by Vite at dev time from the repo's build output (npm run
    // build:wasm). Production builds never take this path (DEBUG only).
    const url = new URL('../../../../worldgen/pkg/worldgen.wasm', import.meta.url);
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`worldgen.wasm: HTTP ${r.status} (run npm run build:wasm)`);
        return r.arrayBuffer();
      })
      .then((b) => loadWorldgenGround(b, seed));
    cache.set(key, p);
  }
  return p;
}
