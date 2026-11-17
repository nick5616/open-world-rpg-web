// (browser globals come from the eslint config)
// Playtest 4 (first hour) evidence: a brand-new character in the real client.
//   1. the arrival: ~7 s in, no welcome card over the world, the mentor's call
//      (Event 1930) received, the first quest tracked;
//   2. the slimes handed in with the dev console (the kills are covered in the
//      meadows tests): the first errand starts by itself and is tracked;
//   3. the blacksmith's talk starts its deeds ("Mine 3 veins", 0/3).
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1
//   LODESTONE_CLIENT_URL=<its url> node ../tools/playtest/pt4-first-hour-evidence.mjs <outDir>   (run from client/)
import { launch, newCharacter, sleep, pl, look, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/pt4-first-hour-evidence';
const t = await launch(out);
const { page, note, issue, save } = t;
let n = 0;
const jpg = async (name) => {
  const f = `${out}/${String(++n).padStart(2, '0')}-${name}.jpg`;
  await page.screenshot({ path: f, type: 'jpeg', quality: 72 });
  return f;
};
const visible = (testid) => page.evaluate((id) => !!document.querySelector(`[data-testid="${id}"]`), testid);
const tracker = () => page.evaluate(() => document.querySelector('[data-testid="quest-tracker"]')?.innerText?.replace(/\s+/g, ' ') ?? null);
const dev = (line) => page.evaluate((l) => window.__lodestoneDev?.run(l), line);

await newCharacter(page, 'Evi' + String(Date.now()).slice(-4));
await page.waitForFunction(() => !!window.__lodestoneDev, null, { timeout: 30000 }).catch(() => issue('dev', 'no dev console (start the stack with LODESTONE_ZONE_DEV=1)'));
await dev('/time 10'); // a scratch world starts at any hour: daylight for the pictures
await page.keyboard.press('F3'); // the debug panel off
await sleep(7000);
note(`tracker: ${await tracker()}`);
note(`welcome card up: ${await visible('whatsnew')} (it waits for the first quest)`);
note(`tip up: ${await page.evaluate(() => document.querySelector('[data-testid="tip"]')?.getAttribute('data-tip') ?? null)}`);
if (await visible('whatsnew')) issue('hold', 'the welcome card is over a new character on the first quest');
await jpg('arrival');

await dev('/quest all done');
await sleep(2500);
note(`after the slimes: ${await tracker()}`);
await jpg('errand-start');

// Go and talk to the blacksmith (the tracked quest's marker), E.
const marker = await page.evaluate(() => window.__lodestoneQuests?.tracked?.()?.markers?.[0] ?? null);
note(`marker ${JSON.stringify(marker)}`);
if (marker) {
  await dev(`/tp ${Math.round(marker.x + 2)} ${Math.round(marker.z + 1)}`);
  await sleep(3500);
  await look(page, yawTo(await pl(page).then((s) => s.pos), marker.x, marker.z));
  await sleep(500);
  await page.getByTestId('whatsnew-close').click({ timeout: 2000 }).catch(() => {}); // the welcome card arrives once the first quest is handed in
  await sleep(500);
  await page.keyboard.press('KeyE');
  await sleep(2500);
  note(`after the smith: ${await tracker()}`);
  await jpg('errand-mine');
}
note(`player ${JSON.stringify(await pl(page))}`);
save();
await t.browser.close();
