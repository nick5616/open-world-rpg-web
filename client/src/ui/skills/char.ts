// The character data the skill screen and the character panel's spell cards
// read: level, points, known spells, both loadouts and the build view (for
// "your hit" in a spell's deep info). Lifted out of SkillScreen.tsx so the
// character panel (C) can show the same cards and tooltips.

import { useMemo } from 'react';
import { COMBAT } from '@lodestone/contracts';
import { useCombatHud } from '../../combat/store';
import { useInventory } from '../inventory/store';
import { useProgression } from '../progression/store';
import { statsAt } from '../progression/gains';
import { buildOverview, type BuildView } from './build';
import { spellByKey } from './tree';

export interface Char {
  level: number;
  attuned: number;
  free: number;
  total: number;
  known: string[];
  knownSet: Set<string>;
  online: boolean;
  activeLoadout: number;
  loadouts: { weapon: string; spells: (string | null)[]; gem: number }[];
  skillXp: Record<string, number>;
  view: BuildView;
}

export function useChar(): Char {
  const stats = useProgression((s) => s.stats);
  const actions = useProgression((s) => s.actions);
  const known = useCombatHud((s) => s.known);
  const skillXp = useCombatHud((s) => s.skillXp);
  const combatActive = useCombatHud((s) => s.active);
  const freePoints = useCombatHud((s) => s.skillPoints);
  const loadouts = useCombatHud((s) => s.loadouts);
  const activeLoadout = useCombatHud((s) => s.activeLoadout);
  const combatLevel = useCombatHud((s) => s.level);
  const items = useInventory((s) => s.inv?.items);
  return useMemo(() => {
    const level = stats?.level ?? combatLevel ?? 1;
    const attuned = stats?.attunedCount ?? 0;
    const total = stats?.skillTotal ?? statsAt(level, attuned).skillPoints;
    // Like the character panel: combat_sync's free points while combat runs, else Event 900's.
    const free = combatActive ? freePoints : (stats?.skillFree ?? total - known.filter((k) => !COMBAT.start.spells.includes(k)).length);
    const view = buildOverview({ level, attuned, skillFree: free, skillTotal: total, known, skillXp, loadouts, activeLoadout, items: items ?? [], zone: stats ? { manaMax: stats.manaMax, staminaMax: stats.staminaMax } : null });
    return { level, attuned, free, total, known, knownSet: new Set(known), online: !!actions, activeLoadout, loadouts, skillXp, view };
  }, [stats, actions, known, skillXp, combatActive, freePoints, loadouts, activeLoadout, combatLevel, items]);
}

/** Learn a spell (1 skill point): the existing combat Interact. */
export function learnSpell(key: string): void {
  const s = spellByKey.get(key);
  if (s) useProgression.getState().actions?.learn(s.id);
}

/** Put a known spell in a loadout slot (null empties it; a spell already in another slot moves). */
export function equipSpell(loadout: number, slot: number, key: string | null): void {
  const id = key ? (spellByKey.get(key)?.id ?? 0) : 0;
  useProgression.getState().actions?.equipSpell(loadout, slot, id);
}
