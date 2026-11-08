#!/usr/bin/env node
// Decision 0005 measurement: 150 WP03 bots inside a 40 m disc (everyone in
// everyone's near ring, the case that blew the 160 kbps budget at ~530 kbps),
// run once with the per-client byte budget off and once at the default
// 150 kbps, on a private zone process (port 8097, no Postgres/Redis) so a
// running dev stack is left alone.
//
//   node tools/netsim/dense-budget.mjs [--duration 40s] [--n 150] [--budgets 0,150]
//
// Writes docs/evidence/wp06-dense-budget-<off|N>.{txt,json,prom} and prints a
// before/after table.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env, killTree, root, waitHttp } from '../../scripts/lib.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const duration = arg('duration', '40s');
const n = arg('n', '150');
const budgets = arg('budgets', '0,150').split(',').map(Number);
const PORT = Number(arg('port', '8097'));
const EXE = process.platform === 'win32' ? '.exe' : '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-wp06-budget-'));
const evidence = path.join(root, 'docs', 'evidence');

function build(name, pkg) {
  const out = path.join(tmp, name + EXE);
  const r = spawnSync('go', ['build', '-o', out, pkg], { cwd: root, env: env(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`go build ${pkg}: ${r.stderr}`);
  return out;
}

const zoneBin = build('zone', './server/zone');
const botsBin = build('bots', './tools/bots');
const results = [];
for (const budget of budgets) {
  const tag = budget > 0 ? String(budget) : 'off';
  const zone = spawn(zoneBin, [], {
    cwd: root,
    env: env({
      LODESTONE_ZONE_PORT: String(PORT),
      LODESTONE_ZONE_WT_ADDR: 'off',
      LODESTONE_ZONE_NO_DB: '1',
      LODESTONE_ZONE_NO_REDIS: '1',
      LODESTONE_ZONE_DOWN_BUDGET_KBPS: String(budget),
    }),
    stdio: 'ignore',
  });
  try {
    if (!(await waitHttp(`http://localhost:${PORT}/healthz`, 30000))) throw new Error('zone not healthy');
    const json = path.join(evidence, `wp06-dense-budget-${tag}.json`);
    const prom = path.join(evidence, `wp06-dense-budget-${tag}.prom`);
    console.log(`── budget ${tag}: ${n} bots, clustered radius 40 m, ${duration}`);
    const r = spawnSync(botsBin, ['-url', `ws://localhost:${PORT}/ws`, '-n', n, '-mode', 'clustered', '-radius', '40', '-duration', duration, '-json', json, '-metrics-out', prom], {
      cwd: root,
      env: env(),
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    });
    const text = `# node tools/netsim/dense-budget.mjs (zone LODESTONE_ZONE_DOWN_BUDGET_KBPS=${budget})\n${r.stdout}${r.stderr}`;
    fs.writeFileSync(path.join(evidence, `wp06-dense-budget-${tag}.txt`), text);
    process.stdout.write(r.stdout);
    const sum = JSON.parse(fs.readFileSync(json, 'utf8'));
    const metric = (name) => {
      const m = fs.readFileSync(prom, 'utf8').split('\n').find((l) => l.startsWith(name + ' '));
      return m ? Number(m.split(' ')[1]) : null;
    };
    results.push({ budget: tag, down: sum.downKbps, inView: sum.entitiesInView.avg, snapBytes: sum.snapshotBytes.avg, sent: metric('zone_budget_records_sent_total'), deferred: metric('zone_budget_records_deferred_total'), tickP99: metric('zone_tick_ms{q="p99"}') });
  } finally {
    killTree(zone);
  }
}

console.log('\nbudget | down avg | down max | in view | snapshot B | records sent / deferred | tick p99 ms');
for (const r of results) {
  console.log(`${r.budget.padEnd(6)} | ${r.down.avg.toFixed(1).padStart(8)} | ${r.down.max.toFixed(1).padStart(8)} | ${r.inView.toFixed(1).padStart(7)} | ${r.snapBytes.toFixed(0).padStart(10)} | ${r.sent ?? '-'} / ${r.deferred ?? '-'} | ${r.tickP99 ?? '-'}`);
}
fs.writeFileSync(path.join(evidence, 'wp06-dense-budget-summary.json'), JSON.stringify(results, null, 2) + '\n');
