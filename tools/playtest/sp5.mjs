// Playtest pass 5: walk out of town, then open the map (explored sketch, framing, labels).
import { launch, newCharacter, sleep, pl, go } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/playtest5';
const t = await launch(out);
const { page, shot, note, issue } = t;
try {
  await newCharacter(page, 'Mapper' + (Date.now() % 100000));
  await sleep(4000);
  await page.keyboard.press('KeyM');
  await sleep(1200);
  await shot('map-at-spawn');
  await page.keyboard.press('KeyM');
  const p = (await pl(page)).pos;
  const r = await go(page, p.x - 150, p.z + 160, { stopAt: 8, timeoutMs: 80000, sprint: true });
  note(`walked out: ok=${r.ok} d=${r.d.toFixed(0)}`);
  await sleep(800);
  await page.keyboard.press('KeyM');
  await sleep(1200);
  await shot('map-after-walk');
  await page.mouse.move(800, 450);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 400);
    await sleep(120);
  }
  await sleep(500);
  await shot('map-zoomed-out');
  const unexplored = await page.evaluate(() => !!document.querySelector('[data-testid="map-screen"]'));
  if (!unexplored) issue('map', 'map did not open');
} catch (e) {
  issue('script', String(e?.stack ?? e).slice(0, 600));
  await shot('error').catch(() => {});
} finally {
  t.save();
  await t.browser.close();
}
