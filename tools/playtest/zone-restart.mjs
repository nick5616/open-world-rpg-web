#!/usr/bin/env node
// Rebuild and restart only the zone of a running playtest stack
// (tools/playtest/stack.mjs), keeping its database, ports and the other
// services: a server fix mid-playthrough without losing the characters.
//
//   node tools/playtest/zone-restart.mjs <stack tmp dir> [--zone-env KEY=VALUE ...]
//
// The stack's own zone process is killed (stack.mjs logs that it exited and
// carries on); the new zone runs detached, logging to <dir>/zone-<n>.log.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { env, root, waitHttp } from '../../scripts/lib.mjs';

const args = process.argv.slice(2);
const dir = args[0];
const st = JSON.parse(fs.readFileSync(path.join(dir, 'stack.json'), 'utf8'));
const exe = fs.readdirSync(dir).find((f) => /^pt.*-zone(\.exe)?$/.test(f));
const RUN = exe.replace(/^pt/, '').replace(/-zone(\.exe)?$/, '');
const zoneEnv = {};
args.forEach((a, i) => {
  if (a === '--zone-env') {
    const [k, ...v] = (args[i + 1] ?? '').split('=');
    if (k) zoneEnv[k] = v.join('=');
  }
});
const n = fs.readdirSync(dir).filter((f) => /^zone-\d+\.log$/.test(f)).length + 1;
const bin = path.join(dir, `pt${RUN}-zone${n}${process.platform === 'win32' ? '.exe' : ''}`);
const b = spawnSync('go', ['build', '-o', bin, './server/zone'], { cwd: root, env: env(), encoding: 'utf8' });
if (b.status !== 0) throw new Error(b.stderr);
// Kill whichever zone binary of this stack is running.
for (const f of fs.readdirSync(dir).filter((x) => x.startsWith(`pt${RUN}-zone`))) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/IM', f], { encoding: 'utf8' });
  else spawnSync('pkill', ['-f', path.join(dir, f)]);
}
await new Promise((r) => setTimeout(r, 1500));
const base = env();
const pg = new URL(base.LODESTONE_PG_URL ?? 'postgres://lodestone:lodestone@127.0.0.1:55432/lodestone?sslmode=disable');
pg.pathname = '/' + st.DB;
const H = '127.0.0.1';
const svc = { LODESTONE_PG_URL: pg.toString(), LODESTONE_ACCOUNT_PORT: String(st.PORT.account), LODESTONE_DIRECTOR_PORT: String(st.PORT.director), LODESTONE_SOCIAL_PORT: String(st.PORT.social), LODESTONE_SOCIAL_URL: `ws://${H}:${st.PORT.social}/ws`, LODESTONE_DEV_AUTH: '1', LODESTONE_CORS_ORIGIN: '*' };
const out = fs.openSync(path.join(dir, `zone-${n}.log`), 'a');
const child = spawn(bin, [], { cwd: root, env: env({ ...svc, LODESTONE_ZONE_PORT: String(st.PORT.zone), LODESTONE_ZONE_ID: `zone-pt-${RUN}`, LODESTONE_ZONE_WT_ADDR: 'off', LODESTONE_ZONE_PUBLIC_URL: `ws://${H}:${st.PORT.zone}/ws`, ...zoneEnv }), stdio: ['ignore', out, out], detached: true });
child.unref();
const ok = await waitHttp(`http://${H}:${st.PORT.zone}/healthz`, 120000);
console.log(ok ? `zone restarted (${path.basename(bin)}, pid ${child.pid}), log ${path.join(dir, `zone-${n}.log`)}` : 'zone did not come up');
process.exit(ok ? 0 : 1);
