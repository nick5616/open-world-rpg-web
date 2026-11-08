// Consistency of the texture pipeline inputs/outputs (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMaps } from '../build-textures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const cfg = JSON.parse(fs.readFileSync(path.join(here, '..', 'sets.json'), 'utf8'));

test('every set has its source folder with at least a base colour map', () => {
  for (const s of cfg.sets) {
    const maps = findMaps(path.join(root, 'texture-sources', s.folder));
    assert.ok(maps.color, `${s.id}: base colour`);
  }
});

test('terrain layers are known sets and the built manifest matches', () => {
  const ids = new Set(cfg.sets.map((s) => s.id));
  for (const l of cfg.terrain.layers) assert.ok(ids.has(l), l);
  const manifest = path.join(root, 'client', 'public', 'textures', 'terrain', 'manifest.json');
  if (fs.existsSync(manifest)) {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.deepEqual(m.layers, cfg.terrain.layers);
    for (const f of Object.values(m.files)) assert.ok(fs.existsSync(path.join(path.dirname(manifest), f)), f);
  }
});

test('map discovery handles every 3dtextures.me naming scheme', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'tex-'));
  for (const f of ['X_001_COLOR.jpg', 'X_001_NORM.jpg', 'X_001_OCC.jpg', 'X_001_ROUGH.jpg', 'X_001_DISP.png']) fs.writeFileSync(path.join(dir, f), '');
  const m = findMaps(dir);
  assert.ok(m.color && m.normal && m.ao && m.rough && m.height);
  assert.equal(m.metal, null);
  fs.rmSync(dir, { recursive: true });
});
