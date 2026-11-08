#!/usr/bin/env node
// WP14 headless evidence: the real client in solo mode (no servers), the
// inventory dev handle's mock() (a sample inventory and containers), then
// screenshots of the inventory, the item card of a mythic item, the forge
// crafting panel and the Bitchin' banner with loot toasts.
//
//   node client/src/ui/inventory/dev/shots.mjs
//   LODESTONE_CLIENT_URL=http://127.0.0.1:5173 node client/src/ui/inventory/dev/shots.mjs   # use a running solo client
//
// Without LODESTONE_CLIENT_URL it starts Vite (VITE_SOLO=1) on 127.0.0.1 and a
// random free port, and kills it on exit. Writes docs/evidence/wp14-inventory.png,
// wp14-inventory-tooltip.png, wp14-forge-panel.png, wp14-bitchin.png.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', '..', '..');
const clientDir = path.join(root, 'client');
const evidence = path.join(root, 'docs', 'evidence');
fs.mkdirSync(evidence, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A free port in 20000-40000 (clear of the project's fixed ports and the Hyper-V reserved ranges). */
async function freePort() {
  for (let i = 0; i < 50; i++) {
    const p = 20000 + Math.floor(Math.random() * 20000);
    const ok = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(p, '127.0.0.1', () => s.close(() => res(true)));
    });
    if (ok) return p;
  }
  throw new Error('no free port');
}

let base = process.env.LODESTONE_CLIENT_URL;
let server = null;
if (!base) {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  server = spawn(npx, ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: clientDir, env: { ...process.env, VITE_SOLO: '1' }, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  const cleanup = () => {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']);
      else server.kill();
    } catch {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(1));
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    try {
      up = (await fetch(base)).ok;
    } catch {}
    if (!up) await sleep(500);
  }
  if (!up) throw new Error(`vite did not come up on ${base}`);
}
console.log(`client: ${base}`);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' || m.text().includes('[inventory]')) errors.push(`console.${m.type()}: ${m.text().slice(0, 300)}`);
});

await page.goto(`${base}/?solo&autoplay=1&seed=20261108`);
await page.waitForSelector('[data-testid="world-loading"]', { timeout: 180000 }).catch(() => {});
await page.waitForSelector('[data-testid="world-loading"]', { state: 'detached', timeout: 240000 });
await page.waitForFunction(() => !!window.__lodestoneInventory && !!window.__lodestone, null, { polling: 250, timeout: 60000 });
await page.evaluate(() => {
  window.__lodestone.setFreezeTime?.(true);
  window.__lodestone.setTimeOfDay?.(0.45 * 3600);
});
await sleep(2500);
// Hide the debug HUD (F3): it sits where the panels are.
if (await page.evaluate(() => !!document.querySelector('[data-testid="hud-fps"]'))) await page.keyboard.press('F3');

const shot = async (name) => {
  const file = path.join(evidence, name);
  await page.screenshot({ path: file });
  console.log(`screenshot ${path.relative(root, file)}`);
};
const inv = (fn, arg) => page.evaluate(([f, a]) => window.__lodestoneInventory[f](a), [fn, arg]);

const n = await inv('mock');
console.log(`mock items: ${n}`);
await inv('open');
await page.waitForSelector('[data-testid="inventory-panel"]');
// Select the equipped Sunsteel Blade first (actions visible), park the mouse off the panel.
await inv('select', 'weapon:sunsteel_blade');
await page.mouse.move(5, 5);
await sleep(400);
await shot('wp14-inventory.png');

// The mythic: select it and hover its tile (the card shows it).
const mythic = await inv('select', 'Riftreaver');
await page.hover(`[data-testid="inv-item-${mythic}"]`);
await sleep(300);
const card = await page.textContent('[data-testid="inv-card"]');
if (!card?.includes('Riftreaver') || !card.includes('Unverified')) errors.push(`mythic card text unexpected: ${card}`);
await shot('wp14-inventory-tooltip.png');

await inv('close');
await page.mouse.move(5, 5);
await inv('openCraft', 'forge');
await page.waitForSelector('[data-testid="craft-panel"]');
// A crafted result (Event 405) for the "Last crafted" line.
await page.evaluate(() =>
  window.__lodestoneInventory.event(405, JSON.stringify({ h: 900, b: 'weapon:sunsteel_blade', q: 1, l: 10, r: 3, s: 'inv:16', a: [{ k: 'brutal', s: 'damagePct', v: 6.1 }], k: [''], t: true, v: true, p: 1 }), 1, 16),
);
await sleep(300);
await shot('wp14-forge-panel.png');
await inv('closeCraft');

// Loot toasts and the Bitchin' banner.
await page.evaluate(() => {
  const h = window.__lodestoneInventory;
  h.event(401, JSON.stringify([{ b: 'currency:gold', q: 34, r: 0 }, { b: 'gem:ruby:rough', q: 1, r: 0 }, { b: 'armor:silver_helm', q: 1, r: 2 }, { b: 'weapon:silver_staff', q: 1, r: 4 }, { b: 'weapon:starmetal_bow', q: 1, r: 7, n: 'Starsong' }]), 5, 2);
  h.showBitchin("Mira found Starsong, a Bitchin' Starmetal Bow!", 'Mira');
});
await sleep(1100);
await shot('wp14-bitchin.png');

const state = await inv('state');
console.log(`state: ${state.inv?.items.length} items, gold ${state.inv?.gold}, ${state.containers.length} containers, toasts ${state.toasts.length}`);
await browser.close();
if (errors.length) {
  console.log(`errors:\n  ${errors.join('\n  ')}`);
  process.exitCode = 1;
} else console.log('no page errors');
process.exit();
