// Connects the live zone session to the pets store: Events 1200-1219 in,
// Interact 130 out. NetPlay calls ensurePetHook before Hello (so the join's
// 1200 is never missed); the HUD re-checks it on a timer (reconnects, WP16
// failovers).

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { netRuntime } from '../../net/netStore';
import type { ZoneSession } from '../../net/zoneSession';
import { nameChunks, PET_ACT, PET_INTERACT } from './events';
import { applyPetEvent, resetPets, setPetActions, setPetSelf, type PetActions } from './store';

const listener = (e: ZoneEvent) => {
  if (e.kind >= 1200 && e.kind <= 1219) applyPetEvent(e);
};
let hooked: ZoneSession | null = null;

export function petActionsFor(s: ZoneSession): PetActions {
  const send = (action: number, target = 0n, arg = 0) => s.sendInteract(PET_INTERACT, target, action, arg >>> 0);
  return {
    feed: (creature) => send(PET_ACT.feed, BigInt(creature)),
    command: (cmd, target = 0) => send(PET_ACT.command, BigInt(target), cmd),
    pet: () => send(PET_ACT.pet),
    feedPet: () => send(PET_ACT.feedPet),
    name: (id, text) => nameChunks(text).forEach((chunk, i) => send(PET_ACT.name, BigInt(id | (i << 16)), chunk)),
    takeOut: (id) => send(PET_ACT.takeOut, BigInt(id)),
    stable: () => send(PET_ACT.stable),
    release: (id) => send(PET_ACT.release, BigInt(id)),
    sync: () => send(PET_ACT.sync),
    dev: (arg, target = 0) => send(PET_ACT.dev, BigInt(target), arg),
  };
}

/** Hook the live session if it changed (cheap; the HUD calls it on a timer). */
export function ensurePetHook(): void {
  const s = netRuntime.session;
  if (s === hooked) {
    if (s?.welcome) setPetSelf(s.welcome.entityId);
    return;
  }
  hooked?.eventListeners.delete(listener);
  hooked = s;
  if (s) {
    resetPets();
    s.eventListeners.add(listener);
    setPetActions(petActionsFor(s));
  } else setPetActions(null);
}
