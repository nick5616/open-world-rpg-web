// The hand-off between the account screen and the play screen: WP04's
// AccountScreen produces a ReadySession (zone ticket, endpoints, character);
// the play screen connects with it. Null = play offline (solo, or "continue
// offline" from the account screen).

import { create } from 'zustand';
import type { ReadySession } from '../account/types';
import type { RemoteView } from './interpolation';
import type { ZoneSession } from './zoneSession';

interface NetState {
  ready: ReadySession | null;
  setReady: (r: ReadySession | null) => void;
}

export const useNetStore = create<NetState>()((set) => ({
  ready: null,
  setReady: (ready) => set({ ready }),
}));

/** The live session, for the debug handle and headless scripts (not reactive). */
export const netRuntime: { session: ZoneSession | null } = { session: null };

/** Last drawn remote views and their LOD level (headless scripts aim at what is on screen). */
export const drawnRemotes: { views: RemoteView[]; lod: Record<number, number> } = { views: [], lod: {} };

/**
 * JSON snapshot of the connection for the dev handle and the acceptance run:
 * transport, corrections, interpolation counters, what is drawn.
 */
export function netDebug() {
  const s = netRuntime.session;
  if (!s) return null;
  const p = s.prediction;
  return {
    phase: s.phase,
    transport: s.transport?.kind ?? null,
    attempts: s.attempts,
    entityId: s.welcome?.entityId ?? null,
    name: s.welcome?.name ?? null,
    tick: s.decoder.latest,
    rttMs: s.clock.minRtt,
    lastRttMs: s.clock.rtt,
    bandwidth: s.bandwidth(),
    bytes: { in: s.transport?.bytesIn ?? 0, out: s.transport?.bytesOut ?? 0 },
    stats: { ...s.stats },
    prediction: { reconciles: p.reconciles, agreements: p.agreements, maxError: p.maxError, unacked: p.unacked, ackSeq: p.ackSeq, log: p.log.slice() },
    interp: { ...s.interp.metrics, linkDelay: s.interp.linkDelay, arrival: s.interp.debugArrival() },
    remotes: drawnRemotes.views,
    lod: { ...drawnRemotes.lod },
    end: s.end,
    // WP16
    zoneId: s.zoneId,
    standby: [...s.standby.keys()],
    transfers: s.transfers.slice(),
  };
}
