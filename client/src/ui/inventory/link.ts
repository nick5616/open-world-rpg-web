// Connects a zone session to the inventory store (WP14): Events 400-411 and
// WP20's 805 in, Interacts 20/21/22/41 out. NetPlay calls attachInventory
// right after it builds the session (like WP12's attachExploration and
// WP13's attachCombat), so the inventory Event that follows Welcome is never
// missed. `ensureInventoryHook` is a safety net the HUD runs every few
// frames: if a session exists that nobody attached (a dev-handle connect, a
// future screen), it hooks it the same way, re-hooking when it changes
// (like townHud does).

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { netRuntime } from '../../net/netStore';
import type { ZoneSession } from '../../net/zoneSession';
import { CRAFT_ACT, INTERACT, ITEM_ACT } from './events';
import { socketTarget, trainingEquipArg } from './items';
import { ACT, INTERACT_COMBAT } from '../../combat/events';
import { applyItemEvent, resetInventory, setInventoryActions, type InventoryActions } from './store';

const listener = (e: ZoneEvent) => applyItemEvent(e);
let hooked: ZoneSession | null = null;

export function inventoryActionsFor(session: ZoneSession): InventoryActions {
  return {
    item: (h, action, arg = 0) => session.sendInteract(INTERACT.item, BigInt(h >>> 0), action, arg),
    socket: (w, g, socket) => session.sendInteract(INTERACT.item, socketTarget(w, g), ITEM_ACT.socket, socket),
    craft: (recipeId) => session.sendInteract(INTERACT.craft, 0n, CRAFT_ACT.craft, recipeId),
    openContainer: (id) => session.sendInteract(INTERACT.container, id, 1, 0),
    takePickup: (id) => session.sendInteract(INTERACT.pickup, BigInt(id >>> 0), 1, 0),
    openCook: (prop) => session.sendInteract(INTERACT.craft, prop, CRAFT_ACT.openCook, 0),
    trainingWeapon: (loadout, weapon) => {
      const arg = trainingEquipArg(loadout, weapon);
      if (arg) session.sendInteract(INTERACT_COMBAT, 0n, ACT.equipWeapon, arg);
    },
  };
}

export function attachInventory(session: ZoneSession): () => void {
  if (hooked && hooked !== session) hooked.eventListeners.delete(listener);
  resetInventory();
  session.eventListeners.add(listener);
  hooked = session;
  setInventoryActions(inventoryActionsFor(session));
  return () => {
    session.eventListeners.delete(listener);
    if (hooked === session) {
      hooked = null;
      setInventoryActions(null);
    }
  };
}

/** Hook the live session if nobody did (cheap; call it from a frame loop). */
export function ensureInventoryHook(): void {
  const s = netRuntime.session;
  if (s && s !== hooked) attachInventory(s);
  else if (!s && hooked) {
    hooked.eventListeners.delete(listener);
    hooked = null;
    setInventoryActions(null);
  }
}
