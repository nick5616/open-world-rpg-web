#!/usr/bin/env node
/* global localStorage */
// CR 038 dev aid: open the solo client at a place and run a list of probes
// (toggle groups, screenshot each) to find what draws wrong.
//   node client/src/world/vertical/dev/vertical-debug.mjs x y z yaw pitch outDir
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', '..', '..');
const [x, y, z, yaw, pitch, out] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 5392;
const base = `http://127.0.0.1:${port}`;
const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(root, 'client'), env: { ...process.env, VITE_SOLO: '1' }, shell: process.platform === 'win32', stdio: 'ignore' });
const kill = () => spawnSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
process.on('exit', kill);
for (let i = 0; i < 160; i++) {
  try {
    if ((await fetch(base)).ok) break;
  } catch {
    /* */
  }
  await sleep(500);
}
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await ctx.addInitScript(() => localStorage.setItem('lodestone_whatsnew_seen', '9999'));
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log('console:', m.text().slice(0, 300));
  });
  await page.goto(`${base}/?solo&autoplay=1`);
  await page.waitForSelector('[data-testid="world-loading"]', { timeout: 120000 });
  await page.waitForSelector('[data-testid="world-loading"]', { state: 'detached', timeout: 240000 });
  await page.evaluate(() => window.__lodestone.setFreezeTime(true));
  await page.evaluate(() => window.__lodestone.setFly(true));
  await page.evaluate((p) => window.__lodestone.teleport(p), { x: +x, y: +y, z: +z });
  await sleep(9000);
  await page.evaluate(([a, b]) => window.__lodestone.setLook(a, b), [+yaw, +pitch]);
  await sleep(1500);
  const probes = [
    ['all', () => {}],
    ['no-shafts', () => window.__lodestoneVertical.group.traverse((o) => { if (o.renderOrder === 5) o.visible = false; })],
    ['no-falls', () => window.__lodestoneVertical.group.traverse((o) => { if (o.renderOrder === 4) o.visible = false; })],
    ['no-inst', () => window.__lodestoneVertical.group.traverse((o) => { if (o.isInstancedMesh) o.visible = false; })],
  ];
  for (const [name, fn] of probes) {
    await page.evaluate(`(${fn.toString()})()`);
    await sleep(800);
    await page.screenshot({ path: path.join(out, `dbg-${name}.jpg`), type: 'jpeg', quality: 70 });
    console.log('shot', name);
  }
} finally {
  await browser.close();
  kill();
}
