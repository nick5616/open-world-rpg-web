// Debug hotkeys: F3 HUD, ` panel, V fly, F4 cell borders. Ignored while typing
// in a text field. Only mounted when DEBUG is on.
import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { useDebugStore } from '../stores/debugStore';
import { isTextTarget } from '../input/useKeyboard';

export function useDebugHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || isTextTarget(e.target)) return;
      const app = useAppStore.getState();
      const dbg = useDebugStore.getState();
      switch (e.code) {
        case 'F3':
          e.preventDefault();
          app.toggleHud();
          break;
        case 'Backquote': {
          e.preventDefault();
          const open = !app.debugPanelOpen;
          app.setDebugPanelOpen(open);
          if (open && document.pointerLockElement) document.exitPointerLock();
          break;
        }
        case 'KeyV':
          dbg.setFly(!dbg.fly);
          break;
        case 'F4':
          e.preventDefault();
          dbg.setShowCells(!dbg.showCells);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
