// Playtest 2 view model evidence ("fix the view", "fix this fucked up
// hand"): a new character on a dev zone, out in the meadow north of town
// with a boss spawned straight ahead, and the first-person weapon at rest,
// mid-swing and casting with a sword, spear, staff and wand (dev console
// /equip), at 16:9 and 21:9. Each group of frames goes on one contact sheet
// with the middle 40% of the view marked (it must be clear at rest):
//   docs/evidence/pt2-viewmodel-<tag>-rest.jpg, -action.jpg, -wide.jpg
//
//   LODESTONE_CLIENT_URL=<a client on a LODESTONE_ZONE_DEV=1 zone> node tools/playtest/viewmodel-shots.mjs <tag> [outDir]
//   VM_YAW=<radians> faces another way; VM_PROBE=1 only shoots the four headings (to find an open one).
import { launch, newCharacter, sleep, dismissCards, look } from './lib.mjs';

const tag = process.argv[2] ?? 'after';
const out = process.argv[3] ?? 'docs/evidence';
const t = await launch('tmp/viewmodel', { width: 1280, height: 720 });
const { page, note, issue, browser } = t;
const run = (line) => page.evaluate((l) => window.__lodestoneDev.run(l), line);
const frames = { rest: [], action: [], wide: [] };
const grab = async (group, label, fast = false) => {
  if (!fast) {
    await dismissCards(page);
    await sleep(150);
  }
  const buf = await page.screenshot({ type: 'jpeg', quality: 80 });
  frames[group].push({ label, src: `data:image/jpeg;base64,${buf.toString('base64')}` });
  note(`${group}: ${label}`);
};
const equip = async (item) => {
  await run(`/equip ${item}`);
  await sleep(1400);
};
const swing = async () => {
  await page.mouse.down();
  await sleep(30);
  await page.mouse.up();
};
// a boss straight ahead (respawned for each frame so it is a few metres off, not in your face)
const boss = async () => {
  await run('/despawn');
  await run('/spawn warden 1 1');
  await sleep(1100);
};

async function shots() {
  for (const [kind, item] of [
    ['sword', 'iron_sword'],
    ['spear', 'iron_spear'],
    ['staff', 'oak_staff'],
    ['wand', 'birch_wand'],
  ]) {
    await equip(item);
    await boss();
    await grab('rest', `${kind} at rest`);
  }

  // mid-swing and casting (a first click takes the mouse: the game's, not an attack)
  await page.mouse.click(640, 360);
  await sleep(400);
  note(`under the mouse: ${await page.evaluate(() => document.elementFromPoint(640, 360)?.tagName)}`);
  await equip('iron_sword');
  await boss();
  await dismissCards(page);
  await swing();
  await sleep(70);
  await grab('action', 'sword: forehand, mid-swing', true);
  await sleep(900);
  await swing();
  await sleep(70);
  await grab('action', 'sword: backhand, mid-swing', true);
  await sleep(900);
  await page.keyboard.press('Digit1');
  await sleep(90);
  await grab('action', 'sword: casting (off-hand palm)', true);
  await sleep(900);
  await equip('oak_staff');
  await boss();
  await dismissCards(page);
  await page.keyboard.press('Digit1');
  await sleep(40);
  await grab('action', 'staff: casting', true);
  await sleep(900);
  await swing();
  await sleep(70);
  await grab('action', 'staff: swing', true);
  await sleep(900);
  await equip('iron_spear');
  await dismissCards(page);
  await swing();
  await sleep(40);
  await grab('action', 'spear: thrust', true);
  await sleep(900);

  // 21:9
  await page.setViewportSize({ width: 1680, height: 720 });
  await sleep(800);
  await equip('iron_sword');
  await boss();
  await grab('wide', 'sword at rest, 21:9');
  await equip('oak_staff');
  await boss();
  await grab('wide', 'staff at rest, 21:9');
  await run('/despawn');
}

try {
  await newCharacter(page, `View${Date.now().toString(36).slice(-4)}`);
  await sleep(9000); // past the discovery and welcome cards
  await dismissCards(page);
  await page.keyboard.press('F3'); // the dev stats overlay off
  await page.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 20000 });
  await run('/god');
  await run('/nocd');
  await run('/mana');
  await run('/freeze on');
  await run('/time 13');
  await run('/weather clear');
  // out of town into the meadow to the north
  await run('/tp 1919 2200');
  await sleep(8000); // the discovery XP's level-up toast comes and goes
  await dismissCards(page);
  await page.mouse.move(640, 360);
  if (process.env.VM_PROBE) {
    for (const y of [0, 1.57, 3.14, -1.57]) {
      await look(page, y, 0);
      await sleep(600);
      await grab('rest', `yaw ${y}`);
    }
  } else {
    await look(page, +(process.env.VM_YAW ?? 1.57), 0); // west: open grass, the town wall and a mountain
    await shots();
  }

  // contact sheets: one page per group, the middle-40% box drawn on every frame
  for (const [group, list] of Object.entries(frames)) {
    if (!list.length) continue;
    const cols = group === 'wide' ? 1 : 2;
    const w = group === 'wide' ? 1050 : 800;
    const h = 450;
    const rows = Math.ceil(list.length / cols);
    const sheet = await browser.newPage({ viewport: { width: cols * w, height: rows * h } });
    await sheet.setContent(
      `<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(${cols},${w}px)">${list
        .map(
          (f) =>
            `<div style="position:relative;width:${w}px;height:${h}px;overflow:hidden"><img src="${f.src}" style="width:100%;height:100%;object-fit:cover;display:block">` +
            `<div style="position:absolute;left:30%;top:30%;width:40%;height:40%;border:1px dashed rgba(255,255,255,.8);box-sizing:border-box"></div>` +
            `<div style="position:absolute;left:8px;top:6px;font:600 15px system-ui;color:#fff;text-shadow:0 1px 3px #000">${tag}: ${f.label}</div></div>`,
        )
        .join('')}</body>`,
    );
    await sheet.screenshot({ path: `${out}/pt2-viewmodel-${tag}-${group}.jpg`, type: 'jpeg', quality: 70 });
    await sheet.close();
    note(`wrote ${out}/pt2-viewmodel-${tag}-${group}.jpg`);
  }
} catch (e) {
  issue('exception', String(e?.stack ?? e));
  await page.screenshot({ path: 'tmp/viewmodel/fail.jpg', type: 'jpeg', quality: 60 }).catch(() => {});
} finally {
  await browser.close();
}
