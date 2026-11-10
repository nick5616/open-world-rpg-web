// The achievement unlock toast queue (playtest 2, CR 031). Pure and
// unit-tested: one card at a time, ~6 s each; several unlocks at once (a
// kill that finishes two counters, a returning character's catch-up) show
// one after another, at most MAX_QUEUED waiting and the rest counted as
// "+N more". While something else owns the middle of the screen (the
// welcome / What's new card, a discovery card, the level-up fanfare, a
// centred panel, the Esc menu) the card waits, and a card already up is
// held (hidden, its time paused) so it never shows under another card.

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { ITEMS } from '@lodestone/contracts';
import { decodeJSON } from '../content/events';
import { achByKey, fmt } from './model';

export const TOAST_MS = 6000;
export const MAX_QUEUED = 5;

/** Zone events (contracts/events.md): 1002 achievement_earned, 1240 achievement_announce, 1241 achievements_caught_up. */
export const AEV = { earned: 1002, announce: 1240, caughtUp: 1241 } as const;

export interface AchToast {
  key: string;
  name: string;
  desc: string;
  /** Tier index (CONTENT.achievementTiers). */
  tier: number;
  pts: number;
  rewards: string[];
  /** The 1241 summary card ("N achievements earned from your past deeds"). */
  summary?: boolean;
}

export interface ToastQueue {
  /** The card up: `left` ms of showing still to go, counted from `at` (held while blocked). */
  current: (AchToast & { id: number; left: number; at: number }) | null;
  queue: AchToast[];
  /** Unlocks beyond MAX_QUEUED: told as "+N more" on the cards still to come. */
  extra: number;
}

export const emptyQueue = (): ToastQueue => ({ current: null, queue: [], extra: 0 });

let nextId = 1;

export function enqueueToast(q: ToastQueue, t: AchToast): ToastQueue {
  if (q.queue.length >= MAX_QUEUED) return { ...q, extra: q.extra + 1 };
  return { ...q, queue: [...q.queue, t] };
}

/**
 * Advance the queue at `now`. `blocked`: another card or a panel owns the
 * screen, so nothing new shows and the card up (if any) is held.
 */
export function tickToasts(q: ToastQueue, now: number, blocked: boolean): ToastQueue {
  let { current, queue, extra } = q;
  if (current) {
    const left = blocked ? current.left : current.left - Math.max(0, now - current.at);
    current = left > 0 ? { ...current, left, at: now } : null;
  }
  if (!current && !blocked && queue.length) {
    current = { ...queue[0], id: nextId++, left: TOAST_MS, at: now };
    queue = queue.slice(1);
  }
  if (!current && !queue.length) extra = 0;
  return { current, queue, extra };
}

/** "+N more" under the card up (the cards waiting and those past the cap). */
export function moreCount(q: ToastQueue): number {
  return q.queue.length + q.extra;
}

export function itemName(key: string): string {
  return ITEMS.items.find((i) => i.key === key)?.name ?? (key.split(':').pop() ?? key).replace(/_/g, ' ');
}

export function rewardLines(r: { gold?: number; xp?: number; title?: string; item?: string; qty?: number }): string[] {
  const out: string[] = [];
  if (r.gold) out.push(`+${fmt(r.gold)} gold`);
  if (r.xp) out.push(`+${fmt(r.xp)} XP`);
  if (r.title) out.push(`title "${r.title}"`);
  if (r.item) out.push(`${r.qty && r.qty > 1 ? `${r.qty} x ` : ''}${itemName(r.item)}`);
  return out;
}

/** The toast for an Event 1002 / 1241 (null for anything else or bad data). */
export function toastFromEvent(ev: ZoneEvent): AchToast | null {
  if (ev.kind === AEV.earned) {
    const j = decodeJSON<{ key: string; name?: string; desc?: string; title?: string; gold?: number; xp?: number; tier?: number; pts?: number; item?: string; qty?: number }>(ev.data);
    if (!j?.key) return null;
    const def = achByKey(j.key);
    return { key: j.key, name: j.name || def?.name || j.key, desc: j.desc || def?.desc || '', tier: j.tier ?? def?.tier ?? 0, pts: j.pts ?? def?.pts ?? 0, rewards: rewardLines(j) };
  }
  if (ev.kind === AEV.caughtUp) {
    const j = decodeJSON<{ keys?: string[]; gold?: number; xp?: number; pts?: number }>(ev.data);
    const keys = j?.keys ?? [];
    const n = ev.value || keys.length;
    if (!n) return null;
    const names = keys.map((k) => achByKey(k)?.name ?? k);
    return {
      key: '',
      name: `${n} achievement${n === 1 ? '' : 's'} earned from your past deeds`,
      desc: names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', '),
      tier: Math.max(0, ...keys.map((k) => achByKey(k)?.tier ?? 0)),
      pts: j?.pts ?? 0,
      rewards: rewardLines({ gold: j?.gold, xp: j?.xp }),
      summary: true,
    };
  }
  return null;
}
