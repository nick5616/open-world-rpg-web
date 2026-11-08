// Headless Chromium host of the WP07 height comparison: serves page/ with
// Vite (so @lodestone/worldgen's TypeScript loads unbundled, exactly as the
// client imports it), runs the check inside a Web Worker (where the client
// generates terrain) and writes the result.
//   HEIGHTCMP_IN=in.json HEIGHTCMP_OUT=out.json HEIGHTCMP_WASM=/abs/worldgen.wasm \
//     node server/pkg/worldhost/jscheck/browser.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', '..');
const input = JSON.parse(fs.readFileSync(process.env.HEIGHTCMP_IN, 'utf8'));
const wasmUrl = '/@fs/' + path.resolve(process.env.HEIGHTCMP_WASM).replace(/\\/g, '/').replace(/^\//, '');

const server = await createServer({
  configFile: false,
  root: path.join(here, 'page'),
  logLevel: 'error',
  server: { port: Number(process.env.HEIGHTCMP_PORT ?? 5190), strictPort: false, fs: { allow: [root] } },
});
await server.listen();
const browser = await chromium.launch();
let result;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => typeof window.runHeights === 'function');
  result = await page.evaluate(([inp, url]) => window.runHeights(inp, url), [input, wasmUrl]);
  result.host = `chromium ${browser.version()} web worker`;
} finally {
  await browser.close();
  await server.close();
}
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
fs.writeFileSync(process.env.HEIGHTCMP_OUT, JSON.stringify(result));
