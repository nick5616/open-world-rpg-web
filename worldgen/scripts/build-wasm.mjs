#!/usr/bin/env node
/* global WebAssembly */
// `npm run build:wasm`: release-build worldgen.wasm into worldgen/pkg/ with a
// manifest. The pinned artifact is worldgen-<sha256:16>.wasm (spec 5,
// "the pinned thing is worldgen-<hash>.wasm"); worldgen.wasm is a copy under
// a stable name for local tools. Fails if the module imports anything:
// hosts instantiate it with an empty import object (no WASI, no host math).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../scripts/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const pkg = path.join(root, 'worldgen', 'pkg');
const quiet = process.argv.includes('--quiet');

const cargo = spawnSync('cargo', ['build', '-p', 'worldgen', '--release', '--target', 'wasm32-unknown-unknown', ...(quiet ? ['-q'] : [])], {
  cwd: root,
  env: env(),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (cargo.status !== 0) process.exit(cargo.status ?? 1);

const built = path.join(root, 'target', 'wasm32-unknown-unknown', 'release', 'worldgen.wasm');
const bytes = fs.readFileSync(built);
const mod = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(mod);
if (imports.length) {
  console.error('worldgen.wasm must not import anything, found:', imports);
  process.exit(1);
}
const { exports } = new WebAssembly.Instance(mod, {});
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const rustc = spawnSync('rustc', ['--version'], { env: env(), encoding: 'utf8', shell: process.platform === 'win32' }).stdout.trim();
const manifest = {
  file: `worldgen-${sha256.slice(0, 16)}.wasm`,
  sha256,
  bytes: bytes.length,
  genVersion: exports.gen_version(),
  abiVersion: exports.abi_version(),
  rustc,
  exports: WebAssembly.Module.exports(mod).map((e) => e.name),
};
fs.mkdirSync(pkg, { recursive: true });
for (const f of fs.readdirSync(pkg)) if (/^worldgen-[0-9a-f]+\.wasm$/.test(f)) fs.rmSync(path.join(pkg, f));
fs.writeFileSync(path.join(pkg, 'worldgen.wasm'), bytes);
fs.writeFileSync(path.join(pkg, manifest.file), bytes);
fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
if (!quiet) console.log(`worldgen.wasm ${bytes.length} bytes, sha256 ${sha256.slice(0, 16)}, genVersion ${manifest.genVersion}, abi ${manifest.abiVersion}`);
