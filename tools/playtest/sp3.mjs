/* global document, window */
// Playtest pass 3: find the starter creatures, fight with the weapon and
// every slotted spell, loot, check feedback (numbers, hit sounds, kill XP).
import { launch, newCharacter, sleep, pl, walkTo, look, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/playtest3';
const t = await launch(out);
const { page, shot, note, issue } = t;
const hud = () => page.evaluate(() => window.__lodestoneCombat?.hud?.());
const drawn = () =>
  page.evaluate(() => {
    const me = window.__lodestone.player().pos;
    return (window.__lodestoneDrawn?.() ?? []).map((e) => ({ id: e.id, kind: e.kind, x: e.x, y: e.y, z: e.z, typeId: e.typeId, hp: e.healthPct, d: Math.hypot(e.x - me.x, e.z - me.z) })).sort((a, b) => a.d - b.d);
  });
const xp = () => page.evaluate(() => window.__lodestoneProgression?.state?.()?.stats ?? null).catch(() => null);

try {
  await newCharacter(page, 'Fighter' + (Date.now() % 100000));
  await sleep(5000);
  const all = await drawn();
  const kinds = {};
  for (const e of all) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  note(`drawn entities by kind: ${JSON.stringify(kinds)}; nearest enemies: ${JSON.stringify(all.filter((e) => e.kind === 2).slice(0, 5).map((e) => [e.typeId, Math.round(e.d)]))}`);
  let target = all.find((e) => e.kind === 2 && e.hp > 0);
  if (!target) {
    // wander out of town in a spiral until something shows up
    const p0 = (await pl(page)).pos;
    for (let i = 1; i <= 8 && !target; i++) {
      const a = i * 1.3;
      await walkTo(page, p0.x + Math.cos(a) * 40 * i, p0.z + Math.sin(a) * 40 * i, { stopAt: 5, timeoutMs: 25000, sprint: true });
      target = (await drawn()).find((e) => e.kind === 2 && e.hp > 0);
    }
  }
  if (!target) {
    issue('content', 'no creatures found within ~300 m of spawn');
  } else {
    note(`target type ${target.typeId} at ${target.d.toFixed(0)} m`);
    await walkTo(page, target.x, target.z, { stopAt: 6, timeoutMs: 60000, sprint: true });
    const before = await xp();
    await shot('approach');
    // spells first from range, then melee
    for (const slot of ['Digit1', 'Digit2', 'Digit3']) {
      const e = (await drawn()).find((x) => x.id === target.id);
      if (!e || e.hp <= 0) break;
      const me = (await pl(page)).pos;
      await look(page, yawTo(me, e.x, e.z), Math.atan2(e.y + 0.4 - (me.y + 1.6), Math.max(0.5, e.d)));
      await page.keyboard.press(slot);
      await sleep(250);
      await shot(`cast-${slot}`);
      await sleep(900);
      const after = (await drawn()).find((x) => x.id === target.id);
      note(`${slot}: target hp ${e.hp} -> ${after?.hp ?? 'gone'}`);
    }
    let swings = 0;
    for (let i = 0; i < 80; i++) {
      const e = (await drawn()).find((x) => x.id === target.id);
      if (!e || e.hp <= 0) break;
      const me = (await pl(page)).pos;
      await look(page, yawTo(me, e.x, e.z), Math.max(-0.5, Math.min(0.3, Math.atan2(e.y + 0.4 - (me.y + 1.6), Math.max(0.5, e.d)))));
      if (e.d > 2.3) {
        await page.keyboard.down('KeyW');
        await sleep(Math.min(400, (e.d - 2) * 160));
        await page.keyboard.up('KeyW');
        continue;
      }
      await page.mouse.down();
      await sleep(40);
      await page.mouse.up();
      swings++;
      if (swings === 2) await shot('melee');
      await sleep(260);
    }
    const left = (await drawn()).find((x) => x.id === target.id);
    note(`melee: ${swings} swings, target ${left ? `hp ${left.hp}` : 'gone'}`);
    await sleep(1500);
    await shot('after-kill');
    const after = await xp();
    note(`xp before ${JSON.stringify(before)?.slice(0, 120)} after ${JSON.stringify(after)?.slice(0, 120)}`);
    const pick = (await drawn()).filter((e) => e.kind === 4 && e.d < 15);
    note(`pickups nearby: ${pick.length}`);
    for (const p of pick) await walkTo(page, p.x, p.z, { stopAt: 0.5, timeoutMs: 8000 });
    const inv = await page.evaluate(() => (window.__lodestoneInventory?.state()?.inv?.items ?? []).map((i) => `${i.b}x${i.q}`));
    note(`inventory: ${inv.join(', ')}`);
  }
  const h = await hud();
  note(`hud after: ${JSON.stringify(h)?.slice(0, 300)}`);
} catch (e) {
  issue('script', String(e?.stack ?? e).slice(0, 600));
  await shot('error').catch(() => {});
} finally {
  t.save();
  await t.browser.close();
}
