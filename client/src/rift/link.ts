// CR 040: connects the live zone session to the rift store (Events
// 2000-2019 in, Interact 190 out), like ui/story/link.ts: hooked from the
// HUD's timer, re-hooked after a reconnect. The arena reaches the movement
// ground synchronously inside the listener, before the teleport that
// follows it on the same reliable channel is applied.

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { netRuntime } from '../net/netStore';
import type { ZoneSession } from '../net/zoneSession';
import { bulletClock, type ClockInput } from './clock';
import { applyRiftEvent, resetRift, RIFT_ACT, RIFT_INTERACT, setRiftActions, setRiftSelf, type RiftActions } from './store';

const listener = (e: ZoneEvent) => {
  if (e.kind < 2000 || e.kind > 2019) return;
  applyRiftEvent(e);
};
let hooked: ZoneSession | null = null;

export function riftActionsFor(s: ZoneSession): RiftActions {
  const send = (id: number, action: number, arg = 0) => s.sendInteract(RIFT_INTERACT, BigInt(id >>> 0), action, arg);
  return {
    enter: (portal) => send(portal, RIFT_ACT.enter),
    pick: (perk) => send(0, RIFT_ACT.perk, perk),
    leave: () => send(0, RIFT_ACT.leave),
    board: (chapter) => send(0, RIFT_ACT.board, chapter),
  };
}

/** Hook the live session if it changed (cheap; the HUD calls it on a timer). */
export function ensureRiftHook(): void {
  const s = netRuntime.session;
  if (s === hooked) {
    if (s?.welcome) setRiftSelf(s.welcome.entityId);
    return;
  }
  hooked?.eventListeners.delete(listener);
  hooked = s;
  resetRift();
  bulletClock.reset();
  if (s) {
    s.eventListeners.add(listener);
    const actions = riftActionsFor(s);
    setRiftActions(actions);
    if (s.welcome) {
      setRiftSelf(s.welcome.entityId);
      // Playtest 6 polish: hooked after the zone's join list went by (a reconnect, a remount): ask for the
      // open rifts (the board request answers with every chapter's board and the portals), or none show
      // until the next window.
      actions.board(0);
    }
  } else setRiftActions(null);
}

/** The bullet clock's inputs from the live session. */
export function clockInput(): ClockInput | null {
  const s = netRuntime.session;
  const f = s?.latestFrame;
  if (!s || !f) return null;
  return { tick: f.tick, ackSeq: f.ackInputSeq, lastSeq: s.lastStepSeq };
}
