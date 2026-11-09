// HUD bottom layout (playtest 1: "the lower part of the HUD is vertically
// crowded, with UI elements overlapping"). One set of CSS variables on :root
// that the bottom-anchored overlays share, so they stack instead of
// overlapping at any window size:
//
//   centre column   the combat hotbar + bars + key hints (CombatHud), its
//                   measured height in --ls-hotbar-h; the pointer-lock hint
//                   (LockHint) sits right above it (--ls-hint-h)
//   bottom corners  chat (left) and voice (right), never wider than the
//                   space beside the centre column; below 1080 px wide
//                   there is no such space, so the corners lift above the
//                   centre stack (--ls-corner-bottom)
//   above corners   the party frame, loot toasts
//
// Elements measure themselves with useHudHeight (a ResizeObserver writing
// the variable), so a wrapped line or a hidden bar re-flows everything.

import { useEffect, type RefObject } from 'react';

/** Half the centre column's width: the hotbar and bars fit inside 2x this. */
export const CENTER_HALF_PX = 260;
/** Below this width the corners lift above the centre stack. */
export const NARROW_PX = 1080;

export const HUD_CSS = `
:root {
  --ls-center-half: ${CENTER_HALF_PX}px;
  --ls-hotbar-h: 0px;
  --ls-hint-h: 0px;
  --ls-corner-bottom: 12px;
  --ls-chat-w: min(400px, calc(50vw - var(--ls-center-half) - 24px));
}
@media (max-width: ${NARROW_PX}px) {
  :root {
    --ls-corner-bottom: calc(var(--ls-hotbar-h) + var(--ls-hint-h) + 20px);
    --ls-chat-w: min(400px, calc(100vw - 300px));
  }
}`;

/** Bottom offset for corner overlays (chat, voice). */
export const CORNER_BOTTOM = 'var(--ls-corner-bottom, 12px)';
/** Chat column width. */
export const CHAT_WIDTH = 'var(--ls-chat-w, 400px)';
/** Bottom offset right above the centre stack (hotbar + hint). */
export const ABOVE_HOTBAR = 'calc(var(--ls-hotbar-h, 0px) + 14px)';

export function ensureHudLayoutCss(): void {
  if (typeof document === 'undefined' || document.getElementById('ls-hud-layout')) return;
  const s = document.createElement('style');
  s.id = 'ls-hud-layout';
  s.textContent = HUD_CSS;
  document.head.appendChild(s);
}

/** Publish an element's height as a CSS variable while it is mounted. */
export function useHudHeight(ref: RefObject<HTMLElement | null>, name: '--ls-hotbar-h' | '--ls-hint-h', active = true): void {
  useEffect(() => {
    ensureHudLayoutCss();
    const el = ref.current;
    const root = document.documentElement;
    if (!el || !active) {
      root.style.setProperty(name, '0px');
      return;
    }
    const set = () => root.style.setProperty(name, `${Math.ceil(el.getBoundingClientRect().height)}px`);
    set();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(set) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.setProperty(name, '0px');
    };
  }, [ref, name, active]);
}
