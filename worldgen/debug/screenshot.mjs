#!/usr/bin/env node
// Headless screenshots of the debug map into docs/evidence/:
//   node worldgen/debug/screenshot.mjs [seed ...]
// Starts the debug Vite server (port 5180, LODESTONE_WORLDGEN_DEBUG_PORT to
// override), opens /debug/?seed=N in headless Chromium and captures the page.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const out = path.join(root, 'docs', 'evidence');
fs.mkdirSync(out, { recursive: true });
const seeds = process.argv.slice(2).length ? process.argv.slice(2) : ['7'];

const server = await createServer({ configFile: path.join(here, 'vite.config.ts') });
await server.listen();
const port = server.config.server.port;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1430, height: 1110 } });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  for (const seed of seeds) {
    const cover = seed.endsWith(':cover');
    const s = seed.replace(':cover', '');
    await page.goto(`http://localhost:${port}/debug/?seed=${s}${cover ? '&cover=1' : ''}`);
    await page.waitForSelector('body[data-ready="1"]', { timeout: 60000 });
    const file = path.join(out, `wp01-atlas-seed${s}${cover ? '-coverage' : ''}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`wrote ${path.relative(root, file)}`);
  }
} finally {
  await browser.close();
  await server.close();
}
