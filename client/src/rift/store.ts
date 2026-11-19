// Rift runs in the browser (playtest 2, CR 040): the open rifts (2000), the
// run you are in (2001 rooms, 2002 volleys, 2003 clear, 2004 door, 2006-
// 2007 perks, 2008 rewards, 2009 bank, 2010 notes, 2005 / 2012 the end) and
// the leaderboard (2011). `reduceRiftEvent` is pure (rift.test.ts); the
// zone is the truth. The arena and the volleys also live in `riftRuntime`
// (runtime.ts) for the movement ground and the renderer, outside React.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { stageLayout, type Layout } from './layout';
import { decodeVolley, ends, seekers, type Seeker, type Volley } from './patterns';

export const RIFT_EV = {
  portals: 2000,
  stage: 2001,
  volley: 2002,
  clear: 2003,
  door: 2004,
  left: 2005,
  perks: 2006,
  perk: 2007,
  reward: 2008,
  bank: 2009,
  note: 2010,
  board: 2011,
  end: 2012,
} as const;

export const RIFT_INTERACT = 190;
export const RIFT_ACT = { enter: 1, perk: 2, leave: 3, board: 4 } as const;
/** Event 2005 value. */
export const LEFT = { refused: 0, died: 1, exit: 2, disconnect: 3, victory: 4, dev: 5 } as const;
/** Stage kinds (2001 kind). */
export const STAGE_KIND = { fight: 0, miniBoss: 1, boss: 2, gemVault: 3, gemShower: 4, gemGolem: 5 } as const;

export interface RiftPortal {
  id: number;
  x: number;
  y: number;
  z: number;
  chapter: number;
  name: string;
  color: string;
  level: number;
  endsInMs: number;
  dev?: boolean;
  /** performance.now() it was received (endsInMs counts from here). */
  at: number;
}

export interface RiftFoe {
  id: number;
  name: string;
  boss?: number;
  kind: number;
}

export interface RiftMemberView {
  id: number;
  name: string;
  perks: Record<string, number> | null;
  spoils: number;
  banked: number;
}

export interface RiftStage {
  run: number;
  chapter: number;
  chapterName: string;
  color: string;
  stage: number;
  stages: number;
  kind: number;
  kindName: string;
  level: number;
  ox: number;
  oy: number;
  oz: number;
  startTick: number;
  tick: number;
  foes: RiftFoe[] | null;
  members: RiftMemberView[] | null;
  checkpoint: boolean;
  portal: number;
}

export interface PerkCard {
  i: number;
  key: string;
  name: string;
  text: string;
  have: number;
}

export interface RiftReward {
  stage: number;
  gold: number;
  spoils: number;
  banked: number;
  items: string[] | null;
  gems: number;
  luck: number;
  minRarity: number;
  at: number;
}

export interface RiftLeft {
  reason: number;
  best: number;
  banked: number;
  chapter: number;
  chapterName: string;
  stage: number;
  perks: Record<string, number> | null;
  ms: number;
  refused?: string;
  at: number;
}

export interface BoardRow {
  name: string;
  stage: number;
  ms: number;
}

export interface Board {
  chapter: number;
  name: string;
  rows: BoardRow[] | null;
  you: number;
}

export interface RiftNote {
  id: number;
  text: string;
  tone: 'good' | 'warn' | 'info';
  at: number;
}

export interface RiftActions {
  enter(portal: number): void;
  pick(perk: number): void;
  leave(): void;
  board(chapter: number): void;
}

export interface RiftState {
  self: number;
  portals: RiftPortal[];
  stage: RiftStage | null;
  /** The room is clear (bullets fade, the door may open). */
  cleared: boolean;
  door: 0 | 1 | 2; // 0 shut, 1 open, 2 open with the way out beside it
  perks: { stage: number; cards: PerkCard[]; until: number } | null;
  taken: Record<string, number>;
  spoils: number;
  banked: number;
  reward: RiftReward | null;
  left: RiftLeft | null;
  boards: Board[];
  notes: RiftNote[];
  bossPhase: number;
  actions: RiftActions | null;
}

let nextNote = 1;
const utf8 = new TextDecoder();

export function decodeJSON<T>(d: Uint8Array): T | null {
  try {
    return JSON.parse(utf8.decode(d)) as T;
  } catch {
    return null;
  }
}

const initial = (): Omit<RiftState, 'actions' | 'self'> => ({ portals: [], stage: null, cleared: false, door: 0, perks: null, taken: {}, spoils: 0, banked: 0, reward: null, left: null, boards: [], notes: [], bossPhase: 0 });

export const useRift = create<RiftState>(() => ({ ...initial(), self: 0, actions: null }));

/** Pure: the store change for one zone Event (null = not ours). */
export function reduceRiftEvent(s: RiftState, ev: ZoneEvent, now: number): Partial<RiftState> | null {
  const note = (text: string, tone: RiftNote['tone'] = 'info'): RiftNote[] => [...s.notes.filter((n) => now - n.at < 5000), { id: nextNote++, text, tone, at: now }].slice(-4);
  switch (ev.kind) {
    case RIFT_EV.portals: {
      const list = decodeJSON<Omit<RiftPortal, 'at'>[]>(ev.data) ?? [];
      return { portals: list.map((p) => ({ ...p, at: now })) };
    }
    case RIFT_EV.stage: {
      const st = decodeJSON<RiftStage>(ev.data);
      if (!st) return null;
      const me = st.members?.find((m) => m.id === s.self);
      return { stage: st, cleared: false, door: 0, perks: null, left: null, bossPhase: 0, spoils: me?.spoils ?? s.spoils, banked: me?.banked ?? s.banked, taken: me?.perks ?? s.taken };
    }
    case RIFT_EV.clear:
      return { cleared: true, notes: note(`Room ${ev.value} clear`, 'good') };
    case RIFT_EV.door:
      return { door: ev.value === 1 ? 2 : 1 };
    case RIFT_EV.perks: {
      const p = decodeJSON<{ stage: number; seconds: number; cards: PerkCard[] }>(ev.data);
      return p ? { perks: { stage: p.stage, cards: p.cards ?? [], until: now + p.seconds * 1000 } } : null;
    }
    case RIFT_EV.perk: {
      if (ev.targetId !== s.self) return null;
      const card = s.perks?.cards.find((c) => c.i === ev.value);
      const taken = card ? { ...s.taken, [card.key]: (s.taken[card.key] ?? 0) + 1 } : s.taken;
      return { perks: null, taken, notes: card ? note(`${card.name}: ${card.text}`, 'good') : s.notes };
    }
    case RIFT_EV.reward: {
      const r = decodeJSON<Omit<RiftReward, 'at'>>(ev.data);
      return r ? { reward: { ...r, at: now }, spoils: r.spoils, banked: r.banked } : null;
    }
    case RIFT_EV.bank:
      return { banked: s.banked + ev.value, spoils: 0, notes: note(`Banked ${ev.value} gold: safe whatever happens`, 'good') };
    case RIFT_EV.note:
      if (ev.value === 1) return { notes: note('Your ward ate a shot', 'good') };
      if (ev.value === 2) return { notes: note('Graze! +3 mana', 'good') };
      if (ev.value === 4) return { bossPhase: ev.data[0] ?? s.bossPhase + 1, notes: note('The boss grows fiercer', 'warn') };
      if (ev.value === 5) return { notes: note('A friend joined the run', 'info') };
      return null;
    case RIFT_EV.left: {
      const l = decodeJSON<Omit<RiftLeft, 'at'>>(ev.data);
      if (!l) return null;
      if (l.refused) return { notes: note(l.refused, 'warn') };
      return { left: { ...l, reason: ev.value, at: now }, stage: null, cleared: false, door: 0, perks: null, taken: {}, spoils: 0, banked: 0, reward: null, bossPhase: 0 };
    }
    case RIFT_EV.board: {
      const b = decodeJSON<Board[]>(ev.data) ?? [];
      const boards = [...s.boards.filter((x) => !b.some((y) => y.chapter === x.chapter)), ...b].sort((a, c) => a.chapter - c.chapter);
      return { boards };
    }
    case RIFT_EV.end:
      return null;
  }
  return null;
}

export function applyRiftEvent(ev: ZoneEvent, now = performance.now()): void {
  const patch = reduceRiftEvent(useRift.getState(), ev, now);
  if (patch) useRift.setState(patch);
  // The arena and the shots for the movement ground and the renderer.
  if (ev.kind === RIFT_EV.stage && patch?.stage) setArena(patch.stage);
  else if (ev.kind === RIFT_EV.left && patch?.left) setArena(null);
  else if (ev.kind === RIFT_EV.volley) addVolley(ev.targetId, ev.data);
  else if (ev.kind === RIFT_EV.clear) riftRuntime.clearedAt = performance.now();
}

export function resetRift(): void {
  useRift.setState({ ...initial() });
  setArena(null);
}

export function setRiftActions(a: RiftActions | null): void {
  useRift.setState({ actions: a });
}

export function setRiftSelf(id: number): void {
  if (useRift.getState().self !== id) useRift.setState({ self: id });
}

// ---- the non-React runtime (ground, renderer) ----

export interface Arena {
  run: number;
  chapter: number;
  stage: number;
  ox: number;
  oy: number;
  oz: number;
  layout: Layout;
  color: string;
  /** The room's first tick (spikes, intro). */
  startTick: number;
}

export interface LiveVolley {
  v: Volley;
  seekers: Seeker[] | null;
  /** Last tick the seekers were stepped to. */
  stepped: number;
}

export const riftRuntime = {
  arena: null as Arena | null,
  volleys: [] as LiveVolley[],
  clearedAt: 0,
  /** Bumped when the arena changes (the renderer rebuilds its room). */
  version: 0,
};

export function setArena(st: RiftStage | null): void {
  riftRuntime.volleys = [];
  riftRuntime.clearedAt = 0;
  riftRuntime.version++;
  if (!st) {
    riftRuntime.arena = null;
    return;
  }
  riftRuntime.arena = { run: st.run, chapter: st.chapter, stage: st.stage, ox: st.ox / 100, oy: st.oy / 100, oz: st.oz / 100, layout: stageLayout(st.chapter, st.stage), color: st.color, startTick: st.startTick };
}

function addVolley(id: number, data: Uint8Array): void {
  const v = decodeVolley(id, data);
  if (!v || !riftRuntime.arena) return;
  riftRuntime.volleys.push({ v, seekers: v.kind === 7 ? seekers(v) : null, stepped: v.fire });
}

/** Drop volleys whose shots are all over (renderer, every frame). */
export function pruneVolleys(tick: number): void {
  const keep: LiveVolley[] = [];
  for (const lv of riftRuntime.volleys) if ((tick - lv.v.fire) / 30 <= ends(lv.v) + 0.5) keep.push(lv);
  riftRuntime.volleys = keep;
}

/** Whether the local player is in a rift (the arena exists). */
export function inRift(): boolean {
  return riftRuntime.arena !== null;
}
