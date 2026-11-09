#!/usr/bin/env node
// Playtest 2 headless evidence: the skill tree screen (N) and the build
// overview (B) in the real client, solo (no servers). The skills dev handle
// dresses a level-12 character (Event 900 stats, combat_sync spells and skill
// XP, the inventory mock's gear) and stands in for the zone's learn/equip
// answers, so the clicks below go through the same UI paths as online play.
//
//   node client/src/ui/skills/dev/shots.mjs
//   LODESTONE_CLIENT_URL=http://127.0.0.1:5199 node client/src/ui/skills/dev/shots.mjs   # a running solo client
//
// Without LODESTONE_CLIENT_URL it starts Vite (VITE_SOLO=1) on 127.0.0.1 and a
// random free port, and kills it on exit. Writes docs/evidence/pt2-skill-tree-*.png
// and pt2-skill-tree-shots.txt.
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
if (!base) {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const server = spawn(npx, ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: clientDir, env: { ...process.env, VITE_SOLO: '1' }, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
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
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.${m.type()}: ${m.text().slice(0, 300)}`);
});
const check = (ok, what) => {
  if (!ok) errors.push(`check failed: ${what}`);
  say(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};

await page.goto(`${base}/?solo&autoplay=1&seed=20261108`);
await page.waitForSelector('[data-testid="world-loading"]', { timeout: 180000 }).catch(() => {});
await page.waitForSelector('[data-testid="world-loading"]', { state: 'detached', timeout: 240000 });
await page.waitForFunction(() => !!window.__lodestoneSkills && !!window.__lodestone, null, { polling: 250, timeout: 90000 });
await page.evaluate(() => {
  window.__lodestone.setFreezeTime?.(true);
  window.__lodestone.setTimeOfDay?.(0.45 * 3600);
});
await sleep(1500);
if (await page.evaluate(() => !!document.querySelector('[data-testid="hud-fps"]'))) await page.keyboard.press('F3');

const S = (fn, ...args) => page.evaluate(([f, a]) => window.__lodestoneSkills[f](...a), [fn, args]);
const shot = async (name) => {
  const file = path.join(evidence, name);
  await page.screenshot({ path: file });
  say(`screenshot ${path.relative(root, file).replaceAll('\\', '/')}`);
};
const overflowX = () => page.evaluate(() => {
  const el = document.querySelector('[data-testid="skill-screen"]');
  const r = el.getBoundingClientRect();
  return r.left < 0 || r.right > window.innerWidth || r.top < 0 || r.bottom > window.innerHeight;
});

const mocked = await S('mock');
say(`mock: ${JSON.stringify(mocked)}`);

// 1. N opens the tree on Fire; the look hint hides; nodes carry their state.
await page.keyboard.press('KeyN');
await page.waitForSelector('[data-testid="skill-tree-fire"]');
await sleep(400);
check(await page.evaluate(() => !document.querySelector('[data-testid="lock-hint"]') || window.getComputedStyle(document.querySelector('[data-testid="lock-hint"]')).display === 'none'), 'look hint hidden while the screen is open');
const states = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid^="skill-node-"]')].map((n) => [n.getAttribute('data-testid').slice(11), n.getAttribute('data-state')])));
say(`fire states: ${JSON.stringify(states)}`);
check(states.fireball === 'learned' && states.cauterize === 'learnable' && states.immolate === 'needsPrereq', 'fire node states (fireball learned, cauterize learnable, immolate needs a prerequisite)');

// 2. Learn Cauterize: pick it, press Learn (the zone's answer: combat_sync + Event 900).
const free0 = (await S('state')).free;
await page.click('[data-testid="skill-node-cauterize"]');
await page.waitForSelector('[data-testid="skill-learn"]');
await page.click('[data-testid="skill-learn"]');
await sleep(300);
const st1 = await S('state');
check(st1.known.includes('cauterize') && st1.free === free0 - 1, `Learn spends a point (${free0} -> ${st1.free}) and Cauterize is learned`);
check((await page.getAttribute('[data-testid="skill-node-immolate"]', 'data-state')) === 'learnable', 'Immolate became learnable');

// 3. Drag the learned Cauterize onto slot 4 of the active loadout.
await page.dragAndDrop('[data-testid="skill-node-cauterize"]', '[data-testid="skill-slot-0-3"]');
await sleep(300);
const st2 = await S('state');
check(st2.loadouts[0].spells[3] === 'cauterize', `drag to slot 4: loadout 1 = ${JSON.stringify(st2.loadouts[0].spells)}`);
// Click-to-assign: pick Fireball, then click slot 4 of loadout 2.
await page.click('[data-testid="skill-node-fireball"]');
await page.click('[data-testid="skill-slot-1-3"]');
await sleep(300);
const st3 = await S('state');
check(st3.loadouts[1].spells[3] === 'fireball', `pick + click a slot: loadout 2 = ${JSON.stringify(st3.loadouts[1].spells)}`);

// The tree with a picked node and a hover tooltip.
await page.click('[data-testid="skill-node-immolate"]');
await page.hover('[data-testid="skill-node-fireball"]');
await page.waitForSelector('[data-testid="skill-tooltip"]');
const tip = await page.textContent('[data-testid="skill-tooltip"]');
check(/Damage85/.test(tip) && /Cooldown2.2 s/.test(tip) && /Mana/.test(tip) && /StatusBurn/.test(tip), `tooltip: ${tip.slice(0, 160)}`);
check(!(await overflowX()), 'screen fits the 1920x1080 viewport');
await shot('pt2-skill-tree-fire-1920x1080.png');

// Light (kills demons) and Earth (the widest tree).
await page.click('[data-testid="skill-tab-btn-light"]');
await page.hover('[data-testid="skill-node-glint"]');
await sleep(300);
check((await page.textContent('[data-testid="skill-tooltip"]')).includes('kills demons'), 'Light tooltip says it kills demons');
await page.click('[data-testid="skill-tab-btn-earth"]');
await page.mouse.move(5, 5);
await sleep(300);
await shot('pt2-skill-tree-earth-1920x1080.png');

// 4. Weapon skills and techniques.
await page.click('[data-testid="skill-tab-btn-skills"]');
await page.waitForSelector('[data-testid="skill-tab-skills"]');
await sleep(300);
await shot('pt2-skill-tree-weapon-skills-1920x1080.png');

// 5. B: the build overview.
await page.keyboard.press('KeyB');
await page.waitForSelector('[data-testid="skill-tab-build"]');
await sleep(400);
const build = await page.textContent('[data-testid="skill-tab-build"]');
for (const want of ['Sunsteel Blade', 'Cut Topaz', 'Silver Cuirass', 'Loadout 1', 'Loadout 2', 'Weapon hits', 'Crystal', 'unspent', 'Kindling', 'Forge luck', 'Loot find', 'kills demons']) check(build.toLowerCase().includes(want.toLowerCase()), `build shows "${want}"`);
check(!(await overflowX()), 'build fits the 1920x1080 viewport');
await shot('pt2-skill-tree-build-1920x1080.png');

// 6. 1280x720.
await page.setViewportSize({ width: 1280, height: 720 });
await sleep(600);
check(!(await overflowX()), 'build fits 1280x720');
await shot('pt2-skill-tree-build-1280x720.png');
await page.keyboard.press('KeyN'); // back to the last tree (Earth)
await page.click('[data-testid="skill-tab-btn-fire"]');
await page.click('[data-testid="skill-node-solar_flare"]');
await page.hover('[data-testid="skill-node-eruption"]');
await sleep(400);
check(!(await overflowX()), 'tree fits 1280x720');
const crowd = await page.evaluate(() => {
  // No two nodes overlap at this size.
  const r = [...document.querySelectorAll('[data-testid^="skill-node-"]')].map((n) => n.getBoundingClientRect());
  for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) if (r[i].left < r[j].right && r[j].left < r[i].right && r[i].top < r[j].bottom && r[j].top < r[i].bottom) return true;
  return false;
});
check(!crowd, 'no overlapping nodes at 1280x720 (Fire)');
await shot('pt2-skill-tree-fire-1280x720.png');
await page.click('[data-testid="skill-tab-btn-dark"]');
await page.mouse.move(5, 5);
await sleep(300);
await shot('pt2-skill-tree-dark-1280x720.png');

// 7. Esc closes.
await page.keyboard.press('Escape');
await sleep(200);
check(!(await page.$('[data-testid="skill-screen"]')), 'Esc closes the screen');

say(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors; all checks PASS');
fs.writeFileSync(path.join(evidence, 'pt2-skill-tree-shots.txt'), log.join('\n') + '\n');
await browser.close();
process.exit(errors.length ? 1 : 0);
