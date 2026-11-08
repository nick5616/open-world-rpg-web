#!/usr/bin/env node
// `npm run test:golden`: build worldgen.wasm, then check the golden table in
// all three hosts (spec 5 rule 5, spec 14): Node, headless Chromium (Web
// Worker, plus the 8 ms chunk budget) and Go/wazero (compiler and
// interpreter); plus native Rust as a bonus. Writes a summary to
// docs/evidence/wp01-golden.txt and the Chromium report to
// docs/evidence/wp01-chromium-golden.json.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../scripts/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const evidence = path.join(root, 'docs', 'evidence');
fs.mkdirSync(evidence, { recursive: true });
const shell = process.platform === 'win32';
const e = env({ LODESTONE_REQUIRE_WASM: '1', FORCE_COLOR: '0' });

const steps = [
  ['build', 'node', ['worldgen/scripts/build-wasm.mjs'], root],
  ['node', 'npx', ['vitest', 'run', 'test/golden.test.ts', '--reporter=verbose'], path.join(root, 'worldgen', 'js')],
  ['chromium', 'node', ['worldgen/harness/browser/run.mjs', '--json', path.join(evidence, 'wp01-chromium-golden.json')], root],
  ['go', 'go', ['test', '-v', '-count=1', './...'], path.join(root, 'worldgen', 'harness', 'go')],
  ['native', 'cargo', ['test', '-q', '-p', 'worldgen', '--release', '--test', 'golden_native', '--', '--nocapture'], root],
];

const lines = [`# WP01 golden determinism run`, `date: ${new Date().toISOString()}`, `machine: ${os.cpus()[0]?.model} x${os.cpus().length}, ${os.platform()} ${os.release()}, node ${process.version}`];
const failed = [];
for (const [name, cmd, args, cwd] of steps) {
  console.log(`\n━━ ${name}: ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, env: e, shell, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // eslint-disable-next-line no-control-regex -- strip ANSI color codes from tool output
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  process.stdout.write(out);
  const tagged = out.split(/\r?\n/).filter((l) => /\[golden:|worldgen\.wasm \d+ bytes|FAIL|--- (PASS|FAIL)|Tests +\d/.test(l));
  lines.push('', `## ${name}: ${r.status === 0 ? 'PASS' : 'FAIL'}`, ...tagged.map((l) => l.trim()));
  if (r.status !== 0) failed.push(name);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'worldgen', 'pkg', 'manifest.json'), 'utf8'));
lines.splice(3, 0, `wasm: ${manifest.file} (${manifest.bytes} B, genVersion ${manifest.genVersion}, abi ${manifest.abiVersion}, ${manifest.rustc})`);
lines.push('', failed.length ? `RESULT: FAIL (${failed.join(', ')})` : 'RESULT: PASS (all hosts agree)');
fs.writeFileSync(path.join(evidence, 'wp01-golden.txt'), lines.join('\n') + '\n');
console.log(`\n${lines.at(-1)}\nwrote docs/evidence/wp01-golden.txt`);
process.exit(failed.length ? 1 : 0);
