#!/usr/bin/env node
// Headless Chromium host for the golden table plus the spec 12 budget check
// (detail chunk <= 8 ms in a worker). Starts the worldgen Vite server
// (port 5180 unless LODESTONE_WORLDGEN_DEBUG_PORT), opens
// /harness/browser/, waits for the worker's report and prints it as JSON.
// Exit code 1 on any hash mismatch or a p95 chunk time over budget.
//   node worldgen/harness/browser/run.mjs [--bench N] [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const BUDGET_MS = 8;
const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const bench = Number(arg('--bench', 200));
const jsonOut = arg('--json', null);

const server = await createServer({ configFile: path.join(here, '..', '..', 'debug', 'vite.config.ts') });
await server.listen();
const port = server.config.server.port;
const browser = await chromium.launch();
let result;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('console:', m.text()));
  await page.goto(`http://localhost:${port}/harness/browser/?bench=${bench}`);
  await page.waitForSelector('body[data-done="1"]', { timeout: 300_000 });
  result = await page.evaluate(() => window.__result);
  result.browserVersion = browser.version();
} finally {
  await browser.close();
  await server.close();
}

if (result.error) {
  console.error('[golden:chromium] worker failed:', result.error);
  process.exit(1);
}
const b = result.bench.chunks;
console.log(
  `[golden:chromium] Chromium ${result.browserVersion} worker: ${result.worlds} worlds, ${result.chunks} chunks, ${result.collisions} collision points, ${result.failures.length} failures`,
);
console.log(
  `[golden:chromium] detail chunk (LOD 0, ${b.n} chunks, worker, crossOriginIsolated=${result.crossOriginIsolated}): mean ${b.mean.toFixed(2)} ms, p50 ${b.p50.toFixed(2)}, p95 ${b.p95.toFixed(2)}, max ${b.max.toFixed(2)} (budget ${BUDGET_MS} ms); atlas ${result.bench.atlasMs.toFixed(0)} ms; ${result.bench.scatterPerChunk.toFixed(0)} scatter/chunk`,
);
for (const f of result.failures.slice(0, 20)) console.error('  ' + f);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(result, null, 2) + '\n');
process.exit(result.failures.length || b.p95 > BUDGET_MS ? 1 : 0);
