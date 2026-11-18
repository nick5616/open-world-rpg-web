// Owners speak their animals' names (playtest 5, CR 054). The bark seam is
// the same one the townsfolk use client-side (npcFocus.say; the zone's
// npcBark, Event 1930, draws through it too): a person who keeps a dog calls
// it by name when it pesters a visitor, and remarks on it when you have
// petted it. Who keeps which animal is deterministic (animalNames.ownerOf
// over the settlement's ordinary villagers and farmers), so every client
// agrees. Pure picking here; the manager feeds it the NPCs and animals near.

import { npcFocus } from './npcFocus';
import { ownerLine, ownerOf } from './animalNames';

/** The NPC roles that keep animals: villagers (0) and farmers (5). */
export const KEEPER_ROLES = new Set([0, 5]);

/** The keeper's NPC record index for animal `idx` (wire key low byte) of a settlement, from the settlement's NPC records [first, first + count). */
export function keeperIndex(settlementId: number, idx: number, npcs: readonly { role: number }[], first: number, count: number): number {
  const keepers: number[] = [];
  for (let i = first; i < first + count; i++) if (KEEPER_ROLES.has(npcs[i].role)) keepers.push(i);
  const k = ownerOf(settlementId, idx, keepers.length);
  return k < 0 ? -1 : keepers[k];
}

export interface BarkAnimal {
  key: number;
  kind: number;
  name: string;
  x: number;
  z: number;
  seed: number;
  /** Index of its keeper's record in the towns buffer (-1 none). */
  keeper: number;
}

export interface BarkNpc {
  key: number;
  index: number;
  x: number;
  z: number;
}

/** Calls the name when the animal is within CALL_M of the visitor and the keeper within HEAR_M of the visitor. */
export const CALL_M = 5.5;
export const HEAR_M = 14;
const GAP_MS = 70_000;

export class OwnerBarks {
  private readonly next = new Map<number, number>();
  /** Lines said (debug and tests). */
  said = 0;

  /** Per frame (cheap: a handful of animals). `petted`: the animal key just petted, if any. */
  update(now: number, player: { x: number; z: number }, animals: readonly BarkAnimal[], npcs: readonly BarkNpc[], petted: number | null = null): void {
    for (const a of animals) {
      if (a.keeper < 0 || !a.name) continue;
      const justPetted = petted === a.key;
      if (!justPetted) {
        if (Math.hypot(a.x - player.x, a.z - player.z) > CALL_M) continue;
        if (now < (this.next.get(a.key) ?? 0)) continue;
      }
      const n = npcs.find((v) => v.index === a.keeper);
      if (!n || Math.hypot(n.x - player.x, n.z - player.z) > HEAR_M) continue;
      if (npcFocus.lineOf(n.key, now) || npcFocus.talkingTo === n.key) continue; // mid-sentence or in a conversation
      this.next.set(a.key, now + GAP_MS + (a.seed % 20_000));
      npcFocus.say(n.key, ownerLine(a.kind, a.name, justPetted, a.seed ^ ((now / 1000) | 0)), 0, true, now);
      this.said++;
    }
  }
}
