// Wildlife ambience (playtest 2 immersion pass: "the daytime is just
// noise: no birdsong, no frogs, no owls"). Pure: which voices the land
// asks for where you stand, by biome, hour and weather (ambience.ts plays
// them; engine.ts feeds the biome under the listener). Unit-tested.

export interface WildlifeTargets {
  /** Songbirds (phrases of whistled notes): 0..1 density. */
  birds: number;
  /** A hawk's long descending cry over open high ground. */
  hawks: number;
  /** Frogs croaking in a chorus (wetlands, warm nights). */
  frogs: number;
  /** An owl's hoots in the woods at night. */
  owls: number;
}

const BY_BIOME: Record<string, WildlifeTargets> = {
  meadow: { birds: 1, hawks: 0.25, frogs: 0.3, owls: 0.3 },
  forest: { birds: 1, hawks: 0, frogs: 0.2, owls: 1 },
  highlands: { birds: 0.45, hawks: 1, frogs: 0.05, owls: 0.3 },
  snowpeak: { birds: 0.08, hawks: 0.5, frogs: 0, owls: 0 },
  badlands: { birds: 0.15, hawks: 0.8, frogs: 0, owls: 0.1 },
  wetland: { birds: 0.8, hawks: 0.1, frogs: 1, owls: 0.4 },
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Birdsong through the day: the dawn chorus loudest, a quieter midday, an evening song, silence at night. */
export function birdHours(hour: number): number {
  const up = smooth(4.8, 5.8, hour) * (1 - smooth(19.4, 20.3, hour));
  const chorus = Math.exp(-(((hour - 6.6) / 1.4) ** 2));
  const evening = Math.exp(-(((hour - 18.6) / 1.1) ** 2)) * 0.5;
  return Math.min(1, up * (0.55 + 0.45 * chorus + evening));
}

export function wildlifeTargets(o: { biome: string | null; hour: number; rain: number; snow: number; wind: number; inTown: boolean; underground: number }): WildlifeTargets {
  const b = BY_BIOME[o.biome ?? 'meadow'] ?? BY_BIOME.meadow;
  const above = Math.max(0, 1 - o.underground * 2.5);
  const night = o.hour >= 19.6 || o.hour < 4.8 ? 1 : 0;
  const gale = 1 - Math.min(1, Math.max(0, o.wind - 0.6) * 2.5);
  const dryish = 1 - Math.min(1, o.rain * 0.95 + o.snow * 0.8);
  const town = o.inTown ? 0.5 : 1;
  return {
    birds: b.birds * birdHours(o.hour) * dryish * gale * above * town,
    hawks: b.hawks * smooth(7.5, 9, o.hour) * (1 - smooth(17.5, 18.5, o.hour)) * dryish * above * (o.inTown ? 0 : 1),
    // frogs like the wet (not the cold)
    frogs: Math.min(1, b.frogs * night * (1 - o.snow) * (1 + 0.3 * o.rain)) * gale * above * town,
    owls: b.owls * night * (1 - Math.min(1, o.rain)) * gale * above * (o.inTown ? 0.3 : 1),
  };
}
