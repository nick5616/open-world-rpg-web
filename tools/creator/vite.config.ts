// Creator web app (port 5177). /v1 is proxied to the Go endpoint (8094) so
// the page and API share an origin in dev; the worldgen wasm is imported
// with ?url from worldgen/pkg, hence fs.allow on the repo root.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.LODESTONE_CREATOR_WEB_PORT ?? 5177);
const api = `http://127.0.0.1:${process.env.LODESTONE_CREATOR_PORT ?? 8094}`;

export default defineConfig({
  root: path.join(here, 'web'),
  server: {
    port,
    strictPort: true,
    fs: { allow: [path.resolve(here, '..', '..')] },
    proxy: { '/v1': api },
  },
  preview: { port, strictPort: true, proxy: { '/v1': api } },
  worker: { format: 'es' },
  build: { outDir: path.join(here, 'dist'), emptyOutDir: true, target: 'es2022' },
  logLevel: 'warn',
});
