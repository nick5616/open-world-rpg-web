// Playtest pass 6: walk to the nearest crystal tower, climb it like a player
// (hold W into the wall, rest on a ledge when the stamina wheel runs low),
// attune at the top, read what the map and boons say.
import { launch, newCharacter, sleep, pl, go, look, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/playtest6';
const t = await launch(out);
const { page, shot, note, issue } = t;
const until = async (fn, arg, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg)) return true;
    await sleep(150);
  }
  return false;
};
try {
  await newCharacter(page, 'Climber' + (Date.now() % 100000));
  await page.waitForFunction(() => window.__lodestoneMap?.towers?.().length > 0, null, { timeout: 120000 });
  await sleep(3000);
  const p0 = (await pl(page)).pos;
  const towers = await page.evaluate(() => window.__lodestoneMap.towers());
  const tw = towers.map((x) => ({ ...x, d: Math.hypot(x.x - p0.x, x.z - p0.z) })).sort((a, b) => a.d - b.d)[0];
  note(`nearest tower "${tw.name}" ${tw.d.toFixed(0)} m, top y ${tw.topY.toFixed(1)} (ground ${p0.y.toFixed(1)})`);
  const stage = { x: tw.x - (tw.maxR + 1.5), z: tw.z };
  const w = await go(page, tw.x - 60, tw.z, { stopAt: 3, timeoutMs: 240000, sprint: true });
  note(`walk to tower: ok=${w.ok} ${(w.ms / 1000).toFixed(0)} s`);
  await go(page, stage.x, stage.z, { stopAt: 1, timeoutMs: 30000 });
  await look(page, yawTo((await pl(page)).pos, tw.x, tw.z), 0.4);
  await sleep(500);
  await shot('tower-base');
  const t0 = Date.now();
  let rests = 0;
  let falls = 0;
  for (let i = 0; i < 8; i++) {
    await until(() => window.__lodestone.player().stamina >= 99 && !window.__lodestone.player().exhausted, null, 60000);
    await look(page, yawTo((await pl(page)).pos, tw.x, tw.z), 0.45);
    await page.keyboard.down('KeyW');
    await until(() => window.__lodestone.player().mode === 'climb', null, 15000);
    await until((top) => {
      const p = window.__lodestone.player();
      return p.mode !== 'climb' && p.mode !== 'air';
    }, tw.topY, 240000);
    await page.keyboard.up('KeyW');
    const p = await pl(page);
    if (p.pos.y >= tw.topY - 0.5) break;
    if (p.pos.y < p0.y + 3) falls++;
    else rests++;
    note(`stopped climbing at y ${p.pos.y.toFixed(1)} (stamina ${p.stamina.toFixed(0)}, mode ${p.mode})`);
    if (i === 1) await shot('climb');
  }
  const top = await pl(page);
  note(`climb: reached y ${top.pos.y.toFixed(1)} / ${tw.topY.toFixed(1)} in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${rests} rests, ${falls} falls`);
  if (top.pos.y < tw.topY - 0.5) issue('tower', `could not climb the tower (${falls} falls)`);
  await sleep(800);
  await shot('tower-top');
  const prompt = await page.evaluate(() => document.body.innerText.match(/\[E\][^\n]*/)?.[0] ?? '');
  note(`prompt on top: ${prompt}`);
  // walk toward the crystal at the centre until the attune prompt shows
  for (let i = 0; i < 20 && !/Attune/.test(await page.evaluate(() => document.body.innerText)); i++) {
    const p = (await pl(page)).pos;
    await look(page, yawTo(p, tw.x, tw.z), 0);
    await page.keyboard.down('KeyW');
    await sleep(250);
    await page.keyboard.up('KeyW');
  }
  await page.keyboard.press('KeyE');
  await sleep(3000);
  await shot('attuned');
  const st = await page.evaluate(() => window.__lodestoneMap.state());
  note(`after attune: revealed ${st.revealed}, towers ${st.towersUnlocked}, waypoints ${st.waypointsUnlocked}, level ${st.level}, xp ${st.xp}`);
  if (!st.towersUnlocked) issue('tower', 'attuning did not unlock the tower');
  await page.keyboard.press('KeyM');
  await sleep(1500);
  await shot('map-after-attune');
} catch (e) {
  issue('script', String(e?.stack ?? e).slice(0, 600));
  await shot('error').catch(() => {});
} finally {
  t.save();
  await t.browser.close();
}
