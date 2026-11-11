/* global document, getComputedStyle */
// Helpers for coop-driver.mjs (re-imported on every command). Each takes a
// Playwright page; the pages carry __who ('A' or 'B'). Honest play: keys,
// mouse, the look handle (headless has no pointer lock). The dev console
// (run) only for travel or retries, and every use is logged.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { walkTo, go, pl, look, yawTo, sleep, BASE } from './lib.mjs';

export { sleep, pl, look, yawTo };
export const OUT = 'tmp/coop';

// ---- keep the local profiles across driver restarts ----
export async function saveProfile(page) {
  const p = await page.evaluate(async () => {
    const { SaveStore } = await import('/src/account/saveStore.ts');
    const s = await SaveStore.open();
    return s.getProfile();
  });
  if (p) writeFileSync(`${OUT}/profile-${page.__who}.json`, JSON.stringify(p));
  return !!p;
}
/** Log back in to an existing character (the saved local profile). */
export async function login(page, name) {
  const f = `${OUT}/profile-${page.__who}.json`;
  await page.goto(BASE + '/');
  if (existsSync(f)) {
    const prof = JSON.parse(readFileSync(f, 'utf8'));
    await page.evaluate(async (p) => {
      const { SaveStore } = await import('/src/account/saveStore.ts');
      const s = await SaveStore.open();
      await s.putProfile(p);
    }, prof);
    await page.goto(BASE + '/');
  }
  await page.getByTestId('play').click({ timeout: 5000 }).catch(() => {});
  await page.getByTestId('account-screen').waitFor({ timeout: 120000 });
  await page.getByTestId('auth-local').click();
  await page.getByTestId(`play-${name}`).click({ timeout: 60000 });
  await page.waitForFunction(() => window.__lodestone?.netDebug?.()?.phase === 'playing', null, { timeout: 120000 });
}
/** Abort long loops (set by the driver's /abort or a command). */
export const aborted = () => !!globalThis.__coopAbort;

export async function newChar(page, name) {
  await page.goto(BASE + '/');
  await page.getByTestId('play').click({ timeout: 5000 }).catch(() => {});
  await page.getByTestId('account-screen').waitFor({ timeout: 120000 });
  await page.getByTestId('auth-local').click();
  await page.getByTestId('char-name').waitFor({ timeout: 30000 });
  await page.getByTestId('char-name').fill(name);
  await page.getByTestId('char-create').click();
  await page.getByTestId(`play-${name}`).click();
  await page.waitForFunction(() => window.__lodestone?.netDebug?.()?.phase === 'playing', null, { timeout: 120000 });
}

export async function dismiss(page) {
  for (const id of ['whatsnew-close']) {
    const b = page.getByTestId(id);
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
  }
  const got = page.locator('button', { hasText: /^Got it$/ });
  if (await got.first().isVisible().catch(() => false)) {
    await got.first().click({ timeout: 2000 }).catch(() => {});
    if (await got.first().isVisible().catch(() => false)) await page.keyboard.press('Escape');
  }
  // A quest offer card: "Not now" (a player reads it and declines side work mid-story).
  const off = page.locator('[data-testid="quest-offer"] button', { hasText: 'Not now' });
  if (await off.isVisible().catch(() => false)) {
    const title = await page.evaluate(() => document.querySelector('[data-testid="quest-offer"]')?.innerText?.split('\n').slice(0, 2).join(' ') ?? '');
    await off.click().catch(() => {});
    (globalThis.__coopOffers ??= []).push(`${page.__who}: ${title}`);
  }
}

/** Dev console line (logged by the caller as a dev shortcut). */
export const run = (page, line) => page.evaluate((l) => window.__lodestoneDev.run(l), line);

export async function shot(page, name) {
  mkdirSync(`${OUT}/shots`, { recursive: true });
  const f = `${OUT}/shots/${name}.jpg`;
  await page.screenshot({ path: f, type: 'jpeg', quality: 55 });
  return f;
}

/** What the player can see right now: compact. */
export async function snap(page) {
  return page.evaluate(() => {
    const L = window.__lodestone;
    const p = L.player();
    const c = window.__lodestoneCombat?.hud?.() ?? {};
    const q = window.__lodestoneQuests?.tracked?.();
    const st = window.__lodestoneStory?.state?.();
    const pr = window.__lodestoneProgression?.state?.();
    const vis = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return '';
      const cs = getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden' ? '' : (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    };
    const prompts = ['town-prompt', 'content-prompt', 'loot-prompt', 'camp-prompt', 'steed-prompt', 'revive-prompt', 'revive-self', 'tower-prompt', 'attune-prompt'].map((id) => vis(`[data-testid="${id}"]`)).filter(Boolean);
    return {
      pos: { x: Math.round(p.pos.x), y: Math.round(p.pos.y), z: Math.round(p.pos.z) },
      mode: p.mode,
      hp: (() => { const h = L.selfHealth(); return h ? `${h.health}/${h.healthMax}` : '?'; })(),
      mana: Math.round(c.mana),
      sta: Math.round(p.stamina),
      lvl: pr?.stats?.level ?? c.level,
      xp: pr?.stats ? `${pr.stats.xpInto}/${pr.stats.xpNext}` : '',
      sp: pr?.stats?.skillFree,
      down: c.downedUntil > 0,
      boss: c.boss ? `${c.boss.name} ${Math.round((c.boss.healthPct ?? 0) * 100) / 100}` : '',
      area: pr?.area ? `L${pr.area.level}` : '',
      q: q ? { t: q.title, s: q.step, txt: q.text, prog: q.need ? `${q.progress}/${q.need}` : '', m: (q.markers ?? []).slice(0, 4).map((m) => ({ l: m.label, x: Math.round(m.x), z: Math.round(m.z), d: Math.round(Math.hypot(m.x - p.pos.x, m.z - p.pos.z)) })) } : null,
      story: st?.sync ? { act: st.sync.act, step: st.sync.step, beaten: st.sync.beaten, party: (st.party?.members ?? []).map((m) => `${m.name}:${m.act}.${m.step}`) } : null,
      prompts,
      toast: c.toast?.text ?? '',
    };
  });
}

export async function status(A, B) {
  const [a, b] = await Promise.all([snap(A), snap(B)]);
  return { A: a, B: b };
}

export async function drawn(page, r = 60) {
  return page.evaluate((rr) => {
    const me = window.__lodestone.player().pos;
    return (window.__lodestoneDrawn?.() ?? [])
      .map((e) => ({ id: e.id, kind: e.kind, name: e.name, lvl: e.level, x: Math.round(e.x * 10) / 10, y: Math.round(e.y * 10) / 10, z: Math.round(e.z * 10) / 10, hp: e.healthPct, d: Math.round(Math.hypot(e.x - me.x, e.z - me.z) * 10) / 10 }))
      .filter((e) => e.d < rr)
      .sort((a, b) => a.d - b.d);
  }, r);
}

/** Walk (streets in a town, else straight), sprinting. */
export async function walk(page, x, z, opts = {}) {
  const o = { stopAt: 2, timeoutMs: 120000, sprint: true, ...opts };
  return opts.straight ? walkTo(page, x, z, o) : nav(page, x, z, o);
}
export async function walkBoth(A, B, x, z, opts = {}) {
  const [a, b] = await Promise.all([walk(A, x, z, opts), walk(B, x + 2, z + 1.5, opts)]);
  return { A: { ok: a.ok, d: Math.round(a.d), s: Math.round(a.ms / 1000) }, B: { ok: b.ok, d: Math.round(b.d), s: Math.round(b.ms / 1000) } };
}

/** Release every held key (after an interrupted command). */
export async function release(page) {
  for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'KeyE', 'Space']) await page.keyboard.up(k).catch(() => {});
  await page.mouse.up().catch(() => {});
}

async function faceAt(page, e) {
  const me = (await pl(page)).pos;
  const d = Math.max(0.5, Math.hypot(e.x - me.x, e.z - me.z));
  await look(page, yawTo(me, e.x, e.z), Math.max(-0.6, Math.min(0.5, Math.atan2(e.y + 1.0 - (me.y + 1.6), d))));
}

/** Talk to the townsperson nearest (x, z): walk up, face them, E, click any accept/hand-in button, close. */
export async function talk(page, x, z, { name = '' } = {}) {
  await walk(page, x, z, { stopAt: 3, timeoutMs: 60000 });
  let npc = (await drawn(page, 25)).filter((e) => e.kind === 5 && (!name || e.name.includes(name))).sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
  if (npc && npc.d > 2.4) {
    await walk(page, npc.x, npc.z, { stopAt: 1.8, timeoutMs: 20000 });
    npc = (await drawn(page, 25)).find((e) => e.id === npc.id) ?? npc;
  }
  await dismiss(page);
  // Aim until the town's target is them (a person nudges the mouse until the prompt names them).
  for (let k = 0; npc && k < 10; k++) {
    npc = (await drawn(page, 25)).find((e) => e.id === npc.id) ?? npc;
    if (k >= 3 && npc.d < 1.4) {
      await page.keyboard.down('KeyS');
      await sleep(250);
      await page.keyboard.up('KeyS');
    } else if (k >= 3 && npc.d > 2.6) await walk(page, npc.x, npc.z, { stopAt: 1.8, timeoutMs: 8000, straight: true });
    await faceAt(page, { ...npc, y: npc.y + 0.3 - (k % 3) * 0.25 });
    await sleep(300);
    const tg = await page.evaluate(() => window.__lodestoneTowns?.target?.() ?? null);
    if (tg?.kind === 'npc' && (!name || tg.name?.includes(name))) break;
  }
  const prompt = await page.evaluate(() => document.querySelector('[data-testid="town-prompt"]')?.textContent ?? '');
  await page.keyboard.press('KeyE');
  await sleep(1200);
  const panel = await page.evaluate(() => document.querySelector('[data-testid="town-panel"]')?.innerText ?? '');
  const clicked = [];
  for (const label of ['Accept', 'Hand in', 'Complete', 'Turn in', 'Give']) {
    const b = page.locator('[data-testid="town-panel"] button', { hasText: label }).first();
    if (await b.count().catch(() => 0)) {
      await b.click().catch(() => {});
      clicked.push(label);
      await sleep(500);
    }
  }
  return { npc: npc ? `${npc.name} (${npc.d} m)` : null, prompt, panel: panel.slice(0, 900).replace(/\n+/g, ' | '), clicked };
}

export async function closePanels(page) {
  await page.evaluate(() => {
    for (let i = 0; i < 5 && window.__lodestonePanels?.top(); i++) window.__lodestonePanels.closeTop();
  });
}

/** Read the visible panel text (town panel, loot, dialog...). */
export async function panelText(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-testid$="-panel"], [data-testid$="-dialog"], [role="dialog"]')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      out.push(`${el.dataset.testid}: ${(el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 600)}`);
    }
    return out;
  });
}

const HOSTILE = (e) => (e.kind === 2 || e.kind === 6) && e.hp > 0;

/**
 * Fight what is near like a player: face the nearest hostile, close in,
 * left-click the weapon; cast the spell slots in `spells` (e.g. ['Digit1'])
 * every few swings when there is mana; drink a draught (R) under 35 %
 * health; dodge (F) now and then. Stops when nothing hostile is within r
 * of the anchor for 3 s, or after ms. Returns kills, hits, low health.
 */
export async function fight(page, { x, z, r = 30, ms = 90000, spells = ['Digit1'], melee = 2.6, keepRange = 0, onlyIds = null, partner = null, dodge = false } = {}) {
  const t0 = Date.now();
  let quiet = 0;
  let swings = 0;
  let kills = 0;
  let lowHp = 1;
  let draughts = 0;
  let downs = 0;
  let lastDraught = 0;
  let lastTell = Date.now();
  let dodges = 0;
  let lastD = null;
  const seen = new Set();
  let lastId = -1;
  const anchor = async () => (x === undefined ? (await pl(page)).pos : { x, z });
  while (Date.now() - t0 < ms && !aborted()) {
    if (swings % 10 === 0) await dismiss(page);
    // A wind-up aimed at me (EvTelegraph 204): dodge back out of it, as a player reads the tell.
    if (dodge) {
      const tell = await page.evaluate((since) => { const me = window.__lodestoneStory?.state?.().self; const t = window.__lodestone.tapped([204], since); return me ? t.events.filter((e) => e.targetId === me).length : 0; }, lastTell);
      lastTell = Date.now();
      if (tell > 0) {
        await page.keyboard.down('KeyS');
        await page.keyboard.press('KeyF');
        await sleep(350);
        await page.keyboard.up('KeyS');
        dodges++;
      }
    }
    // A fallen friend nearby (waiting to be raised): go and hold E beside them.
    if (partner && swings % 3 === 0) {
      const down = await partner.evaluate(() => { const st = window.__lodestoneStory?.state?.(); const h = window.__lodestone.selfHealth(); return h && h.health <= 0 && st && st.reviveUntil > performance.now() ? window.__lodestone.player().pos : null; });
      if (down) {
        await walkTo(page, down.x + 0.8, down.z, { stopAt: 1.0, timeoutMs: 8000 });
        const prompt = await page.evaluate(() => document.querySelector('[data-testid="revive-prompt"]')?.innerText ?? '');
        await page.keyboard.down('KeyE');
        await sleep(3500);
        await page.keyboard.up('KeyE');
        await sleep(500);
        const ok = await partner.evaluate(() => (window.__lodestone.selfHealth()?.health ?? 0) > 0);
        (globalThis.__coopRevives ??= []).push(`${new Date().toISOString().slice(11, 19)} ${page.__who} raised ${partner.__who}: ${ok} ("${prompt}")`);
      }
    }
    const s = await page.evaluate(() => {
      const c = window.__lodestoneCombat.hud();
      const h = window.__lodestone.selfHealth() ?? { health: 1, healthMax: 1 }; // the HUD bar's source (SelfState)
      return { hp: h.health / Math.max(1, h.healthMax), mana: c.mana, down: c.downedUntil > 0 || h.health <= 0 };
    });
    if (s.down) {
      downs++;
      return { kills, swings, lowHp: 0, draughts, downs, ms: Date.now() - t0, seen: seen.size, downed: true };
    }
    lowHp = Math.min(lowHp, s.hp);
    if (s.hp < 0.45 && draughts < 8 && Date.now() - lastDraught > 2500) {
      await page.keyboard.press('KeyR');
      draughts++;
      lastDraught = Date.now();
    }
    const a = await anchor();
    const es = (await drawn(page, 80)).filter((e) => HOSTILE(e) && Math.hypot(e.x - a.x, e.z - a.z) < r && (!onlyIds || onlyIds.includes(e.id)));
    if (!es.length) {
      if (++quiet > 12) break;
      await sleep(250);
      continue;
    }
    quiet = 0;
    const e = es[0];
    if (lastId !== -1 && lastId !== e.id && !es.some((q) => q.id === lastId)) kills++;
    lastId = e.id;
    seen.add(e.id);
    await faceAt(page, e);
    const myY = (await pl(page)).pos.y;
    const dy = e.y - myY;
    if (Math.abs(dy) > 1.4 && e.d < 6) {
      // On a ledge above (or below) it: step off toward it, casting meanwhile.
      if (s.mana > 15) await page.keyboard.press(spells[swings % spells.length]);
      await page.keyboard.down('KeyW');
      if (dy > 1.4) await page.keyboard.press('Space');
      await sleep(450);
      await page.keyboard.up('KeyW');
      swings++;
      continue;
    }
    // Big bodies (sentinels, golems, bosses) stop you before 2.6 m: when a step closer
    // gains nothing, you are as close as you get, so swing.
    const blocked = lastD !== null && lastId === e.id && lastD - e.d < 0.15 && e.d < 7;
    lastD = e.d;
    if (e.d > melee + (keepRange || 0) && !blocked) {
      await page.keyboard.down('KeyW');
      await sleep(Math.min(500, (e.d - melee) * 150));
      await page.keyboard.up('KeyW');
      if (keepRange && spells.length && swings % 2 === 0) await page.keyboard.press(spells[swings % spells.length]);
      swings++;
      continue;
    }
    swings++;
    if (spells.length && swings % 4 === 0 && s.mana > 20) {
      await page.keyboard.press(spells[(swings / 4) % spells.length | 0]);
      await sleep(350);
    } else {
      await page.mouse.down();
      await sleep(60);
      await page.mouse.up();
      await sleep(320);
    }
    if (swings % 23 === 0) await page.keyboard.press('KeyF');
  }
  return { kills, swings, lowHp: Math.round(lowHp * 100), draughts, downs, ms: Date.now() - t0, seen: seen.size };
}

/** Both fight around the same anchor. */
export async function fightBoth(A, B, o = {}) {
  const [a, b] = await Promise.all([fight(A, { ...o, partner: B }), fight(B, { ...o, partner: A })]);
  return { A: a, B: b };
}

/** Hold E for ms (interact / attune / revive). */
export async function holdE(page, ms = 600) {
  await page.keyboard.down('KeyE');
  await sleep(ms);
  await page.keyboard.up('KeyE');
}

export async function towers(page) {
  return page.evaluate(() => window.__lodestoneMap.towers());
}

/** Climb a tower like g3: face the axis, W into the wall, rest on the ledge, mantle. */
export async function climb(page, tower, { maxMs = 240000 } = {}) {
  const t0 = Date.now();
  const until = async (fn, arg, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await page.evaluate(fn, arg)) return true;
      if (Date.now() > end) return false;
      await sleep(150);
    }
  };
  const aim = async () => {
    const p = (await pl(page)).pos;
    await look(page, yawTo(p, tower.x, tower.z), 0.45);
  };
  const logs = [];
  for (let attempt = 1; attempt <= 3 && Date.now() - t0 < maxMs; attempt++) {
    // Night hunters at the foot of a tower: deal with them before climbing.
    const f = await fight(page, { r: 22, ms: 60000, spells: ['Digit1', 'Digit4'] });
    if (f.seen) logs.push(`fought ${f.seen} at the foot (low ${f.lowHp}%)`);
    if (f.downed) return { ok: false, logs: [...logs, 'downed at the foot'] };
    await aim();
    await until(() => window.__lodestone.player().stamina >= 99 && !window.__lodestone.player().exhausted, 0, 60000);
    await page.keyboard.down('KeyW');
    try {
      if (!(await until(() => window.__lodestone.player().mode === 'climb', 0, 20000))) {
        logs.push('never started climbing');
        await page.keyboard.press('Space');
        continue;
      }
      await until(([ledgeY]) => {
        const p = window.__lodestone.player();
        return (p.mode !== 'climb' && p.mode !== 'air' && p.pos.y > ledgeY - 1.5) || (p.mode !== 'climb' && p.pos.y < ledgeY - 8 && p.mode !== 'air');
      }, [tower.topY - 13], 120000);
    } finally {
      await page.keyboard.up('KeyW');
    }
    let p = await pl(page);
    if (p.pos.y < tower.topY - 14.5) {
      logs.push(`fell to ${p.pos.y.toFixed(1)} (stamina ${p.stamina.toFixed(0)})`);
      continue;
    }
    if (p.pos.y < tower.topY - 0.5) {
      logs.push(`ledge ${p.pos.y.toFixed(1)}, resting`);
      await until(() => window.__lodestone.player().stamina >= 99, 0, 60000);
      await aim();
      await page.keyboard.down('KeyW');
      try {
        await until((top) => {
          const q = window.__lodestone.player();
          return q.mode !== 'climb' && q.mode !== 'air' && q.pos.y >= top - 0.05;
        }, tower.topY, 120000);
        await sleep(600);
      } finally {
        await page.keyboard.up('KeyW');
      }
      p = await pl(page);
    }
    logs.push(`top y ${p.pos.y.toFixed(1)} after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    return { ok: p.pos.y >= tower.topY - 1, logs };
  }
  return { ok: false, logs };
}

/** Walk to the crystal on top (tower centre) and press E. */
export async function attune(page, tower) {
  await walk(page, tower.x, tower.z, { stopAt: 1.2, timeoutMs: 15000, sprint: false });
  await sleep(400);
  const before = await page.evaluate(() => [...document.querySelectorAll('[data-testid]')].filter((e) => /attune|crystal|tower/i.test(e.dataset.testid)).map((e) => `${e.dataset.testid}: ${e.innerText.slice(0, 80)}`));
  await holdE(page, 400);
  await sleep(1500);
  return before;
}

/** Visible HUD text (cards, toasts, prompts) for clarity notes. */
export async function hudText(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-testid]')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0 || cs.position !== 'fixed') continue;
      const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (t && t.length < 400) out.push(`${el.dataset.testid}: ${t.slice(0, 200)}`);
    }
    return out;
  });
}

// ---- town-aware walking: the nearest town's street graph (cached per town), followed with a lookahead ----
const GRAPHS = (globalThis.__coopGraphs ??= new Map());
async function nearestTown(page, x, z) {
  return page.evaluate(([qx, qz]) => {
    const T = window.__lodestoneTowns;
    if (!T) return null;
    const s = T.settlements().map((t) => ({ ...t, d: Math.hypot(t.x - qx, t.z - qz) })).sort((a, b) => a.d - b.d)[0];
    return s ? { index: s.index, name: s.name, x: s.x, z: s.z, radius: s.radius, square: s.square, d: s.d } : null;
  }, [x, z]);
}
async function townGraph(page, town) {
  if (GRAPHS.has(town.index)) return GRAPHS.get(town.index);
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
      const [ax, az, bx, bz] = [p[i], p[i + 2], p[i + 3], p[i + 5]];
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
  const g = { nodes, adj, town };
  GRAPHS.set(town.index, g);
  return g;
}
function route(g, from, to) {
  const near = (p) => g.nodes.reduce((best, n, i) => (Math.hypot(n.x - p.x, n.z - p.z) < Math.hypot(g.nodes[best].x - p.x, g.nodes[best].z - p.z) ? i : best), 0);
  const s = near(from);
  const t = near(to);
  const dist = new Array(g.nodes.length).fill(Infinity);
  const prev = new Array(g.nodes.length).fill(-1);
  dist[s] = 0;
  const done = new Uint8Array(g.nodes.length);
  for (;;) {
    let u = -1;
    for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === t) break;
    done[u] = 1;
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

/** Follow points holding W (and Shift), aiming at the next point ~4 m ahead; jump/strafe when stuck. */
export async function follow(page, pts, { stopAt = 2, timeoutMs = 180000, sprint = true, fightBack = true } = {}) {
  const t0 = Date.now();
  let lastScan = 0;
  const fights = [];
  let i = 0;
  let last = null;
  let stuck = 0;
  let unstick = 0;
  await page.keyboard.down('KeyW');
  if (sprint) await page.keyboard.down('ShiftLeft');
  try {
    for (;;) {
      const p = (await pl(page)).pos;
      const end = pts[pts.length - 1];
      const dEnd = Math.hypot(end.x - p.x, end.z - p.z);
      if (dEnd <= stopAt) return { ok: true, d: dEnd, ms: Date.now() - t0, p, fights };
      if (Date.now() - t0 > timeoutMs || aborted()) return { ok: false, d: dEnd, ms: Date.now() - t0, p };
      // Something attacking? Stop and fight it (a player would), then go on.
      if (fightBack && Date.now() - lastScan > 1000) {
        lastScan = Date.now();
        const near = (await drawn(page, 14)).some((e) => (e.kind === 2 || e.kind === 6) && e.hp > 0);
        if (near) {
          await page.keyboard.up('KeyW');
          if (sprint) await page.keyboard.up('ShiftLeft');
          const f = await fight(page, { r: 18, ms: 90000, spells: ['Digit1', 'Digit4', 'Digit2'] });
          fights.push(f.seen);
          if (f.downed) return { ok: false, d: dEnd, ms: Date.now() - t0, p, downed: true, fights };
          await page.keyboard.down('KeyW');
          if (sprint) await page.keyboard.down('ShiftLeft');
        }
      }
      // advance past points already close
      while (i < pts.length - 1 && Math.hypot(pts[i].x - p.x, pts[i].z - p.z) < 4) i++;
      const tgt = pts[i];
      await look(page, yawTo(p, tgt.x, tgt.z), 0);
      if (last && Math.hypot(p.x - last.x, p.z - last.z) < 0.04) stuck++;
      else stuck = Math.max(0, stuck - 1);
      if (stuck > 8) {
        unstick++;
        const k = unstick % 2 ? 'KeyA' : 'KeyD';
        if (unstick % 3 === 0) {
          // back off, then sidestep: a wall or a doorway frame
          await page.keyboard.up('KeyW');
          await page.keyboard.down('KeyS');
          await sleep(700);
          await page.keyboard.up('KeyS');
          await page.keyboard.down(k);
          await sleep(900);
          await page.keyboard.up(k);
          await page.keyboard.down('KeyW');
        } else {
          await page.keyboard.down(k);
          await page.keyboard.press('Space');
          await sleep(500 + 150 * (unstick % 4));
          await page.keyboard.up(k);
        }
        if (unstick % 4 === 0 && i < pts.length - 1) i++;
        stuck = 0;
      }
      last = p;
      await sleep(100);
    }
  } finally {
    await page.keyboard.up('KeyW');
    if (sprint) await page.keyboard.up('ShiftLeft');
  }
}

/** Walk to (x, z): through a town's streets when either end is inside one, else straight. */
/** Building footprints (OBBs, padded) of towns near a segment. */
async function obstacles(page, ax, az, bx, bz) {
  return page.evaluate(([ax, az, bx, bz]) => {
    const T = window.__lodestoneTowns;
    if (!T) return [];
    const out = [];
    for (const s of T.settlements()) {
      // distance from the town centre to the segment
      const dx = bx - ax, dz = bz - az;
      const L = Math.max(1e-6, dx * dx + dz * dz);
      const t = Math.max(0, Math.min(1, ((s.x - ax) * dx + (s.z - az) * dz) / L));
      const d = Math.hypot(ax + dx * t - s.x, az + dz * t - s.z);
      if (d > s.radius + 40) continue;
      if (T.solids) out.push(...T.solids(s.index));
      else for (const b of T.buildings(s.index)) out.push([b.x, b.z, b.c, b.s, b.hx, b.hz]);
    }
    return out;
  }, [ax, az, bx, bz]);
}

/** A* on a 1 m grid around building footprints, then string-pulled. Null when no town is near. */
function gridPath(obs, from, to, pad = 0.7) {
  if (!obs.length) return null;
  const m = 40;
  const x0 = Math.floor(Math.min(from.x, to.x) - m), z0 = Math.floor(Math.min(from.z, to.z) - m);
  const W = Math.ceil(Math.max(from.x, to.x) + m) - x0, H = Math.ceil(Math.max(from.z, to.z) + m) - z0;
  if (W * H > 1.6e6) return null;
  const blocked = new Uint8Array(W * H);
  for (const [bx, bz, c, s, hx, hz] of obs) {
    const r = Math.hypot(hx, hz) + pad + 1;
    for (let gz = Math.max(0, Math.floor(bz - r - z0)); gz < Math.min(H, Math.ceil(bz + r - z0)); gz++)
      for (let gx = Math.max(0, Math.floor(bx - r - x0)); gx < Math.min(W, Math.ceil(bx + r - x0)); gx++) {
        const dx = gx + x0 + 0.5 - bx, dz = gz + z0 + 0.5 - bz;
        if (Math.abs(dx * c + dz * s) <= hx + pad && Math.abs(dz * c - dx * s) <= hz + pad) blocked[gz * W + gx] = 1;
      }
  }
  const idx = (q) => Math.max(0, Math.min(H - 1, Math.floor(q.z - z0))) * W + Math.max(0, Math.min(W - 1, Math.floor(q.x - x0)));
  const S = idx(from), T = idx(to);
  // free the start/goal neighbourhoods (standing at a door, an NPC by a wall)
  for (const k of [S, T]) {
    const kx = k % W, kz = (k / W) | 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const q = (kz + dz) * W + kx + dx; if (q >= 0 && q < W * H) blocked[q] = 0; }
  }
  const g = new Float32Array(W * H).fill(Infinity);
  const prev = new Int32Array(W * H).fill(-1);
  const tx = T % W, tz = (T / W) | 0;
  const hfun = (k) => Math.hypot((k % W) - tx, ((k / W) | 0) - tz);
  // binary heap
  const heap = [];
  const push = (k, f) => { heap.push([f, k]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m2 = i; if (l < heap.length && heap[l][0] < heap[m2][0]) m2 = l; if (r < heap.length && heap[r][0] < heap[m2][0]) m2 = r; if (m2 === i) break; [heap[m2], heap[i]] = [heap[i], heap[m2]]; i = m2; } } return top; };
  g[S] = 0;
  push(S, hfun(S));
  const closed = new Uint8Array(W * H);
  let found = false;
  while (heap.length) {
    const [, u] = pop();
    if (closed[u]) continue;
    closed[u] = 1;
    if (u === T) { found = true; break; }
    const ux = u % W, uz = (u / W) | 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const vx = ux + dx, vz = uz + dz;
      if (vx < 0 || vz < 0 || vx >= W || vz >= H) continue;
      const v = vz * W + vx;
      if (blocked[v] || closed[v]) continue;
      if (dx && dz && (blocked[uz * W + vx] || blocked[vz * W + ux])) continue;
      const nd = g[u] + (dx && dz ? 1.4142 : 1);
      if (nd < g[v]) { g[v] = nd; prev[v] = u; push(v, nd + hfun(v)); }
    }
  }
  if (!found) return null;
  const cells = [];
  for (let k = T; k >= 0; k = prev[k]) cells.unshift(k);
  const pts = cells.map((k) => ({ x: (k % W) + x0 + 0.5, z: ((k / W) | 0) + z0 + 0.5 }));
  // string pulling: keep a point only when the straight line to the next kept one crosses a blocked cell
  const clear = (a, b) => { const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) * 2); for (let i = 1; i < n; i++) { const q = { x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n }; if (blocked[idx(q)]) return false; } return true; };
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !clear(pts[i], pts[j])) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

/** Walk to (x, z): around town buildings (grid A*), else straight. */
export async function nav(page, x, z, opts = {}) {
  const p = (await pl(page)).pos;
  const obs = await obstacles(page, p.x, p.z, x, z);
  const path = gridPath(obs, p, { x, z }) ?? [{ x, z }];
  path.push({ x, z });
  return follow(page, path, opts);
}
export async function navBoth(A, B, x, z, opts = {}) {
  const [a, b] = await Promise.all([nav(A, x, z, opts), nav(B, x + 2, z + 1.5, opts)]);
  return { A: { ok: a.ok, d: Math.round(a.d), s: Math.round(a.ms / 1000) }, B: { ok: b.ok, d: Math.round(b.d), s: Math.round(b.ms / 1000) } };
}

/** Where a named townsperson stands (drawn ones first, else their work spot). */
export async function npcAt(page, name) {
  return page.evaluate((n) => {
    const T = window.__lodestoneTowns;
    const v = T.visibleNpcs().find((q) => q.name === n);
    if (v) return { x: v.x, z: v.z };
    for (const s of T.settlements()) {
      const q = T.npcs(s.index).find((k) => k.name === n);
      if (q) return { x: q.x, z: q.z, town: s.name };
    }
    return null;
  }, name);
}

/**
 * Travel to (x, z): walk (nav) with a time budget for the distance; if the
 * walker gets stuck (a headless walker, not a player, problem), finish the
 * trip with the dev console's /tp and say so. Returns how it went.
 */
export async function travel(page, x, z, { stopAt = 3, walkBudget = 1, log = null, why = '' } = {}) {
  const p0 = (await pl(page)).pos;
  const d0 = Math.hypot(x - p0.x, z - p0.z);
  const r = await nav(page, x, z, { stopAt, timeoutMs: Math.round((d0 / 3.5 + 25) * 1000 * walkBudget) });
  if (r.ok) return { walked: Math.round(d0), s: Math.round(r.ms / 1000), tp: false };
  const left = Math.round(r.d);
  await run(page, `/tp ${Math.round(x)} ${Math.round(z)}`);
  await sleep(2500);
  log?.(`DEV /tp (${page.__who}): walked ${Math.round(d0 - left)} of ${Math.round(d0)} m in ${Math.round(r.ms / 1000)} s, then the walker stuck; teleported the last ${left} m${why ? ` (${why})` : ''}`);
  return { walked: Math.round(d0 - left), s: Math.round(r.ms / 1000), tp: true, left };
}
export async function travelBoth(A, B, x, z, o = {}) {
  const [a, b] = await Promise.all([travel(A, x, z, o), travel(B, x + 2, z + 1.5, o)]);
  return { A: a, B: b };
}

/** The town forge (prop kind 10) of the settlement nearest (x, z), with a spot to stand at it. */
export async function forgeNear(page, x, z) {
  return page.evaluate(([qx, qz]) => {
    const T = window.__lodestoneTowns;
    const s = T.settlements().map((t) => ({ ...t, d: Math.hypot(t.x - qx, t.z - qz) })).sort((a, b) => a.d - b.d)[0];
    const f = T.props(s.index, 10)[0];
    const b = T.buildings(s.index).find((k) => k.index === f.building);
    const dx = b.x - f.x, dz = b.z - f.z, dl = Math.hypot(dx, dz) || 1;
    return { town: s.name, si: s.index, x: f.x, y: f.y, z: f.z, stand: { x: f.x + (dx / dl) * 1.3, z: f.z + (dz / dl) * 1.3 } };
  }, [x, z]);
}

/** Use the forge like g4: stand at it, aim, E, click the recipes in turn. */
export async function forge(page, f, recipes) {
  await nav(page, f.stand.x, f.stand.z, { stopAt: 0.5, timeoutMs: 90000, sprint: false });
  let opened = false;
  for (let k = 0; k < 6 && !opened; k++) {
    await aimAt(page, f.x, f.y + 0.6, f.z);
    await sleep(400);
    const tg = await page.evaluate(() => window.__lodestoneTowns.target());
    if (tg?.kind === 'forge') {
      await page.keyboard.press('KeyE');
      opened = await page.getByTestId('craft-panel').waitFor({ timeout: 6000 }).then(() => true, () => false);
    } else await walkTo(page, f.stand.x + (Math.random() - 0.5), f.stand.z + (Math.random() - 0.5), { stopAt: 0.3, timeoutMs: 4000 });
  }
  const done = [];
  if (opened) {
    for (const key of recipes) {
      const btn = page.getByTestId(`recipe-${key}`).locator('button');
      const en = await btn.isEnabled().catch(() => false);
      if (en) await btn.click({ timeout: 5000 }).catch(() => {});
      done.push(`${key}:${en ? 'ok' : 'disabled'}`);
      await sleep(900);
    }
  }
  const panel = await page.evaluate(() => document.querySelector('[data-testid="craft-panel"]')?.innerText?.slice(0, 500) ?? '');
  await closePanels(page);
  return { opened, done, panel: panel.replace(/\n+/g, ' | ') };
}

/** Equip an item from the inventory like a player: I, select it, click Equip. */
export async function equip(page, base) {
  await page.keyboard.press('KeyI');
  await sleep(800);
  const h = await page.evaluate((b) => window.__lodestoneInventory.state().inv.items.find((i) => i.b === b && !String(i.s ?? '').startsWith('eq:'))?.h, base);
  const slot = page.getByTestId(`inv-item-${h}`).first();
  let ok = false;
  if (h !== undefined && (await slot.count().catch(() => 0))) {
    await slot.click().catch(() => {});
    await sleep(300);
    const b = page.locator('[data-testid="inv-actions"] button', { hasText: /^Equip|^Learn/ }).first();
    if (await b.count().catch(() => 0)) {
      await b.click().catch(() => {});
      ok = true;
    }
  }
  await sleep(600);
  const actions = await page.evaluate(() => document.querySelector('[data-testid="inv-actions"]')?.innerText ?? '');
  await page.keyboard.press('KeyI');
  await sleep(300);
  await closePanels(page);
  return { ok, actions: actions.slice(0, 200) };
}

/**
 * Put on the best gear in the pack like a player sorting loot: the highest
 * level melee weapon (sword or spear; `keep` a base to leave alone) in
 * loadout `lo`, and per armor base type the highest level piece. Through
 * the inventory screen (I, click, Equip).
 */
export async function gearUp(page, { lo = 1, weapons = /weapon:.*(sword|spear|blade)/, skipWeapon = false } = {}) {
  const items = await page.evaluate(() => window.__lodestoneInventory.state().inv.items.map((i) => ({ h: i.h, b: i.b, l: i.l ?? 0, r: i.r ?? 0, s: String(i.s ?? '') })));
  const score = (i) => i.l * 10 + i.r;
  const picks = [];
  if (!skipWeapon) {
    const ws = items.filter((i) => weapons.test(i.b)).sort((a, b) => score(b) - score(a));
    const cur = items.find((i) => i.s === `eq:main${lo - 1}`);
    if (ws[0] && (!cur || score(ws[0]) > score(cur)) && !ws[0].s.startsWith('eq:')) picks.push({ ...ws[0], act: `equip${lo}` });
  }
  const slotOf = (b) => (/cap|helm|hood/.test(b) ? 'head' : /cuirass|robe|tunic|vest|chest|mail/.test(b) ? 'chest' : /leggings|greaves|trousers|legs/.test(b) ? 'legs' : /boots|shoes/.test(b) ? 'feet' : /gloves|gauntlet/.test(b) ? 'hands' : b);
  const bySlot = {};
  for (const i of items.filter((x) => x.b.startsWith('armor:'))) {
    const k = slotOf(i.b);
    if (!bySlot[k] || score(i) > score(bySlot[k])) bySlot[k] = i;
  }
  for (const i of Object.values(bySlot)) if (!i.s.startsWith('eq:')) picks.push({ ...i, act: 'equip' });
  const done = [];
  if (!picks.length) return done;
  await page.keyboard.press('KeyI');
  await sleep(700);
  for (const p of picks) {
    const el = page.getByTestId(`inv-item-${p.h}`).first();
    if (!(await el.count().catch(() => 0))) continue;
    await el.click().catch(() => {});
    await sleep(250);
    const b = page.locator(`[data-testid="inv-actions"] button[data-act="${p.act}"]`).first();
    if (await b.count().catch(() => 0)) {
      await b.click().catch(() => {});
      done.push(`${p.b} L${p.l}`);
      await sleep(400);
    }
  }
  await page.keyboard.press('KeyI');
  await sleep(300);
  await closePanels(page);
  return done;
}

/** Fast travel through the map handle (the map's "Travel" button sends the same). */
export async function fastTravel(page, site) {
  await page.evaluate((s) => window.__lodestoneMap.fastTravel(s), site);
  await sleep(3000);
  return (await pl(page)).pos;
}

/** Read the lore tablet nearest (x, z): walk up to the glowing stone, face it, E. */
export async function readTablet(page, x, z) {
  const t = await page.evaluate(([qx, qz]) => Object.values(window.__lodestoneContent.state().tablets).map((k) => ({ site: k.site, x: k.x, y: k.y, z: k.z, d: Math.hypot(k.x - qx, k.z - qz) })).sort((a, b) => a.d - b.d)[0], [x, z]);
  if (!t) return { ok: false };
  await walk(page, t.x + 1.8, t.z, { stopAt: 0.6, straight: true, sprint: false, timeoutMs: 20000 });
  await aimAt(page, t.x, t.y + 0.8, t.z);
  await sleep(500);
  const prompt = await page.evaluate(() => document.querySelector('[data-testid="content-prompt"]')?.innerText ?? '');
  await page.keyboard.press('KeyE');
  await sleep(2500);
  const text = await page.evaluate(() => [...document.querySelectorAll('[data-testid]')].filter((e) => /tablet|reader/i.test(e.dataset.testid)).map((e) => e.innerText.slice(0, 500)).join(' | '));
  return { ok: true, prompt, offset: Math.round(t.d), text };
}

/** Talk to a trader and click Buy on the ware row matching `ware` (regex source). */
export async function buy(page, x, z, name, ware) {
  const t = await talk(page, x, z, { name });
  await sleep(600);
  const row = page.getByTestId('town-panel').locator('div', { hasText: new RegExp(ware, 'i') }).filter({ has: page.locator('button[data-act="buy"]') }).last();
  let ok = false;
  if (await row.count().catch(() => 0)) {
    await row.locator('button[data-act="buy"]').click({ timeout: 5000 }).then(() => (ok = true), () => {});
    await sleep(1200);
  }
  const after = await page.evaluate(() => document.querySelector('[data-testid="town-panel"]')?.innerText ?? '');
  await closePanels(page);
  return { ok, talked: t.npc, after: after.slice(0, 600).replace(/\n+/g, ' | ') };
}
export const inv = (page) => page.evaluate(() => { const s = window.__lodestoneInventory.state(); return { gold: s.inv.gold, items: s.inv.items.map((i) => `${i.b}x${i.q}`) }; });

/** The cave system nearest (x, z) by mouth, its veins and route. */
export async function caveNear(page, x, z) {
  return page.evaluate(([qx, qz]) => {
    const C = window.__lodestoneCaves;
    const sys = C.systems().map((s) => ({ ...s, d: Math.hypot(s.mouth.x - qx, s.mouth.z - qz) })).sort((a, b) => a.d - b.d)[0];
    return { sys, veins: C.veins(sys.index), route: C.route(sys.index), chambers: C.chambers(sys.index) };
  }, [x, z]);
}

/** Aim at a 3D point. */
export async function aimAt(page, x, y, z) {
  const p = (await pl(page)).pos;
  const d = Math.max(0.3, Math.hypot(x - p.x, z - p.z));
  await look(page, yawTo(p, x, z), Math.atan2(y - (p.y + 1.6), d));
}

/** Mine the vein with id (string) like a player: aim, E until it breaks. */
export async function mine(page, v) {
  let target = null;
  const hex = BigInt(v.id).toString(16);
  for (let i = 0; i < 12 && !target?.endsWith(hex); i++) {
    await aimAt(page, v.x, v.y, v.z);
    await sleep(300);
    target = await page.evaluate(() => window.__lodestoneCaves.info().target);
  }
  if (!target?.endsWith(hex)) return { ok: false, why: `not targeted (${target})` };
  let swings = 0;
  for (; swings < 40; swings++) {
    await page.keyboard.press('KeyE');
    await sleep(350);
    const t = await page.evaluate(() => window.__lodestoneCaves.info().target);
    if (!t?.endsWith(hex)) break;
  }
  await sleep(2500);
  return { ok: true, swings };
}
