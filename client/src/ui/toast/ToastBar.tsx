// Playtest 5 (CR 055): the thin bar along the bottom edge of every timed
// toast that drains linearly over the time you have left to read it.
//
// One component and one stylesheet. The parent must be `position: relative`
// (or fixed / absolute) with `overflow: hidden` if it has rounded corners; add the
// class `ls-timed` to it and hovering it pauses the bar (CSS only). A toast that
// stops its own clock on hover (the tips) shifts its start time while hovered,
// so the bar and the toast stay in step.
//
// prefers-reduced-motion: the bar steps down in eight jumps instead of
// gliding (a stepped bar, still readable, no continuous motion).

import { useState } from 'react';

export const TOAST_BAR_CSS = `
@keyframes lsToastDrain { from { transform: scaleX(1) } to { transform: scaleX(0) } }
.ls-toast-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: var(--ls-toast-bar, rgba(255,209,102,0.85)); transform-origin: left center; animation-name: lsToastDrain; animation-timing-function: linear; animation-fill-mode: both; pointer-events: none; }
.ls-timed:hover .ls-toast-bar { animation-play-state: paused; }
@media (prefers-reduced-motion: reduce) { .ls-toast-bar { animation-timing-function: steps(8, end); } }
`;

const STYLE_ID = 'ls-toast-bar-css';

/** Add the stylesheet once (idempotent). */
export function ensureToastBarCss(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement('style');
  el.id = STYLE_ID;
  el.textContent = TOAST_BAR_CSS;
  doc.head.appendChild(el);
}

/** Fraction of the bar left (1 full, 0 gone) for a toast shown at `at` that lasts `durationMs`. */
export function barLeft(at: number, now: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - (now - at) / durationMs));
}

/**
 * The bar. `at` is when the toast began (performance.now() clock) and
 * `durationMs` how long it lasts; a toast already part-way through starts the
 * bar part-way down. Give the toast a `key` so a new one restarts the bar.
 */
export function ToastBar({ at, durationMs, color }: { at: number; durationMs: number; color?: string }) {
  // Read once: changing the delay of a running animation would make the bar jump.
  const [elapsed] = useState(() => {
    ensureToastBarCss();
    return Math.max(0, performance.now() - at);
  });
  return (
    <div
      aria-hidden
      data-testid="toast-bar"
      className="ls-toast-bar"
      style={{ animationDuration: `${durationMs}ms`, animationDelay: `${-Math.min(elapsed, durationMs)}ms`, ...(color ? ({ '--ls-toast-bar': color } as React.CSSProperties) : null) }}
    />
  );
}
