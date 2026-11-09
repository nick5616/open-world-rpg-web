// Connects the live zone session to the quest store: Events 950-955 in,
// Interact 60 out. Hooked from the HUD's timer like townHud and the
// inventory's safety net (no NetPlay change), re-hooking when the session
// changes (a reconnect, a WP16 failover).

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { netRuntime } from '../../net/netStore';
import type { ZoneSession } from '../../net/zoneSession';
import { QUEST_ACT, QUEST_INTERACT } from './events';
import { applyQuestEvent, resetQuests, setQuestActions } from './store';

const listener = (e: ZoneEvent) => {
  if (e.kind >= 950 && e.kind <= 969) applyQuestEvent(e);
};
let hooked: ZoneSession | null = null;

export function questActionsFor(s: ZoneSession) {
  const send = (id: number, action: number) => s.sendInteract(QUEST_INTERACT, BigInt(id >>> 0), action, 0);
  return {
    accept: (id: number) => send(id, QUEST_ACT.accept),
    abandon: (id: number) => send(id, QUEST_ACT.abandon),
    turnIn: (id: number) => send(id, QUEST_ACT.turnIn),
    track: (id: number) => send(id, QUEST_ACT.track),
  };
}

/** Hook the live session if it changed (cheap; the HUD calls it on a timer). */
export function ensureQuestHook(): void {
  const s = netRuntime.session;
  if (s === hooked) return;
  hooked?.eventListeners.delete(listener);
  hooked = s;
  if (s) {
    resetQuests();
    s.eventListeners.add(listener);
    setQuestActions(questActionsFor(s));
  } else setQuestActions(null);
}

export function unhookQuests(): void {
  hooked?.eventListeners.delete(listener);
  hooked = null;
  setQuestActions(null);
}
