// Playtest 2 emotes: the live zone session in (Event 1090 others' emotes,
// 1091 refusals) and out (Interact 89), the /emote chat command, and
// playing your own emote (your body animates at once; the zone tells the
// players near you).

import type { Event as ZoneEvent, EmoteDef } from '@lodestone/contracts';
import { create } from 'zustand';
import { netRuntime } from '../../net/netStore';
import type { ZoneSession } from '../../net/zoneSession';
import { view } from '../../state/live';
import { setEmoteCommandHandler } from '../../social/session';
import { useSocialStore } from '../../social/store';
import { EMOTE_ACT, EMOTE_INTERACT, EMOTE_REFUSAL, EV_EMOTE, EV_EMOTE_REFUSED, parseEmoteCommand, WHEEL } from './emotes';
import { applyEmoteEvent, clearEmotes, emoteOf, localEmote, localLimiter, SELF, setEmote } from './store';

/** A short line under the crosshair (refusals, "slow down"). */
export const useEmoteToast = create<{ text: string; at: number }>(() => ({ text: '', at: 0 }));
const toast = (text: string) => useEmoteToast.setState({ text, at: performance.now() });

/** Hooks other features into playing an emote (fishing reels its line in). */
export const emoteHooks = { beforePlay: null as null | (() => void) };

let lastId = 1;
/** The emote a quick tap of H replays. */
export function lastEmoteId(): number {
  return lastId;
}

/** Play one of your emotes (the wheel, /emote, a tap of H). Returns false when refused here. */
export function playEmote(def: EmoteDef, now = performance.now()): boolean {
  if (def.system) return false;
  if (!localLimiter.take(now)) {
    toast(EMOTE_REFUSAL[2]);
    return false;
  }
  emoteHooks.beforePlay?.();
  lastId = def.id;
  setEmote(SELF, def.id, 0, view.feet.x, view.feet.y, view.feet.z, now);
  localEmote.id = def.id;
  localEmote.n++;
  localEmote.at = now;
  netRuntime.session?.sendInteract(EMOTE_INTERACT, BigInt(def.id), EMOTE_ACT.play);
  return true;
}

/** End your looping emote (sit, dance, rest). */
export function stopEmote(): void {
  const r = emoteOf(SELF);
  if (r && r.id) setEmote(SELF, 0, 0, view.feet.x, view.feet.y, view.feet.z);
  netRuntime.session?.sendInteract(EMOTE_INTERACT, 0n, EMOTE_ACT.stop);
}

function runEmoteCommand(args: string): string | null {
  const c = parseEmoteCommand(args);
  switch (c.kind) {
    case 'list':
      useSocialStore.getState().localNotice(`Emotes: ${WHEEL.map((e) => e.key).join(', ')} (or hold H)`);
      return null;
    case 'stop':
      stopEmote();
      return null;
    case 'error':
      return c.message;
    case 'play':
      playEmote(c.emote);
      return null;
  }
}

const listener = (e: ZoneEvent) => {
  if (e.kind === EV_EMOTE) applyEmoteEvent(e);
  else if (e.kind === EV_EMOTE_REFUSED) {
    toast(EMOTE_REFUSAL[e.value] ?? 'Not now');
    setEmote(SELF, 0, 0, view.feet.x, view.feet.y, view.feet.z); // the zone said no: stop your own too
  }
};
let hooked: ZoneSession | null = null;

/** Hook the live session if it changed (the wheel calls it on a timer). */
export function ensureEmoteHook(): void {
  const s = netRuntime.session;
  setEmoteCommandHandler(runEmoteCommand);
  if (s === hooked) return;
  hooked?.eventListeners.delete(listener);
  hooked = s;
  clearEmotes();
  s?.eventListeners.add(listener);
}
