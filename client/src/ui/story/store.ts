// Main story state in the browser (playtest 2, CR 035): your story (1600),
// your party's progress (1601), the finale at the Heartfall (1603, 1604),
// the ending (1605), lines from the story's speakers (1606) and revives
// (1610-1612). `reduceStoryEvent` is pure and unit-tested; the zone is the
// truth.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { SEV, STORY_REFUSAL, decodeJSON, type FinaleIntro, type FinaleView, type ReviveWindow, type StoryEnding, type StoryParty, type StorySync } from './events';

export interface StoryLine {
  id: number;
  speaker: string;
  text: string;
  at: number;
}

export interface DownedFriend {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  until: number;
}

export interface StoryActions {
  sync(): void;
  catchUp(): void;
  revive(target: number, on: boolean): void;
  respawn(): void;
  vow(on: boolean): void;
}

export interface StoryState {
  self: number;
  sync: StorySync | null;
  party: StoryParty | null;
  finale: (FinaleView & { at: number }) | null;
  cinematic: (FinaleIntro & { at: number }) | null;
  ending: (StoryEnding & { at: number }) | null;
  lines: StoryLine[];
  /** You are down and a friend may raise you until this (performance.now()). */
  reviveUntil: number;
  /** Friends down near you that you can raise. */
  downed: Record<number, DownedFriend>;
  /** A revive under way (you holding E, or a friend holding it over you). */
  reviving: { by: number; target: number; at: number; ms: number } | null;
  actions: StoryActions | null;
}

export const LINE_MS = 7000;
const MAX_LINES = 4;
let lineId = 1;

export const emptyStory = (): Omit<StoryState, 'actions'> => ({
  self: 0,
  sync: null,
  party: null,
  finale: null,
  cinematic: null,
  ending: null,
  lines: [],
  reviveUntil: 0,
  downed: {},
  reviving: null,
});

export const useStory = create<StoryState>(() => ({ ...emptyStory(), actions: null }));

function line(s: Omit<StoryState, 'actions'>, speaker: string, text: string, now: number): StoryLine[] {
  const keep = s.lines.filter((l) => now - l.at < LINE_MS && !(l.text === text && l.speaker === speaker));
  return [...keep, { id: lineId++, speaker, text, at: now }].slice(-MAX_LINES);
}

/** Apply one Event (pure). */
export function reduceStoryEvent(s: Omit<StoryState, 'actions'>, ev: ZoneEvent, now: number): Omit<StoryState, 'actions'> {
  switch (ev.kind) {
    case SEV.sync: {
      const sync = decodeJSON<StorySync>(ev);
      return sync ? { ...s, sync } : s;
    }
    case SEV.party: {
      const party = decodeJSON<StoryParty>(ev);
      return { ...s, party: party && party.members?.length ? party : null };
    }
    case SEV.finale: {
      const f = decodeJSON<FinaleView>(ev);
      return f ? { ...s, finale: { ...f, at: now } } : s;
    }
    case SEV.finaleIntro: {
      const c = decodeJSON<FinaleIntro>(ev);
      return c ? { ...s, cinematic: { ...c, at: now } } : s;
    }
    case SEV.ending: {
      const e = decodeJSON<StoryEnding>(ev);
      return e ? { ...s, ending: { ...e, at: now }, cinematic: null, reviveUntil: 0, reviving: null } : s;
    }
    case SEV.say: {
      const l = decodeJSON<{ speaker: string; text: string }>(ev);
      return l ? { ...s, lines: line(s, l.speaker, l.text, now) } : s;
    }
    case SEV.refused:
      return { ...s, lines: line(s, '', STORY_REFUSAL[ev.value] ?? 'Not now', now) };
    case SEV.reviveWindow: {
      const w = decodeJSON<ReviveWindow>(ev);
      if (!w) return s;
      if (w.id === s.self) return { ...s, reviveUntil: now + w.ms };
      return { ...s, downed: { ...s.downed, [w.id]: { id: w.id, name: w.name, x: w.x, y: w.y, z: w.z, until: now + w.ms } } };
    }
    case SEV.reviveProgress:
      if (ev.value <= 0) return { ...s, reviving: null };
      return { ...s, reviving: { by: ev.entityId, target: ev.targetId, at: now, ms: ev.value } };
    case SEV.revived: {
      const downed = { ...s.downed };
      delete downed[ev.entityId];
      const by = new TextDecoder().decode(ev.data);
      const mine = ev.entityId === s.self;
      return {
        ...s,
        downed,
        reviving: null,
        reviveUntil: mine ? 0 : s.reviveUntil,
        lines: mine ? line(s, '', `${by || 'A friend'} raises you to your feet.`, now) : s.lines,
      };
    }
  }
  return s;
}

/** Drop what has expired (lines, revive windows). */
export function pruneStory(s: Omit<StoryState, 'actions'>, now: number): Omit<StoryState, 'actions'> | null {
  let changed = false;
  const lines = s.lines.filter((l) => now - l.at < LINE_MS);
  if (lines.length !== s.lines.length) changed = true;
  const downed: Record<number, DownedFriend> = {};
  for (const [k, d] of Object.entries(s.downed)) {
    if (d.until > now) downed[Number(k)] = d;
    else changed = true;
  }
  const reviveUntil = s.reviveUntil > now ? s.reviveUntil : 0;
  if (reviveUntil !== s.reviveUntil) changed = true;
  return changed ? { ...s, lines, downed, reviveUntil } : null;
}

export function applyStoryEvent(ev: ZoneEvent, now = performance.now()): void {
  const { actions, ...rest } = useStory.getState();
  useStory.setState({ ...reduceStoryEvent(rest, ev, now), actions });
}

export function setStorySelf(id: number): void {
  if (useStory.getState().self !== id) useStory.setState({ self: id });
}

export function setStoryActions(actions: StoryActions | null): void {
  useStory.setState({ actions });
}

export function resetStory(): void {
  useStory.setState({ ...emptyStory(), actions: useStory.getState().actions });
}

export function closeEnding(): void {
  useStory.setState({ ending: null });
}

export function endCinematic(): void {
  useStory.setState({ cinematic: null });
}

/** The nearest friend you can raise within reach (m), or null. */
export function reviveTarget(s: Pick<StoryState, 'downed'>, x: number, z: number, reach = 3.2): DownedFriend | null {
  let best: DownedFriend | null = null;
  let bd = reach;
  for (const d of Object.values(s.downed)) {
    const dist = Math.hypot(d.x - x, d.z - z);
    if (dist <= bd) {
      best = d;
      bd = dist;
    }
  }
  return best;
}
