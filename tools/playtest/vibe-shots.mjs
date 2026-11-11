// Playtest 2 vibe explorer (docs/cr/036-vibe-explorer.md) evidence: a new
// character on a dev zone opens the console's Vibe tab, searches the world
// (forest shrines, then lake shores), teleports to a match, sets the area's
// level and the time, loads a test WAV, maps it to the vibe it stands in and
// hears it take over (the now-playing readout says "Mapped"). Captures
// docs/evidence/pt2-vibe-{results,teleport,now-playing}.jpg and checks the
// effects in the client's own stores (what the zone sent back).
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1 --zone-env LODESTONE_ZONE_NO_WORLD_EVENTS=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/vibe-shots.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch, newCharacter, sleep, dismissCards, pl } from './lib.mjs';

const out = process.argv[2] ?? 'docs/evidence';
const tmp = 'tmp/vibe';
mkdirSync(tmp, { recursive: true });
const t = await launch(tmp, { width: 1600, height: 900 });
const { page, note, issue, browser } = t;
const result = {};
const run = (line) => page.evaluate((l) => window.__lodestoneDev.run(l), line);
const vibe = () => page.evaluate(() => window.__lodestoneDev.vibe());
const composer = () => page.evaluate(() => window.__lodestoneComposer.state());
const jpg = (name) => page.screenshot({ path: `${out}/pt2-vibe-${name}.jpg`, type: 'jpeg', quality: 70 });
const waitAnswers = (n) => page.waitForFunction((k) => window.__lodestoneDev.vibe().answers >= k, n, { timeout: 15000 });
const answers = () => page.evaluate(() => window.__lodestoneDev.vibe().answers);

// A 6 s test tone (A minor arpeggio) standing in for one of Nicole's new tracks.
function testWav(file) {
  const sr = 22050;
  const n = sr * 6;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  const notes = [220, 261.63, 329.63, 440];
  for (let i = 0; i < n; i++) {
    const tt = i / sr;
    const f = notes[Math.floor(tt * 2) % notes.length];
    const env = Math.min(1, (tt % 0.5) * 20) * Math.exp(-(tt % 0.5) * 3);
    b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * f * tt) * env * 9000), 44 + i * 2);
  }
  writeFileSync(file, b);
}

try {
  const wav = path.resolve(tmp, 'forest_dusk_sketch.wav');
  testWav(wav);
  await newCharacter(page, `Vibe${Date.now().toString(36).slice(-4)}`);
  await sleep(1500);
  await dismissCards(page);
  await page.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 20000 });
  note('zone says dev mode');
  await page.keyboard.press('F2');
  await page.getByTestId('dev-console').waitFor({ timeout: 5000 });
  await page.getByTestId('dev-tab-vibe').click();
  await page.getByTestId('dev-vibe').waitFor({ timeout: 15000 });
  await waitAnswers(1); // the first visit lists what is around the spawn
  const first = await vibe();
  result.first = { total: first.total, regions: first.regions.length };
  if (first.total < 100 || first.regions.length < 4) issue('first', `first search: ${first.total} matches, ${first.regions.length} regions`);

  // Search with the UI: forest shrines... then lake shores from the command line.
  await page.getByTestId('vibe-biome').selectOption('1');
  await page.getByTestId('vibe-landmark').selectOption(String(1 + 12)); // shrine
  let a0 = await answers();
  await page.getByTestId('vibe-search').click();
  await waitAnswers(a0 + 1);
  let v = await vibe();
  result.forestShrines = { total: v.total, sample: v.results.slice(0, 3).map((r) => `${r.n} (${r.k}, ${r.b}, lvl ${r.lv} ${r.st})`) };
  if (v.results.some((r) => r.b !== 'forest' || r.k !== 'shrine')) issue('filter', 'a forest shrine search returned something else');
  a0 = await answers();
  await run('/vibe find landmark=lake 12');
  await waitAnswers(a0 + 1);
  v = await vibe();
  result.lakes = { total: v.total, first: v.results[0] && { n: v.results[0].n, x: v.results[0].x, z: v.results[0].z, b: v.results[0].b, lv: v.results[0].lv } };
  if (v.total === 0 || v.results.some((r) => r.k !== 'lake')) issue('lakes', `lake shores: ${v.total}`);
  await sleep(500);
  await jpg('results');

  // Teleport to the third lake shore with its Teleport button; set the area to level 14, dusk, rain.
  const target = v.results[Math.min(2, v.results.length - 1)];
  await page.getByTestId(`vibe-go-${target.i}`).click();
  await sleep(3000);
  const p = await pl(page);
  result.teleport = { target: [target.x, target.z], landed: [Math.round(p.pos.x), Math.round(p.pos.z), Math.round(p.pos.y)], mode: p.mode };
  if (Math.hypot(p.pos.x - target.x, p.pos.z - target.z) > 125) issue('teleport', `landed ${Math.round(p.pos.x)},${Math.round(p.pos.z)} far from ${target.x},${target.z}`);
  if (p.mode === 'swim') issue('teleport', 'landed in the water');
  await run('/god on'); // a level-1 character in a level-14 area
  await page.getByTestId('vibe-area-level').click(); // 10 by default
  await run('/vibe level 14');
  await run('/time 18:10');
  await run('/weather drizzle');
  await sleep(2500);
  v = await vibe();
  result.here = v.here && { biome: v.here.spot.b, level: v.here.spot.lv, tier: v.here.spot.t, state: v.here.spot.st, weather: v.here.weather, hour: v.here.hour, overrides: v.here.overrides.length };
  if (!v.here || v.here.spot.lv !== 14 || v.here.spot.st !== 'override') issue('area', `here after /vibe level 14: ${JSON.stringify(result.here)}`);

  // The composer: load the test WAV, map it to "here", pin the readout and look around.
  const fc = page.waitForEvent('filechooser', { timeout: 10000 });
  await page.getByTestId('vibe-load-audio').click();
  await (await fc).setFiles(wav);
  await page.waitForFunction(() => window.__lodestoneComposer.state().files.some((f) => f.ready), null, { timeout: 15000 });
  await page.waitForFunction(() => window.__lodestoneComposer.state().now !== null, null, { timeout: 30000 });
  await page.getByTestId('vibe-mapping-editor').getByText('fill from here').click();
  await page.getByTestId('vibe-add-mapping').click();
  await page.waitForFunction(() => window.__lodestoneComposer.state().now?.source === 'mapping', null, { timeout: 15000 }).catch(() => {});
  let c = await composer();
  result.mapped = { files: c.files.map((f) => `${f.name} ${f.duration?.toFixed(1)} s`), mappings: c.mappings.map((m) => ({ file: m.file, when: m.when })), source: c.now?.source, track: c.now?.track, why: c.now?.why?.slice(0, 3), context: c.now?.context, loading: c.now?.loading };
  if (c.now?.source !== 'mapping') issue('mapping', `the mapped file is not playing: ${JSON.stringify(result.mapped)}`);
  await page.evaluate(() => window.__lodestoneComposer.set({ pinned: true }));
  await page.keyboard.press('F2');
  await sleep(500);
  await dismissCards(page);
  await page.getByText("Let's go").click({ timeout: 1500 }).catch(() => {});
  await page.evaluate(() => window.__lodestone.setLook?.(Math.PI * 0.75, -0.05));
  await sleep(1500);
  await jpg('teleport');
  const p2 = await pl(page);
  if (Math.hypot(p2.pos.x - target.x, p2.pos.z - target.z) > 125) issue('teleport', 'moved away from the target before the shot (died?)');

  // Now playing: force night at 0.6 intensity (the mapping stays off at night), then back to auto.
  await dismissCards(page);
  await page.keyboard.press('F2');
  await page.getByTestId('dev-tab-vibe').click();
  await run('/vibe spawn 3');
  await run('/music force night 0.6');
  await sleep(2500);
  c = await composer();
  result.forced = { state: c.override.state, director: c.now?.director, source: c.now?.source, track: c.now?.track, intensity: c.now?.context.intensity };
  if (c.now?.director !== 'night') issue('force', `forced night, director ${c.now?.director}`);
  await page.getByTestId('vibe-composer').scrollIntoViewIfNeeded();
  await sleep(500);
  await jpg('now-playing');
  await run('/music now');
  await run('/music force auto');
  await run('/vibe level clear all');
  await run('/weather seeded');
  await sleep(800);
  result.log = await page.evaluate(() => window.__lodestoneDev.state().log.map((l) => `${l.kind} ${l.text}`));
  const errs = result.log.filter((l) => l.startsWith('err'));
  if (errs.length) issue('log', errs.join(' | '));
} catch (e) {
  issue('exception', String(e?.stack ?? e));
  await page.screenshot({ path: `${tmp}/fail.jpg`, type: 'jpeg', quality: 60 }).catch(() => {});
} finally {
  writeFileSync(`${tmp}/result.json`, JSON.stringify({ result, issues: t.issues }, null, 2));
  note(JSON.stringify({ ...result, log: undefined }));
  await browser.close();
}
