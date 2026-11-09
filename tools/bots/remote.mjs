// G5: run a soak's zone processes on a second (Linux) machine over ssh, so
// the zone is timed on dedicated cores while the bots, netsim proxies,
// director, Postgres and Redis stay on the machine running the soak script
// (tools/soak/linux/README.md). Used by scale-soak.mjs and handoff-soak.mjs
// with --zone-host; without it they run everything locally as before.
//
// The remote side needs the same layout as the local one (`--remote-dir`,
// default: this repo root's path), passwordless ssh from this machine, and
// prebuilt binaries (--bin-dir). Each zone runs as a copy of the binary under
// a unique name (/tmp/<name>), so it can be found and killed without touching
// anything else on that host.
import { spawnSync } from 'node:child_process';

export const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-o', 'ServerAliveInterval=15'];

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * [cmd, args] that start `bin` (relative to `dir` or absolute) on `host` as
 * /tmp/<name>, in `dir`, with exactly `envs` added to the remote login
 * environment, pinned with `taskset -c <cpus>` when cpus is set. Its stdout
 * and stderr come back over the ssh connection.
 */
export function remoteCommand(host, dir, bin, name, envs, cpus) {
  const assigns = Object.entries(envs).map(([k, v]) => `${k}=${q(v)}`).join(' ');
  const exe = `/tmp/${name}`;
  const pin = cpus ? `taskset -c ${q(cpus)} ` : '';
  return ['ssh', [...SSH_OPTS, host, `cd ${q(dir)} && cp ${q(bin)} ${exe} && exec env ${assigns} ${pin}${exe}`]];
}

/** Signal the process started by remoteCommand(..., name, ...) (TERM: graceful, KILL: a hard kill). */
export function remoteKill(host, name, signal = 'TERM') {
  // Anchored: the remote shell running this pkill has the name in its own command line.
  const r = spawnSync('ssh', [...SSH_OPTS, host, `pkill -${signal} -f '^/tmp/${name}( |$)'; sleep 0.5; rm -f /tmp/${name}; true`], { encoding: 'utf8', timeout: 30000 });
  return r.status === 0;
}

/** One-line description of a Linux host (CPU model, vCPUs, load), for the evidence. */
export function describeHost(host) {
  const r = spawnSync('ssh', [...SSH_OPTS, host, `echo "$(nproc) vCPUs, $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs), load avg $(cut -d' ' -f1-3 /proc/loadavg), kernel $(uname -r)"`], { encoding: 'utf8', timeout: 30000 });
  return (r.stdout || r.stderr || '').trim();
}
