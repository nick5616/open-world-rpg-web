// Connects the live zone session to the camp store: Events 1100-1119 in,
// Interact 90 out. NetPlay calls ensureCampHook before Hello (so the first
// area baseline is never missed); the HUD re-checks it on a timer, re-hooking
// when the session changes (a reconnect, a WP16 failover).

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { netRuntime } from '../../net/netStore';
import type { ZoneSession } from '../../net/zoneSession';
import { buildArg, CAMP_ACT, CAMP_INTERACT, labelChunks, placeTarget } from './events';
import { applyCampEvent, resetCamps, setCampActions, setCampSelf, type CampActions } from './store';

const listener = (e: ZoneEvent) => {
  if ((e.kind >= 1100 && e.kind <= 1119) || (e.kind >= 1820 && e.kind <= 1839)) applyCampEvent(e);
};
let hooked: ZoneSession | null = null;

const id40 = (id: number) => BigInt(Math.floor(id)) & ((1n << 40n) - 1n);

export function campActionsFor(s: ZoneSession): CampActions {
  const send = (target: bigint, action: number, arg = 0) => s.sendInteract(CAMP_INTERACT, target, action, arg >>> 0);
  return {
    place: (kind, rot, x, z, y = null) => send(placeTarget(kind, rot, Math.round(x * 100), Math.round(z * 100)), CAMP_ACT.place, buildArg(y === null ? null : Math.round(y * 100))),
    repair: (id) => send(id40(id), CAMP_ACT.repair),
    home: () => send(0n, CAMP_ACT.home),
    share: (on) => send(0n, CAMP_ACT.share, on ? 1 : 0),
    buildSync: () => send(0n, CAMP_ACT.buildSync),
    pickup: (id) => send(id40(id), CAMP_ACT.pickup),
    use: (id) => send(id40(id), CAMP_ACT.use),
    fuel: (id, n = 0) => send(id40(id), CAMP_ACT.fuel, n),
    put: (piece, handle, qty = 0) => send(id40(piece) | (BigInt(qty & 0xffff) << 40n), CAMP_ACT.put, handle),
    take: (piece, slot) => send(id40(piece) | (BigInt(slot & 0xff) << 40n), CAMP_ACT.take),
    label: (piece, text) => labelChunks(text).forEach((chunk, i) => send(id40(piece) | (BigInt(i) << 40n), CAMP_ACT.label, chunk)),
    lock: (piece, party) => send(id40(piece), CAMP_ACT.lock, party ? 1 : 0),
    dev: () => send(0n, CAMP_ACT.dev),
    sync: () => send(0n, CAMP_ACT.sync),
  };
}

/** Hook the live session if it changed (cheap; the HUD calls it on a timer). */
export function ensureCampHook(): void {
  const s = netRuntime.session;
  if (s === hooked) {
    if (s?.welcome) setCampSelf(s.welcome.entityId);
    return;
  }
  hooked?.eventListeners.delete(listener);
  hooked = s;
  if (s) {
    resetCamps();
    s.eventListeners.add(listener);
    setCampActions(campActionsFor(s));
  } else setCampActions(null);
}
