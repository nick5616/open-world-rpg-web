// Connects a zone session to the progression store (playtest 1): Events
// 900-903 in, attune and learn Interacts out. NetPlay calls it right after
// it builds the session (like attachExploration), so the stats Event that
// follows Welcome is never missed.

import type { ZoneSession } from '../../net/zoneSession';
import { ACTION_ATTUNE, ACTION_LEARN, INTERACT_COMBAT, INTERACT_SITE, PEV } from './events';
import { applyProgressionEvent, resetProgression, setProgressionActions } from './store';

const KINDS = new Set<number>(Object.values(PEV));

export function attachProgression(session: Pick<ZoneSession, 'eventListeners' | 'sendInteract'>): () => void {
  resetProgression();
  const onEvent = (ev: Parameters<typeof applyProgressionEvent>[0]) => {
    if (KINDS.has(ev.kind)) applyProgressionEvent(ev);
  };
  session.eventListeners.add(onEvent);
  setProgressionActions({
    attune: (site) => session.sendInteract(INTERACT_SITE, BigInt(site), ACTION_ATTUNE),
    learn: (spellId) => session.sendInteract(INTERACT_COMBAT, 0n, ACTION_LEARN, spellId),
  });
  return () => {
    session.eventListeners.delete(onEvent);
    setProgressionActions(null);
  };
}
