// Playtest 5 "can't press E on anything": the welcome / What's new card comes up on its own once a player has
// stood still (after the first-hour hold, 10 min of play), holds E like any panel and could not be clicked with
// the mouse captured. This checks, in the real client, that
//   1. the card appears while the player stands still and holds E (a pickup beside them cannot be taken),
//   2. it waits while an "[E]" prompt is up (the player is about to use something),
//   3. E closes it, and E then takes the pickup.
// The first-hour hold is skipped by abandoning the first quest through the dev console.
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1 --zone-env LODESTONE_ZONE_NO_WORLD_EVENTS=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/pt5-card-check.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, newCharacter, sleep, pl, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'docs/evidence';
mkdirSync(out, { recursive: true });
mkdirSync('tmp/pt5-card', { recursive: true });
const A = await launch('tmp/pt5-card/raw', { width: 1280, height: 720 });
const page = A.page;
const result = { checks: {} };
const check = (k, ok, d) => {
  result.checks[k] = { ok: !!ok, detail: d };
  console.log(`${ok ? 'PASS' : 'FAIL'} ${k}${d ? ` ${JSON.stringify(d)}` : ''}`);
};
const run = (l) => page.evaluate((x) => window.__lodestoneDev.run(x), l);
const key = async (k) => {
  await page.keyboard.down(k);
  await sleep(60);
  await page.keyboard.up(k);
};
const card = () => page.evaluate(() => !!document.querySelector('[data-testid="whatsnew"]'));
const pickups = () =>
  page.evaluate(async () => {
    const f = (await import('/src/net/netStore.ts')).netRuntime.session?.latestFrame;
    return (f?.ents ?? []).filter((e) => e.kind === 4).map((e) => ({ id: e.id, x: e.x, y: e.y, z: e.z }));
  });
const jpg = (n) => page.screenshot({ path: `${out}/pt5-interact-${n}.jpg`, type: 'jpeg', quality: 70 });

try {
  await newCharacter(page, `Card${Date.now().toString(36).slice(-4)}`);
  await page.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 90000 });
  await run('/god');
  await run('/quest all abandon'); // no first-hour hold
  await run('/time 10');
  // a spot in open country with a sword at our feet
  const places = await page.evaluate(() => window.__lodestoneDev.state().places);
  const pts = [...places.towns, ...places.vaults, ...places.towers];
  let best = { d: 0, x: 1600, z: 1200 };
  for (let x = 800; x < 3300; x += 100) for (let z = 800; z < 3300; z += 100) {
    const d = Math.min(...pts.map((q) => Math.hypot(q.x - x, q.z - z)));
    if (d > best.d) best = { d, x, z };
  }
  const jx = best.x + Math.round((Math.random() - 0.5) * 200);
  const jz = best.z + Math.round((Math.random() - 0.5) * 200);
  await run(`/tp ${jx} ${jz}`);
  let lastY = -1e9;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const y = ((await pl(page)).pos ?? (await pl(page))).y;
    if (Math.abs(y - lastY) < 0.02 && i > 4) break;
    lastY = y;
  }
  const before = new Set((await pickups()).map((p) => p.id));
  await run('/give weapon:sunsteel_blade 1 rare');
  let h = null;
  for (let i = 0; i < 30 && h === null; i++) {
    await sleep(300);
    h = await page.evaluate(async () => ((await import('/src/ui/inventory/store.ts')).useInventory.getState().inv?.items ?? []).find((x) => x.b === 'weapon:sunsteel_blade' && x.s.startsWith('inv:'))?.h ?? null);
  }
  await page.evaluate(async (hh) => (await import('/src/ui/inventory/store.ts')).useInventory.getState().actions.item(hh, 2, 1), h);
  let drop;
  for (let i = 0; i < 24 && !drop; i++) {
    await sleep(250);
    drop = (await pickups()).find((p) => !before.has(p.id));
  }
  check('a sword on the ground at our feet', !!drop, drop);
  const me = (await pl(page)).pos ?? (await pl(page));
  await page.evaluate(([y]) => window.__lodestone.setLook(y, -0.3), [yawTo(me, drop.x / 100, drop.z / 100)]);
  await sleep(500);
  await page.evaluate(() => window.__lodestone.setLook(null));
  // stand still: the card comes up (2.5 s after the world is ready, once still for 1.2 s)
  let shown = false;
  for (let i = 0; i < 60 && !shown; i++) {
    await sleep(500);
    shown = await card();
  }
  const prompt = await page.evaluate(() => document.querySelector('[data-testid="loot-prompt"]')?.textContent ?? null);
  check('while an [E] prompt is up the card waits (or it came before the prompt)', !shown || prompt === null, { shown, prompt });
  if (!prompt) {
    // the card came up first: it holds E, E closes it
    check('the card is up', shown);
    await jpg('card-up');
    const hint = await page.evaluate(() => document.querySelector('[data-testid="whatsnew-hint"]')?.textContent ?? null);
    check('the card says how to close it', /E/.test(hint ?? ''), hint);
    await key('KeyE');
    await sleep(600);
    check('E closes the card', !(await card()));
  } else await jpg('prompt-first');
  await sleep(800);
  const prompt2 = await page.evaluate(() => document.querySelector('[data-testid="loot-prompt"]')?.textContent ?? null);
  check('the pickup prompt is back', !!prompt2, prompt2);
  await jpg('pickup-prompt');
  await key('KeyE');
  let gone = false;
  for (let i = 0; i < 12 && !gone; i++) {
    await sleep(250);
    gone = !(await pickups()).some((p) => p.id === drop.id);
  }
  check('E takes the sword', gone);
} catch (e) {
  console.log('SCRIPT ERROR', e?.stack ?? e);
} finally {
  writeFileSync('tmp/pt5-card/result.json', JSON.stringify(result, null, 2));
  await A.browser.close().catch(() => {});
}
