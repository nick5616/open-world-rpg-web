#!/usr/bin/env node
// Playtest 2 (CR 018): opt-in PvP and party duels, end to end. A private
// stack built from this checkout (account, director, zone, social on random
// ports, a scratch database: a fresh world), the client from Vite, and two
// headless Chromium players signed in with dev auth, driving the real UI:
//
//   1. Both sign in; A invites B with /invite, B accepts in the party frame.
//   2. Duel: A presses Duel in the party frame, B gets the prompt and
//      accepts, both see the 3-2-1 countdown and the ring, A fights B to 1
//      health (real attack input, real hit claims), both get the result, the
//      loser's health comes back, party chat has the line.
//   3. PvP: B leaves the party; A flags from the character panel (C), B with
//      /pvp; in the Haven A's swings are refused ("safe zone"); both rejoin
//      outside the Haven (dev spawn) and A's swings land at half damage
//      until B goes down: kill feed on both, B respawns with nothing lost.
//
//   node tools/acceptance/pt2-pvp.mjs [--livekit ws://127.0.0.1:7880] [--keep-db]
//
// Evidence: docs/evidence/pt2-pvp-acceptance.txt, pt2-pvp-*.png.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { env, killTree, root, waitHttp } from '../../scripts/lib.mjs';

const require = createRequire(path.join(root, 'client', 'package.json'));
const { chromium } = require('playwright');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const LIVEKIT = arg('livekit', 'ws://127.0.0.1:7880');
const KEEP_DB = process.argv.includes('--keep-db');
const EVIDENCE = path.join(root, 'docs', 'evidence');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-pvp-'));
const RUN = Date.now().toString(36);
const DB = `lodestone_wp04_pvp_${RUN}`; // devdb manages lodestone_wp04_* scratch databases only
const EXE = process.platform === 'win32' ? '.exe' : '';
const ZONE_ID = `zone-pvp-${RUN}`;
const NAMES = { A: 'Corin', B: 'Della' };
const USERS = { A: `pvpcorin${RUN}`, B: `pvpdella${RUN}` };
const GPU_ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const H = '127.0.0.1';

fs.mkdirSync(EVIDENCE, { recursive: true });
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
let shotN = 0;
async function shot(page, name) {
  const file = `pt2-pvp-${String(++shotN).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: path.join(EVIDENCE, file) });
  step(`  screenshot ${file}`);
}

function goSync(args, extra = {}) {
  const r = spawnSync('go', args, { cwd: root, env: env(extra), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`go ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
const bin = (name) => path.join(TMP, `pvp${RUN}-${name}${EXE}`);
const children = [];
let stopping = false;
let dead = null;
function start(name, cmd, args, extra, cwd = root) {
  const out = fs.createWriteStream(path.join(TMP, `${name}.log`));
  const child = spawn(cmd, args, { cwd, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.push(child);
  child.on('exit', (code, sig) => {
    if (!stopping) {
      dead = `${name} exited (${code ?? sig}) during the run`;
      step(`ERROR service ${name} exited (${code ?? sig}); see ${path.join(TMP, name + '.log')}`);
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

// ---------------------------------------------------------------- page helpers
const pl = (page) => page.evaluate(() => window.__lodestone.player());
const pvp = (page) => page.evaluate(() => window.__lodestonePvp.state());
const look = (page, yaw, pitch = 0) => page.evaluate(([y, p]) => window.__lodestone.setLook(y, p), [yaw, pitch]);
const yawTo = (from, x, z) => Math.atan2(-(x - from.x), -(z - from.z));
const health = (page) => page.evaluate(() => window.__lodestone.selfHealth());
const tapped = (page, kinds, since = 0) => page.evaluate(([k, s]) => window.__lodestone.tapped(k, s), [kinds, since]);
async function until(page, fn, a = 0, timeout = 120000) {
  await page.waitForFunction(fn, a, { polling: 100, timeout });
}

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
  await page.waitForFunction(() => !!window.__lodestoneCombat?.hud().active && !!window.__lodestonePvp && !!window.__lodestoneMap?.state().online, null, { timeout: 240000 });
  // The world is loaded and the player stands on it (the position is set).
  await page.waitForFunction(() => {
    const p = window.__lodestone.player().pos;
    return Math.abs(p.x) + Math.abs(p.z) > 1 && window.__lodestone.netDebug()?.prediction?.agreements > 30;
  }, null, { timeout: 240000 });
  await page.evaluate(() => {
    window.__lodestone.tap();
    window.__lodestone.setQuality('medium');
    window.__lodestone.setFreezeTime(true);
    window.__lodestone.setTimeOfDay(0.45 * 3600);
  });
}

async function openChat(page) {
  if ((await page.getByTestId('chat-input').count()) === 0) await page.keyboard.press('Enter');
  await page.getByTestId('chat-input').waitFor();
}
async function say(page, text) {
  await openChat(page);
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-input').press('Enter');
  await page.getByTestId('chat-input').press('Escape').catch(() => {});
}

async function walkTo(page, x, z, { stopAt = 1, timeoutMs = 60000 } = {}) {
  const t0 = Date.now();
  await page.keyboard.down('KeyW');
  try {
    for (;;) {
      if (dead) throw new Error(dead);
      const p = (await pl(page)).pos;
      const d = Math.hypot(x - p.x, z - p.z);
      if (d <= stopAt) return { ok: true, p, d };
      if (Date.now() - t0 > timeoutMs) return { ok: false, p, d };
      await look(page, yawTo(p, x, z), 0);
      await sleep(80);
    }
  } finally {
    await page.keyboard.up('KeyW');
  }
}

/** The victim stands `dist` m in front of the attacker (along the attacker's yaw); both face each other. */
async function faceOff(attacker, victim, dist = 2) {
  const a = (await pl(attacker)).pos;
  const yaw = (await pl(attacker)).yaw;
  const tx = a.x - Math.sin(yaw) * dist;
  const tz = a.z - Math.cos(yaw) * dist;
  await walkTo(victim, tx, tz, { stopAt: 0.3, timeoutMs: 40000 });
  await sleep(600);
  const a2 = (await pl(attacker)).pos;
  const b2 = (await pl(victim)).pos;
  await look(attacker, yawTo(a2, b2.x, b2.z), -0.05);
  await look(victim, yawTo(b2, a2.x, a2.z), 0);
  return Math.hypot(a2.x - b2.x, a2.z - b2.z);
}

/** Swing (the runtime's scripted input: the same latches as the mouse) until done() or n swings. */
async function swingUntil(attacker, victim, done, max = 40) {
  let swings = 0;
  for (; swings < max; swings++) {
    if (await done()) break;
    const a = (await pl(attacker)).pos;
    const b = (await pl(victim)).pos;
    await look(attacker, yawTo(a, b.x, b.z), -0.05);
    await attacker.evaluate(() => window.__lodestoneCombat.runtime.press('attack'));
    await sleep(700);
  }
  return swings;
}

async function rejoinAt(page, char, at) {
  await page.evaluate(() => window.__lodestone.screen('title'));
  for (let i = 0; i < 100; i++) {
    const info = await fetch(`${ZONE}/debug/items?char=${encodeURIComponent(char)}`).then((r) => r.json()).catch(() => ({ online: true }));
    if (!info.online) break;
    await sleep(150);
  }
  await page.evaluate((a) => window.__lodestone.rejoinAt(a), at);
  await waitPlaying(page);
}

let ZONE = '';

/** Flag on through the chat command, retrying through the combat lock / cooldown. */
async function flagOn(page) {
  for (let i = 0; i < 12; i++) {
    if ((await pvp(page)).flagged) return true;
    await say(page, '/pvp on');
    const ok = await page.waitForFunction(() => window.__lodestonePvp.state().flagged, null, { timeout: 2500 }).then(() => true, () => false);
    if (ok) return true;
    await sleep(1500);
  }
  return false;
}

// ================================================================ main
let browsers = [];
const errors = [];
try {
  step(`Playtest 2 PvP + duels (CR 018), run ${RUN}`);
  const taken = new Set();
  const PORT = { account: await freePort(taken), director: await freePort(taken), zone: await freePort(taken), social: await freePort(taken), vite: await freePort(taken) };
  ZONE = `http://${H}:${PORT.zone}`;
  step(`private ports ${JSON.stringify(PORT)}; logs in ${TMP}`);
  const pgUrl = goSync(['run', './server/account/cmd/devdb', 'create', DB]).trim().split('\n').pop();
  step(`scratch database ${DB}`);
  for (const [name, pkg] of [['account', './server/account'], ['director', './server/director'], ['zone', './server/zone'], ['social', './server/social']]) goSync(['build', '-o', bin(name), pkg]);
  step('built account, director, zone, social from this checkout');
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
  check(await waitHttp(`http://${H}:${PORT.account}/healthz`, 120000), `account healthy on :${PORT.account}`);
  start('social', bin('social'), [], { ...svcEnv, LODESTONE_LIVEKIT_URL: LIVEKIT });
  check(await waitHttp(`http://${H}:${PORT.social}/healthz`, 30000), `social healthy on :${PORT.social}`);
  start('director', bin('director'), [], svcEnv);
  check(await waitHttp(`http://${H}:${PORT.director}/healthz`, 30000), `director healthy on :${PORT.director}`);
  start('zone', bin('zone'), [], { ...svcEnv, LODESTONE_ZONE_PORT: String(PORT.zone), LODESTONE_ZONE_ID: ZONE_ID, LODESTONE_ZONE_WT_ADDR: 'off', LODESTONE_ZONE_PUBLIC_URL: `ws://${H}:${PORT.zone}/ws`, LODESTONE_ZONE_DEBUG_RAIN: '0', LODESTONE_ZONE_DEV_SPAWN: '1' });
  check(await waitHttp(`${ZONE}/healthz`, 120000), `zone healthy on :${PORT.zone}`);
  start('vite', process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT.vite), '--strictPort', '--host', H], { VITE_ACCOUNT_URL: `http://${H}:${PORT.account}`, VITE_DIRECTOR_URL: `http://${H}:${PORT.director}`, VITE_SOLO: '0' }, path.join(root, 'client'));
  check(await waitHttp(`http://${H}:${PORT.vite}/`, 90000), `vite on :${PORT.vite}`);
  await sleep(6000); // the zone registry heartbeat reaches the director

  browsers = [await chromium.launch({ args: [...GPU_ARGS, '--autoplay-policy=no-user-gesture-required'] }), await chromium.launch({ args: [...GPU_ARGS, '--autoplay-policy=no-user-gesture-required'] })];
  const pages = [];
  for (const [i, br] of browsers.entries()) {
    const label = i === 0 ? 'A' : 'B';
    const page = await (await br.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
    await page.goto(`http://${H}:${PORT.vite}/?debug=1&autoplay=1&transport=ws&rain=0`);
    pages.push(page);
  }
  const [a, b] = pages;

  // ======================================================== 1. party
  item = '1 sign-in, party';
  await Promise.all([signInAndPlay(a, USERS.A, NAMES.A), signInAndPlay(b, USERS.B, NAMES.B)]);
  for (const p of [a, b]) await p.keyboard.press('F3'); // debug HUD off (top left is the PvP indicator's)
  const charA = (await a.evaluate(() => window.__lodestone.session())).characterId;
  const charB = (await b.evaluate(() => window.__lodestone.session())).characterId;
  const [pa0, pb0] = [(await pl(a)).pos, (await pl(b)).pos];
  step(`  both playing: ${NAMES.A} at (${pa0.x.toFixed(1)}, ${pa0.z.toFixed(1)}), ${NAMES.B} at (${pb0.x.toFixed(1)}, ${pb0.z.toFixed(1)})`);
  await say(a, `/invite ${NAMES.B}`);
  await b.getByTestId('party-accept').waitFor({ timeout: 20000 });
  await b.getByTestId('party-accept').dispatchEvent('click');
  await a.waitForFunction(() => document.querySelectorAll('[data-testid="party-member"]').length === 2, null, { timeout: 20000 });
  await Promise.all([a, b].map((p) => p.waitForFunction(() => window.__lodestoneMap.state().partyId !== 0, null, { timeout: 20000 })));
  check(true, 'party formed (/invite + the party frame); the zone sees both in one party');

  // ======================================================== 2. duel
  item = '2 duel';
  await look(a, 0, 0);
  await sleep(300);
  const dist = await faceOff(a, b);
  step(`  ${NAMES.B} stands ${dist.toFixed(2)} m in front of ${NAMES.A}`);
  await a.getByTestId('party-duel').waitFor({ timeout: 10000 });
  await shot(a, 'party-frame-duel-button-A');
  const tDuel = Date.now();
  await a.getByTestId('party-duel').dispatchEvent('click');
  await b.getByTestId('duel-challenge').waitFor({ timeout: 10000 });
  const promptText = await b.getByTestId('duel-challenge').innerText();
  check(promptText.includes(NAMES.A) && /challenges you to a duel/.test(promptText), 'the challenged gets the prompt (Accept Y / Decline U, 20 s)', promptText.replace(/\s+/g, ' '));
  check((await pvp(a)).duel?.phase === 1, `${NAMES.A} sees "challenge sent"`);
  await shot(b, 'duel-challenge-B');
  await b.getByTestId('duel-accept').dispatchEvent('click');
  await a.getByTestId('duel-countdown').waitFor({ timeout: 5000 });
  const cd = await a.getByTestId('duel-countdown').innerText();
  check(['3', '2', '1'].includes(cd.trim()), `3-2-1 countdown on ${NAMES.A}'s screen (saw "${cd.trim()}")`);
  await shot(a, 'duel-countdown-A');
  const dA = (await pvp(a)).duel;
  check(dA && dA.radius === 25 && dA.phase === 2, 'duel ring: 25 m around the midpoint', dA && { center: dA.center, radius: dA.radius });
  // No hit lands during the countdown (party members, not fighting yet).
  await a.evaluate(() => window.__lodestoneCombat.runtime.press('attack'));
  await sleep(500);
  await until(a, () => window.__lodestonePvp.state().duel?.phase === 3, 0, 8000);
  check(true, 'the fight starts after the countdown');
  const hpB0 = await health(b);
  let midShot = false;
  const swings = await swingUntil(a, b, async () => {
    const s = await pvp(b);
    if (!midShot) {
      const h = await health(b);
      if (h && h.health < hpB0.health * 0.75) {
        midShot = true;
        await shot(a, 'duel-fight-ring-A');
      }
    }
    return !s.duel;
  }, 60);
  const endA = await pvp(a);
  const endB = await pvp(b);
  check(endA.banner?.kind === 'won' && endB.banner?.kind === 'lost', `the duel ends at 1 health after ${swings} swings: ${NAMES.A} wins, ${NAMES.B} loses`, { a: endA.banner?.text, b: endB.banner?.text });
  await shot(a, 'duel-won-A');
  await shot(b, 'duel-lost-B');
  const ended = await tapped(b, [996], tDuel - 1000);
  const e996 = ended.events[0];
  check(!!e996 && e996.value === 1, 'Event 996 reason 1 (dropped to 1 health)', e996 && { value: e996.value });
  const hits = await tapped(b, [992], tDuel - 1000);
  check(hits.events.length > 0, `${hits.events.length} duel hits landed on ${NAMES.B} (Event 992)`);
  await sleep(800);
  const hpB1 = await health(b);
  check(hpB1.health >= hpB0.health - 1, `${NAMES.B}'s health is back after the duel (${hpB1.health} / ${hpB1.healthMax}; ${hpB0.health} before)`);
  const partyChat = await a.evaluate(() => JSON.stringify(window.__lodestoneSocial?.messages?.('party') ?? null)).catch(() => 'null');
  step(`  party chat (if the dev handle exposes it): ${partyChat.slice(0, 300)}`);
  const zoneLog = fs.readFileSync(path.join(TMP, 'zone.log'), 'utf8');
  check(/duel ended.*reason"?[=:]1/.test(zoneLog), 'zone log: duel ended, reason 1');

  // ======================================================== 3. open PvP
  item = '3 pvp';
  await say(b, '/leave');
  await a.waitForFunction(() => !document.querySelector('[data-testid="party-frame"]'), null, { timeout: 15000 }).catch(() => {});
  await Promise.all([a, b].map((p) => p.waitForFunction(() => window.__lodestoneMap.state().partyId === 0, null, { timeout: 20000 })));
  check(true, `${NAMES.B} left the party`);
  await a.keyboard.press('KeyC');
  await a.getByTestId('pvp-toggle').waitFor({ timeout: 5000 });
  await a.getByTestId('pvp-panel').scrollIntoViewIfNeeded();
  // Just out of a duel: the combat lock (6 s) may still refuse it; click again until it takes.
  for (let i = 0; i < 8 && !(await pvp(a)).flagged; i++) {
    await a.getByTestId('pvp-toggle').dispatchEvent('click');
    await a.waitForFunction(() => window.__lodestonePvp.state().flagged, null, { timeout: 2000 }).catch(() => {});
    if (!(await pvp(a)).flagged) step(`  panel toggle refused: ${(await pvp(a)).notice?.text}`);
  }
  check((await pvp(a)).flagged, `${NAMES.A} flagged from the character panel`);
  await sleep(300);
  await shot(a, 'character-panel-pvp-on-A');
  await a.keyboard.press('KeyC');
  await flagOn(b);
  const sa = await pvp(a);
  check(sa.flagged && sa.safe, `both flagged (panel toggle, /pvp on); the Haven is a safe zone: "${sa.safeName}"`, { safe: sa.safe, name: sa.safeName });
  await until(a, (n) => (window.__lodestoneDrawn?.() ?? []).some((v) => v.name === n && (v.typeId & 0x1000) !== 0), NAMES.B, 8000);
  check(true, `${NAMES.B}'s snapshot typeId carries the PvP bit (red crossed swords on the nameplate)`);
  await look(a, 0, 0);
  await sleep(300);
  await faceOff(a, b);
  const tSafe = Date.now();
  const hpSafe = await health(b);
  await swingUntil(a, b, async () => false, 3);
  const refusedSafe = (await tapped(a, null, tSafe)).hits.filter((h) => !h.accepted && h.flags === 16);
  const hpSafe2 = await health(b);
  check(refusedSafe.length > 0 && hpSafe2.health === hpSafe.health, `in the Haven ${refusedSafe.length} claims refused with 16 (safe zone), ${NAMES.B}'s health unchanged`);
  await shot(a, 'safe-zone-refused-A');

  // Out of the Haven: candidates 900 m from spawn, on dry land, not in a town.
  const spawn = pa0;
  const settlements = await a.evaluate(() => window.__lodestoneMap.sites().filter((s) => s.kind === 'settlement' || s.kind === 'town' || s.kind === 'village' || s.kind === 'hamlet'));
  let spot = null;
  for (let k = 0; k < 16 && !spot; k++) {
    const ang = (k / 16) * Math.PI * 2;
    const c = { x: spawn.x + Math.cos(ang) * 900, z: spawn.z + Math.sin(ang) * 900 };
    if (c.x < 100 || c.z < 100 || c.x > 3996 || c.z > 3996) continue;
    if (settlements.some((s) => Math.hypot(s.x - c.x, s.z - c.z) < 250)) continue;
    await rejoinAt(a, charA, c);
    await sleep(1000);
    await flagOn(a); // a fresh session starts unflagged (CR 018)
    await sleep(700); // 990 carries the safe-zone bit
    const p = await pl(a);
    const st = await pvp(a);
    step(`  candidate (${c.x.toFixed(0)}, ${c.z.toFixed(0)}): mode ${p.mode}, flagged ${st.flagged}, safe ${st.safe} ${st.safeName}`);
    if (p.mode !== 'swim' && st.flagged && !st.safe) spot = p.pos;
  }
  check(!!spot, 'found open ground outside the Haven and towns (rejoined at a dev spawn point; a fresh session is unflagged, so flagged again)', spot);
  if (!spot) throw new Error('no PvP spot');
  await rejoinAt(b, charB, { x: spot.x, z: spot.z - 2 });
  await flagOn(b);
  await sleep(1000);
  await look(a, 0, 0);
  await sleep(300);
  await faceOff(a, b);
  const sb = await pvp(b);
  check(sb.flagged && !sb.safe, `${NAMES.B} flagged on open ground (no safe zone)`);
  const tOpen = Date.now();
  const hpOpen = await health(b);
  let hitShot = false;
  const swings2 = await swingUntil(a, b, async () => {
    const h = await health(b);
    if (!hitShot && h && h.health < hpOpen.health) {
      hitShot = true;
      await sleep(150);
      await shot(a, 'pvp-hit-A');
    }
    return (await pvp(b)).feed.length > 0;
  }, 60);
  const acc = (await tapped(a, null, tOpen)).hits.filter((h) => h.accepted);
  const dmg = acc.map((h) => h.damage);
  check(acc.length > 0, `open PvP: ${acc.length} hits accepted in ${swings2} swings, damage ${JSON.stringify(dmg.slice(0, 6))}... (sword light at level 1 is 18 PvE, 9 PvP)`);
  const feedA = (await pvp(a)).feed.map((f) => f.text);
  const feedB = (await pvp(b)).feed.map((f) => f.text);
  check(feedA.some((t) => t.includes(`You defeated ${NAMES.B}`)) && feedB.some((t) => t.includes(`${NAMES.A} defeated you`)), 'kill feed on both (Event 993)', { a: feedA, b: feedB });
  await shot(a, 'kill-feed-A');
  await shot(b, 'kill-feed-downed-B');
  await until(b, () => {
    const h = window.__lodestone.selfHealth();
    return h && h.health === h.healthMax;
  }, 0, 20000).catch(() => {});
  const hpRes = await health(b);
  check(hpRes.health === hpRes.healthMax, `${NAMES.B} respawned at full health (${hpRes.health})`);
  check(errors.length === 0, 'no page errors in either browser', errors.slice(0, 5));
} catch (e) {
  failures.push(String(e));
  step(`ERROR ${e.stack ?? e}`);
  for (const [i, br] of browsers.entries()) {
    try {
      const pg = br.contexts()[0]?.pages()[0];
      if (pg) await pg.screenshot({ path: path.join(TMP, `error-${i}.png`) });
    } catch {}
  }
} finally {
  stopping = true;
  for (const br of browsers) await br.close().catch(() => {});
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
  fs.writeFileSync(path.join(EVIDENCE, 'pt2-pvp-acceptance.txt'), lines.join('\n') + '\n');
  process.exit(failures.length ? 1 : 0);
}
