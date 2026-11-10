/* global getComputedStyle, localStorage, innerHeight */
// Playtest pass 9 (new player onboarding): the first minutes of a new
// character. Tips (first spawn, near a person, the first enemy), the Esc
// menu (open/close, Controls, Sound, Esc still closes panels first), the
// starter quest "Slimes in the meadows" (talk to the giver, kill slimes at
// the marked packs, hand in, hand-off to the blacksmith), and dying outside
// town (the downed screen, where you respawn, what you keep).
// Passes: whatsnew (the welcome for a new browser, "since you last played"
// for a returning one, the Esc menu page), menu, quest (the starter quest
// is tracked), death (needs dev spawn and a dev camp on the zone: SP9_CAMP
// is where the camp stands).
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV_SPAWN=1 --zone-env LODESTONE_ZONE_DEV_COMBAT=1 --zone-env "LODESTONE_ZONE_DEBUG_CAMP=x,z,8,brute brute brute"
//   LODESTONE_CLIENT_URL=<its url> SP9_CAMP=x,z node tools/playtest/sp9.mjs <outDir> [whatsnew|menu|quest|death]   (all by default)
import { launch, newCharacter, hudBoxes, overlaps, sleep, pl, go, walkTo, look, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/playtest9';
const only = process.argv[3] ?? 'all';
const t = await launch(out);
const { page, shot, note, issue } = t;

const visible = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].some((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0), sel);
const tip = () => page.evaluate(() => document.querySelector('[data-testid="tip"]')?.getAttribute('data-tip') ?? null);
const tracked = () => page.evaluate(() => window.__lodestoneQuests?.tracked?.() ?? null);
const drawn = () =>
  page.evaluate(() => {
    const me = window.__lodestone.player().pos;
    return (window.__lodestoneDrawn?.() ?? []).map((e) => ({ id: e.id, kind: e.kind, x: e.x, y: e.y, z: e.z, typeId: e.typeId, hp: e.healthPct, d: Math.hypot(e.x - me.x, e.z - me.z) })).sort((a, b) => a.d - b.d);
  });
const hp = () => page.evaluate(() => window.__lodestoneCombat?.hud?.() ?? null);
const selfHp = () => page.evaluate(() => {
  const s = window.__lodestone?.netDebug?.();
  return s?.self ?? null;
});

async function waitTip(id, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await tip()) === id) return true;
    await sleep(250);
  }
  return false;
}

async function menuPass() {
  // 1. tips on first spawn
  const sawLook = await waitTip('look', 15000);
  if (!sawLook) issue('tips', 'no "getting around" tip on first spawn');
  else note('tip: look shown');
  await shot('tip-look');
  const o = overlaps(await hudBoxes(page));
  if (o.length) issue('hud-overlap', `with the first tip: ${o.join('; ')}`);
  const hint = await page.evaluate(() => document.querySelector('[data-testid="lock-hint"]')?.innerText ?? null);
  note(`lock hint: ${JSON.stringify(hint)}`);
  if (hint && hint.length > 70) issue('hint', `lock hint is long again (${hint.length} chars)`);

  // 2. Esc opens the menu; Controls; back; close
  await page.keyboard.press('Escape');
  await sleep(400);
  if (!(await visible('[data-testid="esc-menu"]'))) issue('menu', 'Esc did not open the menu');
  await shot('menu');
  await page.getByTestId('menu-controls').click();
  await sleep(300);
  const rows = await page.locator('[data-testid="control-row"]').count();
  note(`controls rows: ${rows}`);
  if (rows < 25) issue('menu', `controls page lists only ${rows} rows`);
  await shot('menu-controls');
  const fits = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="menu-controls-page"]');
    return el ? { h: el.scrollHeight, view: el.clientHeight } : null;
  });
  note(`controls page height ${JSON.stringify(fits)}`);
  await page.keyboard.press('Escape'); // back to the main page
  await sleep(300);
  if (await visible('[data-testid="menu-controls-page"]')) issue('menu', 'Esc on Controls did not go back');
  if (!(await visible('[data-testid="esc-menu"]'))) issue('menu', 'Esc on Controls closed the whole menu');
  // hotkeys wait while the menu is open
  await page.keyboard.press('KeyI');
  await sleep(300);
  if (await visible('[data-testid="inventory-panel"]')) issue('menu', 'I opened the inventory behind the menu');
  await page.keyboard.press('Escape');
  await sleep(300);
  if (await visible('[data-testid="esc-menu"]')) issue('menu', 'Esc did not close the menu');
  // 3. Esc closes an open panel and does not open the menu
  for (const [key, id] of [
    ['KeyI', 'inventory-panel'],
    ['KeyM', 'map-screen'],
    ['KeyJ', 'quest-journal'],
    ['KeyC', 'character-panel'],
    ['KeyK', 'sound-settings'],
    ['KeyO', 'friends-panel'],
  ]) {
    await page.keyboard.press(key);
    await sleep(500);
    const open = await visible(`[data-testid="${id}"]`);
    await page.keyboard.press('Escape');
    await sleep(400);
    const still = await visible(`[data-testid="${id}"]`);
    const menu = await visible('[data-testid="esc-menu"]');
    note(`${id}: open ${open}, after Esc open ${still}, menu ${menu}`);
    if (open && still) issue('menu', `Esc did not close ${id}`);
    if (menu) {
      issue('menu', `Esc on ${id} opened the menu too`);
      await page.keyboard.press('Escape');
      await sleep(300);
    }
  }
  // 4. Sound from the menu opens the sound panel
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.getByTestId('menu-entry-sound').click();
  await sleep(300);
  if (!(await visible('[data-testid="sound-settings"]'))) issue('menu', 'Sound did not open the sound panel');
  if (await visible('[data-testid="esc-menu"]')) issue('menu', 'the menu stayed over the sound panel');
  await page.keyboard.press('Escape');
  await sleep(300);
  // 5. Tips toggle
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.getByTestId('menu-tips-toggle').click();
  const off = await page.evaluate(() => localStorage.getItem('lodestone_tips_enabled'));
  if (off !== '0') issue('tips', 'the toggle did not store off');
  await page.getByTestId('menu-tips-toggle').click();
  await page.getByTestId('menu-resume').click();
  await sleep(300);
  if (await visible('[data-testid="esc-menu"]')) issue('menu', 'Resume did not close the menu');
}

const run = (p) => only === 'all' || only === p;

async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
}
const panelKind = () => page.evaluate(() => document.querySelector('[data-testid="whatsnew"]')?.getAttribute('data-kind') ?? null);

/** Leave to the title and come back (the zone needs a moment to let the character go). */
async function rejoin(at) {
  await page.evaluate(() => window.__lodestone.screen('title'));
  await sleep(4000);
  if (at) await page.evaluate((a) => window.__lodestone.rejoinAt(a), at);
  else await page.evaluate(() => window.__lodestone.screen('play'));
  await page.waitForFunction(() => window.__lodestone?.netDebug?.()?.phase === 'playing', null, { timeout: 120000 });
  await sleep(1500);
}

async function whatsNewWelcome() {
  // A new browser: the short welcome, not the history.
  const kind = await waitFor(panelKind, 15000);
  note(`whatsnew after the first login: ${kind}`);
  if (kind !== 'welcome') issue('whatsnew', `a first-time player should get the welcome, got ${kind}`);
  await shot('whatsnew-welcome');
  if (await visible('[data-testid="tip"]')) issue('whatsnew', 'a tip shows over the welcome');
  await page.keyboard.press('Escape');
  await sleep(400);
  if (await panelKind()) issue('whatsnew', 'Esc did not close the welcome');
  if (await visible('[data-testid="esc-menu"]')) issue('whatsnew', 'Esc on the welcome opened the menu too');
  const seen = await page.evaluate(() => localStorage.getItem('lodestone_whatsnew_seen'));
  note(`marker after closing: ${seen}`);
  if (!seen) issue('whatsnew', 'closing did not store the newest id');
}

async function whatsNewReturning() {
  // A browser that last saw an older entry: only the newer ones, then nothing.
  await page.evaluate(() => localStorage.setItem('lodestone_whatsnew_seen', 'pt2-world'));
  await rejoin();
  const kind = await waitFor(panelKind, 15000);
  const shown = await page.evaluate(() => [...document.querySelectorAll('[data-testid="whatsnew"] [data-testid="whatsnew-entry"]')].map((e) => e.getAttribute('data-id')));
  note(`returning (last saw pt2-world): ${kind} ${JSON.stringify(shown)}`);
  if (kind !== 'news' || shown.includes('pt2-world') || shown.includes('pt2-fixes') || !shown.includes('pt2-onboarding')) issue('whatsnew', `expected only entries newer than pt2-world: ${JSON.stringify(shown)}`);
  await shot('whatsnew-since');
  const box = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="whatsnew"] > div')?.getBoundingClientRect();
    return r ? { top: r.top, bottom: r.bottom, h: innerHeight } : null;
  });
  if (box && (box.top < 0 || box.bottom > box.h)) issue('whatsnew', `panel off screen ${JSON.stringify(box)}`);
  await page.getByTestId('whatsnew-close').click();
  await sleep(300);
  await rejoin();
  await sleep(4000);
  if (await panelKind()) issue('whatsnew', 'the panel came back after it was closed');
  // The whole list from the Esc menu.
  await page.keyboard.press('Escape');
  await sleep(400);
  await page.getByTestId('menu-entry-whatsnew').click();
  await sleep(300);
  const all = await page.locator('[data-testid="menu-whatsnew-page"] [data-testid="whatsnew-entry"]').count();
  note(`Esc > What's new lists ${all} entries`);
  if (all < 8) issue('whatsnew', `the menu page lists ${all} entries`);
  await shot('whatsnew-menu');
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.keyboard.press('Escape');
  await sleep(300);
}

async function questPass() {
  const q = await waitFor(tracked, 15000);
  note(`tracked quest: ${JSON.stringify(q)?.slice(0, 300)}`);
  if (!q || !/slime/i.test(JSON.stringify(q))) issue('quest', 'the starter quest is not tracked');
  if (!(await visible('[data-testid="quest-tracker"]'))) issue('quest', 'no quest tracker on screen');
  await shot('quest-start');
}

async function deathPass() {
  const camp = (process.env.SP9_CAMP ?? '').split(',').map(Number);
  if (camp.length !== 2 || camp.some(Number.isNaN)) {
    note('death pass skipped (SP9_CAMP not set)');
    return;
  }
  const spawn = (await pl(page)).pos;
  await rejoin({ x: camp[0] + 4, z: camp[1] });
  note(`rejoined next to the camp at ${JSON.stringify((await pl(page)).pos)}`);
  const downed = await waitFor(() => visible('[data-testid="downed"]'), 90000);
  if (!downed) {
    issue('death', 'never downed next to the camp');
    await shot('death-not-downed');
    return;
  }
  await sleep(300);
  const text = await page.evaluate(() => document.querySelector('[data-testid="downed"]')?.innerText ?? '');
  note(`downed screen: ${JSON.stringify(text)}`);
  await shot('downed');
  if (!/Downed/.test(text)) issue('death', 'no "Downed" title');
  if (!/by an? \w+/.test(text)) issue('death', `the downed screen does not name the enemy: ${text}`);
  if (!/Back on your feet/.test(text) || !/keep everything/.test(text)) issue('death', 'the downed screen does not say where/when and what you keep');
  const back = await waitFor(async () => !(await visible('[data-testid="downed"]')), 15000);
  if (!back) issue('death', 'still downed after 15 s');
  await sleep(500);
  const grace = await page.evaluate(() => document.querySelector('[data-testid="respawn-grace"]')?.innerText ?? null);
  note(`after the respawn: ${JSON.stringify(grace)}`);
  if (!grace) issue('death', 'no grace line after the respawn');
  await shot('respawned');
  const p = (await pl(page)).pos;
  const fromCamp = Math.hypot(p.x - camp[0], p.z - camp[1]);
  const fromSpawn = Math.hypot(p.x - spawn.x, p.z - spawn.z);
  note(`respawned at ${JSON.stringify(p)}: ${fromCamp.toFixed(0)} m from the camp, ${fromSpawn.toFixed(0)} m from the first spawn`);
  if (fromCamp < 100) issue('death', 'respawned next to the camp');
  const h = await page.evaluate(() => window.__lodestone.selfHealth());
  if (!h || h.health < h.healthMax) issue('death', `not at full health after the respawn: ${JSON.stringify(h)}`);
  await sleep(5500);
  if (await page.evaluate(() => !!document.querySelector('[data-testid="respawn-grace"]'))) issue('death', 'the grace line outlived the grace');
}

async function main() {
  const name = 'Newbie' + (Date.now() % 100000);
  await newCharacter(page, name);
  note(`playing as ${name} at ${JSON.stringify((await pl(page)).pos)}`);
  if (run('whatsnew') || run('menu')) await whatsNewWelcome();
  if (run('menu')) await menuPass();
  if (run('quest')) await questPass();
  if (run('whatsnew')) await whatsNewReturning();
  if (run('death')) await deathPass();
}

try {
  await main();
} catch (e) {
  issue('script', String(e?.stack ?? e).slice(0, 600));
  await shot('error').catch(() => {});
} finally {
  note(`issues: ${t.issues.length}`);
  t.save();
  await t.browser.close();
}

export { drawn, hp, selfHp, tracked, go, walkTo, look, yawTo };
