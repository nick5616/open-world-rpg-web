// Connects the live zone session to the mount store: Events 1140-1159 in,
// Interact 110 out. NetPlay calls ensureMountHook before Hello (so the join's
// 1140 is never missed); the HUD re-checks it on a timer (reconnects, WP16
// failovers).

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { netRuntime } from '../../net/netStore';
import type { ZoneSession } from '../../net/zoneSession';
import { nameChunks, STEED_ACT, STEED_INTERACT } from './events';
import { applySteedEvent, resetMounts, setSteedActions, setSteedSelf, type SteedActions } from './store';

const listener = (e: ZoneEvent) => {
  if (e.kind >= 1140 && e.kind <= 1159) applySteedEvent(e);
};
let hooked: ZoneSession | null = null;

export function steedActionsFor(s: ZoneSession): SteedActions {
  const send = (action: number, target = 0n, arg = 0) => s.sendInteract(STEED_INTERACT, target, action, arg >>> 0);
  return {
    summon: () => send(STEED_ACT.summon),
    mount: () => send(STEED_ACT.mount),
    dismount: () => send(STEED_ACT.dismount),
    name: (text) => nameChunks(text).forEach((chunk, i) => send(STEED_ACT.name, BigInt(i), chunk)),
    colour: (i) => send(STEED_ACT.colour, 0n, i),
    dismiss: () => send(STEED_ACT.dismiss),
    sync: () => send(STEED_ACT.sync),
    dev: () => send(STEED_ACT.dev),
  };
}

/** Hook the live session if it changed (cheap; the HUD calls it on a timer). */
export function ensureMountHook(): void {
  const s = netRuntime.session;
  if (s === hooked) {
    if (s?.welcome) setSteedSelf(s.welcome.entityId);
    return;
  }
  hooked?.eventListeners.delete(listener);
  hooked = s;
  if (s) {
    resetMounts();
    s.eventListeners.add(listener);
    setSteedActions(steedActionsFor(s));
  } else setSteedActions(null);
}
