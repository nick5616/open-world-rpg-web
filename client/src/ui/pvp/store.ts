// PvP and duel client state (playtest 2, CR 017): zustand, updated at event
// rate. `reducePvp` is a pure function of (state, event, now) so the whole
// flow is unit-tested (pvp.test.ts); `hostileTo` decides which remote
// players the combat runtime may predict hits on.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { DUEL_END, DUEL_PHASE, PEV, TYPE_PVP_FLAG, decodeDuelState, decodeKill, decodeState, refusalText, textOf } from './events';

export interface DuelView {
  id: number;
  opponentId: number;
  opponentName: string;
  phase: number;
  center: { x: number; y: number; z: number };
  radius: number;
  /** performance.now() when the phase ends (countdown: the fight starts; fight: the time cap). */
  phaseEnd: number;
  /** performance.now() deadline of the outside-the-ring forfeit (0 = inside). */
  forfeitAt: number;
}

export interface Challenge {
  duelId: number;
  fromId: number;
  fromName: string;
  until: number;
}

export interface Banner {
  text: string;
  kind: 'won' | 'lost' | 'draw' | 'info';
  at: number;
}

export interface FeedLine {
  id: number;
  text: string;
  at: number;
  mine: boolean;
}

export interface PvpActions {
  setFlag(on: boolean): void;
  challenge(entityId: number): void;
  answer(accept: boolean, challengerId?: number): void;
  yieldDuel(): void;
}

export interface PvpState {
  selfId: number;
  flagged: boolean;
  turningOff: boolean;
  /** performance.now() when a waiting turn-off applies (0 none). */
  offAt: number;
  safe: boolean;
  safeName: string;
  challenge: Challenge | null;
  duel: DuelView | null;
  banner: Banner | null;
  feed: FeedLine[];
  /** Last message for the player (refusals, flag changes); the HUD toasts it. */
  notice: { text: string; at: number; error: boolean } | null;
  actions: PvpActions | null;
}

export const BANNER_MS = 4500;
export const FEED_MS = 9000;
const FEED_MAX = 5;

export const initialPvp = (): Omit<PvpState, 'actions'> => ({
  selfId: 0,
  flagged: false,
  turningOff: false,
  offAt: 0,
  safe: false,
  safeName: '',
  challenge: null,
  duel: null,
  banner: null,
  feed: [],
  notice: null,
});

export const usePvp = create<PvpState>(() => ({ ...initialPvp(), actions: null }));

let feedId = 1;

/** Apply one PvP Event (980-987); returns the patch (null: not ours). */
export function reducePvp(s: PvpState, ev: ZoneEvent, now: number): Partial<PvpState> | null {
  const self = s.selfId;
  switch (ev.kind) {
    case PEV.state: {
      const st = decodeState(ev);
      const patch: Partial<PvpState> = { flagged: st.flagged, turningOff: st.turningOff, offAt: st.turningOff ? now + st.offInMs : 0, safe: st.safe, safeName: st.safeName };
      if (st.flagged && !s.flagged) patch.notice = { text: 'PvP on: flagged players outside your party can attack you (and you them) outside towns and the Haven.', at: now, error: false };
      else if (!st.flagged && s.flagged) patch.notice = { text: 'PvP off.', at: now, error: false };
      else if (st.turningOff && !s.turningOff) patch.notice = { text: `PvP turns off in ${Math.round(st.offInMs / 1000)} s.`, at: now, error: false };
      else if (st.safe && !s.safe) patch.notice = { text: `Safe zone: ${st.safeName}. No PvP here.`, at: now, error: false };
      return patch;
    }
    case PEV.refused:
      return { notice: { text: refusalText(ev.value, ev.targetId), at: now, error: true } };
    case PEV.kill: {
      const k = decodeKill(ev);
      const mine = k.killerId === self || k.victimId === self;
      const text = k.killerId === self ? `You defeated ${k.victim}` : k.victimId === self ? `${k.killer} defeated you` : `${k.killer} defeated ${k.victim}`;
      const feed = [...s.feed, { id: feedId++, text, at: now, mine }].slice(-FEED_MAX);
      return { feed };
    }
    case PEV.challenge:
      return { challenge: { duelId: ev.targetId, fromId: ev.entityId, fromName: textOf(ev), until: now + ev.value } };
    case PEV.duelState: {
      const d = decodeDuelState(ev);
      if (!d) return null;
      const patch: Partial<PvpState> = {
        duel: { id: d.duelId, opponentId: d.opponentId, opponentName: d.opponentName, phase: d.phase, center: d.center, radius: d.radius, phaseEnd: now + d.phaseMs, forfeitAt: 0 },
      };
      if (d.phase >= DUEL_PHASE.countdown) patch.challenge = null;
      if (d.phase === DUEL_PHASE.waiting) patch.notice = { text: `Duel challenge sent to ${d.opponentName}.`, at: now, error: false };
      return patch;
    }
    case PEV.duelOutside:
      if (!s.duel) return null;
      return { duel: { ...s.duel, forfeitAt: ev.value > 0 ? now + ev.value : 0 } };
    case PEV.duelEnded: {
      const text = textOf(ev);
      let kind: Banner['kind'] = 'info';
      let head = text;
      if (ev.entityId !== 0 && ev.entityId === self) {
        kind = 'won';
        head = 'Victory!';
      } else if (ev.targetId !== 0 && ev.targetId === self) {
        kind = 'lost';
        head = 'Defeat';
      } else if (ev.value === DUEL_END.timeUp) {
        kind = 'draw';
        head = 'Draw';
      }
      const fought = ev.value >= DUEL_END.defeated && ev.value <= DUEL_END.yielded;
      return {
        duel: null,
        challenge: null,
        banner: fought || kind !== 'info' ? { text: kind === 'info' ? text : `${head}|${text}`, kind, at: now } : null,
        notice: fought ? null : { text, at: now, error: false },
      };
    }
  }
  return null;
}

export function applyPvpEvent(ev: ZoneEvent, now = performance.now()): void {
  const patch = reducePvp(usePvp.getState(), ev, now);
  if (patch) usePvp.setState(patch);
}

/** Drop expired banners, feed lines and challenges (the HUD calls it ~2 Hz). */
export function prunePvp(now = performance.now()): void {
  const s = usePvp.getState();
  const patch: Partial<PvpState> = {};
  if (s.banner && now - s.banner.at > BANNER_MS) patch.banner = null;
  if (s.feed.some((f) => now - f.at > FEED_MS)) patch.feed = s.feed.filter((f) => now - f.at <= FEED_MS);
  if (s.challenge && now > s.challenge.until) patch.challenge = null;
  if (Object.keys(patch).length) usePvp.setState(patch);
}

export function resetPvp(selfId = 0): void {
  usePvp.setState({ ...initialPvp(), selfId });
}

export function setPvpActions(a: PvpActions | null): void {
  usePvp.setState({ actions: a });
}

/** What the rules need from a remote entity (net/interpolation RemoteView). */
export interface RemoteLike {
  id: number;
  kind: number;
  typeId?: number;
  partyId: number;
  healthPct: number;
}

/**
 * May I hit this remote player? The duel opponent while the fight is on;
 * otherwise a flagged player outside my party while I am flagged. The zone
 * decides for real (safe zones too: a refused claim says why); this only
 * picks what the runtime predicts hits on.
 */
export function hostileTo(v: RemoteLike, me: { flagged: boolean; party: number; duel: Pick<DuelView, 'opponentId' | 'phase'> | null }): boolean {
  if (v.kind !== 1 || v.healthPct <= 0) return false;
  if (me.duel && me.duel.phase === DUEL_PHASE.fighting && me.duel.opponentId === v.id) return true;
  if (!me.flagged || ((v.typeId ?? 0) & TYPE_PVP_FLAG) === 0) return false;
  return !(me.party !== 0 && v.partyId === me.party);
}
