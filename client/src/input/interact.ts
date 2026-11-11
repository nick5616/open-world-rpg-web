// Playtest 2 integration QA: one E, many things to use. Talking, doors and
// forges (towns), mining (caves), loot, lore tablets / herbs / vault parts
// (content), camp pieces, fishing, taming, petting your pet and riding your
// steed all answer E. Each shows an "[E] ..." prompt in the same spot under
// the crosshair, so two at once drew over each other and one press could do
// two things (rest in the bedroll and mount the steed beside it). Now:
//
//   - in the saddle, E only gets off (no other prompt shows);
//   - otherwise the first of E_ORDER whose prompt is up owns E: every user
//     hides its prompt and leaves E alone while one above it shows.
//
// Every handler listens on window, most in the capture phase, so their
// registration order used to decide; this list decides instead. A running
// fishing fight (strike / reel) and an open tablet keep E to themselves
// (their handlers stop the event before any prompt is considered).

import { localPlayer } from '../state/live';

/** Who answers E, first wins. */
export const E_ORDER = ['town', 'cave', 'tower', 'revive', 'rift', 'loot', 'content', 'camp', 'fish', 'tame', 'pet', 'steed'] as const;
export type EUser = (typeof E_ORDER)[number];

const PROMPT: Record<EUser, string> = {
  town: 'town-prompt',
  cave: 'cave-hud',
  tower: 'tower-prompt-attune',
  revive: 'revive-prompt', // CR 035: raise a fallen friend (ui/story)
  rift: 'rift-prompt', // CR 040: enter a rift (rift/RiftHud.tsx)
  loot: 'loot-prompt',
  content: 'content-prompt',
  camp: 'camp-prompt',
  fish: 'fish-prompt',
  tame: 'tame-prompt',
  pet: 'pet-prompt',
  steed: 'steed-prompt',
};

/** Whether `u`'s "[E] ..." prompt is on screen (hints without [E] don't take the key). */
export function ePromptUp(u: EUser): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.querySelector<HTMLElement>(`[data-testid="${PROMPT[u]}"]`);
  return !!el && (el.textContent ?? '').includes('[E]') && el.style.visibility !== 'hidden' && el.style.display !== 'none';
}

/**
 * Whether E (and its prompt) belongs to something other than `u` right now:
 * the rider (E gets off), or a user above `u` in E_ORDER with its prompt up.
 */
export function eTakenAbove(u: EUser, mounted = localPlayer.mounted): boolean {
  if (mounted) return u !== 'steed';
  for (const x of E_ORDER) {
    if (x === u) return false;
    if (ePromptUp(x)) return true;
  }
  return false;
}

/** A panel that freed the mouse (data-ui-panel; photo mode's marker counts) or a held emote / pet wheel. */
export function uiPanelUp(): boolean {
  if (typeof document === 'undefined') return false;
  for (const el of document.querySelectorAll<HTMLElement>('[data-ui-panel], [data-testid="emote-wheel"], [data-testid="pet-wheel"]')) {
    if (el.style.display !== 'none' && el.getClientRects().length > 0) return true;
  }
  return false;
}

/** Whether `u` may show its "[E] ..." prompt and act on E now. */
export function eFree(u: EUser): boolean {
  return !uiPanelUp() && !eTakenAbove(u);
}
