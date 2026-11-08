import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORLDSPEC_RANGES, type WorldSpec } from '@lodestone/contracts';
import { loadWorldgen } from '@lodestone/worldgen';
import { normalize } from '../web/src/spec/normalize';
import { PRESETS, applyPreset } from '../web/src/spec/presets';
import { GROUPS } from '../web/src/spec/fields';
import { BASE } from './fixture-cases';

describe('presets', () => {
  it('include the three spec presets plus original ones', () => {
    const labels = PRESETS.map((p) => p.label);
    for (const l of ['Archipelago', 'Highland', 'Badlands']) expect(labels).toContain(l);
    expect(PRESETS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });

  it('are in range: applying one never needs a clamp beyond renormalizing', () => {
    for (const p of PRESETS) {
      const r = normalize(applyPreset(BASE as WorldSpec, p));
      expect(r.ok, p.id).toBe(true);
      if (!r.ok) continue;
      expect(r.changes.filter((c) => c.reason !== 'renormalized'), p.id).toEqual([]);
      expect(r.spec.name).toBe(BASE.name);
      expect(r.spec.seed).toBe(BASE.seed);
    }
  });
});

describe('sliders', () => {
  it('cover every WORLDSPEC_RANGES field exactly once (specVersion excepted)', () => {
    const keys = GROUPS.flatMap((g) => g.fields.map((f) => f.key)).sort();
    const want = Object.keys(WORLDSPEC_RANGES).filter((k) => k !== 'specVersion').sort();
    expect(keys).toEqual(want);
    for (const g of GROUPS) for (const f of g.fields) expect(f.min).toBe(WORLDSPEC_RANGES[f.key].min);
  });
});

// With the wasm built: every preset generates a valid atlas (the generator
// validates specs strictly, so this proves normalize's output is acceptable
// to worldgen) and the "Archipelago" preset really has less land.
const wasmPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'worldgen', 'pkg', 'worldgen.wasm');
const haveWasm = fs.existsSync(wasmPath);
if (!haveWasm && process.env.LODESTONE_REQUIRE_WASM === '1') throw new Error('worldgen.wasm missing');

describe.skipIf(!haveWasm)('presets through worldgen.wasm', () => {
  it('build atlases and change the world in the expected direction', async () => {
    const wg = await loadWorldgen(fs.readFileSync(wasmPath));
    const land: Record<string, number> = {};
    for (const p of PRESETS) {
      const r = normalize(applyPreset(wg.specFromSeed(7n), p));
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const atlas = wg.buildAtlas(r.spec);
      land[p.id] = atlas.data.params[23];
      expect(atlas.data.sites.length).toBeGreaterThan(20);
      atlas.free();
    }
    expect(land.archipelago).toBeLessThan(land.highland);
    expect(land.archipelago).toBeLessThan(land.badlands);
  }, 60_000);
});
