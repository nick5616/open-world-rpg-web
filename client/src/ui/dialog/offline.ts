// Offline (solo, no zone) conversation: a small local one so the flow can be
// seen without servers. The real talk (temperaments, memory, rumours that
// point at real places, quests) is the zone's (server/zone/internal/dialog).

import type { Candidate } from '../../world/buildings/interact';
import { MERCHANT_LABEL, NPC_ROLE_LABEL } from '../../world/buildings/townEvents';
import type { DialogChoice, DialogNode } from './events';

const OFFLINE_LINES: Record<number, string[]> = {
  0: ['Fine day for a walk, traveller.', 'Mind the road after dark. The demons keep to the wilds, mostly.', 'The well water is the sweetest this side of the hills.'],
  1: ['Have a look, have a look! Fair prices for fair folk.', 'Fresh stock this morning, straight off the cart.'],
  2: ['Bring me ore and I will make it worth carrying.', 'Careful, the forge bites.'],
  3: ['A warm bed and a hot meal: that is all anyone needs.', 'Rest a while, the road will keep.'],
  4: ['The board is full again. Folk need brave hands.', 'Bandits to the north, a demon by the mill... take your pick.'],
  5: ['The barley is coming in nicely this year.', 'Crows again. Always the crows.'],
  6: ['Keep the peace and we will get along.', 'Move along, nothing to see.'],
};

const hashStr = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

const CHOICES: DialogChoice[] = [
  { id: 1, text: 'Heard anything strange lately?', kind: 'rumour', tag: 'Rumour' },
  { id: 2, text: 'Take care.', kind: 'leave', tag: 'Leave' },
];

export function offlineNode(c: Candidate): DialogNode {
  const lines = OFFLINE_LINES[c.role] ?? OFFLINE_LINES[0];
  const role = NPC_ROLE_LABEL[c.role] ?? 'villager';
  const title = c.role === 1 ? `${role}, ${MERCHANT_LABEL[c.merchant] ?? 'goods'}` : role;
  return {
    npc: { id: c.entityId ?? 0, name: c.name || 'Villager', role: c.role, title },
    seq: 1,
    aff: 0,
    met: false,
    line: lines[hashStr(c.name) % lines.length],
    choices: CHOICES,
  };
}

/** The local reply to a choice: a farewell (the box closes after it) for the way out. */
export function offlineReply(from: DialogNode, ch: DialogChoice): DialogNode {
  if (ch.kind === 'leave') return { ...from, seq: from.seq + 1, line: 'Safe travels.', bye: true, check: undefined, choices: [] };
  return {
    ...from,
    seq: from.seq + 1,
    line: '(offline) I would point you at something real, but I only know what the zone tells me. Connect to a zone and ask again.',
    check: undefined,
    choices: [{ id: 2, text: 'Take care.', kind: 'leave', tag: 'Leave' }],
  };
}
