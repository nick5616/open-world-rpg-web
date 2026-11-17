#!/usr/bin/env node
// Gate G4 (spec 15): "Full loop: fight, loot, mine ore and a gem, forge a
// sunsteel blade, socket the gem, survive a night in a generated town." One
// end-to-end session on the merged main for ONE character: real account,
// director, zone and social processes (built from this checkout, private
// random ports, a scratch database, so a fresh world id), the client from
// Vite, one headless Chromium player driving the real client UI with real
// key and mouse events (inventory on I, the town's talk/shop panel, the
// forge's crafting panel, socketing in the inventory), and two WP15 night
// bots joining for the town defense.
//
//   1. Fight a camp outside the spawn town with the starting sword, walk
//      over the personal loot, open a chest (E).
//   2. Mine sunsteel ore (two veins, 4 ore = 2 ingots per the recipe) and a
//      gem vein (aim + E, as G3).
//   3. Travel back to the town on foot (from outside its ward to the smithy).
//   4. Talk to the blacksmith, buy the Sunsteel Blade blueprint (gold),
//      use the forge: smelt 2 sunsteel ingots, forge the blade.
//   5. Inventory (I): socket the gem into the blade, equip it (loadout 2;
//      loadout 1 keeps the ordinary starting sword).
//   6. Night: fast-forward to dusk, step outside the ward, demons rise; the
//      ordinary sword cannot kill the high-level ones (level 20: they shrug and regenerate; a level 1 pack dies to it, CR 048), the
//      sunsteel blade does.
//   7. Town defense: two night bots join at the ward garden and the ward
//      falters (WP15's dev force, the same StartDefense a seeded night uses);
//      the player fights the waves at the garden until the event ends.
//   8. Dawn: the clock is moved to just before sunrise; dawn burns what is
//      left; the player is alive.
//
//   node tools/acceptance/g4.mjs [--keep-db] [--stop-after <1..8>] [--no-bots] [--defense-only]
//
// Dev shortcuts (all used by earlier harnesses): zone LODESTONE_ZONE_DEV_SPAWN
// (rejoins at `?spawn=` points: the cave veins and the start of the walk
// back to town), LODESTONE_ZONE_DEBUG_CAMP (the camp placed outside the spawn
// town, as WP13/WP14), LODESTONE_ZONE_TIME_OFFSET_S + the dev set-time
// Interact 52/2 (morning start, dusk, just before dawn), the dev defense
// Interact 52/1 (sent by the night bots, as WP15), the bots' dev sunsteel
// (Interact 50/6, as WP15; the browser player uses only the forged blade),
// LODESTONE_ZONE_DEBUG_RAIN=0 and ?rain=0 (dry weather, as G3).
//
// Evidence: docs/evidence/g4-acceptance.txt, g4-acceptance.json, g4-*.png
// (see docs/evidence/g4-README.md).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { env, killTree, root, waitHttp } from '../../scripts/lib.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const KEEP_DB = process.argv.includes('--keep-db');
const NO_BOTS = process.argv.includes('--no-bots');
const DEF_ONLY = process.argv.includes('--defense-only'); // harness debugging: straight to the town defense
const STOP_AFTER = Number(arg('stop-after', '99'));
const EVIDENCE = path.join(root, 'docs', 'evidence');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-g4-'));
const RUN = Date.now().toString(36);
const DB = `lodestone_wp04_g4_${RUN}`; // devdb manages lodestone_wp04_* scratch databases only
const EXE = process.platform === 'win32' ? '.exe' : '';
const ZONE_ID = `zone-g4-${RUN}`;
const NAME = 'Brannoc';
const USER = `g4brannoc${RUN}`;
const GPU_ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const H = '127.0.0.1';
// Official world (seed 20261108): the dev camp hint WP14's G4 loop used
// (spawn settlement radius + 70 m, outside the ward); the zone snaps it to
// walkable ground and the run reads the real anchor back from /debug/combat.
const CAMP_HINT = { x: 2085, z: 2385 };
// Veins WP14's loop proved reachable on this world (tried first; the rest of
// the world's veins follow in graph order).
const KNOWN_VEINS = ['8835879023699622851', '14318032726258039959', '7840581575915726357'];

fs.mkdirSync(EVIDENCE, { recursive: true });
for (const f of fs.readdirSync(EVIDENCE)) if (/^g4-\d\d-.*\.png$/.test(f)) fs.rmSync(path.join(EVIDENCE, f)); // this run's shots only
const lines = [];
function step(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  lines.push(line);
}
const failures = [];
const verdicts = {};
let item = 'setup';
function check(cond, msg, detail) {
  const d = detail === undefined ? '' : '  ' + JSON.stringify(detail);
  if (!cond) failures.push(`[${item}] ${msg}`);
  (verdicts[item] ??= []).push(!!cond);
  step(`${cond ? 'PASS' : 'FAIL'} ${msg}${d}`);
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = [];
async function shot(page, name) {
  const file = `g4-${String(shots.length + 1).padStart(2, '0')}-${name}.png`;
  shots.push(file);
  await page.screenshot({ path: path.join(EVIDENCE, file) });
  step(`  screenshot ${file}`);
}
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

function goSync(args, extra = {}) {
  const r = spawnSync('go', args, { cwd: root, env: env(extra), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`go ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
// Unique binary names: other agents on this machine stop their own
// processes by image name.
const bin = (name) => path.join(TMP, `g4${RUN}-${name}${EXE}`);
const children = [];
let stopping = false;
let dead = null;
function start(name, cmd, args, extra, cwd = root, onExit = null) {
  const out = fs.createWriteStream(path.join(TMP, `${name}.log`));
  const child = spawn(cmd, args, { cwd, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.push(child);
  child.on('exit', (code, sig) => {
    if (onExit) return onExit(code, sig);
    if (!stopping) {
      dead = `${name} exited (${code ?? sig}) during the run`;
      step(`ERROR service ${name} exited (${code ?? sig}) during the run; see ${path.join(TMP, name + '.log')}`);
    }
  });
  return child;
}
async function freePort(taken) {
  for (;;) {
    const p = 20000 + Math.floor(Math.random() * 25000);
    if (taken.has(p)) continue;
    const ok = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(p, H, () => s.close(() => res(true)));
    });
    if (ok) {
      taken.add(p);
      return p;
    }
  }
}
/** World clock offset so that the zone starts at hour h (an in-game hour is 150 s). */
function offsetForHour(h) {
  const tod = (Date.now() / 1000) % 3600;
  return Math.round((((h * 150 - tod) % 3600) + 3600) % 3600);
}

// ---------------------------------------------------------------- zone debug
let ZONE = '';
async function zget(p) {
  const r = await fetch(`${ZONE}${p}`);
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
}
const night = () => zget('/debug/night');
const combatDbg = () => zget('/debug/combat');
const itemsDbg = (char) => zget(`/debug/items?char=${encodeURIComponent(char)}`);
function zoneLogLines(re, n = 12) {
  try {
    return fs.readFileSync(path.join(TMP, 'zone.log'), 'utf8').split('\n').filter((l) => re.test(l)).slice(-n);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- page helpers
const pl = (page) => page.evaluate(() => window.__lodestone.player());
const look = (page, yaw, pitch = 0) => page.evaluate(([y, p]) => window.__lodestone.setLook(y, p), [yaw, pitch]);
const yawTo = (from, x, z) => Math.atan2(-(x - from.x), -(z - from.z));
const inv = (page) => page.evaluate(() => window.__lodestoneInventory.state());
// The combat HUD store (loadouts) with health from the latest SelfState (the store's own health fields are not fed).
const hud = (page) =>
  page.evaluate(() => {
    const h = window.__lodestoneCombat?.hud();
    const s = window.__lodestone.selfHealth();
    return h ? { ...h, ...(s ?? {}) } : null;
  });
const lowHealth = { night: Infinity, nightMax: 0 }; // lowest own health seen while fighting at night
const nightHud = (page) => page.evaluate(() => window.__lodestoneNight?.hud() ?? null);
const tapped = (page, kinds = null, since = 0) => page.evaluate(([k, s]) => window.__lodestone.tapped(k, s), [kinds, since]);
const netd = (page) => page.evaluate(() => {
  const d = window.__lodestone.netDebug();
  return d ? { phase: d.phase, reconciles: d.prediction.reconciles, agreements: d.prediction.agreements, maxError: d.prediction.maxError } : null;
});
function units(state) {
  const m = {};
  for (const it of state?.inv?.items ?? []) m[it.b] = (m[it.b] ?? 0) + it.q;
  return m;
}
const fmtUnits = (u) => Object.entries(u).sort().map(([k, v]) => `${k}=${v}`).join(' ');

async function signInAndPlay(page, user, charName) {
  await page.getByTestId('auth-dev-username').waitFor({ timeout: 180000 });
  await page.getByTestId('auth-dev-username').fill(user);
  await page.getByTestId('auth-dev-submit').click();
  await page.getByTestId('char-name').waitFor();
  if ((await page.getByTestId(`play-${charName}`).count()) === 0) {
    await page.getByTestId('char-name').fill(charName);
    await page.getByTestId('char-create').click();
  }
  await page.getByTestId(`play-${charName}`).click();
  await waitPlaying(page);
}
async function waitPlaying(page) {
  await page.waitForFunction(() => window.__lodestone?.netDebug?.()?.phase === 'playing', null, { timeout: 120000 });
  await page.waitForFunction(() => !!window.__lodestoneTowns && !!window.__lodestoneCaves && !!window.__lodestoneInventory?.state().inv && !!window.__lodestoneCombat?.hud().active && !!window.__lodestoneNight, null, { timeout: 240000 });
  await page.evaluate(() => {
    window.__lodestone.tap();
    window.__lodestone.setQuality('medium');
  });
}

/**
 * Leave the zone (play screen unmounts, the session closes), wait until the
 * zone has let the character go, rejoin at a dev spawn point with a fresh
 * director ticket (same character, same browser session).
 */
async function rejoinAt(page, char, at, label) {
  const t0 = Date.now();
  await page.evaluate(() => window.__lodestone.screen('title'));
  for (let i = 0; i < 200; i++) {
    const info = await itemsDbg(char).catch(() => ({ online: true }));
    if (!info.online) break;
    await sleep(100);
  }
  await page.evaluate((a) => window.__lodestone.rejoinAt(a), at);
  await waitPlaying(page);
  const p = (await pl(page)).pos;
  step(`  rejoined at ${label} (${at.x.toFixed(1)}, ${at.y === undefined ? '~' : at.y.toFixed(1)}, ${at.z.toFixed(1)}): standing at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return p;
}

/**
 * Walk toward (x, z) like a player: face it, hold W (+ Shift), re-aim, hop
 * and side-step when stuck. Ends within stopAt m, when done() says so, or on
 * timeout.
 */
async function walkTo(page, x, z, { stopAt = 1, timeoutMs = 300000, done = null, sprint = false, label = '' } = {}) {
  const t0 = Date.now();
  let p = (await pl(page)).pos;
  let lastLog = 0;
  let last = null;
  let stuck = 0;
  let unstick = 0;
  await page.keyboard.down('KeyW');
  if (sprint) await page.keyboard.down('ShiftLeft');
  try {
    for (;;) {
      if (dead) throw new Error(dead);
      p = (await pl(page)).pos;
      const d = Math.hypot(x - p.x, z - p.z);
      if (d <= stopAt || (done && (await done(p, d)))) return { ok: true, p, d, ms: Date.now() - t0 };
      if (Date.now() - t0 > timeoutMs) return { ok: false, p, d, ms: Date.now() - t0 };
      await look(page, yawTo(p, x, z), 0);
      if (last && Math.hypot(p.x - last.x, p.z - last.z) < 0.03) stuck++;
      else stuck = 0;
      if (stuck > 10) {
        // Hop; every second time also side-step around whatever blocks us.
        unstick++;
        if (unstick % 2 === 0) {
          const k = unstick % 4 === 0 ? 'KeyA' : 'KeyD';
          await page.keyboard.down(k);
          await page.keyboard.press('Space');
          await sleep(700);
          await page.keyboard.up(k);
        } else await page.keyboard.press('Space');
        stuck = 0;
      }
      last = p;
      if (label && Date.now() - lastLog > 15000) {
        lastLog = Date.now();
        step(`  ${label}: ${d.toFixed(0)} m to go, at (${p.x.toFixed(0)}, ${p.y.toFixed(1)}, ${p.z.toFixed(0)})`);
      }
      await sleep(120);
    }
  } finally {
    await page.keyboard.up('KeyW');
    if (sprint) await page.keyboard.up('ShiftLeft');
  }
}

// ---------------------------------------------------------------- town streets
// Players walk the streets: a straight line across a town runs into
// buildings. The graph is the settlement's street polylines from the
// client's towns buffer (densified to ~3 m), joined where streets meet and
// at the square.
let TOWN_GRAPH = null;
async function buildTownGraph(page, town) {
  const streets = await page.evaluate((i) => window.__lodestoneTowns.streets(i), town.index);
  const nodes = [{ x: town.x, z: town.z, s: -1 }];
  const adj = [[]];
  const link = (a, b) => {
    if (a === b || adj[a].includes(b)) return;
    adj[a].push(b);
    adj[b].push(a);
  };
  for (const [si, st] of streets.entries()) {
    const p = st.points;
    let prev = -1;
    for (let i = 0; i + 5 < p.length; i += 3) {
      const ax = p[i], az = p[i + 2], bx = p[i + 3], bz = p[i + 5];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 3));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) {
        nodes.push({ x: ax + ((bx - ax) * k) / n, z: az + ((bz - az) * k) / n, s: si });
        adj.push([]);
        const id = nodes.length - 1;
        if (prev >= 0) link(prev, id);
        prev = id;
      }
    }
  }
  for (let a = 1; a < nodes.length; a++) {
    if (Math.hypot(nodes[a].x - town.x, nodes[a].z - town.z) < town.square + 4) link(0, a);
    for (let b = a + 1; b < nodes.length; b++) if (nodes[a].s !== nodes[b].s && Math.hypot(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z) < 3.5) link(a, b);
  }
  TOWN_GRAPH = { nodes, adj, town, streets: streets.length };
  return TOWN_GRAPH;
}
function routeOn(g, from, to) {
  const near = (p) => g.nodes.reduce((best, n, i) => (Math.hypot(n.x - p.x, n.z - p.z) < Math.hypot(g.nodes[best].x - p.x, g.nodes[best].z - p.z) ? i : best), 0);
  const s = near(from);
  const t = near(to);
  const dist = new Array(g.nodes.length).fill(Infinity);
  const prev = new Array(g.nodes.length).fill(-1);
  dist[s] = 0;
  const done = new Set();
  for (;;) {
    let u = -1;
    for (let i = 0; i < dist.length; i++) if (!done.has(i) && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === t) break;
    done.add(u);
    for (const v of g.adj[u]) {
      const d = dist[u] + Math.hypot(g.nodes[u].x - g.nodes[v].x, g.nodes[u].z - g.nodes[v].z);
      if (d < dist[v]) {
        dist[v] = d;
        prev[v] = u;
      }
    }
  }
  const path = [];
  for (let v = t; v >= 0; v = prev[v]) path.unshift(g.nodes[v]);
  return path;
}
/** Walk to (x, z) along the town's streets when either end is in the town, else straight. */
async function go(page, x, z, opts = {}) {
  const g = TOWN_GRAPH;
  const p = (await pl(page)).pos;
  const inTown = (q) => g && Math.hypot(q.x - g.town.x, q.z - g.town.z) < g.town.radius + 12;
  if (!inTown(p) && !inTown({ x, z })) return walkTo(page, x, z, opts);
  const t0 = Date.now();
  const path = routeOn(g, p, { x, z });
  // Skip leading nodes behind us and trailing nodes past the goal.
  while (path.length > 1 && Math.hypot(path[1].x - p.x, path[1].z - p.z) < Math.hypot(path[0].x - p.x, path[0].z - p.z) + 0.5 && Math.hypot(path[0].x - p.x, path[0].z - p.z) < 6) path.shift();
  while (path.length > 1 && Math.hypot(path.at(-2).x - x, path.at(-2).z - z) < Math.hypot(path.at(-1).x - x, path.at(-1).z - z)) path.pop();
  const budget = opts.timeoutMs ?? 300000;
  for (const n of path) {
    const left = budget - (Date.now() - t0);
    if (left <= 0) break;
    await walkTo(page, n.x, n.z, { stopAt: 1.8, sprint: opts.sprint, timeoutMs: Math.min(left, 40000), label: opts.label });
  }
  const r = await walkTo(page, x, z, { ...opts, timeoutMs: Math.max(5000, budget - (Date.now() - t0)) });
  return { ...r, ms: Date.now() - t0, via: path.length };
}

/** Drawn enemies (snapshot views), nearest first. */
async function enemies(page) {
  return page.evaluate(() => {
    const me = window.__lodestone.player().pos;
    const v = (window.__lodestoneDrawn?.() ?? []).filter((e) => e.kind === 2 && e.healthPct > 0);
    return v.map((e) => ({ id: e.id, x: e.x, y: e.y, z: e.z, healthPct: e.healthPct, typeId: e.typeId, d: Math.hypot(e.x - me.x, e.z - me.z) })).sort((a, b) => a.d - b.d);
  });
}
async function click(page, hold = 40) {
  await page.mouse.down();
  await sleep(hold);
  await page.mouse.up();
}

/**
 * Fight like a player: face the nearest enemy, close in, swing (left click).
 * Stops when no enemy is within `radius` for `idleMs`, when stop() is true,
 * or on timeout. Drinks (R) when health is low. keep: stay within `leash` m
 * of a point (defense: the ward garden).
 */
async function fight(page, { radius = 40, timeoutMs = 120000, idleMs = 4000, stop = null, filter = null, keep = null, leash = 30, onTick = null, seek = null, trackLow = false } = {}) {
  const t0 = Date.now();
  let lastTele = Date.now();
  let dodges = 0;
  let lastSeen = Date.now();
  let swings = 0;
  let drinks = 0;
  let lastDrink = 0;
  await page.mouse.move(640, 360);
  for (;;) {
    if (dead) throw new Error(dead);
    if (Date.now() - t0 > timeoutMs) break;
    if (stop && (await stop())) break;
    if (onTick) await onTick();
    const me = await pl(page);
    const h = await hud(page);
    if (h && trackLow) {
      lowHealth.night = Math.min(lowHealth.night, h.health);
      lowHealth.nightMax = h.healthMax;
    }
    if (h && h.health < h.healthMax * 0.5 && Date.now() - lastDrink > 2500) {
      await page.keyboard.press('KeyR');
      lastDrink = Date.now();
      drinks++;
    }
    let list = await enemies(page);
    if (filter) list = list.filter(filter);
    if (keep) list = list.filter((e) => Math.hypot(e.x - keep.x, e.z - keep.z) < leash + 8);
    const t = list.find((e) => e.d < radius);
    // A telegraphed strike (Event 204 wind-up) from an enemy next to us: dodge (F, i-frames), as a player would.
    const tele = (await tapped(page, [204], lastTele)).events;
    lastTele = Date.now();
    if (tele.some((e) => list.some((x) => x.id === e.entityId && x.d < 6))) {
      await page.keyboard.press('KeyF');
      dodges++;
      await sleep(150);
    }
    if (!t && seek) {
      const sp = await seek();
      if (sp) {
        const far = Math.hypot(sp.x - me.pos.x, sp.z - me.pos.z);
        if (far > radius - 5) {
          await go(page, sp.x, sp.z, { stopAt: radius - 10, timeoutMs: 60000, sprint: true });
          lastSeen = Date.now();
          continue;
        }
      }
    }
    if (!t) {
      if (keep && Math.hypot(me.pos.x - keep.x, me.pos.z - keep.z) > 6) await walkTo(page, keep.x, keep.z, { stopAt: 3, timeoutMs: 8000 });
      if (Date.now() - lastSeen > idleMs) break;
      await sleep(250);
      continue;
    }
    lastSeen = Date.now();
    const pitch = Math.max(-0.5, Math.min(0.3, Math.atan2(t.y + 0.6 - (me.pos.y + 1.6), Math.max(0.5, t.d))));
    await look(page, yawTo(me.pos, t.x, t.z), pitch);
    if (t.d > 2.3) {
      await page.keyboard.down('KeyW');
      await sleep(Math.min(400, (t.d - 2) * 160));
      await page.keyboard.up('KeyW');
      continue;
    }
    await click(page, 40);
    swings++;
    await sleep(230);
  }
  return { swings, drinks, dodges, ms: Date.now() - t0 };
}

/** Walk over pickups (personal loot is taken on touch). */
async function collectPickups(page, radius = 30, timeoutMs = 40000) {
  const t0 = Date.now();
  let walked = 0;
  while (Date.now() - t0 < timeoutMs) {
    const pk = await page.evaluate((r) => {
      const me = window.__lodestone.player().pos;
      return (window.__lodestoneDrawn?.() ?? []).filter((e) => e.kind === 4).map((e) => ({ id: e.id, x: e.x, z: e.z, d: Math.hypot(e.x - me.x, e.z - me.z) })).filter((e) => e.d < r).sort((a, b) => a.d - b.d);
    }, radius);
    if (!pk.length) break;
    await walkTo(page, pk[0].x, pk[0].z, { stopAt: 0.4, timeoutMs: 10000 });
    walked++;
    await sleep(400);
  }
  return walked;
}

/** Aim at a world point (pitch from the eye). */
async function aimAt(page, x, y, z) {
  const p = (await pl(page)).pos;
  await look(page, yawTo(p, x, z), Math.atan2(y - (p.y + 1.6), Math.max(0.3, Math.hypot(x - p.x, z - p.z))));
}

// ================================================================ main
let browser = null;
let page = null;
let botsProc = null;
const result = { run: RUN };
try {
  step(`G4 acceptance (spec 15): fight, loot, mine ore and a gem, forge a sunsteel blade, socket the gem, survive a night in a generated town. Run ${RUN}`);
  const taken = new Set();
  const PORT = { account: await freePort(taken), director: await freePort(taken), zone: await freePort(taken), social: await freePort(taken), vite: await freePort(taken) };
  step(`private ports ${JSON.stringify(PORT)}; logs in ${TMP}`);
  const pgUrl = goSync(['run', './server/account/cmd/devdb', 'create', DB]).trim().split('\n').pop();
  step(`scratch database ${DB} (all migrations)`);
  for (const [name, pkg] of [['account', './server/account'], ['director', './server/director'], ['zone', './server/zone'], ['social', './server/social']]) goSync(['build', '-o', bin(name), pkg]);
  goSync(['-C', 'server/zone', 'build', '-o', bin('nightbots'), './cmd/nightbots']);
  step('built account, director, zone, social and the WP15 night bots from this checkout');
  const svcEnv = {
    LODESTONE_PG_URL: pgUrl,
    LODESTONE_ACCOUNT_PORT: String(PORT.account),
    LODESTONE_DIRECTOR_PORT: String(PORT.director),
    LODESTONE_SOCIAL_PORT: String(PORT.social),
    LODESTONE_SOCIAL_URL: `ws://${H}:${PORT.social}/ws`,
    LODESTONE_DEV_AUTH: '1',
    LODESTONE_CORS_ORIGIN: '*',
  };
  start('account', bin('account'), [], svcEnv);
  check(await waitHttp(`http://${H}:${PORT.account}/healthz`, 90000), `account healthy on :${PORT.account} (mints the official world into the scratch DB)`);
  start('social', bin('social'), [], svcEnv);
  check(await waitHttp(`http://${H}:${PORT.social}/healthz`, 30000), `social healthy on :${PORT.social}`);
  start('director', bin('director'), [], svcEnv);
  check(await waitHttp(`http://${H}:${PORT.director}/healthz`, 30000), `director healthy on :${PORT.director}`);
  const startHour = 8;
  const zoneEnv = {
    ...svcEnv,
    LODESTONE_ZONE_PORT: String(PORT.zone),
    LODESTONE_ZONE_ID: ZONE_ID,
    LODESTONE_ZONE_WT_ADDR: 'off',
    LODESTONE_ZONE_PUBLIC_URL: `ws://${H}:${PORT.zone}/ws`,
    LODESTONE_ZONE_DEBUG_RAIN: '0',
    LODESTONE_ZONE_DEV_SPAWN: '1',
    LODESTONE_ZONE_DEV_COMBAT: '1',
    LODESTONE_ZONE_DEV_NIGHT: '1',
    LODESTONE_ZONE_DEBUG_CAMP: `${CAMP_HINT.x},${CAMP_HINT.z},1,boar boar`,
    LODESTONE_ZONE_TIME_OFFSET_S: String(offsetForHour(startHour)),
  };
  result.zoneEnv = Object.fromEntries(Object.entries(zoneEnv).filter(([k]) => k.startsWith('LODESTONE_ZONE_')));
  start('zone', bin('zone'), [], zoneEnv);
  check(await waitHttp(`http://${H}:${PORT.zone}/healthz`, 120000), `zone healthy on :${PORT.zone}`);
  ZONE = `http://${H}:${PORT.zone}`;
  const zoneInfo = await zget('/debug/zone');
  result.world = { worldId: zoneInfo.worldId, seed: zoneInfo.seed, genVersion: zoneInfo.genVersion };
  step(`zone serves world ${zoneInfo.worldId} (fresh for this run) seed ${zoneInfo.seed} genVersion ${zoneInfo.genVersion}; dev knobs ${JSON.stringify(result.zoneEnv)}`);
  start('vite', process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT.vite), '--strictPort', '--host', H], { VITE_ACCOUNT_URL: `http://${H}:${PORT.account}`, VITE_DIRECTOR_URL: `http://${H}:${PORT.director}`, VITE_SOLO: '0' }, path.join(root, 'client'));
  check(await waitHttp(`http://${H}:${PORT.vite}/`, 90000), `vite on :${PORT.vite}`);
  await sleep(6000); // the zone registry heartbeat reaches the director

  const consoleLog = [];
  browser = await chromium.launch({ args: GPU_ARGS });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  page = await ctx.newPage();
  page.on('console', (m) => consoleLog.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => consoleLog.push(`pageerror: ${e.message}`));
  await page.goto(`http://${H}:${PORT.vite}/?debug=1&autoplay=1&transport=ws&rain=0`);
  await signInAndPlay(page, USER, NAME);
  const me = await page.evaluate(() => window.__lodestone.session());
  const CHAR = me.characterId;
  result.character = me;
  const p0 = (await pl(page)).pos;
  check(true, `${NAME} playing (dev auth -> director ticket -> zone), character ${CHAR}, at (${p0.x.toFixed(1)}, ${p0.y.toFixed(1)}, ${p0.z.toFixed(1)})`);
  const fps = await page.evaluate(() => new Promise((res) => {
    let n = 0;
    const t0 = performance.now();
    const f = () => (++n < 40 ? window.requestAnimationFrame(f) : res((n * 1000) / (performance.now() - t0)));
    window.requestAnimationFrame(f);
  }));
  result.fpsAtStart = r1(fps);
  step(`render rate ${fps.toFixed(1)} fps (headless Chromium, ANGLE/D3D11; WP19 may be loading the machine)`);
  const inv0 = await inv(page);
  step(`starter inventory (Event 400): ${fmtUnits(units(inv0))}`);

  // The spawn town, its forge, smithy and blacksmith, from the client's own towns buffer.
  const town = await page.evaluate(([x, z]) => {
    const T = window.__lodestoneTowns;
    const ss = T.settlements().map((s) => ({ ...s, d: Math.hypot(s.x - x, s.z - z) })).sort((a, b) => a.d - b.d);
    const s = ss[0];
    const forge = T.props(s.index, 10)[0];
    const anvil = T.props(s.index, 11)[0];
    const bs = T.buildings(s.index);
    const smithy = bs.find((b) => b.index === forge.building);
    const smith = T.npcs(s.index).find((n) => n.role === 'blacksmith');
    return { index: s.index, name: s.name, size: s.size, x: s.x, y: s.y, z: s.z, radius: s.radius, square: s.square, buildings: s.buildings, forge, anvil, smithy, smith };
  }, [p0.x, p0.z]);
  const door = (b, out) => {
    const u = b.doorU;
    const v = -b.hz - out;
    return { x: b.x + u * b.c - v * b.s, z: b.z + u * b.s + v * b.c };
  };
  const tg = await buildTownGraph(page, town);
  step(`street graph of ${town.name}: ${tg.streets} streets, ${tg.nodes.length} nodes (players walk the streets; a straight line across a town meets walls)`);
  const nt = await zget('/debug/night?towns=1');
  const ward = nt.towns.map((t) => ({ ...t, d: Math.hypot(t.x - town.x, t.z - town.z) })).sort((a, b) => a.d - b.d)[0];
  result.town = { ...town, ward };
  step(`spawn town #${town.index} "${town.name}" (${town.size}, ${town.buildings} buildings) at (${town.x.toFixed(0)}, ${town.z.toFixed(0)}) r ${town.radius.toFixed(0)}; ward r ${ward.wardR?.toFixed?.(0)} garden (${ward.gardenX?.toFixed?.(0)}, ${ward.gardenZ?.toFixed?.(0)}); forge prop ${town.forge.id} at (${town.forge.x.toFixed(1)}, ${town.forge.y.toFixed(1)}, ${town.forge.z.toFixed(1)}); blacksmith "${town.smith?.name}"`);

  const W = { x: ward.gardenX ?? town.x, z: ward.gardenZ ?? town.z, r: ward.wardR ?? town.radius + 10 };
  if (DEF_ONLY) {
    step('--defense-only: skipping phases 1-6 (harness debugging); setting the clock to 21:00');
    await page.evaluate(() => window.__lodestoneNight.setTime(21));
    await sleep(2000);
  } else {
  // ======================================================== 1. fight a camp, loot
  item = '1 fight + loot';
  const cdbg = await combatDbg();
  const camp = cdbg.groups.find((g) => g.kind === 'test');
  check(!!camp, `dev camp placed outside the town: ${camp ? `${camp.members} x level ${camp.level} at (${camp.x.toFixed(1)}, ${camp.z.toFixed(1)}), ${Math.hypot(camp.x - town.x, camp.z - town.z).toFixed(0)} m from the town centre` : 'missing'}`);
  const toCamp = await go(page, camp.x + 12, camp.z, { stopAt: 2, sprint: true, label: `${NAME} to the camp`, timeoutMs: 240000 });
  step(`  walked from the town to the camp: ${toCamp.ok ? 'arrived' : 'timed out'} in ${(toCamp.ms / 1000).toFixed(0)} s`);
  await shot(page, 'camp-approach');
  const fightT0 = Date.now();
  let midShot = false;
  const f1 = await fight(page, {
    radius: 45,
    timeoutMs: 180000,
    idleMs: 6000,
    onTick: async () => {
      if (!midShot && Date.now() - fightT0 > 3000) {
        const e = await enemies(page);
        if (e.length && e[0].d < 6) {
          midShot = true;
          await shot(page, 'camp-fight');
        }
      }
    },
  });
  const t1 = await tapped(page, [201, 202, 203, 211, 221, 401], fightT0);
  const hits1 = t1.hits.filter((h) => h.accepted);
  const kills1 = t1.events.filter((e) => e.kind === 201);
  const cleared = t1.events.some((e) => e.kind === 211);
  result.fight1 = { swings: f1.swings, drinks: f1.drinks, ms: f1.ms, accepted: hits1.length, refused: t1.hits.length - hits1.length, damage: hits1.map((h) => h.damage), kills: kills1.length, xp: kills1.map((e) => e.value), cleared, hurt: t1.events.filter((e) => e.kind === 202).map((e) => e.value), downs: t1.events.filter((e) => e.kind === 221).length };
  step(`fight: ${JSON.stringify(result.fight1)}`);
  check(kills1.length >= 2 && cleared, `the camp died to the starting sword (left click, client-predicted hits): ${kills1.length} kills, ${hits1.length} accepted hits (damage ${hits1.map((h) => h.damage).join(' ')}), camp cleared Event 211, ${f1.swings} swings in ${(f1.ms / 1000).toFixed(0)} s, ${result.fight1.downs} downs`);
  await sleep(800);
  const walkedPk = await collectPickups(page, 30, 40000);
  await sleep(1000);
  const t1b = await tapped(page, [401], fightT0);
  const killLoot = t1b.events.filter((e) => e.kind === 401 && e.targetId === 1);
  const invA = await inv(page);
  step(`  walked over ${walkedPk} pickups; inventory now ${fmtUnits(units(invA))}`);
  check(killLoot.length > 0, `personal kill loot picked up by walking over it: ${killLoot.length} grant Events (401, source kill); gold ${invA.inv.gold}`, { toasts: invA.toasts.slice(-6) });
  await shot(page, 'camp-loot');
  // A chest: the nearest unopened container the zone lists (Event 406), E to open.
  let gold = invA.inv.gold;
  const chestsTried = [];
  for (let k = 0; k < 4 && gold < 45; k++) {
    const st = await inv(page);
    const me2 = (await pl(page)).pos;
    const cs = st.containers.filter((c) => !c.opened && !chestsTried.includes(c.id)).map((c) => ({ ...c, d: Math.hypot(c.x - me2.x, c.z - me2.z) })).sort((a, b) => a.d - b.d);
    let c = cs[0];
    if (!c) {
      // None within 96 m: ask the zone for the nearest anchors and walk toward one.
      const near = (await zget(`/debug/containers?x=${me2.x.toFixed(0)}&z=${me2.z.toFixed(0)}&r=400`)).map((x) => ({ ...x, d: Math.hypot(x.x - me2.x, x.z - me2.z) })).filter((x) => !chestsTried.includes(x.id)).sort((a, b) => a.d - b.d);
      if (!near.length) break;
      c = near[0];
      step(`  no container in view; walking ${c.d.toFixed(0)} m to the ${c.kind} at (${c.x.toFixed(0)}, ${c.z.toFixed(0)})`);
    }
    chestsTried.push(c.id);
    const w = await go(page, c.x, c.z, { stopAt: 1.2, timeoutMs: 150000, sprint: true, label: `to the ${c.kind ?? 'container'}` });
    await aimAt(page, c.x, c.y + 0.3, c.z);
    await sleep(600);
    const tE = Date.now();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('KeyE');
      await sleep(700);
      if ((await tapped(page, [407], tE)).events.length) break;
    }
    const opened = (await tapped(page, [407, 401, 403], tE)).events;
    if (!opened.some((e) => e.kind === 407)) {
      const diag = await page.evaluate((id) => {
        const t = (sel) => document.querySelector(sel)?.textContent ?? null;
        const st = window.__lodestoneInventory.state();
        return { me: window.__lodestone.player().pos, container: st.containers.find((x) => x.id === id) ?? null, containers: st.containers.length, lootPrompt: t('[data-testid="loot-prompt"]'), townPrompt: t('[data-testid="town-prompt"]'), caveHud: t('[data-testid="cave-hud"]'), caveHuds: document.querySelectorAll('[data-testid="cave-hud"]').length, invOpen: st.invOpen, station: st.station };
      }, String(c.id));
      step(`  E did not open it: ${JSON.stringify(diag)}`);
    }
    const st2 = await inv(page);
    step(`  container ${c.id} (${c.kind ?? ''}) ${w.ok ? 'reached' : 'not reached'}: ${opened.filter((e) => e.kind === 407).length ? 'opened' : 'NOT opened'} (${opened.map((e) => `${e.kind}/${e.value}`).join(' ')}); gold ${st2.inv.gold}`);
    if (opened.some((e) => e.kind === 407)) {
      await shot(page, 'chest-opened');
      gold = st2.inv.gold;
    }
  }
  const invB = await inv(page);
  result.loot = { units: units(invB), gold: invB.inv.gold, chestsTried: chestsTried.length };
  check(invB.inv.gold >= 40, `loot: enough gold for the blueprint (40): ${invB.inv.gold} gold; bag ${fmtUnits(units(invB))}`);
  if (STOP_AFTER <= 1) throw new Error('stop-after 1');

  // ======================================================== 2. mine sunsteel ore and a gem
  item = '2 mine ore + gem';
  const allVeins = await page.evaluate(() => {
    const C = window.__lodestoneCaves;
    const out = [];
    // material is the ore id (ORE_NAMES) or gem id (GEM_NAMES) of worldgen/js/src/cave.ts.
    const ORE = ['copper', 'iron', 'silver', 'sunsteel', 'starmetal', 'voidglass'];
    const GEM = ['ruby', 'sapphire', 'topaz', 'emerald', 'aquamarine', 'sunstone', 'onyx', 'amethyst', 'opal', 'moonstone'];
    for (const s of C.systems()) for (const v of C.veins(s.index)) out.push({ ...v, material: typeof v.material === 'number' ? (v.kind === 'gem' ? GEM : ORE)[v.material] : v.material, system: s.index });
    return out;
  });
  const reachable = (v) => {
    const nl = Math.hypot(v.nx, v.nz);
    return nl >= 0.3 && v.ny <= 0.5;
  };
  const order = (list) => [...list.filter((v) => KNOWN_VEINS.includes(v.id)), ...list.filter((v) => !KNOWN_VEINS.includes(v.id))];
  const sunVeins = order(allVeins.filter((v) => v.kind !== 'gem' && v.material === 'sunsteel' && reachable(v)));
  const gemVeins = order(allVeins.filter((v) => v.kind === 'gem' && v.material !== 'opal' && v.material !== 'moonstone' && reachable(v)));
  step(`caves: ${allVeins.length} veins in ${new Set(allVeins.map((v) => v.system)).size} systems; ${sunVeins.length} sunsteel and ${gemVeins.length} gem veins facing sideways`);
  const mineLog = [];
  async function mineVein(v) {
    const nl = Math.hypot(v.nx, v.nz);
    const stand = { x: v.x + (v.nx / nl) * 1.6, y: v.y + 0.3, z: v.z + (v.nz / nl) * 1.6 };
    const p = await rejoinAt(page, CHAR, stand, `${v.material} vein ${v.id} (system ${v.system})`);
    if (Math.abs(p.y - v.y) > 3 || Math.hypot(p.x - v.x, p.z - v.z) > 4) {
      mineLog.push({ id: v.id, material: v.material, ok: false, why: 'spawned away from the vein', at: p });
      return null;
    }
    await sleep(2500); // cave cells and vein meshes build around us
    const hex = BigInt(v.id).toString(16);
    let target = null;
    for (let i = 0; i < 20 && !target?.endsWith(hex); i++) {
      await aimAt(page, v.x, v.y, v.z);
      await sleep(300);
      target = await page.evaluate(() => window.__lodestoneCaves.info().target);
    }
    if (!target?.endsWith(hex)) {
      mineLog.push({ id: v.id, material: v.material, ok: false, why: `not targeted (${target})`, at: p });
      return null;
    }
    await shot(page, `vein-${v.material}-before`);
    const tE = Date.now();
    let swings = 0;
    for (; swings < 40; swings++) {
      await page.keyboard.press('KeyE');
      await sleep(330);
      const ev = (await tapped(page, [401, 430, 431], tE)).events;
      if (ev.some((e) => e.kind === 401 && e.targetId === 3)) break;
      const t = await page.evaluate(() => window.__lodestoneCaves.info().target);
      if (!t?.endsWith(hex)) {
        // Broken: wait for the pickups to fly to us.
        for (let k = 0; k < 25; k++) {
          await sleep(200);
          if ((await tapped(page, [401], tE)).events.some((e) => e.targetId === 3)) break;
        }
        break;
      }
    }
    await sleep(600);
    const grants = (await tapped(page, [401], tE)).events.filter((e) => e.targetId === 3);
    const st = await inv(page);
    const toasts = st.toasts.slice(-4);
    await shot(page, `vein-${v.material}-mined`);
    mineLog.push({ id: v.id, material: v.material, ok: grants.length > 0, swings: swings + 1, grants: grants.length, toasts, at: { x: r1(p.x), y: r1(p.y), z: r1(p.z) } });
    step(`  mined ${v.material} vein ${v.id}: ${swings + 1} swings (E), ${grants.length} vein grants; toasts ${JSON.stringify(toasts)}`);
    return grants.length > 0;
  }
  for (const v of sunVeins.slice(0, 8)) {
    if ((units(await inv(page))['ore:sunsteel'] ?? 0) >= 4) break;
    await mineVein(v);
  }
  let gemKey = null;
  for (const v of gemVeins.slice(0, 6)) {
    const before = units(await inv(page));
    if (await mineVein(v)) {
      const after = units(await inv(page));
      gemKey = Object.keys(after).find((k) => k.startsWith(`gem:${v.material}:`) && (after[k] ?? 0) > (before[k] ?? 0)) ?? null;
      if (gemKey) break;
    }
  }
  const invM = await inv(page);
  result.mining = { log: mineLog, units: units(invM), gemKey };
  for (const l of mineLog.filter((x) => !x.ok)) step(`  skipped vein ${l.id} (${l.material}): ${l.why}`);
  check((units(invM)['ore:sunsteel'] ?? 0) >= 4, `sunsteel ore for two ingots (smelt_sunsteel = 2 ore): ${units(invM)['ore:sunsteel'] ?? 0} ore:sunsteel from ${mineLog.filter((x) => x.ok && x.material === 'sunsteel').length} veins`);
  check(!!gemKey, `a gem mined: ${gemKey}`, { zone: zoneLogLines(/vein|grant/i, 6).map((l) => l.slice(0, 200)) });
  if (STOP_AFTER <= 2) throw new Error('stop-after 2');

  // ======================================================== 3. travel to the town
  item = '3 travel to town';
  {
    // Start where the camp was (outside the ward) and walk into the town to the smithy door.
    const startAt = { x: camp.x + 6, z: camp.z };
    await rejoinAt(page, CHAR, startAt, 'the camp outside the town (back from the caves)');
    await sleep(1500);
    const caveHuds = await page.evaluate(() => document.querySelectorAll('[data-testid="cave-hud"]').length);
    check(caveHuds <= 1, `after ${mineLog.length + 1} rejoins one cave HUD is on the page (${caveHuds}): the previous worlds' cave managers were disposed (their E/mouse listeners too)`);
    const t0 = Date.now();
    const sqx = town.x;
    const sqz = town.z;
    const toSquare = await go(page, sqx, sqz, { stopAt: 4, sprint: true, timeoutMs: 240000, label: `${NAME} into the town` });
    await shot(page, 'town-square');
    const outside = door(town.smithy, 1.6);
    const toDoor = await go(page, outside.x, outside.z, { stopAt: 0.6, timeoutMs: 120000, label: 'to the smithy door' });
    const inside = door(town.smithy, -1.6);
    const inS = await walkTo(page, inside.x, inside.z, { stopAt: 0.6, timeoutMs: 30000 });
    const p = (await pl(page)).pos;
    const walked = { toSquare: toSquare.ok, toDoor: toDoor.ok, inside: inS.ok, s: Math.round((Date.now() - t0) / 1000), from: startAt, at: { x: r1(p.x), y: r1(p.y), z: r1(p.z) } };
    result.travel = walked;
    check(toSquare.ok && toDoor.ok && inS.ok, `walked from the camp (${Math.hypot(startAt.x - town.x, startAt.z - town.z).toFixed(0)} m from the centre) through the town square into the smithy in ${walked.s} s`, walked);
    if (!inS.ok) {
      step('  walk failed; rejoining at the smithy door to continue the loop');
      await rejoinAt(page, CHAR, outside, 'the smithy door (fallback)');
      await walkTo(page, inside.x, inside.z, { stopAt: 0.6, timeoutMs: 30000 });
    }
    await shot(page, 'smithy-inside');
  }
  if (STOP_AFTER <= 3) throw new Error('stop-after 3');

  // ======================================================== 4. blueprint, smelt, forge
  item = '4 blueprint + smelt + forge';
  {
    const n0 = await night();
    if (n0.hour > 17 || n0.hour < 7.5) {
      step(`  world time ${n0.hour.toFixed(2)} h: the smith works 07-19, setting the clock to 09:00 (dev Interact 52/2)`);
      await page.evaluate(() => window.__lodestoneNight.setTime(9));
      await sleep(1500);
    }
    // Find the smith's live entity and talk (E) to it.
    let talked = false;
    for (let attempt = 0; attempt < 12 && !talked; attempt++) {
      const npc = await page.evaluate((nm) => window.__lodestoneTowns.visibleNpcs().find((v) => v.name === nm && v.entityId !== null) ?? null, town.smith.name);
      if (!npc) {
        await sleep(1000);
        continue;
      }
      const p = (await pl(page)).pos;
      if (Math.hypot(npc.x - p.x, npc.z - p.z) > 1.8) await walkTo(page, npc.x, npc.z, { stopAt: 1.4, timeoutMs: 8000 });
      const n2 = await page.evaluate((nm) => window.__lodestoneTowns.visibleNpcs().find((v) => v.name === nm) ?? null, town.smith.name);
      await aimAt(page, n2.x, n2.y + 1.3, n2.z);
      await sleep(400);
      const tg = await page.evaluate(() => window.__lodestoneTowns.target());
      if (tg?.kind !== 'npc' || tg.name !== town.smith.name) continue;
      await page.keyboard.press('KeyE');
      await page.waitForFunction(() => (window.__lodestoneTowns.panel()?.shop ?? 0) > 0, null, { timeout: 6000 }).then(() => (talked = true), () => {});
    }
    const panel = await page.evaluate(() => window.__lodestoneTowns.panel());
    check(talked, `talked to the blacksmith "${town.smith.name}" (E on the "[E] Talk to" prompt): the shop panel lists ${panel?.shop ?? 0} wares`, panel);
    await shot(page, 'blacksmith-shop');
    const gold0 = (await inv(page)).inv.gold;
    const row = page.getByTestId('town-panel').locator('div', { hasText: /Sunsteel Blade/i }).filter({ has: page.locator('button[data-act="buy"]') }).last();
    const tBuy = Date.now();
    await row.locator('button[data-act="buy"]').click({ timeout: 10000 });
    await page.waitForFunction(() => window.__lodestoneInventory.state().inv.items.some((i) => i.b === 'blueprint:sunsteel_blade'), null, { timeout: 10000 }).catch(() => {});
    const invP = await inv(page);
    const bought = (await tapped(page, [807, 403, 806], tBuy)).events;
    result.purchase = { gold0, gold1: invP.inv.gold, events: bought };
    check(units(invP)['blueprint:sunsteel_blade'] === 1, `bought the Sunsteel Blade blueprint with the Buy button: gold ${gold0} -> ${invP.inv.gold} (Event 807 price ${bought.find((e) => e.kind === 807)?.value ?? '?'})`);
    await shot(page, 'blueprint-bought');
    await page.keyboard.press('Escape');
    await sleep(300);

    // The forge: stand inside the smithy facing it, E opens the smithing panel (805).
    const f = town.forge;
    const b = town.smithy;
    const dx = b.x - f.x;
    const dz = b.z - f.z;
    const dl = Math.hypot(dx, dz) || 1;
    const stand = { x: f.x + (dx / dl) * 1.3, z: f.z + (dz / dl) * 1.3 };
    await walkTo(page, stand.x, stand.z, { stopAt: 0.35, timeoutMs: 15000 });
    let opened = false;
    for (let k = 0; k < 6 && !opened; k++) {
      await aimAt(page, f.x, f.y + 0.6, f.z);
      await sleep(400);
      const tg = await page.evaluate(() => window.__lodestoneTowns.target());
      if (tg?.kind === 'forge') {
        await page.keyboard.press('KeyE');
        opened = await page.getByTestId('craft-panel').waitFor({ timeout: 6000 }).then(() => true, () => false);
      } else {
        const p = (await pl(page)).pos;
        step(`  forge not targeted (target ${JSON.stringify(tg)}), at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}); stepping closer`);
        await walkTo(page, f.x + (dx / dl) * 1.0, f.z + (dz / dl) * 1.0, { stopAt: 0.3, timeoutMs: 5000 });
      }
    }
    const station = (await inv(page)).station;
    check(opened && station?.kind === 'forge', `E at the town forge: the zone opened it (Event 805) and the crafting panel shows the smithing recipes`, station);
    await shot(page, 'forge-panel');
    const craft = async (key) => {
      const t0 = Date.now();
      const btn = page.getByTestId(`recipe-${key}`).locator('button');
      const enabled = await btn.isEnabled();
      if (enabled) await btn.click({ timeout: 5000 });
      await page.waitForFunction((t) => window.__lodestone.tapped([405, 403], t).events.length > 0, t0, { timeout: 8000 }).catch(() => {});
      return { enabled, events: (await tapped(page, [405, 403], t0)).events };
    };
    const s1 = await craft('smelt_sunsteel');
    await sleep(500);
    const s2 = await craft('smelt_sunsteel');
    await sleep(500);
    const invS = await inv(page);
    check(s1.events.some((e) => e.kind === 405) && s2.events.some((e) => e.kind === 405) && (units(invS)['ingot:sunsteel'] ?? 0) >= 2, `smelted twice with the Craft button: ${units(invS)['ingot:sunsteel'] ?? 0} ingot:sunsteel, ${units(invS)['ore:sunsteel'] ?? 0} ore left`, { s1: s1.events, s2: s2.events });
    const fb = await craft('forge_sunsteel_blade');
    await sleep(800);
    const invF = await inv(page);
    const blade = invF.inv.items.find((i) => i.b === 'weapon:sunsteel_blade');
    result.forge = { smelt: [s1, s2], forge: fb, blade };
    check(!!blade && (blade.k?.length ?? 0) >= 1, `forged the Sunsteel Blade at the town forge: rarity ${blade?.r}, item level ${blade?.l}, ${blade?.k?.length ?? 0} socket(s)`, blade);
    await shot(page, 'blade-forged');
    await page.keyboard.press('Escape');
    await sleep(300);
  }
  if (STOP_AFTER <= 4) throw new Error('stop-after 4');

  // ======================================================== 5. socket the gem, equip
  item = '5 socket + equip';
  {
    await page.keyboard.press('KeyI');
    await page.getByTestId('inventory-panel').waitFor({ timeout: 5000 });
    let st = await inv(page);
    const blade = st.inv.items.find((i) => i.b === 'weapon:sunsteel_blade');
    const gem = st.inv.items.find((i) => i.b === gemKey) ?? st.inv.items.find((i) => i.b.startsWith('gem:') && !/opal|moonstone/.test(i.b));
    await page.getByTestId(`inv-item-${blade.h}`).click();
    await shot(page, 'inventory-blade');
    await page.getByTestId('inv-actions').locator('button[data-act="socket"]').click();
    await page.getByTestId(`inv-item-${gem.h}`).click();
    await page.waitForFunction((h) => (window.__lodestoneInventory.state().inv.items.find((i) => i.h === h)?.k ?? []).some((g) => g), blade.h, { timeout: 8000 }).catch(() => {});
    st = await inv(page);
    const sock = st.inv.items.find((i) => i.h === blade.h);
    check((sock?.k ?? []).includes(gem.b), `socketed ${gem.b} into the blade in the inventory ("Socket a gem", click the gem)`, { sockets: sock?.k });
    await page.getByTestId(`inv-item-${blade.h}`).click().catch(() => {});
    if ((await page.getByTestId('inv-actions').locator('button[data-act="equip2"]').count()) === 0) await page.getByTestId(`inv-item-${blade.h}`).click();
    const tEq = Date.now();
    await page.getByTestId('inv-actions').locator('button[data-act="equip2"]').click();
    await page.waitForFunction((h) => window.__lodestoneInventory.state().inv.items.find((i) => i.h === h)?.s === 'eq:main1', blade.h, { timeout: 8000 }).catch(() => {});
    await sleep(800);
    st = await inv(page);
    const eq = st.inv.items.find((i) => i.h === blade.h);
    await page.getByTestId(`inv-item-${blade.h}`).hover().catch(() => {});
    await sleep(300);
    await shot(page, 'inventory-equipped');
    const h = await hud(page);
    const sync = (await tapped(page, [212], tEq)).events;
    result.equip = { slot: eq?.s, sockets: eq?.k, loadouts: h?.loadouts, activeLoadout: h?.activeLoadout };
    check(eq?.s === 'eq:main1' && h?.loadouts?.[1]?.weapon === 'sword' && h.loadouts[1].gem >= 0, `equipped in loadout 2 with "Equip · Loadout 2": slot ${eq?.s}; combat_sync (Event 212 x${sync.length}) loadout 2 = ${h?.loadouts?.[1]?.weapon} with gem element ${h?.loadouts?.[1]?.gem}; loadout 1 keeps the ordinary ${h?.loadouts?.[0]?.weapon}`, result.equip);
    // Before the night: put on whatever armor the loot brought (one per slot), as a player would.
    const worn = [];
    for (const a of st.inv.items.filter((i) => i.b.startsWith('armor:') && i.s.startsWith('inv:'))) {
      const cur = (await inv(page)).inv.items;
      const slot = a.b.includes('helm') || a.b.includes('cap') || a.b.includes('hood') ? 'head' : a.b.includes('greaves') || a.b.includes('leggings') ? 'legs' : 'body';
      if (cur.some((i) => i.s === `eq:${slot}`)) continue;
      await page.getByTestId(`inv-item-${a.h}`).click();
      const btn = page.getByTestId('inv-actions').locator('button[data-act="equip"]');
      if (!(await btn.count())) continue;
      await btn.click();
      await page.waitForFunction((hh) => window.__lodestoneInventory.state().inv.items.find((i) => i.h === hh)?.s.startsWith('eq:'), a.h, { timeout: 5000 }).catch(() => {});
      const now = (await inv(page)).inv.items.find((i) => i.h === a.h);
      if (now?.s.startsWith('eq:')) worn.push(`${a.b} -> ${now.s}`);
    }
    result.armor = worn;
    const h2 = await hud(page);
    step(`  armor from the loot put on with "Equip": ${worn.length ? worn.join(', ') : 'none dropped'}; health max ${h2?.healthMax}`);
    if (worn.length) await shot(page, 'inventory-armor');
    await page.keyboard.press('Escape');
    await sleep(300);
    const db = await itemsDbg(CHAR).catch((e) => ({ error: String(e) }));
    result.zoneInventoryAfterForge = db;
  }
  if (STOP_AFTER <= 5) throw new Error('stop-after 5');

  // ======================================================== 6. night: demons
  item = '6 night: demons';
  {
    // Out of the smithy to the garden first (the town at dusk).
    const sm = town.smithy;
    const out = door(sm, 1.8);
    await walkTo(page, door(sm, -1.0).x, door(sm, -1.0).z, { stopAt: 0.6, timeoutMs: 15000 });
    await walkTo(page, out.x, out.z, { stopAt: 0.8, timeoutMs: 20000 });
    const nb = await night();
    step(`  world time ${nb.hour.toFixed(2)} h; fast-forwarding to 18:15 (dev Interact 52/2) so dusk (18:30) comes in ~40 s`);
    const tDusk0 = Date.now();
    await page.evaluate(() => window.__lodestoneNight.setTime(18.25));
    await go(page, W.x, W.z, { stopAt: 4, timeoutMs: 120000, label: 'to the ward garden' });
    await page.waitForFunction((t) => window.__lodestone.tapped([501], t).events.length > 0, tDusk0, { timeout: 150000 }).catch(() => {});
    const dusk = (await tapped(page, [501], tDusk0)).events[0];
    const nd = await night();
    result.dusk = { event: dusk, hour: nd.hour, moon: nd.moon, nightIndex: nd.nightIndex, planned: nd.planned };
    check(!!dusk && nd.night, `dusk fell (Event 501) at ${nd.hour.toFixed(2)} h, moon ${nd.moon}, night ${nd.nightIndex}; defense planned tonight: ${JSON.stringify(nd.planned)}`);
    await shot(page, 'town-dusk');
    // Step out of the ward on the open side (toward the camp) and wait for demons.
    const ang = Math.atan2(camp.z - W.z, camp.x - W.x);
    const edge = { x: W.x + Math.cos(ang) * (W.r + 14), z: W.z + Math.sin(ang) * (W.r + 14) };
    const toEdge = await go(page, edge.x, edge.z, { stopAt: 2, sprint: true, timeoutMs: 180000, label: 'out past the ward' });
    step(`  outside the ward (${(W.r + 14).toFixed(0)} m from the garden, ward r ${W.r.toFixed(0)}): ${toEdge.ok ? 'arrived' : 'timed out'}`);
    // CR 048 (playtest 3): only high-level demons shrug off ordinary weapons. Both packs are raised
    // with the dev Interact 52/3 at a forced level (arg = rank | level << 8): level 1 must die to
    // the starting sword, level 20 must not.
    const knownBefore = new Set((await night()).demonList.map((d) => d.id));
    const tLow = Date.now();
    await page.evaluate(() => window.__lodestoneNight.raiseDemons(0, 1));
    await sleep(2000);
    const nLow = await night();
    const lowIds = new Set(nLow.demonList.filter((d) => !knownBefore.has(d.id) && Math.hypot(d.x - edge.x, d.z - edge.z) < 60 && d.hp > 0).map((d) => d.id));
    check(lowIds.size > 0, `a pack of level 1 demons raised near ${NAME}: ${lowIds.size} demons`);
    {
      let h = await hud(page);
      if (h.activeLoadout !== 0) {
        await page.keyboard.press('KeyX');
        await sleep(500);
      }
      const e0 = (await enemies(page))[0];
      if (e0) await aimAt(page, e0.x, e0.y + 0.8, e0.z);
    }
    const fLow = await fight(page, {
      radius: 45,
      timeoutMs: 60000,
      idleMs: 8000,
      filter: (e) => lowIds.has(e.id),
      stop: async () => (await night()).demonList.filter((d) => lowIds.has(d.id) && d.hp > 0).length === 0,
      seek: async () => {
        const me = (await pl(page)).pos;
        return (await night()).demonList.filter((d) => lowIds.has(d.id) && d.hp > 0).sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0] ?? null;
      },
    });
    const lowEv = await tapped(page, [201], tLow);
    const lowKills = lowEv.events.filter((e) => e.kind === 201 && lowIds.has(e.entityId)).length;
    result.lowLevel = { demons: lowIds.size, kills: lowKills, s: Math.round(fLow.ms / 1000) };
    check(lowKills >= 1, `a low-level demon dies to the starting sword (CR 048): ${lowKills}/${lowIds.size} level 1 demons killed in ${result.lowLevel.s} s`);
    const tRise = Date.now();
    let risen = null;
    const raised = true;
    const knownBeforeHigh = new Set((await night()).demonList.map((d) => d.id));
    step('  raising a pack of level 20 demons with the dev Interact 52/3 (WP15 harness shortcut, forced level)');
    await page.evaluate(() => window.__lodestoneNight.raiseDemons(0, 20));
    await page.waitForFunction((t) => window.__lodestone.tapped([505], t).events.length > 0, tRise, { timeout: 15000 }).catch(() => {});
    risen = (await tapped(page, [505], tRise)).events[0] ?? null;
    await sleep(1500);
    const nd1 = await night();
    const demonIds = new Set(nd1.demonList.filter((d) => !knownBeforeHigh.has(d.id) && Math.hypot(d.x - edge.x, d.z - edge.z) < 60 && d.hp > 0).map((d) => d.id));
    result.demonsRose = { natural: !raised, event: risen, waitS: Math.round((Date.now() - tRise) / 1000), demons: nd1.demonList.filter((d) => demonIds.has(d.id)) };
    check(demonIds.size > 0, `demons rose near ${NAME} ${raised ? '(raised at level 20 by the dev Interact)' : `naturally after ${result.demonsRose.waitS} s`}: ${demonIds.size} demons (${[...new Set(nd1.demonList.filter((d) => demonIds.has(d.id)).map((d) => `${d.rank} ${d.key}`))].join(', ')})`);
    {
      const e = (await enemies(page))[0];
      if (e) await aimAt(page, e.x, e.y + 0.8, e.z);
      await sleep(500);
      await shot(page, 'demons-rise');
    }
    // Ordinary steel: loadout 1, the starting sword.
    let h0 = await hud(page);
    if (h0.activeLoadout !== 0) {
      await page.keyboard.press('KeyX');
      await sleep(500);
      h0 = await hud(page);
    }
    const tOrd = Date.now();
    const minPct = {};
    const sampleDemons = async () => {
      const n = await night();
      for (const d of n.demonList) if (demonIds.has(d.id) && d.hp > 0) minPct[d.id] = Math.min(minPct[d.id] ?? 1, d.hp / d.hpMax);
      return n;
    };
    let ordShot = false;
    const fOrd = await fight(page, {
      radius: 40,
      timeoutMs: 25000,
      idleMs: 15000,
      filter: (e) => demonIds.has(e.id),
      trackLow: true,
      onTick: async () => {
        await sampleDemons();
        if (!ordShot && Date.now() - tOrd > 8000) {
          ordShot = true;
          await shot(page, 'demon-shrugs-steel');
        }
      },
    });
    const ordEv = await tapped(page, [504, 201, 202, 203, 221], tOrd);
    const ordHits = ordEv.hits.filter((h) => h.accepted && demonIds.has(h.targetId));
    const nAfterOrd = await sampleDemons();
    const aliveAfterOrd = nAfterOrd.demonList.filter((d) => demonIds.has(d.id) && d.hp > 0);
    result.ordinary = { loadout: h0.loadouts[0], swings: fOrd.swings, accepted: ordHits.length, damage: ordHits.reduce((a, h) => a + h.damage, 0), shrugged: ordEv.events.filter((e) => e.kind === 504).length, kills: ordEv.events.filter((e) => e.kind === 201 && demonIds.has(e.entityId)).length, minHealthPct: Object.fromEntries(Object.entries(minPct).map(([k, v]) => [k, r2(v)])), alive: aliveAfterOrd.length, of: demonIds.size, seared: aliveAfterOrd.map((d) => d.seared), downs: ordEv.events.filter((e) => e.kind === 221).length, hurt: ordEv.events.filter((e) => e.kind === 202).reduce((a, e) => a + e.value, 0) };
    step(`ordinary sword vs demons: ${JSON.stringify(result.ordinary)}`);
    check(ordHits.length >= 3 && result.ordinary.kills === 0 && aliveAfterOrd.length === demonIds.size && result.ordinary.shrugged > 0, `a demon survives ordinary damage: ${(fOrd.ms / 1000).toFixed(0)} s of the starting sword, ${ordHits.length} accepted hits, ${result.ordinary.damage} damage, ${result.ordinary.shrugged} "shrugged" Events (504), 0 deaths, ${aliveAfterOrd.length}/${demonIds.size} alive, lowest health ${Math.round(Math.min(...Object.values(minPct), 1) * 100)} %`);
    // The sunsteel blade: loadout 2.
    await page.keyboard.press('KeyX');
    await page.waitForFunction(() => window.__lodestoneCombat.hud().activeLoadout === 1, null, { timeout: 5000 }).catch(() => {});
    const h1 = await hud(page);
    const tSun = Date.now();
    let sunShot = false;
    const fSun = await fight(page, {
      radius: 45,
      timeoutMs: 90000,
      idleMs: 6000,
      filter: (e) => demonIds.has(e.id),
      trackLow: true,
      stop: async () => (await night()).demonList.filter((d) => demonIds.has(d.id) && d.hp > 0).length === 0,
      seek: async () => {
        const me = (await pl(page)).pos;
        return (await night()).demonList.filter((d) => demonIds.has(d.id) && d.hp > 0).sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0] ?? null;
      },
      onTick: async () => {
        if (!sunShot && Date.now() - tSun > 2500) {
          const e = await enemies(page);
          if (e.length && e[0].d < 4) {
            sunShot = true;
            await shot(page, 'demon-sunsteel');
          }
        }
      },
    });
    await sleep(800);
    const sunEv = await tapped(page, [504, 201, 203, 221], tSun);
    const sunHits = sunEv.hits.filter((h) => h.accepted && demonIds.has(h.targetId));
    const nAfterSun = await night();
    const aliveSun = nAfterSun.demonList.filter((d) => demonIds.has(d.id) && d.hp > 0);
    const demonKills = sunEv.events.filter((e) => e.kind === 201 && demonIds.has(e.entityId));
    result.sunsteel = { loadout: h1.loadouts[1], activeLoadout: h1.activeLoadout, swings: fSun.swings, accepted: sunHits.length, damage: sunHits.map((h) => h.damage), kills: demonKills.length, xp: demonKills.map((e) => e.value), alive: aliveSun.length, shruggedWithBlade: sunEv.events.filter((e) => e.kind === 504).length, s: Math.round(fSun.ms / 1000), downs: sunEv.events.filter((e) => e.kind === 221).length };
    step(`sunsteel blade vs demons: ${JSON.stringify(result.sunsteel)}`);
    check(h1.activeLoadout === 1 && demonKills.length >= 1, `the forged Sunsteel Blade (X -> loadout 2) kills them: ${demonKills.length}/${demonIds.size} demons dead in ${result.sunsteel.s} s, ${sunHits.length} accepted hits (damage ${sunHits.map((h) => h.damage).join(' ')}), ${result.sunsteel.shruggedWithBlade} shrugs, ${aliveSun.length} left`);
    await shot(page, 'demons-slain');
  }
  if (STOP_AFTER <= 6) throw new Error('stop-after 6');
  } // phases 1-6

  // ======================================================== 7. town defense
  item = '7 night: town defense';
  {
    await go(page, W.x, W.z, { stopAt: 3, sprint: true, timeoutMs: 180000, label: 'back to the ward garden' });
    const tDef = Date.now();
    let botsOut = '';
    let botsCode = null;
    if (!NO_BOTS) {
      botsProc = start('nightbots', bin('nightbots'), ['-url', `ws://${H}:${PORT.zone}/ws`, '-scenario', 'defense', '-town', String(ward.index), '-out', path.join(TMP, 'nightbots-defense.txt'), '-json', path.join(TMP, 'nightbots-defense.json')], {}, root, (code) => {
        botsCode = code;
      });
      step('  two WP15 night bots (Ana: sword, Bo: spear; dev sunsteel) join at the ward garden; they make the ward falter (dev Interact 52/1)');
    } else {
      await page.evaluate(() => window.__lodestoneNight.defense());
      step('  --no-bots: the ward falters by the dev Interact 52/1 from the browser');
    }
    await page.waitForFunction((t) => window.__lodestone.tapped([510, 511], t).events.length > 0, tDef, { timeout: 60000 }).catch(() => {});
    const warn = (await tapped(page, [510, 511], tDef)).events;
    check(warn.length > 0, `the ward falters: defense warning/wave Events reach the browser (${warn.map((e) => `${e.kind}/${e.value}`).join(' ')})`);
    await sleep(2000);
    await shot(page, 'defense-warning');
    let wardMin = 1000;
    let waveShot = 0;
    const fDef = await fight(page, {
      radius: 50,
      timeoutMs: 600000,
      idleMs: 1e9,
      keep: W,
      trackLow: true,
      leash: 48,
      stop: async () => (await tapped(page, [513], tDef)).events.length > 0,
      onTick: async () => {
        const nh = await nightHud(page);
        if (nh?.defense?.ward != null) wardMin = Math.min(wardMin, nh.defense.ward);
        const waves = (await tapped(page, [511], tDef)).events.length;
        if (waves > waveShot && (await enemies(page)).some((e) => e.d < 12)) {
          waveShot = waves;
          await shot(page, `defense-wave-${waves}`);
        }
      },
    });
    const dEv = await tapped(page, [510, 511, 512, 513, 514, 201, 203, 221], tDef);
    const ended = dEv.events.find((e) => e.kind === 513);
    const selfId = await page.evaluate(() => window.__lodestone.netDebug().entityId);
    const myKills = dEv.events.filter((e) => e.kind === 201 && e.targetId === selfId);
    const rewards = dEv.events.filter((e) => e.kind === 514);
    for (let i = 0; i < 40 && botsProc && botsCode === null; i++) await sleep(500);
    try {
      botsOut = fs.readFileSync(path.join(TMP, 'nightbots-defense.txt'), 'utf8');
    } catch {}
    result.defense = {
      waves: dEv.events.filter((e) => e.kind === 511).map((e) => e.value),
      result: ended?.value ?? null,
      wardMinFromHud: wardMin,
      kills: dEv.events.filter((e) => e.kind === 201).length,
      killsByBrowser: myKills.length,
      reward: rewards.map((e) => e.value),
      swings: fDef.swings,
      drinks: fDef.drinks,
      s: Math.round(fDef.ms / 1000),
      downs: dEv.events.filter((e) => e.kind === 221).length,
      botsExit: botsCode,
      botsLogTail: botsOut.split('\n').slice(-14),
    };
    step(`defense: ${JSON.stringify({ ...result.defense, botsLogTail: undefined })}`);
    for (const l of result.defense.botsLogTail) if (l.trim()) step(`  bots: ${l}`);
    check(ended?.value === 1, `the town defense ended HELD (Event 513 value ${ended?.value ?? 'none'}) after ${result.defense.s} s: waves ${result.defense.waves.join(', ')}, ${result.defense.kills} demon deaths seen by ${NAME} (${myKills.length} by ${NAME}), ward garden lowest ${wardMin}/1000 on the HUD`);
    check(rewards.length > 0, `${NAME} took part and was rewarded (Event 514): ${rewards.map((e) => `+${e.value} XP`).join(', ')}`);
    await shot(page, 'defense-ended');
  }
  if (STOP_AFTER <= 7) throw new Error('stop-after 7');

  // ======================================================== 8. dawn
  item = '8 dawn: survived';
  {
    const nb = await night();
    step(`  world time ${nb.hour.toFixed(2)} h, ${nb.demons} demons alive in the zone; fast-forwarding to 05:50 (dev Interact 52/2) so sunrise (06:00) comes in ~25 s`);
    const tDawn = Date.now();
    await page.evaluate(() => window.__lodestoneNight.setTime(5.84));
    await page.waitForFunction((t) => window.__lodestone.tapped([502], t).events.length > 0, tDawn, { timeout: 120000 }).catch(() => {});
    await sleep(2500);
    const dEv = await tapped(page, [502, 503], tDawn);
    const dawn = dEv.events.find((e) => e.kind === 502);
    const nd = await night();
    const h = await hud(page);
    const all = await tapped(page, [221], 0);
    const downs = all.events.filter((e) => e.kind === 221).length; // respawned (to you only)
    result.dawn = { event: dawn, burned: dEv.events.filter((e) => e.kind === 503).length, hour: nd.hour, night: nd.night, demonsLeft: nd.demons, health: h.health, healthMax: h.healthMax, downsAllSession: downs, lowestNightHealth: lowHealth.night, lowestNightHealthMax: lowHealth.nightMax };
    check(!!dawn && !nd.night, `dawn (Event 502) at ${nd.hour.toFixed(2)} h: ${dawn?.value ?? 0} demons burned, ${dawn?.targetId ?? 0} fled; ${nd.demons} demons left`);
    check(h.health > 0 && downs === 0, `${NAME} survived the night in ${town.name}: health ${Math.round(h.health)}/${h.healthMax} at dawn (lowest while fighting at night ${lowHealth.night === Infinity ? "n/a" : lowHealth.night}/${lowHealth.nightMax}), downed ${downs} times all session (Event 221 respawns)`);
    await look(page, 1.2, 0.1);
    await sleep(1200);
    await shot(page, 'dawn');
    const db = await itemsDbg(CHAR).catch((e) => ({ error: String(e) }));
    result.zoneInventoryAtDawn = db;
    const items = (db.items ?? db.inventory?.items ?? []).map((i) => i.b ?? i.item ?? i.key).filter(Boolean);
    check(items.includes('weapon:sunsteel_blade') || JSON.stringify(db).includes('sunsteel_blade'), "the zone's live inventory still holds the socketed Sunsteel Blade at dawn", { items });
  }

  item = 'general';
  const errors = consoleLog.filter((l) => /pageerror/.test(l));
  fs.writeFileSync(path.join(EVIDENCE, 'g4-acceptance-console.txt'), consoleLog.join('\n') + '\n');
  check(errors.length === 0, 'no page errors in the browser', errors.slice(0, 5));
  const nf = await netd(page);
  result.prediction = nf;
} catch (e) {
  if (!String(e).includes('stop-after')) {
    failures.push(String(e));
    step(`ERROR ${e.stack ?? e}`);
    try {
      if (page) await page.screenshot({ path: path.join(TMP, 'error.png') });
      step(`  error screenshot ${path.join(TMP, 'error.png')}`);
    } catch {}
  } else step(`stopped after phase ${STOP_AFTER} (--stop-after)`);
} finally {
  stopping = true;
  try {
    result.zoneLogTail = zoneLogLines(/error|warn|panic/i, 30);
  } catch {}
  if (browser) await browser.close().catch(() => {});
  for (const c of children) killTree(c);
  await sleep(500);
  if (!KEEP_DB) {
    try {
      goSync(['run', './server/account/cmd/devdb', 'drop', DB]);
      step(`dropped ${DB}`);
    } catch (e) {
      step(`could not drop ${DB}: ${e.message}`);
    }
  }
  const summary = Object.entries(verdicts).map(([k, v]) => `${k}: ${v.every(Boolean) ? 'PASS' : 'FAIL'} (${v.filter(Boolean).length}/${v.length})`);
  step('summary: ' + summary.join(' | '));
  step(failures.length ? `FAILED: ${failures.join('; ')}` : 'ALL PASS');
  result.verdicts = verdicts;
  result.screenshots = shots;
  result.logs = TMP;
  fs.writeFileSync(path.join(EVIDENCE, 'g4-acceptance.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(EVIDENCE, 'g4-acceptance.json'), JSON.stringify(result, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1) + '\n');
  process.exit(failures.length ? 1 : 0);
}
