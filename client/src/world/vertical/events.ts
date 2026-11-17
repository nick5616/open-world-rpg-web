// CR 038: the zone's vertical-world Events (contracts/events.md 1700-1719)
// on the client: a hard landing, the Depths' lava, and the hooks the sky
// palace and sky activity follow-ups replace (the sealed palace doors, the
// activity spot in a sky-town square).

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { useNightHud } from '../../systems/night';
import { applyPalaceWire, type PalaceWire } from '../palace/palaceStore';

export const VERTICAL_EV = { fallDamage: 1700, lava: 1701, palaceDoor: 1702, activity: 1703, palaceState: 1704, palaceNote: 1705, shrineState: 1890, shrineReward: 1891 } as const;

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
      // CR 044: the doors answer with the palace's phase (0 it was asleep: it wakes now).
      hud.notice(e.value === 0 ? 'The great doors swing wide. The halls are waking.' : e.value === 3 ? 'The doors stand open. The Sky Guardian has fallen.' : 'The great doors stand open. Strike the three wards.', 'night', 5000);
      break;
    case VERTICAL_EV.palaceState:
      try {
        applyPalaceWire(JSON.parse(new TextDecoder().decode(e.data ?? new Uint8Array(0))) as PalaceWire);
      } catch {
        /* a malformed state is ignored */
      }
      break;
    case VERTICAL_EV.palaceNote:
      hud.notice(new TextDecoder().decode(e.data ?? new Uint8Array(0)), e.value === 2 ? 'danger' : e.value >= 3 ? 'dawn' : 'night', 6000);
      break;
    case VERTICAL_EV.shrineState:
      shrineNotice(e, hud);
      break;
    case VERTICAL_EV.shrineReward: {
      const names = new TextDecoder().decode(e.data ?? new Uint8Array(0));
      hud.notice(`The shrine's fire goes out. ${e.value} gold${names ? ` and ${names.split(',').length} piece(s) of gear` : ''}.`, 'dawn', 6000);
      break;
    }
    case VERTICAL_EV.activity:
      hud.notice('A challenge will be held here. Come back soon.', 'dawn', 4000);
      break;
  }
}

/** CR 044: a Depths demon shrine's cleansing (Event 1890; data = [wave, waves]). */
export const SHRINE_STATE = { busy: 0, started: 1, waveDone: 2, cleansed: 3, failed: 4 } as const;

export function shrineNotice(e: ZoneEvent, hud: ReturnType<typeof useNightHud.getState>): void {
  const wave = e.data?.[0] ?? 0;
  const waves = e.data?.[1] ?? 0;
  switch (e.value) {
    case SHRINE_STATE.busy:
      hud.notice('This shrine is quiet. You have cleansed it already; come back later.', 'night', 4500);
      break;
    case SHRINE_STATE.started:
      hud.notice(`The shrine flares. Wave ${wave} of ${waves}: hold the circle!`, 'danger', 4500);
      break;
    case SHRINE_STATE.waveDone:
      hud.notice(`Wave ${wave} of ${waves} wakes around you.`, 'danger', 4000);
      break;
    case SHRINE_STATE.cleansed:
      hud.notice('The shrine is cleansed.', 'dawn', 5000);
      break;
    case SHRINE_STATE.failed:
      hud.notice('The shrine grows dark again. Nobody held the circle.', 'night', 4000);
      break;
  }
}
