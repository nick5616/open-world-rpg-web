// Torches and familiar lights (playtest 3, CR 042): the data side.
//
// What a player carries lit rides in their snapshot record (EntityRecord.appearance
// bits 51-56, net/snapshotDecoder.ts -> RemoteView.light): bit 0 a torch, bits 1-5 the
// familiar light's id (combat.yaml `familiar.id`, the spells below). Your own light
// comes from Event 1840 in the same layout.

import { COMBAT, type SpellDef } from '@lodestone/contracts';

export interface FamiliarDef {
  /** combat.yaml familiar.id (1-31): the code in the snapshot record. */
  id: number;
  /** The look (lightRig visuals): icicle, ember, lantern, fireflies, orb, zephyr, wisp, lamp. */
  kind: string;
  /** The spell that calls it. */
  spellId: number;
  spellKey: string;
  name: string;
  /** '#rrggbb' (the spell's colour: the light and the glow). */
  color: string;
  /** Candela of the pooled point light and its reach in metres. */
  intensity: number;
  range: number;
  upkeepPerS: number;
  element: number;
}

export const FAMILIARS: readonly FamiliarDef[] = COMBAT.spells
  .filter((s: SpellDef) => !!s.familiar)
  .map((s: SpellDef) => ({
    id: s.familiar!.id,
    kind: s.familiar!.kind,
    spellId: s.id,
    spellKey: s.key,
    name: s.name,
    color: s.color ?? '#ffffff',
    intensity: s.familiar!.intensity,
    range: s.familiar!.range,
    upkeepPerS: s.familiar!.upkeepPerS,
    element: s.element,
  }))
  .sort((a, b) => a.id - b.id);

const byId = new Map(FAMILIARS.map((f) => [f.id, f]));
const bySpell = new Map(FAMILIARS.map((f) => [f.spellId, f]));

export const familiarById = (id: number): FamiliarDef | undefined => byId.get(id);
export const familiarOfSpell = (spellId: number): FamiliarDef | undefined => bySpell.get(spellId);

/** The light bits of a snapshot appearance number shifted down by 51 (Event 1840's `value` has the same layout). */
export function unpackLight(light: number | undefined): { torch: boolean; familiar: number } {
  const v = light ?? 0;
  return { torch: (v & 1) !== 0, familiar: (v >> 1) & 31 };
}

/** The torch: a warm point light (candela, metres). A camp fire is 9, a town torch 9. */
export const TORCH = { color: '#ffa84a', intensity: 15, range: 17 } as const;
