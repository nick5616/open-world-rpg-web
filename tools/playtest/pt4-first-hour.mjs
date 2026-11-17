/* global getComputedStyle */
// Playtest 4 (first hour): the first minutes of a brand-new character, as
// the player sees them. `audit` mode does nothing but watch (screenshot every
// 20 s, log every card/tip/notice/bark as it appears); `arrival` takes the
// evidence images of the first seconds.
//
//   node tools/playtest/stack.mjs
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/pt4-first-hour.mjs <outDir> [audit|arrival]   (run from client/: playwright resolves there)
import { launch, newCharacter, sleep, pl } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/pt4-first-hour';
const mode = process.argv[3] ?? 'audit';
const t = await launch(out);
const { page, shot, note, save } = t;

const snapshot = () =>
  page.evaluate(() => {
    const vis = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.05;
    };
    const rows = [];
    for (const e of document.querySelectorAll('[data-testid]')) {
      const id = e.getAttribute('data-testid');
      if (!vis(e)) continue;
      const txt = (e.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      rows.push(`${id}${txt ? ': ' + txt : ''}`);
    }
    return rows;
  });

await newCharacter(page, 'Audit' + String(Date.now()).slice(-4));
note('playing');
const t0 = Date.now();
let last = new Set();
let nextShot = 0;
const total = mode === 'audit' ? 200000 : 40000;
while (Date.now() - t0 < total) {
  const s = (Date.now() - t0) / 1000;
  const rows = await snapshot();
  const cur = new Set(rows);
  for (const r of cur) if (!last.has(r)) note(`+${s.toFixed(0)}s shown: ${r}`);
  for (const r of last) if (!cur.has(r)) note(`+${s.toFixed(0)}s gone : ${r.slice(0, 60)}`);
  last = cur;
  if (s >= nextShot) {
    await shot(`t${String(Math.round(s)).padStart(3, '0')}`);
    nextShot += mode === 'audit' ? 20 : 6;
  }
  await sleep(1000);
}
note(`player ${JSON.stringify(await pl(page))}`);
save();
await t.browser.close();
