#!/usr/bin/env node
// Playtest 2 co-op playthrough driver: one headless Chromium with two
// isolated players (two browser contexts), kept alive while a person (or an
// agent) plays them step by step. Commands arrive over a local HTTP port as
// the body of an async function `(A, B, H, S, log)`: A and B are the two
// Playwright pages, H the helpers in coop-helpers.mjs (re-imported on every
// call, so they can be edited mid-run), S a state object that lives as long
// as the driver, log(msg) a timestamped line in the play log.
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1 --minutes 600
//   LODESTONE_CLIENT_URL=<url> node tools/playtest/coop-driver.mjs [--port 47123] [--out tmp/coop]
//   node tools/playtest/coop-send.mjs 'return await H.status(A, B)'
//
// POST /run {code}     -> {ok, value, ms} | {ok:false, error}
// POST /quit           -> closes the browser and exits
import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(new URL('../../client/package.json', import.meta.url));
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const PORT = +opt('--port', '47123');
const OUT = opt('--out', 'tmp/coop');
const W = +opt('--width', '960');
const Hh = +opt('--height', '540');
mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'play.log');
const t0 = Date.now();
const stamp = () => {
  const s = Math.round((Date.now() - t0) / 1000);
  return `${new Date().toISOString().slice(11, 19)} +${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};
const log = (m) => {
  const line = `[${stamp()}] ${m}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
};

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: W, height: Hh } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(`${who} PAGEERROR ${e.message.slice(0, 300)}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket|net::ERR/.test(m.text())) appendFileSync(path.join(OUT, `console-${who}.log`), `[${stamp()}] ${m.text().slice(0, 400)}\n`);
  });
  page.__who = who;
  return page;
};
const A = await mk('A');
const B = await mk('B');
const S = { t0 };
const here = path.dirname(fileURLToPath(import.meta.url));
const helpersUrl = pathToFileURL(path.join(here, 'coop-helpers.mjs')).href;
let busy = false;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const reply = (o) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o, null, 1));
    };
    if (req.url === '/quit') {
      reply({ ok: true });
      log('driver quit');
      await browser.close().catch(() => {});
      process.exit(0);
    }
    if (req.url === '/abort') {
      globalThis.__coopAbort = true;
      log('abort requested');
      return reply({ ok: true, busy });
    }
    if (busy) return reply({ ok: false, error: 'busy' });
    busy = true;
    globalThis.__coopAbort = false;
    const started = Date.now();
    try {
      const { code } = JSON.parse(body);
      const H = await import(`${helpersUrl}?v=${Date.now()}`);
      const fn = new Function('A', 'B', 'H', 'S', 'log', `return (async () => { ${code} })();`);
      const value = await fn(A, B, H, S, log);
      reply({ ok: true, ms: Date.now() - started, value });
    } catch (e) {
      reply({ ok: false, ms: Date.now() - started, error: String(e?.stack ?? e).slice(0, 2000) });
    } finally {
      busy = false;
    }
  });
});
server.timeout = 0;
server.requestTimeout = 0;
server.listen(PORT, '127.0.0.1', () => log(`driver ready on 127.0.0.1:${PORT}, client ${process.env.LODESTONE_CLIENT_URL}`));
