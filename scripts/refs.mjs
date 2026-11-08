#!/usr/bin/env node
// Clone (or update) the read-only reference repos into refs/ (spec section 3).
// refs/ is gitignored; never import from it.
import fs from 'node:fs';
import path from 'node:path';
import { root, run } from './lib.mjs';

const REPOS = ['wizard-wars', '3d-portfolio-website', 'the-circle'];
const dir = path.join(root, 'refs');
fs.mkdirSync(dir, { recursive: true });
for (const r of REPOS) {
  const dest = path.join(dir, r);
  if (fs.existsSync(path.join(dest, '.git'))) {
    console.log(`↻ ${r}`);
    run('git', ['pull', '--ff-only'], { cwd: dest });
  } else {
    console.log(`⇣ ${r}`);
    run('git', ['clone', '--depth', '1', `https://github.com/nick5616/${r}.git`, dest]);
  }
}
