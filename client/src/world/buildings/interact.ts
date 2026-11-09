// Interaction targets of the towns layer (WP20): pure selection of what the
// camera is "at", so the HUD prompt, the E key and the tests agree.
//
// Reach is 4 m from the eye for every WP20 Interact (contracts/events.md);
// the target must be roughly in front of the view (within ~35 degrees of the
// view ray); among those the one closest to the view ray wins, ties to the
// nearer. Signposts are read-only (no Interact) and use a slightly longer
// reach so the HUD can show the destinations as you walk up.

export type TargetKind = 'npc' | 'board' | 'forge' | 'anvil' | 'shaft' | 'sign' | 'door';

export interface Candidate {
  kind: TargetKind;
  /** Point the player looks at (chest of an NPC, the board face...). */
  x: number;
  y: number;
  z: number;
  /** NPC: snapshot entity id online, null offline. */
  entityId: number | null;
  /** Stable id: board/station prop id, shaft structure id, sign id. */
  stableId: bigint;
  /** NPC record index in the towns buffer (-1 unknown), structure index, sign index, door index... */
  index: number;
  name: string;
  /** NPC role; doors: 1 open, 0 closed (at the local player's current step). */
  role: number;
  /** Merchant kind (255 none) for NPCs. */
  merchant: number;
  settlement: number;
}

export const REACH_M = 4;
export const SIGN_REACH_M = 6;
export const FACING_COS = Math.cos((35 * Math.PI) / 180);

export function pickTarget(eye: { x: number; y: number; z: number }, fwd: { x: number; y: number; z: number }, cands: readonly Candidate[], reach = REACH_M, cosMin = FACING_COS): Candidate | null {
  let best: Candidate | null = null;
  let bestScore = -Infinity;
  for (const c of cands) {
    const dx = c.x - eye.x;
    const dy = c.y - eye.y;
    const dz = c.z - eye.z;
    const d = Math.hypot(dx, dy, dz);
    const r = c.kind === 'sign' ? SIGN_REACH_M : reach;
    if (d > r) continue;
    // Standing right on top of it: always "facing".
    const cos = d < 0.4 ? 1 : (dx * fwd.x + dy * fwd.y + dz * fwd.z) / d;
    // Close things subtend more of the view: widen the cone a little up close.
    const lim = d < 1.5 ? cosMin - 0.15 : cosMin;
    if (cos < lim) continue;
    // Playtest 2: a blacksmith stands at her anvil; looking roughly at both,
    // talking to the person wins (about 12 degrees of aim).
    const score = cos * 4 - d * 0.1 + (c.kind === 'npc' ? 0.6 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** Prompt line for a target ("[E] Talk to Mira (blacksmith)"). */
export function promptFor(c: Candidate, roleLabel: (role: number) => string): string {
  switch (c.kind) {
    case 'npc':
      return `[E] Talk to ${c.name || 'the villager'} (${roleLabel(c.role)})`;
    case 'board':
      return '[E] Read the bounty board';
    case 'forge':
      return '[E] Use the forge';
    case 'anvil':
      return '[E] Use the anvil';
    case 'shaft':
      return '[E] Descend the shaft';
    case 'sign':
      return c.name;
    case 'door':
      return c.role === 1 ? '[E] Close door' : '[E] Open door';
  }
}
