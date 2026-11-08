// Deploy configuration (WP18): flags > environment > defaults. Nothing here
// reads or changes gcloud's own configuration: every gcloud command gets an
// explicit --project, so deploying never switches a developer's active
// project.
import { spawnSync } from 'node:child_process';
import { root } from '../../scripts/lib.mjs';

export function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      flags._.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split('=', 2);
    if (v !== undefined) flags[k] = v;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
    else flags[k] = true;
  }
  return flags;
}

export function gitSha() {
  const r = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'dev';
}

export function gitDirty() {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() !== '';
}

// Empty strings count as unset: GitHub Actions passes unset `vars.X` as "".
const env = new Proxy(process.env, { get: (t, k) => (t[k] === '' ? undefined : t[k]) });
const pick = (flags, flag, envName, def) => flags[flag] ?? env[envName] ?? def;

/** Configuration for the real (GCP + Netlify) deployment. */
export function gcpConfig(flags) {
  const project = pick(flags, 'project', 'LODESTONE_GCP_PROJECT', null);
  const region = pick(flags, 'region', 'LODESTONE_GCP_REGION', 'us-central1');
  const tag = pick(flags, 'tag', 'LODESTONE_TAG', gitSha());
  const p = project ?? 'YOUR-GCP-PROJECT';
  return {
    project,
    projectOrPlaceholder: p,
    region,
    zone: pick(flags, 'zone', 'LODESTONE_GCP_ZONE', `${region}-a`),
    tag,
    // Artifact Registry
    repo: 'lodestone',
    registry: `${region}-docker.pkg.dev/${p}/lodestone`,
    registryHost: `${region}-docker.pkg.dev`,
    // The game VM. e2-standard-2 (2 vCPU, 8 GB) holds zone + social + LiveKit
    // + Postgres + Redis with headroom for the 30 Hz tick; it is billed only
    // while awake. Override with LODESTONE_VM_MACHINE_TYPE once WP19 has soak
    // numbers.
    vm: {
      name: pick(flags, 'vm-name', 'LODESTONE_VM_NAME', 'lodestone-game'),
      machineType: pick(flags, 'machine-type', 'LODESTONE_VM_MACHINE_TYPE', 'e2-standard-2'),
      bootDiskGb: 20,
      dataDisk: 'lodestone-data',
      dataDiskGb: +pick(flags, 'data-disk-gb', 'LODESTONE_VM_DATA_DISK_GB', 20),
      tag: 'lodestone-game',
      externalIp: 'lodestone-game-ip',
      internalIp: 'lodestone-game-internal-ip',
    },
    network: pick(flags, 'network', 'LODESTONE_GCP_NETWORK', 'default'),
    subnet: pick(flags, 'subnet', 'LODESTONE_GCP_SUBNET', 'default'),
    runTag: 'lodestone-run', // network tag on Cloud Run's Direct VPC egress
    sa: {
      vm: `lodestone-vm@${p}.iam.gserviceaccount.com`,
      run: `lodestone-run@${p}.iam.gserviceaccount.com`,
      director: `lodestone-director@${p}.iam.gserviceaccount.com`,
    },
    services: { director: 'lodestone-director', account: 'lodestone-account', creator: 'lodestone-creator' },
    backupBucket: `${p}-lodestone-backups`,
    wasmBucket: `${p}-lodestone-worldgen`,
    // Custom domain for the game VM (needs an A record to the VM's static IP).
    // Unset: <ip-with-dashes>.sslip.io, which resolves to the IP with no DNS
    // setup and gets a Let's Encrypt certificate like any other name.
    gameHost: pick(flags, 'game-host', 'LODESTONE_GAME_HOST', null),
    netlify: {
      clientSite: pick(flags, 'client-site', 'LODESTONE_NETLIFY_CLIENT_SITE', `${p}-client`),
      creatorSite: pick(flags, 'creator-site', 'LODESTONE_NETLIFY_CREATOR_SITE', `${p}-creator`),
      team: pick(flags, 'netlify-team', 'LODESTONE_NETLIFY_TEAM', null),
    },
    firebase: {
      projectId: pick(flags, 'firebase-project', 'LODESTONE_FIREBASE_PROJECT_ID', p),
      apiKey: env.VITE_FIREBASE_API_KEY ?? null,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? `${pick(flags, 'firebase-project', 'LODESTONE_FIREBASE_PROJECT_ID', p)}.firebaseapp.com`,
      appId: env.VITE_FIREBASE_APP_ID ?? null,
    },
    creatorLLM: flags['creator-llm'] === true || env.LODESTONE_CREATOR_LLM === '1',
    worldSeed: pick(flags, 'world-seed', 'LODESTONE_WORLD_SEED', '20261108'),
    idle: pick(flags, 'idle', 'LODESTONE_WAKE_IDLE', '15m'),
  };
}

/** Ports and names for the local rehearsal (all free on the dev machine). */
export const rehearsal = {
  project: 'lodestone-rehearsal',
  registry: 'lodestone-rehearsal',
  ports: {
    edge: 28080, // Caddy (stands in for :80/:443 on the VM)
    zoneHttp: 28092,
    zoneWt: 28433,
    socialHttp: 28093,
    director: 28090,
    account: 28091,
    creator: 28094,
    client: 28173,
    creatorWeb: 28177,
    pg: 28432,
    redis: 28379,
    livekitTcp: 28881,
    livekitUdp: 28882,
    caddyHttps: 28443,
  },
};
