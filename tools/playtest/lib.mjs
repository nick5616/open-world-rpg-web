/* global getComputedStyle, innerWidth, innerHeight */
// Single-player playtest helpers: drive the real client like a new player
// against a running stack (npm run dev). No dev shortcuts unless a step says so.
//
//   cd client && node ../tools/playtest/sp1.mjs <outDir>   (playwright resolves from client/)
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../client/package.json', import.meta.url));
const { chromium } = require('playwright');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const BASE = process.env.LODESTONE_CLIENT_URL ?? 'http://localhost:5173';

export async function launch(outDir, { width = 1600, height = 900 } = {}) {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const log = [];
  const issues = [];
  const note = (msg) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
    console.log(line);
    log.push(line);
  };
  const issue = (kind, text) => {
    issues.push({ kind, text });
    note(`ISSUE ${kind}: ${text}`);
  };
  page.on('pageerror', (e) => issue('pageerror', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') log.push(`[console.error] ${m.text()}`.slice(0, 400));
  });
  let n = 0;
  const shot = async (name) => {
    const f = `${outDir}/${String(++n).padStart(2, '0')}-${name}.png`;
    await page.screenshot({ path: f });
    return f;
  };
  const save = () => writeFileSync(`${outDir}/report.json`, JSON.stringify({ issues, log }, null, 2));
  return { browser, page, shot, note, issue, issues, log, save };
}

export async function newCharacter(page, name) {
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

export const pl = (page) => page.evaluate(() => window.__lodestone.player());
export const look = (page, yaw, pitch = 0) => page.evaluate(([y, p]) => window.__lodestone.setLook(y, p), [yaw, pitch]);
export const yawTo = (p, x, z) => Math.atan2(-(x - p.x), -(z - p.z));

/** Visible fixed-position HUD boxes with a testid or text, for overlap checks. */
export async function hudBoxes(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.width > innerWidth * 0.9 || r.height > innerHeight * 0.9) continue;
      const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (!text && !el.dataset.testid) continue;
      if (el.closest('[data-testid="debug-hud"]')) continue; // dev overlay (F3)
      out.push({ id: el.dataset.testid || '', text, x: r.left, y: r.top, w: r.width, h: r.height, z: cs.zIndex });
    }
    return out;
  });
}

/** Pairs of fixed boxes that overlap by more than a few px (excluding nesting). */
export function overlaps(boxes) {
  const res = [];
  const contains = (p, q) => q.x >= p.x - 1 && q.y >= p.y - 1 && q.x + q.w <= p.x + p.w + 1 && q.y + q.h <= p.y + p.h + 1;
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox <= 4 || oy <= 4) continue;
      if (contains(a, b) || contains(b, a)) continue;
      res.push(`${a.id || a.text} <-> ${b.id || b.text} (${Math.round(ox)}x${Math.round(oy)})`);
    }
  return res;
}

export async function walkTo(page, x, z, { stopAt = 1.5, timeoutMs = 90000, sprint = false } = {}) {
  const t0 = Date.now();
  let last = null;
  let stuck = 0;
  let unstick = 0;
  await page.keyboard.down('KeyW');
  if (sprint) await page.keyboard.down('ShiftLeft');
  try {
    for (;;) {
      const p = (await pl(page)).pos;
      const d = Math.hypot(x - p.x, z - p.z);
      if (d <= stopAt) return { ok: true, d, ms: Date.now() - t0, p };
      if (Date.now() - t0 > timeoutMs) return { ok: false, d, ms: Date.now() - t0, p };
      await look(page, yawTo(p, x, z), 0);
      if (last && Math.hypot(p.x - last.x, p.z - last.z) < 0.03) stuck++;
      else stuck = 0;
      if (stuck > 10) {
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
      await sleep(120);
    }
  } finally {
    await page.keyboard.up('KeyW');
    if (sprint) await page.keyboard.up('ShiftLeft');
  }
}

// ---- street routing (from tools/acceptance/g4.mjs): players walk the streets ----
let GRAPH = null;
export async function townGraphNear(page) {
  const town = await page.evaluate(() => {
    const T = window.__lodestoneTowns;
    const me = window.__lodestone.player().pos;
    const s = T.settlements().map((x) => ({ ...x, d: Math.hypot(x.x - me.x, x.z - me.z) })).sort((a, b) => a.d - b.d)[0];
    return { index: s.index, name: s.name, x: s.x, z: s.z, radius: s.radius, square: s.square };
  });
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
      const ax = p[i];
      const az = p[i + 2];
      const bx = p[i + 3];
      const bz = p[i + 5];
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
  GRAPH = { nodes, adj, town };
  return GRAPH;
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
/** Walk to (x, z) along the nearest town's streets when either end is in town, else straight. */
export async function go(page, x, z, opts = {}) {
  const g = GRAPH ?? (await townGraphNear(page));
  const p = (await pl(page)).pos;
  const inTown = (q) => Math.hypot(q.x - g.town.x, q.z - g.town.z) < g.town.radius + 12;
  if (!inTown(p) && !inTown({ x, z })) return walkTo(page, x, z, opts);
  let path = routeOn(g, p, { x, z });
  if (!inTown({ x, z })) {
    // leave town along the street that ends nearest the goal
    const exits = g.nodes.filter((n) => Math.hypot(n.x - g.town.x, n.z - g.town.z) > g.town.radius - 6);
    const ex = exits.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
    if (ex) path = routeOn(g, p, ex);
  }
  for (const n of path) await walkTo(page, n.x, n.z, { stopAt: 1.8, sprint: opts.sprint, timeoutMs: 20000 });
  return walkTo(page, x, z, opts);
}

/** Close the welcome / What's new card if it is up (a player would click it away). */
export async function dismissCards(page) {
  const b = page.getByTestId('whatsnew-close');
  if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
}
