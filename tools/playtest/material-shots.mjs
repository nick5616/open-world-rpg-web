// Playtest 2 polish evidence: the iron sword (and the first-person iron
// vambraces) under the game's light. A new character on a dev zone out in
// the meadow, /equip iron_sword and iron_cuirass, then the first-person view
// at day (facing away from the sun and toward it), dusk, night, and day in
// each graphics style. Each frame is cropped to the lower right (where the
// weapon rests) and put on one contact sheet:
//   docs/evidence/pt2-polish-material-<tag>.jpg
//
//   LODESTONE_CLIENT_URL=<a client on a LODESTONE_ZONE_DEV=1 zone> node tools/playtest/material-shots.mjs <before|after> [outDir]
//   MAT_FRAMES=1 also keeps each frame (tmp/material/<tag>-<n>.jpg).
import { writeFileSync } from 'node:fs';
import { launch, newCharacter, sleep, dismissCards, look } from './lib.mjs';

const tag = process.argv[2] ?? 'after';
const out = process.argv[3] ?? 'docs/evidence';
const t = await launch('tmp/material', { width: 1280, height: 720 });
const { page, note, issue, browser } = t;
const run = (line) => page.evaluate((l) => window.__lodestoneDev.run(l), line);
const frames = [];
const grab = async (label) => {
  await dismissCards(page);
  await sleep(1200);
  const buf = await page.screenshot({ type: 'jpeg', quality: 82, clip: { x: 560, y: 160, width: 720, height: 560 } });
  frames.push({ label, src: `data:image/jpeg;base64,${buf.toString('base64')}` });
  if (process.env.MAT_FRAMES) writeFileSync(`tmp/material/${tag}-${frames.length}.jpg`, buf);
  note(`frame: ${label}`);
};
const setStyle = (s) => page.evaluate((x) => window.__lodestone.setStyle(x), s);

try {
  await newCharacter(page, `Mat${Date.now().toString(36).slice(-4)}`);
  await sleep(9000); // past the discovery and welcome cards
  await dismissCards(page);
  await page.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 20000 });
  await run('/god');
  await run('/freeze on');
  await run('/weather clear');
  await run('/tp 1919 2200'); // the meadow north of town (as viewmodel-shots)
  await sleep(8000);
  await dismissCards(page);
  await run('/equip iron_sword');
  await run('/equip iron_cuirass');
  await sleep(1500);
  await page.mouse.move(640, 360);
  const startStyle = await page.evaluate(() => window.__lodestone.graphics()?.style ?? 'lodestone');
  note(`style at start: ${startStyle}`);

  const at = async (hour, yaw, label) => {
    await run(`/time ${hour}`);
    await look(page, yaw, -0.05);
    await sleep(2500); // the sky and exposure ease
    await grab(label);
  };
  await at(13, 1.57, 'day 13:00, sun behind');
  await at(13, -1.57, 'day 13:00, toward the sun');
  await at(18, 1.57, 'dusk 18:00');
  await at(23, 1.57, 'night 23:00');
  await run('/time 13');
  await look(page, 1.57, -0.05);
  for (const s of ['painterly', 'grim', 'retro']) {
    await setStyle(s);
    await sleep(s === 'retro' ? 7000 : 2500); // Retro rebuilds the post chain
    await grab(`day, ${s} style`);
  }
  await setStyle(startStyle);
  await sleep(1500);

  // Underground: walk a cave route (world/caves/dev/caveWalk.mjs) from in front of the nearest mouth
  // until the cave's own light takes over, then look along the passage.
  const route = await page.evaluate(() => {
    const C = window.__lodestoneCaves;
    if (!C) return null;
    const p = window.__lodestone.player().pos;
    const sys = C.systems().sort((a, b) => Math.hypot(a.mouth.x - p.x, a.mouth.z - p.z) - Math.hypot(b.mouth.x - p.x, b.mouth.z - p.z));
    return sys.length ? C.route(sys[0].index) : null;
  });
  if (route?.points?.length) {
    await run(`/tp ${route.start.x.toFixed(1)} ${route.start.z.toFixed(1)}`);
    await sleep(5000);
    await page.keyboard.down('KeyW');
    let next = 0;
    let under = 0;
    let last = null;
    let stuck = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 120000 && under < 0.95) {
      const p = await page.evaluate(() => window.__lodestone.player().pos);
      let w = route.points[next];
      while (next < route.points.length - 1 && Math.hypot(w.x - p.x, w.z - p.z) < 1.6) w = route.points[++next];
      if (next === route.points.length - 1 && Math.hypot(w.x - p.x, w.z - p.z) < 2.5) break;
      await look(page, Math.atan2(-(w.x - p.x), -(w.z - p.z)), -0.1);
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
    note(`cave: underground ${under.toFixed(2)} after ${((Date.now() - t0) / 1000).toFixed(0)} s, waypoint ${next}/${route.points.length}`);
    if (under > 0.5) {
      await sleep(2500);
      await grab('in a cave');
    }
  }
  await run('/freeze off');
  await run('/weather seeded');

  const cols = 4;
  const w = 480;
  const h = Math.round((w * 560) / 720);
  const rows = Math.ceil(frames.length / cols);
  const sheet = await browser.newPage({ viewport: { width: cols * w, height: rows * h } });
  await sheet.setContent(
    `<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(${cols},${w}px)">${frames
      .map((f) => `<div style="position:relative;width:${w}px;height:${h}px;overflow:hidden"><img src="${f.src}" style="width:100%;height:100%;object-fit:cover;display:block"><div style="position:absolute;left:8px;top:6px;font:600 14px system-ui;color:#fff;text-shadow:0 1px 3px #000">${tag}: ${f.label}</div></div>`)
      .join('')}</body>`,
  );
  await sheet.screenshot({ path: `${out}/pt2-polish-material-${tag}.jpg`, type: 'jpeg', quality: 72 });
  await sheet.close();
  note(`wrote ${out}/pt2-polish-material-${tag}.jpg`);
} catch (e) {
  issue('exception', String(e?.stack ?? e));
  await page.screenshot({ path: 'tmp/material/fail.jpg', type: 'jpeg', quality: 60 }).catch(() => {});
} finally {
  await browser.close();
}
