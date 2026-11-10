// CR 022 shared spell visuals, end to end: two real clients (Vite, headless
// Chromium on the GPU) on a private zone process with a training camp.
// "Caster" plays in third person (their own body and spells, what they
// see) and uses every spell mechanic, held dash and weapon move through the
// real runtime; "Watcher" stands 11 m away in first person and sees it as
// another player. For each one the run takes both screenshots at the same
// moment and samples both clients' caster records (castState: what is held,
// the dash thrust, the aim) and both bodies (the caster's own third-person
// avatar vs the watcher's avatar of them: action, held pose, body pitch)
// over the next second, then compares them.
//
//   npx vite-node src/combat/dev/shared-fx-shots.ts      (from client/; needs Go and the worldgen wasm)
//   SHARED_FX_TAG=before npx vite-node ...                (a run on a build without CR 022: same shots, no records)
//
// Writes docs/evidence/pt2-shared-fx-{casts,channels,dashes,weapons}[-before].jpg
// and pt2-shared-fx-run[-before].json.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { COMBAT } from '@lodestone/contracts';
import { devTicket } from '../../net/dev/devTicket';
import { buildZone, repoRoot, startZone, waitHttp, type ZoneProc } from '../../sim/dev/traversalRun';

const SEED = '20261108';
const HINT = { x: 1330, z: 2330 };
const TAG = process.env.SHARED_FX_TAG ? `-${process.env.SHARED_FX_TAG}` : '';
/** SHARED_FX_ONLY=key,key: a subset (debug runs; no sheets are written). */
const ONLY = process.env.SHARED_FX_ONLY ? process.env.SHARED_FX_ONLY.split(',') : null;
const on = (key: string) => !ONLY || ONLY.includes(key);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEG = 180 / Math.PI;

interface Handle {
  player(): { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; mode: string; dash: number };
  setLook(yaw: number | null, pitch?: number): void;
  setQuality(q: string): void;
  setFreezeTime(v: boolean): void;
  setTimeOfDay(s: number): void;
  connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
  netDebug(): { phase: string } | null;
}
interface Rt {
  press(what: number | string): void;
  hold(slot: number, on: boolean): void;
  holdCast(slot: number, on: boolean): void;
  selfId(): number;
  timeline: { mana: number };
}
interface CombatHandle {
  runtime: Rt;
  hud(): { active: boolean; loadouts: { weapon: string; spells: (string | null)[] }[]; activeLoadout: number; mana: number; health?: number; healthMax?: number };
  interact(kind: number, action: number, arg: number): void;
}
interface Rec {
  held: { kind: string; id: number } | null;
  dash: { variant: number; holding: boolean } | null;
  action: { id: number } | null;
  aim: { yaw: number; pitch: number };
}
interface Body {
  action: string | null;
  held: string | null;
  bodyPitch: number;
}
type W = Window & {
  __lodestone: Handle;
  __lodestoneCombat?: CombatHandle;
  __lodestoneDrawn?: () => { id: number; kind: number; x: number; y: number; z: number; yaw: number; pitch: number; healthPct: number; activity: number }[];
  __lodestoneCastState?: (key: 'self' | number) => Rec | null;
  __lodestoneLocalAvatar?: () => Body;
  __lodestoneAvatars?: () => (Body & { id: number })[];
};

async function join(browser: Browser, vitePort: number, zone: ZoneProc, name: string, at: { x: number; z: number }, view: 'first' | 'third'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${name}] pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${vitePort}/?debug=1&rain=0&view=${view}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
  const ticket = devTicket({ characterId: `pt2sfx-${name}-${Date.now()}`, characterName: name, worldId: zone.worldId, zoneId: zone.zoneId });
  await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zone.port}/ws?spawn=${at.x.toFixed(2)},${at.z.toFixed(2)}`, zoneId: zone.zoneId, worldId: zone.worldId, name });
  await page.waitForFunction(() => (window as unknown as W).__lodestone.netDebug()?.phase === 'playing' && (window as unknown as W).__lodestone.player().pos.y > 20 && !!(window as unknown as W).__lodestoneCombat?.hud().active, null, { polling: 250, timeout: 120000 });
  await page.evaluate(() => {
    const l = (window as unknown as W).__lodestone;
    l.setQuality('high');
    l.setFreezeTime(true);
    l.setTimeOfDay(0.45 * 3600);
  });
  await page.mouse.move(640, 360);
  await page.keyboard.press('F3'); // hide the debug HUD
  await page.addStyleTag({ content: '[data-testid="lock-hint"]{display:none!important}' }); // the "click to look" hint over the view
  return page;
}

async function sheet(browser: Browser, file: string, title: string, imgs: { label: string; png: Buffer }[]): Promise<void> {
  if (!imgs.length) return;
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  const cells = imgs.map((i) => `<figure><img src="data:image/png;base64,${i.png.toString('base64')}" width="640" height="360"><figcaption>${i.label}</figcaption></figure>`).join('');
  await page.setContent(`<html><body style="margin:0;background:#111;color:#ddd;font:14px system-ui"><div style="padding:8px 10px;font-weight:600">${title}</div><div style="display:grid;grid-template-columns:repeat(2,640px)">${cells}</div><style>figure{margin:0}figcaption{height:22px;line-height:22px;padding:0 8px;background:#1c1c1c;overflow:hidden;white-space:nowrap}img{display:block}</style></body></html>`);
  await page.screenshot({ path: file, fullPage: true, type: 'jpeg', quality: 84 });
  await page.close();
  console.log(file);
}

const yawTo = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(-(to.x - from.x), -(to.z - from.z));
const wrap = (a: number) => {
  let d = a % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

async function main() {
  const bin = buildZone();
  const vitePort = 20000 + Math.floor(Math.random() * 25000);
  const viteBin = path.join(path.dirname(createRequire(path.join(repoRoot, 'client', 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');
  const vite = spawn(process.execPath, [viteBin, '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  let zone: ZoneProc | null = null;
  let browser: Browser | null = null;
  const report: { tag: string; rows: Record<string, unknown>[]; summary?: Record<string, unknown> } = { tag: TAG || 'after', rows: [] };
  const out = path.join(repoRoot, 'docs', 'evidence');
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    zone = await startZone(bin, SEED, { LODESTONE_ZONE_DEBUG_CAMP: `${HINT.x},${HINT.z},20,sentinel boar wolf ram brute sentinel,,dummy`, LODESTONE_ZONE_NO_ATLAS_ENEMIES: '1', LODESTONE_ZONE_NO_DEMONS: '1' });
    let anchor: { x: number; z: number } | null = null;
    for (let i = 0; i < 60 && !anchor; i++) {
      const dbg = (await (await fetch(`http://127.0.0.1:${zone.port}/debug/combat`)).json()) as { groups?: { kind: string; x: number; z: number }[] } | null;
      anchor = dbg?.groups?.find((g) => g.kind === 'test') ?? null;
      if (!anchor) await sleep(250);
    }
    if (!anchor) throw new Error('no training camp');
    const home = { ...anchor };
    browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const caster = await join(browser, vitePort, zone, 'Caster', { x: home.x + 14, z: home.z }, 'third');
    const watcher = await join(browser, vitePort, zone, 'Watcher', { x: home.x + 13, z: home.z + 11 }, 'first');
    await sleep(6000); // the area banner fades
    const casterId = await caster.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.selfId());
    const shared = await caster.evaluate(() => typeof (window as unknown as W).__lodestoneCastState === 'function');
    console.log('caster', casterId, 'shared state build:', shared);

    const me = (p: Page) => p.evaluate(() => (window as unknown as W).__lodestone.player());
    const press = (what: number | string) => caster.evaluate((w) => (window as unknown as W).__lodestoneCombat!.runtime.press(w), what);
    const holdSlot = (slot: number, on: boolean) => caster.evaluate(([s, o]) => (window as unknown as W).__lodestoneCombat!.runtime.hold(s, o), [slot, on] as const);
    const holdCast = (slot: number, on: boolean) => caster.evaluate(([s, o]) => (window as unknown as W).__lodestoneCombat!.runtime.holdCast(s, o), [slot, on] as const);
    const look = (p: Page, yaw: number, pitch: number) => p.evaluate(([y, pi]) => (window as unknown as W).__lodestone.setLook(y, pi), [yaw, pitch] as const);
    const target = async () =>
      caster.evaluate(() => {
        const me0 = (window as unknown as W).__lodestone.player().pos;
        const vs = ((window as unknown as W).__lodestoneDrawn?.() ?? []).filter((v) => v.kind === 2 && v.healthPct > 0);
        vs.sort((a, b) => Math.hypot(a.x - me0.x, a.z - me0.z) - Math.hypot(b.x - me0.x, b.z - me0.z));
        return vs[0] ?? null;
      });
    /** The caster faces the nearest dummy (its chest), yawOff to the side. */
    const aim = async (yawOff = 0, pitchAdd = 0) => {
      const t = await target();
      const p = (await me(caster)).pos;
      if (!t) return;
      const d = Math.hypot(t.x - p.x, t.z - p.z);
      await look(caster, yawTo(p, t) + yawOff, Math.atan2(t.y + 0.7 - (p.y + 1.6), d) + pitchAdd);
    };
    /** The watcher frames the caster (and what they aim at), leading a moving caster by `leadS`. */
    const frameWatcher = async (towardTarget = true, leadS = 0) => {
      const cp = await me(caster);
      const c = { x: cp.pos.x + cp.vel.x * leadS, y: cp.pos.y + cp.vel.y * leadS, z: cp.pos.z + cp.vel.z * leadS };
      const w = (await me(watcher)).pos;
      const t = towardTarget ? await target() : null;
      const fx = t ? (c.x * 2 + t.x) / 3 : c.x;
      const fz = t ? (c.z * 2 + t.z) / 3 : c.z;
      await look(watcher, yawTo(w, { x: fx, z: fz }), Math.atan2(c.y + 1 - (w.y + 1.6), Math.hypot(fx - w.x, fz - w.z)));
    };
    const waitMana = async (min: number) => {
      await caster.waitForFunction((m) => (window as unknown as W).__lodestoneCombat!.runtime.timeline.mana >= m, Math.min(95, min), { timeout: 30000, polling: 200 }).catch(() => console.log('  (mana wait timed out)'));
    };
    const active = () => caster.evaluate(() => (window as unknown as W).__lodestoneCombat!.hud().activeLoadout);
    const equipSpell = async (key: string, slot = 0) => {
      const sp = COMBAT.spells.find((s) => s.key === key)!;
      const lo = await active();
      await caster.evaluate(([id, a, s]) => {
        const c = (window as unknown as W).__lodestoneCombat!;
        c.interact(50, 7, id);
        c.interact(50, 3, a | (s << 4) | (id << 8));
      }, [sp.id, lo, slot] as const);
      await caster.waitForFunction(([k, s]) => {
        const h = (window as unknown as W).__lodestoneCombat!.hud();
        return h.loadouts[h.activeLoadout]?.spells[s as number] === k;
      }, [key, slot] as const, { timeout: 10000 });
      await sleep(250);
    };
    const equipWeapon = async (key: string) => {
      const w = COMBAT.weapons.find((x) => x.key === key)!;
      const lo = await active();
      await caster.evaluate(([id, a]) => (window as unknown as W).__lodestoneCombat!.interact(50, 2, a | (id << 8)), [w.id, lo] as const);
      await caster.waitForFunction((k) => {
        const h = (window as unknown as W).__lodestoneCombat!.hud();
        return h.loadouts[h.activeLoadout]?.weapon === k;
      }, key, { timeout: 10000 });
      await sleep(400);
    };
    const drink = async () => {
      const low = await caster.evaluate(() => {
        const h = (window as unknown as W).__lodestoneCombat!.hud();
        return (h.health ?? 100) < (h.healthMax ?? 100) * 0.5;
      });
      if (low) await press('drink');
    };

    /**
     * Samples both clients for `ms`: the caster's own record and body, the
     * watcher's record and avatar of the caster, the watcher's drawn look of
     * the caster (the pre-CR 022 aim source). Returns what each side showed.
     */
    const sample = async (ms: number) => {
      const seen = { caster: { actions: new Set<string>(), held: new Set<string>(), dashHold: false, pitchMin: 0 }, watcher: { actions: new Set<string>(), held: new Set<string>(), dashHold: false, pitchMin: 0 }, aimErr: [] as number[], lookErr: [] as number[], conv: [] as number[], heldMatch: 0, heldN: 0, raw: [] as unknown[], variants: new Set<string>() };
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const [c, w] = await Promise.all([
          caster.evaluate(() => {
            const x = window as unknown as W;
            const p = x.__lodestone.player() as unknown as { yaw?: number; pitch?: number };
            return { rec: x.__lodestoneCastState?.('self') ?? null, body: x.__lodestoneLocalAvatar?.() ?? null, look: { yaw: p.yaw ?? null, pitch: p.pitch ?? null } };
          }),
          watcher.evaluate((id) => {
            const x = window as unknown as W;
            return { rec: x.__lodestoneCastState?.(id) ?? null, body: x.__lodestoneAvatars?.().find((a) => a.id === id) ?? null, view: x.__lodestoneDrawn?.().find((v) => v.id === id) ?? null };
          }, casterId),
        ]);
        for (const [side, s] of [['caster', c], ['watcher', w]] as const) {
          const o = seen[side];
          if (s.body?.action) o.actions.add(s.body.action);
          if (s.body?.held) o.held.add(s.body.held);
          if (s.body) o.pitchMin = Math.min(o.pitchMin, s.body.bodyPitch);
          if (s.rec?.dash?.holding) o.dashHold = true;
        }
        if (c.rec?.held && ['stream', 'beam', 'charge'].includes(c.rec.held.kind) && w.rec) {
          // Against the aim the caster's spell really flies along (third person: the crosshair's
          // convergence, `conv` degrees off their camera look; CR 022 sends it in the frame).
          const ay = c.rec.aim.yaw;
          const ap = c.rec.aim.pitch;
          seen.aimErr.push(Math.hypot(wrap(w.rec.aim.yaw - ay), w.rec.aim.pitch - ap) * DEG);
          if (w.view) seen.lookErr.push(Math.hypot(wrap(w.view.yaw - ay), w.view.pitch - ap) * DEG);
          if (c.look.yaw !== null && c.look.pitch !== null) seen.conv.push(Math.hypot(wrap(ay - c.look.yaw), ap - c.look.pitch) * DEG);
          if (seen.raw.length < 6) seen.raw.push({ casterAim: c.rec.aim, casterLook: c.look, watcherRec: w.rec, watcherView: w.view ? { yaw: w.view.yaw, pitch: w.view.pitch } : null });
        }
        if (c.rec?.dash || w.rec?.dash) seen.variants.add(`${c.rec?.dash?.variant ?? '-'}/${w.rec?.dash?.variant ?? '-'}`);
        seen.heldN++;
        if ((c.rec?.held?.kind ?? null) === (w.rec?.held?.kind ?? null)) seen.heldMatch++;
        await sleep(40);
      }
      const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
      return {
        caster: { actions: [...seen.caster.actions], held: [...seen.caster.held], dashHold: seen.caster.dashHold, bodyPitchMin: +seen.caster.pitchMin.toFixed(2) },
        watcher: { actions: [...seen.watcher.actions], held: [...seen.watcher.held], dashHold: seen.watcher.dashHold, bodyPitchMin: +seen.watcher.pitchMin.toFixed(2) },
        aimErrDegMedian: med(seen.aimErr),
        drawnLookErrDegMedian: med(seen.lookErr),
        aimErrDegFinal: seen.aimErr.length ? +seen.aimErr[seen.aimErr.length - 1].toFixed(3) : null,
        drawnLookErrDegFinal: seen.lookErr.length ? +seen.lookErr[seen.lookErr.length - 1].toFixed(3) : null,
        thirdPersonConvergenceDeg: med(seen.conv),
        heldStateAgreement: seen.heldN ? +(seen.heldMatch / seen.heldN).toFixed(2) : null,
        dashVariants: [...seen.variants],
        raw: seen.raw,
      };
    };

    const shots: Record<string, { label: string; png: Buffer }[]> = {};
    /** Both screenshots at once, then the parity sample (in parallel with nothing else). */
    const capture = async (group: string, key: string, label: string, sampleMs = 900, frame = true, leadS = 0) => {
      if (frame) await frameWatcher(!leadS, leadS);
      const sampling = sample(sampleMs);
      await sleep(Math.min(250, sampleMs / 3));
      const [a, b] = await Promise.all([caster.screenshot(), watcher.screenshot()]);
      (shots[group] ??= []).push({ label: `${label}: the caster (third person, what they see)`, png: a });
      (shots[group] ??= []).push({ label: `${label}: another player`, png: b });
      const s = await sampling;
      const row = { key, label, ...s, poseMatch: s.caster.actions.some((x) => s.watcher.actions.includes(x)) || (s.caster.actions.length === 0 && s.watcher.actions.length === 0), heldPoseMatch: s.caster.held.join() === s.watcher.held.join() };
      report.rows.push(row);
      console.log(key.padEnd(18), JSON.stringify({ c: s.caster.actions, w: s.watcher.actions, ch: s.caster.held, wh: s.watcher.held, aim: s.aimErrDegMedian, look: s.drawnLookErrDegMedian, aimEnd: s.aimErrDegFinal, lookEnd: s.drawnLookErrDegFinal, conv: s.thirdPersonConvergenceDeg, v: s.dashVariants, dash: [s.caster.dashHold, s.watcher.dashHold] }));
    };

    // ---------------- casts ----------------
    await equipWeapon('sword');
    for (const [key, weapon, label, wait, extra] of [
      ['ember_flick', 'sword', 'cast: Ember Flick from the open off hand (sword)', 120, 0],
      ['ember_flick', 'staff', 'castStaff: Ember Flick from the staff tip', 120, 0],
      ['eruption', 'staff', 'castBig: Eruption (windup sigil at the aim point)', 300, 0],
      ['ice_wall', 'staff', 'shield: Ice Wall (the shell others see)', 300, 0],
      ['wraith_hound', 'staff', 'summon: Wraith Hound (flourish at the hand, the ally)', 900, 0],
      ['guiding_motes', 'staff', 'homing: Guiding Motes aimed 35 deg off, curving in', 250, 0.6],
      ['pyre_brand', 'staff', 'brand: Pyre Brand fan', 200, 0],
    ] as const) {
      if (!on(key)) continue;
      if (weapon !== (await caster.evaluate(() => (window as unknown as W).__lodestoneCombat!.hud().loadouts[(window as unknown as W).__lodestoneCombat!.hud().activeLoadout].weapon))) await equipWeapon(weapon);
      await equipSpell(key);
      await waitMana(COMBAT.spells.find((s) => s.key === key)!.mana + 5);
      await drink();
      await aim(extra, key === 'ice_wall' || key === 'wraith_hound' ? -0.25 : 0.02);
      await frameWatcher();
      await press(0);
      await capture('casts', key, label, 900, false);
      await sleep(wait);
    }
    // castBeam: Cauterize, turning while it burns (the beam follows the caster's aim for everyone)
    if (on('cauterize')) {
    await equipSpell('cauterize');
    await waitMana(40);
    await aim(-0.25, 0);
    await frameWatcher();
    await press(0);
    await sleep(250);
    for (let i = 0; i < 8; i++) {
      const p = (await me(caster)).pos;
      const t = await target();
      if (t) await look(caster, yawTo(p, t) - 0.25 + i * 0.06, -0.02);
      await sleep(60);
    }
    await capture('casts', 'cauterize', 'castBeam: Cauterize, turning while it burns', 900, false);
    await sleep(1200);
    }

    // ---------------- channels ----------------
    for (const [key, label, pitch, sweep] of [
      ['cinder_spray', 'stream: Cinder Spray held, sweeping', 0.02, true],
      ['arc_sparks', 'stream: Arc Sparks held', 0.02, false],
      ['starfall_hail', 'rain: Starfall Hail held (seeded points around the aim)', -0.05, false],
    ] as const) {
      if (!on(key)) continue;
      await equipSpell(key);
      await waitMana(70);
      await drink();
      await aim(sweep ? -0.3 : 0, pitch);
      await frameWatcher();
      await holdSlot(0, true);
      await sleep(400);
      if (sweep) {
        for (let i = 0; i < 6; i++) {
          const p = (await me(caster)).pos;
          const t = await target();
          if (t) await look(caster, yawTo(p, t) - 0.3 + i * 0.1, pitch);
          await sleep(80);
        }
      }
      await capture('channels', key, label, 1000, false);
      await holdSlot(0, false);
      await sleep(900);
    }
    if (on('boulder_heave')) {
    await equipSpell('boulder_heave');
    await waitMana(40);
    await aim(0, 0.12);
    await frameWatcher();
    await holdSlot(0, true);
    await sleep(700);
    await capture('channels', 'boulder_heave', 'charge: Boulder Heave gathering (held)', 600, false);
    await holdSlot(0, false);
    await sleep(150);
    await capture('channels', 'boulder_heave_release', 'charge: Boulder Heave released', 600, false);
    await equipSpell('whirling_blades');
    await waitMana(40);
    await aim(0, -0.3);
    await frameWatcher();
    await press(0);
    await sleep(500);
    await capture('channels', 'whirling_blades', 'orbit: Whirling Blades', 800, false);
    await sleep(800);
    }

    // ---------------- dashes ----------------
    const dashes: [string, number, string][] = [
      ['magma_dash', 1.1, 'Magma Dash held: jet flight (climbing)'],
      ['glacier_step', 0, 'Glacier Step held: skate'],
      ['static_step', 0, 'Static Step held: blink chain'],
      ['root_launch', 0, 'Root Launch held'],
      ['updraft', 0.2, 'Updraft held: soar'],
      ['sunstep', 0, 'Sunstep held: radiant trail'],
      ['skip', 0, 'Skip held: phase'],
      ['phase_slip', 0, 'Phase Slip held: blood dash'],
    ];
    for (const [key, pitch, label] of dashes) {
      if (!on(key)) continue;
      await equipSpell(key, 3);
      await waitMana(50);
      await drink();
      // Always through the start point and past it (the dashes cover 30-40 m): the caster stays
      // well inside the watcher's 64 m, crossing their view.
      const c0 = (await me(caster)).pos;
      const mid = { x: home.x + 14, z: home.z + 4 };
      const away = Math.hypot(mid.x - c0.x, mid.z - c0.z) > 6 ? mid : { x: mid.x + (c0.x > mid.x ? -30 : 30), z: mid.z };
      await look(caster, yawTo(c0, away), pitch);
      await holdCast(3, true);
      await press(3);
      await sleep(key === 'magma_dash' ? 500 : 380);
      if (key === 'magma_dash') await look(caster, yawTo(c0, away), 0.25);
      await capture('dashes', key, label, 500, true, 0.3);
      await holdCast(3, false);
      await sleep(key === 'magma_dash' || key === 'updraft' ? 2600 : 1400);
    }

    // ---------------- weapons ----------------
    for (const [weapon, label] of [
      ['sword', 'sword: slash (arc in the world for both)'],
      ['spear', 'spear: thrust'],
      ['staff', 'staff: bolt'],
      ['wand', 'wand: jab'],
    ] as const) {
      if (!on(`${weapon}_attack`)) continue;
      await equipWeapon(weapon);
      await aim(0, 0.02);
      await frameWatcher();
      await press('attack');
      await capture('weapons', `${weapon}_attack`, label, 700, false);
      await sleep(500);
    }
    // the guards: sword parry, spear charge, bow draw held past the old 3 s time-out, then the release
    for (const [weapon, holdMs, label] of [
      ['sword', 400, 'sword: parry stance (held)'],
      ['spear', 1500, 'spear: charge (held)'],
      ['bow', 3600, 'bow: draw held 3.6 s'],
    ] as const) {
      if (!on(`${weapon}_guard`)) continue;
      await equipWeapon(weapon);
      await aim(0, 0.02);
      await frameWatcher();
      await press('alt');
      await sleep(Math.max(0, holdMs - 400));
      await capture('weapons', `${weapon}_guard`, label, 600, false);
      await press('altRelease');
      await capture('weapons', `${weapon}_release`, `${weapon}: released`, 700, false);
      await sleep(400);
    }

    if (ONLY) {
      fs.writeFileSync(path.join(process.env.SHARED_FX_DEBUG_DIR ?? repoRoot, 'shared-fx-debug.json'), JSON.stringify(report, null, 1));
      return;
    }
    const t = `two players on a private zone (CR 022 shared spell visuals${TAG ? `, ${TAG}` : ''}): left the caster's own view in third person, right another player 11 m away`;
    await sheet(browser, path.join(out, `pt2-shared-fx-casts${TAG}.jpg`), `Casts, shields, summons, homing, brands, beams: ${t}`, shots.casts ?? []);
    await sheet(browser, path.join(out, `pt2-shared-fx-channels${TAG}.jpg`), `Streams, rain, charges, orbits: ${t}`, shots.channels ?? []);
    await sheet(browser, path.join(out, `pt2-shared-fx-dashes${TAG}.jpg`), `Held dashes per element: ${t}`, shots.dashes ?? []);
    await sheet(browser, path.join(out, `pt2-shared-fx-weapons${TAG}.jpg`), `Weapon swings and guards: ${t}`, shots.weapons ?? []);
    const rows = report.rows as { key: string; poseMatch: boolean; heldPoseMatch: boolean; aimErrDegMedian: number | null; drawnLookErrDegMedian: number | null; aimErrDegFinal: number | null; drawnLookErrDegFinal: number | null; thirdPersonConvergenceDeg: number | null; heldStateAgreement: number | null }[];
    report.summary = {
      sharedStateBuild: shared,
      rows: rows.length,
      poseMatch: rows.filter((r) => r.poseMatch).length,
      heldPoseMatch: rows.filter((r) => r.heldPoseMatch).length,
      aimErrDegMedianByKey: Object.fromEntries(rows.filter((r) => r.aimErrDegMedian !== null).map((r) => [r.key, { replicated: r.aimErrDegMedian, drawnLook: r.drawnLookErrDegMedian, replicatedFinal: r.aimErrDegFinal, drawnLookFinal: r.drawnLookErrDegFinal, thirdPersonConvergence: r.thirdPersonConvergenceDeg }])),
    };
    fs.writeFileSync(path.join(out, `pt2-shared-fx-run${TAG}.json`), JSON.stringify(report, null, 1) + '\n');
    console.log(JSON.stringify(report.summary));
  } finally {
    await browser?.close();
    zone?.proc.kill();
    vite.kill();
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
