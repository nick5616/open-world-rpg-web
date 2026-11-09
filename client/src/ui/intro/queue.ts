// Discovery intro queue: one intro on screen at a time, the rest wait their
// turn. Pure functions over a plain state object (unit-tested in
// intro.test.ts) plus the zustand store DiscoveryIntro renders from.
//
// Rules:
//  - dedupe: an intro key ("site:35", "reveal:5", "region:5") shows once per
//    session; a key already showing or waiting is dropped too.
//  - name cards (re-entering a known town) never wait: dropped when anything
//    is showing or queued, and rate-limited per site and globally.
//  - collapse: when two or more are waiting, the one on screen cuts its hold
//    short and the next ones play faster (pace 0.75, then 0.55); past
//    MAX_WAITING the lowest-priority, oldest waiting intro is dropped.
//
// Timing is the 3d-portfolio-website region reveal (src/styles/gem.css
// `botw-region`: 3.4 s, fade in over the first 18 %, hold to 78 %, fade out),
// stretched per variant: discoveries are rarer than room entries, so they
// hold longer.

import { create } from 'zustand';

export type IntroVariant = 'region' | 'major' | 'minor' | 'card';

export interface IntroSpec {
  /** Dedupe key: "site:<index>", "reveal:<region>", "region:<region>", "card:<site>", ... */
  key: string;
  variant: IntroVariant;
  title: string;
  /** Small caps line above the title ("Region revealed"). */
  eyebrow?: string;
  /** Small caps line under the ornament ("Village · Ashen Vale"). */
  subtitle?: string;
  /** Faint line under the subtitle ("+80 XP"). */
  detail?: string;
  /** Ornament diamond color. */
  accent?: string;
  /** Keys this intro makes redundant (a region reveal covers that region's entry intro). */
  covers?: string[];
}

export interface ActiveIntro extends IntroSpec {
  id: number;
  startedAt: number;
  /** Fade-in and fade-out lengths (ms, already paced). */
  inMs: number;
  outMs: number;
  endsAt: number;
  /** 1 = full length; < 1 when others are waiting. */
  pace: number;
}

export interface IntroQueueState {
  current: ActiveIntro | null;
  queue: (IntroSpec & { id: number })[];
  /** Key -> last time it was enqueued (session dedupe and card rate limit). */
  seen: Record<string, number>;
  /** Last name card shown (global card rate limit). */
  lastCardAt: number;
  nextId: number;
}

/** Total length per variant (ms) at pace 1. Reference room reveal: 3400. */
export const INTRO_MS: Record<IntroVariant, number> = { region: 5200, major: 4400, minor: 3000, card: 2800 };
/** Reference keyframes: fade in over 0-18 %, hold to 78 %, fade out 78-100 %. */
export const IN_FRAC = 0.18;
export const OUT_FRAC = 0.22;
/** A collapsed intro still holds this long after fading in. */
export const MIN_HOLD_MS = 700;
export const MAX_WAITING = 4;
/** Same town's name card again only after this long. */
export const CARD_REPEAT_MS = 120_000;
/** Any two name cards at least this far apart. */
export const CARD_GAP_MS = 20_000;
/** No name card right after the place's own discovery intro. */
export const CARD_AFTER_DISCOVERY_MS = 60_000;

const PRIORITY: Record<IntroVariant, number> = { card: 0, minor: 1, major: 2, region: 3 };

export const emptyIntroState = (): IntroQueueState => ({ current: null, queue: [], seen: {}, lastCardAt: -Infinity, nextId: 1 });

/** How fast the next intro plays given how many wait behind it. */
export function paceFor(waitingBehind: number): number {
  return waitingBehind <= 0 ? 1 : waitingBehind === 1 ? 0.75 : 0.55;
}

function start(spec: IntroSpec & { id: number }, waitingBehind: number, now: number): ActiveIntro {
  const pace = paceFor(waitingBehind);
  const total = INTRO_MS[spec.variant] * pace;
  return { ...spec, startedAt: now, inMs: Math.round(total * IN_FRAC), outMs: Math.round(total * OUT_FRAC), endsAt: now + total, pace };
}

/** Advance the clock: retire a finished intro and start the next one. */
export function tickIntro(s: IntroQueueState, now: number): IntroQueueState {
  let { current, queue } = s;
  if (current && now >= current.endsAt) current = null;
  if (!current && queue.length > 0) {
    const [next, ...rest] = queue;
    current = start(next, rest.length, now);
    queue = rest;
  }
  return current === s.current && queue === s.queue ? s : { ...s, current, queue };
}

/** Cut the intro on screen short (others are waiting): fade out after a short hold. */
function collapseCurrent(c: ActiveIntro, now: number): ActiveIntro {
  if (now >= c.endsAt - c.outMs) return c; // already fading out
  const earliest = c.startedAt + c.inMs + MIN_HOLD_MS + c.outMs;
  const endsAt = Math.max(now + c.outMs, Math.min(c.endsAt, earliest));
  return endsAt === c.endsAt ? c : { ...c, endsAt };
}

/** Queue an intro (or drop it: duplicate, card while busy, over the limit). */
export function enqueueIntro(s0: IntroQueueState, spec: IntroSpec, now: number): IntroQueueState {
  const s = tickIntro(s0, now);
  const busy = s.current !== null || s.queue.length > 0;
  if (s.current?.key === spec.key || s.queue.some((q) => q.key === spec.key)) return s;
  if (spec.variant === 'card') {
    if (busy) return s;
    const last = s.seen[spec.key];
    if (last !== undefined && now - last < CARD_REPEAT_MS) return s;
    if (now - s.lastCardAt < CARD_GAP_MS) return s;
    const site = spec.key.startsWith('card:') ? spec.key.slice(5) : '';
    const discovered = s.seen[`site:${site}`];
    if (discovered !== undefined && now - discovered < CARD_AFTER_DISCOVERY_MS) return s;
  } else if (s.seen[spec.key] !== undefined) {
    return s;
  }
  const item = { ...spec, id: s.nextId };
  const covered = new Set(spec.covers ?? []);
  let queue = [...s.queue.filter((q) => !covered.has(q.key)), item];
  while (queue.length > MAX_WAITING) {
    // Drop the lowest-priority waiting intro, oldest first.
    let drop = 0;
    for (let i = 1; i < queue.length; i++) if (PRIORITY[queue[i].variant] < PRIORITY[queue[drop].variant]) drop = i;
    queue = queue.filter((_, i) => i !== drop);
  }
  let current = s.current;
  if (current && queue.length >= 2) current = collapseCurrent(current, now);
  const next: IntroQueueState = {
    current,
    queue,
    seen: { ...s.seen, ...Object.fromEntries([...covered].map((k) => [k, now])), [spec.key]: now },
    lastCardAt: spec.variant === 'card' ? now : s.lastCardAt,
    nextId: s.nextId + 1,
  };
  return tickIntro(next, now);
}

/** Dismiss the intro on screen now (dev handle; the next one starts). */
export function skipIntro(s: IntroQueueState, now: number): IntroQueueState {
  return s.current ? tickIntro({ ...s, current: { ...s.current, endsAt: now } }, now) : s;
}

// ---- store ----

export const useIntro = create<IntroQueueState>(() => emptyIntroState());

/** Every intro that went on screen this session (dev handle, screenshots). */
export const introHistory: { at: number; key: string; variant: IntroVariant; title: string; subtitle?: string }[] = [];

export function pushIntro(spec: IntroSpec, now = performance.now()): void {
  const before = useIntro.getState();
  const after = enqueueIntro(before, spec, now);
  if (after !== before) useIntro.setState(after, true);
  noteStarted(before, after, now);
}

export function advanceIntro(now = performance.now()): void {
  const before = useIntro.getState();
  const after = tickIntro(before, now);
  if (after !== before) useIntro.setState(after, true);
  noteStarted(before, after, now);
}

export function skipCurrentIntro(now = performance.now()): void {
  const before = useIntro.getState();
  const after = skipIntro(before, now);
  if (after !== before) useIntro.setState(after, true);
  noteStarted(before, after, now);
}

export function resetIntros(): void {
  useIntro.setState(emptyIntroState(), true);
  introHistory.length = 0;
}

function noteStarted(before: IntroQueueState, after: IntroQueueState, now: number): void {
  const c = after.current;
  if (c && c.id !== before.current?.id) {
    introHistory.push({ at: now, key: c.key, variant: c.variant, title: c.title, subtitle: c.subtitle });
    if (introHistory.length > 50) introHistory.shift();
  }
}
