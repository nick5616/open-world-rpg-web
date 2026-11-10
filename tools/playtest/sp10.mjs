/* global document */
// Playtest pass 10 (playtest 2: fishing, emotes, photo mode; CR 026). Two
// characters in one headless browser (two pages): the Angler fishes at the
// nearest shore of the spawn, the Watcher stands beside them and sees the
// rod, the line and the catch held up; then the Angler emotes (the wheel,
// the debug handle, /emote in chat) and the Watcher photographs each one;
// then photo mode (panel, a dusk preview with depth of field, Painterly,
// a saved PNG, Esc restores everything). Screenshots go to docs/evidence
// as pt2-fishing-*, pt2-emotes-*, pt2-photo-*; notes and issues to
// <outDir>/report.json and docs/evidence/pt2-fishing-emotes-photo.json.
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV_SPAWN=1 --zone-env LODESTONE_ZONE_FISH_FAST=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/sp10.mjs <outDir>
import { writeFileSync } from 'node:fs';
import { launch, newCharacter, sleep, pl, look, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/playtest10';
const EVD = 'docs/evidence';
const t = await launch(out);
const { browser, page: A, note, issue, issues, log, save } = t;
const B = await browser.newPage({ viewport: { width: 1600, height: 900 } });
B.on('pageerror', (e) => issue('pageerror-watcher', e.message));
const shots = [];
const shot = async (page, name) => {
  const f = `${EVD}/pt2-${name}.png`;
  await page.screenshot({ path: f });
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
const fish = (p = A) => p.evaluate(() => window.__lodestoneFishing.state());
const visible = (p, sel) => p.evaluate((s) => [...document.querySelectorAll(s)].some((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0), sel);
const avatarsOf = (p) => p.evaluate(() => window.__lodestoneAvatars?.() ?? []);
const selfId = (p) => p.evaluate(() => window.__lodestone.netDebug()?.self?.id ?? window.__lodestone.netDebug()?.entityId ?? null);
async function rejoin(p, at) {
  await p.evaluate(() => window.__lodestone.screen('title'));
  await sleep(3000);
  await p.evaluate((a) => window.__lodestone.rejoinAt(a), at);
  await p.waitForFunction(() => window.__lodestone?.netDebug?.()?.phase === 'playing', null, { timeout: 120000 });
  await sleep(2500);
}
async function closePanels(p) {
  for (let i = 0; i < 2; i++) {
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

try {
  await newCharacter(A, 'Angler');
  await newCharacter(B, 'Watcher');
  await sleep(2500);
  await closePanels(A);
  await closePanels(B);
  const spawn = (await pl(A)).pos;
  note(`spawned at ${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}`);
  const spot = await A.evaluate(([x, z]) => window.__lodestoneFishing.findSpot(x, z, 1200), [spawn.x, spawn.z]);
  if (!spot) throw new Error('no shore with deep water within 1200 m of the spawn');
  note(`fishing spot ${JSON.stringify(spot)}`);
  await rejoin(A, { x: spot.x, z: spot.z });
  // The watcher stands 7 m to the angler's left, a little toward the water, facing them.
  const rx = Math.cos(spot.yaw);
  const rz = -Math.sin(spot.yaw);
  await rejoin(B, { x: spot.x - rx * 7 - Math.sin(spot.yaw) * 1.5, z: spot.z - rz * 7 - Math.cos(spot.yaw) * 1.5 });
  await closePanels(A);
  await closePanels(B);
  const aPos = (await pl(A)).pos;
  const bPos = (await pl(B)).pos;
  note(`angler at ${JSON.stringify(aPos)}, watcher at ${JSON.stringify(bPos)}`);
  await B.evaluate(() => window.__lodestone.setView('first'));
  await look(B, yawTo(bPos, aPos.x, aPos.z), -0.05);

  // ---------------- fishing ----------------
  await A.evaluate(() => window.__lodestone.setView('third', 1, 3.6));
  await look(A, spot.yaw, -0.1);
  await sleep(800);
  let st = await fish();
  if (st.canCast) issue('fishing', 'the cast prompt shows without a rod');
  await A.evaluate(() => window.__lodestoneFishing.devRod());
  st = await waitFor(async () => {
    const s = await fish();
    return s.rod && s.canCast ? s : null;
  }, 10000);
  if (!st) {
    issue('fishing', `no cast prompt with a rod: ${JSON.stringify(await fish())}`);
  } else note(`cast target ${JSON.stringify(st.target)}`);
  await shot(A, 'fishing-prompt');

  const species = [];
  for (let round = 0; round < 3; round++) {
    await A.keyboard.press('KeyE');
    const w = await waitFor(async () => {
      const s = await fish();
      return s.phase === 'waiting' ? s : null;
    }, 6000, 50);
    if (!w) {
      issue('fishing', `cast ${round}: no line in the water: ${JSON.stringify(await fish())}`);
      break;
    }
    note(`cast ${round}: ${w.water}, bobber ${JSON.stringify(w.bobber)}`);
    if (round === 0) {
      await sleep(500);
      await shot(A, 'fishing-waiting');
      const seen = await avatarsOf(B);
      const them = seen.find((x) => Math.hypot(x.x - aPos.x, x.z - aPos.z) < 3);
      note(`watcher sees the angler: ${JSON.stringify(them)}`);
      if (!them || them.emote !== 20 || !them.rod) issue('fishing', 'the watcher does not see the fishing pose and rod');
      await shot(B, 'fishing-remote');
    }
    // the bite
    const bite = await waitFor(() => A.evaluate(() => document.querySelector('[data-testid="fish-waiting"]')?.getAttribute('data-float') === 'bite'), 12000, 30);
    if (!bite) {
      issue('fishing', `cast ${round}: never saw the bite (${JSON.stringify(await fish())})`);
      break;
    }
    if (round === 0) await shot(A, 'fishing-bite');
    await A.keyboard.press('KeyE');
    const hooked = await waitFor(async () => ((await fish()).phase === 'fight' ? true : null), 4000, 30);
    if (!hooked) {
      issue('fishing', `cast ${round}: not hooked: ${JSON.stringify(await fish())}`);
      await sleep(2600);
      continue;
    }
    // Reel like a player watching the bar: hold, let go when it reddens.
    let held = false;
    let shotFight = round !== 0;
    const t0 = Date.now();
    for (;;) {
      const s = await fish();
      if (s.phase !== 'fight') break;
      const f = s.fight;
      const want = held ? f.tension < 0.85 : f.tension < 0.45;
      if (want !== held) {
        held = want;
        if (held) await A.keyboard.down('KeyE');
        else await A.keyboard.up('KeyE');
      }
      if (!shotFight && Date.now() - t0 > 1200) {
        shotFight = true;
        await shot(A, 'fishing-fight');
      }
      if (Date.now() - t0 > 100000) break;
      await sleep(40);
    }
    if (held) await A.keyboard.up('KeyE');
    const res = await waitFor(async () => {
      const s = await fish();
      return s.phase === 'result' ? s : null;
    }, 5000, 50);
    note(`cast ${round}: ${JSON.stringify(res?.caught ?? res?.lost)} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (res?.caught) {
      species.push(res.caught.key);
      if (species.length === 1) {
        await sleep(300);
        await shot(A, 'fishing-caught');
        await sleep(300);
        const seen = await avatarsOf(B);
        const them = seen.find((x) => Math.hypot(x.x - aPos.x, x.z - aPos.z) < 3);
        note(`watcher sees the catch: ${JSON.stringify(them)}`);
        if (!them || them.emote !== 21 || !them.fish) issue('fishing', 'the watcher does not see the catch held up');
        await shot(B, 'fishing-remote-catch');
      }
    } else issue('fishing', `cast ${round} lost: ${res?.lost}`);
    await sleep(4600); // the card, then the cooldown
  }
  note(`caught: ${species.join(', ')}`);
  // The inventory holds the fish (Event 400), the journal's Fish tab lists them.
  const inv = await A.evaluate(() => window.__lodestoneInventory?.state?.()?.inv?.items?.map((i) => i.b) ?? null);
  note(`inventory: ${JSON.stringify(inv)}`);
  for (const k of species) if (inv && !inv.includes(`fish:${k}`)) issue('fishing', `fish:${k} not in the inventory`);
  await A.keyboard.press('KeyJ');
  await sleep(500);
  await A.getByTestId('journal-tab-fish').click();
  await sleep(500);
  await shot(A, 'fishing-journal');
  await A.keyboard.press('Escape');
  await sleep(400);

  // ---------------- emotes ----------------
  await A.evaluate(() => window.__lodestone.setView('third', 1, 3.6));
  await look(A, yawTo(aPos, bPos.x, bPos.z), -0.05); // face the watcher
  await sleep(600);
  await A.keyboard.down('KeyH');
  await sleep(300);
  if (!(await visible(A, '[data-testid="emote-wheel"]'))) issue('emotes', 'holding H shows no wheel');
  await A.hover('[data-testid="emote-wave"]').catch(() => {});
  await shot(A, 'emotes-wheel');
  await A.locator('[data-testid="emote-wave"]').dispatchEvent('mousedown');
  await A.keyboard.up('KeyH');
  await sleep(700);
  let seen = (await avatarsOf(B)).find((x) => Math.hypot(x.x - aPos.x, x.z - aPos.z) < 3);
  note(`watcher sees after the wheel's wave: emote ${seen?.emote}`);
  if (seen?.emote !== 1) issue('emotes', 'the wave from the wheel did not reach the watcher');
  await shot(B, 'emotes-remote-wave');
  for (const key of ['bow', 'cheer', 'dance', 'sit', 'salute', 'rest', 'point', 'shrug']) {
    await sleep(1700); // the rate limit: one per 1.5 s after the burst
    const ok = await A.evaluate((k) => window.__lodestoneEmotes.play(k), key);
    await sleep(key === 'bow' ? 900 : 700);
    seen = (await avatarsOf(B)).find((x) => Math.hypot(x.x - aPos.x, x.z - aPos.z) < 3);
    note(`${key}: played ${ok}, watcher sees emote ${seen?.emote}`);
    if (!ok || !seen?.emote) issue('emotes', `${key} did not reach the watcher`);
    await shot(B, `emotes-remote-${key}`);
  }
  // /emote in chat
  await sleep(1700);
  await A.keyboard.press('Enter');
  await sleep(300);
  await A.keyboard.type('/emote laugh');
  await A.keyboard.press('Enter');
  await sleep(700);
  seen = (await avatarsOf(B)).find((x) => Math.hypot(x.x - aPos.x, x.z - aPos.z) < 3);
  note(`/emote laugh: watcher sees emote ${seen?.emote}`);
  if (seen?.emote !== 7) issue('emotes', '/emote laugh did not reach the watcher');
  await shot(B, 'emotes-remote-laugh-chat');
  await A.keyboard.press('Escape'); // leave the chat
  await sleep(300);
  // First person: the nod and the hand.
  await sleep(1500);
  await A.evaluate(() => window.__lodestone.setView('first'));
  await sleep(300);
  await A.evaluate(() => window.__lodestoneEmotes.play('salute'));
  await sleep(500);
  await shot(A, 'emotes-firstperson-salute');
  await sleep(1800);
  await A.evaluate(() => window.__lodestoneEmotes.play('wave'));
  await sleep(450);
  await shot(A, 'emotes-firstperson-wave');
  await sleep(2000);

  // ---------------- photo mode ----------------
  await A.evaluate(() => window.__lodestone.setView('first'));
  await look(A, spot.yaw, -0.05);
  await sleep(500);
  const styleBefore = await A.evaluate(() => window.__lodestone.graphics().style);
  await A.keyboard.press('KeyP');
  await sleep(600);
  const ph = await A.evaluate(() => window.__lodestonePhoto.state());
  if (!ph.active) issue('photo', 'P did not open photo mode');
  const hudHidden = await A.evaluate(() => document.body.classList.contains('ls-photo') && getComputedStyle(document.querySelector('[data-testid="photo-panel"]')).visibility === 'visible');
  if (!hudHidden) issue('photo', 'the HUD is not hidden or the panel is not shown');
  await shot(A, 'photo-panel');
  // Fly out over the water and look back at the angler (no pointer lock headless: place the camera).
  const fx = -Math.sin(spot.yaw);
  const fz = -Math.cos(spot.yaw);
  const me = (await pl(A)).pos;
  await A.evaluate(([x, y, z, yaw]) => window.__lodestonePhoto.pose(x, y, z, yaw, -0.12), [me.x + fx * 4.5 + fz * 1.5, me.y + 2.1, me.z + fz * 4.5 - fx * 1.5, spot.yaw + Math.PI - 0.3]);
  await A.evaluate(() => window.__lodestonePhoto.set({ hour: 18.4, dof: 0.75, focusM: 0, vignette: 0.45, grain: 0.25, panelHidden: true }));
  await sleep(1200);
  await shot(A, 'photo-dusk-dof');
  // Try to fly far away: the camera stops at the radius.
  await A.keyboard.down('KeyS');
  await A.keyboard.down('ShiftLeft');
  await sleep(3500);
  await A.keyboard.up('ShiftLeft');
  await A.keyboard.up('KeyS');
  const cam = (await A.evaluate(() => window.__lodestonePhoto.state())).cam;
  const camD = Math.hypot(cam.x - me.x, cam.y - (me.y + 1.6), cam.z - me.z);
  note(`camera after flying away: ${camD.toFixed(1)} m from the eye`);
  if (camD > 30.01) issue('photo', `the camera left its radius: ${camD.toFixed(1)} m`);
  const body = await B.evaluate(() => window.__lodestone.player().pos);
  const angler = (await avatarsOf(B)).find((x) => Math.hypot(x.x - aPos.x, x.z - aPos.z) < 3);
  note(`the watcher sees the angler stand still at ${JSON.stringify(angler && { x: angler.x, z: angler.z })} (watcher at ${JSON.stringify(body)})`);
  if (!angler || Math.hypot(angler.x - me.x, angler.z - me.z) > 0.5) issue('photo', 'the angler moved on the server while flying the photo camera');
  await A.evaluate(([x, y, z, yaw]) => window.__lodestonePhoto.pose(x, y, z, yaw, -0.18), [me.x - fx * 3 + fz * 2.2, me.y + 2.4, me.z - fz * 3 - fx * 2.2, spot.yaw - 0.5]);
  await A.evaluate(() => window.__lodestone.setStyle('painterly'));
  await A.evaluate(() => window.__lodestonePhoto.set({ hour: 10, dof: 0, vignette: 0.3, grain: 0.1 }));
  await sleep(1500);
  await shot(A, 'photo-painterly-noon');
  // Save a PNG the way a player does (Enter): the browser downloads it.
  const dl = A.waitForEvent('download', { timeout: 10000 }).catch(() => null);
  await A.keyboard.press('Enter');
  const d = await dl;
  if (!d) issue('photo', 'Enter saved no PNG');
  else {
    await d.saveAs(`${EVD}/pt2-photo-saved.png`);
    note(`saved ${d.suggestedFilename()} -> ${EVD}/pt2-photo-saved.png`);
    shots.push(`${EVD}/pt2-photo-saved.png`);
  }
  await sleep(300);
  await A.evaluate(() => window.__lodestonePhoto.set({ panelHidden: false }));
  await A.keyboard.press('Escape');
  await sleep(600);
  const after = await A.evaluate(() => ({ active: window.__lodestonePhoto.state().active, cls: document.body.classList.contains('ls-photo'), style: window.__lodestone.graphics().style, menu: !!document.querySelector('[data-testid="esc-menu"]') }));
  note(`after Esc: ${JSON.stringify(after)}`);
  if (after.active || after.cls) issue('photo', 'Esc did not leave photo mode');
  if (after.style !== styleBefore) issue('photo', `the style was not restored (${after.style} vs ${styleBefore})`);
  if (after.menu) issue('photo', 'Esc in photo mode opened the Esc menu');
  await shot(A, 'photo-after');
} catch (e) {
  issue('script', String(e?.stack ?? e));
} finally {
  save();
  writeFileSync(`${EVD}/pt2-fishing-emotes-photo.json`, JSON.stringify({ issues, shots, log }, null, 2));
  await browser.close();
  note(`done: ${issues.length} issue(s)`);
}
