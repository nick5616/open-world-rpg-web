#!/usr/bin/env node
// `npm run dev`: Postgres, Redis and LiveKit in Docker, migrations, every Go
// service, then the Vite client. `npm run dev:solo`: client + worldgen only,
// no servers (wizard-wars' dev:mock idea) for terrain and rendering work.
import { config, serviceEnv } from './config.mjs';
import { mustRun, start, killTree, waitHttp } from './lib.mjs';

const solo = process.argv.includes('--solo');
const children = [];

function shutdown() {
  for (const c of children) killTree(c);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const senv = serviceEnv();

if (!solo) {
  console.log('▶ infra (docker compose)');
  mustRun('docker', ['compose', '-f', 'infra/docker-compose.yml', 'up', '-d', '--wait', 'postgres', 'redis']);
  // LiveKit is started without --wait: its image has no healthcheck and voice
  // is optional for most work.
  mustRun('docker', ['compose', '-f', 'infra/docker-compose.yml', 'up', '-d', 'livekit']);
  console.log('▶ migrations');
  mustRun('go', ['run', './server/pkg/cmd/migrate'], { env: senv });

  const services = [
    ['account', config.accountPort],
    ['director', config.directorPort],
    ['zone', config.zonePort],
    ['social', config.socialPort],
  ];
  for (const [name] of services) children.push(start(name, 'go', ['run', `./server/${name}`], { env: senv }));
  for (const [name, port] of services) {
    const ok = await waitHttp(`http://localhost:${port}/healthz`, 120000);
    console.log(ok ? `✓ ${name} healthy on :${port}` : `✗ ${name} did not become healthy on :${port}`);
  }
}

children.push(
  start('client', 'npm', ['run', 'dev', '-w', 'client', '--', '--port', String(config.clientPort), '--strictPort'], {
    env: { ...senv, VITE_SOLO: solo ? '1' : '0', VITE_DIRECTOR_URL: `http://localhost:${config.directorPort}`, VITE_ACCOUNT_URL: `http://localhost:${config.accountPort}`, VITE_SOCIAL_URL: `ws://localhost:${config.socialPort}/ws`, VITE_ZONE_URL: `ws://localhost:${config.zonePort}/ws` },
  }),
);
console.log(`▶ client on http://localhost:${config.clientPort}${solo ? ' (solo)' : ''}`);
if (process.argv.includes('--smoke')) {
  // CI / gate check: bring everything up, verify health, tear down.
  const ok = await waitHttp(`http://localhost:${config.clientPort}/`, 120000);
  console.log(ok ? '✓ client serving' : '✗ client not serving');
  shutdown();
}
