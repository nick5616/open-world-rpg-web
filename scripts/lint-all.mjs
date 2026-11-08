#!/usr/bin/env node
// `npm run lint`: eslint + tsc, go vet + gofmt, cargo clippy (definition of done).
import { spawnSync } from 'node:child_process';
import { env, root, run } from './lib.mjs';

const failed = [];
const step = (name, cmd, args) => {
  console.log(`\n━━ ${name}`);
  if (run(cmd, args) !== 0) failed.push(name);
};
step('eslint', 'npx', ['eslint', '.']);
step('typecheck', 'npm', ['run', 'typecheck']);
step('go vet', 'node', ['scripts/go.mjs', 'each', 'vet', './...']);
console.log('\n━━ gofmt');
const fmt = spawnSync('gofmt', ['-l', 'server', 'tools'], { cwd: root, env: env(), encoding: 'utf8' });
if (fmt.stdout.trim()) {
  console.error(`unformatted:\n${fmt.stdout}`);
  failed.push('gofmt');
}
step('clippy', 'cargo', ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings']);
if (failed.length) {
  console.error(`\n✗ failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('\n✓ lint clean');
