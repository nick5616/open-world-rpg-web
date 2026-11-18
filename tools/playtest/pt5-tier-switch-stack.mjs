// Playtest 5 (CR 057): live tier switching on a private stack (real character, town, caves and
// vertical materials), with moves between switches. Any page error fails the run. The
// "Cannot read properties of undefined (reading 'toArray')" crash needed a previously visited
// cascade count plus materials created far from spawn, which the solo script does not reach.
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1      (prints the client URL)
//   LODESTONE_CLIENT_URL=<url> LODESTONE_ANGLE=gl node tools/playtest/pt5-csm-debug.mjs [out]
import { launch, newCharacter, sleep, dismissCards } from './lib.mjs';
const T = await launch(process.argv[2] ?? 'tmp/pt5/tier-switch', { width: 1280, height: 720 });
const { page, note } = T;
await newCharacter(page, 'Tier' + Math.random().toString(36).slice(2, 6));
await dismissCards(page);
await sleep(4000);
const run = (l) => page.evaluate((x) => window.__lodestoneDev.run(x), l);
const p0 = await page.evaluate(() => window.__lodestone.player().pos);
let errN = 0;
page.on('pageerror', () => errN++);
await run('/time 12');
const steps = [
  ['low', 0, 0],
  ['medium', 0, 0],
  ['high', 0, 0],
  ['medium', 700, 300],
  ['high', 700, 300],
  ['low', 700, 300],
  ['high', -400, 500],
  ['medium', -400, 500],
  ['low', 0, 0],
  ['high', 0, 0],
  ['auto', 0, 0],
];
for (const [t, dx, dz] of steps) {
  await page.evaluate((q) => window.__lodestone.setQuality(q), t);
  await run(`/tp ${Math.round(p0.x + dx)} ${Math.round(p0.z + dz)}`);
  await sleep(3500);
  const g = await page.evaluate(() => window.__lodestone.graphics());
  note(`${t} (${dx},${dz}): tier ${g.tier}/${g.shaderTier} cascades ${g.shadowCascades}, page errors so far ${errN}`);
}
T.save();
await T.browser.close();
note(errN === 0 ? 'PASS: no page errors across the tier switches' : `FAIL: ${errN} page errors`);
process.exit(errN === 0 ? 0 : 1);
