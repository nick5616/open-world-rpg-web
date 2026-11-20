// Quest state in the browser (playtest 1): the zone's quest log (Event 950
// is the whole truth; nothing here invents progress), a pending offer
// (951), a map preview ("where would this take me?") for offers and bounty
// notices, the journal (J) and short notes for steps and completions.
// `reduceQuestEvent` is pure and unit-tested.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { isImmersive, NOTE_MS_IMMERSIVE } from '../../hud/immersive';
import { decodeJSON, decodeQuest, decodeQuestLog, QEV, QUEST_REFUSAL, type QuestLogView, type QuestMarker, type QuestView } from './events';

export interface QuestNote {
  id: number;
  kind: 'started' | 'step' | 'done' | 'refused';
  title: string;
  text: string;
  at: number;
}

export interface QuestPreview {
  title: string;
  markers: QuestMarker[];
  /** Where it came from (the map shows a matching hint). */
  from: 'offer' | 'bounty' | 'quest';
}

export interface QuestActions {
  accept(id: number): void;
  abandon(id: number): void;
  turnIn(id: number): void;
  track(id: number): void;
}

export interface QuestState {
  log: QuestLogView;
  offer: { quest: QuestView; npc: number; at: number } | null;
  preview: QuestPreview | null;
  journalOpen: boolean;
  notes: QuestNote[];
  actions: QuestActions | null;
  stats: { logs: number; steps: number; completed: number; offers: number };
}

const NOTE_MS = 6000;

/** How long a quest notice stays up now (the immersive HUD shortens it): the toast bar drains over this. */
export function noteTtl(): number {
  return isImmersive() ? NOTE_MS_IMMERSIVE : NOTE_MS;
}
let noteId = 1;

/** Pure: the state change for one zone Event (null = not ours). */
export function reduceQuestEvent(s: QuestState, ev: ZoneEvent, now: number): Partial<QuestState> | null {
  const push = (n: Omit<QuestNote, 'id' | 'at'>) => [...s.notes.filter((x) => now - x.at < NOTE_MS), { ...n, id: noteId++, at: now }].slice(-3);
  switch (ev.kind) {
    case QEV.log:
      return { log: decodeQuestLog(ev.data), stats: { ...s.stats, logs: s.stats.logs + 1 } };
    case QEV.offer: {
      const q = decodeQuest(ev.data);
      return q ? { offer: { quest: q, npc: ev.entityId, at: now }, stats: { ...s.stats, offers: s.stats.offers + 1 } } : null;
    }
    case QEV.started: {
      const j = decodeJSON<{ title?: string; text?: string }>(ev.data);
      return { notes: push({ kind: 'started', title: `New quest: ${j?.title ?? ''}`, text: j?.text ?? '' }), offer: s.offer?.quest.id === ev.targetId ? null : s.offer };
    }
    case QEV.step: {
      const j = decodeJSON<{ title?: string; done?: string; next?: string }>(ev.data);
      return { notes: push({ kind: 'step', title: j?.title ?? '', text: j?.next ? `Next: ${j.next}` : (j?.done ?? '') }), stats: { ...s.stats, steps: s.stats.steps + 1 } };
    }
    case QEV.completed: {
      const j = decodeJSON<{ title?: string; gold?: number; xp?: number }>(ev.data);
      const reward = [j?.gold ? `+${j.gold} gold` : '', j?.xp ? `+${j.xp} XP` : ''].filter(Boolean).join(' · ');
      return { notes: push({ kind: 'done', title: `Quest complete: ${j?.title ?? ''}`, text: reward }), stats: { ...s.stats, completed: s.stats.completed + 1 } };
    }
    case QEV.refused:
      return { notes: push({ kind: 'refused', title: 'Quest', text: QUEST_REFUSAL[ev.value] ?? `Refused (${ev.value})` }) };
    default:
      return null;
  }
}

const initial = (): Omit<QuestState, 'actions'> => ({
  log: { tracked: 0, quests: [] },
  offer: null,
  preview: null,
  journalOpen: false,
  notes: [],
  stats: { logs: 0, steps: 0, completed: 0, offers: 0 },
});

export const useQuests = create<QuestState>(() => ({ ...initial(), actions: null }));

export function applyQuestEvent(ev: ZoneEvent, now = performance.now()): void {
  const patch = reduceQuestEvent(useQuests.getState(), ev, now);
  if (patch) useQuests.setState(patch);
}

export function resetQuests(): void {
  useQuests.setState({ ...initial() });
}

export function setQuestActions(a: QuestActions | null): void {
  useQuests.setState({ actions: a });
}

export function setQuestPreview(p: QuestPreview | null): void {
  useQuests.setState({ preview: p });
}

export function setJournalOpen(open: boolean): void {
  useQuests.setState({ journalOpen: open });
}

export function dismissOffer(): void {
  useQuests.setState({ offer: null });
}

export function pruneNotes(now = performance.now()): void {
  const n = useQuests.getState().notes;
  const ttl = noteTtl();
  const keep = n.filter((x) => now - x.at < ttl);
  if (keep.length !== n.length) useQuests.setState({ notes: keep });
}

/** Hold every note's clock for `ms` (playtest 6 polish: notes wait while a conversation is open). */
export function holdNotes(ms: number): void {
  const n = useQuests.getState().notes;
  if (n.length) useQuests.setState({ notes: n.map((x) => ({ ...x, at: x.at + ms })) });
}

/** The tracked quest (or the first one). */
export function trackedQuest(s: Pick<QuestState, 'log'> = useQuests.getState()): QuestView | null {
  return s.log.quests.find((q) => q.id === s.log.tracked) ?? s.log.quests[0] ?? null;
}

/** Every step's markers of an offer, labelled with the step number. */
export function offerMarkers(q: QuestView): QuestMarker[] {
  const out: QuestMarker[] = [];
  const seen = new Set<string>();
  (q.stepMarkers ?? [q.markers]).forEach((ms, i) => {
    for (const m of ms) {
      const k = `${Math.round(m.x)},${Math.round(m.z)},${m.label}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ...m, label: `${i + 1}. ${m.label}` });
    }
  });
  return out;
}

/** A townsperson where the client draws them (an NPC entity). */
export interface PersonSpot {
  name: string;
  x: number;
  z: number;
}

/**
 * Playtest 2: a person's marker (a point labelled "Name, role", e.g. the
 * blacksmith of a talk step) follows that person while they are drawn.
 * Townsfolk leave their work spot in the evening, and the marker used to
 * lead to an empty anvil. The nearest namesake within 300 m of the marker.
 */
export function followPeople(ms: QuestMarker[], people: readonly PersonSpot[]): QuestMarker[] {
  let out = ms;
  ms.forEach((m, i) => {
    const comma = m.label.indexOf(', ');
    if (m.r || comma <= 0) return;
    const name = m.label.slice(0, comma);
    let best: PersonSpot | null = null;
    let bd = 300;
    for (const p of people) {
      if (p.name !== name) continue;
      const d = Math.hypot(p.x - m.x, p.z - m.z);
      if (d < bd) {
        best = p;
        bd = d;
      }
    }
    if (best) {
      if (out === ms) out = ms.slice();
      out[i] = { ...m, x: best.x, z: best.z };
    }
  });
  return out;
}
