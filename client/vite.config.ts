import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// adapted from wizard-wars client/vite.config.ts: vendor chunks split out so a
// game-only deploy doesn't make every player re-download three.js.
export default defineConfig({
  plugins: [react()],
  server: { port: Number(process.env.LODESTONE_CLIENT_PORT ?? 5173) },
  build: {
    target: 'es2022',
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
