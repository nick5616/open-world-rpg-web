#!/usr/bin/env node
// `node scripts/go.mjs each <go args...>` runs a go command in every go.work
// module (go vet ./... from the repo root can't span workspace modules).
// `node scripts/go.mjs <go args...>` runs one go command from the repo root.
import path from 'node:path';
import { goModules, root, run } from './lib.mjs';
import { serviceEnv } from './config.mjs';

const args = process.argv.slice(2);
if (args[0] === 'each') {
  let failed = 0;
  for (const m of goModules()) {
    console.log(`── ${m}: go ${args.slice(1).join(' ')}`);
    if (run('go', args.slice(1), { cwd: path.join(root, m), env: serviceEnv() }) !== 0) failed++;
  }
  process.exit(failed ? 1 : 0);
}
process.exit(run('go', args, { env: serviceEnv() }));
