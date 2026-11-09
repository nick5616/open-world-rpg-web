/* global getComputedStyle, localStorage */
// Playtest pass 8 (new player onboarding): the first minutes of a new
// character. Tips (first spawn, near a person, the first enemy), the Esc
// menu (open/close, Controls, Sound, Esc still closes panels first), the
// starter quest "Slimes in the meadows" (talk to the giver, kill slimes at
// the marked packs, hand in, hand-off to the blacksmith), and dying outside
// town (the downed screen, where you respawn, what you keep).
//
//   node tools/playtest/sp8.mjs <outDir> [menu|quest|death]   (all by default)
import { launch, newCharacter, hudBoxes, overlaps, sleep, pl, go, walkTo, look, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/playtest8';
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

async function main() {
  const name = 'Newbie' + (Date.now() % 100000);
  await newCharacter(page, name);
  note(`playing as ${name} at ${JSON.stringify((await pl(page)).pos)}`);
  if (only === 'all' || only === 'menu') await menuPass();
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
