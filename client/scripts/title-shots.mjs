#!/usr/bin/env node
// Pt3 title + character-creation evidence: the title cavern and the character
// select / creation stage, from the real components (TitleScreen, the
// CharacterScreen on stage-dev.html with a fake account API), on their own Vite
// server (random port, killed at the end). No services needed.
//
//   node client/scripts/title-shots.mjs [prefix]   -> docs/evidence/<prefix>-title.png, -select.png, -create.png, -phone-*.png, -css.png
//
// LODESTONE_BENCH_GL=swiftshader renders on the CPU (slow, a few seconds a frame).

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const client = resolve(here, '..');
const out = resolve(client, '..', 'docs', 'evidence');
mkdirSync(out, { recursive: true });
const prefix = process.argv[2] ?? 'pt3-title';
const port = 20000 + Math.floor(Math.random() * 20000);
const software = process.env.LODESTONE_BENCH_GL === 'swiftshader';
const gpuArgs = software ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];

const require = (await import('node:module')).createRequire(import.meta.url);
const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: client, stdio: 'ignore' });
let browser = null;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/stage-dev.html`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 120) throw new Error('vite did not start');
    await sleep(500);
  }
  browser = await chromium.launch({ headless: true, args: gpuArgs });
  const open = async (path, w, h) => {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && console.log(`console.error: ${m.text()}`));
    await page.goto(`${base}${path}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('[data-testid=cave-backdrop]')?.getAttribute('data-cave') !== 'loading', null, { polling: 300, timeout: 120000 });
    await sleep(software ? 6000 : 2500);
    return page;
  };
  const shot = async (page, name) => {
    await page.screenshot({ path: join(out, `${prefix}-${name}.png`) });
    console.log(`shot ${prefix}-${name}.png`);
  };

  // title: desktop, phone, and the no-WebGL fallback
  let page = await open('/?solo&cave=1', 1280, 720);
  await shot(page, 'title');
  await page.close();
  page = await open('/?solo&cave=lite', 390, 780);
  await shot(page, 'title-phone');
  await page.close();
  page = await open('/?solo&cave=0', 1280, 720);
  await shot(page, 'title-css');
  await page.close();

  // character select + creation (stage-dev.html: the CharacterScreen with a fake account API)
  page = await open('/stage-dev.html?cave=1&chars=2', 1280, 720);
  await shot(page, 'select');
  await page.getByTestId('look-random').click();
  await page.getByTestId('char-name').fill('Brindle');
  await sleep(software ? 4000 : 1200);
  await shot(page, 'create');
  // drag to turn
  await page.mouse.move(640, 300);
  await page.mouse.down();
  await page.mouse.move(760, 300, { steps: 8 });
  await page.mouse.up();
  await sleep(software ? 4000 : 800);
  await shot(page, 'create-turned');
  await page.close();
  page = await open('/stage-dev.html?cave=lite&chars=2', 390, 780);
  await shot(page, 'select-phone');
  await page.close();
} finally {
  await browser?.close();
  vite.kill();
}
