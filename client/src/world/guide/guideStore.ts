// The guiding wisp's request state (CR 052), shared by the key handler, the
// scene layer and the little DOM line. Plain object for what the frame loop
// reads; a zustand store for the one line of text that fades.

import { create } from 'zustand';

/** How long a wisp that started by itself (a new quest step) guides you (ms). */
export const AUTO_GUIDE_MS = 20000;

/** A place the wisp can lead to (CR 055: a marked service, a pin). */
export interface PlaceGoal {
  x: number;
  z: number;
  label: string;
}

export const guide = {
  /** The key was pressed: toggle on the next frame. */
  toggle: false,
  /** A new quest step asked for a short guide. */
  auto: false,
  /** CR 055: "Guide me" on a place: start (or re-aim) the wisp at `target` on the next frame. */
  go: false,
  target: null as PlaceGoal | null,
  /** CR 055: the place a conversation or the journal just marked: the next press of the key leads there. */
  marked: null as (PlaceGoal & { at: number }) | null,
};

/** How long a marked place is what the key leads to (ms); after that the tracked quest comes first again. */
export const MARK_GUIDE_MS = 120000;

/** "Guide me": the wisp leads to this place (a pin, a town's stables). */
export function guideTo(x: number, z: number, label: string): void {
  guide.target = { x, z, label };
  guide.go = true;
}

/** A conversation or the journal marked a place: remember it for the key. */
export function noteMarked(x: number, z: number, label: string, now = performance.now()): void {
  guide.marked = { x, z, label, at: now };
}

/** The recently marked place, if the key should lead to it. */
export function markedGoal(now = performance.now()): PlaceGoal | null {
  const m = guide.marked;
  return m && now - m.at < MARK_GUIDE_MS ? m : null;
}

export function toggleGuide(): void {
  guide.toggle = true;
}

export function requestAutoGuide(): void {
  guide.auto = true;
}

interface GuideNote {
  text: string;
  at: number;
}

export const useGuideNote = create<{ note: GuideNote | null }>(() => ({ note: null }));

export function guideNote(text: string): void {
  useGuideNote.setState({ note: { text, at: performance.now() } });
}

let installed = false;

/** The guide key: Period ("." guides you; G is the glider). */
export function installGuideKey(isBlocked: () => boolean): () => void {
  if (installed || typeof window === 'undefined') return () => {};
  installed = true;
  const on = (e: KeyboardEvent) => {
    if (e.code !== 'Period' || e.repeat || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
    if (isBlocked()) return;
    toggleGuide();
  };
  window.addEventListener('keydown', on);
  return () => {
    window.removeEventListener('keydown', on);
    installed = false;
  };
}
