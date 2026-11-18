// Playtest 4 (the first hour, CR 051): one thing at a time. A brand-new
// character starts with the slimes ("story:meadows") and a mentor who calls
// them over; until that first quest is handed in (or HOLD_S of play have
// passed) the secondary tips, the What's new welcome and other notices wait,
// so nothing competes with the person who is asking for help. Tips a person
// says instead of a card (SAID_BY_PEOPLE) are never shown as one to a new
// character.

import type { TipId } from './tips';

/** The first quest's key (server/zone/internal/quests MeadowsKey). */
export const FIRST_QUEST_KEY = 'story:meadows';
/** The hold never lasts longer than this much play in a session. */
export const HOLD_S = 600;

/** Tips that stay available during the hold: moving, finding the person, fighting, healing. */
export const PRIMARY_TIPS: readonly TipId[] = ['look', 'quest', 'fight', 'heal'];
/** Tips a townsperson says (the mentor: "walk up and press E"), not a card. */
export const SAID_BY_PEOPLE: readonly TipId[] = ['talk'];

/** Whether the secondary announcements are held back right now. */
export function firstHourHold(quests: readonly { key: string }[], playedS: number): boolean {
  return playedS < HOLD_S && quests.some((q) => q.key === FIRST_QUEST_KEY);
}

/** Playtest 4 (Nicole's music): how long the anthem may play over a new character's arrival (s of play). */
export const ARRIVAL_ANTHEM_S = 180;

/**
 * Whether a new character is still arriving: the first quest is in the log
 * with its first (talk) step not yet done, in the first ARRIVAL_ANTHEM_S
 * seconds of the session. The music director plays the anthem then
 * (client/src/audio/music/director.ts `arrival`).
 */
export function arrivalAnthem(quests: readonly { key: string; steps?: readonly { done: boolean }[] }[], playedS: number): boolean {
  if (playedS >= ARRIVAL_ANTHEM_S) return false;
  const q = quests.find((x) => x.key === FIRST_QUEST_KEY);
  return !!q && q.steps?.[0]?.done === false;
}
