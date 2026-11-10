// Playtest pass 10: play the new-player quest "Slimes in the meadows" start
// to finish like a player (talk to the giver, kill the slimes at the marked
// packs, go back, hand in), then check the hand-off to the blacksmith.
import { launch, newCharacter, sleep, pl, go, look, yawTo, dismissCards } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/playtest10';
const t = await launch(out);
const { page, shot, note, issue } = t;
const tracked = () => page.evaluate(() => window.__lodestoneQuests?.tracked?.() ?? null);
const drawn = () =>
  page.evaluate(() => {
    const me = window.__lodestone.player().pos;
    return (window.__lodestoneDrawn?.() ?? []).map((e) => ({ id: e.id, kind: e.kind, x: e.x, y: e.y, z: e.z, hp: e.healthPct, d: Math.hypot(e.x - me.x, e.z - me.z) })).sort((a, b) => a.d - b.d);
  });

async function talkAt(m0) {
  // the marker follows the person (they walk about); refresh it as we go
  let m = m0;
  for (let i = 0; i < 4; i++) {
    await go(page, m.x, m.z, { stopAt: 2.2, timeoutMs: 45000 });
    const q = await tracked();
    const nm = q?.markers?.[0];
    if (!nm || Math.hypot(nm.x - m.x, nm.z - m.z) < 2) break;
    m = nm;
  }
  const npc = (await drawn()).filter((e) => e.kind === 5).sort((a, b) => Math.hypot(a.x - m.x, a.z - m.z) - Math.hypot(b.x - m.x, b.z - m.z))[0];
  const me = (await pl(page)).pos;
  if (npc) {
    if (Math.hypot(npc.x - me.x, npc.z - me.z) > 2.5) await go(page, npc.x, npc.z, { stopAt: 2, timeoutMs: 20000 });
    const p = (await pl(page)).pos;
    await look(page, yawTo(p, npc.x, npc.z), Math.atan2(npc.y + 1.3 - (p.y + 1.6), Math.max(0.5, Math.hypot(npc.x - p.x, npc.z - p.z))));
  }
  await dismissCards(page); // a modal card holds E (the welcome comes up a few seconds in)
  await sleep(400);
  const prompt = await page.evaluate(() => document.querySelector('[data-testid="town-prompt"]')?.textContent ?? '');
  await page.keyboard.press('KeyE');
  await sleep(1200);
  const panel = await page.evaluate(() => document.querySelector('[data-testid="town-panel"]')?.innerText ?? '');
  // accept / hand in buttons if the panel offers them
  for (const label of ['Accept', 'Hand in', 'Complete', 'Turn in']) {
    const b = page.locator('[data-testid="town-panel"] button', { hasText: label }).first();
    if (await b.count()) await b.click().catch(() => {});
  }
  await page.keyboard.press('Escape');
  await sleep(800);
  return { prompt, panel: panel.slice(0, 300).replace(/\n/g, ' | ') };
}

async function fightNear(x, z, ms) {
  const t0 = Date.now();
  let kills = 0;
  while (Date.now() - t0 < ms) {
    await dismissCards(page);
    const e = (await drawn()).find((v) => v.kind === 2 && v.hp > 0 && Math.hypot(v.x - x, v.z - z) < 40);
    if (!e) {
      await sleep(500);
      if (!(await drawn()).some((v) => v.kind === 2 && v.hp > 0 && Math.hypot(v.x - x, v.z - z) < 40)) break;
      continue;
    }
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
    await sleep(260);
    const after = (await drawn()).find((v) => v.id === e.id);
    if (!after || after.hp <= 0) kills++;
  }
  return kills;
}

try {
  const t0 = Date.now();
  await newCharacter(page, 'Meadow' + (Date.now() % 100000));
  await sleep(4000);
  await dismissCards(page);
  let q = await tracked();
  note(`start: ${q?.title} step ${q?.step} "${q?.text}"`);
  const r1 = await talkAt(q.markers[0]);
  note(`talk 1: prompt "${r1.prompt}" panel "${r1.panel}"`);
  q = await tracked();
  note(`after talk: step ${q?.step} "${q?.text}" (${q?.progress}/${q?.need}) markers ${q?.markers?.length}`);
  if (q?.step !== 1) issue('quest', 'talking to the giver did not start the slime hunt');
  for (let round = 0; round < 8 && q && q.step === 1; round++) {
    // the marked packs in turn, nearest first, moving on when one is empty
    const me = (await pl(page)).pos;
    const ms = q.markers.slice().sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z));
    const target = ms[round % ms.length];
    await go(page, target.x, target.z, { stopAt: 15, timeoutMs: 90000, sprint: true });
    await sleep(1500);
    const k = await fightNear(target.x, target.z, 60000);
    q = await tracked();
    note(`round ${round} at ${target.label ?? 'marker'}: killed ~${k}; quest ${q?.progress}/${q?.need} step ${q?.step}`);
    if (round === 0) await shot('slimes');
  }
  if (q?.step === 1) issue('quest', `could not finish the slime hunt (${q?.progress}/${q?.need})`);
  if (q?.step === 2) {
    const r2 = await talkAt(q.markers[0]);
    note(`hand in: "${r2.panel}"`);
    await sleep(1500);
    q = await tracked();
    note(`after hand-in: ${q?.title} step ${q?.step} "${q?.text}"`);
    await shot('handed-in');
    if (q?.title === 'Slimes in the meadows') issue('quest', 'hand-in did not complete the quest');
  }
  const inv = await page.evaluate(() => (window.__lodestoneInventory?.state()?.inv?.items ?? []).map((i) => `${i.b}x${i.q}`));
  note(`inventory: ${inv.join(', ')}; total ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} catch (e) {
  issue('script', String(e?.stack ?? e).slice(0, 600));
  await shot('error').catch(() => {});
} finally {
  t.save();
  await t.browser.close();
}
