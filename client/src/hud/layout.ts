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
  --ls-badge-h: 0px;
}
/* Netlify's free tier injects a "Powered by Netlify" badge in the bottom-right
   corner of the live site; keep the right corner's overlays above it. */
:root:has([data-nf-variant]) { --ls-badge-h: 56px; }
/* A panel that freed the mouse on purpose (shop, inventory, map, journal...)
   makes "Click to look around" noise: hide it while one is open. */
body:has([data-ui-panel]:not([style*="display: none"])) [data-testid="lock-hint"] { display: none !important; }
/* The sound and friends panels open under the top-right buttons, over the quest tracker. */
body:has([data-testid="sound-settings"], [data-testid="friends-panel"], [data-testid="craft-panel"]) [data-testid="quest-tracker"] { visibility: hidden; }
/* The "[E] ..." prompt is noise once the thing it offers is open. */
body:has([data-ui-panel]:not([style*="display: none"])) [data-testid="town-prompt"] { visibility: hidden; }
/* A shop / NPC dialogue sits on the right: loot toasts (a purchase, a quest reward) move to its left. */
body:has([data-testid="town-panel"]:not([style*="display: none"])) [data-testid="loot-toasts"] { right: calc(4% + min(380px, 86vw) + 14px) !important; }
@media (max-width: ${NARROW_PX}px) {
  :root {
    --ls-corner-bottom: calc(var(--ls-hotbar-h) + var(--ls-hint-h) + 20px);
    --ls-chat-w: min(400px, calc(100vw - 300px));
  }
}`;

/** Bottom offset for corner overlays (chat, voice). */
export const CORNER_BOTTOM = 'var(--ls-corner-bottom, 12px)';
/** Bottom offset for the right corner (voice): also clears the hosting badge. */
export const CORNER_BOTTOM_RIGHT = 'calc(var(--ls-corner-bottom, 12px) + var(--ls-badge-h, 0px))';
/** Top-right button row: Sound at the corner, Friends to its left. */
export const TOP_BUTTON_TOP = 12;
export const SOUND_BUTTON_W = 78;
export const FRIENDS_BUTTON_RIGHT = 12 + SOUND_BUTTON_W + 8;
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
