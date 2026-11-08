#!/usr/bin/env node
// WP13 acceptance, networked half: build the zone and combatbots, start the
// zone on the official world (seed 20261108, real worldgen terrain, atlas
// camps and boss arenas), run the party of two, keep the evidence.
//
//   node server/zone/cmd/combatbots/acceptance.mjs [--out docs/evidence]
//
// Needs Go on PATH and worldgen/pkg/worldgen.wasm (npm run build:wasm). No
// Postgres/Redis: the zone runs with LODESTONE_ZONE_NO_DB/NO_REDIS and dev
// tickets.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const args = process.argv.slice(2);
const outDir = path.resolve(root, args[args.indexOf('--out') + 1] && args.includes('--out') ? args[args.indexOf('--out') + 1] : 'docs/evidence');
const exe = process.platform === 'win32' ? '.exe' : '';
const bin = path.join(root, 'bin');
fs.mkdirSync(bin, { recursive: true });

function build(pkg, out) {
  const r = spawnSync('go', ['-C', path.join(root, 'server', 'zone'), 'build', '-o', out, pkg], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
build('.', path.join(bin, `zone-wp13${exe}`));
build('./cmd/combatbots', path.join(bin, `combatbots${exe}`));

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
const zoneLog = [];
const zone = spawn(path.join(bin, `zone-wp13${exe}`), [], {
  cwd: root,
  env: {
    ...process.env,
    LODESTONE_ZONE_PORT: String(port),
    LODESTONE_ZONE_WT_ADDR: 'off',
    LODESTONE_ZONE_NO_DB: '1',
    LODESTONE_ZONE_NO_REDIS: '1',
    LODESTONE_ZONE_ID: 'zone-wp13',
    LODESTONE_WORLD_ID: 'world-wp13',
    LODESTONE_WORLD_SEED: '20261108',
    LODESTONE_GEN_VERSION: 'dev',
    LODESTONE_ZONE_REQUIRE_TERRAIN: '1',
    LODESTONE_ZONE_DEV_SPAWN: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const s of [zone.stdout, zone.stderr]) s.on('data', (b) => zoneLog.push(...b.toString().split('\n').filter(Boolean)));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 120; i++) {
  try {
    const r = await fetch(`${base}/debug/combat`);
    if (r.ok && (await r.json())) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
const bots = spawn(path.join(bin, `combatbots${exe}`), ['-url', `ws://127.0.0.1:${port}/ws`, '-out', path.join(outDir, 'wp13-party-clear.txt'), '-json', path.join(outDir, 'wp13-party-clear.json'), '-timeout', '20m'], { cwd: root, stdio: 'inherit' });
const code = await new Promise((r) => bots.on('exit', r));
try {
  const r = await fetch(`${base}/metrics`);
  fs.writeFileSync(path.join(outDir, 'wp13-party-clear-zone-metrics.txt'), (await r.text()).split('\n').filter((l) => /zone_(combat|tick_ms|client_kbps|players)/.test(l)).join('\n') + '\n');
} catch {}
zone.kill();
fs.writeFileSync(path.join(outDir, 'wp13-party-clear-zone.log'), zoneLog.filter((l) => /combat|join|leave|error|warn/i.test(l)).join('\n') + '\n');
process.exit(code ?? 1);
