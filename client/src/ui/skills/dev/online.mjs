#!/usr/bin/env node
// Playtest 2, online: the skill tree screen against a REAL zone (the local
// dev stack, `npm run dev`). Signs a dev user in, makes a fresh character,
// opens N, learns a root node with a skill point through the screen's Learn
// button (combat Interact 50/4), drags it onto a slot (50/3), and checks the
// zone's own answers (combat_sync known/loadouts, Event 900 free points).
// Then B: the build overview from the zone's Event 400 inventory.
//
//   LODESTONE_CLIENT_URL=http://127.0.0.1:5199 node client/src/ui/skills/dev/online.mjs
//
// The client must be a non-solo Vite pointed at the stack (VITE_SOLO=0,
// VITE_ACCOUNT_URL / VITE_DIRECTOR_URL). Writes docs/evidence/pt2-skill-tree-online-*.png.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', '..', '..');
const evidence = path.join(root, 'docs', 'evidence');
const base = process.env.LODESTONE_CLIENT_URL ?? 'http://127.0.0.1:5199';
const user = process.env.LODESTONE_USER ?? `pt2skills${Date.now() % 100000}`;
// Character names are unique per world: a fresh one per run (letters only).
const charName = process.env.LODESTONE_CHAR ?? `Tree${Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const log = [];
const say = (s) => {
  console.log(s);
  log.push(s);
};
const check = (ok, what) => {
  if (!ok) errors.push(what);
  say(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${base}/?debug=1&autoplay=1`);
await page.getByTestId('auth-dev-username').waitFor({ timeout: 120000 });
await page.getByTestId('auth-dev-username').fill(user);
await page.getByTestId('auth-dev-submit').click();
await page.getByTestId('char-name').waitFor();
if ((await page.getByTestId(`play-${charName}`).count()) === 0) {
  await page.getByTestId('char-name').fill(charName);
  await page.getByTestId('char-create').click();
}
await page.getByTestId(`play-${charName}`).click();
await page.waitForFunction(() => window.__lodestone?.netDebug?.()?.phase === 'playing', null, { timeout: 60000 });
await page.waitForFunction(() => !!window.__lodestoneSkills && window.__lodestoneSkills.state().free !== undefined, null, { timeout: 30000 });
await sleep(2500);
say(`signed in as ${user} / ${charName}`);
const S = () => page.evaluate(() => window.__lodestoneSkills.state());

const s0 = await S();
say(`zone: known ${JSON.stringify(s0.known)}, free ${s0.free}, loadout 1 ${JSON.stringify(s0.loadouts[0].spells)}`);
await page.keyboard.press('KeyN');
await page.click('[data-testid="skill-tab-btn-light"]');
await page.waitForSelector('[data-testid="skill-node-glint"]');
check((await page.getAttribute('[data-testid="skill-node-glint"]', 'data-state')) === 'learnable', 'Glint is learnable for a new character');
await page.click('[data-testid="skill-node-glint"]');
await page.click('[data-testid="skill-learn"]');
await page.waitForFunction(() => window.__lodestoneSkills.state().known.includes('glint'), null, { timeout: 10000 }).catch(() => {});
await sleep(800);
const s1 = await S();
check(s1.known.includes('glint'), `the zone learned Glint (combat_sync known: ${JSON.stringify(s1.known)})`);
check(s1.free === s0.free - 1, `the zone's free skill points (combat_sync) ${s0.free} -> ${s1.free}`);
check((await page.getAttribute('[data-testid="skill-node-glint"]', 'data-state')) === 'learned', 'node shows learned');

// Glint may already have filled the empty slot 4 (learning fills a free slot); drag it onto slot 1 instead.
await page.dragAndDrop('[data-testid="skill-node-glint"]', '[data-testid="skill-slot-0-0"]');
await page.waitForFunction(() => window.__lodestoneSkills.state().loadouts[window.__lodestoneSkills.state().activeLoadout ?? 0]?.spells[0] === 'glint', null, { timeout: 10000 }).catch(() => {});
await sleep(500);
const s2 = await S();
check(s2.loadouts[0].spells[0] === 'glint', `drag to slot 1: the zone's loadout 1 = ${JSON.stringify(s2.loadouts[0].spells)}`);
await page.hover('[data-testid="skill-node-radiant_lance"]');
await sleep(300);
await page.screenshot({ path: path.join(evidence, 'pt2-skill-tree-online-light-1920x1080.png') });
await page.keyboard.press('KeyB');
await page.waitForSelector('[data-testid="skill-tab-build"]');
await sleep(500);
const build = await page.textContent('[data-testid="skill-tab-build"]');
check(build.includes('Training sword') || build.includes('Main hand'), 'build overview renders the zone inventory');
await page.screenshot({ path: path.join(evidence, 'pt2-skill-tree-online-build-1920x1080.png') });
say(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'online: all checks PASS');
fs.writeFileSync(path.join(evidence, 'pt2-skill-tree-online.txt'), log.join('\n') + '\n');
await browser.close();
process.exit(errors.length ? 1 : 0);
