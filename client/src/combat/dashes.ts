// Playtest 2 dash overhaul (CR 021, docs/cr/021-dash-overhaul.md): the
// client half of held dashes, run inside CombatTimeline.step.
//
// A mobility spell starts its dash as before (the dodge flag + the variant
// in castSlot). From the next step until the dash has run out the timeline
// names the running variant in castSlot (so the shared step clamps to its
// exit speed when it ends) and, while the spell's key stays down and the
// predicted mana covers the step (combat.yaml dashes.*.sustain.manaPerS),
// sets InputFlag.channel: the shared movement step (sim/dash.ts) keeps the
// dash going. Letting go ends the hold for good (the carry then runs out);
// another action (attack, dodge, cast) on a step takes castSlot and ends it
// too. The zone pays for every held step and strips what it will not pay
// (combat/dashes.go): prediction is corrected by reconciliation then.

import { COMBAT, InputFlag, type DashDef } from '@lodestone/contracts';
import type { MoveState } from '../sim/movement';
import { holding } from '../sim/dash';
import type { CombatButtons, StepOut } from './timeline';

export interface DashHold {
  /** Spell slot whose key holds it. */
  slot: number;
  variant: number;
  /** Seq of the start step (dodge flag). */
  started: number;
  /** Still held (false once the key was let go: no re-hold). */
  held: boolean;
  /** Held steps so far (FX, the probe). */
  steps: number;
}

const dashById = new Map<number, DashDef>(COMBAT.dashes.map((d) => [d.id, d]));

export function dashDef(variant: number): DashDef | undefined {
  return dashById.get(variant);
}

/**
 * CR 048: the dash variant a spell whose base dash is `id` runs at a character
 * level: the tier row with the highest minLevel <= level among the base and the
 * rows naming it in tierOf (the lowest tier below every minLevel); an untiered
 * dash is itself. Twin of Go combatdefs.Defs.ResolveDash (the zone resolves the
 * same level from combat_sync / the character).
 */
export function resolveDash(id: number, level: number): number {
  const base = dashById.get(id);
  if (!base || !base.minLevel) return id;
  const tiers = COMBAT.dashes.filter((t) => t.minLevel && (t.id === id || t.tierOf === base.key));
  let best = -1;
  let bestMin = -1;
  let lowest = id;
  let lowMin = Infinity;
  for (const t of tiers) {
    const m = t.minLevel!;
    if (m <= level && m > bestMin) {
      best = t.id;
      bestMin = m;
    }
    if (m < lowMin) {
      lowest = t.id;
      lowMin = m;
    }
  }
  return best < 0 ? lowest : best;
}

/** Mana a held step of this dash costs (the zone charges the same per step). */
export function holdManaPerStep(d: DashDef): number {
  return (d.sustain?.manaPerS ?? 0) / 60;
}

export function startDashHold(slot: number, variant: number, seq: number): DashHold {
  return { slot, variant, started: seq, held: true, steps: 0 };
}

/** What dashStep needs of the timeline (CombatTimeline implements it). */
export interface DashTimeline {
  dashHold: DashHold | null;
  mana: number;
}

/** Live view for FX / camera feel: the dash being held right now (null when none). */
export const dashLive: { variant: number; held: boolean; heldSteps: number } = { variant: 0, held: false, heldSteps: 0 };

/**
 * After the step's action has been chosen: name the running dash in
 * castSlot and hold it while its key is down and mana lasts.
 */
export function dashStep(tl: DashTimeline, b: CombatButtons, before: MoveState, out: StepOut, seq: number): void {
  const h = tl.dashHold;
  if (!h) return;
  if (seq === h.started) {
    dashLive.variant = h.variant;
    dashLive.held = false;
    dashLive.heldSteps = 0;
    return; // the start step itself (dodge + variant)
  }
  if ((before.dash ?? 0) <= 0) {
    tl.dashHold = null; // ran out
    dashLive.variant = 0;
    dashLive.held = false;
    return;
  }
  if ((out.flags & (InputFlag.dodge | InputFlag.cast | InputFlag.attack)) !== 0) {
    h.held = false; // another action took this step (and its castSlot)
    dashLive.held = false;
    return;
  }
  out.castSlot = h.variant;
  const d = dashDef(h.variant);
  const cost = d ? holdManaPerStep(d) : 0;
  if (h.held && d?.sustain && b.castHeld?.[h.slot] && tl.mana >= cost && holding(before, InputFlag.channel, h.variant)) {
    tl.mana -= cost;
    out.flags |= InputFlag.channel;
    h.steps++;
  } else h.held = false;
  dashLive.held = h.held;
  dashLive.heldSteps = h.steps;
}
