// Playtest 2 ground loot: two players on a private dev stack (two browser
// contexts in one headless Chromium). Player A kills a camp (its personal
// loot scatters on the ground: real models, beams, sparkles; B does not see
// A's rolls), takes one with E, opens a chest (its items pop out onto the
// ground), drops a line of items of every rarity that BOTH see in the same
// places with the same item and rarity (compared entity by entity), day and
// night; then a scene of ~40 drops for the frame-time check.
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1 --zone-env LODESTONE_ZONE_NO_WORLD_EVENTS=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/ground-loot-shots.mjs [--out docs/evidence] [--skip-perf]
//
// Writes docs/evidence/pt2-ground-loot-*.jpg and tmp/ground-loot/report.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, newCharacter, sleep, dismissCards } from './lib.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const OUT = arg('--out', 'docs/evidence');
const TMP = 'tmp/ground-loot';
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });

const T = await launch(`${TMP}/raw`, { width: 1280, height: 720 });
const { note, issue } = T;
const A = T.page;
const ctxB = await T.browser.newContext({ viewport: { width: 1280, height: 720 } });
const B = await ctxB.newPage();
B.on('pageerror', (e) => issue('pageerror B', e.message));
const report = { checks: {}, perf: {} };
const check = (k, ok, detail) => {
  report.checks[k] = { ok: !!ok, detail };
  note(`${ok ? 'PASS' : 'FAIL'} ${k}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

const run = (p, line) => p.evaluate((l) => window.__lodestoneDev.run(l), line);
const me = (p) => p.evaluate(() => window.__lodestone.player().pos);
const look = (p, yaw, pitch = 0) => p.evaluate(([y, q]) => window.__lodestone.setLook(y, q), [yaw, pitch]);
const view = (p, mode, dist = 3.4) => p.evaluate(([m, d]) => window.__lodestone.setView(m, 1, d), [mode, dist]);
const yawTo = (p, x, z) => Math.atan2(-(x - p.x), -(z - p.z));
async function lookAt(p, x, y, z) {
  const m = await me(p);
  await look(p, yawTo(m, x, z), Math.atan2(y - (m.y + 1.7), Math.hypot(x - m.x, z - m.z)));
}
async function settle(p, ms = 1500) {
  for (let i = 0; i < 60; i++) {
    const st = await p.evaluate(() => window.__lodestoneWorld?.stats?.());
    if (!st?.terrain || (st.terrain.queued + st.terrain.inFlight === 0 && st.terrain.missingWanted === 0)) break;
    await sleep(250);
  }
  await sleep(ms);
}
const tp = async (p, x, z, ms = 1200) => {
  await run(p, `/tp ${x.toFixed(1)} ${z.toFixed(1)}`);
  await sleep(500);
  await settle(p, ms);
};
/** Pickups in the latest snapshot: id, item, rarity, position (cm). */
const pickups = (p) =>
  p.evaluate(async () => {
    const ns = await import('/src/net/netStore.ts');
    const f = ns.netRuntime.session?.latestFrame;
    return (f?.ents ?? []).filter((e) => e.kind === 4).map((e) => ({ id: e.id, name: e.name, r: e.typeId, x: e.x, y: e.y, z: e.z }));
  });
const drawn = (p) =>
  p.evaluate(() => {
    const m = window.__lodestone.player().pos;
    return (window.__lodestoneDrawn?.() ?? []).map((e) => ({ id: e.id, kind: e.kind, x: e.x, y: e.y, z: e.z, hp: e.healthPct, d: Math.hypot(e.x - m.x, e.z - m.z) })).sort((a, b) => a.d - b.d);
  });
async function clean(p, on) {
  await p.evaluate((v) => {
    let s = document.getElementById('ls-clean');
    if (!s) {
      s = document.createElement('style');
      s.id = 'ls-clean';
      s.textContent = 'body.ls-clean *:not(canvas):not(:has(canvas)) { visibility: hidden !important; }';
      document.head.appendChild(s);
    }
    document.body.classList.toggle('ls-clean', v);
  }, on);
}
async function shot(p, name, { hud = false } = {}) {
  await dismissCards(p);
  await clean(p, !hud);
  await sleep(300);
  const f = `${OUT}/pt2-ground-loot-${name}.jpg`;
  await p.screenshot({ path: f, type: 'jpeg', quality: 72 });
  await clean(p, false);
  note(`shot ${f}`);
  return f;
}
async function fight(p, x, z, ms) {
  const t0 = Date.now();
  let kills = 0;
  while (Date.now() - t0 < ms) {
    await dismissCards(p);
    const e = (await drawn(p)).find((v) => v.kind === 2 && v.hp > 0 && Math.hypot(v.x - x, v.z - z) < 30);
    if (!e) break;
    const m = await me(p);
    await look(p, yawTo(m, e.x, e.z), Math.max(-0.5, Math.min(0.3, Math.atan2(e.y + 0.4 - (m.y + 1.6), Math.max(0.5, e.d)))));
    if (e.d > 2.3) {
      await p.keyboard.down('KeyW');
      await sleep(Math.min(400, (e.d - 2) * 160));
      await p.keyboard.up('KeyW');
      continue;
    }
    await p.mouse.down();
    await sleep(40);
    await p.mouse.up();
    await sleep(260);
    const after = (await drawn(p)).find((v) => v.id === e.id);
    if (!after || after.hp <= 0) kills++;
  }
  return kills;
}
const inv = (p) => p.evaluate(async () => (await import('/src/ui/inventory/store.ts')).useInventory.getState().inv);
/** Give an item and drop one of it in front of the player (a public pickup everyone near sees). */
async function giveDrop(p, key, rarity, qty = 1) {
  const before = new Set(((await inv(p))?.items ?? []).map((i) => i.h));
  await run(p, `/give ${key} ${qty} ${rarity}`);
  for (let i = 0; i < 20; i++) {
    const it = ((await inv(p))?.items ?? []).find((x) => x.b === key && x.s.startsWith('inv:') && !before.has(x.h));
    const any = it ?? ((await inv(p))?.items ?? []).find((x) => x.b === key && (x.s.startsWith('inv:') || x.s === 'purse'));
    if (it || (i > 6 && any)) {
      const h = (it ?? any).h;
      await p.evaluate(async ([hh, q]) => (await import('/src/ui/inventory/store.ts')).useInventory.getState().actions.item(hh, 2, q), [h, qty]);
      await sleep(350);
      return true;
    }
    await sleep(150);
  }
  issue('give', `${key} ${rarity} never arrived`);
  return false;
}
async function frameTimes(p, ms = 5000) {
  return p.evaluate(async (dur) => {
    const ts = [];
    let last = performance.now();
    const t0 = last;
    await new Promise((res) => {
      const f = (t) => {
        ts.push(t - last);
        last = t;
        if (t - t0 < dur) requestAnimationFrame(f);
        else res();
      };
      requestAnimationFrame(f);
    });
    ts.shift();
    const s = [...ts].sort((a, b) => a - b);
    const q = (k) => +s[Math.min(s.length - 1, Math.floor(k * s.length))].toFixed(1);
    const st = window.__lodestoneWorld?.stats?.();
    return { frames: ts.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +s[s.length - 1].toFixed(1), over33: ts.filter((x) => x > 33.4).length, calls: st?.frame?.calls ?? null, tris: st?.frame?.triangles ?? null };
  }, ms);
}

try {
  const tag = Date.now() % 100000;
  await newCharacter(A, `Looter${tag}`);
  await newCharacter(B, `Watcher${tag}`);
  for (const p of [A, B]) {
    await dismissCards(p);
    await run(p, '/god on');
  }
  await run(A, '/weather clear');
  await run(A, '/time 12');
  await run(A, '/freeze on');
  await run(A, '/level 30');
  await run(A, '/equip weapon:voidglass_sword mythic l1 lvl=30');
  await run(A, '/fly off');
  await view(A, 'third', 4);
  await view(B, 'third', 4);
  // The middle of the largest meadow: open ground, no town in the way.
  await A.waitForFunction(() => window.__lodestoneWorld?.biomeSpot, null, { timeout: 60000 }).catch(() => {});
  const spot = await A.evaluate(() => window.__lodestoneWorld?.biomeSpot?.(0) ?? null);
  if (!spot) throw new Error('no world debug handle (biomeSpot)');
  const jit = Math.round((Math.random() - 0.5) * 400); // a fresh patch each run: drops from an earlier run lie for 10 minutes
  const X0 = spot.x + jit;
  const Z0 = spot.z - jit;
  await tp(A, X0, Z0, 2500);
  await tp(B, X0 + 8, Z0 + 8, 2500);
  const a0 = await me(A);
  note(`A at ${JSON.stringify(a0)}`);

  // ---- 1. A camp of boars: A's personal loot scatters on the ground ----
  await look(A, 0, 0);
  const old = new Set((await pickups(A)).map((x) => x.id));
  await run(A, '/spawn wolf 5 12 fast');
  await sleep(2500);
  const kills = await fight(A, a0.x, a0.z, 60000);
  await sleep(2500);
  const pa = (await pickups(A)).filter((x) => !old.has(x.id));
  const pb = await pickups(B);
  const aOnly = pa.filter((x) => !pb.some((y) => y.id === x.id));
  check('camp killed, loot on the ground', kills >= 1 && pa.length > 0, { kills, drops: pa.map((x) => `${x.name}(r${x.r})`) });
  check("B does not see A's personal kill loot", aOnly.length === pa.length, { aSees: pa.length, bSeesOfThem: pa.length - aOnly.length });
  if (pa.length) {
    const best = [...pa].sort((p, q) => q.r - p.r)[0];
    const avg = pa.reduce((s, x) => ({ x: s.x + x.x / 100 / pa.length, y: s.y + x.y / 100 / pa.length, z: s.z + x.z / 100 / pa.length }), { x: 0, y: 0, z: 0 });
    // frame the rarest drop (its beam) with the rest of the scatter around it
    const c = best.r >= 2 ? { x: (best.x / 100 + avg.x) / 2, y: (best.y / 100 + avg.y) / 2, z: (best.z / 100 + avg.z) / 2 } : avg;
    const m = await me(A);
    const dx = m.x - c.x;
    const dz = m.z - c.z;
    const d = Math.hypot(dx, dz) || 1;
    await tp(A, c.x + (dx / d) * 3.2, c.z + (dz / d) * 3.2, 800);
    await view(A, 'first');
    await lookAt(A, c.x, c.y, c.z);
    await sleep(800);
    await shot(A, 'kill-day');
    await view(A, 'third', 4);
    // A takes one item with E (walk-over took the gold and commons already).
    const left = (await pickups(A)).filter((x) => !old.has(x.id));
    const target = left.find((x) => /^(weapon|armor|tome|blueprint):/.test(x.name)) ?? left.find((x) => !x.name.startsWith('currency:')); // gear waits for E
    if (target) {
      await tp(A, target.x / 100 + 0.8, target.z / 100, 500);
      await lookAt(A, target.x / 100, target.y / 100, target.z / 100);
      await sleep(400);
      const prompt = await A.evaluate(() => document.querySelector('[data-testid="loot-prompt"]')?.textContent ?? '');
      await A.keyboard.press('KeyE');
      await sleep(1200);
      const gone = !(await pickups(A)).some((x) => x.id === target.id);
      check('A takes a drop with E', gone, { item: target.name, prompt });
    }
  }

  // ---- 2. A chest: its items pop out onto the ground ----
  const chest = await A.evaluate(async () => {
    const st = (await import('/src/ui/inventory/store.ts')).useInventory.getState();
    const m = window.__lodestone.player().pos;
    return st.containers.filter((c) => !c.opened).map((c) => ({ id: String(c.id), x: c.x, y: c.y, z: c.z, d: Math.hypot(c.x - m.x, c.z - m.z) })).sort((a, b) => a.d - b.d)[0] ?? null;
  });
  if (chest) {
    await tp(A, chest.x - 1.5, chest.z, 1500);
    await view(A, 'first');
    await tp(A, chest.x - 3.2, chest.z - 0.5, 300);
    await lookAt(A, chest.x, chest.y + 0.2, chest.z);
    const n0 = (await pickups(A)).length;
    await A.evaluate(async (id) => (await import('/src/ui/inventory/store.ts')).useInventory.getState().actions.openContainer(BigInt(id)), chest.id);
    await sleep(700);
    await shot(A, 'chest-pop');
    await sleep(1500);
    const n1 = (await pickups(A)).length;
    check('a chest drops its items on the ground', n1 > n0, { before: n0, after: n1 });
    await lookAt(A, chest.x, chest.y, chest.z);
    await sleep(600);
    await shot(A, 'chest-day');
    await view(A, 'third', 4);
  } else issue('chest', 'no container listed near A');

  // ---- 3. Shared drops: a line of every rarity both players see ----
  const LINE = [
    ['weapon:iron_sword', 'common'],
    ['potion:health', 'uncommon'],
    ['weapon:oak_bow', 'rare'],
    ['armor:sunsteel_helm', 'relic'],
    ['weapon:sunsteel_blade', 'legendary'],
    ['weapon:starmetal_spear', 'mythic'],
    ['armor:sunsteel_mail', 'primordial'],
    ['weapon:voidglass_sword', 'bitchin'],
  ];
  const LX = a0.x + 30;
  const oldLine = new Set((await pickups(A)).map((x) => x.id)); // only this run's drops
  const LZ = a0.z;
  for (let i = 0; i < LINE.length; i++) {
    await tp(A, LX + i * 2.6, LZ, i === 0 ? 1500 : 250);
    await look(A, Math.PI, 0); // facing +Z: the drop lands 1 m toward +Z
    await giveDrop(A, LINE[i][0], LINE[i][1]);
  }
  await sleep(1500);
  const mid = { x: LX + 3.5 * 2.6, z: LZ + 1 };
  await tp(A, mid.x - 3, mid.z + 9, 800);
  await tp(B, mid.x + 4, mid.z + 10, 800);
  await sleep(1500);
  const sa = (await pickups(A)).filter((x) => !oldLine.has(x.id) && Math.abs(x.z / 100 - mid.z) < 3 && Math.abs(x.x / 100 - mid.x) < 14);
  const sb = (await pickups(B)).filter((x) => !oldLine.has(x.id) && Math.abs(x.z / 100 - mid.z) < 3 && Math.abs(x.x / 100 - mid.x) < 14);
  const same = sa.length === LINE.length && sa.every((x) => sb.some((y) => y.id === x.id && y.name === x.name && y.r === x.r && y.x === x.x && y.y === x.y && y.z === x.z));
  check('both players see the same dropped items in the same places', same, { A: sa.map((x) => `${x.name}:r${x.r}@${x.x},${x.z}`), B: sb.length });
  for (const p of [A, B]) await lookAt(p, mid.x, 0.9 + (await me(p)).y - 0.2, mid.z);
  await sleep(800);
  await shot(A, 'shared-day-A');
  await shot(B, 'shared-day-B');
  // up close
  await view(A, 'first');
  await tp(A, LX + 4 * 2.6 + 0.3, LZ + 5.5, 500);
  await lookAt(A, LX + 4 * 2.6, (await me(A)).y + 0.9, LZ + 1);
  await sleep(600);
  await shot(A, 'closeup-day');
  await view(A, 'third', 4);
  // night
  await run(A, '/time 22.5');
  await sleep(4000);
  await tp(A, mid.x - 3, mid.z + 12, 600);
  for (const p of [A, B]) await lookAt(p, mid.x, (await me(p)).y + 2, mid.z);
  await sleep(1200);
  await shot(A, 'shared-night-A');
  await shot(B, 'shared-night-B');
  // from afar: rare+ beams across the mid ring
  await tp(B, mid.x + 90, mid.z + 90, 1500);
  await lookAt(B, mid.x, (await me(B)).y + 6, mid.z);
  await sleep(1500);
  const far = (await pickups(B)).filter((x) => Math.abs(x.z / 100 - mid.z) < 3 && Math.abs(x.x / 100 - mid.x) < 14);
  check('from 127 m, B still sees the rare+ drops (beams) and not the commoner ones', far.length > 0 && far.every((x) => x.r >= 2), far.map((x) => `${x.name}:r${x.r}`));
  await shot(B, 'far-night-B');
  // A takes the legendary; B sees it go
  const leg = sa.find((x) => x.r === 4);
  if (leg) {
    await tp(B, mid.x + 4, mid.z + 10, 800);
    await tp(A, leg.x / 100 + 0.9, leg.z / 100 + 0.3, 600);
    await lookAt(A, leg.x / 100, leg.y / 100, leg.z / 100);
    await sleep(400);
    await A.keyboard.press('KeyE');
    await sleep(1500);
    const goneA = !(await pickups(A)).some((x) => x.id === leg.id);
    const goneB = !(await pickups(B)).some((x) => x.id === leg.id);
    check('A takes the legendary; it is gone for B too', goneA && goneB, { goneA, goneB });
  }
  await run(A, '/time 12');

  // ---- 4. Perf: ~40 drops in view ----
  if (!process.argv.includes('--skip-perf')) {
    const PX = a0.x - 70;
    const PZ = a0.z + 20;
    await tp(A, PX - 6, PZ - 8, 2500);
    await lookAt(A, PX + 6, (await me(A)).y, PZ + 6);
    report.perf.before = await frameTimes(A);
    const keys = ['weapon:iron_sword', 'potion:health', 'armor:leather_cap', 'herb:heartleaf', 'weapon:oak_bow', 'fish:speckled_trout', 'tome:ember_flick', 'ammo:iron_arrow'];
    const rar = ['common', 'uncommon', 'rare', 'relic', 'legendary', 'common', 'uncommon', 'rare'];
    let n = 0;
    for (let gz = 0; gz < 5; gz++)
      for (let gx = 0; gx < 8; gx++) {
        await tp(A, PX + gx * 1.8, PZ + gz * 1.8, 0);
        await look(A, Math.PI, 0);
        if (await giveDrop(A, keys[(gx + gz) % keys.length], rar[(gx * 3 + gz) % rar.length])) n++;
      }
    await sleep(1500);
    await tp(A, PX - 6, PZ - 8, 1500);
    await lookAt(A, PX + 6, (await me(A)).y, PZ + 4);
    await sleep(1500);
    report.perf.drops = n;
    report.perf.after = await frameTimes(A);
    await shot(A, 'forty-day');
    note(`perf ${JSON.stringify(report.perf)}`);
  }
} catch (e) {
  issue('fatal', e.stack ?? String(e));
} finally {
  report.issues = T.issues;
  writeFileSync(`${TMP}/report.json`, JSON.stringify(report, null, 2));
  T.save();
  await T.browser.close();
}
