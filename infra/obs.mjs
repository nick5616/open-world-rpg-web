#!/usr/bin/env node
// `npm run infra:obs` / `npm run infra:obs:down`: local Prometheus (9390) and
// Grafana (3390) in their own compose project, "lodestone-obs" (WP18). They
// scrape `npm run dev` (8090-8094) and a kept rehearsal (28090-28094). `down`
// removes only the lodestone-obs project; the dev infra is never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mustRun, root, run } from '../scripts/lib.mjs';

const dir = path.join(root, 'infra', 'observability');
const compose = ['compose', '-p', 'lodestone-obs', '-f', path.join(dir, 'docker-compose.yml')];
const cmd = process.argv[2] ?? 'up';

if (cmd === 'up') {
  // A kept rehearsal guards /metrics with a random token; reuse it. Dev
  // services have no token and ignore the header.
  const rehearsalToken = path.join(os.tmpdir(), 'lodestone-rehearsal', 'metrics-token');
  const token = fs.existsSync(rehearsalToken) ? fs.readFileSync(rehearsalToken, 'utf8').trim() : 'none';
  fs.writeFileSync(path.join(dir, 'metrics-token'), token);
  // Docker Desktop on Windows sometimes still holds a just-released host port
  // ("Only one usage of each socket address"); one retry clears it.
  if (run('docker', [...compose, 'up', '-d']) !== 0) {
    await new Promise((r) => setTimeout(r, 3000));
    mustRun('docker', [...compose, 'up', '-d']);
  }
  console.log('Prometheus http://localhost:9390   Grafana http://localhost:3390 (dashboards: Lodestone overview, Lodestone cost per player)');
} else if (cmd === 'down') {
  mustRun('docker', [...compose, 'down', '-v']);
} else {
  console.error('usage: obs.mjs up|down');
  process.exit(2);
}
