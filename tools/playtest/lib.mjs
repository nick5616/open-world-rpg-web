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
