// The guiding wisp's request state (CR 052), shared by the key handler, the
// scene layer and the little DOM line. Plain object for what the frame loop
// reads; a zustand store for the one line of text that fades.

import { create } from 'zustand';

/** How long a wisp that started by itself (a new quest step) guides you (ms). */
export const AUTO_GUIDE_MS = 20000;

export const guide = {
  /** The key was pressed: toggle on the next frame. */
  toggle: false,
  /** A new quest step asked for a short guide. */
  auto: false,
};

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
