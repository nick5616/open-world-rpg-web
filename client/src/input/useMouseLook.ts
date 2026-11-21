// Pointer lock + accumulated mouse deltas. Deltas pile up between frames and
// the controller consumes them once per rendered frame, so look is applied at
// display rate (144 Hz stays 144 Hz) while movement steps at 60 Hz.
//
// adapted from wizard-wars client/src/hooks/useMouseControls.ts

import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { installAutoCapture, installFullscreenPreference, noteLockRefused, pointerLockState, requestCapture } from './mouseCapture';

/**
 * Chrome on Windows occasionally reports a single bogus mousemove under
 * pointer lock: hundreds of pixels, often in the opposite direction, between
 * ordinary small deltas. Applied as-is it snaps the view ("gaze teleports").
 * A delta is treated as such a spike when it is both large in absolute terms
 * and far larger than the recent typical delta; genuine fast flicks ramp up
 * over several events, so they raise the running average first and pass.
 */
export function isLookSpike(dx: number, dy: number, avg: number): boolean {
  const m = Math.hypot(dx, dy);
  return m > 120 && m > 6 * avg + 40;
}

/**
 * Holds back a suspected spike for one event: if the next event continues in
 * the same direction with real magnitude it was the start of a fast flick and
 * both are applied (one event late, ~1-8 ms); otherwise it is dropped.
 */
export class LookSpikeFilter {
  private avg = 0; // running mean of |delta| per event (pixels)
  private held: { x: number; y: number } | null = null;
  push(dx: number, dy: number): { x: number; y: number } {
    let ox = 0;
    let oy = 0;
    const m = Math.hypot(dx, dy);
    if (this.held) {
      const h = this.held;
      this.held = null;
      const hm = Math.hypot(h.x, h.y);
      if (m > hm / 4 && dx * h.x + dy * h.y > 0) {
        ox += h.x;
        oy += h.y;
        this.avg = this.avg * 0.5 + hm * 0.5;
      }
    }
    if (isLookSpike(dx, dy, this.avg)) {
      this.held = { x: dx, y: dy };
      return { x: ox, y: oy };
    }
    this.avg = this.avg * 0.8 + m * 0.2;
    return { x: ox + dx, y: oy + dy };
  }
}

// The capture rules live in input/mouseCapture.ts (playtest 6: the game takes
// the mouse back whenever the browser allows); re-exported for older imports.
export { pointerLockState } from './mouseCapture';

/**
 * Playtest 2 polish: the click that captures the mouse is the game's, not an
 * attack or a cast (combat/runtime.ts asks before it swings). A click on the
 * view with the mouse free requests the lock (below); the lock arrives after
 * the click's listeners have run, so "not locked yet" marks that click. Where
 * the browser keeps refusing the lock (some headless or embedded browsers),
 * clicks fight unlocked after two refusals in a row instead of never.
 */
export function isCaptureClick(): boolean {
  if (typeof document === 'undefined' || typeof document.exitPointerLock !== 'function') return false;
  return !document.pointerLockElement && pointerLockState.refusals < 2;
}

/**
 * Playtest 2 polish: the browser's right-click menu is off over the game
 * view only (the right button uses a spell or the weapon's move there, and
 * with the mouse captured every click is the game's). Chat, text boxes and
 * panels keep it (copy, paste, spelling); panels that use the right button
 * themselves (the map's pins, chat names, the skill screen) stop it there.
 */
export function blocksContextMenu(target: EventTarget | null): boolean {
  if (typeof document !== 'undefined' && document.pointerLockElement) return true;
  return (target as HTMLElement | null)?.tagName === 'CANVAS';
}

export function useMouseLook() {
  const delta = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const filter = new LookSpikeFilter();
    const onMove = (e: MouseEvent) => {
      if (!document.pointerLockElement) return;
      const d = filter.push(e.movementX, e.movementY);
      delta.current.x += d.x;
      delta.current.y += d.y;
    };
    const onDown = (e: MouseEvent) => {
      // Only the canvas acquires the lock, so clicks on overlays (debug panel,
      // menus) still work normally.
      if (!document.pointerLockElement && e.target instanceof HTMLCanvasElement && e.button === 0) {
        requestCapture({ soft: false, el: e.target });
      }
    };
    const onLock = () => {
      if (document.pointerLockElement) pointerLockState.refusals = 0;
      delta.current.x = 0;
      delta.current.y = 0;
      useAppStore.getState().setPointerLocked(!!document.pointerLockElement);
    };
    const onLockError = () => noteLockRefused();
    const onContext = (e: Event) => {
      if (blocksContextMenu(e.target)) e.preventDefault();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('pointerlockerror', onLockError);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('pointerlockchange', onLock);
    document.addEventListener('contextmenu', onContext);
    const offAuto = installAutoCapture();
    const offFs = installFullscreenPreference();
    return () => {
      offAuto();
      offFs();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('pointerlockerror', onLockError);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('pointerlockchange', onLock);
      document.removeEventListener('contextmenu', onContext);
      if (document.pointerLockElement) document.exitPointerLock();
    };
  }, []);

  /** Returns and clears the accumulated delta (pixels). */
  const consume = () => {
    const d = { x: delta.current.x, y: delta.current.y };
    delta.current.x = 0;
    delta.current.y = 0;
    return d;
  };
  return consume;
}
