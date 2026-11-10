// Your own worn armor (CR 034): the appearance the zone put in your
// inventory event (Event 400 "ap"), the same number every other player's
// snapshot carries for you. 0 offline and before the first inventory.

import { useInventory } from '../../ui/inventory/store';

export function ownAppearance(): number {
  return useInventory.getState().inv?.ap ?? 0;
}
