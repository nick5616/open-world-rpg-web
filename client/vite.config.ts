import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// WP05: the world imports worldgen/pkg/worldgen.wasm (gitignored build
// output). Build it on first start so `npm run dev:solo` works on a fresh
// clone; fails with the cargo error if the Rust toolchain is missing.
function ensureWorldgenWasm(): Plugin {
  return {
    name: 'lodestone-ensure-worldgen-wasm',
    buildStart() {
      if (existsSync(path.join(root, 'worldgen', 'pkg', 'worldgen.wasm'))) return;
      console.log('[lodestone] worldgen.wasm missing: running npm run build:wasm');
      const r = spawnSync('node', [path.join(root, 'worldgen', 'scripts', 'build-wasm.mjs'), '--quiet'], { cwd: root, stdio: 'inherit' });
      if (r.status !== 0) throw new Error('worldgen.wasm build failed (npm run build:wasm)');
    },
  };
}

// adapted from wizard-wars client/vite.config.ts: vendor chunks split out so a
// game-only deploy doesn't make every player re-download three.js.
export default defineConfig({
  plugins: [react(), ensureWorldgenWasm()],
  server: { port: Number(process.env.LODESTONE_CLIENT_PORT ?? 5173) },
  // Generation workers import @lodestone/worldgen and the mesh builder as ES modules.
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // Audio (client/src/audio/assets): always hashed files, never base64 in
    // the JS (Vite inlines files under 4 KB; short clicks would bloat the
    // audio chunk and lose the immutable caching).
    assetsInlineLimit: (file: string) => (/\.(ogg|m4a)$/.test(file) ? false : undefined),
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules[/\\](react|react-dom|scheduler)[/\\]/.test(id)) return 'vendor-react';
          if (/node_modules[/\\]three[/\\]/.test(id)) return 'vendor-three';
          if (id.includes('@react-three') || id.includes('postprocessing')) return 'vendor-r3f';
          return undefined;
        },
      },
    },
  },
});
