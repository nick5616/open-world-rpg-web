// Playtest 5 (CR 055): find a conversation that offers the stables and mark it; report the pin on the map store, the compass and the guide.
//   LODESTONE_CLIENT_URL=<stack url> node tools/playtest/pt5-stables.mjs [outDir]
import { mkdirSync } from 'node:fs';
import { launch, newCharacter, sleep, dismissCards, pl, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/pt5';
mkdirSync(out, { recursive: true });
const A = await launch(out + '/a', { width: 1280, height: 720 });
const note = (m) => console.log(`[stables ${new Date().toISOString().slice(11, 19)}] ${m}`);
const run = (line) => A.page.evaluate((l) => window.__lodestoneDev.run(l), line);
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
const name = `Nic${Date.now().toString(36).slice(-4)}`;
await newCharacter(A.page, name);
await sleep(2500);
await dismissCards(A.page);
await A.page.keyboard.press('F3').catch(() => {});
await A.page.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 30000 });
await run('/god');
await run('/time 10');
const list = await (async () => {
  for (let i = 0; i < 60; i++) {
    const l = await npcs();
    if (l.length > 3) return l;
    await sleep(500);
  }
  return [];
})();
note(`${list.length} npcs`);
let found = false;
for (const n of list) {
  if (!(await approach(n))) {
    note(`no dialog with ${n.name}`);
    continue;
  }
  await typed();
  for (let guard = 0; guard < 8 && !found; guard++) {
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
    note(`${n.name}: ${d.line.slice(0, 90)}`);
    if (/stable|steed/i.test(d.line)) {
      const mi = d.kinds.indexOf('mark');
      if (mi >= 0) {
        await A.page.keyboard.press(String(mi + 1));
        await sleep(900);
        await typed();
        d = await dlg();
        note(`note: ${d.note}`);
        found = true;
      }
    }
  }
  if ((await dlg()).open) await A.page.keyboard.press('Escape');
  await sleep(800);
  if (found) break;
}
await sleep(1200);
note('pins ' + JSON.stringify(await pins()));
const p = await pl(A.page);
note('player ' + JSON.stringify(p.pos ?? p));
note('compass ' + JSON.stringify(await A.page.evaluate(async () => (await import('/src/ui/map/Compass.tsx')).compassMarks())));
await A.page.screenshot({ path: `${out}/after-mark.jpg`, type: 'jpeg', quality: 72 });
await A.page.keyboard.press('m');
await sleep(1200);
await A.page.screenshot({ path: `${out}/map.jpg`, type: 'jpeg', quality: 72 });
await A.browser.close();
