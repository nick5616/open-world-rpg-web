import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORLDSPEC_RANGES } from '@lodestone/contracts';
import { normalize, cleanName, blockedStem } from '../web/src/spec/normalize';
import { RELAXED_SCHEMA, validateStrict } from '../web/src/spec/schema';
import { BASE, CASES, caseInput } from './fixture-cases';
import { FIXTURE_FILE, fixtureText } from './build-fixtures';

describe('shared fixtures', () => {
  it('fixtures/normalize.json is up to date with fixture-cases.ts and normalize.ts', () => {
    // If this fails, run `npm run fixtures -w @lodestone/creator` and make
    // sure the Go test (internal/spec) still passes against the new file.
    expect(fs.readFileSync(FIXTURE_FILE, 'utf8').replace(/\r\n/g, '\n')).toBe(fixtureText());
  });

  it('every ok result passes the strict contract schema and is idempotent', () => {
    for (const c of CASES) {
      const r = normalize(caseInput(c));
      if (!r.ok) continue;
      expect(validateStrict(r.spec), c.name).toEqual([]);
      const again = normalize(r.spec);
      expect(again.ok && again.changes, c.name).toEqual([]);
      expect(again.ok && again.spec).toEqual(r.spec);
    }
  });
});

describe('normalize', () => {
  it('clamps every numeric field to WORLDSPEC_RANGES', () => {
    const wild: Record<string, unknown> = structuredClone(BASE);
    for (const [key, r] of Object.entries(WORLDSPEC_RANGES)) {
      const [group, sub] = key.split('.');
      const v = r.max + 1000;
      if (sub) (wild[group] as Record<string, number>)[sub] = v;
      else wild[key] = v;
    }
    const res = normalize(wild);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const flat = res.spec as unknown as Record<string, unknown>;
    for (const [key, r] of Object.entries(WORLDSPEC_RANGES)) {
      const [group, sub] = key.split('.');
      const got = sub ? (flat[group] as Record<string, number>)[sub] : (flat[key] as number);
      expect(got, key).toBeGreaterThanOrEqual(r.min);
      expect(got, key).toBeLessThanOrEqual(r.max);
    }
  });

  it('turns -0 into 0 (Go would serialize -0 as "-0")', () => {
    const res = normalize({ ...BASE, plateaus: -0 });
    expect(res.ok && Object.is(res.spec.plateaus, 0)).toBe(true);
  });

  it('renormalizes weights so the strongest is exactly 1', () => {
    const res = normalize(BASE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Math.max(...Object.values(res.spec.biomeWeights))).toBe(1);
    expect(res.spec.biomeWeights.forest).toBe(1);
    expect(res.spec.biomeWeights.meadow).toBe(0.657 / 0.863);
  });

  it('rejects instead of guessing on unclampable problems', () => {
    expect(normalize({ ...BASE, palette: 'neon' }).ok).toBe(false);
    expect(normalize({ ...BASE, extra: 1 }).ok).toBe(false);
    expect(normalize({ ...BASE, name: '!!' }).ok).toBe(false);
    expect(normalize('drowned cathedral').ok).toBe(false);
  });

  it('cleans names and applies the blocklist per word prefix', () => {
    expect(cleanName('  Isles:: of\tFrost ')).toBe('Isles of Frost');
    expect(blockedStem('Lavender Wanderer')).toBeNull();
    expect(blockedStem('Enderwood')).toBe('ender');
    expect(blockedStem("Wolf's-Odinsgate")).toBe('odin');
  });

  it('relaxed schema keeps structure but drops range constraints', () => {
    const p = RELAXED_SCHEMA.properties as Record<string, Record<string, unknown>>;
    expect(p.seaLevel.minimum).toBeUndefined();
    expect(p.windDirection.type).toBe('number');
    expect(p.palette.enum).toBeDefined();
    expect(p.seed.pattern).toBeDefined();
    expect(RELAXED_SCHEMA.additionalProperties).toBe(false);
  });
});
