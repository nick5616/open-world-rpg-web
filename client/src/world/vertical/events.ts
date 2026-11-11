// CR 038: the zone's vertical-world Events (contracts/events.md 1700-1719)
// on the client: a hard landing, the Depths' lava, and the hooks the sky
// palace and sky activity follow-ups replace (the sealed palace doors, the
// activity spot in a sky-town square).

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { useNightHud } from '../../systems/night';

export const VERTICAL_EV = { fallDamage: 1700, lava: 1701, palaceDoor: 1702, activity: 1703 } as const;

/** When you last landed hard / burned (the HUD flashes them). */
export const verticalFx = { landedAt: 0, burning: false };

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
