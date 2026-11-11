// Playtest 2 polish: held actions and the menus. A fishing reel (E, Space,
// the left button), a bow's draw (left button), streams and charges (1-4,
// the right button), the weapon's secondary (Z) and instrument notes are
// held. They let go when the game loses your hands: the window loses focus
// or is hidden, the mouse capture is lost (Esc, a panel freeing the mouse),
// or the Esc menu opens. While the Esc menu is open, or a panel that freed
// the mouse is up, new presses of them are ignored (fishing kept reeling
// under the menu).

import { useMenu } from '../ui/menu/store';
import { uiPanelUp } from './interact';

const listeners = new Set<() => void>();

/** Called whenever held input should let go; returns the removal. */
export function onHeldRelease(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function releaseHeld(): void {
  for (const fn of [...listeners]) fn();
}

/** The Esc menu, or a panel that freed the mouse: held actions don't start. */
export function heldBlocked(): boolean {
  if (useMenu.getState().open) return true;
  if (typeof document === 'undefined') return false;
  return !document.pointerLockElement && uiPanelUp();
}

// The Esc menu opening lets go of everything.
useMenu.subscribe((s, prev) => {
  if (s.open && !prev.open) releaseHeld();
});

// So do the window losing focus, the page hiding and the mouse capture ending (once per page).
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const w = window as Window & { __lsHeldRelease?: boolean };
  if (!w.__lsHeldRelease) {
    w.__lsHeldRelease = true;
    window.addEventListener('blur', releaseHeld);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) releaseHeld();
    });
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement) releaseHeld();
    });
  }
}
