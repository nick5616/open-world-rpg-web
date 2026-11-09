#!/usr/bin/env node
/* global requestAnimationFrame, PerformanceObserver, localStorage, setInterval, clearInterval, WebGL2RenderingContext */
// Traversal benchmark (spec 12 budgets, spec 14 "Traversal benchmark"):
// a headless Chromium walks, then flies a fixed path across every biome of
// the default world, recording frame times, main-thread long tasks (> 50 ms),
// draw calls, triangles (visible and shadow passes), JS heap, chunk
// generation times and the bytes downloaded before the first playable frame.
// Then (high tier) beauty shots: meadow, forest, snowpeak, a valley at
// sunset, dawn fog.
//
//   npm run bench -w client                       # both tiers against the production preview
//   LODESTONE_CLIENT_URL=http://localhost:5176 node client/src/world/bench/traversal.mjs high
//
// The production build is what players download, so it is the default
// target: `VITE_SOLO=1 npm run build -w client && npx vite preview --port 5177`
// (run from client/). Against the dev server, the download number is
// meaningless (unbundled modules) but everything else holds.
//
// GPU: launched with ANGLE on D3D11 (`--use-angle=d3d11 --enable-gpu`), which
// gives headless Chromium the real GPU on Windows (an RTX 3070 on the dev
// machine: the spec's high-tier reference class). `LODESTONE_BENCH_GL=swiftshader`
// forces software GL. vsync is left on, so frame times read like a 60 Hz
// display; `LODESTONE_BENCH_UNCAPPED=1` disables the frame-rate limit to
// expose the true frame cost.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', '..', '..', '..', 'docs', 'evidence');
mkdirSync(out, { recursive: true });
const base = process.env.LODESTONE_CLIENT_URL ?? 'http://localhost:5177';
const tiers = process.argv.slice(2).filter((a) => ['high', 'medium', 'low'].includes(a));
const runTiers = tiers.length ? tiers : ['high', 'low'];
const software = process.env.LODESTONE_BENCH_GL === 'swiftshader';
const uncapped = process.env.LODESTONE_BENCH_UNCAPPED === '1';
// LODESTONE_BENCH_SHORT=1: 2 s walk, no flight, results not written (iterating on the beauty shots).
const SHORT = process.env.LODESTONE_BENCH_SHORT === '1';
// LODESTONE_BENCH_PREFIX names the results (default wp05-traversal-*; WP19's second pass: wp19b).
const PREFIX = process.env.LODESTONE_BENCH_PREFIX ?? 'wp05';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUDGETS = { drawCalls: 400, triangles: 1.5e6, longTaskMs: 50, heapMB: 600, chunkGenMs: 8, downloadMB: 15, frameMs: { high: 16.6, medium: 16.6, low: 33 } };

const gpuArgs = software ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
if (uncapped) gpuArgs.push('--disable-gpu-vsync', '--disable-frame-rate-limit');

const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

async function runTier(tier) {
  const viewport = tier === 'low' ? { width: 1280, height: 720 } : { width: 1920, height: 1080 };
  const browser = await chromium.launch({ headless: true, args: gpuArgs });
  const context = await browser.newContext({ viewport });
  // Pin the tier before the app reads it (zustand persist format).
  await context.addInitScript((t) => {
    localStorage.setItem('lodestone_quality_settings', JSON.stringify({ state: { setting: t }, version: 0 }));
    // Frame recorder + long-task observer, installed before any app code runs.
    const w = window;
    w.__bench = { frames: [], longTasks: [], recording: false, samples: [] };
    let last = performance.now();
    const tick = (now) => {
      if (w.__bench.recording) w.__bench.frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__bench.longTasks.push({ start: e.startTime, ms: e.duration, recording: w.__bench.recording });
      }).observe({ type: 'longtask', buffered: true });
    } catch {}
    // WP19b: every shader program linked, with time and phase, so a long
    // task can be matched to the programs compiled inside it (first-use
    // shader compiles were the traversal long tasks, decision v1-capacity).
    w.__bench.links = [];
    const link = WebGL2RenderingContext.prototype.linkProgram;
    WebGL2RenderingContext.prototype.linkProgram = function (p) {
      w.__bench.links.push({ t: performance.now(), recording: w.__bench.recording, p });
      return link.call(this, p);
    };
  }, tier);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  // Every response until the first playable frame: raw and gzipped sizes.
  const responses = [];
  let playable = false;
  page.on('response', async (r) => {
    if (playable) return;
    try {
      const body = await r.body();
      responses.push({ url: r.url().replace(base, ''), bytes: body.length, gzip: gzipSync(body, { level: 6 }).length, encoding: r.headers()['content-encoding'] ?? null });
    } catch {}
  });

  const t0 = Date.now();
  // LODESTONE_BENCH_QUERY: extra URL parameters (WP19b: `nowarmup` measures without the shader warm-up).
  await page.goto(`${base}/?autoplay=1&nocache=1${process.env.LODESTONE_BENCH_QUERY ? `&${process.env.LODESTONE_BENCH_QUERY}` : ''}`);
  await page.waitForSelector('[data-testid="world-loading"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="world-loading"]', { state: 'detached', timeout: 120000 });
  const loadMs = Date.now() - t0;
  playable = true;
  await sleep(500);
  const renderer = await page.evaluate(() => {
    const gl = document.querySelector('canvas')?.getContext('webgl2');
    const e = gl?.getExtension('WEBGL_debug_renderer_info');
    return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  const startStats = await page.evaluate(() => window.__lodestoneWorld.stats());
  const programsAtPlayable = await page.evaluate(() => window.__bench.links.length); // WP19b
  console.log(`[${tier}] programs linked before playable: ${programsAtPlayable}`);
  console.log(`[${tier}] playable in ${loadMs} ms on ${renderer}`);

  const begin = async () => {
    await page.evaluate(() => {
      window.__bench.frames = [];
      window.__bench.recording = true;
      window.__lodestoneWorld.resetStats();
      window.__bench.sampler = setInterval(() => window.__bench.samples.push({ t: performance.now(), ...window.__lodestoneWorld.stats(), player: window.__lodestone.player() }), 500);
    });
  };
  const end = async (name) => {
    const r = await page.evaluate(() => {
      window.__bench.recording = false;
      clearInterval(window.__bench.sampler);
      const b = window.__bench;
      // Programs linked during this phase, named from three's program list.
      const progs = window.__r3f?.gl?.info?.programs ?? [];
      const linked = b.links.filter((l) => l.recording).map((l) => {
        const pr = progs.find((x) => x.program === l.p);
        return { t: Math.round(l.t), name: pr ? pr.name : '?', key: pr ? String(pr.cacheKey) : '', similar: pr ? progs.filter((x) => x !== pr && String(x.cacheKey).startsWith(String(pr.cacheKey).slice(0, 20))).map((x) => String(x.cacheKey)) : [] };
      });
      b.links = b.links.filter((l) => !l.recording);
      const res = { frames: b.frames, samples: b.samples, longTasks: b.longTasks.filter((l) => l.recording), stats: window.__lodestoneWorld.stats(), linked };
      b.samples = [];
      b.longTasks = b.longTasks.filter((l) => !l.recording);
      return res;
    });
    const f = r.frames;
    const s = r.samples;
    const phase = {
      name,
      seconds: round(f.reduce((a, b) => a + b, 0) / 1000, 1),
      frames: f.length,
      frameMs: { mean: round(f.reduce((a, b) => a + b, 0) / Math.max(1, f.length)), p50: round(pct(f, 50)), p95: round(pct(f, 95)), p99: round(pct(f, 99)), max: round(Math.max(0, ...f)) },
      framesOverBudget: f.filter((x) => x > BUDGETS.frameMs[tier] * 1.05).length,
      drawCalls: { mean: round(s.reduce((a, x) => a + x.frame.calls, 0) / Math.max(1, s.length), 0), max: Math.max(0, ...s.map((x) => x.frame.calls)) },
      triangles: { mean: Math.round(s.reduce((a, x) => a + x.frame.triangles, 0) / Math.max(1, s.length)), max: Math.max(0, ...s.map((x) => x.frame.triangles)) },
      visibleTriangles: { max: Math.max(0, ...s.map((x) => x.frame.triangles - x.frame.shadowTris)) },
      shadowTriangles: { max: Math.max(0, ...s.map((x) => x.frame.shadowTris)) },
      heapMB: { max: round(Math.max(0, ...s.map((x) => (x.heap?.used ?? 0) / 1048576)), 1) },
      longTasks: r.longTasks.map((l) => round(l.ms, 0)),
      longTaskAt: r.longTasks.map((l) => ({ start: Math.round(l.start), ms: round(l.ms, 0) })),
      programsLinked: r.linked,
      chunkGenMs: r.stats.terrain.genMs,
      chunkMeshMs: r.stats.terrain.meshMs,
      scatterGenMs: r.stats.scatter.genMs,
      tilesBuilt: r.stats.terrain.built,
      queueMax: Math.max(0, ...s.map((x) => x.terrain.queued + x.terrain.inFlight)),
      uploadMsMax: round(r.stats.terrain.uploadMsMax),
      rebinMsMax: round(Math.max(0, ...s.map((x) => x.scatter.rebinMs))),
      terrainMsMax: { reselect: round(Math.max(0, ...s.map((x) => x.terrain.prof.reselect))), upload: round(Math.max(0, ...s.map((x) => x.terrain.prof.upload))), resolve: round(Math.max(0, ...s.map((x) => x.terrain.prof.resolve))) },
    };
    console.log(`[${tier}] ${name}: rebin ${phase.rebinMsMax} terrain ${JSON.stringify(phase.terrainMsMax)} ${phase.seconds}s, frame p50 ${phase.frameMs.p50} p99 ${phase.frameMs.p99} max ${phase.frameMs.max} ms, calls max ${phase.drawCalls.max}, tris max ${phase.triangles.max}, long tasks ${phase.longTasks.length} ${JSON.stringify(phase.longTaskAt)}, programs linked ${phase.programsLinked.length} ${JSON.stringify(phase.programsLinked).slice(0, 600)}, gen p95 ${round(phase.chunkGenMs.p95)} ms`);
    return phase;
  };

  await page.evaluate(() => {
    window.__lodestone.setFreezeTime(true);
    window.__lodestone.setTimeOfDay(0.42 * 3600); // ~10:00 (DAY_LENGTH_S = 3600)
  });

  // Phase 1: walk on the ground for 20 s (the "no pops at walking speed" case).
  const spawn = startStats.spawn;
  await page.evaluate(() => window.__lodestone.setLook(Math.PI * 0.25, -0.05));
  await begin();
  await page.keyboard.down('KeyW');
  await sleep(SHORT ? 2000 : 20000);
  await page.keyboard.up('KeyW');
  const walk = await end('walk');

  // Phase 2: fly the biome tour. Waypoints: one site per biome, nearest-first from spawn.
  const sites = await page.evaluate(() => window.__lodestoneWorld.sites());
  const order = ['forest', 'highlands', 'snowpeak', 'badlands', 'wetland', 'meadow'];
  const route = [];
  let cur = { x: spawn.x, z: spawn.z };
  for (const b of order) {
    const cands = sites.filter((s) => s.biome === b && !route.includes(s));
    if (!cands.length) continue;
    cands.sort((a, c) => Math.hypot(a.x - cur.x, a.z - cur.z) - Math.hypot(c.x - cur.x, c.z - cur.z));
    route.push(cands[0]);
    cur = cands[0];
  }
  await page.evaluate(() => window.__lodestone.setFly(true));
  await begin();
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft'); // 80 m/s: the streaming worst case (spec: farther ahead when gliding/sprinting)
  const legs = [];
  for (const wp of SHORT ? [] : route) {
    const legStart = Date.now();
    for (;;) {
      const p = (await page.evaluate(() => window.__lodestone.player())).pos;
      const dx = wp.x - p.x;
      const dz = wp.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 60 || Date.now() - legStart > 60000) break;
      const ground = await page.evaluate(([x, z]) => window.__lodestoneWorld.groundAt(x, z), [p.x + (dx / d) * 120, p.z + (dz / d) * 120]);
      const want = Math.max(ground, p.y - 200) + 40; // hold ~40 m above the terrain ahead
      const pitch = Math.max(-0.6, Math.min(0.6, Math.atan2(want - p.y, 150)));
      await page.evaluate(([y, pt]) => window.__lodestone.setLook(y, pt), [Math.atan2(-dx, -dz), pitch]);
      await sleep(100);
    }
    legs.push({ to: wp.biome, kind: wp.kind, x: Math.round(wp.x), z: Math.round(wp.z) });
  }
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  const fly = await end('fly');

  // Phase 3 (high): beauty shots. Wait for streaming to settle before each.
  const shots = [];
  if (tier === 'high' && process.env.LODESTONE_BENCH_SHOTS !== '0') {
    const settle = async () => {
      for (let i = 0; i < 80; i++) {
        const st = await page.evaluate(() => window.__lodestoneWorld.stats());
        if (st.terrain.queued + st.terrain.inFlight === 0 && st.terrain.missingWanted === 0) break;
        await sleep(250);
      }
      await sleep(1500);
    };
    const shoot = async (name, setup) => {
      await page.evaluate(setup);
      await settle();
      const file = `wp05-${name}.png`;
      // Clean frame: no debug HUD, no pointer-lock hint (headless never locks).
      await page.evaluate(() => {
        document.querySelector('[data-testid="debug-hud"]')?.setAttribute('style', 'display:none');
        for (const el of document.querySelectorAll('div')) if (el.childElementCount === 0 && /Click to look around/.test(el.textContent ?? '')) el.style.display = 'none';
      });
      await page.screenshot({ path: join(out, file) });
      shots.push(file);
      console.log(`[${tier}] screenshot ${file}`);
    };
    const pick = (biome, pred = () => true) => sites.filter((s) => s.biome === biome && pred(s)).sort((a, b) => Math.hypot(a.x - spawn.x, a.z - spawn.z) - Math.hypot(b.x - spawn.x, b.z - spawn.z))[0];
    const meadow = { x: spawn.x + 40, z: spawn.z + 30 };
    // Forest: the middle of the largest forest patch (forest settlements sit on clearings or coasts).
    const forest = await page.evaluate(() => window.__lodestoneWorld.biomeSpot(1));
    const snow = pick('snowpeak');
    const valley = pick('meadow', (s) => s.category === 'settlement' && Math.hypot(s.x - spawn.x, s.z - spawn.z) > 300) ?? pick('highlands');
    await page.evaluate(() => window.__lodestone.setFly(false));
    await shoot('meadow', `(() => { const L = window.__lodestone; L.setTimeOfDay(0.42 * 3600); L.teleport({ x: ${meadow.x}, z: ${meadow.z} }); L.setLook(${Math.PI * 0.75}, -0.02); })()`);
    if (forest) await shoot('forest', `(() => { const L = window.__lodestone; L.setTimeOfDay(0.4 * 3600); L.teleport({ x: ${forest.x}, z: ${forest.z} }); L.setLook(${Math.PI * 0.8}, 0.08); })()`);
    if (snow) await shoot('snowpeak', `(() => { const L = window.__lodestone; L.setFly(true); L.setTimeOfDay(0.4 * 3600); L.teleport({ x: ${snow.x - 250}, y: ${snow.y + 60}, z: ${snow.z + 250} }); L.setLook(${Math.atan2(250, -250)}, -0.12); })()`);
    if (valley) await shoot('valley-sunset', `(() => { const L = window.__lodestone; L.setFly(true); L.setTimeOfDay(0.738 * 3600); L.teleport({ x: ${valley.x + 200}, y: ${valley.y + 45}, z: ${valley.z} }); L.setLook(${Math.PI / 2}, -0.08); })()`);
    await shoot('dawn-fog', `(() => { const L = window.__lodestone; L.setFly(true); L.setTimeOfDay(0.27 * 3600); L.teleport({ x: ${spawn.x}, y: window.__lodestoneWorld.groundAt(${spawn.x}, ${spawn.z}) + 70, z: ${spawn.z} }); L.setLook(${-Math.PI / 2}, -0.15); })()`);
    await shoot('lod-tiles', `(() => { const L = window.__lodestone; L.setTimeOfDay(0.45 * 3600); L.setShowCells(true); L.teleport({ x: ${spawn.x}, y: window.__lodestoneWorld.groundAt(${spawn.x}, ${spawn.z}) + 180, z: ${spawn.z} }); L.setLook(0.3, -0.6); })()`);
    await page.evaluate(() => window.__lodestone.setShowCells(false));
    // Debug panel: regenerate the chunk under the player and compare hashes (spec 14 dev tool), via the real UI.
    await page.evaluate(() => {
      const L = window.__lodestone;
      L.setFly(false);
      L.setTimeOfDay(0.42 * 3600);
      L.setLook(0.5, -0.1);
      document.querySelector('[data-testid="debug-hud"]')?.removeAttribute('style');
    });
    await page.keyboard.press('Backquote');
    await page.click('[data-testid="world-debug"] button');
    await page.waitForSelector('[data-testid="regen-result"]', { timeout: 30000 });
    await sleep(500);
    await page.screenshot({ path: join(out, 'wp05-debug-panel.png') });
    shots.push('wp05-debug-panel.png');
    await page.keyboard.press('Backquote');
  }

  // Regenerate the chunk under the player and compare hashes (debug tool, spec 14).
  const regen = await page.evaluate(() => window.__lodestoneWorld.regenerateCurrentChunk());
  const final = await page.evaluate(() => window.__lodestoneWorld.stats());
  await browser.close();

  const downloadBytes = responses.reduce((a, r) => a + r.bytes, 0);
  const downloadGzip = responses.reduce((a, r) => a + (r.url.endsWith('.ktx2') || r.url.endsWith('.webp') || r.url.endsWith('.png') ? r.bytes : r.gzip), 0);
  const phases = [walk, fly];
  const gen = { p95: Math.max(walk.chunkGenMs.p95, fly.chunkGenMs.p95), max: Math.max(walk.chunkGenMs.max, fly.chunkGenMs.max), mean: round((walk.chunkGenMs.mean + fly.chunkGenMs.mean) / 2) };
  const longTasks = phases.flatMap((p) => p.longTasks);
  const result = {
    tier,
    when: new Date().toISOString(),
    url: base,
    renderer,
    viewport,
    vsync: !uncapped,
    loadMs,
    firstPlayableMs: final.firstPlayableMs,
    programsAtPlayable,
    load: startStats.load,
    textures: startStats.textures,
    download: { files: responses.length, bytes: downloadBytes, gzipBytes: downloadGzip, byType: summarize(responses) },
    route: legs,
    phases,
    regen,
    errors,
    budgets: {
      drawCalls: { budget: BUDGETS.drawCalls, max: Math.max(...phases.map((p) => p.drawCalls.max)), pass: phases.every((p) => p.drawCalls.max <= BUDGETS.drawCalls) },
      triangles: { budget: BUDGETS.triangles, maxAllPasses: Math.max(...phases.map((p) => p.triangles.max)), maxVisible: Math.max(...phases.map((p) => p.visibleTriangles.max)), pass: phases.every((p) => p.triangles.max <= BUDGETS.triangles) },
      longTasks: { budget: `none over ${BUDGETS.longTaskMs} ms`, count: longTasks.length, maxMs: Math.max(0, ...longTasks), pass: longTasks.length === 0 },
      heap: { budgetMB: BUDGETS.heapMB, maxMB: Math.max(...phases.map((p) => p.heapMB.max)), pass: phases.every((p) => p.heapMB.max <= BUDGETS.heapMB) },
      chunkGen: { budgetMs: BUDGETS.chunkGenMs, ...gen, pass: gen.p95 <= BUDGETS.chunkGenMs },
      download: { budgetMB: BUDGETS.downloadMB, gzipMB: round(downloadGzip / 1048576), pass: downloadGzip / 1048576 <= BUDGETS.downloadMB },
      frameTime: { budgetMs: BUDGETS.frameMs[tier], p99: Math.max(...phases.map((p) => p.frameMs.p99)), pass: phases.every((p) => p.frameMs.p99 <= BUDGETS.frameMs[tier] * 1.05), note: software ? 'software GL: not representative' : `measured on ${renderer}` },
    },
    shots,
  };
  if (!SHORT) writeFileSync(join(out, `${PREFIX}-traversal-${tier}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(`[${tier}] budgets`, JSON.stringify(result.budgets));
  return result;
}

function summarize(responses) {
  const by = {};
  for (const r of responses) {
    const ext = (r.url.split('?')[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? 'other').toLowerCase();
    by[ext] ??= { files: 0, bytes: 0, gzip: 0 };
    by[ext].files++;
    by[ext].bytes += r.bytes;
    by[ext].gzip += r.gzip;
  }
  return by;
}

const results = [];
for (const t of runTiers) results.push(await runTier(t));
const md = [
  '# WP05 traversal benchmark',
  '',
  `Generated by \`client/src/world/bench/traversal.mjs\` at ${new Date().toISOString()} against ${base}.`,
  '',
  '| Budget | ' + results.map((r) => `${r.tier} (${r.viewport.width}x${r.viewport.height})`).join(' | ') + ' |',
  '| --- | ' + results.map(() => '---').join(' | ') + ' |',
  ...['drawCalls', 'triangles', 'longTasks', 'heap', 'chunkGen', 'download', 'frameTime'].map((k) => `| ${k} | ` + results.map((r) => `${r.budgets[k].pass ? 'PASS' : 'FAIL'} ${JSON.stringify(r.budgets[k]).replace(/"/g, '').replace(/\|/g, '/')}`).join(' | ') + ' |'),
  '',
  ...results.map((r) => `- ${r.tier}: renderer ${r.renderer}; first playable ${Math.round(r.firstPlayableMs)} ms after navigation start; route ${r.route.map((l) => l.to).join(' -> ')}; regen hash ${r.regen?.match ? 'MATCH' : 'MISMATCH'}; page errors ${r.errors.length}`),
  '',
].join('\n');
if (!SHORT) writeFileSync(join(out, `${PREFIX}-traversal.md`), md);
console.log(md);
