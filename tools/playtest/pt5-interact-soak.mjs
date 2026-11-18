// Playtest 5 "can't interact": a long soak in the real client. After every
// step that captures keys or holds state (conversations, panels, mounting,
// build mode, death, reconnect) it checks that E still works on a ground
// pickup (a dropped sword) and on a townsperson (the conversation opens).
// The first failing step dumps who owns E (prompts, panels, dialog store).
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1 --zone-env LODESTONE_ZONE_NO_WORLD_EVENTS=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/pt5-interact-soak.mjs [outDir] [--rounds 3]
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, newCharacter, sleep, dismissCards, pl, yawTo } from './lib.mjs';

const out = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'tmp/pt5-soak';
const rounds = +(process.argv[process.argv.indexOf('--rounds') + 1] || 2) || 2;
mkdirSync(out, { recursive: true });
const A = await launch(`${out}/raw`, { width: 1280, height: 720 });
const page = A.page;
const result = { steps: [], failures: [] };
const note = (m) => {
  console.log(`[soak ${new Date().toISOString().slice(11, 19)}] ${m}`);
  result.steps.push(m);
};
const run = (line) => page.evaluate((l) => window.__lodestoneDev.run(l), line);
const key = async (k, ms = 60) => {
  await page.keyboard.down(k);
  await sleep(ms);
  await page.keyboard.up(k);
};
const npcs = () =>
  page.evaluate(async () => {
    const ns = await import('/src/net/netStore.ts');
    const frame = ns.netRuntime.session?.latestFrame;
    const typeOf = new Map();
    if (frame) for (const e of frame.ents) if (e.kind === 5) typeOf.set(e.id, e.typeId);
    return ns.drawnRemotes.views.filter((v) => v.kind === 5).map((v) => ({ id: v.id, name: v.name, x: v.x, y: v.y, z: v.z, role: (typeOf.get(v.id) ?? 0) & 0xff }));
  });
const pickups = () =>
  page.evaluate(async () => {
    const ns = await import('/src/net/netStore.ts');
    const f = ns.netRuntime.session?.latestFrame;
    return (f?.ents ?? []).filter((e) => e.kind === 4).map((e) => ({ id: e.id, name: e.name, x: e.x, y: e.y, z: e.z }));
  });
/** Esc only while something is open: a spare Esc opens the Esc menu (which rightly holds every hotkey). */
const escIfOpen = async () => {
  if ((await dialogOpen()) || (await page.evaluate(() => (window.__lodestonePanels?.open().length ?? 0) > 0))) await key('Escape');
};
const dialogOpen = () => page.evaluate(() => !!document.querySelector('[data-testid="dialog"]'));

/** Everything that decides who answers E. */
const diag = () =>
  page.evaluate(async () => {
    const I = await import('/src/input/interact.ts');
    const D = await import('/src/ui/dialog/store.ts');
    const P = await import('/src/input/panelStack.ts');
    const N = await import('/src/world/buildings/npcFocus.ts');
    const L = await import('/src/input/lookRouter.ts');
    const inv = (await import('/src/ui/inventory/store.ts')).useInventory.getState();
    const d = D.useDialog.getState();
    return {
      prompts: Object.fromEntries(I.E_ORDER.map((u) => [u, I.ePromptUp(u)])),
      panelsUp: [...document.querySelectorAll('[data-ui-panel], [data-testid="emote-wheel"], [data-testid="pet-wheel"]')].filter((el) => el.style.display !== 'none' && el.getClientRects().length > 0).map((el) => el.dataset.testid || el.tagName),
      stack: P.openPanels(),
      dialog: { open: d.open, parked: d.parked, awaitingWork: d.awaitingWork, node: !!d.node, key: d.key },
      talkingTo: N.npcFocus.talkingTo,
      blockMove: L.lookRouter.blockMove,
      dataDialog: document.body.dataset.dialog ?? null,
      invOpen: inv.invOpen,
      station: !!inv.station,
      active: document.activeElement ? `${document.activeElement.tagName}#${document.activeElement.id}` : null,
      lock: !!document.pointerLockElement,
      eFree: I.eFree('loot'),
      townPrompt: document.querySelector('[data-testid="town-prompt"]')?.textContent ?? null,
      townPromptCount: document.querySelectorAll('[data-testid="town-prompt"]').length,
    };
  });

/** Stand by a villager (not the stable master) and look at them. */
let town = null;
async function faceNpc(prefer = -1) {
  let list = await npcs();
  if (!list.length) {
    town ??= await page.evaluate(() => window.__lodestoneDev.state().places.towns[0]);
    await run(`/tp ${town.x} ${town.z}`);
    for (let i = 0; i < 60 && !list.length; i++) {
      await sleep(500);
      list = await npcs();
    }
  }
  const n = list.find((v) => v.role === prefer) ?? list.find((v) => v.role !== 2 && v.role !== 6) ?? list[0];
  if (!n) return null;
  await run(`/tp ${Math.round(n.x + 1.6)} ${Math.round(n.z + 1.2)}`);
  await sleep(1500);
  const live = (await npcs()).find((v) => v.id === n.id) ?? n;
  const p = await pl(page);
  await page.evaluate(([y]) => window.__lodestone.setLook(y, -0.05), [yawTo(p.pos ?? p, live.x, live.z)]);
  await sleep(450);
  await page.evaluate(() => window.__lodestone.setLook(null));
  return live;
}

async function probeNpc() {
  if (await dialogOpen()) {
    await key('Escape');
    await sleep(500);
  }
  const face = await faceNpc();
  const pre = await page.evaluate(() => ({ prompt: document.querySelector('[data-testid="town-prompt"]')?.textContent ?? '', at: document.querySelector('[data-testid="town-prompt"]')?.dataset.eAt ?? null, now: performance.now() }));
  await key('KeyE');
  let ok = false;
  for (let i = 0; i < 16 && !ok; i++) {
    await sleep(250);
    ok = await dialogOpen();
  }
  if (!ok) {
    const post = await page.evaluate(async () => {
      const D = (await import('/src/ui/dialog/store.ts')).useDialog.getState();
      return { toast: D.toast?.text ?? null, open: D.open, target: window.__lodestoneTowns?.target?.() ?? null, now: performance.now() };
    });
    const pos = await pl(page);
    note(`probeNpc failed: face=${JSON.stringify(face)} me=${JSON.stringify(pos.pos ?? pos)} pre=${JSON.stringify(pre)} post=${JSON.stringify(post)}`);
  }
  if (ok) {
    await key('Escape');
    await sleep(600);
  }
  return ok;
}

let wild = null;
/** The point on the map farthest from every town, vault and tower: nothing there outranks loot. */
async function wildSpot() {
  const pl2 = await page.evaluate(() => window.__lodestoneDev.state().places);
  const pts = [...pl2.towns, ...pl2.vaults, ...pl2.towers];
  let best = { d: 0, x: 1000, z: 1000 };
  for (let x = 800; x < 3300; x += 100)
    for (let z = 800; z < 3300; z += 100) {
      const d = Math.min(...pts.map((q) => Math.hypot(q.x - x, q.z - z)));
      if (d > best.d) best = { d, x, z };
    }
  return best;
}
async function probeLoot() {
  wild ??= await wildSpot();
  // a fresh patch each probe: drops lie for 10 minutes, and another character's unverified drop is not ours to take
  await run(`/tp ${wild.x + Math.round((Math.random() - 0.5) * 220)} ${wild.z + Math.round((Math.random() - 0.5) * 220)}`);
  let lastY = -1e9;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const y = ((await pl(page)).pos ?? (await pl(page))).y;
    if (Math.abs(y - lastY) < 0.02 && i > 4) break;
    lastY = y;
  }
  const before = new Set((await pickups()).map((x) => x.id));
  await run('/give weapon:sunsteel_blade 1 rare');
  let h = null;
  for (let i = 0; i < 30 && h === null; i++) {
    await sleep(300);
    h = await page.evaluate(async () => {
      const st = (await import('/src/ui/inventory/store.ts')).useInventory.getState();
      const it = (st.inv?.items ?? []).find((x) => x.b === 'weapon:sunsteel_blade' && x.s.startsWith('inv:'));
      return it?.h ?? null;
    });
  }
  if (h === null) { note('probeLoot: sword never arrived'); return null; }
  const me = (await pl(page)).pos ?? (await pl(page));
  await page.evaluate(async (hh) => (await import('/src/ui/inventory/store.ts')).useInventory.getState().actions.item(hh, 2, 1), h);
  let drop;
  for (let i = 0; i < 24 && !drop; i++) {
    await sleep(250);
    drop = (await pickups()).find((x) => !before.has(x.id));
  }
  if (!drop) { note(`probeLoot: no drop appeared (h=${h}, now ${JSON.stringify(await pickups())}, inv ${await page.evaluate(async () => JSON.stringify(((await import('/src/ui/inventory/store.ts')).useInventory.getState().inv?.items ?? []).map((x) => x.b + '@' + x.s).slice(0, 12)))})`); return null; }
  await run(`/tp ${(drop.x / 100 + 0.6).toFixed(1)} ${(drop.z / 100).toFixed(1)}`);
  await sleep(900);
  const p = await pl(page);
  await page.evaluate(([y]) => window.__lodestone.setLook(y, -0.3), [yawTo(p.pos ?? p, drop.x / 100, drop.z / 100)]);
  await sleep(600);
  await page.evaluate(() => window.__lodestone.setLook(null));
  void me;
  const nearCount = async () => {
    const m = (await pl(page)).pos ?? (await pl(page));
    return (await pickups()).filter((x) => Math.hypot(x.x / 100 - m.x, x.z / 100 - m.z) < 3).length;
  };
  const near0 = await nearCount(); // older drops from earlier runs lie here for 10 minutes: E takes the nearest of them
  const pre = await diag();
  const prompt = await page.evaluate(() => document.querySelector('[data-testid="loot-prompt"]')?.textContent ?? null);
  await key('KeyE');
  for (let i = 0; i < 10; i++) {
    await sleep(250);
    if (!(await pickups()).some((x) => x.id === drop.id) || (await nearCount()) < near0) return true;
  }
  const at = await pl(page);
  note(`probeLoot failed: prompt=${prompt} me=${JSON.stringify(at.pos ?? at)} drop=${drop.x / 100},${drop.y / 100},${drop.z / 100} wild=${JSON.stringify(wild)} diag=${JSON.stringify(pre)}`);
  return false;
}

let failed = false;
async function check(step) {
  if (failed) return;
  const loot = await probeLoot();
  const talk = await probeNpc();
  const ok = loot === true && talk === true;
  note(`${ok ? 'OK  ' : 'FAIL'} after ${step}: loot=${loot} talk=${talk}`);
  if (!ok) {
    const d = await diag();
    note(`DIAG ${JSON.stringify(d)}`);
    result.failures.push({ step, loot, talk, diag: d });
    await page.screenshot({ path: `${out}/fail-${result.failures.length}.jpg`, type: 'jpeg', quality: 70 });
    if (process.env.SOAK_STOP !== '0') failed = true;
  }
}

async function panel(code, name) {
  await key(code);
  await sleep(500);
  const open = await page.evaluate(() => [...document.querySelectorAll('[data-ui-panel]')].filter((el) => el.getClientRects().length > 0).length);
  await key(code);
  await sleep(400);
  if (open === 0) {
    // some panels are closed by Esc only
  }
  await escIfOpen();
  await sleep(300);
  await escIfOpen();
  await sleep(300);
  await check(`panel ${name} (${open} up)`);
}

try {
  const name = `Soak${Date.now().toString(36).slice(-4)}`;
  await newCharacter(page, name);
  await sleep(2500);
  await dismissCards(page);
  await page.keyboard.press('F3').catch(() => {});
  await page.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 90000 }).catch(async () => {
    note(`dev state: ${JSON.stringify(await page.evaluate(() => ({ has: !!window.__lodestoneDev, st: window.__lodestoneDev?.state?.() ?? null, ph: window.__lodestone?.netDebug?.()?.phase })))}`);
    await page.screenshot({ path: `${out}/nodev.jpg`, type: 'jpeg', quality: 60 });
    throw new Error('no dev console');
  });
  await run('/god');
  await run('/time 10');
  await run('/gold 5000');
  await page.waitForFunction(async () => ((await (await import('/src/net/netStore.ts')).drawnRemotes.views.filter((v) => v.kind === 5).length) > 3), null, { timeout: 60000 });
  await check('start');

  for (let r = 0; r < rounds && !failed; r++) {
    note(`--- round ${r + 1}`);
    // talk, Esc mid-conversation
    await faceNpc();
    await key('KeyE');
    await sleep(1500);
    await key('Escape');
    await sleep(500);
    await check('talk + Esc mid-line');
    // talk, then the zone drops it when we teleport away
    await faceNpc();
    await key('KeyE');
    await sleep(1500);
    const here = (await pl(page)).pos ?? (await pl(page));
    await run(`/tp ${Math.round(here.x + 40)} ${Math.round(here.z + 40)}`);
    await sleep(2500);
    note(`dialog after teleporting away: ${await dialogOpen()}`);
    await check('talk + walked away (tp)');
    // talk, take a service (shop/board) from the conversation, close it with Esc and with E
    for (const closeWith of ['Escape', 'KeyE', 'Escape']) {
      await faceNpc(1);
      await key('KeyE');
      await sleep(1500);
      const work = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="dialog-choice-"]')].findIndex((b) => b.getAttribute('data-kind') === 'work'));
      for (let i = 0; i < 4 && work < 0; i++) {
        const w2 = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="dialog-choice-"]')].findIndex((b) => b.getAttribute('data-kind') === 'work'));
        if (w2 >= 0) break;
        await key('KeyE');
        await sleep(700);
      }
      const wi = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="dialog-choice-"]')].findIndex((b) => b.getAttribute('data-kind') === 'work'));
      if (wi >= 0) {
        await page.waitForFunction(() => (document.querySelector('[data-testid="dialog-choices"]')?.style.opacity ?? '0') === '1', null, { timeout: 15000 }).catch(() => {});
        await key(`Digit${wi + 1}`);
        await sleep(1500);
        note(`service opened: panel=${await page.evaluate(() => document.querySelector('[data-testid="town-panel"]')?.style.display)} dialog=${await dialogOpen()}`);
        if (closeWith === 'Escape') await escIfOpen();
        else await key(closeWith);
        await sleep(700);
        note(`after ${closeWith}: dialog=${await dialogOpen()} townPanel=${await page.evaluate(() => document.querySelector('[data-testid="town-panel"]')?.style.display)}`);
        await escIfOpen();
        await sleep(600);
      } else {
        note('no service choice on this person');
        await escIfOpen();
        await sleep(500);
      }
      await check(`conversation service closed with ${closeWith}`);
    }
    // panels
    for (const [code, nm] of [['KeyI', 'inventory'], ['KeyM', 'map'], ['KeyJ', 'journal'], ['KeyC', 'character'], ['KeyN', 'skill tree'], ['KeyB', 'build overview'], ['KeyK', 'sound'], ['F10', 'graphics'], ['KeyO', 'friends'], ['KeyY', 'achievements'], ['KeyP', 'camp menu'], ['KeyL', 'photo mode']]) {
      await panel(code, nm);
      if (failed) break;
    }
    // Esc menu
    await key('Escape');
    await sleep(400);
    await key('Escape');
    await sleep(400);
    await check('Esc menu');
    // emote wheel held, released
    await page.keyboard.down('KeyH');
    await sleep(500);
    await page.keyboard.up('KeyH');
    await sleep(400);
    await check('emote wheel');
    // steed: summon, mount, dismount
    await run('/steed');
    await sleep(1500);
    await key('Digit5');
    await sleep(2500);
    await key('KeyE');
    await sleep(1500);
    note(`mounted: ${await page.evaluate(() => window.__lodestone.player().mounted ?? null)}`);
    await key('KeyE');
    await sleep(1500);
    await check('mount + dismount');
    // build mode
    await key('Digit9');
    await sleep(800);
    await key('Digit9');
    await sleep(600);
    await check('build mode');
    // death and respawn
    await run('/god off');
    await run('/spawn boss 1 60');
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      const dead = await page.evaluate(() => document.body.innerText.toLowerCase().includes('respawn') || !!document.querySelector('[data-testid="death-screen"], [data-testid="respawn"]'));
      if (dead) {
        note('dead');
        break;
      }
    }
    await page.screenshot({ path: `${out}/death-${r}.jpg`, type: 'jpeg', quality: 60 });
    await run('/despawn');
    await sleep(500);
    const btn = page.locator('[data-testid="respawn"], [data-testid="respawn-btn"], button:has-text("Respawn")').first();
    if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
    await sleep(3500);
    await run('/god');
    await run('/heal');
    await check('death + respawn');
  }
} catch (e) {
  note(`SCRIPT ERROR ${e?.stack ?? e}`);
} finally {
  writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
  A.save();
  await A.browser.close().catch(() => {});
  console.log(failed || result.failures.length ? 'SOAK: FAILURES' : 'SOAK: all OK');
}
