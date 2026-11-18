/* global document, window */
// Playtest 5 conversations revamp (CR 053) evidence: two real browsers on a
// dev zone. Player A talks to a townsperson: the framed box (name, role,
// town, transcript, typed line, tagged answers), a check answer, a goodbye
// that answers and closes the box, walking away with a parting call, and
// player B standing nearby sees both bubbles. Writes
// docs/evidence/pt5-conversations-*.jpg and tmp/pt5conv/result.json.
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1 --zone-env LODESTONE_ZONE_NO_WORLD_EVENTS=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/pt5-conversations.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, newCharacter, sleep, dismissCards, pl, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'docs/evidence';
mkdirSync('tmp/pt5conv', { recursive: true });
const A = await launch('tmp/pt5conv/a', { width: 1280, height: 720 });
const B = await launch('tmp/pt5conv/b', { width: 1280, height: 720 });
const result = { steps: [], checks: {} };
const note = (m) => {
  console.log(`[pt5conv ${new Date().toISOString().slice(11, 19)}] ${m}`);
  result.steps.push(m);
};
const runOn = (P, line) => P.page.evaluate((l) => window.__lodestoneDev.run(l), line);
const jpg = async (P, name) => {
  await P.page.screenshot({ path: `${out}/pt5-conversations-${name}.jpg`, type: 'jpeg', quality: 72 });
  note(`shot ${name}`);
};
const npcs = (P) =>
  P.page.evaluate(async () => {
    const ns = await import('/src/net/netStore.ts');
    const frame = ns.netRuntime.session?.latestFrame;
    const typeOf = new Map();
    if (frame) for (const e of frame.ents) if (e.kind === 5) typeOf.set(e.id, e.typeId);
    return ns.drawnRemotes.views.filter((v) => v.kind === 5).map((v) => ({ id: v.id, name: v.name, x: v.x, y: v.y, z: v.z, role: (typeOf.get(v.id) ?? 0) & 0xff }));
  });
const state = (P) =>
  P.page.evaluate(() => ({
    open: !!document.querySelector('[data-testid="dialog"]'),
    name: document.querySelector('[data-testid="dialog-name"]')?.textContent ?? '',
    line: document.querySelector('[data-testid="dialog-line"]')?.textContent ?? '',
    choices: [...document.querySelectorAll('[data-testid^="dialog-choice-"]')].map((b) => ({ kind: b.getAttribute('data-kind'), low: b.getAttribute('data-low') === '1', text: b.textContent })),
    transcript: document.querySelector('[data-testid="dialog-transcript"]')?.textContent ?? '',
    chip: document.querySelector('[data-testid="dialog-check"]')?.textContent ?? '',
    bye: !!document.querySelector('[data-testid="dialog-bye"]'),
  }));
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
const typed = (P) => waitFor('line typed', () => P.page.evaluate(() => (document.querySelector('[data-testid="dialog-choices"]')?.style.opacity ?? '0') === '1' || !!document.querySelector('[data-testid="dialog-bye"]')), 15000);
const bubbles = (P, id) =>
  P.page.evaluate((tid) => [...(document.querySelector(`[data-testid="${tid}"]`)?.children ?? [])].filter((e) => e.style.display !== 'none').map((e) => e.textContent), id);

async function approach(P, n, dx = 1.6, dz = 1.2) {
  await dismissCards(P.page);
  const here = (await npcs(P)).find((v) => v.id === n.id) ?? n;
  await runOn(P, `/tp ${Math.round(here.x + dx)} ${Math.round(here.z + dz)}`);
  await sleep(1500);
  const live = (await npcs(P)).find((v) => v.id === n.id) ?? here;
  const p = await pl(P.page);
  await P.page.evaluate(([y]) => window.__lodestone.setLook(y, -0.05), [yawTo(p.pos ?? p, live.x, live.z)]);
  await sleep(500);
  await P.page.evaluate(() => window.__lodestone.setLook(null));
  await P.page.keyboard.press('e');
  return waitFor('dialog opens', async () => (await state(P)).open);
}

try {
  const stamp = Date.now().toString(36).slice(-4);
  await newCharacter(A.page, `Nicole${stamp}`);
  await newCharacter(B.page, `Ada${stamp}`);
  await sleep(2500);
  for (const P of [A, B]) {
    await dismissCards(P.page);
    await P.page.keyboard.press('F3').catch(() => {});
    await P.page.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 30000 });
    await runOn(P, '/god');
    await runOn(P, '/time 10');
  }
  const list = await waitFor('townsfolk drawn', async () => ((await npcs(A)).length > 3 ? await npcs(A) : null), 40000);
  note(`${list?.length ?? 0} townsfolk: ${(list ?? []).map((n) => `${n.name}/${n.role}`).join(', ')}`);
  // Someone to talk to who is not busy with a quest line: a merchant, innkeeper or villager.
  const target = list.find((n) => [1, 3, 5, 0].includes(n.role)) ?? list[0];

  // B stands about 8 m from the talk, to watch.
  await runOn(B, `/tp ${Math.round(target.x + 8)} ${Math.round(target.z + 4)}`);
  await sleep(1500);
  {
    const bp = await pl(B.page);
    const live = (await npcs(B)).find((v) => v.id === target.id) ?? target;
    await B.page.evaluate(([y]) => window.__lodestone.setLook(y, 0.02), [yawTo(bp.pos ?? bp, live.x, live.z)]); // B watches the talk
  }

  if (await approach(A, target)) {
    await sleep(700);
    await jpg(A, 'typing');
    await typed(A);
    await sleep(300);
    // Skip past any quest lines (keep it simple: "Go on" or "Not now" then to the topics).
    for (let i = 0; i < 4; i++) {
      const s = await state(A);
      if (s.choices.some((c) => c.kind === 'rumour')) break;
      const q = s.choices.findIndex((c) => c.kind === 'quest' && /Not right now/.test(c.text));
      await A.page.keyboard.press(q >= 0 ? String(q + 1) : 'e');
      await sleep(500);
      await typed(A);
    }
    await sleep(300);
    await jpg(A, 'box');
    let s = await state(A);
    note(`${s.name}: ${s.line}`);
    note(`answers: ${s.choices.map((c) => `${c.kind}${c.low ? '(low)' : ''}: ${c.text}`).join(' | ')}`);
    result.checks.lastIsLeave = s.choices.at(-1)?.kind === 'leave';

    // Their bubble reached B (the person's line as a bark), and A's own box has it.
    note(`B sees bubbles: ${JSON.stringify(await bubbles(B, 'npc-bubbles'))}`);
    await jpg(B, 'bystander-npc-bubble');
    result.checks.bystanderSawNpcBubble = (await bubbles(B, 'npc-bubbles')).length > 0;

    // 1. A rumour (a tagged answer), so the transcript has something in it.
    const ri = s.choices.findIndex((c) => c.kind === 'rumour');
    if (ri >= 0) {
      await A.page.keyboard.press(String(ri + 1));
      await sleep(900);
      await jpg(B, 'bystander-player-bubble');
      result.checks.bystanderSawPlayerBubble = (await bubbles(B, 'player-bubbles')).length > 0;
      note(`B sees player bubbles: ${JSON.stringify(await bubbles(B, 'player-bubbles'))}`);
      await jpg(A, 'own-bubble');
      note(`A sees player bubbles: ${JSON.stringify(await bubbles(A, 'player-bubbles'))}`);
      await typed(A);
      await sleep(300);
      await jpg(A, 'transcript');
      s = await state(A);
      note(`transcript: ${s.transcript}`);
    }

    // 2. A check answer (a tag in front, passed or too low).
    s = await state(A);
    let ci = s.choices.findIndex((c) => c.kind === 'check');
    if (ci < 0) {
      const back = s.choices.findIndex((c) => /Back to what|Thanks/.test(c.text));
      if (back >= 0) {
        await A.page.keyboard.press(String(back + 1));
        await sleep(700);
        await typed(A);
        s = await state(A);
        ci = s.choices.findIndex((c) => c.kind === 'check');
      }
    }
    if (ci >= 0) {
      await jpg(A, 'check-tag');
      note(`check: ${s.choices[ci].text} low=${s.choices[ci].low}`);
      await A.page.keyboard.press(String(ci + 1));
      await sleep(700);
      await typed(A);
      await sleep(400);
      s = await state(A);
      result.checks.checkChip = s.chip;
      note(`check result: ${s.chip} / ${s.line}`);
      await jpg(A, 'check-result');
    } else note('no check answer on screen');

    // 3. The goodbye: the last answer; they answer and the box closes by itself.
    s = await state(A);
    await typed(A);
    const li = s.choices.findIndex((c) => c.kind === 'leave');
    await A.page.keyboard.press(String(li + 1));
    await sleep(900);
    s = await state(A);
    result.checks.byeShown = s.bye;
    note(`farewell: ${s.line} (bye hint ${s.bye})`);
    await jpg(A, 'goodbye');
    const closed = await waitFor('box closes after the farewell', async () => !(await state(A)).open, 9000);
    result.checks.closedByItself = !!closed;
    note(`box closed by itself: ${!!closed}`);
    await sleep(600);
    await jpg(A, 'after-goodbye');
  } else note('could not open a conversation');

  // 4. Walking away: open again, then walk off; they call after you.
  const again = (await npcs(A)).find((n) => n.id === target.id) ?? target;
  if (await approach(A, again)) {
    await typed(A);
    await sleep(300);
    await runOn(A, `/tp ${Math.round(again.x + 14)} ${Math.round(again.z + 3)}`);
    await sleep(1800);
    const s = await state(A);
    result.checks.walkedAwayClosed = !s.open;
    note(`after walking 14 m away: open=${s.open}`);
    note(`bubbles A: ${JSON.stringify(await bubbles(A, 'npc-bubbles'))}`);
    await jpg(A, 'walked-away');
  }
} catch (e) {
  note(`ERROR ${e.stack ?? e}`);
} finally {
  writeFileSync('tmp/pt5conv/result.json', JSON.stringify(result, null, 2));
  A.save?.();
  B.save?.();
  await A.browser.close();
  await B.browser.close();
}
