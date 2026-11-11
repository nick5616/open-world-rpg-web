/* global requestAnimationFrame */
// Playtest 2 "shared basic attacks" evidence (Nicole: "make basic weapon
// attacks like wand attack viewable to everyone like the spell coming out of
// it"). Two players on a dev zone: A attacks a few training slimes with a
// wand, a staff, a bow and a sword; B stands ~7 m to A's side looking across
// at A and the slimes. For each weapon both pages are captured at the same
// moments (the shot leaving the weapon, in flight, the impact) and B's FX
// engine is sampled (remote casts seen, live projectiles, the visual its
// projectile was drawn with), then one contact sheet per run is written:
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/shared-attacks-shots.mjs [--label after] [--out docs/evidence]
//
// -> <out>/pt2-shared-attacks-<label>.jpg (A's view | B's view, per weapon and moment)
//    <out>/pt2-shared-attacks-<label>.json (what B's engine drew)
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { launch, newCharacter, sleep, dismissCards, pl, look, yawTo } from './lib.mjs';

const sharp = createRequire(new URL('../../package.json', import.meta.url))('sharp');
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.indexOf(`--${k}`) >= 0 ? argv[argv.indexOf(`--${k}`) + 1] : d);
const LABEL = arg('label', 'after');
const OUT = arg('out', 'docs/evidence');
const W = 960;
const H = 540;
const TMP = `tmp/shared-attacks/${LABEL}`;
mkdirSync(TMP, { recursive: true });

const WEAPONS = [
  { name: 'wand', item: 'birch_wand', mode: 'click', moments: [70, 140, 260] },
  { name: 'staff', item: 'oak_staff', mode: 'click', moments: [90, 170, 300] },
  { name: 'bow', item: 'oak_bow', mode: 'bow', moments: [60, 140, 260] },
  { name: 'sword', item: 'iron_sword', mode: 'click', moments: [80, 130, 200] },
];

const run = (p, l) => p.evaluate((x) => window.__lodestoneDev.run(x), l);
const t = await launch(TMP, { width: W, height: H });
const { page: a, note, issue, browser } = t;
const result = { label: LABEL, weapons: {} };
const shots = [];
try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const b = await ctx.newPage();
  b.on('pageerror', (e) => issue('B pageerror', e.message));
  for (const [p, n] of [
    [a, 'Atk'],
    [b, 'Eye'],
  ]) {
    await newCharacter(p, `${n}${Date.now().toString(36).slice(-4)}`);
    await sleep(1200);
    await dismissCards(p);
    await p.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 20000 });
    for (const l of ['/god on', '/mana on', '/time 12:00', '/weather clear']) await run(p, l);
    await p.evaluate(() => window.__lodestone.setQuality('high'));
  }
  await a.waitForFunction(() => Math.hypot(window.__lodestone.player().pos.x, window.__lodestone.player().pos.z) > 5, null, { timeout: 30000 });
  const settle = async (p) => {
    let still = 0;
    let last = null;
    for (let i = 0; i < 60 && still < 4; i++) {
      await sleep(300);
      const y = (await pl(p)).pos.y;
      still = last !== null && Math.abs(y - last) < 0.03 ? still + 1 : 0;
      last = y;
    }
  };
  await settle(a);
  const sp = await pl(a);
  await run(a, `/tp ${Math.round(sp.pos.x + 90)} ${Math.round(sp.pos.z + 70)}`);
  await settle(a);
  await sleep(1500);
  const me = (await pl(a)).pos;
  note(`A at ${Math.round(me.x)}, ${Math.round(me.z)} (spawn ${Math.round(sp.pos.x)}, ${Math.round(sp.pos.z)})`);
  // B 7 m to A's right (A faces -Z: yaw 0), a little behind, so B sees A, the weapon and the flight line
  for (let i = 0; i < 4; i++) {
    await run(b, `/tp ${(me.x + 7).toFixed(1)} ${(me.z + 2).toFixed(1)}`);
    await sleep(2500);
    const q = (await pl(b)).pos;
    if (Math.hypot(q.x - me.x - 7, q.z - me.z - 2) < 4) break;
    note(`B not there yet (${Math.round(q.x)}, ${Math.round(q.z)}), again`);
  }
  for (const p of [a, b]) await p.keyboard.press('F3');
  await sleep(9000);
  result.positions = { a: me, b: (await pl(b)).pos };
  for (const p of [a, b]) {
    await dismissCards(p);
    const tip = p.getByTestId('tip-close');
    if (await tip.isVisible().catch(() => false)) await tip.click().catch(() => {});
  }
  await a.mouse.click(W / 2, H / 2);
  const recorder = async (page) => {
    const cdp = await page.context().newCDPSession(page);
    let frames = [];
    let on = false;
    cdp.on('Page.screencastFrame', (e) => {
      cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
      if (on) frames.push({ t: e.metadata.timestamp, buf: Buffer.from(e.data, 'base64') });
    });
    return {
      start: async () => {
        frames = [];
        on = true;
        await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 75, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
      },
      stop: async () => {
        on = false;
        await cdp.send('Page.stopScreencast').catch(() => {});
        return frames;
      },
    };
  };
  const recA = await recorder(a);
  const recB = await recorder(b);
  for (const p of [a, b])
    await p.evaluate(() => {
      window.__atkProbe = { on: false, s: [] };
      const tick = () => {
        const pr = window.__atkProbe;
        if (pr.on) {
          const st = window.__lodestoneFx?.stats?.() ?? {};
          pr.s.push([Date.now(), st.projectiles ?? 0, st.particles ?? 0]);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  for (const w of WEAPONS) {
    note(`weapon ${w.name}`);
    for (const p of [a, b]) {
      const tip = p.getByTestId('tip-close');
      if (await tip.isVisible().catch(() => false)) await tip.click().catch(() => {});
    }
    await run(a, '/despawn');
    await run(a, `/equip ${w.item} legendary l1`);
    await sleep(800);
    await look(a, 0, 0.02);
    await run(a, '/spawn slime 2 40');
    await sleep(1800);
    const pa = (await pl(a)).pos;
    const target = await a.evaluate(() => {
      const me0 = window.__lodestone.player().pos;
      const vs = (window.__lodestoneDrawn?.() ?? []).filter((v) => v.kind === 2 && v.healthPct > 0);
      vs.sort((x, y) => Math.hypot(x.x - me0.x, x.z - me0.z) - Math.hypot(y.x - me0.x, y.z - me0.z));
      return vs[0] ? { x: vs[0].x, y: vs[0].y, z: vs[0].z } : null;
    });
    if (!target) {
      issue(w.name, 'no slime');
      continue;
    }
    const d = Math.hypot(target.x - pa.x, target.z - pa.z);
    await look(a, yawTo(pa, target.x, target.z), Math.atan2(target.y + 0.4 - (pa.y + 1.6), d));
    // B looks at the middle of A and the target
    const pb = (await pl(b)).pos;
    const mx = (pa.x * 2 + target.x) / 3;
    const mz = (pa.z * 2 + target.z) / 3;
    await look(b, yawTo(pb, mx, mz), Math.atan2(pa.y + 1.2 - (pb.y + 1.6), Math.hypot(mx - pb.x, mz - pb.z)));
    await sleep(500);
    const before = await b.evaluate(() => window.__lodestoneFx?.stats?.() ?? {});
    await b.evaluate(() => window.__lodestone.tap());
    const tapFrom = Date.now();
    // Both pages are recorded (DevTools screencast) while an in-page probe logs, per frame, what each
    // FX engine has live: a screenshot takes longer than a wand bolt flies.
    for (const p of [a, b]) await p.evaluate(() => {
        window.__atkProbe.s = [];
        window.__atkProbe.on = true;
      });
    await recA.start();
    await recB.start();
    await sleep(150);
    const pressAt = Date.now();
    if (w.mode === 'bow') {
      await a.evaluate(() => window.__lodestoneCombat.runtime.holdAttack(true));
      await sleep(700);
      await a.evaluate(() => window.__lodestoneCombat.runtime.holdAttack(false));
    } else await a.evaluate(() => window.__lodestoneCombat.runtime.press('attack'));
    const releaseAt = Date.now();
    await sleep(2200);
    const framesA = await recA.stop();
    const framesB = await recB.stop();
    const probeA = await a.evaluate(() => ((window.__atkProbe.on = false), window.__atkProbe.s));
    const probeB = await b.evaluate(() => ((window.__atkProbe.on = false), window.__atkProbe.s));
    // the moment each page starts drawing it: a live projectile (bolts, arrows) or, for a swing, the arc's particles
    const startOf = (pr) => {
      const base = pr.find((x) => x[0] >= releaseAt)?.[2] ?? 0;
      const hit = pr.find((x) => x[0] >= releaseAt && (w.mode === 'click' && w.name === 'sword' ? x[2] > base + 5 : x[1] > 0));
      return hit ? hit[0] : -1;
    };
    const sA = startOf(probeA);
    const sB = startOf(probeB);
    const pick = (frames, at) => frames.reduce((best, f) => (Math.abs(f.t * 1000 - at) < Math.abs(best.t * 1000 - at) ? f : best), frames[0]);
    const offsets = w.name === 'sword' ? [40, 100, 160] : [40, 90, 150];
    for (const [i, ms] of offsets.entries()) {
      const fa = `${TMP}/${w.name}-${i}-A.jpg`;
      const fb = `${TMP}/${w.name}-${i}-B.jpg`;
      const ta = (sA > 0 ? sA : releaseAt + 80) + ms;
      const tb = (sB > 0 ? sB : releaseAt + 300) + ms;
      writeFileSync(fa, pick(framesA, ta).buf);
      writeFileSync(fb, pick(framesB, tb).buf);
      shots.push({ w: w.name, i, ms: Math.round(ta - releaseAt), msB: Math.round(tb - releaseAt), fa, fb });
    }
    const after = await b.evaluate(() => window.__lodestoneFx?.stats?.() ?? {});
    const ev = await b.evaluate(() => window.__lodestone.tapped([214]).events.map((e) => ({ kind: e.kind, from: e.entityId, id: e.targetId, t: e.t })));
    const liveB = probeB.filter((x) => x[1] > 0);
    result.weapons[w.name] = {
      events214ToB: ev.filter((e) => e.t >= tapFrom - 50).map((e) => e.id),
      aDrawnByB: await b.evaluate(() => (window.__lodestoneDrawn?.() ?? []).some((v) => v.kind === 1)),
      remoteCastsSeenByB: (after.remoteCasts ?? 0) - (before.remoteCasts ?? 0),
      shotsDrawnByB: (after.shots ?? 0) - (before.shots ?? 0),
      aDrawsItMsAfterRelease: sA > 0 ? sA - releaseAt : null,
      bDrawsItMsAfterRelease: sB > 0 ? sB - releaseAt : null,
      bProjectileVisibleMs: liveB.length ? liveB.at(-1)[0] - liveB[0][0] : 0,
      pressToRelease: releaseAt - pressAt,
      targetDistance: Math.round(d * 10) / 10,
    };
    note(`${w.name}: ${JSON.stringify(result.weapons[w.name])}`);
    await sleep(900);
  }
  // the sheet: per weapon and moment, A | B
  const tw = 480;
  const th = 270;
  const rows = shots.length;
  const comp = [];
  for (const [r, s] of shots.entries()) {
    comp.push({ input: await sharp(s.fa).resize(tw, th).toBuffer(), left: 0, top: r * (th + 18) + 18 });
    comp.push({ input: await sharp(s.fb).resize(tw, th).toBuffer(), left: tw, top: r * (th + 18) + 18 });
    comp.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw * 2}" height="18"><rect width="100%" height="100%" fill="#111"/><text x="6" y="13" fill="#eee" font-family="sans-serif" font-size="12">${s.w} [${LABEL}]: left A, the attacker (${s.ms} ms after the release); right B, another player ~7 m to the side (${s.msB} ms after it: B draws A's attack when its drawn body of A gets there)</text></svg>`), left: 0, top: r * (th + 18) });
  }
  await sharp({ create: { width: tw * 2, height: rows * (th + 18), channels: 3, background: '#111' } }).composite(comp).jpeg({ quality: 68 }).toFile(`${OUT}/pt2-shared-attacks-${LABEL}.jpg`);
} catch (e) {
  issue('exception', String(e?.stack ?? e));
} finally {
  result.issues = t.issues;
  writeFileSync(`${OUT}/pt2-shared-attacks-${LABEL}.json`, JSON.stringify(result, null, 2));
  await browser.close();
}
