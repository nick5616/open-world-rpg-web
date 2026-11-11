/* global requestAnimationFrame */
// Photosensitivity audit (playtest 2 "calm kills"): plays real kills on a dev
// zone with every weapon class and a few big spells, records the page with
// the DevTools screencast (Page.startScreencast) and measures every frame:
// relative luminance (WCAG 2.x: sRGB -> linear, 0.2126 R + 0.7152 G +
// 0.0722 B) and saturated red, per pixel, then counts flashes the way the
// WCAG 2.3.1 / Harding method does:
//
//   transition  a monotonic luminance change of >= 0.1 (10 % of white) where
//               the darker end is below 0.8; red: (R - G - B) x 320 changing
//               by >= 20 on a pixel with R / (R + G + B) >= 0.8
//   flash       a pair of opposing transitions
//   area        a flash counts when >= 25 % of a 10 degree field flips
//               together. At a normal viewing distance a 10 degree field is
//               ~341 x 256 px of a 1024 x 768 screen (~11 % of the view), so
//               the frame is covered by overlapping windows of 1/3 x 1/3 of
//               the view (a 5 x 5 lattice at half-window steps)
//   FAIL        more than 3 flashes (general or red) inside any 1 s
//
// Besides the WCAG verdict it reports what a sensitive player feels even
// below the area threshold: "local" flashes in a 12 x 12 grid (each cell
// ~0.7 % of the view: an enemy's body), the biggest one-frame luminance jump
// of the full frame and of any cell, bright pops (a cell brightening by
// >= 0.04 and falling back within 0.4 s), frame hitches (rAF gaps), and an
// in-page probe of what the game itself flashed (enemy hit flash, FX flash
// sprites, pooled light intensity) so a spike can be attributed.
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/flash-audit.mjs \
//     [--label before] [--only wand,bow] [--quality high] [--out docs/evidence] [--observer] [--calm on|off]
//
// Writes <out>/pt2-flash-audit-<label>.json and one contact sheet per
// scenario (<out>/pt2-flash-audit-<label>-<scenario>.jpg: the frame with the
// biggest local change, its neighbours and the luminance trace). The frames
// themselves stay in tmp/flash-audit/<label>/ (not committed).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { launch, newCharacter, sleep, dismissCards, pl, look, yawTo, BASE } from './lib.mjs';

const requireRoot = createRequire(new URL('../../package.json', import.meta.url));
const sharp = requireRoot('sharp');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const LABEL = arg('label', 'run');
const OUT = arg('out', 'docs/evidence');
const QUALITY = arg('quality', 'high');
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const OBSERVER = argv.includes('--observer');
const CALM = arg('calm', ''); // '' leave the default, 'on' / 'off' set the Reduce flashing toggle
const W = 1280;
const H = 720;
const TMP = `tmp/flash-audit/${LABEL}`;
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });

// ── Analysis (pure: frames in, numbers out) ─────────────────────────────────

// The analysis raster: each pixel averages 20 x 20 screen px at 1280 x 720. Coarse on purpose: a
// flash that matters covers a large area, while a camera turning across grass only shifts fine
// texture (at full resolution that reads as thousands of tiny pixel "flashes").
const AW = 64;
const AH = 36;
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Per-pixel relative luminance and red value of a decoded RGB raster. */
function measure(rgb) {
  const n = AW * AH;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = LIN[rgb[i * 3]];
    const g = LIN[rgb[i * 3 + 1]];
    const b = LIN[rgb[i * 3 + 2]];
    L[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const s = r + g + b;
    R[i] = s > 0 && r / s >= 0.8 ? Math.max(0, (r - g - b) * 320) : 0;
  }
  return { L, R };
}

/**
 * Per-pixel Harding transitions: a monotonic run of change (a dead band
 * ignores JPEG noise) closes when it reverses; it is a transition when it
 * changed by >= `min` and its darker end is below `darkMax`. Returns, per
 * frame, the pixels that completed a rising (+1) or falling (-1) transition.
 */
function transitions(series, min, darkMax, dead, shifts = null, mask = null) {
  const n = AW * AH;
  let start = new Float32Array(n);
  let last = new Float32Array(n);
  let dir = new Int8Array(n);
  const out = [];
  series.forEach((v, f) => {
    const ev = new Int8Array(n);
    if (f === 0) {
      start.set(v);
      last.set(v);
      out.push(ev);
      return;
    }
    if (shifts && (shifts[f][0] !== 0 || shifts[f][1] !== 0)) {
      // the camera turned: carry every pixel's run along with the picture (new pixels start fresh)
      const [sx, sy] = shifts[f];
      const s2 = new Float32Array(n);
      const l2 = new Float32Array(n);
      const d2 = new Int8Array(n);
      for (let y = 0; y < AH; y++)
        for (let x = 0; x < AW; x++) {
          const i = y * AW + x;
          const ox = x - sx;
          const oy = y - sy;
          if (ox < 0 || oy < 0 || ox >= AW || oy >= AH) {
            s2[i] = l2[i] = v[i];
            continue;
          }
          const j = oy * AW + ox;
          s2[i] = start[j];
          l2[i] = last[j];
          d2[i] = dir[j];
        }
      start = s2;
      last = l2;
      dir = d2;
    }
    for (let i = 0; i < n; i++) {
      if (mask && !mask[i]) {
        start[i] = last[i] = v[i];
        dir[i] = 0;
        continue;
      }
      const d = v[i] - last[i];
      if (Math.abs(d) < dead) continue;
      const s = d > 0 ? 1 : -1;
      if (dir[i] === 0 || dir[i] === s) {
        dir[i] = s;
        last[i] = v[i];
        // a run that already crossed the threshold counts at the frame it crosses it (the flash is visible then)
        continue;
      }
      // reversal: close the run
      const ch = last[i] - start[i];
      if (Math.abs(ch) >= min && Math.min(last[i], start[i]) < darkMax) ev[i] = ch > 0 ? 1 : -1;
      start[i] = last[i];
      last[i] = v[i];
      dir[i] = s;
    }
    out.push(ev);
  });
  // close open runs at the end
  const ev = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const ch = last[i] - start[i];
    if (Math.abs(ch) >= min && Math.min(last[i], start[i]) < darkMax) ev[i] = ch > 0 ? 1 : -1;
  }
  out.push(ev);
  return out;
}

/**
 * Camera motion per frame: the integer shift (at the analysis raster) that
 * best maps the previous picture onto this one (mean absolute luminance
 * difference over the middle of the view, coarse to fine). A turning camera
 * moves the whole picture; the motion-compensated count below follows each
 * patch of the world across the screen, so what is left is what changed in
 * the world (flashes), not the view sweeping over grass and sky.
 */
function registration(Ls) {
  const cost = (a, b, sx, sy, w, h, step) => {
    let c = 0;
    let n = 0;
    for (let y = Math.round(h * 0.15); y < Math.round(h * 0.78); y += step)
      for (let x = Math.round(w * 0.05); x < Math.round(w * 0.85); x += step) {
        const ox = x - sx;
        const oy = y - sy;
        if (ox < 0 || oy < 0 || ox >= w || oy >= h) continue;
        c += Math.abs(a[y * w + x] - b[oy * w + ox]);
        n++;
      }
    return n > 50 / step ? c / n : Infinity;
  };
  const shifts = [[0, 0]];
  for (let f = 1; f < Ls.length; f++) {
    const a = Ls[f];
    const b = Ls[f - 1];
    let best = [0, 0];
    let bc = cost(a, b, 0, 0, AW, AH, 2);
    for (let sy = -8; sy <= 8; sy += 2)
      for (let sx = -12; sx <= 12; sx += 2) {
        const c = cost(a, b, sx, sy, AW, AH, 2);
        if (c < bc - 1e-6) {
          bc = c;
          best = [sx, sy];
        }
      }
    let fine = best;
    let fc = cost(a, b, best[0], best[1], AW, AH, 1);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const c = cost(a, b, best[0] + dx, best[1] + dy, AW, AH, 1);
        if (c < fc - 1e-6) {
          fc = c;
          fine = [best[0] + dx, best[1] + dy];
        }
      }
    shifts.push(fine);
  }
  return shifts;
}

/** The part of the view the motion-compensated count looks at: not the HUD rows at the top and bottom, nor the quest column. */
function viewMask() {
  const m = new Uint8Array(AW * AH);
  for (let y = Math.round(AH * 0.12); y < Math.round(AH * 0.8); y++) for (let x = 0; x < Math.round(AW * 0.86); x++) m[y * AW + x] = 1;
  return m;
}

/** Windows (x0, y0, x1, y1 in analysis px). */
function lattice(cols, rows, step) {
  const ws = [];
  const cw = AW / cols;
  const ch = AH / rows;
  for (let y = 0; y + rows * 0 <= rows - 1 + 1e-9; y += step) for (let x = 0; x <= cols - 1 + 1e-9; x += step) ws.push([Math.round(x * cw), Math.round(y * ch), Math.round(x * cw + cw), Math.round(y * ch + ch)]);
  return ws;
}
const WCAG_WINDOWS = lattice(3, 3, 0.5); // 5 x 5 overlapping 1/3 x 1/3 windows (a 10 degree field each)
const LOCAL_CELLS = lattice(12, 12, 1);

/**
 * Flash events per window: a window transition happens when >= `area` of its
 * pixels completed transitions of one direction within the last 3 frames; a
 * window must alternate direction (a flash is a pair of opposing changes).
 * Returns the per-window list of event times and the worst count of flashes
 * in any 1 s.
 */
function windowFlashes(events, times, windows, area) {
  const res = [];
  let worst = 0;
  let worstAt = -1;
  let worstWin = -1;
  windows.forEach(([x0, y0, x1, y1], wi) => {
    const px = (x1 - x0) * (y1 - y0);
    const up = new Float32Array(events.length);
    const dn = new Float32Array(events.length);
    for (let f = 0; f < events.length; f++) {
      const ev = events[f];
      let u = 0;
      let d = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const e = ev[y * AW + x];
          if (e > 0) u++;
          else if (e < 0) d++;
        }
      up[f] = u;
      dn[f] = d;
    }
    const ts = [];
    let lastDir = 0;
    for (let f = 0; f < events.length; f++) {
      let u = 0;
      let d = 0;
      for (let k = Math.max(0, f - 2); k <= f; k++) {
        u += up[k];
        d += dn[k];
      }
      const s = u >= area * px && u >= d ? 1 : d >= area * px ? -1 : 0;
      if (s !== 0 && s !== lastDir) {
        ts.push(times[Math.min(f, times.length - 1)]);
        lastDir = s;
      }
    }
    // flashes in any 1 s = floor(transitions in that second / 2)
    let j = 0;
    for (let i = 0; i < ts.length; i++) {
      while (ts[i] - ts[j] > 1) j++;
      const fl = Math.floor((i - j + 1) / 2);
      if (fl > worst) {
        worst = fl;
        worstAt = ts[i];
        worstWin = wi;
      }
    }
    res.push(ts.length);
  });
  return { worstPerSecond: worst, at: worstAt, window: worstWin, transitions: res.reduce((a, b) => a + b, 0) };
}

function cellMeans(L, windows) {
  return windows.map(([x0, y0, x1, y1]) => {
    let s = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += L[y * AW + x];
    return s / ((x1 - x0) * (y1 - y0));
  });
}

/** Everything for one recording: frames [{t, buf}] (jpeg). */
export async function analyze(frames) {
  const rasters = [];
  for (const fr of frames) {
    const raw = await sharp(fr.buf).resize(AW, AH, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    rasters.push(measure(raw));
  }
  const times = frames.map((f) => f.t - frames[0].t);
  const Ls = rasters.map((r) => r.L);
  const Rs = rasters.map((r) => r.R);
  const evL = transitions(Ls, 0.1, 0.8, 0.004);
  const evR = transitions(Rs, 20, Infinity, 1);
  const shifts = registration(Ls);
  const mask = viewMask();
  const evLc = transitions(Ls, 0.1, 0.8, 0.004, shifts, mask);
  const evRc = transitions(Rs, 20, Infinity, 1, shifts, mask);
  const generalC = windowFlashes(evLc, times, WCAG_WINDOWS, 0.25);
  const redC = windowFlashes(evRc, times, WCAG_WINDOWS, 0.25);
  const localC = windowFlashes(evLc, times, LOCAL_CELLS, 0.25);
  const moving = shifts.filter((s) => s[0] !== 0 || s[1] !== 0).length;
  const general = windowFlashes(evL, times, WCAG_WINDOWS, 0.25);
  const red = windowFlashes(evR, times, WCAG_WINDOWS, 0.25);
  const local = windowFlashes(evL, times, LOCAL_CELLS, 0.25);
  // intensity: full-frame mean and per-cell means
  const full = Ls.map((L) => L.reduce((a, b) => a + b, 0) / L.length);
  const cells = Ls.map((L) => cellMeans(L, LOCAL_CELLS));
  let maxFullJump = 0;
  let maxCellJump = 0;
  let maxCellJumpAt = 0;
  let maxCellJumpFrame = 0;
  for (let f = 1; f < full.length; f++) {
    maxFullJump = Math.max(maxFullJump, Math.abs(full[f] - full[f - 1]));
    for (let c = 0; c < LOCAL_CELLS.length; c++) {
      const d = Math.abs(cells[f][c] - cells[f - 1][c]);
      if (d > maxCellJump) {
        maxCellJump = d;
        maxCellJumpAt = times[f];
        maxCellJumpFrame = f;
      }
    }
  }
  // bright pops: a cell up >= 0.04 over its level 0.15 s before and back down within 0.4 s
  let pops = 0;
  for (let c = 0; c < LOCAL_CELLS.length; c++) {
    let f = 1;
    while (f < cells.length) {
      let b = f;
      while (b > 0 && times[f] - times[b] < 0.15) b--;
      const base = cells[b][c];
      if (cells[f][c] - base >= 0.04) {
        let g = f;
        while (g < cells.length && times[g] - times[f] < 0.4 && cells[g][c] - base > 0.015) g++;
        if (g < cells.length && times[g] - times[f] < 0.4) {
          pops++;
          f = g;
        }
      }
      f++;
    }
  }
  const gaps = [];
  for (let f = 1; f < times.length; f++) gaps.push(times[f] - times[f - 1]);
  gaps.sort((a, b) => a - b);
  const round = (v, k = 3) => Math.round(v * 10 ** k) / 10 ** k;
  return {
    frames: frames.length,
    seconds: round(times.at(-1) ?? 0, 2),
    fps: round(frames.length / Math.max(0.001, times.at(-1) ?? 1), 1),
    wcag: {
      generalFlashesPerSecondMax: general.worstPerSecond,
      redFlashesPerSecondMax: red.worstPerSecond,
      pass: general.worstPerSecond <= 3 && red.worstPerSecond <= 3,
      worstAt: round(general.at, 2),
    },
    local: { flashesPerSecondMax: local.worstPerSecond, at: round(local.at, 2), cellTransitions: local.transitions },
    // the same counts following the world through camera turns (what the game drew, not the view sweeping)
    compensated: {
      generalFlashesPerSecondMax: generalC.worstPerSecond,
      redFlashesPerSecondMax: redC.worstPerSecond,
      pass: generalC.worstPerSecond <= 3 && redC.worstPerSecond <= 3,
      worstAt: round(generalC.at, 2),
      localFlashesPerSecondMax: localC.worstPerSecond,
      localAt: round(localC.at, 2),
      movingFrames: moving,
    },
    maxFullFrameJump: round(maxFullJump, 4),
    maxCellJump: round(maxCellJump, 4),
    maxCellJumpAt: round(maxCellJumpAt, 2),
    maxCellJumpFrame,
    brightPops: pops,
    frameGapP50: round(gaps[Math.floor(gaps.length / 2)] ?? 0, 3),
    frameGapMax: round(gaps.at(-1) ?? 0, 3),
    trace: full.map((v) => round(v, 4)),
    cellTrace: cells.map((cs) => round(Math.max(...cs), 4)),
  };
}

// ── Recording ───────────────────────────────────────────────────────────────

async function recorder(page) {
  const cdp = await page.context().newCDPSession(page);
  let frames = [];
  let on = false;
  cdp.on('Page.screencastFrame', (e) => {
    cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
    if (on) frames.push({ t: e.metadata.timestamp, buf: Buffer.from(e.data, 'base64') });
  });
  return {
    async start() {
      frames = [];
      on = true;
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 640, maxHeight: 360, everyNthFrame: 1 });
    },
    async stop() {
      on = false;
      await cdp.send('Page.stopScreencast').catch(() => {});
      return frames;
    },
  };
}

/** In-page probe: rAF gaps and what the game flashed (enemy hit flash, FX flashes, lights) at 60 Hz. */
async function installProbe(page) {
  await page.evaluate(async () => {
    const w0 = window;
    // the app's live layer (a bare import after a hot update can be a second, idle module copy)
    const enemyLayer = w0.__lodestoneEnemyLayer ?? (await import('/src/combat/CombatLayer.tsx')).enemyLayer;
    const w = window;
    w.__flashProbe = { on: false, s: [] };
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const p = w.__flashProbe;
      if (p.on) {
        const r = enemyLayer.renderer;
        let flash = 0;
        let dying = 0;
        let pulses = 0;
        if (r) for (const e of r.enemies.values()) {
          flash = Math.max(flash, e.anim.flash ?? 0);
          pulses += e.anim.tint?.pulses ?? 0;
          if (!e.anim.alive) dying++;
        }
        const st = w.__lodestoneFx?.stats?.() ?? {};
        p.s.push([Math.round(now), Math.round(now - last), Math.round(flash * 100) / 100, dying, st.flashes ?? 0, st.lights ?? 0, pulses]);
      }
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// ── Driving ─────────────────────────────────────────────────────────────────

const SCENARIOS = [
  // control: the same sword swings at nothing (the view model and its arc, no enemy, no kill)
  { name: 'sword-control', weapon: 'iron_sword', mode: 'control', spawn: '' },
  { name: 'sword', weapon: 'iron_sword', mode: 'melee', spawn: 'slime 3 6' },
  { name: 'spear', weapon: 'iron_spear', mode: 'melee', spawn: 'slime 3 6' },
  { name: 'bow', weapon: 'oak_bow', mode: 'bow', spawn: 'slime 3 6' },
  { name: 'staff', weapon: 'oak_staff', mode: 'click', spawn: 'slime 3 6' },
  { name: 'wand', weapon: 'birch_wand', mode: 'click', spawn: 'slime 3 6' },
  { name: 'wand-pack-night', weapon: 'birch_wand', mode: 'click', spawn: 'boar 4 12', time: 23 },
  { name: 'cinder-spray', weapon: 'birch_wand', spell: 'cinder_spray', mode: 'stream', spawn: 'slime 3 6' },
  { name: 'arc-sparks', weapon: 'birch_wand', spell: 'arc_sparks', mode: 'stream', spawn: 'boar 3 12' },
  { name: 'starfall-hail', weapon: 'birch_wand', spell: 'starfall_hail', mode: 'stream', spawn: 'slime 4 8' },
  { name: 'fireball', weapon: 'birch_wand', spell: 'fireball', mode: 'cast', spawn: 'slime 4 8' },
  { name: 'pyre-brand', weapon: 'birch_wand', spell: 'pyre_brand', mode: 'cast', spawn: 'slime 5 8' },
];

const run = (p, line) => p.evaluate((l) => window.__lodestoneDev.run(l), line);
const combat = (p, fn, a) => p.evaluate(fn, a);

async function nearestEnemy(page) {
  return page.evaluate(() => {
    const me = window.__lodestone.player().pos;
    const vs = (window.__lodestoneDrawn?.() ?? []).filter((v) => v.kind === 2 && v.healthPct > 0);
    vs.sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z));
    return { n: vs.length, t: vs[0] ? { x: vs[0].x, y: vs[0].y, z: vs[0].z, id: vs[0].id } : null };
  });
}

// The camera turns smoothly (at most ~1.3 rad/s): a snapped aim swaps the whole view in one frame,
// which the analysis would rightly count as a change of the picture, not something the game flashed.
const aimState = new Map();
async function aimAt(page, t, snap = false) {
  const p = (await pl(page)).pos;
  const d = Math.hypot(t.x - p.x, t.z - p.z);
  const ty = yawTo(p, t.x, t.z);
  const tp = Math.atan2(t.y + 0.5 - (p.y + 1.6), Math.max(0.5, d));
  let a = aimState.get(page);
  if (!a || snap) a = { yaw: ty, pitch: tp };
  else {
    let dy = Math.atan2(Math.sin(ty - a.yaw), Math.cos(ty - a.yaw));
    dy = Math.max(-0.12, Math.min(0.12, dy));
    a = { yaw: a.yaw + dy, pitch: a.pitch + Math.max(-0.08, Math.min(0.08, tp - a.pitch)) };
  }
  aimState.set(page, a);
  await look(page, a.yaw, a.pitch);
  return d;
}

async function equipSpell(page, key) {
  const id = await page.evaluate(async (k) => (await import('/src/combat/fx/spellVisual.ts')).spellByKey.get(k)?.id ?? 0, key).catch(() => 0);
  if (!id) throw new Error(`no spell ${key}`);
  await page.evaluate((sid) => {
    const c = window.__lodestoneCombat;
    const a = c.hud().activeLoadout;
    c.interact(50, 7, sid);
    c.interact(50, 3, a | (0 << 4) | (sid << 8));
  }, id);
  await page.waitForFunction((k) => {
    const h = window.__lodestoneCombat.hud();
    return h.loadouts[h.activeLoadout]?.spells[0] === k;
  }, key, { timeout: 10000 });
}

async function fight(page, sc, maxMs) {
  const t0 = Date.now();
  let lastAttack = 0;
  let streaming = false;
  let kills = 0;
  let seen = 0;
  let w = false;
  try {
    for (;;) {
      const { n, t } = await nearestEnemy(page);
      if (n > seen) seen = n;
      if (!t || Date.now() - t0 > maxMs) break;
      const d = await aimAt(page, t);
      const melee = sc.mode === 'melee';
      if (melee && d > 3.5 && !w) {
        await page.keyboard.down('KeyW');
        w = true;
      } else if ((!melee || d <= 2.0) && w) {
        await page.keyboard.up('KeyW');
        w = false;
      }
      const now = Date.now();
      if (sc.mode === 'stream') {
        if (!streaming) {
          await combat(page, () => window.__lodestoneCombat.runtime.hold(0, true));
          streaming = true;
        }
      } else if (sc.mode === 'cast') {
        if (now - lastAttack > 700) {
          await combat(page, () => window.__lodestoneCombat.runtime.press(0));
          lastAttack = now;
        }
      } else if (sc.mode === 'bow') {
        if (now - lastAttack > 900) {
          await combat(page, () => window.__lodestoneCombat.runtime.holdAttack(true));
          await sleep(550);
          await aimAt(page, t);
          await combat(page, () => window.__lodestoneCombat.runtime.holdAttack(false));
          lastAttack = Date.now();
        }
      } else if (now - lastAttack > 240 && (!melee || d <= 2.6)) {
        await combat(page, () => window.__lodestoneCombat.runtime.press('attack'));
        lastAttack = now;
      }
      await sleep(90);
    }
  } finally {
    if (streaming) await combat(page, () => window.__lodestoneCombat.runtime.hold(0, false));
    if (w) await page.keyboard.up('KeyW');
  }
  const left = (await nearestEnemy(page)).n;
  kills = Math.max(0, seen - left);
  return { kills, seen, left, ms: Date.now() - t0 };
}

async function setCalm(p, v) {
  if (!v) return null;
  return p
    .evaluate(async (on) => {
      const h = window.__lodestoneFlash;
      if (h) {
        h.setReduceFlashing(on === 'on');
        return h.profile().name;
      }
      const m = await import('/src/stores/accessibility.ts');
      m.useAccessibility.getState().setReduceFlashing(on === 'on');
      return m.useAccessibility.getState().reduceFlashing;
    }, v)
    .catch(() => 'n/a (no toggle in this build)');
}

/** Wait until the player stands still on loaded ground (a teleport lands before the terrain streams in). */
async function settle(p) {
  let still = 0;
  let last = null;
  for (let i = 0; i < 60 && still < 4; i++) {
    await sleep(300);
    const y = (await pl(p)).pos.y;
    still = last !== null && Math.abs(y - last) < 0.03 ? still + 1 : 0;
    last = y;
  }
}

async function prep(p, name) {
  await newCharacter(p, name);
  await sleep(1500);
  await dismissCards(p);
  await p.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 20000 });
  for (const l of ['/god on', '/mana on', '/level 40', '/learn all', '/time 13:00', '/weather clear']) await run(p, l);
  await p.evaluate((q) => window.__lodestone.setQuality(q), QUALITY);
}

async function contactSheet(frames, res, file) {
  const f = Math.max(2, Math.min(frames.length - 3, res.maxCellJumpFrame));
  const pick = [f - 2, f - 1, f, f + 1, f + 2].filter((i) => i >= 0 && i < frames.length);
  const tw = 320;
  const th = 180;
  const tiles = await Promise.all(pick.map((i) => sharp(frames[i].buf).resize(tw, th).jpeg().toBuffer()));
  // the luminance trace (full frame white, brightest cell orange) as an SVG strip
  const tr = res.trace;
  const ct = res.cellTrace;
  const sw = tw * tiles.length;
  const sh = 120;
  const path = (arr, k) => arr.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / Math.max(1, arr.length - 1)) * sw).toFixed(1)},${(sh - 8 - v * k * (sh - 16)).toFixed(1)}`).join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sw}" height="${sh}"><rect width="100%" height="100%" fill="#111"/><path d="${path(ct, 1)}" stroke="#ff9a3c" fill="none" stroke-width="1.5"/><path d="${path(tr, 1)}" stroke="#ffffff" fill="none" stroke-width="1.5"/><line x1="${((f / Math.max(1, tr.length - 1)) * sw).toFixed(1)}" y1="0" x2="${((f / Math.max(1, tr.length - 1)) * sw).toFixed(1)}" y2="${sh}" stroke="#4fc3f7"/><text x="6" y="16" fill="#ddd" font-family="sans-serif" font-size="13">luminance: full frame (white), brightest 12x12 cell (orange); blue = frames above. WCAG max ${res.wcag.generalFlashesPerSecondMax}/s general, ${res.wcag.redFlashesPerSecondMax}/s red; local ${res.local.flashesPerSecondMax}/s; pops ${res.brightPops}</text></svg>`;
  await sharp({ create: { width: sw, height: th + sh, channels: 3, background: '#111' } })
    .composite([...tiles.map((b, i) => ({ input: b, left: i * tw, top: 0 })), { input: Buffer.from(svg), left: 0, top: th }])
    .jpeg({ quality: 70 })
    .toFile(file);
}

// --reanalyze: recompute the numbers from the frames a run kept in tmp/flash-audit/<label>/ (no browser)
if (argv.includes('--reanalyze')) {
  const file = `${OUT}/pt2-flash-audit-${LABEL}.json`;
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { label: LABEL, scenarios: {} };
  for (const name of readdirSync(TMP)) {
    const dir = `${TMP}/${name}`;
    if (!statSync(dir).isDirectory()) continue;
    const frames = readdirSync(dir)
      .filter((f) => f.endsWith('.jpg'))
      .sort()
      .map((f) => ({ t: +f.split('-')[1].replace('.jpg', '') / 1000, buf: readFileSync(`${dir}/${f}`) }));
    if (frames.length < 10) continue;
    const res = await analyze(frames);
    const old = prev.scenarios[name] ?? {};
    prev.scenarios[name] = { ...res, trace: undefined, cellTrace: undefined, fight: old.fight, probe: old.probe };
    console.log(`${name}: compensated general ${res.compensated.generalFlashesPerSecondMax}/s red ${res.compensated.redFlashesPerSecondMax}/s local ${res.compensated.localFlashesPerSecondMax}/s ${res.compensated.pass ? 'PASS' : 'FAIL'} (moving ${res.compensated.movingFrames}/${res.frames}); raw general ${res.wcag.generalFlashesPerSecondMax}/s local ${res.local.flashesPerSecondMax}/s; max cell jump ${res.maxCellJump}`);
    await contactSheet(frames, res, `${OUT}/pt2-flash-audit-${LABEL}-${name}.jpg`);
  }
  writeFileSync(file, JSON.stringify(prev, null, 2));
  process.exit(0);
}

const t = await launch(TMP, { width: W, height: H });
const { page, note, issue, browser } = t;
const results = { label: LABEL, quality: QUALITY, url: BASE, observer: OBSERVER, when: new Date().toISOString(), scenarios: {} };
let obs = null;
try {
  await prep(page, `Fl${Date.now().toString(36).slice(-4)}`);
  results.calm = await setCalm(page, CALM);
  // out of the spawn town onto open ground (LODESTONE_AUDIT_TP="dx dz" moves the spot)
  await settle(page);
  await page.waitForFunction(() => Math.hypot(window.__lodestone.player().pos.x, window.__lodestone.player().pos.z) > 5, null, { timeout: 30000 });
  const sp = await pl(page);
  const [dx, dz] = (process.env.LODESTONE_AUDIT_TP ?? '90 70').split(' ').map(Number);
  await run(page, `/tp ${Math.round(sp.pos.x + dx)} ${Math.round(sp.pos.z + dz)}`);
  await settle(page);
  if (OBSERVER) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    obs = await ctx.newPage();
    obs.on('pageerror', (e) => issue('observer pageerror', e.message));
    await prep(obs, `Ob${Date.now().toString(36).slice(-4)}`);
    results.calmObserver = await setCalm(obs, CALM);
  }
  await page.keyboard.press('F3');
  if (obs) await obs.keyboard.press('F3');
  await sleep(9000); // terrain, the area card fades
  for (const p of [page, obs].filter(Boolean)) {
    await dismissCards(p);
    for (const tid of ['tip-close']) {
      const b = p.getByTestId(tid);
      if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
    }
  }
  await page.mouse.click(W / 2, H / 2); // the first click only captures the mouse
  const rec = await recorder(obs ?? page);
  await installProbe(obs ?? page);
  for (const sc of SCENARIOS) {
    if (ONLY && !ONLY.includes(sc.name)) continue;
    note(`scenario ${sc.name}`);
    try {
      await run(page, '/despawn');
      await run(page, `/time ${sc.time ?? 13}:00`);
      await run(page, `/equip ${sc.weapon} legendary l1`);
      if (sc.spell) await equipSpell(page, sc.spell);
      await sleep(600);
      const me = await pl(page);
      if (obs) {
        // the observer 4 m to the side of the attacker, facing where the enemies will be
        await run(obs, `/tp ${(me.pos.x + 4).toFixed(1)} ${(me.pos.z + 1).toFixed(1)}`);
        await settle(obs);
      }
      if (sc.mode === 'control') {
        await (obs ?? page).evaluate(() => {
          window.__flashProbe.s = [];
          window.__flashProbe.on = true;
        });
        await rec.start();
        const c0 = Date.now();
        while (Date.now() - c0 < 8000) {
          await page.evaluate(() => window.__lodestoneCombat.runtime.press('attack'));
          await sleep(240);
        }
        const frames = await rec.stop();
        (obs ?? page).evaluate(() => (window.__flashProbe.on = false));
        const res = await analyze(frames);
        results.scenarios[sc.name] = { ...res, trace: undefined, cellTrace: undefined };
        note(`${sc.name}: WCAG (camera-compensated) general ${res.compensated.generalFlashesPerSecondMax}/s, local ${res.compensated.localFlashesPerSecondMax}/s; raw general ${res.wcag.generalFlashesPerSecondMax}/s; max cell jump ${res.maxCellJump}`);
        mkdirSync(`${TMP}/${sc.name}`, { recursive: true });
        for (let i = 0; i < frames.length; i++) writeFileSync(`${TMP}/${sc.name}/${String(i).padStart(4, '0')}-${Math.round((frames[i].t - frames[0].t) * 1000)}.jpg`, frames[i].buf);
        await contactSheet(frames, res, `${OUT}/pt2-flash-audit-${LABEL}-${sc.name}.jpg`);
        continue;
      }
      await run(page, `/spawn ${sc.spawn}`);
      await sleep(1500);
      const first = await nearestEnemy(page);
      if (!first.t) {
        issue(sc.name, 'nothing spawned');
        continue;
      }
      note(`  me ${JSON.stringify((await pl(page)).pos)} first ${JSON.stringify(first)}`);
      await aimAt(page, first.t, true);
      if (obs) {
        const o = (await pl(obs)).pos;
        await look(obs, yawTo(o, first.t.x, first.t.z), -0.1);
      }
      await sleep(400);
      await (obs ?? page).evaluate(() => {
        window.__flashProbe.s = [];
        window.__flashProbe.on = true;
      });
      await rec.start();
      const f = await fight(page, sc, 16000);
      await sleep(2200); // the last death plays out
      const frames = await rec.stop();
      const probe = await (obs ?? page).evaluate(() => {
        window.__flashProbe.on = false;
        return window.__flashProbe.s;
      });
      const res = await analyze(frames);
      const rafGaps = probe.map((s) => s[1]).sort((a, b) => a - b);
      res.fight = f;
      res.probe = {
        rafP50: rafGaps[Math.floor(rafGaps.length / 2)] ?? 0,
        rafMax: rafGaps.at(-1) ?? 0,
        rafOver50: rafGaps.filter((g) => g > 50).length,
        enemyFlashFrames: probe.filter((s) => s[2] > 0.5).length,
        // hit flashes started on enemies: the old full-white flash's onsets (> 0.5), or the calm tint's pulses
        enemyFlashOnsets: probe.some((s) => s[6] > 0) ? probe.reduce((n, s, i) => n + (i > 0 && s[6] > probe[i - 1][6] ? s[6] - probe[i - 1][6] : 0), 0) : probe.filter((s, i) => i > 0 && s[2] > 0.5 && probe[i - 1][2] <= 0.5).length,
        maxFxFlashes: Math.max(0, ...probe.map((s) => s[4])),
        maxLights: Math.max(0, ...probe.map((s) => s[5])),
      };
      results.scenarios[sc.name] = { ...res, trace: undefined, cellTrace: undefined };
      note(`${sc.name}: kills ${f.kills}/${f.seen} in ${f.ms} ms; WCAG (camera-compensated) general ${res.compensated.generalFlashesPerSecondMax}/s red ${res.compensated.redFlashesPerSecondMax}/s ${res.compensated.pass ? 'PASS' : 'FAIL'}, local ${res.compensated.localFlashesPerSecondMax}/s; raw general ${res.wcag.generalFlashesPerSecondMax}/s red ${res.wcag.redFlashesPerSecondMax}/s ${res.wcag.pass ? 'PASS' : 'FAIL'}; raw local ${res.local.flashesPerSecondMax}/s; max jump full ${res.maxFullFrameJump} cell ${res.maxCellJump}; pops ${res.brightPops}; enemy flash onsets ${res.probe.enemyFlashOnsets}; frames ${res.frames} @ ${res.fps} fps, rAF max ${res.probe.rafMax} ms`);
      await contactSheet(frames, res, `${OUT}/pt2-flash-audit-${LABEL}-${sc.name}.jpg`);
      mkdirSync(`${TMP}/${sc.name}`, { recursive: true });
      for (let i = 0; i < frames.length; i++) writeFileSync(`${TMP}/${sc.name}/${String(i).padStart(4, '0')}-${Math.round((frames[i].t - frames[0].t) * 1000)}.jpg`, frames[i].buf);
      writeFileSync(`${TMP}/${sc.name}-trace.json`, JSON.stringify({ trace: res.trace, cellTrace: res.cellTrace }));
    } catch (e) {
      issue(sc.name, String(e?.stack ?? e).slice(0, 400));
    }
  }
} catch (e) {
  issue('exception', String(e?.stack ?? e));
  await page.screenshot({ path: `${TMP}/fail.jpg`, type: 'jpeg', quality: 60 }).catch(() => {});
} finally {
  results.issues = t.issues;
  writeFileSync(`${OUT}/pt2-flash-audit-${LABEL}.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
