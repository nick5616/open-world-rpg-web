// Playtest 2 immersion pass: the wildlife the land asks for.
import { describe, expect, it } from 'vitest';
import { birdHours, wildlifeTargets } from './wildlife';

const at = (biome: string, hour: number, o: Partial<{ rain: number; snow: number; wind: number; inTown: boolean; underground: number }> = {}) =>
  wildlifeTargets({ biome, hour, rain: 0, snow: 0, wind: 0.2, inTown: false, underground: 0, ...o });

describe('wildlife', () => {
  it('a dawn chorus, a quieter midday, an evening song, silence at night', () => {
    expect(birdHours(6.6)).toBeGreaterThan(birdHours(13));
    expect(birdHours(18.6)).toBeGreaterThan(birdHours(15));
    expect(birdHours(23)).toBe(0);
    expect(birdHours(2)).toBe(0);
    expect(birdHours(13)).toBeGreaterThan(0.4);
  });

  it('songbirds in meadows and woods by day; frogs on wetland nights; owls in the woods; a hawk over the heights', () => {
    expect(at('meadow', 7).birds).toBeGreaterThan(0.8);
    expect(at('forest', 23).owls).toBe(1);
    expect(at('forest', 12).owls).toBe(0);
    expect(at('wetland', 22).frogs).toBe(1);
    expect(at('wetland', 12).frogs).toBe(0);
    expect(at('highlands', 12).hawks).toBeGreaterThan(0.9);
    expect(at('snowpeak', 7).birds).toBeLessThan(0.15);
    expect(at('badlands', 22).frogs).toBe(0);
  });

  it('rain hushes the birds but not the frogs; underground there is nothing; towns are quieter', () => {
    expect(at('meadow', 7, { rain: 1 }).birds).toBeLessThan(0.1);
    expect(at('wetland', 22, { rain: 1 }).frogs).toBe(1);
    for (const v of Object.values(at('forest', 7, { underground: 1 }))) expect(v).toBe(0);
    for (const v of Object.values(at('forest', 23, { underground: 1 }))) expect(v).toBe(0);
    expect(at('meadow', 7, { inTown: true }).birds).toBeLessThan(at('meadow', 7).birds);
    expect(at('meadow', 12, { inTown: true }).hawks).toBe(0);
    expect(at('meadow', 7, { wind: 1 }).birds).toBe(0); // a gale
  });
});
