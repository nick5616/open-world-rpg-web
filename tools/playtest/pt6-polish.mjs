/* global getComputedStyle */
// Playtest 6 polish: one pass over the polished places with a new character and real keys.
//   LODESTONE_CLIENT_URL=<stack url> node tools/playtest/pt6-polish.mjs [outDir]
// Needs a private stack with the dev console (node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1).
// Writes pt6-polish-*.jpg and pt6-polish.txt to outDir (default docs/evidence).
import { writeFileSync } from 'node:fs';
import { launch, newCharacter, sleep, dismissCards, pl, look, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'docs/evidence';
const t = await launch('tmp/pt6', { width: 1280, height: 720 });
const { page } = t;
const lines = [];
const say = (s) => (console.log(s), lines.push(s));
const jpg = (n) => page.screenshot({ path: `${out}/pt6-polish-${n}.jpg`, type: 'jpeg', quality: 62 });
const run = (l) => page.evaluate((x) => window.__lodestoneDev.run(x), l);
const key = async (k, ms = 60) => (await page.keyboard.down(k), await sleep(ms), await page.keyboard.up(k));
const closeAll = async () => {
  for (let i = 0; i < 5; i++) {
    const open = await page.evaluate(() => !!document.querySelector('[data-ui-panel]:not([style*="display: none"])'));
    if (!open) break;
    await page.keyboard.press('Escape');
    await sleep(350);
  }
  await page.mouse.click(900, 200);
  await sleep(300);
};
try {
  // A refused name reads as a sentence.
  await newCharacter(page, `Pol${Date.now().toString(36).slice(-4)}`);
  await sleep(3000);
  await dismissCards(page);
  for (let i = 0; i < 6 && !(await page.evaluate(() => window.__lodestoneDev?.state().dev === true)); i++) {
    await page.keyboard.press('F3').catch(() => {});
    await sleep(2000);
  }
  await key('F3');
  await closeAll();
  await run('/time 10');
  await sleep(1500);

  // 1. The plaza: names make room for each other.
  await run('/tp 1914.5 2276.5');
  await sleep(3000);
  await closeAll();
  await look(page, 0, 0);
  await sleep(1500);
  const labels = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-testid="npc-labels"] > div')].filter((e) => e.style.display !== 'none');
    const r = els.map((e) => e.getBoundingClientRect());
    let overlaps = 0;
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) if (r[i].left < r[j].right && r[i].right > r[j].left && r[i].top < r[j].bottom && r[i].bottom > r[j].top) overlaps++;
    return { shown: r.length, overlaps };
  });
  say(`plaza names: ${labels.shown} shown, ${labels.overlaps} overlapping pairs`);
  await jpg('1-plaza');

  // 2. Inventory icons and empty-slot silhouettes.
  await key('KeyI');
  await sleep(900);
  const ghosts = await page.evaluate(() => document.querySelectorAll('[data-testid="inv-ghost"]').length);
  say(`inventory: ${ghosts} empty equipment slots show what goes there`);
  await jpg('2-inventory');
  await closeAll();

  // 3. A rumour about a forage patch names what grows (ask Tammir until he tells one).
  const tam = (await page.evaluate(() => window.__lodestoneDrawn())).find((e) => e.name === 'Tammir');
  if (tam) {
    await run(`/tp ${(tam.x - 1.2).toFixed(1)} ${(tam.z - 1.2).toFixed(1)}`);
    await sleep(2500);
    await closeAll();
    const me = await pl(page);
    await look(page, yawTo(me.pos, tam.x, tam.z), -0.1);
    await sleep(600);
    await key('KeyE');
    await sleep(1800);
    let said = '';
    for (let k = 0; k < 14; k++) {
      if (!(await page.evaluate(() => !!document.querySelector('[data-testid="dialog"]')))) {
        await key('KeyE');
        await sleep(1800);
        continue;
      }
      const choices = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="dialog-choice-"]')].map((b) => b.textContent ?? ''));
      const i = choices.findIndex((c) => /Rumour/.test(c));
      if (i < 0) {
        await key('Space');
        await sleep(500);
        await key('Digit1');
        await sleep(1500);
        continue;
      }
      await key(`Digit${i + 1}`);
      await sleep(2600);
      await key('Space');
      await sleep(600);
      said = (await page.evaluate(() => document.querySelector('[data-testid="dialog-transcript"]')?.textContent ?? '')).slice(-400);
      if (/herb|grows|deadfall|firewood/i.test(said)) break;
    }
    say(`rumour: ${said.replace(/\s+/g, ' ').slice(-220)}`);
    await jpg('3-rumour');
    await page.keyboard.press('Escape');
    await sleep(800);
  }

  // 4. Level ups: one card, five slots in a row.
  await closeAll();
  await run('/level 10');
  await sleep(1200);
  const toasts = await page.evaluate(() => document.querySelectorAll('[data-testid="toast-level"]').length);
  say(`level 10: ${toasts} extra level toasts (want 0)`);
  await page.keyboard.down('Tab');
  await sleep(800);
  await jpg('4-level10');
  await page.keyboard.up('Tab');

  // 5. A rift: the portal, then the arena with its shots.
  await run('/god');
  await run('/tp 1914.5 2276.5');
  await sleep(2500);
  await closeAll();
  await run('/rift spawn 2');
  await sleep(2000);
  const portal = (await page.evaluate(() => window.__lodestoneRift.state().portals)).find((p) => p.dev);
  if (portal) {
    await run(`/tp ${(portal.x + 7).toFixed(1)} ${(portal.z + 7).toFixed(1)}`);
    await sleep(2500);
    await closeAll();
    const me = await pl(page);
    await look(page, yawTo(me.pos, portal.x, portal.z), 0.05);
    await sleep(1200);
    await jpg('5-portal');
  }
  await run('/rift go 4 7');
  await sleep(6000);
  await jpg('6-rift-lasers');
  await run('/rift go 5 9');
  await sleep(6000);
  await jpg('7-rift-seekers');
  const hud = await page.evaluate(() => ({
    compass: getComputedStyle(document.querySelector('[data-testid="compass"]')).visibility,
    arena: window.__lodestoneRift.state().stage?.chapterName ?? null,
  }));
  say(`rift: ${hud.arena}; compass ${hud.compass} inside`);
  await run('/rift win');
  await sleep(2500);
  await jpg('8-rift-clear');
  await run('/rift leave');
  await sleep(3000);
  say(`page errors: ${t.issues.filter((i) => i.kind === 'pageerror').length}`);
} finally {
  writeFileSync(`${out}/pt6-polish.txt`, lines.join('\n') + '\n');
  await t.browser.close();
}
