// Connects the live zone session to the story store: Events 1600-1629 in,
// Interact 140 out. Hooked before Hello (NetPlay) and re-hooked from the
// HUD's timer after a reconnect, like ui/quests/link.ts. An act's title
// card goes through the discovery intro queue (ui/intro), the revive window
// stretches the downed screen's countdown.

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { netRuntime } from '../../net/netStore';
import type { ZoneSession } from '../../net/zoneSession';
import { useCombatHud } from '../../combat/store';
import { pushIntro } from '../intro/queue';
import { SEV, STORY_ACT, STORY_INTERACT, decodeJSON, type ReviveWindow, type StoryIntro } from './events';
import { applyStoryEvent, resetStory, setStoryActions, setStorySelf, useStory, type StoryActions } from './store';

function sideEffects(e: ZoneEvent): void {
  const now = performance.now();
  if (e.kind === SEV.intro) {
    const c = decodeJSON<StoryIntro>(e);
    if (c) pushIntro({ key: `act:${c.act}:${Math.round(now / 60000)}`, variant: 'region', eyebrow: c.eyebrow, title: c.title, subtitle: c.subtitle, accent: '#ffd166' });
  } else if (e.kind === SEV.reviveWindow) {
    const w = decodeJSON<ReviveWindow>(e);
    if (w && w.id === useStory.getState().self && useCombatHud.getState().downedUntil > 0) useCombatHud.getState().set({ downedUntil: now + w.ms });
  }
}

const listener = (e: ZoneEvent) => {
  if (e.kind < 1600 || e.kind > 1629) return;
  applyStoryEvent(e);
  sideEffects(e);
};
let hooked: ZoneSession | null = null;

export function storyActionsFor(s: ZoneSession): StoryActions {
  const send = (id: number, action: number, arg = 0) => s.sendInteract(STORY_INTERACT, BigInt(id >>> 0), action, arg);
  return {
    sync: () => send(0, STORY_ACT.sync),
    catchUp: () => send(0, STORY_ACT.catchUp),
    revive: (target, on) => send(target, STORY_ACT.revive, on ? 1 : 0),
    respawn: () => send(0, STORY_ACT.respawn),
    vow: (on) => send(0, STORY_ACT.vow, on ? 1 : 0),
  };
}

/** Hook the live session if it changed (cheap; the HUD calls it on a timer). */
export function ensureStoryHook(): void {
  const s = netRuntime.session;
  if (s === hooked) {
    if (s?.welcome) setStorySelf(s.welcome.entityId);
    return;
  }
  hooked?.eventListeners.delete(listener);
  hooked = s;
  if (s) {
    resetStory();
    s.eventListeners.add(listener);
    setStoryActions(storyActionsFor(s));
    if (s.welcome) setStorySelf(s.welcome.entityId);
  } else setStoryActions(null);
}
