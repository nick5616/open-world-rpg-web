// Playtest 2 (new player onboarding): the Esc menu's state and its plug-in
// entries. Other packages add a row with registerMenuEntry (What's new
// does; Graphics and Sound are built in), either opening their own panel
// (the menu closes first) or drawing a page inside the menu.

import type { ReactNode } from 'react';
import { create } from 'zustand';

export interface MenuEntry {
  id: string;
  label: string;
  /** Sort key among the plug-in rows (Sound is 10; lower comes first). */
  order?: number;
  /** Opens the entry's own panel; the menu closes first. */
  open?: () => void;
  /** Or a page drawn inside the menu (with a Back button). */
  render?: () => ReactNode;
}

export type MenuPage = 'main' | 'controls' | `entry:${string}`;

interface MenuState {
  open: boolean;
  page: MenuPage;
  entries: MenuEntry[];
  setOpen: (open: boolean) => void;
  setPage: (page: MenuPage) => void;
}

export const useMenu = create<MenuState>()((set) => ({
  open: false,
  page: 'main',
  entries: [],
  setOpen: (open) => set({ open, page: 'main' }),
  setPage: (page) => set({ page }),
}));

/** Adds (or replaces, by id) a menu row; returns its removal. */
export function registerMenuEntry(entry: MenuEntry): () => void {
  useMenu.setState((s) => ({ entries: sortEntries([...s.entries.filter((e) => e.id !== entry.id), entry]) }));
  return () => useMenu.setState((s) => ({ entries: s.entries.filter((e) => e !== entry) }));
}

export function sortEntries(list: MenuEntry[]): MenuEntry[] {
  return [...list].sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.label.localeCompare(b.label));
}

export function openMenu(): void {
  if (!useMenu.getState().open) useMenu.getState().setOpen(true);
}

export function closeMenu(): void {
  if (useMenu.getState().open) useMenu.getState().setOpen(false);
}

/**
 * What an Esc press does, decided before any other key listener runs
 * (capture phase): close the menu, close the top panel on the stack
 * (input/panelStack.ts: only that one), leave it alone, or open the menu.
 * `sinceUnlockMs` is the time since the browser dropped pointer lock: the
 * Esc that freed the mouse already opened the menu (Chrome may deliver that
 * key press too), so it must not close it again. `panelOpen` is a panel
 * that is not on the stack (none should be: left to its own handler).
 */
export function escAction(s: { menuOpen: boolean; stacked: boolean; panelOpen: boolean; typing: boolean; sinceUnlockMs: number }): 'close' | 'pop' | 'open' | 'none' {
  if (s.typing) return 'none';
  if (s.menuOpen) return s.sinceUnlockMs < 400 ? 'none' : 'close';
  if (s.stacked) return 'pop';
  if (s.panelOpen) return 'none';
  return 'open';
}

/**
 * Whether a lost pointer lock should open the menu: the player pressed Esc
 * to free the mouse (not a panel freeing it on purpose, chat, or the window
 * losing focus).
 */
export function unlockOpensMenu(s: { panelOpen: boolean; typing: boolean; focused: boolean; menuOpen: boolean; requestedMs: number }): boolean {
  return !s.menuOpen && !s.panelOpen && !s.typing && s.focused && s.requestedMs > 600;
}
