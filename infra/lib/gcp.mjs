// The real deployment (spec 13, WP18): GCP for the services, Netlify for the
// static builds. Every step is idempotent (probe, then create only what is
// missing) so the same command bootstraps a fresh project and redeploys a
// running one. In --dry-run nothing is executed, not even the probes: the
// transcript is the full plan for an empty project.
//
//   Cloud Run (min instances 0)   director, account, creator endpoint
//   One GCE VM, started on demand zone, social, LiveKit, Postgres, Redis, Caddy
//   Secret Manager                every key and password (generated once)
//   Cloud Storage                 nightly + on-stop Postgres dumps; worldgen
//                                 wasm by content hash, immutable, kept forever
//   Cloud Scheduler               the director's idle check every 5 minutes
//   Netlify                       client and creator static builds
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root } from '../../scripts/lib.mjs';
import { buildClient, buildCreator, buildImages, buildWasm, pushImages, wasmManifest, writeCreatorRedirects } from './build.mjs';
import { generate, secretSpecs } from './secrets.mjs';

const APIS = [
  'run.googleapis.com',
  'compute.googleapis.com',
  'artifactregistry.googleapis.com',
  'secretmanager.googleapis.com',
  'cloudscheduler.googleapis.com',
  'storage.googleapis.com',
  'iam.googleapis.com',
  'iap.googleapis.com',
];

// Who reads which secret (least privilege per service account).
function secretConsumers(cfg) {
  const { vm, run, director } = cfg.sa;
  return {
    'lodestone-ticket-private-key': [director],
    'lodestone-ticket-public-key': [vm],
    'lodestone-session-private-key': [run],
    'lodestone-session-public-key': [director],
    'lodestone-save-private-key': [run, vm],
    'lodestone-save-public-key': [director, vm],
    'lodestone-pg-password': [vm],
    'lodestone-pg-url': [run, director],
    'lodestone-livekit-key': [vm],
    'lodestone-livekit-secret': [vm],
    'lodestone-wake-cron-token': [director],
    'lodestone-metrics-token': [vm, run, director],
    'lodestone-creator-token': [run],
    'lodestone-anthropic-api-key': cfg.creatorLLM ? [run] : [],
  };
}

export const STEPS = ['preflight', 'apis', 'registry', 'accounts', 'network', 'secrets', 'buckets', 'build', 'wasm', 'vm', 'run', 'scheduler', 'netlify'];

export function deployGcp(r, cfg, { only } = {}) {
  const want = (s) => !only || only.includes(s);
  const P = ['--project', cfg.projectOrPlaceholder];
  const R = ['--region', cfg.region];
  const Z = ['--zone', cfg.zone];
  const out = { urls: {} };
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-deploy-'));

  // Values later steps need; real queries outside dry run, placeholders in it.
  const clientOrigin = process.env.LODESTONE_CLIENT_ORIGIN ?? `https://${cfg.netlify.clientSite}.netlify.app`;
  const creatorOrigin = process.env.LODESTONE_CREATOR_ORIGIN ?? `https://${cfg.netlify.creatorSite}.netlify.app`;
  let externalIp = '203.0.113.10';
  let internalIp = '10.128.0.50';

  if (want('preflight')) {
    r.section('preflight (local tools; no cloud calls)');
    let ok = r.check(['gcloud', '--version']);
    ok = r.check(['netlify', '--version']) && ok;
    ok = r.check(['docker', 'version', '--format', '{{.Server.Version}}']) && ok;
    if (!ok && !r.dryRun) throw new Error('missing tools: install gcloud, netlify-cli and Docker (infra/README.md "Prerequisites")');
    r.note(`project ${cfg.projectOrPlaceholder}, region ${cfg.region}, zone ${cfg.zone}, tag ${cfg.tag}`);
    r.note('gcloud configuration is never changed: every command passes --project explicitly.');
  }

  if (want('apis')) {
    r.section('enable APIs');
    r.run(['gcloud', 'services', 'enable', ...APIS, ...P]);
  }

  if (want('registry')) {
    r.section('Artifact Registry (docker images)');
    if (!r.probe(['gcloud', 'artifacts', 'repositories', 'describe', cfg.repo, '--location', cfg.region, ...P])) {
      r.run(['gcloud', 'artifacts', 'repositories', 'create', cfg.repo, '--repository-format', 'docker', '--location', cfg.region, '--description', 'Lodestone service images', ...P]);
    }
  }

  if (want('accounts')) {
    r.section('service accounts and the VM power role');
    for (const [id, title] of [
      ['lodestone-vm', 'Lodestone game VM'],
      ['lodestone-run', 'Lodestone Cloud Run (account, creator)'],
      ['lodestone-director', 'Lodestone director (wakes the game VM)'],
    ]) {
      const email = `${id}@${cfg.projectOrPlaceholder}.iam.gserviceaccount.com`;
      if (!r.probe(['gcloud', 'iam', 'service-accounts', 'describe', email, ...P])) {
        r.run(['gcloud', 'iam', 'service-accounts', 'create', id, '--display-name', title, ...P]);
      }
    }
    for (const role of ['roles/logging.logWriter', 'roles/monitoring.metricWriter']) {
      r.run(['gcloud', 'projects', 'add-iam-policy-binding', cfg.projectOrPlaceholder, '--member', `serviceAccount:${cfg.sa.vm}`, '--role', role, '--condition', 'None', '--quiet']);
    }
    r.run(['gcloud', 'artifacts', 'repositories', 'add-iam-policy-binding', cfg.repo, '--location', cfg.region, '--member', `serviceAccount:${cfg.sa.vm}`, '--role', 'roles/artifactregistry.reader', ...P]);
    // The director may get/start/stop/resume exactly one instance: a custom
    // role bound on the instance itself (vm step), not project-wide.
    if (!r.probe(['gcloud', 'iam', 'roles', 'describe', 'lodestoneVmPower', ...P])) {
      r.run(['gcloud', 'iam', 'roles', 'create', 'lodestoneVmPower', ...P, '--title', 'Lodestone VM power', '--description', 'Start and stop the Lodestone game VM (wake on demand)', '--permissions', 'compute.instances.get,compute.instances.start,compute.instances.stop,compute.instances.resume', '--stage', 'GA']);
    }
  }

  if (want('network') || want('secrets') || want('vm') || want('run')) {
    r.section('network: static addresses and firewall');
    const extIpCmd = ['gcloud', 'compute', 'addresses', 'describe', cfg.vm.externalIp, ...R, ...P];
    if (want('network') && !r.probe(extIpCmd)) r.run(['gcloud', 'compute', 'addresses', 'create', cfg.vm.externalIp, ...R, ...P]);
    externalIp = r.output([...extIpCmd, '--format', 'value(address)'], externalIp);
    const intIpCmd = ['gcloud', 'compute', 'addresses', 'describe', cfg.vm.internalIp, ...R, ...P];
    if (want('network') && !r.probe(intIpCmd)) r.run(['gcloud', 'compute', 'addresses', 'create', cfg.vm.internalIp, ...R, '--subnet', cfg.subnet, ...P]);
    internalIp = r.output([...intIpCmd, '--format', 'value(address)'], internalIp);
    if (want('network')) {
      const rules = [
        ['lodestone-game-public', ['--rules', 'tcp:80,tcp:443,udp:443,udp:4433,tcp:7881,udp:7882', '--source-ranges', '0.0.0.0/0'], 'browsers: Caddy (wss), WebTransport, LiveKit media'],
        ['lodestone-game-internal', ['--rules', 'tcp:5432,tcp:6379,tcp:8092,tcp:8093', '--source-tags', cfg.runTag], 'Cloud Run (Direct VPC egress, network tag) -> Postgres, Redis, zone/social health+metrics'],
        ['lodestone-game-iap-ssh', ['--rules', 'tcp:22', '--source-ranges', '35.235.240.0/20'], 'gcloud compute ssh --tunnel-through-iap (deploy updates)'],
      ];
      for (const [name, args, why] of rules) {
        r.note(`${name}: ${why}`);
        if (!r.probe(['gcloud', 'compute', 'firewall-rules', 'describe', name, ...P])) {
          r.run(['gcloud', 'compute', 'firewall-rules', 'create', name, '--network', cfg.network, '--direction', 'INGRESS', '--action', 'ALLOW', ...args, '--target-tags', cfg.vm.tag, ...P]);
        }
      }
    }
  }
  const gameHost = cfg.gameHost ?? `${externalIp.replace(/\./g, '-')}.sslip.io`;
  out.gameHost = gameHost;

  if (want('secrets')) {
    r.section('Secret Manager (generated once, never rotated by a deploy)');
    const specs = secretSpecs();
    const exists = {};
    for (const s of specs) exists[s.name] = r.probe(['gcloud', 'secrets', 'describe', s.name, ...P]);
    exists['lodestone-pg-url'] = r.probe(['gcloud', 'secrets', 'describe', 'lodestone-pg-url', ...P]);
    // A key pair is created together or not at all: half a pair would mean
    // tickets nobody can verify.
    const byPair = {};
    for (const s of specs) if (s.pair) (byPair[s.pair] ??= []).push(s);
    for (const [pair, halves] of Object.entries(byPair)) {
      const have = halves.filter((h) => exists[h.name]).length;
      if (have === 1) throw new Error(`secret pair "${pair}" is half present; delete the remaining half or add the other one by hand (${halves.map((h) => h.name).join(', ')})`);
    }
    const missing = specs.filter((s) => !s.external && !exists[s.name]);
    const values = generate(missing);
    for (const s of missing) {
      r.run(['gcloud', 'secrets', 'create', s.name, '--replication-policy', 'automatic', '--data-file=-', ...P], { input: values[s.name] });
    }
    if (!exists['lodestone-pg-url']) {
      const pw = values['lodestone-pg-password'] ?? r.output(['gcloud', 'secrets', 'versions', 'access', 'latest', '--secret', 'lodestone-pg-password', ...P], '<pg-password>');
      r.note(`lodestone-pg-url = postgres://lodestone:<pg-password>@${internalIp}:5432/lodestone?sslmode=disable (VPC-internal)`);
      r.run(['gcloud', 'secrets', 'create', 'lodestone-pg-url', '--replication-policy', 'automatic', '--data-file=-', ...P], { input: `postgres://lodestone:${pw}@${internalIp}:5432/lodestone?sslmode=disable` });
    }
    for (const [name, members] of Object.entries(secretConsumers(cfg))) {
      if (name === 'lodestone-anthropic-api-key' && cfg.creatorLLM && !exists[name]) {
        r.manual('add the Anthropic API key (creator vibe path, LODESTONE_CREATOR_LLM=1)', [
          'The key is never generated or committed. In a shell with the key in $ANTHROPIC_API_KEY run:',
          `  printf %s "$ANTHROPIC_API_KEY" | gcloud secrets create lodestone-anthropic-api-key --replication-policy automatic --data-file=- --project ${cfg.projectOrPlaceholder}`,
          'then re-run the deploy (or deploy without --creator-llm; the vibe path stays off).',
        ]);
        if (!r.dryRun) continue;
      }
      for (const m of members) {
        r.run(['gcloud', 'secrets', 'add-iam-policy-binding', name, '--member', `serviceAccount:${m}`, '--role', 'roles/secretmanager.secretAccessor', ...P, '--quiet']);
      }
    }
  }

  if (want('buckets')) {
    r.section('Cloud Storage: Postgres backups, worldgen wasm archive');
    const bb = `gs://${cfg.backupBucket}`;
    if (!r.probe(['gcloud', 'storage', 'buckets', 'describe', bb, ...P])) {
      r.run(['gcloud', 'storage', 'buckets', 'create', bb, '--location', cfg.region, '--uniform-bucket-level-access', '--public-access-prevention', ...P]);
    }
    r.note('backups: timestamped dumps deleted after 60 days; pg/latest.sql.gz is overwritten, never deleted');
    r.run(['gcloud', 'storage', 'buckets', 'update', bb, '--lifecycle-file', 'infra/gcp/backup-lifecycle.json', ...P]);
    r.run(['gcloud', 'storage', 'buckets', 'add-iam-policy-binding', bb, '--member', `serviceAccount:${cfg.sa.vm}`, '--role', 'roles/storage.objectAdmin', ...P]);
    const wb = `gs://${cfg.wasmBucket}`;
    if (!r.probe(['gcloud', 'storage', 'buckets', 'describe', wb, ...P])) {
      r.run(['gcloud', 'storage', 'buckets', 'create', wb, '--location', cfg.region, '--uniform-bucket-level-access', ...P]);
    }
    r.note('worldgen archive: public read, CORS for browsers, no lifecycle rule (kept forever)');
    const pub = r.run(['gcloud', 'storage', 'buckets', 'add-iam-policy-binding', wb, '--member', 'allUsers', '--role', 'roles/storage.objectViewer', ...P], { allowFail: true });
    if (pub.code !== 0) {
      r.manual('make the worldgen bucket publicly readable', [
        'An organization policy (Domain Restricted Sharing) refused allUsers. Either:',
        `  console: IAM & Admin > Organization Policies > "Domain restricted sharing" > Manage policy > Override > Allow All (project ${cfg.projectOrPlaceholder}), then re-run; or`,
        '  skip it: pinned worlds still load their generator from the client build; the archive is then private.',
      ]);
    }
    r.run(['gcloud', 'storage', 'buckets', 'update', wb, '--cors-file', 'infra/gcp/wasm-cors.json', ...P]);
  }

  let refs = null;
  if (want('build')) {
    buildWasm(r);
    refs = buildImages(r, { registry: cfg.registry, tag: cfg.tag });
    r.run(['gcloud', 'auth', 'configure-docker', cfg.registryHost, '--quiet']);
    pushImages(r, refs);
  }

  if (want('wasm')) {
    r.section('publish worldgen wasm by content hash (immutable, never overwritten)');
    const m = wasmManifest() ?? { file: 'worldgen-<sha256:16>.wasm', sha256: '<sha256>' };
    const dest = `gs://${cfg.wasmBucket}/worldgen/`;
    r.run(['gcloud', 'storage', 'cp', '--no-clobber', '--cache-control', 'public, max-age=31536000, immutable', '--content-type', 'application/wasm', `worldgen/pkg/${m.file}`, `${dest}${m.file}`, ...P]);
    r.run(['gcloud', 'storage', 'cp', '--no-clobber', '--cache-control', 'public, max-age=31536000, immutable', '--content-type', 'application/json', 'worldgen/pkg/manifest.json', `${dest}${m.file.replace(/\.wasm$/, '.json')}`, ...P]);
    out.urls.wasm = `https://storage.googleapis.com/${cfg.wasmBucket}/worldgen/${m.file}`;
  }

  if (want('vm')) {
    r.section(`game VM ${cfg.vm.name} (${cfg.vm.machineType}, started on demand)`);
    const vmEnv = [
      'LODESTONE_ENV=production',
      `LODESTONE_TAG=${cfg.tag}`,
      `LODESTONE_REGISTRY=${cfg.registry}`,
      `LODESTONE_GAME_HOST=${gameHost}`,
      `LODESTONE_CORS_ORIGIN=${clientOrigin}`,
      'LODESTONE_ZONE_ID=zone-1',
      `LODESTONE_WORLD_SEED=${cfg.worldSeed}`,
      'LODESTONE_LIVEKIT_EXTERNAL_IP=true',
    ].join('\n');
    const vmSecrets = [
      'POSTGRES_PASSWORD=lodestone-pg-password',
      'LODESTONE_TICKET_PUBLIC_KEY=lodestone-ticket-public-key',
      'LODESTONE_SAVE_PRIVATE_KEY=lodestone-save-private-key',
      'LODESTONE_SAVE_PUBLIC_KEY=lodestone-save-public-key',
      'LODESTONE_LIVEKIT_KEY=lodestone-livekit-key',
      'LODESTONE_LIVEKIT_SECRET=lodestone-livekit-secret',
      'LODESTONE_METRICS_TOKEN=lodestone-metrics-token',
    ].join('\n');
    fs.writeFileSync(path.join(stage, 'vm.env'), vmEnv + '\n');
    fs.writeFileSync(path.join(stage, 'vm.secrets'), vmSecrets + '\n');
    r.note('instance metadata lodestone-env (non-secret):');
    for (const l of vmEnv.split('\n')) r.note(`  ${l}`);
    r.note('instance metadata lodestone-secrets (ENV=secret name; values fetched on the VM at boot):');
    for (const l of vmSecrets.split('\n')) r.note(`  ${l}`);
    const staged = (f) => (r.dryRun ? `<staging>/${f}` : path.join(stage, f));
    const fromFileArg = [
      'startup-script=infra/vm/startup.sh',
      'shutdown-script=infra/vm/shutdown.sh',
      'lodestone-compose=infra/vm/docker-compose.vm.yml',
      'lodestone-caddyfile=infra/vm/Caddyfile',
      'lodestone-prometheus=infra/vm/prometheus.vm.yml',
      'lodestone-backup=infra/vm/pg-backup.sh',
      `lodestone-env=${staged('vm.env')}`,
      `lodestone-secrets=${staged('vm.secrets')}`,
    ].join(',');
    const plain = `lodestone-registry-host=${cfg.registryHost},lodestone-backup-bucket=${cfg.backupBucket}`;
    if (!r.probe(['gcloud', 'compute', 'disks', 'describe', cfg.vm.dataDisk, ...Z, ...P])) {
      r.run(['gcloud', 'compute', 'disks', 'create', cfg.vm.dataDisk, '--size', `${cfg.vm.dataDiskGb}GB`, '--type', 'pd-balanced', ...Z, ...P]);
    }
    const exists = r.probe(['gcloud', 'compute', 'instances', 'describe', cfg.vm.name, ...Z, ...P]);
    if (!exists) {
      r.run([
        'gcloud', 'compute', 'instances', 'create', cfg.vm.name, ...Z, ...P,
        '--machine-type', cfg.vm.machineType,
        '--image-family', 'debian-12', '--image-project', 'debian-cloud',
        '--boot-disk-size', `${cfg.vm.bootDiskGb}GB`, '--boot-disk-type', 'pd-balanced',
        '--disk', `name=${cfg.vm.dataDisk},device-name=${cfg.vm.dataDisk},mode=rw,boot=no,auto-delete=no`,
        '--address', externalIp, '--subnet', cfg.subnet, '--private-network-ip', internalIp,
        '--tags', cfg.vm.tag,
        '--service-account', cfg.sa.vm, '--scopes', 'cloud-platform',
        '--shielded-secure-boot', '--shielded-vtpm',
        '--metadata-from-file', fromFileArg,
        '--metadata', plain,
      ]);
      r.note('first boot installs Docker and pulls the images (~2 min); the director stops it again after 15 idle minutes');
    } else {
      r.run(['gcloud', 'compute', 'instances', 'add-metadata', cfg.vm.name, ...Z, ...P, '--metadata-from-file', fromFileArg, '--metadata', plain]);
      const status = r.output(['gcloud', 'compute', 'instances', 'describe', cfg.vm.name, ...Z, ...P, '--format', 'value(status)'], 'RUNNING');
      if (status === 'RUNNING') {
        r.note('VM is awake: re-run its startup script now (pulls the new tag, recreates changed containers)');
        r.run(['gcloud', 'compute', 'ssh', cfg.vm.name, ...Z, ...P, '--tunnel-through-iap', '--quiet', '--command', 'sudo google_metadata_script_runner startup']);
      } else {
        r.note(`VM is ${status}: the new tag is in its metadata and is pulled on the next wake`);
      }
    }
    r.run(['gcloud', 'compute', 'instances', 'add-iam-policy-binding', cfg.vm.name, ...Z, ...P, '--member', `serviceAccount:${cfg.sa.director}`, '--role', `projects/${cfg.projectOrPlaceholder}/roles/lodestoneVmPower`]);
  }

  const runUrl = (svc) => r.output(['gcloud', 'run', 'services', 'describe', svc, ...R, ...P, '--format', 'value(status.url)'], `https://${svc}-<hash>-uc.a.run.app`);

  if (want('run')) {
    r.section('Cloud Run (min instances 0): director, account, creator');
    const img = (s) => (refs ? refs[s] : `${cfg.registry}/${s}:${cfg.tag}`);
    const common = (svc, sa, port, mem) => [
      'gcloud', 'run', 'deploy', svc, ...R, ...P,
      '--platform', 'managed', '--allow-unauthenticated',
      '--min-instances', '0', '--max-instances', '4',
      '--port', String(port), '--cpu', '1', '--memory', mem, '--concurrency', '80', '--timeout', '60',
      '--service-account', sa,
      // Direct VPC egress: reach Postgres/Redis/health on the VM's internal
      // IP without a paid Serverless VPC connector; the tag is what the
      // lodestone-game-internal firewall rule admits.
      '--network', cfg.network, '--subnet', cfg.subnet, '--vpc-egress', 'private-ranges-only', '--network-tags', cfg.runTag,
    ];
    const envs = (o) => `^@^${Object.entries(o).map(([k, v]) => `${k}=${v}`).join('@')}`;
    const secs = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}:latest`).join(',');
    const base = { LODESTONE_ENV: 'production', LODESTONE_LAZY_DEPS: '1', LODESTONE_REDIS_ADDR: `${internalIp}:6379`, LODESTONE_CORS_ORIGIN: clientOrigin };
    r.run([
      ...common(cfg.services.director, cfg.sa.director, 8090, '512Mi'), '--image', img('director'),
      '--set-env-vars', envs({
        ...base,
        LODESTONE_SOCIAL_URL: `wss://${gameHost}/social/ws`,
        LODESTONE_WAKE_PROVIDER: 'gce',
        LODESTONE_WAKE_GCE_PROJECT: cfg.projectOrPlaceholder,
        LODESTONE_WAKE_GCE_ZONE: cfg.zone,
        LODESTONE_WAKE_GCE_INSTANCE: cfg.vm.name,
        LODESTONE_WAKE_IDLE: cfg.idle,
        LODESTONE_WAKE_READY_URLS: `http://${internalIp}:8092/healthz,http://${internalIp}:8093/healthz`,
      }),
      '--set-secrets', secs({
        LODESTONE_PG_URL: 'lodestone-pg-url',
        LODESTONE_TICKET_PRIVATE_KEY: 'lodestone-ticket-private-key',
        LODESTONE_SESSION_PUBLIC_KEY: 'lodestone-session-public-key',
        LODESTONE_SAVE_PUBLIC_KEY: 'lodestone-save-public-key',
        LODESTONE_WAKE_CRON_TOKEN: 'lodestone-wake-cron-token',
        LODESTONE_METRICS_TOKEN: 'lodestone-metrics-token',
      }),
    ]);
    r.run([
      ...common(cfg.services.account, cfg.sa.run, 8091, '1Gi'), '--image', img('account'),
      '--set-env-vars', envs({ ...base, LODESTONE_FIREBASE_PROJECT_ID: cfg.firebase.projectId, LODESTONE_WORLD_SEED: cfg.worldSeed }),
      '--set-secrets', secs({
        LODESTONE_PG_URL: 'lodestone-pg-url',
        LODESTONE_SESSION_PRIVATE_KEY: 'lodestone-session-private-key',
        LODESTONE_SAVE_PRIVATE_KEY: 'lodestone-save-private-key',
        LODESTONE_METRICS_TOKEN: 'lodestone-metrics-token',
      }),
    ]);
    r.run([
      ...common(cfg.services.creator, cfg.sa.run, 8094, '1Gi'), '--image', img('creator'),
      '--set-env-vars', envs({ ...base, LODESTONE_CORS_ORIGIN: creatorOrigin, LODESTONE_CREATOR_LLM: cfg.creatorLLM ? '1' : '0' }),
      '--set-secrets', secs({
        LODESTONE_PG_URL: 'lodestone-pg-url',
        LODESTONE_CREATOR_TOKEN: 'lodestone-creator-token',
        LODESTONE_METRICS_TOKEN: 'lodestone-metrics-token',
        ...(cfg.creatorLLM ? { ANTHROPIC_API_KEY: 'lodestone-anthropic-api-key' } : {}),
      }),
    ]);
  }
  if (want('run') || want('scheduler') || want('netlify')) {
    out.urls.director = runUrl(cfg.services.director);
    out.urls.account = runUrl(cfg.services.account);
    out.urls.creatorApi = runUrl(cfg.services.creator);
  }

  if (want('scheduler')) {
    r.section('Cloud Scheduler: idle check every 5 minutes (the director scales to zero)');
    const tok = r.output(['gcloud', 'secrets', 'versions', 'access', 'latest', '--secret', 'lodestone-wake-cron-token', ...P], '<wake-cron-token>');
    const job = ['--location', cfg.region, ...P, '--schedule', '*/5 * * * *', '--uri', `${out.urls.director}/internal/wake/tick`, '--http-method', 'POST', '--attempt-deadline', '60s'];
    if (r.probe(['gcloud', 'scheduler', 'jobs', 'describe', 'lodestone-wake-tick', '--location', cfg.region, ...P])) {
      r.run(['gcloud', 'scheduler', 'jobs', 'update', 'http', 'lodestone-wake-tick', ...job, '--update-headers', `Authorization=Bearer ${tok}`], { redact: [tok] });
    } else {
      r.run(['gcloud', 'scheduler', 'jobs', 'create', 'http', 'lodestone-wake-tick', ...job, '--headers', `Authorization=Bearer ${tok}`], { redact: [tok] });
    }
  }

  if (want('netlify')) {
    const fb = cfg.firebase;
    buildClient(r, {
      VITE_DIRECTOR_URL: out.urls.director,
      VITE_ACCOUNT_URL: out.urls.account,
      VITE_FIREBASE_API_KEY: fb.apiKey ?? '',
      VITE_FIREBASE_AUTH_DOMAIN: fb.apiKey ? fb.authDomain : '',
      VITE_FIREBASE_PROJECT_ID: fb.apiKey ? fb.projectId : '',
      VITE_FIREBASE_APP_ID: fb.appId ?? '',
      VITE_WORLD_SEED: cfg.worldSeed,
    });
    buildCreator(r);
    writeCreatorRedirects(r, out.urls.creatorApi);
    r.section('Netlify (static; creates each site on first deploy)');
    const site = (name, idEnv) => (process.env[idEnv] ? ['--site', process.env[idEnv]] : ['--site-name', name, ...(cfg.netlify.team ? ['--team', cfg.netlify.team] : [])]);
    // Run each deploy from its OWN scratch directory: the CLI never writes
    // .netlify/ link state into the repo, and the creator deploy cannot
    // inherit the client site the first deploy just created and linked (that
    // happened on the first real deploy: the creator overwrote the client).
    const nopts = (sub) => {
      const cwd = path.join(stage, sub);
      fs.mkdirSync(cwd, { recursive: true });
      return { cwd };
    };
    r.run(['netlify', 'deploy', '--prod', '--no-build', '--dir', path.join(root, 'client', 'dist'), ...site(cfg.netlify.clientSite, 'LODESTONE_NETLIFY_CLIENT_SITE_ID'), '--message', `lodestone ${cfg.tag}`], nopts('netlify-client'));
    r.run(['netlify', 'deploy', '--prod', '--no-build', '--dir', path.join(root, 'tools', 'creator', 'dist'), ...site(cfg.netlify.creatorSite, 'LODESTONE_NETLIFY_CREATOR_SITE_ID'), '--message', `lodestone ${cfg.tag}`], nopts('netlify-creator'));
    out.urls.client = clientOrigin;
    out.urls.creator = creatorOrigin;
    if (!fb.apiKey) {
      r.manual('Google sign-in (Firebase Auth) for player accounts', [
        'Local profiles work without this. For account sign-in:',
        `  1. https://console.firebase.google.com > Add project > pick the existing GCP project "${fb.projectId}" > Continue (Analytics off is fine).`,
        '  2. Build > Authentication > Get started > Sign-in method > Google > Enable > Save.',
        `  3. Authentication > Settings > Authorized domains > Add domain > ${new URL(clientOrigin).host}`,
        '  4. Project settings (gear) > General > Your apps > Web (</>) > register "lodestone-client" (no hosting).',
        '  5. Copy apiKey and appId into the deploy environment and re-run:',
        '       VITE_FIREBASE_API_KEY=<apiKey> VITE_FIREBASE_APP_ID=<appId> npm run deploy',
      ]);
    }
  }

  r.section('summary');
  r.note(`client          ${out.urls.client ?? clientOrigin}`);
  r.note(`creator         ${out.urls.creator ?? creatorOrigin}  (token: Secret Manager lodestone-creator-token)`);
  r.note(`director        ${out.urls.director ?? '(not deployed in this run)'}`);
  r.note(`account         ${out.urls.account ?? '(not deployed in this run)'}`);
  r.note(`game VM         ${cfg.vm.name} at ${externalIp} -> wss://${gameHost}/zone/ws, /social/ws, /livekit; WebTransport https://${gameHost}:4433/wt`);
  r.note(`worldgen wasm   ${out.urls.wasm ?? '(not published in this run)'}`);
  r.note(`backups         gs://${cfg.backupBucket}/pg/ (nightly + every stop)`);
  r.note('wake on demand  the first sign-in starts the VM; it stops 15 min after the last player leaves');
  // Best effort: on Windows a CLI child can still hold the directory (EBUSY).
  try {
    fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (e) {
    r.note(`could not remove ${stage}: ${e.code ?? e.message} (harmless)`);
  }
  return out;
}
