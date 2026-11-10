// Mounts in the browser (playtest 2, CR 027): your steed (Event 1140), every
// steed you were told about (1141, by owner), notes (refusals 1142, thrown
// 1143) and the steed panel. `reduceSteedEvent` is pure and unit-tested; the
// zone is the truth.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { decodeState, decodeSync, PHASE, REFUSAL, STEED_EV, THROWN, type SteedSync, type SteedView } from './events';

export interface SteedActions {
  summon(): void;
  mount(): void;
  dismount(): void;
  name(text: string): void;
  colour(i: number): void;
  dismiss(): void;
  sync(): void;
  dev(): void;
}

export interface SteedNote {
  id: number;
  text: string;
  at: number;
  bad: boolean;
}

export interface MountState {
  mine: SteedSync | null;
  steeds: Record<number, SteedView>;
  notes: SteedNote[];
  panel: boolean;
  /** performance.now() of the last throw of you (an avatar stumble, a camera shake). */
  thrownAt: number;
  actions: SteedActions | null;
  selfId: number;
}

let noteId = 1;
const NOTE_MS = 5000;

export const initialMounts = (): Omit<MountState, 'actions'> => ({ mine: null, steeds: {}, notes: [], panel: false, thrownAt: -1e9, selfId: 0 });

/** Pure: the state after one zone Event (1140-1143). */
export function reduceSteedEvent(s: Omit<MountState, 'actions'>, e: ZoneEvent, now: number): Omit<MountState, 'actions'> {
  const note = (text: string, bad: boolean) => (text ? [...s.notes.filter((n) => now - n.at < NOTE_MS), { id: noteId++, text, at: now, bad }] : s.notes);
  switch (e.kind) {
    case STEED_EV.sync: {
      const m = decodeSync(e);
      if (!m) return s;
      const bonded = !!m.owned && !s.mine?.owned && s.mine !== null;
      return { ...s, mine: m, notes: bonded ? note(`A spirit steed answers your whistle. Name it in the steed panel (Character, C).`, false) : s.notes };
    }
    case STEED_EV.state: {
      const v = decodeState(e, now);
      if (!v) return s;
      const steeds = { ...s.steeds };
      const old = steeds[v.owner];
      if (old && old.ver > v.ver && v.ver !== 0) return s; // an older state than the one drawn
      if (v.phase === PHASE.gone) delete steeds[v.owner];
      else steeds[v.owner] = v;
      return { ...s, steeds };
    }
    case STEED_EV.refused: {
      let text = REFUSAL[e.value] ?? REFUSAL[1];
      if (e.value === 3 && e.targetId) text = `Your steed is still spooked (${Math.ceil(e.targetId / 1000)} s).`;
      return { ...s, notes: note(text, true) };
    }
    case STEED_EV.thrown: {
      if (e.entityId !== s.selfId) return s;
      return { ...s, thrownAt: e.value === 0 || e.value === 5 || e.value === 6 ? s.thrownAt : now, notes: note(THROWN[e.value] ?? '', e.value === 1 || e.value === 2) };
    }
  }
  return s;
}

export const useMounts = create<MountState>(() => ({ ...initialMounts(), actions: null }));

export function applySteedEvent(e: ZoneEvent): void {
  const now = performance.now();
  useMounts.setState((s) => reduceSteedEvent(s, e, now));
}

export function resetMounts(): void {
  useMounts.setState({ ...initialMounts() });
}

export function setSteedActions(a: SteedActions | null): void {
  useMounts.setState({ actions: a });
}

export function setSteedSelf(id: number): void {
  if (useMounts.getState().selfId !== id) useMounts.setState({ selfId: id });
}

/** A rider's steed look (colour, name) for avatars: from their 1141, else the default. */
export function steedLookOf(owner: number): { colour: number; name: string } {
  const v = useMounts.getState().steeds[owner];
  if (v) return { colour: v.colour, name: v.name };
  const s = useMounts.getState();
  if (owner === s.selfId && s.mine) return { colour: s.mine.colour, name: s.mine.name };
  return { colour: 0, name: '' };
}
