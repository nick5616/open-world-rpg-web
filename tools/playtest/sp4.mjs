// Playtest pass 4: walk to the nearest creature group around spawn (positions
// from the zone's /debug/combat), fight it with weapon and spells, loot.
import { launch, newCharacter, sleep, pl, go, look, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/playtest4';
const ZONE = process.env.LODESTONE_ZONE_DEBUG ?? 'http://127.0.0.1:8092';
const t = await launch(out);
const { page, shot, note, issue } = t;
const drawn = () =>
  page.evaluate(() => {
    const me = window.__lodestone.player().pos;
    return (window.__lodestoneDrawn?.() ?? []).map((e) => ({ id: e.id, kind: e.kind, x: e.x, y: e.y, z: e.z, typeId: e.typeId, hp: e.healthPct, d: Math.hypot(e.x - me.x, e.z - me.z) })).sort((a, b) => a.d - b.d);
  });
const groups = async () => (await (await fetch(`${ZONE}/debug/combat`)).json()).groups;

try {
  await newCharacter(page, 'Hunter' + (Date.now() % 100000));
  await sleep(4000);
  const me0 = (await pl(page)).pos;
  const near = (await groups()).filter((g) => g.kind === 'pack').map((g) => ({ ...g, d: Math.hypot(g.x - me0.x, g.z - me0.z) })).sort((a, b) => a.d - b.d);
  const g = near[0];
  note(`nearest pack ${g.d.toFixed(0)} m at (${g.x.toFixed(0)}, ${g.z.toFixed(0)})`);
  const w = await go(page, g.x, g.z, { stopAt: 25, timeoutMs: 90000, sprint: true });
  note(`walk: ok=${w.ok} left ${w.d.toFixed(0)} m in ${(w.ms / 1000).toFixed(0)} s`);
  await sleep(1500);
  const gs = (await groups()).find((x) => x.id === g.id);
  note(`group now spawned=${gs.spawned} alive=${gs.alive} members=${gs.members}`);
  const d = await drawn();
  const kinds = {};
  for (const e of d) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  note(`drawn by kind ${JSON.stringify(kinds)}; nearest ${JSON.stringify(d.slice(0, 4).map((e) => [e.kind, e.typeId, Math.round(e.d), e.hp]))}`);
  await shot('pack');
  const foes = d.filter((e) => e.kind === 2 && e.hp > 0);
  if (!foes.length) issue('content', 'pack spawned but nothing drawn as an enemy');
  let target = foes[0];
  let swings = 0;
  let casts = 0;
  const t0 = Date.now();
  while (target && Date.now() - t0 < 90000) {
    const cur = (await drawn()).find((x) => x.id === target.id);
    if (!cur || cur.hp <= 0) {
      target = (await drawn()).find((e) => e.kind === 2 && e.hp > 0 && e.d < 30);
      continue;
    }
    const me = (await pl(page)).pos;
    await look(page, yawTo(me, cur.x, cur.z), Math.max(-0.5, Math.min(0.3, Math.atan2(cur.y + 0.4 - (me.y + 1.6), Math.max(0.5, cur.d)))));
    if (cur.d > 8 && casts < 6) {
      await page.keyboard.press(casts % 2 ? 'Digit2' : 'Digit1');
      casts++;
      if (casts === 1) {
        await sleep(200);
        await shot('cast');
      }
      await sleep(600);
      continue;
    }
    if (cur.d > 2.3) {
      await page.keyboard.down('KeyW');
      await sleep(Math.min(400, (cur.d - 2) * 160));
      await page.keyboard.up('KeyW');
      continue;
    }
    await page.mouse.down();
    await sleep(40);
    await page.mouse.up();
    swings++;
    if (swings === 3) await shot('melee');
    await sleep(260);
  }
  const h = await page.evaluate(() => window.__lodestoneCombat?.hud?.());
  note(`fight: ${swings} swings, ${casts} casts, hp ${h?.health}/${h?.healthMax}, enemies left ${(await drawn()).filter((e) => e.kind === 2 && e.hp > 0 && e.d < 30).length}`);
  await sleep(1500);
  await shot('after');
  const inv = await page.evaluate(() => (window.__lodestoneInventory?.state()?.inv?.items ?? []).map((i) => `${i.b}x${i.q}`));
  note(`inventory: ${inv.join(', ')}`);
} catch (e) {
  issue('script', String(e?.stack ?? e).slice(0, 600));
  await shot('error').catch(() => {});
} finally {
  t.save();
  await t.browser.close();
}
