// Held-button tracking for movement. Ref-based (no React state): the player
// controller samples it every frame, and re-rendering on every key event
// would be wasted work.
//
// adapted from wizard-wars client/src/hooks/useKeyboardControls.ts

import { useEffect, useRef } from 'react';
import { NO_BUTTONS, type HeldButtons } from '../sim/inputFrame';

export const KEY_MAP: Record<string, keyof HeldButtons> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  ControlLeft: 'crouch',
  KeyC: 'crouch',
  KeyG: 'glide', // WP10: open/close the glider without spending the double jump
};

export function isTextTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export function useKeyboard() {
  const held = useRef<HeldButtons>({ ...NO_BUTTONS });

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      // Keystrokes meant for a text field (debug teleport box, chat later)
      // must not walk the player or be swallowed by preventDefault.
      if (isTextTarget(e.target)) return;
      const k = KEY_MAP[e.code];
      if (!k) return;
      e.preventDefault();
      held.current[k] = true;
    };
    const onUp = (e: KeyboardEvent) => {
      const k = KEY_MAP[e.code];
      if (k) held.current[k] = false;
    };
    // A keyup that lands while the window is blurred (alt-tab, devtools,
    // pointer lock dropped by the browser) is never delivered, and the player
    // would run forever. Release everything when focus goes.
    const releaseAll = () => {
      held.current = { ...NO_BUTTONS };
    };
    const onVis = () => {
      if (document.hidden) releaseAll();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return held;
}
