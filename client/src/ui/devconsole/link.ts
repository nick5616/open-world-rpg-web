// Connects the live zone session to the dev console: Events 1400-1402 in,
// Interact 250 out. Debug builds only ask (action 1); a zone without dev
// mode stays silent and the console never appears.

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { netRuntime } from '../../net/netStore';
import type { ZoneSession } from '../../net/zoneSession';
import { DEV_ACT, DEV_INTERACT } from './events';
import { applyDevEvent, resetDev, useDev } from './store';

const listener = (e: ZoneEvent) => {
  if (e.kind >= 1400 && e.kind <= 1419) applyDevEvent(e);
};
let hooked: ZoneSession | null = null;
let asks = 0;
let placesAsked = false;

/** Hook the live session if it changed (the console checks on a timer: reconnects, failovers). */
export function ensureDevHook(): void {
  const s = netRuntime.session;
  if (s === hooked) {
    // Ask a few times (the first may go before the session plays); a zone
    // in dev mode answers with 1400, any other zone stays silent.
    if (s && s.welcome && !useDev.getState().dev && asks < 5) {
      asks++;
      s.sendInteract(DEV_INTERACT, 0n, DEV_ACT.status);
    }
    if (s && useDev.getState().dev && !placesAsked) {
      placesAsked = true; // only a dev zone is asked: anything else would log a refusal
      s.sendInteract(DEV_INTERACT, 0n, DEV_ACT.places);
    }
    return;
  }
  hooked?.eventListeners.delete(listener);
  hooked = s;
  asks = 0;
  placesAsked = false;
  resetDev();
  if (s) {
    s.eventListeners.add(listener);
    useDev.setState({ send: (d) => s.sendInteract(DEV_INTERACT, d.target, d.action, d.arg) });
  } else useDev.setState({ send: null });
}
