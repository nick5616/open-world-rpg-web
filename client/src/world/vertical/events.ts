// CR 038: the zone's vertical-world Events (contracts/events.md 1700-1719)
// on the client: a hard landing, the Depths' lava, and the hooks the sky
// palace and sky activity follow-ups replace (the sealed palace doors, the
// activity spot in a sky-town square).

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { useNightHud } from '../../systems/night';
import { useCombatHud } from '../../combat/store';
import { CHEST_COOLDOWN_MS, dwarfRuntime, EV_CHEST_OPENED, EV_DWARF_DISCOVER, EV_LOWER_HALLS, EV_TABLET_READ } from './dwarfKinds';

export const VERTICAL_EV = { fallDamage: 1700, lava: 1701, palaceDoor: 1702, activity: 1703 } as const;

/** When you last landed hard / burned (the HUD flashes them). */
export const verticalFx = { landedAt: 0, burning: false };

/** CR 043: the dwarves' Events 1860-1863 (found a hall, a chest, a tablet, the lower halls' warden). */
export function onDwarfEvent(e: ZoneEvent, me: number): void {
  const hud = useNightHud.getState();
  switch (e.kind) {
    case EV_DWARF_DISCOVER: {
      if (e.entityId !== me) return;
      dwarfRuntime.found.add(e.targetId);
      const name = dwarfRuntime.siteName(e.targetId) ?? (e.value === 1 ? 'a dwarven stronghold' : 'a hidden dwarven camp');
      hud.notice(`You found ${name}.`, 'dawn', 7000);
      break;
    }
    case EV_CHEST_OPENED: {
      if (e.entityId !== me) return;
      dwarfRuntime.openedAt.set(e.targetId, performance.now());
      if (e.value === 0) {
        hud.notice('The chest is empty.', 'info', 2500);
      } else {
        dwarfRuntime.openChest(e.targetId);
        hud.notice(e.value >= 3 ? 'A dwarven strongbox swings open.' : 'The chest creaks open.', 'info', 3000);
      }
      break;
    }
    case EV_TABLET_READ: {
      if (e.entityId !== me) return;
      const text = new TextDecoder().decode(e.data);
      if (text) hud.notice(`The tablet reads: "${text}"`, 'night', 11000);
      break;
    }
    case EV_LOWER_HALLS: {
      // The warden wakes (0) / falls (1); entityId is the boss. A calm banner (no flashing), and a boss bar
      // through the combat HUD's own (the bar fills from the boss's health events as for every boss).
      const combat = useCombatHud.getState();
      if (e.value === 1) {
        hud.notice('The Deep Warden has fallen', 'dawn', 7000);
        if (combat.boss && combat.boss.id === e.entityId) combat.set({ boss: null });
      } else {
        hud.notice('The Deep Warden wakes', 'danger', 6000);
        if (!combat.boss && e.entityId) combat.set({ boss: { id: e.entityId, name: 'The Deep Warden', phase: 1, phases: 1, pct: 100 } });
      }
      break;
    }
  }
}

export const chestCooling = (idx: number): boolean => {
  const t = dwarfRuntime.openedAt.get(idx);
  return t !== undefined && performance.now() - t < CHEST_COOLDOWN_MS;
};

export function onVerticalEvent(e: ZoneEvent, me: number): void {
  const hud = useNightHud.getState();
  if (e.entityId !== me && e.kind <= VERTICAL_EV.lava) return;
  switch (e.kind) {
    case VERTICAL_EV.fallDamage:
      verticalFx.landedAt = performance.now();
      hud.notice(`A hard landing (${Math.round(e.targetId / 10)} m/s): −${e.value}. Open your glider before the ground!`, 'danger', 4500);
      break;
    case VERTICAL_EV.lava:
      verticalFx.burning = e.value === 1;
      if (e.value === 1) hud.notice('Lava! Get out of it!', 'danger', 3000);
      break;
    case VERTICAL_EV.palaceDoor:
      hud.notice('The palace doors are sealed. Something within is waiting.', 'night', 5000);
      break;
    case VERTICAL_EV.activity:
      hud.notice('A challenge will be held here. Come back soon.', 'dawn', 4000);
      break;
  }
}
