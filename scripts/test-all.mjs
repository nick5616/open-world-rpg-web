#!/usr/bin/env node
// `npm test`: generated-code freshness, then TS, Go and Rust tests.
import { run } from './lib.mjs';

const steps = [
  ['gen:check', 'npm', ['run', 'gen:check']],
  ['ts', 'npm', ['run', 'test:ts']],
  ['go', 'node', ['scripts/go.mjs', 'each', 'test', './...']],
  ['rust', 'cargo', ['test', '--workspace']],
];
const failed = [];
for (const [name, cmd, args] of steps) {
  console.log(`\n━━ ${name}`);
  if (run(cmd, args) !== 0) failed.push(name);
}
if (failed.length) {
  console.error(`\n✗ failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('\n✓ all tests passed');
