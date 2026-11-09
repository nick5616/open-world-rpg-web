// Connects a zone session to the PvP store (playtest 2, CR 018): Events
// 990-997 in, Interact 70 out, PvP refusals of hit claims as messages, the
// /pvp and /duel chat commands. NetPlay calls it right after attachCombat
// (it chains the combat runtime's HitResult handler).

import type { Event as ZoneEvent, HitResult } from '@lodestone/contracts';
import type { ZoneSession } from '../../net/zoneSession';
import { drawnRemotes } from '../../net/netStore';
import { localPlayer } from '../../state/live';
import { pushNumber, toast } from '../../combat/store';
import { setGameCommandHandler } from '../../social/session';
import { INTERACT_PVP, PEV, PVP_ACT, hitRefusalText } from './events';
import { applyPvpEvent, resetPvp, setPvpActions, usePvp, type PvpActions } from './store';

const KINDS = new Set<number>(Object.values(PEV));
const REFUSAL_TOAST_MS = 2500;

type SessionLike = Pick<ZoneSession, 'eventListeners' | 'sendInteract' | 'welcome' | 'onHitResult'>;

/** A remote player's entity id by name (party members are always in the far ring). */
export function playerIdByName(name: string): number {
  const n = name.trim().toLowerCase();
  const v = drawnRemotes.views.find((r) => r.kind === 1 && r.name.toLowerCase() === n);
  return v?.id ?? 0;
}

/**
 * /pvp [on|off] · /duel Name · /duel accept|decline|yield · /yield.
 * Returns an error line for the chat, or null.
 */
export function runPvpCommand(verb: string, args: string, a: PvpActions | null = usePvp.getState().actions): string | null {
  if (!a) return 'Not in the world.';
  const arg = args.trim();
  const low = arg.toLowerCase();
  if (verb === 'pvp') {
    const s = usePvp.getState();
    if (low === 'on') a.setFlag(true);
    else if (low === 'off') a.setFlag(false);
    else if (low === '') a.setFlag(!s.flagged || s.turningOff);
    else return 'Usage: /pvp [on|off]';
    return null;
  }
  if (verb === 'yield') {
    a.yieldDuel();
    return null;
  }
  // duel
  if (low === 'accept' || low === 'yes') a.answer(true);
  else if (low === 'decline' || low === 'no') a.answer(false);
  else if (low === 'yield' || low === 'forfeit' || low === 'cancel') a.yieldDuel();
  else if (!arg) return 'Usage: /duel Name (a party member) · /duel accept|decline|yield';
  else {
    const id = playerIdByName(arg);
    if (!id) return `${arg} is not nearby.`;
    a.challenge(id);
  }
  return null;
}

export function attachPvp(session: SessionLike): () => void {
  resetPvp(session.welcome?.entityId ?? 0);
  let lastRefusal = 0;
  const onEvent = (ev: ZoneEvent) => {
    if (!KINDS.has(ev.kind)) return;
    const st = usePvp.getState();
    if (!st.selfId && session.welcome) usePvp.setState({ selfId: session.welcome.entityId });
    const before = st.notice;
    applyPvpEvent(ev);
    const after = usePvp.getState().notice;
    if (after && after !== before) toast(after.text);
    if (ev.kind === PEV.hit) pushNumber(localPlayer.pos.x, localPlayer.pos.y + 2.1, localPlayer.pos.z, ev.value, 'taken');
  };
  session.eventListeners.add(onEvent);
  // Hit claims on players the zone refused for a PvP reason: say why (once
  // in a while: a swing can claim several hits).
  const prev = session.onHitResult;
  const onHit = (r: HitResult) => {
    prev?.(r);
    if (r.accepted) return;
    const target = drawnRemotes.views.find((v) => v.id === r.targetId);
    if (!target || target.kind !== 1) return;
    const text = hitRefusalText(r.flags);
    const now = performance.now();
    if (text && now - lastRefusal > REFUSAL_TOAST_MS) {
      lastRefusal = now;
      toast(text);
    }
  };
  (session as { onHitResult: SessionLike['onHitResult'] }).onHitResult = onHit;
  const actions: PvpActions = {
    setFlag: (on) => session.sendInteract(INTERACT_PVP, 0n, PVP_ACT.flag, on ? 1 : 0),
    challenge: (id) => session.sendInteract(INTERACT_PVP, BigInt(id), PVP_ACT.challenge),
    answer: (accept, id) => {
      const from = id ?? usePvp.getState().challenge?.fromId ?? 0;
      session.sendInteract(INTERACT_PVP, BigInt(from), PVP_ACT.answer, accept ? 1 : 0);
      if (!accept) usePvp.setState({ challenge: null });
    },
    yieldDuel: () => session.sendInteract(INTERACT_PVP, 0n, PVP_ACT.yield),
  };
  setPvpActions(actions);
  setGameCommandHandler(runPvpCommand);
  const w = typeof window !== 'undefined' ? (window as unknown as { __lodestonePvp?: unknown }) : null;
  if (w) {
    w.__lodestonePvp = {
      state: () => {
        const s = usePvp.getState();
        return { flagged: s.flagged, turningOff: s.turningOff, safe: s.safe, safeName: s.safeName, challenge: s.challenge, duel: s.duel, banner: s.banner, feed: s.feed, notice: s.notice };
      },
      command: (verb: string, args = '') => runPvpCommand(verb, args),
      challengeByName: (name: string) => runPvpCommand('duel', name),
    };
  }
  return () => {
    session.eventListeners.delete(onEvent);
    if (session.onHitResult === onHit) (session as { onHitResult: SessionLike['onHitResult'] }).onHitResult = prev;
    setPvpActions(null);
    setGameCommandHandler(null);
    resetPvp();
  };
}
