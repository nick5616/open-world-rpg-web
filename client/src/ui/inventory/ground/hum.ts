// The hum of a dropped item (playtest 2 ground loot, Nicole: "add range
// based loudness that corresponds of the unique hum of each weapon drop of
// rarity"). Every drop of uncommon or better is a positional loop emitter
// (audio/loopPool.ts): its sound family by what it is (weapons, armor,
// ingots and arrows ring metallic, gems chime, tomes, blueprints and quest
// items whisper, anything else a warm drone, Bitchin' a shimmering chord),
// its pitch, level and reach by rarity (common is silent; a legendary is
// heard ~34 m away, a Bitchin' ~56 m). The audio engine scores it like any
// fire or river (distance curve x occlusion: muffled indoors and in caves),
// and only the loudest MAX_LOOP_VOICES of everything get a voice, so the
// nearest and rarest drops win. Pure (hum.test.ts).

import type { LoopEmitter } from '../../../audio/loopPool';
import type { LootHumKind } from '../../../audio/spatial';
import { itemDef } from '../items';

export interface Hum {
  kind: LootHumKind;
  /** Level multiplier on the kind's profile. */
  level: number;
  /** Range multiplier (1 = the profile's 34 m). */
  reach: number;
  /** Pitch (playback rate) by rarity: each tier its own note. */
  rate: number;
}

/** Per rarity: level, reach, pitch. Common is silent. */
export const HUM_BY_RARITY: readonly ({ level: number; reach: number; rate: number } | null)[] = [
  null,
  { level: 0.14, reach: 0.26, rate: 1 },
  { level: 0.22, reach: 0.42, rate: 1.122 },
  { level: 0.3, reach: 0.6, rate: 1.26 },
  { level: 0.4, reach: 1, rate: 1.498 },
  { level: 0.46, reach: 1.12, rate: 1.682 },
  { level: 0.52, reach: 1.25, rate: 1.888 },
  { level: 0.6, reach: 1.4, rate: 1 },
];

/** The sound family for an item key (independent of rarity, except Bitchin'). */
export function humKind(key: string, rarity: number): LootHumKind {
  if (rarity >= 7) return 'lootHolo';
  const cat = key.split(':')[0];
  if (cat === 'gem') return 'lootChime';
  if (cat === 'tome' || cat === 'blueprint' || cat === 'quest') return 'lootWhisper';
  const k = itemDef(key)?.kind;
  if (k === 'weapon' || k === 'armor' || k === 'ingot' || k === 'ammo' || cat === 'ore' || key === 'tool:pickaxe') return 'lootMetal';
  return 'lootHum';
}

/** A drop's hum, or null (silent: common). Gems hum at least as uncommon (they are precious). */
export function humFor(key: string, rarity: number): Hum | null {
  let r = Math.max(0, Math.min(7, rarity | 0));
  if (r === 0 && key.startsWith('gem:')) r = 1;
  const p = HUM_BY_RARITY[r];
  if (!p) return null;
  return { kind: humKind(key, rarity), ...p };
}

export interface HumDrop {
  id: number;
  key: string;
  rarity: number;
  x: number;
  y: number;
  z: number;
}

/** Hum emitters for the drops within `scan` m of (x, z); space NaN = let the engine place it (indoors, cave). */
export function humEmitters(drops: Iterable<HumDrop>, x: number, z: number, scan = 60): LoopEmitter[] {
  const out: LoopEmitter[] = [];
  for (const d of drops) {
    if (Math.abs(d.x - x) > scan || Math.abs(d.z - z) > scan) continue;
    const h = humFor(d.key, d.rarity);
    if (!h) continue;
    out.push({ id: `loot:${d.id}`, kind: h.kind, x: d.x, y: d.y + 0.4, z: d.z, level: h.level, reach: h.reach, rate: h.rate, space: Number.NaN });
  }
  return out;
}
