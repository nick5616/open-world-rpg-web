// Playtest 2 visible armor (CR 034) evidence, two players on a private dev
// stack: the Knight equips a helm, body and legs through the dev console;
// the Watcher (another browser context: its own local profile) must see the
// very same appearance the zone put in the Knight's inventory; unequipping
// clears it for both; a rejoin keeps it. Screenshots:
//   docs/evidence/pt2-armor-observer.jpg   the Knight's own third person | the Watcher's view of the Knight (front)
//   docs/evidence/pt2-armor-back.jpg       the Watcher behind the Knight | the Knight's own third person
//   docs/evidence/pt2-armor-fp.jpg         the Knight in first person: armored forearms
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/armor-shots.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { BASE, newCharacter, sleep, dismissCards, pl } from './lib.mjs';

const out = process.argv[2] ?? 'docs/evidence';
const tmp = 'tmp/armor';
mkdirSync(tmp, { recursive: true });
const result = {};
const issues = [];
const note = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const issue = (k, t) => {
  issues.push({ k, t });
  note(`ISSUE ${k}: ${t}`);
};

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = async () => {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => issue('pageerror', e.message));
  return p;
};
const run = (p, line) => p.evaluate((l) => window.__lodestoneDev.run(l), line);
const ownAp = (p) => p.evaluate(async () => (await import('/src/ui/inventory/store.ts')).useInventory.getState().inv?.ap ?? null);
const seen = (p, id) => p.evaluate((i) => window.__lodestoneAvatars?.().find((a) => a.id === i) ?? null, id);
const selfId = (p) => p.evaluate(async () => (await import('/src/combat/link.ts')).combatRuntime.current?.selfId() ?? 0);
const png = (p) => p.screenshot({ type: 'png' });
/** No welcome card, no debug HUD, no tips: just the game. */
async function clean(p) {
  // the welcome card can arrive a moment after joining: wait for it, then close it
  const close = p.getByTestId('whatsnew-close');
  await close.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
  for (let i = 0; i < 4 && (await close.isVisible().catch(() => false)); i++) {
    await close.click({ force: true }).catch(() => {});
    await sleep(300);
  }
  for (let i = 0; i < 3 && (await p.getByTestId('tip-close').isVisible().catch(() => false)); i++) {
    await p.getByTestId('tip-close').click({ force: true }).catch(() => {});
    await sleep(300);
  }
  if (await p.getByTestId('debug-hud').isVisible().catch(() => false)) await p.keyboard.press('F3');
  await sleep(300);
  if (await p.getByTestId('debug-hud').isVisible().catch(() => false)) await p.keyboard.press('F3');
}
/** Photo mode (L): the free camera where the eye is, no HUD, no view model. */
const photo = async (p, on) => {
  const now = await p.evaluate(async () => (await import('/src/state/live.ts')).view.photo);
  if (now !== on) await p.keyboard.press('KeyL');
  await sleep(500);
  if (on) {
    await p.keyboard.press('KeyH'); // hide the photo panel
    // lift the free camera out of your own head (photo mode draws your body: it stays below the view)
    await p.keyboard.down('KeyE');
    await sleep(260);
    await p.keyboard.up('KeyE');
    await sleep(400);
  }
};

/** Two screenshots side by side in one jpg (composed in a blank page). */
async function sideBySide(name, left, right, labels) {
  const p = await page();
  await p.setViewportSize({ width: 1920, height: 600 });
  const src = (b) => `data:image/png;base64,${b.toString('base64')}`;
  await p.setContent(
    `<body style="margin:0;background:#111;display:flex">${[left, right]
      .map((b, i) => `<div style="position:relative"><img src="${src(b)}" width="960" height="600"><div style="position:absolute;left:10px;top:8px;font:600 15px system-ui;color:#fff;text-shadow:0 1px 3px #000">${labels[i]}</div></div>`)
      .join('')}</body>`,
  );
  await p.screenshot({ path: `${out}/pt2-armor-${name}.jpg`, type: 'jpeg', quality: 72 });
  await p.context().close();
  note(`shot pt2-armor-${name}.jpg`);
}

/** Wait until `p` draws entity `id` wearing `ap` (returns what it saw). */
async function waitSeen(p, id, ap, what, ms = 8000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await seen(p, id);
    if (last && last.appearance === ap) return last;
    await sleep(250);
  }
  issue(what, `watcher sees ${JSON.stringify(last && { appearance: last.appearance, armor: last.armor, lod: last.lod })}, want ${ap}`);
  return last;
}

try {
  const A = await page();
  const B = await page();
  const knight = `Knight${Date.now().toString(36).slice(-4)}`;
  await newCharacter(A, knight);
  await newCharacter(B, `Watch${Date.now().toString(36).slice(-4)}`);
  await sleep(1500);
  await dismissCards(A);
  await dismissCards(B);
  for (const p of [A, B]) await p.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 30000 });
  await run(A, '/weather clear'); // daylight and a clear sky for the pictures (a dev zone's clock is shared)
  await run(A, '/time 10:30');
  const aId = await selfId(A);
  result.knightId = aId;
  // Gear: a mythic starmetal helm with an aquamarine inlay, a legendary silver cuirass, iron greaves.
  for (const line of ['/equip starmetal_helm mythic gem=aquamarine', '/equip silver_cuirass legendary', '/equip iron_greaves rare', '/equip weapon:iron_sword']) {
    const r = await run(A, line);
    note(`${line} -> ${JSON.stringify(r)?.slice(0, 120)}`);
  }
  await sleep(1500);
  const ap = await ownAp(A);
  result.equipped = ap;
  if (!ap) issue('equip', 'no appearance in the inventory after equipping');
  // The Knight stands still facing north (-Z); the Watcher 3.2 m in front, looking back at them.
  // an open bit of the square, away from the market stalls
  const p0 = (await pl(A)).pos;
  await run(A, `/tp ${(p0.x + 6).toFixed(1)} ${(p0.z - 7).toFixed(1)}`);
  await sleep(2500);
  const pa = (await pl(A)).pos;
  await A.evaluate(() => window.__lodestone.setLook(0, 0));
  await run(B, `/tp ${(pa.x).toFixed(1)} ${(pa.z - 4.2).toFixed(1)}`);
  await sleep(2500);
  await B.evaluate(() => window.__lodestone.setLook(Math.PI, -0.12));
  const sawOn = await waitSeen(B, aId, ap, 'observer-equip');
  result.observerSees = sawOn && { appearance: sawOn.appearance, parts: sawOn.armor, lod: sawOn.lod };
  await sleep(4000); // the achievement toast for the legendary piece fades
  await clean(A);
  await clean(B);
  await A.evaluate(() => window.__lodestone.setView('third', 1, 2.4));
  await A.evaluate(() => window.__lodestone.setLook(0, -0.18));
  await photo(B, true);
  await sleep(1500);
  await clean(A);
  const selfThird = await png(A);
  const watcherFront = await png(B);
  await sideBySide('observer', selfThird, watcherFront, ['The Knight: their own body, third person', 'The Watcher (another player): the same armor, from the front']);

  // The back: the Watcher walks round behind (3.4 m south), looking north.
  await photo(B, false);
  await run(B, `/tp ${(pa.x).toFixed(1)} ${(pa.z + 4.2).toFixed(1)}`);
  await sleep(2500);
  await B.evaluate(() => window.__lodestone.setLook(0, -0.12));
  await clean(B);
  await photo(B, true);
  await sleep(800);
  await clean(A);
  await sideBySide('back', await png(B), await png(A), ['The Watcher behind the Knight', 'The Knight, third person']);

  // First person: the cuirass's vambraces on the view model's forearms.
  await A.evaluate(() => window.__lodestone.setView('first'));
  await A.evaluate(() => window.__lodestone.setLook(-0.7, -0.3));
  await sleep(1200);
  await clean(A);
  await A.evaluate(() => window.__lodestone.setLook(-0.7, -0.3));
  await sleep(400);
  await A.screenshot({ path: `${out}/pt2-armor-fp.jpg`, type: 'jpeg', quality: 72 });
  note('shot pt2-armor-fp.jpg');

  await photo(B, false);
  // Unequip all three: gone for both.
  await A.evaluate(async () => {
    const s = (await import('/src/ui/inventory/store.ts')).useInventory.getState();
    for (const slot of [2, 3, 4]) s.actions?.item(0, 4, slot); // Interact 21 action 4: arg = main0, main1, head, body, legs
  });
  await sleep(1500);
  result.afterUnequip = await ownAp(A);
  if (result.afterUnequip !== 0) issue('unequip', `own appearance ${result.afterUnequip}`);
  const off = await waitSeen(B, aId, 0, 'observer-unequip');
  result.observerAfterUnequip = off?.appearance;

  // Put it back on, then rejoin: the local save keeps the equipment, the zone the appearance.
  for (const line of ['/equip starmetal_helm mythic gem=aquamarine', '/equip silver_cuirass legendary', '/equip iron_greaves rare']) await run(A, line);
  await sleep(1500);
  const before = await ownAp(A);
  // A local profile's blob is re-issued at most every 5 s (explore.go localSaveEvery; a change inside
  // that window waits for the next change or the 30 s checkpoint): one more change after 5 s lands it all.
  await sleep(5500);
  await run(A, '/gold 777');
  await sleep(2500);
  await A.goto(BASE + '/');
  await A.getByTestId('play').click({ timeout: 5000 }).catch(() => {});
  await A.getByTestId('account-screen').waitFor({ timeout: 120000 });
  await A.getByTestId('auth-local').click();
  await A.getByTestId(`play-${knight}`).click({ timeout: 30000 });
  await A.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 60000 });
  await sleep(2500);
  const after = await ownAp(A);
  const aId2 = await selfId(A);
  result.rejoin = { before, after, id: aId2 };
  if (after !== before || !after) issue('rejoin', `appearance ${before} -> ${after}`);
  const back = await waitSeen(B, aId2, before, 'observer-rejoin', 15000);
  result.observerAfterRejoin = back?.appearance;
} catch (e) {
  issue('exception', String(e?.stack ?? e));
} finally {
  writeFileSync(`${tmp}/result.json`, JSON.stringify({ result, issues }, null, 2));
  note(JSON.stringify(result));
  note(`${issues.length} issues`);
  await browser.close();
}
