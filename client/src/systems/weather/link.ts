// The zone's weather Events (CR 030, contracts/events.md 1220-1239) on the
// client: strikes it resolved (drawn, flashed, thundered), the warning a
// metal weapon gives before it draws a bolt, and your cold status.

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { localPlayer } from '../../state/live';
import { useNightHud } from '../night';
import { liveWeather, useWeatherHud, zoneBolt } from './runtime';

export const WEATHER_EV = { lightning: 1220, warn: 1221, status: 1222 } as const;
export const BOLT = { seeded: 1, drawn: 2, hit: 4, ignited: 8 } as const;
export const STATUS = { chilled: 1, warm: 2, cold: 4 } as const;

/** When your weapon last crackled (the HUD and the arms flash it). */
export const weatherFx = { crackleAt: 0, struckAt: 0 };

export function onWeatherEvent(e: ZoneEvent, me: number): void {
  const hud = useNightHud.getState();
  switch (e.kind) {
    case WEATHER_EV.lightning: {
      const flags = e.data[0] ?? 0;
      zoneBolt(e.targetId, e.x / 100, e.y / 100, e.z / 100, (flags & BOLT.hit) !== 0, localPlayer.pos);
      if (e.entityId === me && me !== 0) {
        weatherFx.struckAt = performance.now();
        liveWeather.flash = 2;
        hud.notice(`Struck by lightning!${e.value > 0 ? ` (−${e.value})` : ''}`, 'danger', 5000);
      }
      break;
    }
    case WEATHER_EV.warn:
      if (e.entityId === me && me !== 0) {
        weatherFx.crackleAt = performance.now();
        hud.notice('Your weapon crackles with static: lightning is coming! Switch to a bow or a staff.', 'danger', 4000);
      }
      break;
    case WEATHER_EV.status: {
      const s = useWeatherHud.getState();
      const chilled = (e.value & STATUS.chilled) !== 0;
      const cold = (e.value & STATUS.cold) !== 0;
      const warmS = (e.value & STATUS.warm) !== 0 ? e.targetId : 0;
      const onsetS = e.data.length >= 2 ? e.data[0] | (e.data[1] << 8) : 0;
      if (chilled && !s.chilled) hud.notice('You are chilled: no health regeneration. Find a fire, a roof or warm food.', 'night', 6000);
      else if (!chilled && s.chilled) hud.notice('You warm up.', 'dawn', 3000);
      if (warmS > 0 && s.warmS === 0) hud.notice(`Warm food: the cold can't touch you for ${Math.round(warmS / 60)} min.`, 'dawn', 4000);
      else if (cold && !s.cold && !chilled) hud.notice("It's freezing out here. Get to a fire or eat something warm.", 'night', 5000);
      s.set({ chilled, cold, warmS, onsetS });
      break;
    }
  }
}
