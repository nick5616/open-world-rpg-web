// Smoke tests for a running deployment (WP18): used by the local rehearsal.
// Every check prints one ✓/✗ line; the function returns true only if all
// passed. Metric dumps and screenshots go to evidenceDir when given.
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, init = {}) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    return { status: res.status, headers: res.headers, text: await res.text() };
  } catch (e) {
    return { status: 0, headers: new Headers(), text: String(e.message ?? e) };
  }
}

async function waitFor(fn, timeoutMs, everyMs = 1000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last?.ok) return { ...last, ms: Date.now() - t0 };
    await sleep(everyMs);
  }
  return { ...(last ?? {}), ok: false, ms: Date.now() - t0 };
}

const metricValue = (text, name) => {
  for (const line of text.split('\n')) {
    if (line.startsWith(name + ' ') || line.startsWith(name + '{')) {
      const v = Number(line.slice(line.lastIndexOf(' ') + 1));
      if (!Number.isNaN(v)) return v;
    }
  }
  return null;
};

export async function smoke(r, { ports: P, metricsToken, browser = true, evidenceDir = null, compose }) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    r.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
    return ok;
  };
  const save = (file, body) => {
    if (!evidenceDir) return;
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, file), body);
  };
  const services = {
    director: `http://127.0.0.1:${P.director}`,
    account: `http://127.0.0.1:${P.account}`,
    creator: `http://127.0.0.1:${P.creator}`,
    zone: `http://127.0.0.1:${P.zoneHttp}`,
    social: `http://127.0.0.1:${P.socialHttp}`,
  };
  const auth = { headers: { Authorization: `Bearer ${metricsToken}` } };

  r.section('healthz on every service (first boot builds the atlas and mints the world)');
  for (const [name, base] of Object.entries(services)) {
    const h = await waitFor(async () => {
      const res = await get(`${base}/healthz`);
      return { ok: res.status === 200, body: res.text.trim() };
    }, 240000);
    check(`${name} /healthz`, h.ok, `${h.body ?? ''} (${(h.ms / 1000).toFixed(1)} s)`);
  }
  const edge = await waitFor(async () => {
    const res = await get(`http://127.0.0.1:${P.edge}/healthz`);
    return { ok: res.status === 200, body: res.text.trim() };
  }, 60000);
  check('caddy edge /healthz (the VM\'s public entry)', edge.ok, edge.body);
  const notExposed = await get(`http://127.0.0.1:${P.edge}/metrics`);
  check('edge does not expose /metrics', notExposed.status === 404, `HTTP ${notExposed.status}`);

  r.section('static builds (Netlify stand-in)');
  const index = await get(`http://127.0.0.1:${P.client}/`);
  check('client index.html', index.status === 200 && index.text.includes('<div id="root"'), `HTTP ${index.status}, ${index.text.length} bytes`);
  const asset = /\/assets\/[^"']+\.js/.exec(index.text)?.[0];
  if (asset) {
    const a = await get(`http://127.0.0.1:${P.client}${asset}`);
    check('client hashed asset is cached forever', a.status === 200 && (a.headers.get('cache-control') ?? '').includes('immutable'), `${asset} -> ${a.headers.get('cache-control')}`);
  } else check('client hashed asset found', false);
  const cw = await get(`http://127.0.0.1:${P.creatorWeb}/`);
  check('creator web index.html', cw.status === 200, `HTTP ${cw.status}`);
  const cfg = await get(`http://127.0.0.1:${P.creatorWeb}/v1/config`);
  check('creator /v1 proxied to the creator endpoint (Netlify _redirects stand-in)', cfg.status === 200 || cfg.status === 401, `HTTP ${cfg.status} ${cfg.text.slice(0, 120)}`);

  r.section('metrics (Prometheus text, guarded by LODESTONE_METRICS_TOKEN)');
  const scrape = async (name) => (await get(`${services[name]}/metrics`, auth)).text;
  for (const [name, base] of Object.entries(services)) {
    const anon = await get(`${base}/metrics`);
    check(`${name} /metrics without token refused`, anon.status === 401, `HTTP ${anon.status}`);
    const want = ['lodestone_build_info{', 'go_goroutines ', 'process_uptime_seconds ', 'http_requests_total{'];
    if (name === 'zone') want.push('zone_tick_ms{q="p99"}', 'zone_players ', 'zone_writebehind_depth ', 'zone_terrain_chunks');
    if (name === 'social') want.push('social_sessions');
    // The zone publishes its tick gauges once a second after start.
    let m;
    let missing;
    await waitFor(async () => {
      m = await get(`${base}/metrics`, auth);
      missing = want.filter((w) => !m.text.includes(w));
      return { ok: m.status === 200 && missing.length === 0 };
    }, 20000);
    save(`wp18-rehearsal-${name}-metrics-at-start.prom`, m.text);
    check(`${name} /metrics with token`, m.status === 200 && missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${m.text.split('\n').length} lines`);
  }

  if (browser) {
    r.section('browser: the production client build, end to end (headless Chromium)');
    let pw;
    try {
      pw = await import('playwright');
    } catch {
      check('playwright available (npm ci)', false);
      pw = null;
    }
    if (pw) {
      const b = await pw.chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
      const page = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e.message)));
      try {
        await page.goto(`http://localhost:${P.client}/?debug=1`);
        await page.getByTestId('play').click();
        // The fake provider boots for a few seconds: the waking screen shows.
        const waking = await page.getByTestId('waking-world').waitFor({ timeout: 8000 }).then(() => true, () => false);
        const states = [];
        if (waking) {
          states.push(await page.getByTestId('waking-world').getAttribute('data-state'));
          if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, 'wp18-rehearsal-waking.png') });
        }
        check('"waking the world" screen while the VM boots', waking, waking ? `state ${states[0]}` : 'not shown');
        const t0 = Date.now();
        await page.getByTestId('account-screen').waitFor({ timeout: 90000 });
        check('world awake, account screen shown', true, `${((Date.now() - t0) / 1000).toFixed(1)} s after the waking screen`);
        await page.getByTestId('auth-local').click();
        await page.getByTestId('char-name').waitFor({ timeout: 20000 });
        const name = 'Rehearsal' + Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 5);
        await page.getByTestId('char-name').fill(name);
        await page.getByTestId('char-create').click();
        await page.getByTestId(`play-${name}`).click();
        await page.waitForFunction(() => window.__lodestone?.netDebug?.()?.phase === 'playing', null, { timeout: 90000 });
        await sleep(4000);
        const d = await page.evaluate(() => {
          const n = window.__lodestone.netDebug();
          return { phase: n.phase, transport: n.transport, entityId: n.entityId, name: n.name, rttMs: n.rttMs, tick: n.tick, bytes: n.bytes };
        });
        check('client connected to the zone through the director ticket', d.phase === 'playing' && !!d.entityId, JSON.stringify(d));
        const hud = await page.getByTestId('debug-hud').innerText().catch(() => '');
        const netLine = hud.split('\n').find((l) => l.startsWith('net')) ?? '';
        const queueLine = hud.split('\n').find((l) => l.startsWith('chunk queue')) ?? '';
        const fps = await page.getByTestId('hud-fps').innerText().catch(() => '');
        check('debug HUD: fps, transport, RTT, bandwidth, chunk queue', /FPS/.test(fps) && /rtt \d/.test(netLine) && /kbps/.test(netLine) && /chunk queue \d/.test(queueLine), `${fps} | ${netLine} | ${queueLine}`);
        if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, 'wp18-rehearsal-playing.png') });
        const zm = await scrape('zone');
        save('wp18-rehearsal-zone-metrics.prom', zm);
        check('zone metrics see the player', metricValue(zm, 'zone_players') === 1 && (metricValue(zm, 'zone_bytes_out_total') ?? 0) > 0, `zone_players ${metricValue(zm, 'zone_players')}, zone_bytes_out_total ${metricValue(zm, 'zone_bytes_out_total')}`);
        const dm = await scrape('director');
        save('wp18-rehearsal-director-metrics.prom', dm);
        check('director woke the VM once and issued tickets', metricValue(dm, 'director_wake_starts_total') === 1 && dm.includes('director_tickets_issued_total{kind="local"}'), `director_wake_starts_total ${metricValue(dm, 'director_wake_starts_total')}`);
        for (const s of ['account', 'social', 'creator']) save(`wp18-rehearsal-${s}-metrics.prom`, await scrape(s));
        check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
      } catch (e) {
        check('browser flow', false, String(e.message ?? e).split('\n')[0]);
        if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, 'wp18-rehearsal-failure.png') }).catch(() => {});
      } finally {
        await b.close();
      }
    }
  } else {
    r.section('wake on demand (no browser)');
    const w = await waitFor(async () => {
      const res = await get(`${services.director}/v1/wake`, { method: 'POST' });
      let j = {};
      try {
        j = JSON.parse(res.text);
      } catch {
        /* not json */
      }
      r.log(`  /v1/wake -> ${res.text.trim()}`);
      return { ok: j.awake === true };
    }, 60000, 2000);
    check('director wakes the world', w.ok, `${(w.ms / 1000).toFixed(1)} s`);
  }

  r.section('containers');
  const ps = r.exec([...compose, 'ps', '--all', '--format', '{{.Service}}\t{{.State}}\t{{.Status}}'], { capture: true });
  for (const l of ps.stdout.trim().split('\n')) r.log(`  ${l}`);
  const failed = results.filter((x) => !x.ok);
  r.section(`smoke: ${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) r.log(`  ✗ ${f.name}`);
  return failed.length === 0;
}
