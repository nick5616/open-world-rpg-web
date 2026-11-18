// Playtest 5 (the invisible floor underground) in the real client: walks the
// descent from the surface with real keys, through a tunnel, a cavern, the
// dwarven halls and the Depths gate, reporting every spot where the player is
// caught (no progress), snapped (a position jump) or lifted back to the
// surface, and screenshots each layer.
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1
//   node client/src/sim/probe/dump.test.ts-style dump -> PT5_VERT (the descriptor json, see below)
//   LODESTONE_CLIENT_URL=<url> PT5_VERT=C:/tmp/pt5-vert.json node tools/playtest/pt5-underground.mjs <outDir> <leg> [<leg> ...]
// Legs: corr:<n> (follow corridor n from its first point), tp:<x>,<z>,<y> (teleport),
// go:<x>,<z> (walk straight to a point), dig (dig straight down with the shovel).
import { readFileSync, writeFileSync } from 'node:fs';
import { launch, newCharacter, sleep, pl, look, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/pt5';
const legs = process.argv.slice(3);
const V = JSON.parse(readFileSync(process.env.PT5_VERT ?? 'C:/tmp/pt5-vert.json', 'utf8'));
const { page, note, shot, browser, save } = await launch(out, { width: 1280, height: 720 });
const dev = (line) => page.evaluate((l) => window.__lodestoneDev?.run(l), line);
const events = [];

async function walk(target, name, { timeoutMs = 240000, stopAt = 3 } = {}) {
  const t0 = Date.now();
  let last = null;
  let lastMove = Date.now();
  let unstick = 0;
  let prev = null;
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  try {
    for (;;) {
      const p = (await pl(page)).pos;
      if (prev) {
        const jump = Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
        if (jump > 12) {
          events.push({ leg: name, kind: 'snap', from: prev, to: p });
          note(`SNAP in ${name}: (${prev.x.toFixed(0)},${prev.y.toFixed(0)},${prev.z.toFixed(0)}) -> (${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})`);
        }
      }
      prev = p;
      const d = Math.hypot(target[0] - p.x, target[2] - p.z);
      if (d <= stopAt) return { ok: true, p };
      if (Date.now() - t0 > timeoutMs) return { ok: false, why: 'timeout', p };
      await look(page, yawTo(p, target[0], target[2]), 0);
      if (!last || Math.hypot(p.x - last.x, p.z - last.z) > 0.6) {
        last = p;
        lastMove = Date.now();
      } else if (Date.now() - lastMove > 5000) {
        unstick++;
        if (unstick > 6) return { ok: false, why: 'stuck', p };
        events.push({ leg: name, kind: 'stuck', at: p });
        note(`stuck in ${name} at (${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) heading (${target[0].toFixed(0)},${target[2].toFixed(0)}) mode ${(await pl(page)).mode}`);
        await page.keyboard.press('Space');
        const k = unstick % 2 ? 'KeyA' : 'KeyD';
        await page.keyboard.down(k);
        await sleep(600);
        await page.keyboard.up(k);
        lastMove = Date.now();
        last = null;
      }
      await sleep(100);
    }
  } finally {
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftLeft');
  }
}

try {
  await newCharacter(page, 'Dv' + Math.random().toString(36).slice(2, 7));
  await sleep(4000);
  for (const l of ['/god', '/speed 3', '/stamina']) note(`${l} -> ${JSON.stringify(await dev(l))}`);
  let n = 0;
  for (const leg of legs) {
    const [kind, arg] = leg.split(':');
    if (kind === 'tp') {
      const [x, z, y] = arg.split(',').map(Number);
      note(`tp ${arg}`);
      await dev(`/tp ${x} ${z}${y === undefined || Number.isNaN(y) ? '' : ' ' + y}`);
      await sleep(5000);
    } else if (kind === 'go') {
      const [x, z] = arg.split(',').map(Number);
      const r = await walk([x, 0, z], leg);
      note(`${leg}: ${r.ok ? 'arrived' : r.why} at (${r.p.x.toFixed(0)},${r.p.y.toFixed(1)},${r.p.z.toFixed(0)})`);
      await shot(`${String(++n)}-${kind}`);
    } else if (kind === 'dig') {
      // Dig straight down: shovel in the pack, dig mode (Equal twice), look down, hold the left button.
      await dev('/weather clear');
      await dev('/time 12');
      note(`give shovel -> ${JSON.stringify(await dev('/give tool:shovel'))}`);
      await sleep(1500);
      await page.keyboard.press('Equal');
      await page.keyboard.press('Equal');
      await look(page, 0, -1.45);
      await page.mouse.move(640, 360);
      const swings = +arg || 40;
      const ys = [];
      for (let i = 0; i < swings; i++) {
        await page.mouse.down();
        await sleep(420);
        await page.mouse.up();
        await sleep(120);
        const p = await pl(page);
        ys.push(+p.pos.y.toFixed(2));
        if (i % 4 === 3) note(`dig ${i + 1}: y ${p.pos.y.toFixed(2)} mode ${p.mode}`);
        const toast = await page.evaluate(() => [...document.querySelectorAll('[class*=toast], [role=status]')].map((e) => e.textContent).join(' | '));
        if (toast) events.push({ leg: 'dig', swing: i, toast });
        if (i === 7 || i === swings - 1) await shot(`${String(++n)}-dig-${i + 1}`);
      }
      note(`dig y trace ${ys.join(' ')}`);
      note(`dig hud: ${await page.evaluate(() => document.querySelector('[data-testid=work-hud]')?.textContent)}`);
      await page.evaluate(() => window.__lodestone.setView('third', 1, 9));
      await look(page, 0, -0.4);
      await sleep(1500);
      await shot(`${String(++n)}-dig-pit-third-person`);
      note(`dig toasts ${JSON.stringify(events.filter((e) => e.leg === 'dig').slice(-6))}`);
    } else if (kind === 'corr') {
      const c = V.corridors[+arg];
      const pts = [];
      for (let k = 0; k < c.pts.length / 3; k++) pts.push([c.pts[k * 3], c.pts[k * 3 + 1], c.pts[k * 3 + 2]]);
      let done = 0;
      for (let k = 1; k < pts.length; k++) {
        const r = await walk(pts[k], `${leg}#${k}`, { timeoutMs: 90000 });
        if (!r.ok) {
          note(`${leg}: FAILED at point ${k}/${pts.length} (${r.why}) pos (${r.p.x.toFixed(1)},${r.p.y.toFixed(1)},${r.p.z.toFixed(1)})`);
          await shot(`${String(++n)}-fail-corr${arg}-${k}`);
          break;
        }
        done = k;
        if (k % 10 === 0) await shot(`${String(++n)}-corr${arg}-${k}`);
      }
      const p = (await pl(page)).pos;
      note(`${leg}: reached point ${done}/${pts.length - 1}, pos (${p.x.toFixed(0)},${p.y.toFixed(1)},${p.z.toFixed(0)})`);
    }
  }
  writeFileSync(`${out}/events.json`, JSON.stringify(events, null, 1));
} finally {
  save();
  await browser.close();
}
