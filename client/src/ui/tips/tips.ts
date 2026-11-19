// Playtest 2 (new player onboarding): short contextual tips instead of the
// always-on wall of key hints. Each tip shows once per character, when it
// becomes relevant (first spawn, next to a person, the first enemy, low
// health, the first night, a cliff, a long fall, an unspent skill point),
// one at a time, and is remembered per character in localStorage. The Esc
// menu turns tips off (globally) or shows them all again.
//
// Playtest 4 (CR 051): a brand-new character gets only the primary tips
// until the first quest is handed in (firstHour.ts), the rest in the order
// their thing first matters; "talk" is said by the mentor instead.
//
// Pure logic here (tips.test.ts); TipsHud.tsx samples the game and draws.

import { PRIMARY_TIPS } from './firstHour';

export type TipId = 'look' | 'quest' | 'talk' | 'fight' | 'heal' | 'night' | 'climb' | 'glide' | 'skills';

export interface Tip {
  id: TipId;
  title: string;
  /** One or two short lines. */
  text: string;
  /** Keys drawn as keycaps before the text. */
  keys: string[];
}

/**
 * In priority order: when several are due, the first one shows. The urgent
 * ones come first, then the order a new player meets things: moving, the
 * quest, a person, cliffs and falls, the first night, a free skill point.
 */
export const TIPS: Tip[] = [
  { id: 'heal', title: 'Low health', keys: ['R'], text: 'drinks a healing draught. Out of draughts? Back off: health comes back out of combat.' },
  { id: 'fight', title: 'Enemy nearby', keys: ['LMB', '1-4', 'F'], text: 'attack, cast a spell, dodge. The wheel picks what the right button uses.' },
  { id: 'look', title: 'Getting around', keys: ['WASD', 'Space', 'Shift'], text: 'walk, jump, sprint. Click the game to look with the mouse. Esc: menu and all controls.' },
  { id: 'quest', title: 'Your quest', keys: ['J', 'M'], text: 'journal and map. Follow the gold diamond on the compass and the beam of light.' },
  { id: 'talk', title: 'Townsfolk', keys: ['E'], text: 'talks to people: quests, shops and advice.' },
  { id: 'climb', title: 'A cliff', keys: ['W'], text: 'hold it into the rock to climb (stamina wheel by the crosshair). Space leaps up.' },
  { id: 'glide', title: 'Falling', keys: ['Space', 'G'], text: 'Space again in the air double jumps, then glides. G opens the glider any time.' },
  { id: 'skills', title: 'Skill point to spend', keys: ['N'], text: 'opens the skill tree: learn a spell, then drag it onto a slot.' },
  { id: 'night', title: 'Night falls', keys: [], text: 'Demons rise at night. Weak ones fall to any weapon, the stronger ones shrug off steel and fire ("Resisted"), and the strongest only die to sunsteel, Light magic or the sunrise. Stay near town until you have them.' },
];

const BY_ID = new Map(TIPS.map((t) => [t.id, t]));
export const tipById = (id: TipId): Tip => BY_ID.get(id)!;

/** What the HUD samples each check (4 Hz). */
export interface TipContext {
  /** Seconds since the world became playable this session. */
  playingS: number;
  /** A panel, the Esc menu, chat, a dialogue or the downed screen is up. */
  busy: boolean;
  questTracked: boolean;
  /** The "[E] Talk to ..." prompt is showing. */
  nearPerson: boolean;
  /** A living enemy within 18 m, or you were hit in the last few seconds. */
  enemyNear: boolean;
  /** Health fraction (1 = full); 1 when unknown. */
  health: number;
  draughts: number;
  night: boolean;
  /** Steep rock rises right ahead while you are on foot, or you are climbing. */
  cliff: boolean;
  /** Falling fast (a ledge, a jump off a cliff) or already gliding. */
  falling: boolean;
  freePoints: number;
  /** CR 051: a new character on the first quest: only the primary tips (firstHour.ts). */
  firstHour: boolean;
  /** You lost health in the last HURT_S seconds. */
  hurt: boolean;
  /** In a fight: hurt recently, a boss bar is up, or you are downed (playtest 2 co-op: tips popped mid-fight). */
  inCombat: boolean;
}

export const IDLE_CONTEXT: TipContext = { firstHour: false, playingS: 0, busy: false, questTracked: false, nearPerson: false, enemyNear: false, health: 1, draughts: 0, night: false, cliff: false, falling: false, freePoints: 0, hurt: false, inCombat: false };

/** Seconds after losing health that you count as in a fight. */
export const HURT_S = 6;
/** A non-urgent tip up for less than this when a fight starts is withdrawn (and shows later). */
export const TIP_WITHDRAW_S = 4;

const URGENT = (id: TipId) => id === 'heal' || id === 'fight';

/** Whether a tip is relevant right now. */
export function relevant(id: TipId, c: TipContext): boolean {
  if (c.firstHour && !PRIMARY_TIPS.includes(id)) return false;
  switch (id) {
    case 'look':
      return c.playingS >= 2;
    case 'quest':
      return c.questTracked && c.playingS >= 12;
    case 'talk':
      return c.nearPerson;
    case 'fight':
      return c.enemyNear;
    case 'heal':
      return c.health > 0 && c.health < 0.4;
    case 'night':
      return c.night && c.playingS >= 8;
    case 'climb':
      return c.cliff;
    case 'glide':
      return c.falling;
    case 'skills':
      return c.freePoints > 0 && c.playingS >= 20;
  }
}

/** Seconds a tip stays up (unless dismissed or `settled`). */
export const TIP_SHOW_S = 11;
/** Quiet gap between two tips. */
export const TIP_GAP_S = 2.5;

/**
 * The tip to show next: the first relevant one not yet seen, never while
 * busy and never within TIP_GAP_S of the last one closing. Urgent tips
 * (low health, an enemy) skip the gap. Nothing in a fight, except the
 * 'fight' tip before you have been hit (it introduces the keys as an enemy
 * approaches).
 */
export function nextTip(c: TipContext, seen: ReadonlySet<TipId>, sinceLastS: number): TipId | null {
  if (c.busy) return null;
  for (const t of TIPS) {
    if (seen.has(t.id) || !relevant(t.id, c)) continue;
    if (c.inCombat && !(t.id === 'fight' && !c.hurt)) continue;
    const urgent = URGENT(t.id);
    if (!urgent && sinceLastS < TIP_GAP_S) return null;
    return t.id;
  }
  return null;
}

/**
 * A fight started under a non-urgent tip that has barely shown: take it
 * down and forget it was seen, so it shows again later.
 */
export function withdrawForCombat(id: TipId, c: TipContext, shownS: number): boolean {
  return c.inCombat && !URGENT(id) && shownS < TIP_WITHDRAW_S;
}

/** A shown tip closes early once it has been read and its moment passed. */
export function settled(id: TipId, c: TipContext, shownS: number): boolean {
  if (shownS >= TIP_SHOW_S) return true;
  if (shownS < 5) return false;
  switch (id) {
    case 'talk':
    case 'fight':
    case 'climb':
    case 'glide':
      return !relevant(id, c);
    case 'heal':
      return c.health >= 0.6;
    default:
      return false;
  }
}

// ---- persistence (localStorage; per character for seen tips) ----

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const ENABLED_KEY = 'lodestone_tips_enabled';
const seenKey = (character: string) => `lodestone_tips_seen:${character}`;

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

export function tipsEnabled(kv: KV | null): boolean {
  return safe(() => kv?.getItem(ENABLED_KEY) !== '0', true);
}

export function setTipsEnabled(kv: KV | null, on: boolean): void {
  safe(() => kv?.setItem(ENABLED_KEY, on ? '1' : '0'), undefined);
}

export function loadSeen(kv: KV | null, character: string): Set<TipId> {
  const raw = safe(() => kv?.getItem(seenKey(character)) ?? null, null);
  if (!raw) return new Set();
  try {
    const list = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(list) ? (list.filter((x) => typeof x === 'string' && BY_ID.has(x as TipId)) as TipId[]) : []);
  } catch {
    return new Set();
  }
}

export function saveSeen(kv: KV | null, character: string, seen: ReadonlySet<TipId>): void {
  safe(() => kv?.setItem(seenKey(character), JSON.stringify([...seen])), undefined);
}

export function clearSeen(kv: KV | null, character: string): void {
  safe(() => kv?.removeItem(seenKey(character)), undefined);
}

/** localStorage when the page has one (null in tests / private modes that throw). */
export function browserKV(): KV | null {
  return safe(() => (typeof localStorage === 'undefined' ? null : localStorage), null);
}

// ---- geometry helpers for the triggers ----

/** Forward on the ground for a view yaw (the client's convention: yaw 0 looks down -z). */
export function forwardOf(yaw: number): { x: number; z: number } {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

/**
 * A climbable cliff right ahead: the ground 1-3 m in front rises at least
 * 2.2 m above the feet and steeper than 50 degrees somewhere on the way.
 */
export function cliffAhead(heightAt: (x: number, z: number) => number, x: number, y: number, z: number, yaw: number): boolean {
  const f = forwardOf(yaw);
  let prev = heightAt(x, z);
  let steep = false;
  let rise = -Infinity;
  for (let d = 0.75; d <= 3; d += 0.75) {
    const h = heightAt(x + f.x * d, z + f.z * d);
    if (h - prev > 0.75 * Math.tan((50 * Math.PI) / 180)) steep = true;
    rise = Math.max(rise, h - y);
    prev = h;
  }
  return steep && rise >= 2.2;
}
