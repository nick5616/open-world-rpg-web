// Playtest 5 (CR 055) evidence, real client on a private dev stack:
//   1. a new character talks to the mentor (Tammir): the controls toast after the conversation closes, with its bar
//   2. the stables marked in a conversation: named pin on the compass and the map, "Guide me" from the journal
//   3. the journal's Info tab: services of the town, Mark on map, Guide me
// Writes docs/evidence/pt5-guidance-*.jpg and tmp/pt5/guidance.json.
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1 --zone-env LODESTONE_ZONE_NO_WORLD_EVENTS=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/pt5-guidance.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, newCharacter, sleep, dismissCards, pl, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'docs/evidence';
mkdirSync('tmp/pt5', { recursive: true });
const A = await launch('tmp/pt5/g', { width: 1280, height: 720 });
const result = { steps: [], checks: {} };
const note = (m) => {
  console.log(`[guidance ${new Date().toISOString().slice(11, 19)}] ${m}`);
  result.steps.push(m);
};
const check = (k, v) => {
  result.checks[k] = v;
  note(`CHECK ${k}: ${JSON.stringify(v)}`);
};
const run = (line) => A.page.evaluate((l) => window.__lodestoneDev.run(l), line);
const jpg = async (name) => {
  await A.page.screenshot({ path: `${out}/pt5-guidance-${name}.jpg`, type: 'jpeg', quality: 72 });
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
const dlg = () => A.page.evaluate(() => ({ open: !!document.querySelector('[data-testid="dialog"]'), line: document.querySelector('[data-testid="dialog-line"]')?.textContent ?? '', note: document.querySelector('[data-testid="dialog-note"]')?.textContent ?? '', kinds: [...document.querySelectorAll('[data-testid^="dialog-choice-"]')].map((b) => b.getAttribute('data-kind')) }));
const pins = () => A.page.evaluate(async () => (await import('/src/ui/map/store.ts')).useExploration.getState().pins);
const toasts = () => A.page.evaluate(() => [...document.querySelectorAll('[data-testid="control-toast"]')].map((e) => ({ group: e.getAttribute('data-group'), text: e.textContent, bar: !!e.querySelector('[data-testid="toast-bar"]') })));
async function typed() {
  await A.page.waitForFunction(() => (document.querySelector('[data-testid="dialog-choices"]')?.style.opacity ?? '0') === '1', null, { timeout: 15000 }).catch(() => {});
}
async function approach(n) {
  await dismissCards(A.page);
  await run(`/tp ${Math.round(n.x + 1.6)} ${Math.round(n.z + 1.2)}`);
  await sleep(1500);
  const live = (await npcs()).find((v) => v.id === n.id) ?? n;
  const p = await pl(A.page);
  await A.page.evaluate(([y]) => window.__lodestone.setLook(y, -0.05), [yawTo(p.pos ?? p, live.x, live.z)]);
  await sleep(500);
  await A.page.evaluate(() => window.__lodestone.setLook(null));
  await A.page.keyboard.press('e');
  await A.page.waitForFunction(() => !!document.querySelector('[data-testid="dialog"]'), null, { timeout: 8000 }).catch(() => {});
  return (await dlg()).open;
}

try {
  const name = `Nic${Date.now().toString(36).slice(-4)}`;
  await newCharacter(A.page, name);
  await sleep(2500);
  await dismissCards(A.page);
  await A.page.keyboard.press('F3').catch(() => {});
  await A.page.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 30000 });
  await run('/god');
  await run('/time 10');
  const list = await (async () => {
    for (let i = 0; i < 80; i++) {
      const l = await npcs();
      if (l.length > 3) return l;
      await sleep(500);
    }
    return [];
  })();
  note(`${list.length} townsfolk: ${list.map((n) => n.name + '/' + n.role).join(', ')}`);

  // ---- 1. the mentor and the controls toast
  const quest = await A.page.evaluate(async () => (await import('/src/ui/quests/store.ts')).trackedQuest()?.giver ?? '');
  const mentorName = quest.split(',')[0];
  const mentor = list.find((n) => n.name === mentorName) ?? list.find((n) => n.role === 5);
  note(`mentor: ${mentor?.name} (quest giver "${quest}")`);
  if (await approach(mentor)) {
    await typed();
    const first = await dlg();
    note(`${mentor.name} says: ${first.line}`);
    check('mentor line names no key', !/\b(press|key)\b|\[E\]|left click|\bF dodges\b/i.test(first.line));
    check('no controls toast while talking', (await toasts()).length === 0);
    await A.page.keyboard.press('Escape');
    await sleep(900);
    const t1 = await toasts();
    check('controls toast after closing', t1);
    await jpg('controls-toast');
    await sleep(5000);
    await jpg('controls-toast-later'); // the bar has drained a good way
    const bar = await A.page.evaluate(() => {
      const b = document.querySelector('[data-testid="control-toast"] [data-testid="toast-bar"]');
      if (!b) return null;
      const cs = getComputedStyle(b);
      return { transform: cs.transform, anim: cs.animationName, timing: cs.animationTimingFunction, duration: cs.animationDuration };
    });
    check('bar animating', bar);
  } else note('could not talk to the mentor');

  // ---- 2. the stables, marked in a conversation
  await A.page.evaluate(() => document.querySelector('[data-testid="control-toast-close"]')?.click());
  const fenia = list.filter((n) => n.role === 1 || n.role === 3 || n.role === 5);
  let marked = null;
  for (const n of fenia) {
    if (marked) break;
    if (!(await approach(n))) continue;
    await typed();
    for (let guard = 0; guard < 8 && !marked; guard++) {
      let d = await dlg();
      if (!d.open) break;
      if (d.kinds.includes('quest')) {
        await A.page.keyboard.press(String(d.kinds.length));
        await sleep(500);
        await typed();
        continue;
      }
      const ri = d.kinds.indexOf('rumour');
      if (ri < 0) {
        if (d.kinds.length === 1) {
          await A.page.keyboard.press('e');
          await sleep(400);
          await typed();
          continue;
        }
        break;
      }
      await A.page.keyboard.press(String(ri + 1));
      await sleep(700);
      await typed();
      d = await dlg();
      if (/stable|steed/i.test(d.line)) {
        const mi = d.kinds.indexOf('mark');
        if (mi >= 0) {
          await A.page.keyboard.press(String(mi + 1));
          await sleep(900);
          await typed();
          d = await dlg();
          marked = d.note;
        }
      }
    }
    if ((await dlg()).open) await A.page.keyboard.press('Escape');
    await sleep(800);
  }
  note(`dialog note: ${marked}`);
  check('dialog note names the stables', marked);
  const ps = await pins();
  check('pins', ps);
  const comp = await A.page.evaluate(async () => (await import('/src/ui/map/Compass.tsx')).compassMarks());
  check('compass', comp.filter((m) => m.kind === 'pin'));
  await A.page.evaluate(() => document.querySelector('[data-testid="control-toast-close"]')?.click());
  // Walk away from town a little so the compass has the stables well off to the side, then shoot the compass.
  await sleep(600);
  await jpg('stables-compass');
  await A.page.keyboard.press('m');
  await sleep(1200);
  await jpg('stables-map');
  await A.page.keyboard.press('m');
  await sleep(500);

  // ---- 3. the journal's Info tab
  await A.page.keyboard.press('j');
  await sleep(600);
  await A.page.getByTestId('journal-tab-info').click();
  await sleep(600);
  const rows = await A.page.evaluate(() => [...document.querySelectorAll('[data-testid="info-service"]')].map((e) => ({ kind: e.getAttribute('data-kind'), text: e.textContent })));
  check('info services', rows);
  await jpg('info-tab');
  const before = (await pins()).length;
  await A.page.locator('[data-testid="info-service"][data-kind="smith"] [data-testid="info-mark"]').click();
  await sleep(1200);
  const after = await pins();
  check('smith pin added with a name', after.slice(before));
  await jpg('info-marked');
  await A.page.locator('[data-testid="info-service"][data-kind="inn"] [data-testid="info-guide"]').click();
  await sleep(2500);
  await jpg('info-guide-wisp');
  result.ok = true;
} catch (e) {
  note(`ERROR ${e.stack ?? e}`);
  await A.page.screenshot({ path: 'tmp/pt5/error.jpg', type: 'jpeg', quality: 60 }).catch(() => {});
} finally {
  writeFileSync('tmp/pt5/guidance.json', JSON.stringify(result, null, 2));
  await A.browser.close();
}
