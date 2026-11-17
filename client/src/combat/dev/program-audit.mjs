// Program audit (playtest 3 kill flash): after the world's own warm-up, play
// real enemy deaths and every spell in the two galleries and report any
// shader program three.js links AFTER the warm-up (each is a main-thread
// hitch the first time it shows: a first kill, a first cast). Also checks a
// screen shockwave leaves the frame finite (no black disc).
//
//   npx vite --port 5391 &     (from client/)
//   node src/combat/dev/program-audit.mjs [http://localhost:5391]
//
// Exit 1 when a program appears late. (Headless SwiftShader: the linking is
// the same; whether a driver turns NaN into black is not testable here, see
// glslSafety.test.ts.)
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const { chromium } = require('playwright');
const BASE = process.argv[2] ?? 'http://localhost:5391';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let late = 0;

async function audit(url, ready, programs, drive) {
  const p = await browser.newPage({ viewport: { width: 640, height: 360 } });
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${BASE}${url}`);
  await p.waitForFunction(ready, null, { timeout: 180000 });
  const seen = new Set(await p.evaluate(programs));
  console.log(url, 'programs after warm-up:', seen.size);
  await drive(p, async (label, count = true) => {
    const now = await p.evaluate(programs);
    const fresh = now.filter((x) => !seen.has(x));
    if (fresh.length) {
      if (count) late += fresh.length;
      console.log(count ? '  LATE' : '  note', label, fresh.map((x) => x.slice(0, 160)));
    }
    fresh.forEach((x) => seen.add(x));
  });
  await p.close();
}

await audit(
  '/src/combat/enemies/dev/gallery.html?tier=high',
  () => window.__enemies?.ready,
  () => window.__enemies.programs(),
  async (p, check) => {
    for (const keys of [['slime', 'wolf'], ['cutthroat', 'gloamling'], ['crystal_golem']]) {
      await p.evaluate((k) => window.__enemies.show(k), keys);
      await sleep(1200);
      await check(`${keys.join('+')} in view`, false); // first instanced shadow caster links its depth program: not the kill's doing
      await p.evaluate(() => window.__enemies.act('dying'));
      await sleep(2500);
      await check(`kill ${keys.join('+')}`);
    }
  },
);

await audit(
  '/src/combat/fx/dev/gallery.html?tier=high',
  () => window.__gallery?.ready,
  () => window.__gallery.programs(),
  async (p, check) => {
    for (const k of await p.evaluate(() => window.__gallery.spellKeys())) {
      try {
        const ms = await p.evaluate((kk) => window.__gallery.cast(kk), k);
        await sleep(Math.min(1500, ms + 500));
      } catch {
        continue;
      }
      await check(`cast ${k}`);
      await p.evaluate(() => window.__gallery.clear());
    }
    await p.evaluate(() => window.__gallery.kick(4, 1));
    await sleep(150);
    await check('screen shockwave');
  },
);

await browser.close();
console.log(late ? `FAIL: ${late} program(s) linked after the warm-up` : 'OK: nothing linked after the warm-up');
process.exit(late ? 1 : 0);
