// window.__lodestoneSkills: debug handle for headless scripts (dev/shots.mjs)
// and the console. Debug builds only. mock() dresses a solo character as a
// level-12 adventurer (stats as the zone's Event 900, known spells and skill
// XP as combat_sync would, the inventory mock's gear) and, when no zone is
// attached, installs local stand-ins for learn/equip so the screen can be
// clicked through offline. It never runs online unless called by hand.

import { COMBAT } from '@lodestone/contracts';
import { useCombatHud } from '../../combat/store';
import { applyItemEvent } from '../inventory/store';
import { EV } from '../inventory/events';
import { mockItems } from '../inventory/dev';
import { statsEvent } from '../progression/dev';
import { applyProgressionEvent, setProgressionActions, useProgression } from '../progression/store';
import { STATS_REASON } from '../progression/events';
import { skillXpFor } from '../progression/gains';
import { closeSkillScreen, openSkillScreen, useSkillScreen, type SkillTab } from './store';
import { spellByKey } from './tree';

/** The sample character mock() shows (exported for tests). */
export const MOCK = {
  level: 12,
  attuned: 2,
  known: ['ember_flick', 'frost_bite', 'magma_dash', 'spark_shot', 'kindling', 'fireball', 'combustion', 'glint', 'sunstep', 'radiant_lance', 'spark_jab', 'lightning_strike', 'frost_needle', 'brittle'],
  skills: { swordsmanship: 34, spearmanship: 6, archery: 12, spellcraft: 22, mining: 9, smithing: 15 } as Record<string, number>,
  loadouts: [
    { weapon: 'sword', spells: ['fireball', 'radiant_lance', 'lightning_strike', 'magma_dash'], gem: 2 },
    { weapon: 'staff', spells: ['ember_flick', 'frost_needle', 'glint', null], gem: -1 },
  ] as { weapon: string; spells: (string | null)[]; gem: number }[],
};

const spentOf = (known: readonly string[]) => known.filter((k) => !COMBAT.start.spells.includes(k)).length;

function sendStats(level: number, attuned: number, known: readonly string[]) {
  applyProgressionEvent(statsEvent(level, level, STATS_REASON.sync, attuned, spentOf(known)));
}

export function installSkillsDebug(): () => void {
  const handle = {
    // free: what the screen shows (combat_sync's points while combat runs, else Event 900's).
    state: () => {
      const c = useCombatHud.getState();
      return { ...useSkillScreen.getState(), known: c.known, loadouts: c.loadouts, activeLoadout: c.activeLoadout, free: c.active ? c.skillPoints : useProgression.getState().stats?.skillFree };
    },
    open: (tab?: SkillTab) => openSkillScreen(tab),
    close: () => closeSkillScreen(),
    pick: (key: string | null) => useSkillScreen.setState({ picked: key }),
    /** Dress the solo character (see the header). */
    mock: (level = MOCK.level, attuned = MOCK.attuned) => {
      const known = [...MOCK.known];
      useCombatHud.getState().set({
        known,
        skillXp: Object.fromEntries(Object.entries(MOCK.skills).map(([k, lv]) => [k, skillXpFor(lv) + 5])),
        loadouts: MOCK.loadouts.map((l, i) => ({ ...l, spells: [...l.spells], material: i === 0 ? 3 : 0 })),
        activeLoadout: 0,
        level,
      });
      sendStats(level, attuned, known);
      const inv = mockItems();
      applyItemEvent({ type: 'Event', kind: EV.inventory, entityId: 1, targetId: 0, value: 0, x: 0, y: 0, z: 0, data: new TextEncoder().encode(JSON.stringify({ v: 1, gold: inv.gold, quick: inv.quick, persist: 'memory', items: inv.items })) });
      if (!useProgression.getState().actions) {
        // Offline stand-ins: what the zone would answer with (combat_sync / Event 900).
        setProgressionActions({
          attune: () => {},
          learn: (id) => {
            const s = COMBAT.spells.find((x) => x.id === id);
            const c = useCombatHud.getState();
            if (!s || c.known.includes(s.key)) return;
            const next = [...c.known, s.key];
            c.set({ known: next });
            sendStats(useProgression.getState().stats?.level ?? level, attuned, next);
          },
          equipSpell: (l, slot, id) => {
            const c = useCombatHud.getState();
            const key = id ? (COMBAT.spells.find((x) => x.id === id)?.key ?? null) : null;
            const loadouts = c.loadouts.map((lo, i) => (i !== l ? lo : { ...lo, spells: lo.spells.map((x, j) => (j === slot ? key : x === key && key ? null : x)) }));
            c.set({ loadouts });
          },
        });
      }
      return { known: known.length, spent: spentOf(known), spells: known.map((k) => spellByKey.get(k)?.name) };
    },
  };
  (window as unknown as { __lodestoneSkills?: typeof handle }).__lodestoneSkills = handle;
  return () => {
    delete (window as unknown as { __lodestoneSkills?: typeof handle }).__lodestoneSkills;
  };
}
