// Playtest 4 dialog (CR 049) evidence: a new character talks to townspeople
// on a dev zone: the first greeting (the camera has turned to the person,
// the HUD dims, the lower third), a rumour with "Mark it on my map", and the
// blacksmith's quest offer inside the conversation. Writes
// docs/evidence/pt4-dialog-*.jpg and tmp/dialog/result.json.
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1 --zone-env LODESTONE_ZONE_NO_WORLD_EVENTS=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/dialog-shots.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, newCharacter, sleep, dismissCards, pl, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'docs/evidence';
mkdirSync('tmp/dialog', { recursive: true });
const A = await launch('tmp/dialog/a', { width: 1280, height: 720 });
const result = { steps: [] };
const note = (m) => {
  console.log(`[dialog ${new Date().toISOString().slice(11, 19)}] ${m}`);
  result.steps.push(m);
};
const run = (line) => A.page.evaluate((l) => window.__lodestoneDev.run(l), line);
const jpg = async (name) => {
  await A.page.screenshot({ path: `${out}/pt4-dialog-${name}.jpg`, type: 'jpeg', quality: 72 });
  note(`shot ${name}`);
};
const npcs = () =>
  A.page.evaluate(async () => {
    const ns = await import('/src/net/netStore.ts');
    const frame = ns.netRuntime.session?.latestFrame;
    const typeOf = new Map();
    if (frame) for (const e of frame.ents) if (e.kind === 5) typeOf.set(e.id, e.typeId);
    return ns.drawnRemotes.views.filter((v) => v.kind === 5).map((v) => ({ id: v.id, name: v.name, x: v.x, y: v.y, z: v.z, role: (typeOf.get(v.id) ?? 0) & 0xff }));
  });
const state = () => A.page.evaluate(() => ({ open: !!document.querySelector('[data-testid="dialog"]'), name: document.querySelector('[data-testid="dialog-name"]')?.textContent ?? '', line: document.querySelector('[data-testid="dialog-line"]')?.textContent ?? '' }));
async function waitFor(what, fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) {
      note(`TIMEOUT ${what}`);
      return null;
    }
    await sleep(250);
  }
}
/** Stand 2 m from NPC n, look at them, press E. */
async function approach(n) {
  await dismissCards(A.page);
  const here = (await npcs()).find((v) => v.id === n.id) ?? n;
  await run(`/tp ${Math.round(here.x + 1.6)} ${Math.round(here.z + 1.2)}`);
  await sleep(1500);
  const live = (await npcs()).find((v) => v.id === n.id) ?? here;
  const p = await pl(A.page);
  await A.page.evaluate(([y]) => window.__lodestone.setLook(y, -0.05), [yawTo(p.pos ?? p, live.x, live.z)]);
  await sleep(500);
  note('at ' + JSON.stringify(p.pos ?? p) + ' npc ' + live.x.toFixed(1) + ',' + live.z.toFixed(1) + ' prompt: ' + (await A.page.evaluate(() => document.querySelector('[data-testid="town-prompt"]')?.textContent ?? '')));
  await A.page.evaluate(() => window.__lodestone.setLook(null)); // the conversation camera takes the view from here (a scripted look would fight it)
  await A.page.keyboard.press('e');
  return waitFor('dialog opens', async () => (await state()).open);
}
async function typed() {
  await waitFor('line typed', () => A.page.evaluate(() => (document.querySelector('[data-testid="dialog-choices"]')?.style.opacity ?? '0') === '1'), 15000);
}

try {
  const name = `Nicole${Date.now().toString(36).slice(-4)}`;
  await newCharacter(A.page, name);
  await sleep(2500);
  await dismissCards(A.page);
  await A.page.keyboard.press('F3').catch(() => {});
  await A.page.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 30000 });
  await run('/god');
  await run('/time 10');
  note('a new character on a dev zone');
  const list = await waitFor('townsfolk drawn', async () => ((await npcs()).length > 3 ? await npcs() : null), 40000);
  note(`${list?.length ?? 0} townsfolk around: ${(list ?? []).map((n) => `${n.name}/${n.role}`).join(', ')}`);

  // 1. The first conversation, with the quest giver's line or the greeting.
  const first = list.find((n) => n.role !== 2 && n.role !== 6) ?? list[0];
  if (await approach(first)) {
    await sleep(900);
    await jpg('greeting-typing');
    await typed();
    await sleep(400);
    await jpg('greeting');
    const st = await state();
    note(`${st.name}: ${st.line}`);
    // Advance past a quest line, if the first node is one.
    for (let i = 0; i < 4; i++) {
      const ks = await A.page.evaluate(() => [...document.querySelectorAll('[data-testid^="dialog-choice-"]')].map((b) => b.getAttribute('data-kind')));
      if (ks.includes('rumour')) break;
      if (ks.includes('quest')) {
        await jpg(`quest-offer-${i}`); // an offer inside the conversation
        await A.page.keyboard.press('2'); // "Not now": the offer stands
      } else await A.page.keyboard.press('e');
      await sleep(500);
      await typed();
    }
    // 2. A rumour, then mark it.
    const kinds = await A.page.evaluate(() => [...document.querySelectorAll('[data-testid^="dialog-choice-"]')].map((b) => b.getAttribute('data-kind')));
    const ri = kinds.indexOf('rumour');
    if (ri >= 0) {
      await A.page.keyboard.press(String(ri + 1));
      await sleep(700);
      await typed();
      await sleep(300);
      await jpg('rumour');
      const st2 = await state();
      note(`rumour: ${st2.line}`);
      const mk = await A.page.evaluate(() => [...document.querySelectorAll('[data-testid^="dialog-choice-"]')].findIndex((b) => b.getAttribute('data-kind') === 'mark'));
      if (mk >= 0) {
        await A.page.keyboard.press(String(mk + 1));
        await sleep(900);
        await typed();
        await sleep(300);
        await jpg('marked');
        note(`note: ${await A.page.evaluate(() => document.querySelector('[data-testid="dialog-note"]')?.textContent ?? '')}`);
      } else note('no mark choice');
    } else note('no rumour choice');
    await A.page.keyboard.press('Escape');
    await sleep(1200);
    await jpg('after-close-compass');
  }

  // 3. The blacksmith offers the Ward inside the conversation.
  const smith = (await npcs()).find((n) => n.role === 2);
  if (smith && (await approach(smith))) {
    await typed();
    for (let i = 0; i < 3; i++) {
      const q = await A.page.evaluate(() => !!document.querySelector('[data-testid="dialog-quest"]'));
      if (q) break;
      await A.page.keyboard.press('e');
      await sleep(400);
      await typed();
    }
    await sleep(400);
    await jpg('quest-offer');
    note(`smith: ${(await state()).line}`);
    await A.page.keyboard.press('Escape');
  } else note('no blacksmith in view');
} catch (e) {
  note(`ERROR ${e.stack ?? e}`);
} finally {
  writeFileSync('tmp/dialog/result.json', JSON.stringify(result, null, 2));
  A.save();
  await A.browser.close();
}
