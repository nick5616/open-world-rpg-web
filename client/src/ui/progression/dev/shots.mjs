#!/usr/bin/env node
// Playtest 1 headless evidence: the real client in solo mode (no servers),
// the progression dev handle feeding the same Events the zone sends, then
// screenshots of the level-up fanfare, the character panel (C) and the
// crystal tower prompts (at the foot: "Climb to the crystal..."; on the top:
// "[E] Attune to the crystal"; after: the attunement notice).
//
//   node client/src/ui/progression/dev/shots.mjs
//   LODESTONE_CLIENT_URL=http://127.0.0.1:5173 node client/src/ui/progression/dev/shots.mjs   # a running solo client
//
// Without LODESTONE_CLIENT_URL it starts Vite (VITE_SOLO=1) on 127.0.0.1 and a
// random free port, and kills it on exit. Writes docs/evidence/pt-progression-*.png
// and pt-progression-shots.txt.
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
const log = [];
const say = (s) => {
  console.log(s);
  log.push(s);
};

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
say(`client: ${base}`);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.${m.type()}: ${m.text().slice(0, 300)}`);
});

await page.goto(`${base}/?solo&autoplay=1&seed=20261108`);
await page.waitForSelector('[data-testid="world-loading"]', { timeout: 180000 }).catch(() => {});
await page.waitForSelector('[data-testid="world-loading"]', { state: 'detached', timeout: 240000 });
await page.waitForFunction(() => !!window.__lodestoneProgression && !!window.__lodestone && !!window.__lodestoneMap && window.__lodestoneMap.towers().length > 0, null, { polling: 250, timeout: 90000 });
await page.evaluate(() => {
  window.__lodestone.setFreezeTime?.(true);
  window.__lodestone.setTimeOfDay?.(0.45 * 3600);
});
await sleep(2000);
if (await page.evaluate(() => !!document.querySelector('[data-testid="hud-fps"]'))) await page.keyboard.press('F3');

const shot = async (name) => {
  const file = path.join(evidence, name);
  await page.screenshot({ path: file });
  say(`screenshot ${path.relative(root, file).replaceAll('\\', '/')}`);
};
const P = (fn, ...args) => page.evaluate(([f, a]) => window.__lodestoneProgression[f](...a), [fn, args]);

// 1. Level-up fanfare: level 3 -> 4, as the zone's Event 900 (reason 1) after a kill.
await P('stats', 3);
await P('area', 1, 0, 1, '');
await sleep(600);
await P('levelUp', 3, 4);
await page.waitForSelector('[data-testid="levelup-fanfare"]');
await sleep(900);
const fan = await page.textContent('[data-testid="levelup-fanfare"]');
say(`fanfare: ${fan}`);
if (!fan?.includes('Level 4') || !fan.includes('health') || !fan.includes('damage')) errors.push(`fanfare text unexpected: ${fan}`);
await shot('pt-progression-levelup.png');

// 2. Character panel (C): level 4, one crystal attuned, standing in the wilds someone shaped.
await sleep(6500); // the fanfare fades
await P('stats', 4, 1);
await P('area', 6, 2, 0, 'Bruno');
await page.keyboard.press('KeyC');
await page.waitForSelector('[data-testid="character-panel"]');
await page.mouse.move(1500, 850);
await sleep(500);
const panel = await page.textContent('[data-testid="character-panel"]');
for (const want of ['Level 4', 'Health', 'Stamina', 'Damage', 'Skill points', 'Coming next', 'Learn spells', 'The Wilds']) if (!panel?.includes(want)) errors.push(`panel lacks "${want}"`);
say(`panel: ${panel?.slice(0, 400)}`);
await shot('pt-progression-character-panel.png');
await page.keyboard.press('KeyC');
await sleep(300);

// 3. The crystal tower: at its foot, then on its top.
const tw = await page.evaluate(() => {
  const p = window.__lodestone.player().pos;
  const t = window.__lodestoneMap.towers().sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
  return t;
});
say(`tower: ${tw.name} site ${tw.site} at (${tw.x.toFixed(0)}, ${tw.z.toFixed(0)}) top ${tw.topY.toFixed(1)} m, footprint ${tw.maxR.toFixed(1)} m`);
const foot = { x: tw.x + tw.maxR + 16, z: tw.z + 6 };
await page.evaluate(([f, t]) => {
  window.__lodestone.teleport({ x: f.x, z: f.z });
  window.__lodestone.setLook(Math.atan2(-(t.x - f.x), -(t.z - f.z)), 0.42);
}, [foot, tw]);
await sleep(2500);
await page.waitForSelector('[data-testid="tower-prompt-climb"]', { timeout: 10000 }).catch(() => errors.push('no climb prompt at the foot of the tower'));
await sleep(400);
await shot('pt-progression-tower-prompt.png');

await page.evaluate((t) => {
  // Beside the crystal, looking out over the land with the crystal at the left edge.
  window.__lodestone.teleport({ x: t.x + 2.6, y: t.topY, z: t.z + 0.8 });
  window.__lodestone.setLook(0.55, 0.05);
}, tw);
await sleep(2500);
await page.waitForSelector('[data-testid="tower-prompt-attune"]', { timeout: 10000 }).catch(() => errors.push('no attune prompt on the top'));
await sleep(300);
await shot('pt-progression-tower-attune.png');

// The zone's answer to [E]: Event 902 tower_attuned + stats (reason 2).
await P('attuned', tw.site, 0, 'the land below');
await P('stats', 4, 1, [tw.site]);
await page.waitForSelector('[data-testid="tower-prompt-attuned"]', { timeout: 5000 }).catch(() => errors.push('no "attuned" prompt after the attunement'));
await sleep(500);
await shot('pt-progression-tower-attuned.png');

say(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors; all checks PASS');
fs.writeFileSync(path.join(evidence, 'pt-progression-shots.txt'), log.join('\n') + '\n');
await browser.close();
process.exit(errors.length ? 1 : 0);
