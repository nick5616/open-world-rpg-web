// Small cross-platform process helpers for the npm scripts (no bash, no
// PowerShell: spec section 4).
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const isWin = process.platform === 'win32';

/** PATH with the usual per-user Go/Rust install dirs appended, so scripts work in fresh shells. */
export function toolPath() {
  const home = os.homedir();
  const extra = [path.join(home, 'sdk', 'go', 'bin'), path.join(home, 'go', 'bin'), path.join(home, '.cargo', 'bin')].filter((p) => fs.existsSync(p));
  return [process.env.PATH ?? process.env.Path ?? '', ...extra].join(path.delimiter);
}

export function env(extra = {}) {
  const e = { ...process.env, ...extra };
  // Windows env is case-insensitive but Node copies keys verbatim; normalize.
  delete e.Path;
  e.PATH = toolPath();
  return e;
}

/** Run to completion, inheriting stdio. Returns the exit code. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd ?? root, env: env(opts.env), shell: isWin && !cmd.endsWith('.exe') });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

export function mustRun(cmd, args, opts) {
  const code = run(cmd, args, opts);
  if (code !== 0) {
    console.error(`\n✗ ${cmd} ${args.join(' ')} exited ${code}`);
    process.exit(code);
  }
}

const COLORS = [36, 33, 35, 32, 34, 91, 96, 93];
let colorIdx = 0;

/** Start a long-running child with prefixed, colored output. */
export function start(name, cmd, args, opts = {}) {
  const color = COLORS[colorIdx++ % COLORS.length];
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const child = spawn(cmd, args, { cwd: opts.cwd ?? root, env: env(opts.env), shell: isWin, stdio: ['ignore', 'pipe', 'pipe'] });
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        out.write(tag + buf.slice(0, i) + '\n');
        buf = buf.slice(i + 1);
      }
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`${tag}exited ${code}`));
  return child;
}

/** Kill a child and its process tree (go run spawns a grandchild binary). */
export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

export async function waitHttp(url, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Go modules listed in go.work. */
export function goModules() {
  const work = fs.readFileSync(path.join(root, 'go.work'), 'utf8');
  return [...work.matchAll(/^\s+\.\/(\S+)$/gm)].map((m) => m[1]);
}
