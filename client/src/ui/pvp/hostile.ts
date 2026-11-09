// The combat runtime's question (playtest 2, CR 017): is this remote player
// someone I may attack right now? Reads the PvP store and my party (Event
// 607, the map store). Kept free of React so the runtime can import it.

import { useExploration } from '../map/store';
import { hostileTo, usePvp, type RemoteLike } from './store';

export function isHostilePlayer(v: RemoteLike): boolean {
  if (v.kind !== 1) return false;
  const s = usePvp.getState();
  if (!s.flagged && !s.duel) return false;
  return hostileTo(v, { flagged: s.flagged, party: useExploration.getState().partyId, duel: s.duel });
}
