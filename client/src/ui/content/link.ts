// Connects the live zone session to the content store: Events 1000-1029
// in, Interact 80 out. Hooked from the HUD's timer (like ui/quests/link.ts),
// re-hooking when the session changes (a reconnect, a WP16 failover).

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { netRuntime } from '../../net/netStore';
import type { ZoneSession } from '../../net/zoneSession';
import { CONTENT_ACT, CONTENT_INTERACT } from './events';
import { applyContentEvent, resetContent, setContentActions, setContentSelf, type ContentActions } from './store';

const listener = (e: ZoneEvent) => {
  if (e.kind >= 1000 && e.kind <= 1029) applyContentEvent(e);
};
let hooked: ZoneSession | null = null;

export function contentActionsFor(s: ZoneSession): ContentActions {
  const send = (id: number | bigint, action: number, arg = 0) => s.sendInteract(CONTENT_INTERACT, typeof id === 'bigint' ? id : BigInt(id >>> 0), action, arg);
  return {
    sync: () => send(0, CONTENT_ACT.sync),
    read: (site) => send(site, CONTENT_ACT.read),
    forage: (id) => send(id, CONTENT_ACT.forage),
    vault: (site, part) => send((BigInt(site) << 8n) | BigInt(part & 0xff), CONTENT_ACT.vault),
    title: (featId) => send(featId, CONTENT_ACT.title),
    devEvent: (kind) => send(0, CONTENT_ACT.devEvent, kind),
  };
}

/** Hook the live session if it changed (cheap; the HUD calls it on a timer). */
export function ensureContentHook(): void {
  const s = netRuntime.session;
  if (s === hooked) {
    if (s?.welcome) setContentSelf(s.welcome.entityId);
    return;
  }
  hooked?.eventListeners.delete(listener);
  hooked = s;
  if (s) {
    resetContent();
    s.eventListeners.add(listener);
    setContentActions(contentActionsFor(s));
  } else setContentActions(null);
}
