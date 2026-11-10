// Playtest pass 7: the spawn town's forge and anvil (crafting UI as a new
// player sees it), a merchant's shop, and buying something.
import { launch, newCharacter, sleep, pl, go, look, yawTo, hudBoxes, overlaps, dismissCards } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/playtest7';
const t = await launch(out);
const { page, shot, note, issue } = t;
try {
  await newCharacter(page, 'Smith' + (Date.now() % 100000));
  await page.waitForFunction(() => !!window.__lodestoneTowns?.settlements?.().length, null, { timeout: 120000 });
  await sleep(3000);
  const town = await page.evaluate(() => {
    const T = window.__lodestoneTowns;
    const me = window.__lodestone.player().pos;
    const s = T.settlements().map((x) => ({ ...x, d: Math.hypot(x.x - me.x, x.z - me.z) })).sort((a, b) => a.d - b.d)[0];
    return { index: s.index, name: s.name, forge: T.props(s.index, 10)[0], anvil: T.props(s.index, 11)[0], merchants: T.npcs(s.index).filter((n) => n.merchant !== 255).map((n) => ({ name: n.name, role: n.role, x: n.x, z: n.z })) };
  });
  note(`town ${town.name}: forge ${JSON.stringify(town.forge)?.slice(0, 120)}, merchants ${town.merchants.length}`);
  for (const [label, prop] of [
    ['forge', town.forge],
    ['anvil', town.anvil],
  ]) {
    if (!prop) {
      issue('town', `no ${label} in the spawn town`);
      continue;
    }
    await dismissCards(page); // the welcome card (a new browser) waits for the first panel to close, then holds E
    await go(page, prop.x, prop.z, { stopAt: 2, timeoutMs: 60000 });
    const me = (await pl(page)).pos;
    await look(page, yawTo(me, prop.x, prop.z), -0.35);
    await sleep(500);
    const prompt = await page.evaluate(() => document.querySelector('[data-testid="town-prompt"]')?.textContent ?? '');
    note(`${label} prompt: ${prompt}`);
    await page.keyboard.press('KeyE');
    await sleep(1200);
    await shot(label);
    const panel = await page.evaluate(() => document.querySelector('[data-testid="craft-panel"]')?.innerText ?? '');
    note(`${label} panel: ${panel.slice(0, 400).replace(/\n/g, ' | ')}`);
    if (!panel) issue('craft', `${label}: no craft panel after E`);
    const o = overlaps(await hudBoxes(page));
    if (o.length) issue('hud-overlap', `${label} open: ${o.join('; ')}`);
    await page.keyboard.press('Escape');
    await sleep(600);
  }
  const m = town.merchants.find((x) => x.role !== 1) ?? town.merchants[0];
  if (m) {
    await dismissCards(page);
    await go(page, m.x, m.z, { stopAt: 2, timeoutMs: 60000 });
    const npc = await page.evaluate(([mx, mz]) => (window.__lodestoneDrawn?.() ?? []).filter((e) => e.kind === 5).map((e) => ({ x: e.x, y: e.y, z: e.z, d: Math.hypot(e.x - mx, e.z - mz) })).sort((a, b) => a.d - b.d)[0], [m.x, m.z]);
    const me = (await pl(page)).pos;
    if (npc) await look(page, yawTo(me, npc.x, npc.z), Math.atan2(npc.y + 1.3 - (me.y + 1.6), Math.max(0.5, Math.hypot(npc.x - me.x, npc.z - me.z))));
    await sleep(400);
    await page.keyboard.press('KeyE');
    await sleep(1200);
    await shot('merchant');
    const panel = await page.evaluate(() => document.querySelector('[data-testid="town-panel"]')?.innerText ?? '');
    note(`merchant ${m.name}: ${panel.slice(0, 500).replace(/\n/g, ' | ')}`);
    const buy = page.locator('[data-testid="town-panel"] button', { hasText: 'Buy' }).first();
    if (await buy.count()) {
      const gold0 = await page.evaluate(() => window.__lodestoneInventory?.state()?.inv?.items?.find((i) => i.b === 'currency:gold')?.q ?? 0);
      await buy.click();
      await sleep(1500);
      const gold1 = await page.evaluate(() => window.__lodestoneInventory?.state()?.inv?.items?.find((i) => i.b === 'currency:gold')?.q ?? 0);
      note(`bought first item: gold ${gold0} -> ${gold1}`);
      await shot('after-buy');
    }
  }
} catch (e) {
  issue('script', String(e?.stack ?? e).slice(0, 600));
  await shot('error').catch(() => {});
} finally {
  t.save();
  await t.browser.close();
}
