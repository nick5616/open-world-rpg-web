// Playtest 5 (CR 055): a conversation's "Mark it on my map" (Event 1913) and
// the journal's Info tab (Event 1980) both end the same way: the zone has put
// a named pin on your map (Event 605). Here the client remembers the place for
// the guiding wisp (the next press of its key leads there before the tracked
// quest does) and says so in one line.
//
// "Marking on your map didn't work for pointing out where the horse stables
// are": the pin was there, an anonymous purple drop on unexplored paper, with
// no name on the map or the compass and nothing to lead you to it.

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { guideNote, noteMarked } from '../../world/guide/guideStore';
import { controlKeys } from '../tips/controlTips';
import { EV } from './events';
import { zoneEventListeners } from './store';

const utf8 = new TextDecoder();

/** The one line shown when a place is marked. */
export function markedLine(label: string, guideKeys: string[]): string {
  const key = guideKeys.length ? ` Press ${guideKeys.join(' / ')} and a wisp leads you there.` : '';
  return `Marked: ${label}.${key}`;
}

export function onPlaceEvent(ev: ZoneEvent): void {
  if (ev.kind !== EV.dialogMark && ev.kind !== EV.placeMarked) return;
  const label = ev.data.length ? utf8.decode(ev.data) : 'the place';
  noteMarked(ev.x / 100, ev.z / 100, label);
  // A conversation has its own note under the line; the journal and map have none.
  if (ev.kind === EV.placeMarked) guideNote(markedLine(label, controlKeys('guide')));
}

let installed = false;

/** Listen for the zone's place events (idempotent). */
export function installPlaceMarks(): void {
  if (installed) return;
  installed = true;
  zoneEventListeners.add(onPlaceEvent);
}
