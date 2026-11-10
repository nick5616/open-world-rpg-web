// Connects a zone session to a combat runtime (WP13). NetPlay calls
// attachCombat right after it builds the session (like WP12's
// attachExploration), so the combat_sync after Welcome is never missed.

import type { ZoneSession } from '../net/zoneSession';
import type { GroundQuery } from '../sim/ground';
import { CombatRuntime } from './runtime';
import { useCombatHud } from './store';
import { drawnRemotes } from '../net/netStore';
import { dashSlamEvent } from './dashFeel';

/** The live runtime (PlayerController hook, 3D layer, dev handle). */
export const combatRuntime: { current: CombatRuntime | null } = { current: null };

export function attachCombat(session: ZoneSession, ground: GroundQuery, input = true): () => void {
  const rt = new CombatRuntime({
    sendHitClaim: (c) => session.sendHitClaim(c),
    sendInteract: (k, id, a, arg) => session.sendInteract(k, id, a, arg),
    latestTick: () => session.decoder.latest,
    selfId: () => session.welcome?.entityId ?? 0,
  });
  rt.ground = ground;
  const onEvent = (ev: Parameters<CombatRuntime['onEvent']>[0]) => {
    rt.onEvent(ev);
    if (ev.kind === 230) dashSlamEvent(ev); // CR 021: a flight dived into the ground (dashFeel.ts)
  };
  session.eventListeners.add(onEvent);
  session.onHitResult = (r) => rt.onHitResult(r);
  if (input && typeof window !== 'undefined') rt.attachInput(window);
  combatRuntime.current = rt;
  const w = typeof window !== 'undefined' ? (window as unknown as { __lodestoneCombat?: unknown }) : null;
  if (w) {
    // CR 020: interact() lets dev runs grant and slot spells (combat Interact 50; ActDevGrant needs a dev zone).
    w.__lodestoneCombat = { runtime: rt, probe: () => rt.probe.summary(), hud: () => ({ ...useCombatHud.getState() }), interact: (kind: number, action: number, arg: number) => session.sendInteract(kind, 0n, action, arg) };
    (w as unknown as { __lodestoneDrawn?: unknown }).__lodestoneDrawn = () => drawnRemotes.views; // headless runs aim at what is drawn
  }
  return () => {
    session.eventListeners.delete(onEvent);
    session.onHitResult = null;
    rt.dispose();
    if (combatRuntime.current === rt) combatRuntime.current = null;
    useCombatHud.getState().set({ active: false, boss: null });
  };
}

/** PlayerDriver additions (PlayerController wires them into LocalSim). */
export function combatDriverHooks() {
  return {
    combatHook: (seq: number, before: Parameters<CombatRuntime['stepHook']>[1], sprinting: boolean) => combatRuntime.current?.stepHook(seq, before, sprinting) ?? { flags: 0, castSlot: 0 },
    afterStep: (seq: number, state: Parameters<CombatRuntime['afterStep']>[1]) => combatRuntime.current?.afterStep(seq, state),
    blockInput: () => (combatRuntime.current?.timeline.downed ?? false),
  };
}
