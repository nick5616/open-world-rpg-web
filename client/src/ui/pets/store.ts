// Pets in the browser (playtest 2, CR 029): your pets (Event 1200), calm
// creatures near you (1201), the taming meter (1202), notes (refusals 1203,
// 1204) and what pets just did (1205, for the in-world effects).
// `reducePetEvent` is pure and unit-tested; the zone is the truth.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { ACT, decodeAct, decodeCalm, decodeProgress, decodeSync, INTERRUPT, NOTE, PET_EV, REFUSAL, speciesName, TAME, variantLabel, type CalmView, type PetActView, type PetSync } from './events';

export interface PetActions {
  feed(creature: number): void;
  command(cmd: number, target?: number): void;
  pet(): void;
  feedPet(): void;
  name(id: number, text: string): void;
  takeOut(id: number): void;
  stable(): void;
  release(id: number): void;
  sync(): void;
  dev(arg: number, target?: number): void;
}

export interface PetNote {
  id: number;
  text: string;
  at: number;
  bad: boolean;
}

export interface TameMeter {
  creature: number;
  sp: string;
  start: number;
  ms: number;
  food: string;
  fav: boolean;
}

/** A just-finished taming (the banner and the burst). */
export interface Tamed {
  creature: number;
  name: string;
  sp: string;
  variant: number;
  el: number;
  at: number;
  x: number;
  y: number;
  z: number;
}

export interface PetsState {
  mine: PetSync | null;
  calm: Record<number, CalmView>;
  meter: TameMeter | null;
  tamed: Tamed | null;
  acts: PetActView[];
  notes: PetNote[];
  panel: boolean;
  selfId: number;
  actions: PetActions | null;
}

let noteId = 1;
const NOTE_MS = 5000;
const ACT_MS = 2500;

export const initialPets = (): Omit<PetsState, 'actions'> => ({ mine: null, calm: {}, meter: null, tamed: null, acts: [], notes: [], panel: false, selfId: 0 });

type S = Omit<PetsState, 'actions'>;

/** Pure: the state after one zone Event (1200-1205). */
export function reducePetEvent(s: S, e: ZoneEvent, now: number): S {
  const note = (t: string, bad: boolean) => (t ? [...s.notes.filter((n) => now - n.at < NOTE_MS), { id: noteId++, text: t, at: now, bad }] : s.notes);
  switch (e.kind) {
    case PET_EV.sync: {
      const m = decodeSync(e, now);
      return m ? { ...s, mine: m } : s;
    }
    case PET_EV.calm: {
      const calm = { ...s.calm };
      if (e.value > 0) calm[e.entityId] = decodeCalm(e, now);
      else delete calm[e.entityId];
      return { ...s, calm };
    }
    case PET_EV.progress: {
      const p = decodeProgress(e);
      const mineToo = p.by === s.selfId;
      const name = speciesName(p.sp, true);
      switch (e.value) {
        case TAME.started:
        {
          if (!mineToo) return s;
          const ms = Number(e.targetId) || (p.ms ?? 0) || 1000;
          const meter: TameMeter = { creature: e.entityId, sp: p.sp, start: now, ms, food: p.food ?? '', fav: !!p.fav };
          return { ...s, meter };
        }
        case TAME.interrupted: {
          if (!mineToo) return s;
          const t = INTERRUPT[p.reason ?? 0] ?? '';
          return { ...s, meter: null, notes: note(t, true) };
        }
        case TAME.tamed: {
          const calm = { ...s.calm };
          delete calm[e.entityId];
          const tamed: Tamed = { creature: e.entityId, name: p.name ?? name, sp: p.sp, variant: p.variant ?? 0, el: p.el ?? -1, at: now, x: e.x / 100, y: e.y / 100, z: e.z / 100 };
          if (!mineToo) return { ...s, calm, tamed };
          const v = variantLabel(tamed.variant, tamed.el);
          const line = v ? `Tamed! A ${v.toLowerCase()} ${name} joins you.` : `Tamed! The ${name} joins you.`;
          return { ...s, calm, tamed, meter: null, notes: note(line, false) };
        }
        case TAME.failed: {
          const calm = { ...s.calm };
          delete calm[e.entityId];
          if (!mineToo) return { ...s, calm };
          const why = p.reason === 8 ? REFUSAL[8] : `The ${name} snatched the food and fights on!`;
          return { ...s, calm, meter: null, notes: note(why, true) };
        }
      }
      return s;
    }
    case PET_EV.refused:
      return { ...s, notes: note(REFUSAL[e.value] ?? REFUSAL[1], true) };
    case PET_EV.note: {
      const t = e.data && e.data.length ? new TextDecoder().decode(e.data) : '';
      return { ...s, notes: note(t, e.value === NOTE.ko) };
    }
    case PET_EV.act: {
      const a = decodeAct(e, now);
      return { ...s, acts: [...s.acts.filter((x) => now - x.at < ACT_MS), a] };
    }
  }
  return s;
}

export const usePets = create<PetsState>(() => ({ ...initialPets(), actions: null }));

export function applyPetEvent(e: ZoneEvent): void {
  const s = usePets.getState();
  usePets.setState(reducePetEvent(s, e, performance.now()));
}

export function resetPets(): void {
  usePets.setState({ ...initialPets(), actions: usePets.getState().actions });
}

export function setPetActions(a: PetActions | null): void {
  usePets.setState({ actions: a });
}

export function setPetSelf(id: number): void {
  if (usePets.getState().selfId !== id) usePets.setState({ selfId: id });
}

/** Your pet out with you (its info), or null. */
export function petOut(s: Pick<PetsState, 'mine'>): import('./events').PetInfo | null {
  const m = s.mine;
  if (!m || !m.active) return null;
  return m.pets.find((p) => p.id === m.active && p.out) ?? null;
}

/** Acts within the last ms (the in-world effects). */
export function recentActs(s: Pick<PetsState, 'acts'>, now: number, ms = 1200): PetActView[] {
  return s.acts.filter((a) => now - a.at < ms);
}

export { ACT };
