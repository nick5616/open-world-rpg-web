// Playtest 2 main story (CR 035) evidence: two players in a party on a dev
// zone play key moments of "The Last Song": Act I's title card and the
// keeper's step shared by both, the vigil of Act IV and the Starless
// Sovereign, the Hush's entrance at the Heartfall, its phases (the shroud,
// the choir of bells, the endless night and its wells), a revive, the
// ending over the sunrise and the credits, the post-game journal. Travel,
// levels and the long middle of the story go through the dev console
// (/tp, /level, /story ...). Writes docs/evidence/pt2-main-story-*.jpg and
// tmp/story/result.json.
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1 --zone-env LODESTONE_ZONE_NO_WORLD_EVENTS=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/story-shots.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, newCharacter, sleep, dismissCards, pl } from './lib.mjs';

const out = process.argv[2] ?? 'docs/evidence';
mkdirSync('tmp/story', { recursive: true });
const W = { width: 1280, height: 720 };
const A = await launch('tmp/story/a', W);
const B = await launch('tmp/story/b', W);
const result = { steps: [] };
const issues = [];
const note = (m) => {
  console.log(`[story ${new Date().toISOString().slice(11, 19)}] ${m}`);
  result.steps.push(m);
};
const issue = (k, m) => {
  issues.push({ k, m });
  note(`ISSUE ${k}: ${m}`);
};
const run = (t, line) => t.page.evaluate((l) => window.__lodestoneDev.run(l), line);
const jpg = async (t, name) => {
  await dismissCards(t.page); // the welcome card comes up a little after the first frame
  await t.page.screenshot({ path: `${out}/pt2-main-story-${name}.jpg`, type: 'jpeg', quality: 70 });
};
const story = (t) => t.page.evaluate(() => window.__lodestoneStory.state());
const tracked = (t) => t.page.evaluate(() => window.__lodestoneQuests.tracked());
const act = async (t) => {
  const s = await story(t);
  return s.sync ? s.sync.act : -1;
};
async function waitFor(what, fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) {
      issue('timeout', what);
      return null;
    }
    await sleep(300);
  }
}
/** Talk to the townsperson nearest a marker (kind 5: npc). */
async function talk(t, m) {
  const id = await waitFor(`${m.label} drawn`, () =>
    t.page.evaluate(async ([x, z]) => {
      const ns = await import('/src/net/netStore.ts');
      let best = null;
      let bd = 12;
      for (const v of ns.drawnRemotes.views) {
        const d = Math.hypot(v.x - x, v.z - z);
        if (v.kind === 5 && d < bd) {
          best = v.id;
          bd = d;
        }
      }
      return best;
    }, [m.x, m.z]),
  );
  if (id) await t.page.evaluate((i) => window.__lodestoneQuests.send(30, i, 1), id);
  await sleep(1500);
  // Close the townsperson's panel (the panel stack, as Esc would).
  await t.page.evaluate(() => {
    for (let i = 0; i < 4 && window.__lodestonePanels?.top(); i++) window.__lodestonePanels.closeTop();
  });
  return id;
}
const tp = (t, x, z) => run(t, `/tp ${Math.round(x)} ${Math.round(z)}`);

try {
  const tag = Date.now().toString(36).slice(-4);
  const nameA = `Nicole${tag}`;
  const nameB = `Friend${tag}`;
  await newCharacter(A.page, nameA);
  await newCharacter(B.page, nameB);
  await sleep(1500);
  for (const t of [A, B]) {
    await sleep(2500);
    await dismissCards(t.page);
    await t.page.keyboard.press('F3').catch(() => {}); // the debug readout off
    await t.page.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 30000 });
    await run(t, '/god');
  }
  note('two characters on a dev zone');

  // A party of two (the social service; the zone polls it).
  await A.page.evaluate(async (n) => (await import('/src/social/index.ts')).sendSocial({ type: 'party_invite', name: n }), nameB);
  const accept = B.page.getByTestId('party-accept');
  await accept.waitFor({ timeout: 15000 }).catch(() => issue('party', 'no invite on B'));
  await dismissCards(B.page);
  await B.page.evaluate(() => document.querySelector('[data-testid="party-accept"]')?.click()); // a card may sit over it
  const partied = await waitFor('the zone sees the party', async () => (await story(A)).party?.members?.length === 1, 30000);
  note(`party: ${partied ? 'yes' : 'no'}`);

  // The prologue done: Act I starts with its title card.
  for (const t of [A, B]) {
    await run(t, '/quest all done');
    await sleep(800);
    await run(t, '/quest all done');
  }
  await waitFor('Act I started', async () => (await act(A)) === 1 && (await act(B)) === 1);
  await sleep(900);
  await jpg(A, 'act1-intro');
  note('act I intro');

  // The keeper's step: A talks, both advance (B stands beside A).
  const q = await tracked(A);
  const keeper = q?.markers?.[0];
  if (keeper) {
    await tp(A, keeper.x + 1.5, keeper.z + 1);
    await tp(B, keeper.x + 2.5, keeper.z + 2);
    await sleep(2500);
    await talk(A, keeper);
    await waitFor('B shared the keeper step', async () => (await tracked(B))?.step === 1);
    await sleep(1500);
    await jpg(B, 'shared-step');
    result.shared = { a: (await tracked(A))?.step, b: (await tracked(B))?.step };
    note(`shared step: ${JSON.stringify(result.shared)}`);
  } else issue('act1', 'no keeper marker');

  // Act IV: the vigil.
  for (const t of [A, B]) {
    await run(t, '/level 14');
    await run(t, '/story act 4 2');
  }
  await sleep(1200);
  const cap = (await tracked(A))?.markers?.[0];
  if (cap) {
    await tp(A, cap.x + 1.5, cap.z + 1);
    await tp(B, cap.x + 3, cap.z + 2);
    await run(A, '/time 15:00'); // townsfolk keep their work spots by day
    await sleep(3000);
    await talk(A, cap);
    await run(A, '/time 21:30'); // the vigil by night
    await waitFor('the vigil step', async () => (await tracked(A))?.step === 3);
    await sleep(17000); // the ward falters (15 s), the first wave comes
    await jpg(A, 'vigil');
    await run(A, '/story vigil');
    await waitFor('the Sovereign step', async () => (await tracked(B))?.step === 4);
    await sleep(2500);
    await jpg(B, 'sovereign');
    await run(A, '/story win'); // the Sovereign falls
    await waitFor('the report step', async () => (await tracked(A))?.step === 5);
    note('vigil held, the Sovereign fell');
  } else issue('act4', 'no captain marker');

  // Act VI: the Heartfall and the Hush.
  for (const t of [A, B]) {
    await run(t, '/level 16');
    await run(t, '/story act 6 2');
  }
  await sleep(1000);
  await run(A, '/time 22:00');
  await run(A, '/story heartfall');
  await run(B, '/story heartfall');
  const intro = await waitFor('the Hush rises', async () => (await story(B)).cinematic, 30000);
  if (intro) {
    await sleep(2600);
    await jpg(B, 'hush-intro');
    note('the Hush intro');
  }
  await sleep(6000);
  // Walk both in close (the Hush wakes on proximity).
  const f0 = (await story(A)).finale;
  if (f0) {
    await tp(A, f0.x + 6, f0.z);
    await tp(B, f0.x - 6, f0.z + 3);
  }
  await waitFor('the shroud', async () => ((await story(A)).finale?.shroud ?? 0) > 0, 40000);
  await sleep(600);
  await jpg(A, 'shroud');
  await run(A, '/story hush 69');
  await waitFor('the choir', async () => ((await story(B)).finale?.bells ?? 0) > 0, 15000);
  await sleep(2500);
  await jpg(B, 'choir');
  await run(A, '/story bells');
  await sleep(1500);
  await run(A, '/story hush 34');
  const night = await waitFor('the endless night', async () => {
    const f = (await story(A)).finale;
    return f && f.wells.length >= 2 ? f : null;
  }, 20000);
  if (night) {
    await tp(A, night.wells[0].x, night.wells[0].z);
    await tp(B, night.wells[1].x, night.wells[1].z);
    await sleep(1500);
    await jpg(B, 'wells');
    note(`wells ${JSON.stringify(night.wells)}`);
  }
  await sleep(7000);
  // A revive: B goes down beside A, A holds E.
  const pa = await pl(A.page);
  await tp(B, pa.pos.x + 1.6, pa.pos.z);
  await sleep(1200);
  await dismissCards(A.page);
  await dismissCards(B.page);
  await run(B, '/story down');
  await waitFor('A sees B down', async () => Object.keys((await story(A)).downed).length > 0, 8000);
  result.focus = await A.page.evaluate(() => { const el = document.activeElement; const d = el ? `${el.tagName}#${el.getAttribute('data-testid') ?? ''}` : ''; el?.blur?.(); return d; });
  await A.page.keyboard.down('KeyE');
  await sleep(400);
  result.reviveDiag = await A.page.evaluate(async () => {
    const st = window.__lodestoneStory.state();
    const ia = await import('/src/input/interact.ts');
    const p = window.__lodestone.player();
    return { key: window.__reviveKey ?? null, actions: !!window.__lodestoneStory.state().actions, lines: st.lines.map((l) => l.text), reviving: st.reviving, downed: Object.values(st.downed).map((d) => [d.id, Math.round(Math.hypot(d.x - p.pos.x, d.z - p.pos.z) * 10) / 10]), eFree: ia.eFree('revive'), panel: ia.uiPanelUp() };
  });
  note(`revive diag ${JSON.stringify(result.reviveDiag)}`);
  if (!result.reviveDiag.reviving) {
    // Let go and press again (a person would).
    await A.page.keyboard.up('KeyE');
    await sleep(300);
    await A.page.keyboard.down('KeyE');
    await sleep(500);
    result.reviveDiag2 = await A.page.evaluate(() => ({ key: window.__reviveKey ?? null, reviving: window.__lodestoneStory.state().reviving }));
    note(`second press ${JSON.stringify(result.reviveDiag2)}`);
  }
  if (!result.reviveDiag.reviving && !result.reviveDiag2?.reviving) {
    // The key did not start it: say so, and hold it through the handle (the same Interact).
    issue('revive-key', 'holding E did not start the revive');
    const id = result.reviveDiag.downed[0]?.[0];
    if (id) await A.page.evaluate((i) => window.__lodestoneStory.revive(i, true), id);
    await sleep(400);
    note(`after the handle: ${JSON.stringify(await A.page.evaluate(() => [window.__lodestoneStory.state().reviving, window.__lodestoneStory.state().lines.map((l) => l.text)]))}`);
  }
  await sleep(1100);
  await jpg(B, 'revive');
  await sleep(2400);
  await A.page.keyboard.up('KeyE');
  const raised = await waitFor('B raised', async () => (await story(B)).reviveUntil === 0, 6000);
  note(`revive: ${raised ? 'yes' : 'no'}`);

  // Victory: the ending, the credits.
  await run(A, '/story win');
  const ending = await waitFor('the ending', async () => (await story(B)).ending, 15000);
  if (ending) {
    result.ending = { together: ending.together, names: ending.names, lines: ending.lines.length };
    await sleep(13000);
    await jpg(B, 'ending');
    await sleep(17000);
    await jpg(A, 'credits');
    for (const t of [A, B]) await t.page.evaluate(() => window.__lodestoneStory.closeEnding());
  }
  await sleep(1500);
  // The post-game journal.
  await A.page.keyboard.press('KeyJ');
  await sleep(1200);
  await jpg(A, 'postgame');
  result.after = { a: (await story(A)).sync, b: (await story(B)).sync?.beaten };
  note(`after: beaten ${result.after.a?.beaten} together ${result.after.a?.together}`);
} catch (e) {
  issue('exception', String(e?.stack ?? e));
  await A.page.screenshot({ path: 'tmp/story/fail-a.jpg', type: 'jpeg', quality: 60 }).catch(() => {});
  await B.page.screenshot({ path: 'tmp/story/fail-b.jpg', type: 'jpeg', quality: 60 }).catch(() => {});
} finally {
  writeFileSync('tmp/story/result.json', JSON.stringify({ result, issues }, null, 2));
  await A.browser.close();
  await B.browser.close();
}
