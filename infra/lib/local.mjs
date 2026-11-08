// Local rehearsal of the production deployment (WP18): proves "a clean clone
// deploys everything with one script" without a cloud account.
//
// It builds the production images exactly as the real deploy does, writes a
// production-shaped .env (freshly generated keys, LODESTONE_ENV=production,
// no dev auth), and runs infra/vm/docker-compose.vm.yml (the VM, unchanged)
// plus infra/rehearsal/docker-compose.rehearsal.yml (the Cloud Run and
// Netlify pieces as containers) under its own compose project
// "lodestone-rehearsal" on its own ports and volumes. Then it smoke-tests
// every service (healthz, metrics with and without the metrics token), the
// wake-on-demand flow (fake provider), and a headless browser that plays
// through the production client build: waking screen, local profile,
// character, director ticket, zone connection. Finally it tears down only
// its own project.
//
// Never touches the dev infra (compose project "lodestone", volumes pgdata
// etc.): every compose command names -p lodestone-rehearsal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root } from '../../scripts/lib.mjs';
import { gitSha, rehearsal } from './config.mjs';
import { buildClient, buildCreator, buildImages, buildWasm, SERVICES } from './build.mjs';
import { generate, secretSpecs } from './secrets.mjs';
import { smoke } from './smoke.mjs';

const PROJECT = rehearsal.project;

export async function rehearse(r, flags) {
  if (PROJECT === 'lodestone') throw new Error('refusing: the rehearsal must not use the dev compose project name');
  const P = rehearsal.ports;
  const tag = `rehearsal-${gitSha()}`;
  const stage = path.join(os.tmpdir(), 'lodestone-rehearsal');
  const compose = ['docker', 'compose', '-p', PROJECT, '-f', path.join(stage, 'docker-compose.yml'), '-f', path.join(stage, 'docker-compose.rehearsal.yml')];

  r.log(`Lodestone deploy: target local (rehearsal), project ${PROJECT}, tag ${tag}`);
  r.section('preflight');
  if (!r.check(['docker', 'version', '--format', '{{.Server.Version}}'])) throw new Error('Docker is not running');
  r.check(['docker', 'compose', 'version', '--short']);

  if (!flags['skip-build']) {
    buildWasm(r);
    buildImages(r, { registry: rehearsal.registry, tag });
    buildClient(r, { VITE_DIRECTOR_URL: `http://localhost:${P.director}`, VITE_ACCOUNT_URL: `http://localhost:${P.account}`, VITE_WORLD_SEED: '20261108' });
    buildCreator(r);
  } else {
    r.note('--skip-build: reusing images and static builds from the last rehearsal');
  }

  r.section(`stage ${stage} (the VM's /opt/lodestone, plus the rehearsal overlay)`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const copies = [
    ['infra/vm/docker-compose.vm.yml', 'docker-compose.yml'],
    ['infra/vm/Caddyfile', 'Caddyfile'],
    ['infra/vm/prometheus.vm.yml', 'prometheus.vm.yml'],
    ['infra/rehearsal/docker-compose.rehearsal.yml', 'docker-compose.rehearsal.yml'],
    ['infra/rehearsal/Caddyfile.static', 'Caddyfile.static'],
  ];
  for (const [from, to] of copies) {
    fs.copyFileSync(path.join(root, from), path.join(stage, to));
    r.note(`${from} -> ${to}`);
  }
  // Production-format secrets, generated fresh for this throwaway stack.
  const specs = secretSpecs().filter((s) => !s.external);
  const values = generate(specs);
  const secretEnv = Object.fromEntries(specs.map((s) => [s.env, values[s.name]]));
  const env = {
    LODESTONE_ENV: 'production',
    LODESTONE_TAG: tag,
    LODESTONE_REGISTRY: rehearsal.registry,
    LODESTONE_GAME_HOST: 'localhost',
    LODESTONE_PUBLIC_WS_SCHEME: 'ws',
    LODESTONE_PUBLIC_HTTP_PORT_SUFFIX: `:${P.edge}`,
    LODESTONE_SITE_ADDRESS: 'http://:80',
    LODESTONE_CORS_ORIGIN: `http://localhost:${P.client}`,
    LODESTONE_FIREBASE_PROJECT_ID: 'lodestone-rehearsal',
    LODESTONE_WORLD_SEED: '20261108',
    LODESTONE_ZONE_ID: 'zone-1',
    LODESTONE_LIVEKIT_EXTERNAL_IP: 'false',
    LODESTONE_PUBLIC_BIND: '127.0.0.1', // the VM's public ports, kept off the LAN here
    // Host ports: the edge and WebTransport like the VM's public ports, the
    // rest bound to 127.0.0.1 like the VM's VPC-only ports.
    LODESTONE_CADDY_HTTP_PUBLISH: String(P.edge),
    LODESTONE_CADDY_HTTPS_PUBLISH: `127.0.0.1:${P.caddyHttps}`,
    LODESTONE_ZONE_WT_PUBLISH: String(P.zoneWt),
    LODESTONE_ZONE_HTTP_PUBLISH: `127.0.0.1:${P.zoneHttp}`,
    LODESTONE_SOCIAL_HTTP_PUBLISH: `127.0.0.1:${P.socialHttp}`,
    LODESTONE_PG_PUBLISH: `127.0.0.1:${P.pg}`,
    LODESTONE_REDIS_PUBLISH: `127.0.0.1:${P.redis}`,
    LODESTONE_LIVEKIT_TCP_PUBLISH: `127.0.0.1:${P.livekitTcp}`,
    LODESTONE_LIVEKIT_UDP_PUBLISH: `127.0.0.1:${P.livekitUdp}`,
    LODESTONE_DIRECTOR_PUBLISH: String(P.director),
    LODESTONE_ACCOUNT_PUBLISH: String(P.account),
    LODESTONE_CREATOR_PUBLISH: String(P.creator),
    LODESTONE_CLIENT_PUBLISH: String(P.client),
    LODESTONE_CREATOR_WEB_PUBLISH: String(P.creatorWeb),
    LODESTONE_CLIENT_DIST: path.join(root, 'client', 'dist'),
    LODESTONE_CREATOR_DIST: path.join(root, 'tools', 'creator', 'dist'),
    ...secretEnv,
  };
  fs.writeFileSync(path.join(stage, '.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(stage, 'metrics-token'), secretEnv.LODESTONE_METRICS_TOKEN);
  r.note('.env: LODESTONE_ENV=production, generated Ed25519 keys and tokens (values not shown), rehearsal ports');

  r.section(`up (compose project ${PROJECT})`);
  // Leftovers from an interrupted rehearsal: own project only.
  r.run([...compose, 'down', '-v', '--remove-orphans'], { allowFail: true });
  r.run([...compose, 'up', '-d']);

  let ok = false;
  try {
    ok = await smoke(r, { ports: P, metricsToken: secretEnv.LODESTONE_METRICS_TOKEN, browser: flags.browser !== 'false', evidenceDir: flags['evidence-dir'] ?? null, compose });
  } finally {
    r.section('logs (last lines per service)');
    for (const s of [...SERVICES, 'mint', 'migrate', 'caddy']) {
      const out = r.exec([...compose, 'logs', '--no-color', '--tail', '6', s], { capture: true });
      for (const l of (out.stdout || '').trim().split('\n').filter(Boolean)) r.log(`  ${l.length > 220 ? l.slice(0, 220) + '…' : l}`);
    }
    if (flags.keep) {
      r.section('kept running (--keep)');
      r.note(`stop with: docker compose -p ${PROJECT} -f ${path.join(stage, 'docker-compose.yml')} -f ${path.join(stage, 'docker-compose.rehearsal.yml')} down -v`);
      r.note(`client http://localhost:${P.client}/?debug=1   creator http://localhost:${P.creatorWeb}   metrics: Bearer token in ${path.join(stage, 'metrics-token')}`);
    } else {
      r.section(`teardown (only compose project ${PROJECT}, its containers and volumes)`);
      r.run([...compose, 'down', '-v', '--remove-orphans'], { allowFail: true });
    }
  }
  r.log('');
  r.log(ok ? '✓ rehearsal PASS: every service healthy, metrics exported, a browser played through the production build' : '✗ rehearsal FAILED (see above)');
  return ok;
}
