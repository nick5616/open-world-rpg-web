// Tests live in tools/creator/test (vite.config.ts roots the app at web/).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: path.dirname(fileURLToPath(import.meta.url)),
  test: { include: ['test/**/*.test.ts'] },
});
