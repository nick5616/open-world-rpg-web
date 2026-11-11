import { describe, expect, it } from 'vitest';
import { cleanMapping, describeWhen, exportMappings, importMappings, loadStoredMappings, MAP_FORMAT, MAP_VERSION, mappingMatches, resolveMapping, specificity, type MusicMapping } from './mapping';
import type { VibeContext } from './override';

const ctx = (p: Partial<VibeContext> = {}): VibeContext => ({ state: 'night', biome: 'forest', hour: 22, time: 'night', weather: 'rain', tier: 'wilds', tierIndex: 2, areaLevel: 5, act: 3, combat: false, boss: false, underground: 0, inTown: false, timedPhase: null, intensity: 0.4, ...p });
const map = (file: string, when: MusicMapping['when'], p: Partial<MusicMapping> = {}): MusicMapping => ({ id: file, file, when, gain: 1, loop: true, fadeIn: 3, enabled: true, ...p });

describe('composer mappings', () => {
  it('matches every condition', () => {
    const c = ctx();
    expect(mappingMatches(map('a', {}), c)).toBe(true);
    expect(mappingMatches(map('a', { biome: 'forest', time: 'night', weather: 'rain', state: 'night', act: 3, combat: false }), c)).toBe(true);
    expect(mappingMatches(map('a', { biome: 'meadow' }), c)).toBe(false);
    expect(mappingMatches(map('a', { time: 'day' }), c)).toBe(false);
    expect(mappingMatches(map('a', { tierMin: 2, tierMax: 3 }), c)).toBe(true);
    expect(mappingMatches(map('a', { tierMin: 3 }), c)).toBe(false);
    expect(mappingMatches(map('a', { tierMax: 1 }), c)).toBe(false);
    expect(mappingMatches(map('a', { tierMax: 5 }), ctx({ tierIndex: -1 }))).toBe(false); // an unstamped area has no tier
    expect(mappingMatches(map('a', { combat: true }), c)).toBe(false);
    expect(mappingMatches(map('a', { intensityMin: 0.3, intensityMax: 0.5 }), c)).toBe(true);
    expect(mappingMatches(map('a', { intensityMin: 0.5 }), c)).toBe(false);
    expect(mappingMatches(map('a', {}, { enabled: false }), c)).toBe(false);
  });

  it('the most specific match wins, the earliest on ties; unloaded files are skipped', () => {
    const list = [map('any', {}), map('night', { time: 'night' }), map('forest-night', { biome: 'forest', time: 'night' }), map('forest-night-2', { time: 'night', biome: 'forest' }), map('combat-high', { state: 'combat', tierMin: 3 })];
    expect(resolveMapping(list, ctx())?.file).toBe('forest-night');
    expect(resolveMapping(list, ctx({ biome: 'meadow' }))?.file).toBe('night');
    expect(resolveMapping(list, ctx({ time: 'day', biome: 'meadow' }))?.file).toBe('any');
    expect(resolveMapping(list, ctx({ state: 'combat', tierIndex: 4, time: 'day' }))?.file).toBe('combat-high');
    expect(resolveMapping(list, ctx(), (f) => f !== 'forest-night')?.file).toBe('forest-night-2');
    expect(resolveMapping([], ctx())).toBeNull();
    expect(specificity(map('x', { tierMin: 1, tierMax: 2, intensityMin: 0, biome: 'forest' }))).toBe(3);
    expect(describeWhen({ state: 'combat', biome: 'forest', time: 'night', tierMin: 2 })).toBe('combat, night, in forest, tier 2-5');
    expect(describeWhen({})).toBe('always');
  });

  it('exports and imports (round trip), validating what comes back', () => {
    const list = [map('forest_night.wav', { biome: 'forest', time: 'night' }, { gain: 0.8, note: 'take 3' }), map('boss.mp3', { state: 'combat', tierMin: 4, tierMax: 5 }, { loop: false, fadeIn: 0.5 })];
    const text = exportMappings(list, new Date('2026-11-10T12:00:00Z'));
    const j = JSON.parse(text);
    expect(j).toMatchObject({ format: MAP_FORMAT, version: MAP_VERSION, exportedAt: '2026-11-10T12:00:00.000Z' });
    const back = importMappings(text);
    if ('error' in back) throw new Error(back.error);
    expect(back.dropped).toBe(0);
    expect(back.mappings).toEqual(list);
    // A bare array works; junk entries are dropped and counted; values are clamped.
    const loose = importMappings(JSON.stringify([{ file: 'a.wav', when: { state: 'disco', tierMin: 9, time: 'noon', act: 2 }, gain: 5 }, { nofile: true }, 7]));
    if ('error' in loose) throw new Error(loose.error);
    expect(loose.dropped).toBe(2);
    expect(loose.mappings[0]).toMatchObject({ file: 'a.wav', when: { tierMin: 5, act: 2 }, gain: 2, loop: true, fadeIn: 3, enabled: true });
    expect(loose.mappings[0].when).not.toHaveProperty('state');
    expect(loose.mappings[0].when).not.toHaveProperty('time');
    expect(importMappings('{nope')).toEqual({ error: 'not JSON' });
    expect(importMappings(JSON.stringify({ format: 'other' }))).toHaveProperty('error');
    expect(importMappings(JSON.stringify({ format: MAP_FORMAT, version: 99, mappings: [] }))).toHaveProperty('error', expect.stringContaining('version 99'));
    expect(loadStoredMappings(null)).toEqual([]);
    expect(loadStoredMappings('garbage')).toEqual([]);
    expect(loadStoredMappings(text)).toEqual(list);
    expect(cleanMapping({ file: '  x.ogg ' })?.file).toBe('x.ogg');
  });
});
