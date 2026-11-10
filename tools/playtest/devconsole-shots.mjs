// Playtest 2 dev console (CR 032) evidence: a new character on a dev zone
// opens the console (F2), uses its buttons and command line (give and equip
// gear, learn every spell, level, gold, fly, teleport, weather, spawns) and
// each tab is captured as docs/evidence/pt2-dev-console-<tab>.jpg. Checks
// the effects in the client's own stores (what the zone sent back).
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/devconsole-shots.mjs [outDir]
import { writeFileSync } from 'node:fs';
import { launch, newCharacter, sleep, dismissCards, pl } from './lib.mjs';

const out = process.argv[2] ?? 'docs/evidence';
const t = await launch('tmp/devconsole', { width: 1600, height: 900 });
const { page, note, issue, browser } = t;
const result = {};
const run = (line) => page.evaluate((l) => window.__lodestoneDev.run(l), line);
const log = () => page.evaluate(() => window.__lodestoneDev.state().log.map((l) => `${l.kind} ${l.text}`));
const jpg = (name) => page.screenshot({ path: `${out}/pt2-dev-console-${name}.jpg`, type: 'jpeg', quality: 72 });

try {
  await newCharacter(page, `Dev${Date.now().toString(36).slice(-4)}`);
  await sleep(1500);
  await dismissCards(page);
  await page.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 20000 });
  note('zone says dev mode');
  await page.keyboard.press('F2');
  await page.getByTestId('dev-console').waitFor({ timeout: 5000 });
  result.opened = true;

  // Items: buttons and commands.
  await page.getByTestId('dev-item-search').fill('voidglass');
  await page.getByTestId('dev-item-weapon:voidglass_sword').getByText('Equip').click();
  await run('/give armor:starmetal_cuirass legendary');
  await run('/equip voidglass_helm mythic');
  await run('/give potion:greater_health 10');
  await run('/give gem:ruby:brilliant 3');
  await run('/gold 50000');
  await sleep(1200);
  const inv = await page.evaluate(async () => (await import('/src/ui/inventory/store.ts')).useInventory.getState().inv);
  const sword = inv?.items.find((i) => i.b === 'weapon:voidglass_sword');
  result.items = { sword: sword && { rarity: sword.r, slot: sword.s, name: sword.n }, gold: inv?.gold, count: inv?.items.length };
  if (!sword || sword.s !== 'eq:main0') issue('items', `voidglass sword not equipped: ${JSON.stringify(sword)}`);
  await page.getByTestId('dev-item-search').fill('');
  await page.getByTestId('dev-item-group').selectOption('weapon');
  await sleep(300);
  await jpg('items');

  // Spells.
  await page.getByTestId('dev-tab-spells').click();
  await page.getByTestId('dev-learn-all').click();
  await sleep(1200);
  await run('/equip tome:fireball');
  await sleep(600);
  const known = await page.evaluate(async () => (await import('/src/combat/store.ts')).useCombatHud.getState().known.length);
  result.known = known;
  if (known < 100) issue('spells', `only ${known} known after Learn all`);
  await jpg('spells');

  // Character.
  await page.getByTestId('dev-tab-character').click();
  await run('/level 25');
  await run('/skill all 60');
  await run('/god');
  await run('/mana');
  await sleep(1000);
  result.flags = await page.evaluate(() => window.__lodestoneDev.state().status.flags);
  if ((result.flags & 3) !== 3) issue('flags', `god and infinite mana not both on: ${result.flags}`);
  result.level = await page.evaluate(async () => (await import('/src/ui/progression/store.ts')).useProgression.getState().stats?.level);
  await jpg('character');

  // World: places, teleport, fly, weather, spawn.
  await page.getByTestId('dev-tab-world').click();
  await sleep(800);
  const places = await page.evaluate(() => window.__lodestoneDev.state().places);
  result.places = { towers: places.towers.length, towns: places.towns.length, vaults: places.vaults.length };
  const p0 = await pl(page);
  const town = places.towns[1] ?? places.towns[0];
  await run(`/tp "${town.n}"`);
  await sleep(2500);
  const p1 = await pl(page);
  result.teleport = { from: [Math.round(p0.pos.x), Math.round(p0.pos.z)], to: [Math.round(p1.pos.x), Math.round(p1.pos.z)], town };
  if (Math.hypot(p1.pos.x - town.x, p1.pos.z - town.z) > 40) issue('teleport', `landed ${Math.round(p1.pos.x)},${Math.round(p1.pos.z)} not near ${town.n}`);
  await run('/weather thunderstorm');
  await run('/time 19:30');
  await run('/spawn boar 3');
  await run('/fly on');
  await sleep(800);
  // Fly up for a second (the console is open: the keys go to the game when the box is not focused).
  await page.getByTestId('dev-tab-world').focus();
  await page.evaluate(() => document.activeElement?.blur());
  const y0 = (await pl(page)).pos.y;
  await page.keyboard.down('Space');
  await sleep(1200);
  await page.keyboard.up('Space');
  await sleep(500);
  const y1 = (await pl(page)).pos.y;
  const nd = await page.evaluate(() => window.__lodestone.netDebug?.());
  result.fly = { y0: Math.round(y0 * 10) / 10, y1: Math.round(y1 * 10) / 10, reconciles: nd?.prediction?.reconciles, maxError: nd?.prediction?.maxError };
  if (!(y1 > y0 + 10)) issue('fly', `y ${y0} -> ${y1}`);
  await jpg('world');
  await run('/fly off');
  await run('/despawn');
  await run('/weather seeded');
  await sleep(800);
  result.log = await log();
  if (result.log.some((l) => l.startsWith('err'))) issue('log', result.log.filter((l) => l.startsWith('err')).join(' | '));
} catch (e) {
  issue('exception', String(e?.stack ?? e));
  await page.screenshot({ path: 'tmp/devconsole/fail.jpg', type: 'jpeg', quality: 60 }).catch(() => {});
} finally {
  writeFileSync('tmp/devconsole/result.json', JSON.stringify({ result, issues: t.issues }, null, 2));
  note(JSON.stringify({ ...result, log: undefined }));
  await browser.close();
}
