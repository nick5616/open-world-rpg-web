#!/usr/bin/env node
// `npm run infra:up` / `npm run infra:down`: just the Docker services.
import { mustRun } from './lib.mjs';

const cmd = process.argv[2];
if (cmd === 'up') mustRun('docker', ['compose', '-f', 'infra/docker-compose.yml', 'up', '-d', '--wait', 'postgres', 'redis']);
else if (cmd === 'down') mustRun('docker', ['compose', '-f', 'infra/docker-compose.yml', 'down']);
else {
  console.error('usage: infra.mjs up|down');
  process.exit(2);
}
