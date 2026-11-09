// What the crystal tower near you should say (playtest 1: "what is the
// giant tower with the crystal? that should do something"). Pure: the HUD
// calls it 5 times a second with the player's position.

import { COMBAT } from '@lodestone/contracts';
import { TOWER_TOP_RADIUS } from '../../world/structures/towers';

export interface TowerLike {
  site: number;
  cx: number;
  cz: number;
  topY: number;
  /** Outer radius of the tower's footprint. */
  maxR: number;
}

export type TowerPromptKind = 'climb' | 'attune' | 'attuned' | 'return';

export interface TowerPrompt {
  kind: TowerPromptKind;
  site: number;
  title: string;
  detail: string;
}

/** How far from a tower's wall the hint shows. */
export const TOWER_HINT_M = 45;
/** Same slack as the zone's top check (explore.TowerTopSlackM). */
const TOP_SLACK_M = 0.6;

export function boonText(): string {
  const a = COMBAT.leveling.attune;
  return `+${a.stamina} stamina, +${a.health} health, +${a.skillPoints} skill point`;
}

export function towerPrompt(towers: readonly TowerLike[], x: number, y: number, z: number, unlocked: (site: number) => boolean, attuned: (site: number) => boolean): TowerPrompt | null {
  let best: TowerLike | null = null;
  let bestD = Infinity;
  for (const t of towers) {
    const d = Math.hypot(x - t.cx, z - t.cz);
    if (d - t.maxR < TOWER_HINT_M && d < bestD) {
      best = t;
      bestD = d;
    }
  }
  if (!best) return null;
  const onTop = bestD <= TOWER_TOP_RADIUS + TOP_SLACK_M && y >= best.topY - TOP_SLACK_M;
  const site = best.site;
  if (onTop) {
    if (attuned(site)) return { kind: 'attuned', site, title: 'You are attuned to this crystal', detail: 'Its land is on your map, and you can fast travel here from anywhere.' };
    return { kind: 'attune', site, title: '[E] Attune to the crystal', detail: `Reveal this land on your map, unlock fast travel here, and gain a permanent boon: ${boonText()}.` };
  }
  if (!unlocked(site)) return { kind: 'climb', site, title: 'Climb to the crystal to reveal this land', detail: 'Hold forward against the wall to climb; rest on the ledge to refill stamina. At the top, attune to the crystal.' };
  if (!attuned(site)) return { kind: 'return', site, title: 'The crystal at the top is waiting', detail: `Climb back up and attune to it for a permanent boon: ${boonText()}.` };
  return null;
}
