#!/usr/bin/env node
// Playtest 2 headless evidence: spell cards in the character panel (C) and
// the skill tree (N), solo (no servers). The skills dev handle dresses a
// level-12 character and stands in for the zone's equip answer, so the
// clicks and drags below go through the same UI paths as online play.
//
//   node client/src/ui/spellcards/dev/shots.mjs
//   LODESTONE_CLIENT_URL=http://127.0.0.1:5199 node client/src/ui/spellcards/dev/shots.mjs   # a running solo client
//
// Without LODESTONE_CLIENT_URL it starts Vite (VITE_SOLO=1) on 127.0.0.1 and a
// random free port, and kills it on exit. Writes docs/evidence/pt2-spell-cards-*.png
// and pt2-spell-cards-shots.txt.
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
const panelFits = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="character-panel"]');
    const r = el.getBoundingClientRect();
    const inView = r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight;
    return inView && el.scrollWidth <= el.clientWidth + 1;
  });
const center = async (sel) => {
  const b = await page.locator(sel).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

say(`mock: ${JSON.stringify(await S('mock'))}`);

async function round(w, h) {
  const tag = `${w}x${h}`;
  await page.setViewportSize({ width: w, height: h });
  await S('mock'); // fresh loadouts for each round
  await page.mouse.move(w - 20, h - 20);
  await page.keyboard.press('KeyC');
  await page.waitForSelector('[data-testid="spell-board"]');
  await sleep(500);
  check(!(await page.$('[data-testid="character-panel"] select')), `${tag}: no dropdowns left in the panel`);
  check(await panelFits(), `${tag}: panel inside the viewport, no horizontal scroll`);
  const slots = await page.$$('[data-spell-slot^="0:"]');
  check(slots.length === 4, `${tag}: four slot cards`);
  const slot0 = await page.textContent('[data-testid="spell-slot-0-0"]');
  check(/Fireball/.test(slot0) && /Fire/.test(slot0) && /MANA/.test(slot0) && /DMG/.test(slot0), `${tag}: slot 1 card shows name, school, damage and mana: ${slot0}`);
  const grid = await page.$$eval('[data-testid^="spell-grid-"]', (els) => els.map((e) => e.getAttribute('data-testid').slice(11)));
  check(grid.length >= 10 && !grid.includes('kindling'), `${tag}: grid of known castable spells (${grid.length}), no passives`);
  // Scroll the spells section to the top of the panel so slots and grid are in view together.
  await page.evaluate(() => document.querySelector('[data-testid="spell-board"]').scrollIntoView({ block: 'start' }));
  await sleep(200);
  await shot(`pt2-spell-cards-panel-${tag}.png`);

  // Hover: the deep info (the skill tree's facts, your hit, which slots).
  await page.hover('[data-testid="spell-grid-fireball"]');
  await page.waitForSelector('[data-testid="skill-tooltip"]');
  const tip = await page.textContent('[data-testid="skill-tooltip"]');
  check(/Damage85/.test(tip) && /Cooldown2.2 s/.test(tip) && /Mana/.test(tip) && /StatusBurn/.test(tip) && /Your hit/.test(tip) && /In loadout 1 slot 1/.test(tip), `${tag}: tooltip has full stats, your hit and the slot: ${tip.slice(0, 200)}`);
  const tipBox = await page.locator('[data-testid="skill-tooltip"]').boundingBox();
  const panelBox = await page.locator('[data-testid="character-panel"]').boundingBox();
  check(tipBox.x >= panelBox.x + panelBox.width && tipBox.x + tipBox.width <= w && tipBox.y + tipBox.height <= h, `${tag}: tooltip beside the panel, on screen`);
  await shot(`pt2-spell-cards-hover-${tag}.png`);

  // Click to assign: pick Spark Shot, click slot 4.
  await page.click('[data-testid="spell-grid-spark_shot"]');
  await sleep(150);
  check((await page.getAttribute('[data-testid="spell-grid-spark_shot"]', 'aria-pressed')) === 'true', `${tag}: card picked`);
  await page.click('[data-testid="spell-slot-0-3"]');
  await sleep(250);
  let st = await S('state');
  check(st.loadouts[0].spells[3] === 'spark_shot', `${tag}: pick + click a slot: ${JSON.stringify(st.loadouts[0].spells)}`);

  // Drag Frost Bite onto slot 2; screenshot mid-drag.
  const from = await center('[data-testid="spell-grid-frost_bite"]');
  const to = await center('[data-testid="spell-slot-0-1"]');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
    await sleep(16);
  }
  await page.waitForSelector('[data-testid="spell-drag-ghost"]');
  await sleep(150);
  check(!(await page.$('[data-testid="skill-tooltip"]')), `${tag}: no tooltip while dragging`);
  await shot(`pt2-spell-cards-drag-${tag}.png`);
  await page.mouse.up();
  await sleep(250);
  st = await S('state');
  check(st.loadouts[0].spells[1] === 'frost_bite', `${tag}: drag onto slot 2: ${JSON.stringify(st.loadouts[0].spells)}`);

  // Drag a slot onto another slot (moves), then clear with x.
  const a = await center('[data-testid="spell-slot-0-1"]');
  const b = await center('[data-testid="spell-slot-0-2"]');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8);
  await page.mouse.up();
  await sleep(250);
  st = await S('state');
  check(st.loadouts[0].spells[2] === 'frost_bite' && st.loadouts[0].spells[1] === null, `${tag}: slot to slot moves the spell: ${JSON.stringify(st.loadouts[0].spells)}`);
  await page.click('[data-testid="spell-slot-clear-0-2"]');
  await sleep(250);
  st = await S('state');
  check(st.loadouts[0].spells[2] === null, `${tag}: x clears a slot`);

  // The second loadout.
  await page.click('[data-testid="spell-loadout-1"]');
  await sleep(200);
  check(/Ember Flick/.test(await page.textContent('[data-testid="spell-slot-1-0"]')), `${tag}: loadout 2 shows its own slots`);
  await page.click('[data-testid="spell-grid-glint"]');
  await page.click('[data-testid="spell-slot-1-3"]');
  await sleep(250);
  st = await S('state');
  check(st.loadouts[1].spells[3] === 'glint' && st.loadouts[1].spells[2] === null, `${tag}: assign into loadout 2 (moves within it): ${JSON.stringify(st.loadouts[1].spells)}`);
  await page.click('[data-testid="spell-loadout-0"]');

  // Keyboard: focus shows the tooltip, Enter picks, Enter on a slot places.
  await page.mouse.move(w - 20, h - 20);
  await page.focus('[data-testid="spell-grid-lightning_strike"]');
  await sleep(150);
  check(/Lightning Strike/.test((await page.textContent('[data-testid="skill-tooltip"]')) ?? ''), `${tag}: keyboard focus shows the tooltip`);
  await page.keyboard.press('Enter');
  await page.focus('[data-testid="spell-slot-0-2"]');
  await page.keyboard.press('Enter');
  await sleep(250);
  st = await S('state');
  check(st.loadouts[0].spells[2] === 'lightning_strike', `${tag}: keyboard pick + place`);

  await page.keyboard.press('KeyC');
  await sleep(200);
  check(!(await page.$('[data-testid="character-panel"]')), `${tag}: C closes the panel`);
}

await round(1920, 1080);
await round(1280, 720);

// The skill tree (N) uses the same slot cards and tooltip.
await page.setViewportSize({ width: 1920, height: 1080 });
await S('mock');
await page.keyboard.press('KeyN');
await page.waitForSelector('[data-testid="skill-tree-fire"]');
await page.click('[data-testid="skill-node-fireball"]');
await page.hover('[data-testid="skill-node-combustion"]');
await page.waitForSelector('[data-testid="skill-tooltip"]');
await sleep(300);
check((await page.$$('[data-testid^="skill-slot-"][data-spell-slot]')).length === 4, 'skill tree: four slot cards (one loadout at a time)');
await page.click('[data-testid="skill-slot-tab-1"]');
await sleep(150);
check(/Ember Flick/.test(await page.textContent('[data-testid="skill-slot-1-0"]')), 'skill tree: the loadout toggle shows loadout 2');
await page.click('[data-testid="skill-slot-tab-0"]');
await page.hover('[data-testid="skill-node-combustion"]');
await sleep(200);
await shot('pt2-spell-cards-skill-tree-1920x1080.png');
await page.setViewportSize({ width: 1280, height: 720 });
await sleep(500);
await page.hover('[data-testid="skill-node-combustion"]');
await sleep(300);
await shot('pt2-spell-cards-skill-tree-1280x720.png');
await page.keyboard.press('Escape');

say(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors; all checks PASS');
fs.writeFileSync(path.join(evidence, 'pt2-spell-cards-shots.txt'), log.join('\n') + '\n');
await browser.close();
process.exit(errors.length ? 1 : 0);
