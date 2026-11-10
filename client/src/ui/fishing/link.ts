// Playtest 2 fishing: the live zone session in (Events 1080-1084) and out
// (Interact 88); your own fishing pose and line go through the emote
// record (ui/emotes/store.ts SELF, ids 20 and 21) like everyone else's.

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { netRuntime } from '../../net/netStore';
import type { ZoneSession } from '../../net/zoneSession';
import { localPlayer, view } from '../../state/live';
import { emoteHooks } from '../emotes/link';
import { SELF, setEmote } from '../emotes/store';
import { FEV, FISH_ACT, FISH_INTERACT } from './fish';
import { applyFishEvent, fishLive, reelIn, resetFishing, useFishing } from './store';
import { useContent } from '../content/store';

const listener = (e: ZoneEvent) => {
  if (e.kind < FEV.cast || e.kind > FEV.refused) return;
  applyFishEvent(e, localPlayer.pos);
  const c = e.kind === FEV.caught ? useFishing.getState().caught : null;
  if (c) {
    // The journal's Fish tab updates at once (the next content sync agrees).
    const cs = useContent.getState();
    useContent.setState({ sync: { ...cs.sync, fish: { ...cs.sync.fish, [c.key]: [c.count, c.best] } } });
  }
};
let hooked: ZoneSession | null = null;

fishLive.onPose = (id, value, at) => {
  const p = at ?? view.feet;
  setEmote(SELF, id, value, p.x, p.y, p.z);
};

/** Hook the live session if it changed (the HUD calls it on a timer). */
export function ensureFishingHook(): void {
  const s = netRuntime.session;
  if (s === hooked) return;
  hooked?.eventListeners.delete(listener);
  hooked = s;
  resetFishing();
  if (s) {
    s.eventListeners.add(listener);
    fishLive.send = { interact: (action, target, arg = 0) => s.sendInteract(FISH_INTERACT, target, action, arg) };
  } else fishLive.send = null;
  // An emote reels your line in (the zone does the same).
  emoteHooks.beforePlay = () => {
    if (useFishing.getState().phase !== 'idle') reelIn();
  };
}

/** Dev builds (zone dev ticket): a rod in your pack. */
export function devRod(): void {
  netRuntime.session?.sendInteract(FISH_INTERACT, 0n, FISH_ACT.devRod);
}
