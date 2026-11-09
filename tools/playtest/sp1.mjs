/* global getComputedStyle */
// Playtest pass 1: onboarding, the HUD with each panel open, the starter quest state.
import { launch, newCharacter, hudBoxes, overlaps, sleep, pl } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/playtest';
const t = await launch(out);
const { page, shot, note, issue } = t;
try {
  const t0 = Date.now();
  await newCharacter(page, 'Tester' + (Date.now() % 100000));
  note(`playing after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await sleep(6000);
  await shot('spawn');
  const o0 = overlaps(await hudBoxes(page));
  if (o0.length) issue('hud-overlap', `at spawn: ${o0.join('; ')}`);
  note(`at ${JSON.stringify((await pl(page)).pos)}`);
  const q = await page.evaluate(() => window.__lodestoneQuests?.tracked?.());
  note(`tracked quest: ${JSON.stringify(q)?.slice(0, 1500)}`);
  for (const [key, name] of [
    ['KeyI', 'inventory'],
    ['KeyC', 'character'],
    ['KeyJ', 'journal'],
    ['KeyM', 'map'],
    ['KeyK', 'sound'],
    ['KeyO', 'friends'],
  ]) {
    await page.keyboard.press(key);
    await sleep(900);
    await shot(name);
    const o = overlaps(await hudBoxes(page));
    if (o.length) issue('hud-overlap', `${name} open: ${o.join('; ')}`);
    await page.keyboard.press(key);
    await sleep(400);
    await page.keyboard.press('Escape');
    await sleep(300);
  }
  const stray = await page.evaluate(() => [...document.querySelectorAll('[data-ui-panel]')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.dataset.testid));
  if (stray.length) issue('panel-stuck', `still open after toggling: ${stray.join(', ')}`);
} catch (e) {
  issue('script', String(e?.stack ?? e).slice(0, 600));
  await shot('error').catch(() => {});
} finally {
  t.save();
  await t.browser.close();
}
