/* global AudioContext */
// Playtest 4 (Nicole's new music) in the real client, read off the audio debug handle
// (window.__lodestoneAudio), not by ear. Default autoplay policy (no flags), so the
// "first gesture" rule is real.
//   1. the title is silent until the first click; a click on the page (not Play) starts the
//      menu theme as a sample-exact loop (the decoded asset is also checked at its wrap);
//   2. it keeps playing (and wraps) through the account screen and character creation;
//   3. entering the world crossfades into the anthem for a brand-new character (the first quest's
//      talk step is not done); the title theme is released;
//   4. the first quest handed in: the arrival window closes, the main theme carries on as day music;
//   5. night: night theme 2 / the nocturne cut; 6. /tp into a cave and walk in: a crystal cave track,
//      rotating 1 -> 3 -> 2 -> 3 (the track end is jumped to); 7. the ending: the anthem.
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1
//   LODESTONE_CLIENT_URL=<its url> node ../tools/playtest/pt4-music.mjs <outDir>   (run from client/)
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../client/package.json', import.meta.url));
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = process.env.LODESTONE_CLIENT_URL ?? 'http://localhost:5173';
const out = process.argv[2] ?? 'tmp/pt4-music';
mkdirSync(out, { recursive: true });

const lines = [];
const checks = [];
const log = (s) => {
  const l = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  console.log(l);
  lines.push(l);
};
const check = (name, ok, detail = '') => {
  checks.push(ok);
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

const browser = await chromium.launch({ headless: true, args: [`--use-angle=${process.env.LODESTONE_ANGLE ?? 'd3d11'}`, '--enable-gpu', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => log(`pageerror: ${e.message}`));
const audio = (expr) => page.evaluate(`(() => { const a = window.__lodestoneAudio; return ${expr}; })()`);
const world = () => audio('a && a.state && a.state()').then((s) => ({ music: s?.music, director: s?.director, ctx: s?.ctxState, inputs: s?.inputs }));
const dev = (line) => page.evaluate((l) => window.__lodestoneDev?.run(l), line);
async function until(fn, ms, every = 500) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(every);
  }
}

try {
  // 1. Title
  await page.goto(BASE + '/');
  await page.getByTestId('play').waitFor({ timeout: 60000 });
  await sleep(1500);
  let t = await audio('a && a.title && a.title()');
  let st = await audio('a && a.state && a.state()');
  check('title is silent before any gesture', t && !t.playing && st?.ctxState === 'none', `title ${JSON.stringify(t)} ctx ${st?.ctxState}`);
  await page.mouse.click(60, 400); // a click on the cavern, not Play
  t = await until(async () => (await audio('a.title()')).playing && (await audio('a.title()')), 20000);
  check('first click starts the menu theme', !!t, JSON.stringify(t));
  check('it is a sample-exact loop (looping buffer source over the whole buffer)', !!t?.loop && t.length > 2.5e6 && Math.abs(t.seconds - 59.0476) < 0.01, `length ${t?.length} samples, ${t?.seconds?.toFixed(4)} s`);
  await sleep(3500);
  t = await audio('a.title()');
  check('fades in to its gain', t.gain > 0.5, `gain ${t.gain.toFixed(3)} position ${t.position.toFixed(1)} s`);

  // The asset itself at the wrap, decoded the way the page decodes it.
  const join = await page.evaluate(async () => {
    const url = (await import('/src/audio/assets.ts')).assetUrl('music/menu_theme');
    const buf = await (await fetch(url)).arrayBuffer();
    if (!url) return { error: 'no url' };
    const ctx = new AudioContext();
    const b = await ctx.decodeAudioData(buf);
    const d = b.getChannelData(0);
    const n = d.length;
    const rms = (s) => {
      let x = 0;
      for (let i = 0; i < 441; i++) x += d[(s + i + n) % n] ** 2;
      return 20 * Math.log10(Math.sqrt(x / 441) + 1e-9);
    };
    const around = [];
    for (let k = -4; k < 4; k++) around.push(Math.round(rms(k * 441)));
    let maxD = 0;
    for (let i = 1; i < 400000; i++) maxD = Math.max(maxD, Math.abs(d[i] - d[i - 1]));
    const jump = Math.abs(d[0] - d[n - 1]);
    return { url: url.split('/').pop(), sr: b.sampleRate, n, seconds: n / b.sampleRate, around, jump, maxDelta: maxD };
  });
  log(`asset ${JSON.stringify(join)}`);
  check('the wrap has no seam: no step beyond the music\'s own slope, no dip around the join', join.jump <= join.maxDelta && Math.max(...join.around) - Math.min(...join.around) <= 8, `wrap step ${join.jump.toFixed(3)} vs max slope ${join.maxDelta.toFixed(3)}; 10 ms rms around the join ${join.around.join(' ')} dB`);

  // 2. Account, character creation: the theme keeps playing
  await page.getByTestId('play').click();
  await page.getByTestId('account-screen').waitFor({ timeout: 120000 });
  await page.getByTestId('auth-local').click();
  await page.getByTestId('char-name').waitFor({ timeout: 30000 });
  const name = 'Mus' + String(Date.now()).slice(-4);
  await page.getByTestId('char-name').fill(name);
  await page.getByTestId('char-create').click();
  t = await audio('a.title()');
  check('still playing on the character screens', t.playing, `position ${t.position.toFixed(1)} s, wraps ${t.wraps}`);

  // 3. Into the world
  const playT0 = Date.now();
  await page.getByTestId(`play-${name}`).click();
  await page.waitForFunction(() => window.__lodestone?.netDebug?.()?.phase === 'playing', null, { timeout: 120000 });
  await page.waitForFunction(() => !!window.__lodestoneDev, null, { timeout: 30000 }).catch(() => {});
  await dev('/time 10');
  const first = await until(async () => {
    const w = await world();
    return w.director && w.director !== 'silence' ? w : null;
  }, 60000, 300);
  log(`first world music ${JSON.stringify(first && { director: first.director, track: first.music?.track, arrival: first.inputs?.arrival })} after ${((Date.now() - playT0) / 1000).toFixed(1)} s`);
  // the quest log must arrive for the arrival input; give it a moment, then read
  const anthem = await until(async () => {
    const w = await world();
    return w.director === 'anthem' ? w : null;
  }, 20000, 400);
  check('a brand-new character hears the anthem (main theme)', !!anthem && /main_theme/.test(anthem.music?.track ?? ''), anthem ? `${anthem.director} ${anthem.music.track} arrival=${anthem.inputs?.arrival}` : JSON.stringify(await world()));
  const released = await until(async () => !(await audio('a.title()')).playing, 15000, 500);
  check('the title theme was handed over (released)', !!released);

  // 4. The first quest handed in: the window closes, the theme carries on as day music
  await dev('/quest all done');
  await sleep(1500);
  const day = await until(async () => {
    const w = await world();
    return w.director === 'day' || w.director === 'town' ? w : null;
  }, 20000, 500);
  check('after the first quest the anthem gives way to the town (by day) music, the arrival is over', !!day && day.inputs?.arrival === false, day ? `${day.director} ${day.music.track}` : JSON.stringify(await world()));

  // 5. Night
  await dev('/time 22');
  const night = await until(async () => {
    const w = await world();
    return w.director === 'night' ? w : null;
  }, 20000, 500);
  check('night plays night theme 2 or the nocturne cut', !!night && /music\/night(_2)?$/.test(night.music?.track ?? ''), night ? night.music.track : JSON.stringify(await world()));
  // rotation by jumping to the track's end
  const nightFirst = night?.music?.track;
  await page.evaluate(() => {
    const m = window.__lodestoneAudio.engine().music;
    const d = m.decks[m.active];
    d.el.currentTime = Math.max(0, d.el.duration - 7);
  });
  const nightNext = await until(async () => {
    const w = await world();
    return w.music?.track && w.music.track !== nightFirst ? w.music.track : null;
  }, 15000, 500);
  check('the night rotates to the other night track at the end of one', !!nightNext && /music\/night(_2)?$/.test(nightNext), `${nightFirst} -> ${nightNext}`);
  await dev('/time 10');

  // 6. A cave
  const route = await page.evaluate(() => {
    const C = window.__lodestoneCaves;
    if (!C) return null;
    const p = window.__lodestone.player().pos;
    const sys = C.systems().sort((a, b) => Math.hypot(a.mouth.x - p.x, a.mouth.z - p.z) - Math.hypot(b.mouth.x - p.x, b.mouth.z - p.z));
    return sys.length ? C.route(sys[0].index) : null;
  });
  if (!route?.points?.length) check('found a cave route', false);
  else {
    await dev(`/tp ${route.start.x.toFixed(1)} ${route.start.z.toFixed(1)}`);
    await sleep(5000);
    await page.keyboard.down('KeyW');
    let next = 0;
    let under = 0;
    let last = null;
    let stuck = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 120000 && under < 0.7) {
      const p = await page.evaluate(() => window.__lodestone.player().pos);
      let w = route.points[next];
      while (next < route.points.length - 1 && Math.hypot(w.x - p.x, w.z - p.z) < 1.6) w = route.points[++next];
      await page.evaluate(([y, pi]) => window.__lodestone.setLook(y, pi), [Math.atan2(-(w.x - p.x), -(w.z - p.z)), -0.1]);
      if (last && Math.hypot(p.x - last.x, p.z - last.z) < 0.05) stuck++;
      else stuck = 0;
      if (stuck > 6) {
        await page.keyboard.press('Space');
        stuck = 0;
      }
      last = p;
      under = await page.evaluate(() => window.__lodestoneCaves.info().underground ?? 0);
      await sleep(100);
    }
    await page.keyboard.up('KeyW');
    log(`underground ${under.toFixed(2)}`);
    const cave = await until(async () => {
      const w = await world();
      return w.director === 'cave' ? w : null;
    }, 20000, 500);
    check('a cave plays a crystal cave track', !!cave && /crystal_cave_[123]$/.test(cave.music?.track ?? ''), cave ? `${cave.music.track} lowpass 14 kHz` : JSON.stringify(await world()));
    // Rotation: jump to the end of the track a few times, read the sequence.
    const seq = [cave?.music?.track];
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        const m = window.__lodestoneAudio.engine().music;
        const d = m.decks[m.active];
        d.el.currentTime = Math.max(0, d.el.duration - 7);
      });
      const prev = seq[seq.length - 1];
      const nx = await until(async () => {
        const w = await world();
        return w.music?.track && w.music.track !== prev ? w.music.track : null;
      }, 15000, 400);
      seq.push(nx);
      await sleep(1500);
    }
    log(`cave sequence ${seq.map((s) => s?.split('/').pop()).join(' -> ')}`);
    const okSeq = seq.every((s, i) => s && /crystal_cave_[123]$/.test(s) && (i === 0 || s !== seq[i - 1]));
    check('consecutive cave tracks differ', okSeq);
    await page.screenshot({ path: `${out}/cave.jpg`, type: 'jpeg', quality: 60 });
    // Depths/void still route to the void realm
    await page.evaluate(() => window.__lodestoneAudio.force({ layer: 3 }));
    const depths = await until(async () => ((await world()).director === 'void' ? await world() : null), 10000, 400);
    check('the Depths (layer 3) keep the void realm', !!depths && /void_realm/.test(depths.music?.track ?? ''), depths?.music?.track);
    await page.evaluate(() => window.__lodestoneAudio.force(null));
  }

  // 7. The ending (the story store, as Event 1605 sets it)
  await dev('/tp 1200 900').catch(() => {});
  await page.evaluate(async () => {
    const m = await import('/src/ui/story/store.ts');
    m.useStory.setState({ ending: { title: 'The Last Song', lines: ['x'], together: false, hard: false, names: [], first: false, earned: '', at: performance.now() } });
  });
  const ending = await until(async () => {
    const w = await world();
    return w.director === 'anthem' ? w : null;
  }, 20000, 500);
  check('the ending and its credits play the anthem', !!ending && /main_theme/.test(ending.music?.track ?? ''), ending ? `${ending.music.track} finale=${ending.inputs?.finale}` : JSON.stringify(await world()));
  await page.screenshot({ path: `${out}/ending.jpg`, type: 'jpeg', quality: 60 });
} catch (e) {
  log(`ERROR ${e.stack ?? e}`);
  checks.push(false);
}
writeFileSync(`${out}/pt4-music.txt`, lines.join('\n') + '\n');
log(`${checks.filter(Boolean).length}/${checks.length} checks passed`);
await browser.close();
process.exit(checks.every(Boolean) ? 0 : 1);
