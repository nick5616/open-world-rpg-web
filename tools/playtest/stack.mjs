#!/usr/bin/env node
/* global setInterval, clearInterval */
// A private stack for the playtest scripts: account, director, zone and
// social built from this checkout on random ports, a scratch database (a
// fresh world) on the shared local Postgres, and Vite. Prints the client URL
// for LODESTONE_CLIENT_URL and runs until Ctrl+C, SIGTERM, the stop file
// (<tmp>/stop, printed) appears, or --minutes runs out; then it stops every
// process and drops the database (--keep-db keeps it).
//
//   node tools/playtest/stack.mjs [--minutes 40] [--zone-env KEY=VALUE ...] [--keep-db]
//   LODESTONE_CLIENT_URL=<printed url> node tools/playtest/sp9.mjs tmp/playtest9
//
// Needs `npm run infra:up` (Postgres, Redis). Voice is not started.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { env, killTree, root, waitHttp } from '../../scripts/lib.mjs';

const args = process.argv.slice(2);
const H = '127.0.0.1';
const RUN = Date.now().toString(36);
const DB = `lodestone_wp04_pt${RUN}`; // devdb manages lodestone_wp04_* scratch databases only
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-stack-'));
const STOP = path.join(TMP, 'stop');
const EXE = process.platform === 'win32' ? '.exe' : '';
const minutes = +(args[args.indexOf('--minutes') + 1] || 40) || 40;
const zoneEnv = {};
args.forEach((a, i) => {
  if (a === '--zone-env') {
    const [k, ...v] = (args[i + 1] ?? '').split('=');
    if (k) zoneEnv[k] = v.join('=');
  }
});
const log = (m) => console.log(`[stack ${new Date().toISOString().slice(11, 19)}] ${m}`);

function goSync(a) {
  const r = spawnSync('go', a, { cwd: root, env: env(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`go ${a.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
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
const children = [];
let stopping = false;
function start(name, cmd, a, extra, cwd = root) {
  const out = fs.createWriteStream(path.join(TMP, `${name}.log`));
  const child = spawn(cmd, a, { cwd, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.on('exit', (code, sig) => {
    if (!stopping) log(`ERROR ${name} exited (${code ?? sig}); see ${path.join(TMP, name + '.log')}`);
  });
  children.push(child);
}
let dbMade = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  log('stopping');
  for (const c of children) killTree(c);
  await new Promise((r) => setTimeout(r, 800));
  if (dbMade && !args.includes('--keep-db')) {
    try {
      goSync(['run', './server/account/cmd/devdb', 'drop', DB]);
      log(`dropped ${DB}`);
    } catch (e) {
      log(`could not drop ${DB}: ${e.message}`);
    }
  }
  process.exit(code);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

try {
  const taken = new Set();
  const PORT = { account: await freePort(taken), director: await freePort(taken), zone: await freePort(taken), social: await freePort(taken), vite: await freePort(taken) };
  log(`ports ${JSON.stringify(PORT)}; logs in ${TMP}`);
  const pgUrl = goSync(['run', './server/account/cmd/devdb', 'create', DB]).trim().split('\n').pop();
  dbMade = true;
  log(`scratch database ${DB}`);
  const bin = (n) => path.join(TMP, `pt${RUN}-${n}${EXE}`);
  for (const [n, pkg] of [['account', './server/account'], ['director', './server/director'], ['zone', './server/zone'], ['social', './server/social']]) goSync(['build', '-o', bin(n), pkg]);
  log('built account, director, zone, social');
  const svc = { LODESTONE_PG_URL: pgUrl, LODESTONE_ACCOUNT_PORT: String(PORT.account), LODESTONE_DIRECTOR_PORT: String(PORT.director), LODESTONE_SOCIAL_PORT: String(PORT.social), LODESTONE_SOCIAL_URL: `ws://${H}:${PORT.social}/ws`, LODESTONE_DEV_AUTH: '1', LODESTONE_CORS_ORIGIN: '*' };
  start('account', bin('account'), [], svc);
  if (!(await waitHttp(`http://${H}:${PORT.account}/healthz`, 120000))) throw new Error('account not healthy');
  start('social', bin('social'), [], svc);
  start('director', bin('director'), [], svc);
  if (!(await waitHttp(`http://${H}:${PORT.director}/healthz`, 30000))) throw new Error('director not healthy');
  start('zone', bin('zone'), [], { ...svc, LODESTONE_ZONE_PORT: String(PORT.zone), LODESTONE_ZONE_ID: `zone-pt-${RUN}`, LODESTONE_ZONE_WT_ADDR: 'off', LODESTONE_ZONE_PUBLIC_URL: `ws://${H}:${PORT.zone}/ws`, ...zoneEnv });
  if (!(await waitHttp(`http://${H}:${PORT.zone}/healthz`, 120000))) throw new Error('zone not healthy');
  start('vite', process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT.vite), '--strictPort', '--host', H], { VITE_ACCOUNT_URL: `http://${H}:${PORT.account}`, VITE_DIRECTOR_URL: `http://${H}:${PORT.director}`, VITE_SOLO: '0' }, path.join(root, 'client'));
  if (!(await waitHttp(`http://${H}:${PORT.vite}/`, 90000))) throw new Error('vite not serving');
  await new Promise((r) => setTimeout(r, 6000)); // the zone's registry heartbeat reaches the director
  fs.writeFileSync(path.join(TMP, 'stack.json'), JSON.stringify({ PORT, DB, zone: `http://${H}:${PORT.zone}` }));
  log(`READY LODESTONE_CLIENT_URL=http://${H}:${PORT.vite} zone=http://${H}:${PORT.zone} stopfile=${STOP}`);
  const until = Date.now() + minutes * 60000;
  const timer = setInterval(() => {
    if (fs.existsSync(STOP) || Date.now() > until) {
      clearInterval(timer);
      stop();
    }
  }, 1000);
} catch (e) {
  log(`FAILED: ${e.message}`);
  await stop(1);
}
