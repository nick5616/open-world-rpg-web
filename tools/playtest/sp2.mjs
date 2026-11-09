// Playtest pass 2: follow the starter quest like a new player (talk, walk to
// the marker, mine), fighting what attacks on the way. Logs every snag.
import { launch, newCharacter, sleep, pl, walkTo, look, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/playtest2';
const t = await launch(out);
const { page, shot, note, issue } = t;
const tracked = () => page.evaluate(() => window.__lodestoneQuests?.tracked?.());
const hud = () => page.evaluate(() => window.__lodestoneCombat?.hud?.());
const inv = () => page.evaluate(() => (window.__lodestoneInventory?.state()?.inv?.items ?? []).map((i) => `${i.b}x${i.q}`));
const enemies = () =>
  page.evaluate(() => {
    const me = window.__lodestone.player().pos;
    return (window.__lodestoneDrawn?.() ?? []).filter((e) => e.kind === 2 && e.healthPct > 0).map((e) => ({ id: e.id, x: e.x, y: e.y, z: e.z, typeId: e.typeId, d: Math.hypot(e.x - me.x, e.z - me.z) })).sort((a, b) => a.d - b.d);
  });

async function fightNearby(radius = 12, ms = 30000) {
  const t0 = Date.now();
  let swings = 0;
  for (;;) {
    if (Date.now() - t0 > ms) break;
    const list = await enemies();
    const e = list.find((x) => x.d < radius);
    if (!e) break;
    const me = (await pl(page)).pos;
    await look(page, yawTo(me, e.x, e.z), Math.max(-0.5, Math.min(0.3, Math.atan2(e.y + 0.5 - (me.y + 1.6), Math.max(0.5, e.d)))));
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
    await sleep(250);
  }
  return swings;
}

try {
  await newCharacter(page, 'Quester' + (Date.now() % 100000));
  await sleep(5000);
  let q = await tracked();
  note(`quest step ${q?.step}: ${q?.text} markers ${JSON.stringify(q?.markers)}`);
  // 1. talk to the giver
  const m = q.markers[0];
  const w = await walkTo(page, m.x, m.z, { stopAt: 2.2, timeoutMs: 60000 });
  note(`walked to ${m.label}: ok=${w.ok} d=${w.d.toFixed(1)} in ${(w.ms / 1000).toFixed(1)} s`);
  const me = (await pl(page)).pos;
  await look(page, yawTo(me, m.x, m.z), 0);
  await sleep(600);
  await shot('at-giver');
  const prompt = await page.evaluate(() => document.querySelector('[data-testid="town-prompt"]')?.textContent ?? '');
  note(`prompt: ${prompt}`);
  if (!prompt) issue('quest', 'no interaction prompt next to the quest giver');
  await page.keyboard.press('KeyE');
  await sleep(1200);
  await shot('talk');
  const panel = await page.evaluate(() => document.querySelector('[data-testid="town-panel"]')?.innerText ?? '');
  note(`town panel: ${panel.slice(0, 600).replace(/\n/g, ' | ')}`);
  await page.keyboard.press('Escape');
  await sleep(800);
  q = await tracked();
  note(`quest step ${q?.step}: ${q?.text} (${q?.progress}/${q?.need}) markers ${JSON.stringify(q?.markers)}`);
  if (q?.step === 0) issue('quest', 'talking to the giver did not advance the quest');
  note(`inventory: ${(await inv()).join(', ')}`);
  // 2. go to the ore
  const ore = q?.markers?.[0];
  if (ore) {
    const start = (await pl(page)).pos;
    note(`ore marker ${ore.label} at ${Math.hypot(ore.x - start.x, ore.z - start.z).toFixed(0)} m`);
    const legs = [];
    const t0 = Date.now();
    let res;
    for (let i = 0; i < 40; i++) {
      res = await walkTo(page, ore.x, ore.z, { stopAt: 4, timeoutMs: 15000, sprint: true });
      const h = await hud();
      const near = (await enemies()).filter((e) => e.d < 10);
      if (near.length) {
        const s = await fightNearby(12, 40000);
        legs.push(`fought ${near.length} (${s} swings, hp ${h?.health}/${h?.healthMax})`);
      }
      if (res.ok || Date.now() - t0 > 420000) break;
      if (i % 4 === 3) await shot(`travel-${i}`);
    }
    note(`travel: ok=${res.ok} d=${res.d.toFixed(0)} after ${((Date.now() - t0) / 1000).toFixed(0)} s; ${legs.join('; ')}`);
    await shot('at-ore');
    if (!res.ok) issue('travel', `could not reach the ore marker (${res.d.toFixed(0)} m left)`);
    // 3. mine: look at the nearest vein and swing
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('KeyE');
      await sleep(900);
    }
    await shot('mining');
    q = await tracked();
    note(`after mining: step ${q?.step} ${q?.text} (${q?.progress}/${q?.need}); inventory ${(await inv()).join(', ')}`);
  }
  const h = await hud();
  note(`hud: hp ${h?.health}/${h?.healthMax} level ${h?.level}`);
} catch (e) {
  issue('script', String(e?.stack ?? e).slice(0, 600));
  await shot('error').catch(() => {});
} finally {
  t.save();
  await t.browser.close();
}
