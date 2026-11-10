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

/** Panels drawn in the middle of the screen (playtest 2): what sits in the middle or left waits under them. */
const CENTRE_PANELS = ['camp-menu', 'camp-chest', 'camp-label', 'steed-panel', 'pet-panel', 'tablet-reader', 'quest-journal', 'quest-offer', 'inventory-panel', 'achievements-panel'].map((id) => `[data-testid="${id}"]`).join(', ');

export const HUD_CSS = `
:root {
  --ls-center-half: ${CENTER_HALF_PX}px;
  --ls-hotbar-h: 0px;
  --ls-hint-h: 0px;
  --ls-corner-bottom: 12px;
  --ls-chat-w: min(400px, calc(50vw - var(--ls-center-half) - 24px));
  --ls-badge-h: 0px;
  --ls-clock-h: 30px;
  --ls-vault-h: 130px;
}
/* Netlify's free tier injects a "Powered by Netlify" badge in the bottom-right
   corner of the live site; keep the right corner's overlays above it. */
:root:has([data-nf-variant]) { --ls-badge-h: 56px; }
/* A panel that freed the mouse on purpose (shop, inventory, map, journal...)
   makes "Click to look around" noise: hide it while one is open. */
body:has([data-ui-panel]:not([style*="display: none"])) [data-testid="lock-hint"] { display: none !important; }
/* The sound, graphics and friends panels open under the top-right buttons, over the quest tracker. */
body:has([data-testid="sound-settings"], [data-testid="graphics-settings"], [data-testid="friends-panel"], [data-testid="craft-panel"]) [data-testid="quest-tracker"] { visibility: hidden; }
/* The "[E] ..." prompt is noise once the thing it offers is open. */
body:has([data-ui-panel]:not([style*="display: none"])) [data-testid="town-prompt"] { visibility: hidden; }
/* Playtest 2 integration QA (tools/playtest/sp13.mjs: every playtest 2 overlay at once at
   1920x1080, 1600x900 and 1280x720). Top centre: the world event tracker sits under the clock
   pill and its forecast line (--ls-clock-h, measured), and steps aside for the big centre cards
   (level up, a new place, a catch) and anything covering the middle. */
body:has([data-testid="levelup-fanfare"], [data-testid="discovery-intro"], [data-testid="fish-caught"], ${CENTRE_PANELS}, [data-testid="emote-wheel"], [data-testid="pet-wheel"], [data-testid="achievement-toast"]) [data-testid="world-event"] { visibility: hidden; }
/* CR 031: the achievement toast (top centre, under the clock) takes the world event tracker's place for its few
   seconds, and never shows over the big centre cards or a panel (ui/achievements/toasts.ts also holds it then). */
body:has([data-testid="levelup-fanfare"], [data-testid="discovery-intro"], [data-testid="fish-caught"], [data-testid="whatsnew"], ${CENTRE_PANELS}, [data-testid="character-panel"], [data-testid="emote-wheel"], [data-testid="pet-wheel"]) [data-testid="achievement-toast"] { visibility: hidden; }
/* Left column: content notes (top), the vault puzzle, the pet card under it (--ls-vault-h), the
   Rested strip (bottom). A centred panel or the instrument overlay covers them at 1280 wide. */
body:has([data-testid="vault-panel"]) [data-testid="pet-card"] { top: calc(min(46vh, 420px) + var(--ls-vault-h, 130px) + 8px) !important; }
body:has(${CENTRE_PANELS}, [data-testid="music-overlay"], [data-testid="character-panel"]) :is([data-testid="content-notes"], [data-testid="vault-panel"], [data-testid="pet-card"], [data-testid="camp-strips"], [data-testid="pet-notes"], [data-testid="steed-notes"]) { visibility: hidden; }
/* The character panel (spell cards, 604 px from the left edge) reaches the clock pill below ~1450 px wide and the world event tracker below ~1680 px: they wait. */
@media (max-width: 1450px) { body:has([data-testid="character-panel"]) [data-testid="night-hud"] { visibility: hidden; } }
@media (max-width: 1680px) { body:has([data-testid="character-panel"]) [data-testid="world-event"] { visibility: hidden; } }
/* The level-up and arrival cards (a few seconds) do not sit on a panel you opened. */
body:has(${CENTRE_PANELS}, [data-testid="character-panel"]) :is([data-testid="levelup-fanfare"], [data-testid="discovery-intro"]) { visibility: hidden !important; }
/* A held emote / pet wheel fills the middle: the tip and the lock hint under it wait. */
body:has([data-testid="emote-wheel"], [data-testid="pet-wheel"]) :is([data-testid="tip"], [data-testid="lock-hint"]) { visibility: hidden; }
/* Playing an instrument: the overlay takes the bottom; chat can't be opened (Enter is the metronome). */
body:has([data-testid="music-overlay"]) :is([data-testid="chat-open"], [data-testid="chat-toast"]) { visibility: hidden; }
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
/** Top-right button row: Sound at the corner, Graphics (playtest 2) to its left, then Friends. */
export const TOP_BUTTON_TOP = 12;
export const SOUND_BUTTON_W = 78;
export const GRAPHICS_BUTTON_W = 82;
export const GRAPHICS_BUTTON_RIGHT = 12 + SOUND_BUTTON_W + 8;
export const FRIENDS_BUTTON_RIGHT = GRAPHICS_BUTTON_RIGHT + GRAPHICS_BUTTON_W + 8;
/** Chat column width. */
export const CHAT_WIDTH = 'var(--ls-chat-w, 400px)';
/** Top of the world event tracker: under the clock pill, its forecast line and night notices (--ls-clock-h). */
export const BELOW_CLOCK = 'calc(56px + var(--ls-clock-h, 30px) + 6px)';
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
export function useHudHeight(ref: RefObject<HTMLElement | null>, name: '--ls-hotbar-h' | '--ls-hint-h' | '--ls-clock-h' | '--ls-vault-h', active = true): void {
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
