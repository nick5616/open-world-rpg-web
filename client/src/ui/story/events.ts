// Main story wire glue (playtest 2, CR 035): Events 1600-1612 and
// Interact 140 (contracts/events.md). The zone owns the story: the acts are
// quests (950 carries them like any other), these Events add the story's
// own state (the acts done, the ending, the post-game), the party's
// progress, the act title cards, the finale at the Heartfall, the ending
// and revives.

import type { Event as ZoneEvent } from '@lodestone/contracts';

export const SEV = {
  sync: 1600,
  party: 1601,
  intro: 1602,
  finale: 1603,
  finaleIntro: 1604,
  ending: 1605,
  say: 1606,
  refused: 1607,
  reviveWindow: 1610,
  revived: 1611,
  reviveProgress: 1612,
} as const;

export const STORY_INTERACT = 140;
export const STORY_ACT = { sync: 1, catchUp: 2, revive: 3, respawn: 4, vow: 5 } as const;

export const STORY_REFUSAL: Record<number, string> = {
  1: 'Not now',
  2: 'Nobody in your party is ahead of you in the story',
  3: 'Too far away: stand beside them',
  4: 'They are not down',
  5: 'Beat the game first',
  6: 'The main story stays in your journal',
};

/** The finale's phase (Event 1603 value). */
export const FINALE = { idle: 0, intro: 1, fight: 2, won: 3, choir: 4, night: 5 } as const;

export interface ActView {
  n: number;
  title: string;
  level: number;
  done: boolean;
}

/** Event 1600: your story. act 0 = not started, 7 = the game is beaten. */
export interface StorySync {
  title: string;
  act: number;
  step: number;
  acts: ActView[];
  beaten: number;
  together: number;
  vow: boolean;
  heartfall: [number, number, number];
  arena: string;
}

export interface StoryMember {
  id: number;
  name: string;
  act: number;
  step: number;
  steps: number;
  text: string;
  title: string;
  dist: number;
}

/** Event 1601: your party's progress (empty: no party on this zone). */
export interface StoryParty {
  leader: number;
  you: StoryMember;
  members: StoryMember[];
  behind: boolean;
}

export interface StoryIntro {
  act: number;
  eyebrow: string;
  title: string;
  subtitle: string;
}

export interface FinaleView {
  phase: number;
  x: number;
  z: number;
  r: number;
  boss: number;
  shroud: number;
  shroudMs: number;
  bells: number;
  wells: { x: number; z: number; r: number }[];
  nightMs: number;
  hard: boolean;
  stagger: boolean;
}

export interface FinaleIntro {
  eyebrow: string;
  title: string;
  subtitle: string;
  lines: string[];
  ms: number;
  hard: boolean;
  x: number;
  z: number;
  boss: number;
}

export interface StoryEnding {
  title: string;
  lines: string[];
  together: boolean;
  hard: boolean;
  names: string[];
  first: boolean;
  earned: string;
}

export interface ReviveWindow {
  id: number;
  name: string;
  ms: number;
  x: number;
  y: number;
  z: number;
  helpers: number;
}

const text = new TextDecoder();

export function decodeJSON<T>(ev: Pick<ZoneEvent, 'data'>): T | null {
  if (!ev.data || ev.data.length === 0) return null;
  try {
    return JSON.parse(text.decode(ev.data)) as T;
  } catch {
    return null;
  }
}

/** "Act III" */
export function roman(n: number): string {
  return ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][n] ?? String(n);
}

/** The party line under the tracker: "Friend · Act II, step 3/5: Wake the fork of ..." */
export function memberLine(m: StoryMember): string {
  if (m.act <= 0) return `${m.name} · not started`;
  if (m.act > 6) return `${m.name} · the game is beaten`;
  const step = m.steps > 0 && m.step >= 0 ? `, step ${m.step + 1}/${m.steps}` : '';
  return `${m.name} · Act ${roman(m.act)}${step}${m.text ? `: ${m.text}` : ''}`;
}

/** Seconds left, rounded up ("7 s"). */
export function secsLeft(ms: number): string {
  return `${Math.max(0, Math.ceil(ms / 1000))} s`;
}
