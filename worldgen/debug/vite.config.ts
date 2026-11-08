// Vite dev server for the worldgen debug map and the Chromium golden harness.
// Root is worldgen/ so /pkg/worldgen.wasm and /golden/golden.json are served
// as-is. COOP/COEP make the page cross-origin isolated, which gives workers
// fine-grained performance.now() for the chunk-time measurement.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.LODESTONE_WORLDGEN_DEBUG_PORT ?? 5180);

export default defineConfig({
  root,
  server: {
    port,
    strictPort: true,
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    fs: { allow: [path.resolve(root, '..')] },
  },
  worker: { format: 'es' },
  logLevel: 'warn',
});
