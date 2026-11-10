// Playtest 2 bow rework (CR 033) evidence: on a dev zone an archer equips an
// oak bow from the dev console, holds the LEFT mouse button to draw and lets
// go to shoot, in first and in third person, while a second player standing
// beside them watches. Captures docs/evidence/pt2-bow-*.jpg and checks, in
// the client's own state, that the draw grew with the hold, that the shot was
// bow_charged at full draw (no refusal from the zone), that a tap still drew
// the minimum, and that the observer saw the draw (their avatar of the archer
// posed 'draw', string back) and the release.
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/bow-shots.mjs [outDir]
import { writeFileSync } from 'node:fs';
import { launch, newCharacter, sleep, dismissCards, pl, look, BASE } from './lib.mjs';

const out = process.argv[2] ?? 'docs/evidence';
const W = 1280;
const H = 720;
const t = await launch('tmp/bow', { width: W, height: H });
const { page, note, issue, browser } = t;
const result = {};
const run = (p, line) => p.evaluate((l) => window.__lodestoneDev.run(l), line);
const jpg = (p, name) => p.screenshot({ path: `${out}/pt2-bow-${name}.jpg`, type: 'jpeg', quality: 70 });
/** The archer's timeline and newest start (client prediction, corrected by the zone's refusals). */
const state = (p) =>
  p.evaluate(async () => {
    const rt = (await import('/src/combat/link.ts')).combatRuntime.current;
    const s = rt?.lastStarted;
    return { weapon: rt?.weaponName(), held: rt?.timeline.heldSteps, draw: rt?.timeline.drawFrac, started: rt?.startedCount, last: s ? { key: s.move?.key ?? s.spell?.key, charge: s.charge, seq: s.seq } : null };
  });

try {
  await newCharacter(page, `Bow${Date.now().toString(36).slice(-4)}`);
  await sleep(1500);
  await dismissCards(page);
  await page.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 20000 });
  await run(page, '/equip oak_bow');
  await run(page, '/god');
  await run(page, '/time 11:00');
  await run(page, '/weather clear');
  await page.waitForFunction(async () => (await import('/src/combat/link.ts')).combatRuntime.current?.weaponName() === 'bow', null, { timeout: 10000 });
  note('oak bow equipped');
  // Refused shots come back as Event 207 (cast_refused): count them from here on.
  await page.evaluate(async () => {
    const { useCombatHud } = await import('/src/combat/store.ts');
    window.__bowRefused = 0;
    useCombatHud.subscribe((s, prev) => {
      if (s.refused && s.refused !== prev.refused && (s.refused.id === 301 || s.refused.id === 302)) window.__bowRefused++;
    });
  });

  // The observer: a second player (own context) brought next to the archer, facing them side-on.
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const obs = await ctx.newPage();
  obs.on('pageerror', (e) => issue('observer pageerror', e.message));
  await newCharacter(obs, `Eye${Date.now().toString(36).slice(-4)}`);
  await sleep(1000);
  await dismissCards(obs);
  await obs.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 20000 });
  // into the open (the spawn is in the town square, among stalls and pillars), the observer 3.5 m to the archer's right, side-on
  const sp = await pl(page);
  await run(page, `/tp ${Math.round(sp.pos.x + 30)} ${Math.round(sp.pos.z + 34)}`);
  await sleep(1500);
  const me = await pl(page);
  await run(obs, `/tp ${Math.round(me.pos.x + 3.5)} ${Math.round(me.pos.z - 1)}`);
  await run(obs, '/god');
  await page.keyboard.press('F3'); // the debug readout off for the pictures
  await obs.keyboard.press('F3');
  await sleep(11000); // terrain loaded, the area title faded
  for (const p of [page, obs]) {
    await dismissCards(p);
    const go = p.getByRole('button', { name: "Let's go" });
    if (await go.isVisible().catch(() => false)) await go.click().catch(() => {});
    const tip = p.getByTestId('tip-close');
    if (await tip.isVisible().catch(() => false)) await tip.click().catch(() => {});
  }
  await sleep(500);
  const aimYaw = 0.0;
  await look(page, aimYaw, 0.05);
  const op = await pl(obs);
  await look(obs, Math.atan2(-(me.pos.x - op.pos.x), -(me.pos.z - op.pos.z)), -0.12);
  await obs.bringToFront().catch(() => {});
  await page.bringToFront().catch(() => {});

  // ---- first person: hold the left button ~1 s ----
  await page.mouse.move(W / 2, H / 2);
  const before = await state(page);
  await page.mouse.down();
  await sleep(380);
  const partial = await state(page);
  await jpg(page, 'fp-partial');
  // the observer sees the draw under way
  const archer = (p) => p.evaluate(() => (window.__lodestoneAvatars?.() ?? []).filter((a) => a.weapon === 'bow').map((a) => ({ action: a.action, held: a.held, bowDraw: Math.round(a.bowDraw * 100) / 100 })));
  const seen = await archer(obs).catch(() => null);
  await sleep(Math.max(0, 1250 - 380 - 250));
  const full = await state(page);
  await jpg(page, 'fp-full');
  const theirs = await archer(obs).catch(() => null);
  await jpg(obs, 'observer-drawn');
  await page.mouse.up();
  await sleep(90);
  await jpg(page, 'fp-loose');
  await sleep(700);
  const shot = await state(page);
  const after = await archer(obs).catch(() => null);
  result.fp = { before, partial, full, shot };
  result.observer = { partial: seen, full: theirs, after };
  if (!theirs?.some((a) => a.action === 'draw' && a.bowDraw > 0.6)) issue('observer', `no drawn archer seen: ${JSON.stringify(theirs)}`);
  if (!(partial.draw > 0.15 && partial.draw < 0.75)) issue('fp', `partial draw ${partial.draw}`);
  if (!(full.draw >= 1)) issue('fp', `full draw ${full.draw}`);
  if (shot.last?.key !== 'bow_charged' || shot.last.charge < 0.99 || shot.started !== before.started + 1) issue('fp', `shot ${JSON.stringify(shot.last)} started ${before.started} -> ${shot.started}`);

  // ---- a tap: a weak shot after the minimum draw ----
  await sleep(500);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(600);
  const tap = await state(page);
  result.tap = tap.last;
  if (tap.last?.key !== 'bow_charged' || !(tap.last.charge > 0.1 && tap.last.charge < 0.3)) issue('tap', JSON.stringify(tap.last));

  // ---- third person ----
  await page.keyboard.press('KeyT');
  await sleep(900);
  await page.mouse.down();
  await sleep(420);
  result.tpPartial = await state(page);
  await jpg(page, 'tp-partial');
  await sleep(700);
  result.tpFull = await state(page);
  await jpg(page, 'tp-full');
  await page.mouse.up();
  await sleep(700);
  result.tpShot = (await state(page)).last;
  if (result.tpShot?.key !== 'bow_charged' || result.tpShot.charge < 0.99) issue('tp', JSON.stringify(result.tpShot));
  result.refused = await page.evaluate(() => window.__bowRefused);
  if (result.refused) issue('zone', `${result.refused} refusals`);
  await page.keyboard.press('KeyT');
  await ctx.close();
} catch (e) {
  issue('exception', String(e?.stack ?? e));
  await page.screenshot({ path: 'tmp/bow/fail.jpg', type: 'jpeg', quality: 60 }).catch(() => {});
} finally {
  writeFileSync('tmp/bow/result.json', JSON.stringify({ base: BASE, result, issues: t.issues }, null, 2));
  note(JSON.stringify(result));
  await browser.close();
}
