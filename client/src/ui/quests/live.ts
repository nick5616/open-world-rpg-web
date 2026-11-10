// Playtest 2: the tracked quest's markers as the HUD should point at them
// now (a person's marker follows that person: store.ts followPeople).

import { EntityKind } from '@lodestone/contracts';
import { drawnRemotes } from '../../net/netStore';
import type { QuestMarker, QuestView } from './events';
import { followPeople, type PersonSpot } from './store';

const people: PersonSpot[] = [];

export function liveMarkers(q: QuestView | null): QuestMarker[] {
  if (!q) return [];
  if (!q.markers.some((m) => !m.r && m.label.includes(', '))) return q.markers;
  people.length = 0;
  for (const v of drawnRemotes.views) if (v.kind === EntityKind.npc) people.push(v);
  return followPeople(q.markers, people);
}
