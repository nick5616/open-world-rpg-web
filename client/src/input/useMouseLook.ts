// Pointer lock + accumulated mouse deltas. Deltas pile up between frames and
// the controller consumes them once per rendered frame, so look is applied at
// display rate (144 Hz stays 144 Hz) while movement steps at 60 Hz.
//
// adapted from wizard-wars client/src/hooks/useMouseControls.ts

import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';

export function useMouseLook() {
  const delta = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!document.pointerLockElement) return;
      delta.current.x += e.movementX;
      delta.current.y += e.movementY;
    };
    const onDown = (e: MouseEvent) => {
      // Only the canvas acquires the lock, so clicks on overlays (debug panel,
      // menus) still work normally.
      if (!document.pointerLockElement && e.target instanceof HTMLCanvasElement && e.button === 0) {
        // Chrome returns a promise and rejects if the user just exited lock
        // (it enforces a short cooldown); that is harmless, so swallow it.
        const p = e.target.requestPointerLock() as unknown as Promise<void> | undefined;
        p?.catch?.(() => {});
      }
    };
    const onLock = () => {
      delta.current.x = 0;
      delta.current.y = 0;
      useAppStore.getState().setPointerLocked(!!document.pointerLockElement);
    };
    const onContext = (e: Event) => e.preventDefault();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('pointerlockchange', onLock);
    document.addEventListener('contextmenu', onContext);
    return () => {
      document.removeEventListener('mousemove', onMove);
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
