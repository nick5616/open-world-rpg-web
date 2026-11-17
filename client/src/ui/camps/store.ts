// Camps in the browser (playtest 2, CR 025): the pieces you know (by area,
// Events 1100-1102), your camp and the signposts on your map (1106), the
// open chest (1104), Rested (1105), short notes, and the placement mode.
// `reduceCampEvent` is pure and unit-tested; the zone is the truth. Every
// change to the pieces rebuilds the solid set the movement ground reads
// (collide.ts campRuntime), so prediction collides with what the zone does.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { CAMPS } from '@lodestone/contracts';
import { missingText } from '../build/defs';
import { CampSet, campRuntime, isSolid, pieceDef } from './collide';
import { BUILD_EV, CAMP_EV, CAMP_REFUSAL, decodeBuildInfo, decodeBuildMissing, decodeArea, decodeChest, decodeMine, decodePiece, decodeRemoved, decodeRested, noteText, PIECE, type BuildInfo, type BuildMissing, type CampMine, type CampPiece, type ChestView, type RestedInfo } from './events';

export interface CampNote {
  id: number;
  kind: 'info' | 'fire' | 'rest' | 'refused' | 'placed' | 'removed';
  text: string;
  at: number;
}

export interface CampActions {
  /** `y`: a building piece's height (m) for the zone to check against its sockets; null for camp pieces and a first foundation. */
  place(kind: number, rot: number, x: number, z: number, y?: number | null): void;
  repair(id: number): void;
  home(): void;
  share(on: boolean): void;
  buildSync(): void;
  pickup(id: number): void;
  use(id: number): void;
  fuel(id: number, n?: number): void;
  put(piece: number, handle: number, qty?: number): void;
  take(piece: number, slot: number): void;
  label(piece: number, text: string): void;
  lock(piece: number, party: boolean): void;
  dev(): void;
  sync(): void;
}

export interface Placing {
  kind: number;
  rot: number;
  /** Metres ahead of the feet. */
  dist: number;
}

/** Build mode (CR 041, ui/build): the piece in hand and its turn (quarter turns: 0, 2, 4, 6). */
export interface Building {
  kind: number;
  rot: number;
}

export interface CampState {
  /** CR 041: your base summary (Event 1820), what the last refusal was missing (1821), build mode, the build menu. */
  build: BuildInfo | null;
  missing: BuildMissing | null;
  building: Building | null;
  buildMenu: boolean;
  pieces: Record<number, CampPiece>;
  mine: CampMine;
  chest: ChestView | null;
  rested: { until: number; info: RestedInfo } | null;
  notes: CampNote[];
  placing: Placing | null;
  menu: boolean;
  labeling: number | null;
  actions: CampActions | null;
  selfId: number;
}

const NOTE_MS = 6000;
let noteId = 1;

export const emptyMine = (): CampMine => ({ pieces: [], markers: [], spawn: null, max: CAMPS.limits.maxPieces, restedS: 0 });

const initial = (): Omit<CampState, 'actions'> => ({ build: null, missing: null, building: null, buildMenu: false, pieces: {}, mine: emptyMine(), chest: null, rested: null, notes: [], placing: null, menu: false, labeling: null, selfId: 0 });

export const useCamps = create<CampState>(() => ({ ...initial(), actions: null }));

const note = (kind: CampNote['kind'], text: string, now: number): CampNote => ({ id: noteId++, kind, text, at: now });

/** The state after one camp Event (pure). */
export function reduceCampEvent(s: Omit<CampState, 'actions'>, e: ZoneEvent, now = performance.now()): Partial<CampState> | null {
  switch (e.kind) {
    case CAMP_EV.area: {
      const { pieces } = decodeArea(e, now);
      const next = { ...s.pieces };
      for (const p of pieces) next[p.id] = p;
      return { pieces: next };
    }
    case CAMP_EV.piece: {
      const [p] = decodePiece(e.data, 0, now);
      const out: Partial<CampState> = { pieces: { ...s.pieces, [p.id]: p } };
      if (e.value === 1 && p.mine && e.entityId === s.selfId) out.notes = [...s.notes, note('placed', `${pieceDef(p.kind)?.name ?? 'Piece'} placed`, now)];
      return out;
    }
    case CAMP_EV.removed: {
      const id = decodeRemoved(e);
      if (!s.pieces[id]) return null;
      const next = { ...s.pieces };
      const p = next[id];
      delete next[id];
      const out: Partial<CampState> = { pieces: next };
      if (s.chest?.piece === id) out.chest = null;
      if (e.value === 2 && p.mine) out.notes = [...s.notes, note('removed', `The wilds took your ${pieceDef(p.kind)?.name.toLowerCase() ?? 'piece'}`, now)];
      return out;
    }
    case BUILD_EV.info:
      return { build: decodeBuildInfo(e) };
    case BUILD_EV.missing: {
      const m = decodeBuildMissing(e);
      return { missing: m, notes: [...s.notes, note('refused', missingText(m.items.map((i) => ({ item: i.item, need: i.qty, have: i.have }))) || CAMP_REFUSAL[31], now)] };
    }
    case CAMP_EV.refused:
      if (e.value === 31) return { notes: s.notes }; // Event 1821 names what is missing
      return { notes: [...s.notes, note('refused', CAMP_REFUSAL[e.value] ?? `Refused (${e.value})`, now)] };
    case CAMP_EV.chest: {
      const c = decodeChest(e);
      if (!c.open) return { chest: null, notes: [...s.notes, note('refused', CAMP_REFUSAL[17], now)] };
      return { chest: c };
    }
    case CAMP_EV.rested: {
      const info = decodeRested(e);
      if (!info) return { rested: null, notes: [...s.notes, note('rest', 'You are no longer Rested', now)] };
      return { rested: { until: now + e.value * 1000, info } };
    }
    case CAMP_EV.mine:
      return { mine: decodeMine(e) };
    case CAMP_EV.note:
      return { notes: [...s.notes, note(e.value === 1 ? 'fire' : e.value === 2 ? 'rest' : 'info', noteText(e), now)] };
  }
  return null;
}

let lastSolidSig = '';

/** Rebuild the movement ground's solid set when the solid pieces changed. */
export function syncSolid(pieces: Record<number, CampPiece>): void {
  const solid = Object.values(pieces).filter((p) => isSolid(p.kind));
  const sig = solid
    .map((p) => `${p.id}:${p.state}`)
    .sort()
    .join(',');
  if (sig === lastSolidSig) return;
  lastSolidSig = sig;
  campRuntime.set = new CampSet(solid.map((p) => ({ id: p.id, kind: p.kind, rot: p.rot, x: p.x, y: p.y, z: p.z, state: p.state })));
}

export function applyCampEvent(e: ZoneEvent): void {
  if ((e.kind < 1100 || e.kind > 1119) && (e.kind < 1820 || e.kind > 1839)) return;
  const s = useCamps.getState();
  const patch = reduceCampEvent(s, e);
  if (!patch) return;
  useCamps.setState(patch);
  if (patch.pieces) syncSolid(patch.pieces);
  // The chest panel needs the mouse.
  if (patch.chest && typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();
}

export function resetCamps(): void {
  useCamps.setState(initial());
  syncSolid({});
}

export function setCampActions(a: CampActions | null): void {
  useCamps.setState({ actions: a });
}

export function setCampSelf(id: number): void {
  if (useCamps.getState().selfId !== id) useCamps.setState({ selfId: id });
}

export function pruneCampNotes(now = performance.now()): void {
  const s = useCamps.getState();
  const keep = s.notes.filter((n) => now - n.at < NOTE_MS);
  if (keep.length !== s.notes.length) useCamps.setState({ notes: keep });
}

export function pushCampNote(kind: CampNote['kind'], text: string): void {
  const s = useCamps.getState();
  useCamps.setState({ notes: [...s.notes, note(kind, text, performance.now())] });
}

/** A burning campfire's circle contains (x, z): demons keep away (client view, for the HUD). */
export function safeByFire(pieces: Record<number, CampPiece>, x: number, z: number, now = performance.now()): CampPiece | null {
  const r = CAMPS.fire.safeRadiusM;
  for (const p of Object.values(pieces)) if (p.kind === PIECE.campfire && p.burning && p.burnEnd > now && Math.hypot(p.x - x, p.z - z) < r) return p;
  return null;
}
