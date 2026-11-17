// Your own torch and familiar light (CR 042), as the zone says it (Event 1840;
// Interact 160 asks). The zone keeps the state, so a refusal or a fade
// (water, no mana, a fall) shows up here as the same event.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { familiarById, unpackLight } from './familiars';

export const EV_LIGHT_STATE = 1840;
export const EV_LIGHT_REFUSED = 1841;
export const INTERACT_LIGHT = 160;
export const LIGHT_ACT = { send: 0, torch: 1, dismiss: 2 } as const;

/** Event 1840 `data[0]`. */
export const WHY = { asked: 0, water: 1, mana: 2, downed: 3, resync: 4, noTorch: 5 } as const;
const WHY_TEXT: Record<number, string> = {
  [WHY.water]: 'The water puts your torch out.',
  [WHY.mana]: 'Your light fades: out of mana.',
  [WHY.downed]: 'Your light goes out.',
  [WHY.noTorch]: 'You have no torch.',
};
const REFUSE_TEXT: Record<number, string> = {
  1: 'You have no torch. Buy one from a general merchant or make one at a workbench.',
  2: "A torch won't light in the water.",
  3: 'Not now.',
};

export interface LightState {
  torch: boolean;
  /** combat.yaml familiar.id (0 none). */
  familiar: number;
  /** A line for the HUD to show a moment (reasons a light went out or could not be lit). */
  note: { text: string; at: number } | null;
}

export const useLights = create<LightState>(() => ({ torch: false, familiar: 0, note: null }));

/** Route a zone Event (1840 / 1841) into the store; true when it was a light event. */
export function applyLightEvent(e: ZoneEvent): boolean {
  if (e.kind === EV_LIGHT_STATE) {
    const l = unpackLight(e.value);
    const why = e.data?.[0] ?? 0;
    const fam = familiarById(l.familiar);
    const text = WHY_TEXT[why] ?? null;
    useLights.setState({ torch: l.torch, familiar: fam ? fam.id : 0, note: text ? { text, at: performance.now() } : useLights.getState().note });
    return true;
  }
  if (e.kind === EV_LIGHT_REFUSED) {
    const text = REFUSE_TEXT[e.value];
    if (text) useLights.setState({ note: { text, at: performance.now() } });
    return true;
  }
  return false;
}

/** Your light as the snapshot layout carries it (bit 0 torch, bits 1-5 the familiar). */
export function ownLightBits(): number {
  const s = useLights.getState();
  return (s.torch ? 1 : 0) | (s.familiar << 1);
}

export function resetLights(): void {
  useLights.setState({ torch: false, familiar: 0, note: null });
}
