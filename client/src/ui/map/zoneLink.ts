// Connects a zone session to the exploration store (WP12): Events in, map
// actions out (Interact), and local profiles' re-issued save blobs stored
// in IndexedDB so the next login presents the newest one. NetPlay calls
// attachExploration right after it builds the session, before Hello, so the
// progress Event that follows Welcome is never missed.

import type { ReadySession, SaveBlob } from '../../account/types';
import { SaveStore } from '../../account/saveStore';
import type { ZoneSession } from '../../net/zoneSession';
import { INTERACT, MAX_PERSONAL_PINS, packPinPos } from './events';
import { applyZoneEvent, resetExploration, setExplorationActions, useExploration } from './store';

export function attachExploration(session: ZoneSession, ready: ReadySession): () => void {
  resetExploration();
  session.onEvent = (ev) => applyZoneEvent(ev);
  session.onSaveBlob = (raw) => {
    let blob: SaveBlob;
    try {
      blob = JSON.parse(new TextDecoder().decode(raw)) as SaveBlob;
    } catch {
      return;
    }
    // Reconnects present the newest blob; IndexedDB keeps it across reloads
    // (putSave ignores an older counter).
    if (!ready.save || ready.save.counter < blob.counter) ready.save = blob;
    SaveStore.open()
      .then((s) => s.putSave(blob))
      .catch((e: unknown) => console.warn('[map] could not store the new save blob', e));
  };
  setExplorationActions({
    fastTravel: (site) => session.sendInteract(INTERACT.site, BigInt(site), INTERACT.fastTravel),
    setPin: (x, z, party, color, slot) => {
      if (party) {
        session.sendInteract(INTERACT.pin, packPinPos(x, z), INTERACT.partyPinSet, color & 0xff);
        return;
      }
      // Next free personal slot (the zone refuses an 11th pin).
      const used = new Set(useExploration.getState().pins.filter((p) => !p.party).map((p) => p.slot));
      let s = slot ?? -1;
      for (let i = 0; s < 0 && i < MAX_PERSONAL_PINS; i++) if (!used.has(i)) s = i;
      if (s < 0) return;
      session.sendInteract(INTERACT.pin, packPinPos(x, z), INTERACT.pinSet, (s & 0xff) | ((color & 0xff) << 8));
    },
    placeService: (settlement, kind, x, z) => session.sendInteract(INTERACT.placePin, packPinPos(x, z), INTERACT.placeService, (settlement & 0xffff) | ((kind & 0xff) << 16)),
    clearPin: (pin) => {
      // Each member owns (and can remove) only their own party pin.
      if (pin.party) {
        if (pin.owner === ready.character.name) session.sendInteract(INTERACT.pin, 0n, INTERACT.partyPinClear, 0);
      }
      else session.sendInteract(INTERACT.pin, 0n, INTERACT.pinClear, pin.slot);
    },
  });
  return () => {
    session.onEvent = null;
    session.onSaveBlob = null;
    setExplorationActions(null);
  };
}
