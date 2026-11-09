// Mounted by PlayScreen. Boots the audio engine (a lazy chunk) once the
// world's first playable frame is up, so no audio code or asset is part of
// the first-frame download (spec 12). Also renders the sound settings
// panel (K, or the speaker button) and gives HUD buttons a click.

import { useEffect } from 'react';
import { worldDebug } from '../../world/debug/worldDebug';
import { emitSound } from '../bridge';
import { useAudioSettings } from '../settings';
import { AudioSettingsPanel, SoundButton } from './AudioSettingsPanel';

export function AudioRoot() {
  useEffect(() => {
    let alive = true;
    let dispose: (() => void) | null = null;
    const id = setInterval(() => {
      if (worldDebug.firstPlayableMs === null) return;
      clearInterval(id);
      // After the first playable frame, when the main thread is idle.
      const go = () =>
        void import('../engine').then((m) => {
          if (alive) dispose = m.bootAudio();
        });
      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) ric(go, { timeout: 1500 });
      else setTimeout(go, 200);
    }, 250);
    return () => {
      alive = false;
      clearInterval(id);
      dispose?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.code !== 'KeyK' || e.repeat) return;
      const s = useAudioSettings.getState();
      s.setPanelOpen(!s.panelOpen);
      if (!s.panelOpen && document.pointerLockElement) document.exitPointerLock();
    };
    // Every HUD button clicks (one listener, no per-component wiring).
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('button');
      if (el && !el.hasAttribute('data-silent')) emitSound('ui_click');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onClick, true);
    };
  }, []);

  return (
    <>
      <SoundButton />
      <AudioSettingsPanel />
    </>
  );
}
