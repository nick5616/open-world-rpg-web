/* global getComputedStyle, Buffer */
// Playtest pass 12 (playtest 2: instruments; CR 028). Two characters in one
// headless browser (two pages): the Bard stands by a town's townsfolk with
// every instrument (the dev kit) and plays each with the real keyboard
// (play mode, U; the overlay; Esc); the Listener stands 7 m away and sees
// the playing pose and hears the notes (Event 1120 through the jitter
// buffer into positional sources). Then a song for the townsfolk (their
// applause), a jam (the Bard sets the metronome, the Listener picks up a
// flute and gets it), and each instrument's phrase rendered offline
// (OfflineAudioContext in the page) and saved as a WAV, plus the lute in a
// cave's reverb. Screenshots and WAVs go to docs/evidence/pt2-instruments-*;
// notes and issues to <outDir>/report.json and docs/evidence/pt2-instruments.json.
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV_SPAWN=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/sp12.mjs <outDir>
import { writeFileSync } from 'node:fs';
import { launch, newCharacter, sleep, pl, look, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/playtest12';
const EVD = 'docs/evidence';
const t = await launch(out);
const { browser, page: A, note, issue, issues, log, save } = t;
const B = await browser.newPage({ viewport: { width: 1600, height: 900 } });
B.on('pageerror', (e) => issue('pageerror-listener', e.message));
const shots = [];
const shot = async (page, name) => {
  const f = `${EVD}/pt2-instruments-${name}.jpg`;
  await page.screenshot({ path: f, type: 'jpeg', quality: 86 });
  shots.push(f);
  note(`shot ${f}`);
};
const waitFor = async (fn, ms = 15000, every = 100) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
};
const music = (p = A) => p.evaluate(() => window.__lodestoneMusic.state());
const visible = (p, sel) => p.evaluate((s) => [...document.querySelectorAll(s)].some((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0), sel);
const avatarsOf = (p) => p.evaluate(() => window.__lodestoneAvatars?.() ?? []);
async function rejoin(p, at) {
  await p.evaluate(() => window.__lodestone.screen('title'));
  await sleep(3000);
  await p.evaluate((a) => window.__lodestone.rejoinAt(a), at);
  await p.waitForFunction(() => window.__lodestone?.netDebug?.()?.phase === 'playing', null, { timeout: 120000 });
  await sleep(2500);
}
async function closePanels(p) {
  for (let i = 0; i < 3; i++) {
    if (await visible(p, '[data-testid="whatsnew"], [data-testid="whatsnew-panel"]')) {
      await p.keyboard.press('Escape');
      await sleep(400);
    }
  }
  if (await visible(p, '[data-testid="esc-menu"]')) {
    await p.keyboard.press('Escape');
    await sleep(300);
  }
}
// A phrase on the real keyboard: [code, holdMs, gapMs, shift?]
async function play(p, phrase) {
  for (const [code, hold, gap, shift] of phrase) {
    if (shift) await p.keyboard.down('Shift');
    await p.keyboard.down(code);
    await sleep(hold);
    await p.keyboard.up(code);
    if (shift) await p.keyboard.up('Shift');
    await sleep(gap);
  }
}
const PHRASES = {
  lute: [['KeyQ', 90, 160], ['KeyE', 90, 160], ['KeyT', 90, 160], ['KeyU', 90, 160], ['KeyT', 90, 160], ['KeyE', 90, 160], ['KeyR', 90, 160], ['KeyW', 90, 160], ['KeyQ', 300, 200]],
  wooden_flute: [['KeyQ', 380, 40], ['KeyW', 200, 30], ['KeyE', 200, 30], ['KeyT', 520, 60], ['KeyE', 260, 30], ['KeyW', 600, 120]],
  hand_drum: [['KeyA', 80, 170], ['KeyQ', 60, 110], ['KeyW', 60, 110], ['KeyA', 80, 170], ['Digit1', 60, 110], ['KeyQ', 50, 70], ['KeyE', 50, 70], ['KeyA', 80, 200]],
  handbells: [['KeyI', 120, 220], ['KeyU', 120, 220], ['KeyY', 120, 220], ['KeyT', 120, 220], ['KeyR', 120, 220], ['KeyE', 120, 220], ['KeyW', 120, 220], ['KeyQ', 400, 200]],
};
const report = { instruments: {}, song: null, jam: null, wav: {}, shots };

try {
  const L = 'abcdefghijklmnopqrstuvwxyz';
  const sec = Math.floor(Date.now() / 1000);
  const tag = L[sec % 26] + L[Math.floor(sec / 26) % 26]; // two letters: names are unique per world
  await newCharacter(A, `Bard${tag}`);
  await newCharacter(B, `Listener${tag}`);
  await sleep(2500);
  await closePanels(A);
  await closePanels(B);
  // Mid-morning (dev zones): the townsfolk are out of doors.
  await A.evaluate(() => window.__lodestoneNight.setTime(10.5));
  await sleep(6000);
  // The nearest town: stand by its townsfolk.
  const town = await A.evaluate(() => {
    const T = window.__lodestoneTowns;
    const me = window.__lodestone.player().pos;
    const s = T.settlements().map((x) => ({ ...x, d: Math.hypot(x.x - me.x, x.z - me.z) })).sort((a, b) => a.d - b.d)[0];
    return { index: s.index, name: s.name, x: s.x, z: s.z, square: s.square };
  });
  note(`town ${JSON.stringify(town)}`);
  const sq = town.square ?? { x: town.x, z: town.z };
  await rejoin(A, { x: sq.x + 2, z: sq.z + 2 });
  await sleep(1500);
  await sleep(4000);
  let npcs = await A.evaluate(() => window.__lodestoneTowns.visibleNpcs().filter((n) => n.entityId !== null));
  const me0 = (await pl(A)).pos;
  npcs.sort((a, b) => Math.hypot(a.x - me0.x, a.z - me0.z) - Math.hypot(b.x - me0.x, b.z - me0.z));
  note(`townsfolk near the square: ${npcs.slice(0, 6).map((n) => `${n.name} ${Math.hypot(n.x - me0.x, n.z - me0.z).toFixed(1)} m`).join(', ')}`);
  // Out of doors: a townsperson standing at ground level near the square.
  const outdoors = npcs.filter((n) => Math.abs(n.y - me0.y) < 1.5);
  const host = outdoors[0] ?? npcs[0];
  const stage = host ? { x: host.x + 3, z: host.z + 1 } : { x: sq.x + 2, z: sq.z + 2 };
  note(`stage beside ${host?.name ?? 'the square'}`);
  await rejoin(A, stage);
  // The listener faces the bard from the side away from the townsperson (45 degrees off the line), 3.4 m out.
  const away = host ? Math.atan2(stage.z - host.z, stage.x - host.x) + 0.8 : 0.8;
  await rejoin(B, { x: stage.x + Math.cos(away) * 3.4, z: stage.z + Math.sin(away) * 3.4 });
  await sleep(5000); // the region's title card fades
  await closePanels(A);
  await closePanels(B);
  for (const p of [A, B]) await p.keyboard.press('F3'); // the debug readout off for the shots
  const aPos = (await pl(A)).pos;
  const bPos = (await pl(B)).pos;
  note(`bard at ${JSON.stringify(aPos)}, listener at ${JSON.stringify(bPos)} (${Math.hypot(aPos.x - bPos.x, aPos.z - bPos.z).toFixed(1)} m)`);
  await B.evaluate(() => window.__lodestone.setView('third', -1, 2.0));
  await look(B, yawTo(bPos, aPos.x, aPos.z) - 0.18, -0.32);

  // Without an instrument, U says where to get one.
  await A.bringToFront();
  await A.keyboard.press('KeyU');
  await sleep(400);
  const toast0 = await A.evaluate(() => document.querySelector('[data-testid="music-toast"]')?.textContent ?? '');
  if ((await music()).active) issue('play', 'play mode opened without an instrument');
  note(`U without an instrument: "${toast0}"`);
  await A.evaluate(() => window.__lodestoneMusic.dev());
  await B.evaluate(() => window.__lodestoneMusic.dev());
  const carried = await waitFor(async () => {
    const s = await music();
    return s.carried.length === 4 ? s.carried : null;
  }, 10000);
  if (!carried) issue('items', `the dev kit: ${JSON.stringify(await music())}`);

  // ---------------- each instrument ----------------
  for (const [i, key] of ['lute', 'wooden_flute', 'hand_drum', 'handbells'].entries()) {
    const id = i + 1;
    await A.bringToFront();
    await A.evaluate(() => window.__lodestone.setView('third', 1, 3.2));
    await look(A, yawTo(aPos, bPos.x, bPos.z), -0.12); // facing the listener (they see the front)
    if (i === 0) await A.keyboard.press('KeyU');
    else await A.evaluate((n) => window.__lodestoneMusic.enter(n), id);
    const on = await waitFor(async () => {
      const s = await music();
      return s.active && s.instrument === id ? s : null;
    }, 4000);
    if (!on) {
      issue('play', `${key}: play mode did not open: ${JSON.stringify(await music())}`);
      continue;
    }
    await sleep(600);
    // Play the phrase, and photograph the overlay with keys held mid-phrase.
    const ph = PHRASES[key];
    await play(A, ph.slice(0, 3));
    await A.keyboard.down(ph[3][0]);
    await A.keyboard.down(ph[4][0]);
    await sleep(70);
    await shot(A, `overlay-${key}`);
    await A.keyboard.up(ph[4][0]);
    await A.keyboard.up(ph[3][0]);
    await play(A, ph.slice(5));
    const st = await music();
    const seen = (await avatarsOf(B)).find((x) => Math.hypot(x.x - aPos.x, x.z - aPos.z) < 3);
    const heard = await B.evaluate(() => window.__lodestoneMusic.audio());
    note(`${key}: played ${st.played}, listener sees ${JSON.stringify(seen && { emote: seen.emote, instrument: seen.instrument })}, hears ${JSON.stringify(heard)}`);
    if (!seen || seen.emote !== 22 || seen.instrument !== id) issue('remote', `${key}: the listener does not see the playing pose`);
    if (!heard || heard.sources < 1) issue('remote', `${key}: the listener heard nothing`);
    // The listener's view while the bard plays on.
    await look(A, yawTo(aPos, bPos.x, bPos.z), -0.12);
    void play(A, ph);
    await sleep(500);
    await shot(B, `remote-${key}`);
    await sleep(1500);
    // First person: the instrument held up.
    await A.evaluate(() => window.__lodestone.setView('first'));
    await look(A, yawTo(aPos, bPos.x, bPos.z), -0.15);
    await sleep(300);
    await A.keyboard.down(ph[0][0]);
    await sleep(60);
    await shot(A, `firstperson-${key}`);
    await A.keyboard.up(ph[0][0]);
    const fp = await A.evaluate(() => window.__lodestone.viewState().fpInstrument);
    if (!fp) issue('firstperson', `${key}: no first-person instrument`);
    report.instruments[key] = { played: st.played, listenerSees: seen ? { emote: seen.emote, instrument: seen.instrument } : null, listenerHears: heard, firstPerson: fp };
  }

  // ---------------- a song for the townsfolk ----------------
  await A.evaluate(() => window.__lodestone.setView('third', 1, 4));
  await look(A, yawTo(aPos, bPos.x, bPos.z), -0.12);
  await A.evaluate(() => window.__lodestoneMusic.enter(1));
  await sleep(500);
  const songStart = Date.now();
  while (Date.now() - songStart < 9500) await play(A, PHRASES.lute);
  await A.keyboard.press('Escape');
  const song = await waitFor(async () => (await music()).lastSong, 6000);
  note(`song: ${JSON.stringify(song)}`);
  report.song = song;
  if (!song) issue('song', 'no song event after nine seconds of the lute');
  if (host) await look(B, yawTo(bPos, (host.x + aPos.x) / 2, (host.z + aPos.z) / 2), -0.08);
  await sleep(350);
  await shot(B, 'applause');
  if (song && !song.applause) issue('song', 'no townsfolk applauded (none within applause.npcM?)');
  if ((await music()).active) issue('play', 'Esc did not put the instrument away');

  // ---------------- a jam ----------------
  await A.evaluate(() => window.__lodestoneMusic.enter(3));
  await sleep(400);
  await A.keyboard.press('Enter'); // the click: no jam nearby, so the bard sets the tempo
  await B.evaluate(() => window.__lodestoneMusic.enter(2));
  const jam = await waitFor(async () => (await music(B)).jam, 5000);
  const jamA = (await music()).jam;
  note(`jam: bard ${JSON.stringify(jamA)}, listener ${JSON.stringify(jam)}`);
  report.jam = { bard: jamA, listener: jam };
  if (!jam || !jamA || jam.bpm !== jamA.bpm) issue('jam', 'the listener did not get the bard’s tempo');
  await B.keyboard.press('Enter');
  await sleep(300);
  void play(A, PHRASES.hand_drum);
  await play(B, PHRASES.wooden_flute.slice(0, 3));
  await shot(B, 'jam');
  await A.keyboard.press('Escape');
  await B.keyboard.press('Escape');

  // ---------------- each instrument's phrase, rendered offline ----------------
  for (const [key, rev, name] of [['lute', 0, 'lute'], ['wooden_flute', 0, 'flute'], ['hand_drum', 0, 'drum'], ['handbells', 0, 'handbells'], ['lute', 0.85, 'lute-cave']]) {
    const r = await A.evaluate(([k, v]) => window.__lodestoneMusic.render(k, v), [key, rev]);
    if (!r) {
      issue('wav', `${key}: no render`);
      continue;
    }
    const f = `${EVD}/pt2-instruments-${name}.wav`;
    writeFileSync(f, Buffer.from(r.b64, 'base64'));
    report.wav[name] = { file: f, seconds: r.seconds, peakDb: r.peakDb, rmsDb: r.rmsDb, sampleRate: r.sampleRate, channels: r.channels };
    note(`wav ${f}: ${r.seconds} s, peak ${r.peakDb} dBFS, rms ${r.rmsDb} dBFS`);
    if (r.peakDb > -0.1 || r.rmsDb < -45) issue('wav', `${name}: level peak ${r.peakDb} rms ${r.rmsDb}`);
  }
  report.played = (await music()).played;
} catch (e) {
  issue('crash', String(e?.stack ?? e));
} finally {
  writeFileSync(`${EVD}/pt2-instruments.json`, JSON.stringify({ ...report, issues, log }, null, 2));
  save();
  await browser.close();
}
console.log(issues.length ? `${issues.length} issues` : 'no issues');
