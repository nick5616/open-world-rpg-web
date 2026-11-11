// Playtest 2 polish: one stack of open panels, so Esc closes only the top
// one. Every panel, mode and held wheel that Esc closes registers here when
// it opens (usePanelEsc in React, syncPanel elsewhere) and leaves when it
// closes. The Esc menu's key listener (ui/menu/EscMenu.tsx, installed
// first, capture phase) pops the newest one and stops the event; with
// nothing on the stack Esc opens the menu. Panels no longer listen for Esc
// themselves (they used to, all at once: a shop and the inventory both
// closed on one press; the journal's Esc also dismissed a quest offer).
//
// Text fields keep their own Esc (chat, the dev console's command line, the
// signpost name box): the menu's listener leaves an Esc typed in a text box
// alone.

import { useEffect, useRef } from 'react';

interface Entry {
  id: string;
  close: () => void;
}

const stack: Entry[] = [];

/** Puts `id` on top (opening it again brings it to the top). */
export function showPanel(id: string, close: () => void): void {
  const i = stack.findIndex((e) => e.id === id);
  if (i >= 0) stack.splice(i, 1);
  stack.push({ id, close });
}

/** Takes `id` off the stack (closed some other way: its key, a button, walking away). */
export function hidePanel(id: string): void {
  const i = stack.findIndex((e) => e.id === id);
  if (i >= 0) stack.splice(i, 1);
}

/**
 * Follows a panel's open flag: newly open goes on top, closed comes off,
 * still open stays where it is (only its close function is refreshed).
 */
export function syncPanel(id: string, open: boolean, close: () => void): void {
  const e = stack.find((x) => x.id === id);
  if (!open) hidePanel(id);
  else if (e) e.close = close;
  else showPanel(id, close);
}

/** Closes the top panel; false when none is open. */
export function closeTopPanel(): boolean {
  const top = stack.pop();
  if (!top) return false;
  top.close();
  return true;
}

export function topPanel(): string | null {
  return stack.length ? stack[stack.length - 1].id : null;
}

/** Open panels, bottom to top (tests, the console). */
export function openPanels(): string[] {
  return stack.map((e) => e.id);
}

/** Test reset. */
export function clearPanels(): void {
  stack.length = 0;
}

interface Store<S> {
  getState(): S;
  subscribe(listener: (s: S, prev: S) => void): () => void;
}

/** A panel whose open flag lives in a store: follows it from now on (module level; returns the unsubscribe). */
export function trackPanel<S>(store: Store<S>, isOpen: (s: S) => boolean, id: string, close: () => void): () => void {
  syncPanel(id, isOpen(store.getState()), close);
  return store.subscribe((s, prev) => {
    const o = isOpen(s);
    if (o !== isOpen(prev)) syncPanel(id, o, close);
  });
}

/** React: registers the panel while `open` (Esc calls `close`). */
export function usePanelEsc(id: string, open: boolean, close: () => void): void {
  const fn = useRef(close);
  fn.current = close;
  useEffect(() => {
    syncPanel(id, open, () => fn.current());
    return () => hidePanel(id);
  }, [id, open]);
}

if (typeof window !== 'undefined') (window as unknown as { __lodestonePanels?: unknown }).__lodestonePanels = { open: openPanels, top: topPanel, closeTop: closeTopPanel };
