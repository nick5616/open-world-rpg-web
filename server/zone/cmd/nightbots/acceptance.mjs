#!/usr/bin/env node
// WP15 acceptance, networked: build the zone and nightbots, start the zone
// on the official world (seed 20261108, real worldgen terrain and towns) with
// the world clock set to 22:00, and run
//   1. demon:   ordinary steel vs sunsteel vs sunrise (one bot)
//   2. defense: a town defense event start to finish with two bots
// keeping logs, summaries and zone logs in docs/evidence/wp15-*.
//
//   node server/zone/cmd/nightbots/acceptance.mjs [--only demon|defense]
//
// Needs Go on PATH and worldgen/pkg/worldgen.wasm (npm run build:wasm). No
// Postgres/Redis (LODESTONE_ZONE_NO_DB/NO_REDIS) and dev tickets.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const outDir = path.join(root, 'docs', 'evidence');
const exe = process.platform === 'win32' ? '.exe' : '';
const bin = path.join(root, 'bin');
fs.mkdirSync(bin, { recursive: true });

function build(pkg, out) {
  const r = spawnSync('go', ['-C', path.join(root, 'server', 'zone'), 'build', '-o', out, pkg], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
build('.', path.join(bin, `zone-wp15${exe}`));
build('./cmd/nightbots', path.join(bin, `nightbots${exe}`));

const freePort = () =>
  new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

// World clock offset so that the zone starts at hour h (an in-game hour is 150 s).
function offsetForHour(h) {
  const tod = (Date.now() / 1000) % 3600;
  return Math.round((((h * 150 - tod) % 3600) + 3600) % 3600);
}

async function scenario(name, extraEnv) {
  const port = await freePort();
  const zoneLog = [];
  const zone = spawn(path.join(bin, `zone-wp15${exe}`), [], {
    cwd: root,
    env: {
      ...process.env,
      LODESTONE_ZONE_PORT: String(port),
      LODESTONE_ZONE_WT_ADDR: 'off',
      LODESTONE_ZONE_NO_DB: '1',
      LODESTONE_ZONE_NO_REDIS: '1',
      LODESTONE_ZONE_ID: `zone-wp15-${name}`,
      LODESTONE_WORLD_ID: `world-wp15-${name}`,
      LODESTONE_WORLD_SEED: '20261108',
      LODESTONE_GEN_VERSION: 'dev',
      LODESTONE_ZONE_REQUIRE_TERRAIN: '1',
      LODESTONE_ZONE_DEV_SPAWN: '1',
      LODESTONE_ZONE_DEV_NIGHT: '1',
      LODESTONE_ZONE_DEV_COMBAT: '1', // dev sunsteel (Interact 50 action 6) until WP14 equips forged items
      LODESTONE_ZONE_TIME_OFFSET_S: String(offsetForHour(22)),
      LODESTONE_ZONE_DEBUG_RAIN: '0',
      LODESTONE_ZONE_NO_ATLAS_ENEMIES: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const s of [zone.stdout, zone.stderr]) s.on('data', (b) => zoneLog.push(...b.toString().split('\n').filter(Boolean)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`${base}/debug/night`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const bots = spawn(path.join(bin, `nightbots${exe}`), ['-url', `ws://127.0.0.1:${port}/ws`, '-scenario', name, '-out', path.join(outDir, `wp15-${name}.txt`), '-json', path.join(outDir, `wp15-${name}.json`)], { cwd: root, stdio: 'inherit' });
  const code = await new Promise((r) => bots.on('exit', r));
  try {
    const r = await fetch(`${base}/metrics`);
    fs.writeFileSync(path.join(outDir, `wp15-${name}-zone-metrics.txt`), (await r.text()).split('\n').filter((l) => /zone_(combat|tick_ms|client_kbps|players)/.test(l)).join('\n') + '\n');
  } catch {}
  zone.kill();
  fs.writeFileSync(path.join(outDir, `wp15-${name}-zone.log`), zoneLog.filter((l) => /night|dusk|dawn|defense|demon|clock|material|join|leave|error|warn/i.test(l)).join('\n') + '\n');
  return code;
}

let fails = 0;
if (!only || only === 'demon') fails += (await scenario('demon', { LODESTONE_ZONE_NO_DEMONS: '1' })) ? 1 : 0;
if (!only || only === 'defense') fails += (await scenario('defense', {})) ? 1 : 0;
process.exit(fails ? 1 : 0);
