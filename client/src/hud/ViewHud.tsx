// Playtest 2 ("Need third person mode"): T switches between the first-person
// and the over-the-shoulder camera (persisted, stores/viewStore.ts), with a
// short toast; CameraSettings is the settings row (view, shoulder, distance)
// shown under the pointer-lock hint while the mouse is free and in the debug
// panel. T is free: V is fly / push-to-talk, F dodge, G glider, Q form.

import { useEffect, useState, type CSSProperties } from 'react';
import { isTextTarget } from '../input/useKeyboard';
import { useViewStore, VIEW_DISTANCE } from '../stores/viewStore';
import { ABOVE_HOTBAR } from './layout';

export const VIEW_KEY = 'KeyT';

/** The T key; mount once on the play screen. */
export function ViewHud() {
  const mode = useViewStore((s) => s.mode);
  const [toastAt, setToastAt] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== VIEW_KEY || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTextTarget(e.target)) return;
      useViewStore.getState().toggle();
      setToastAt(performance.now());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!toastAt) return;
    const id = setTimeout(() => setToastAt(0), 1600);
    return () => clearTimeout(id);
  }, [toastAt]);
  if (!toastAt) return null;
  return (
    <div data-testid="view-toast" style={{ position: 'fixed', left: '50%', bottom: `calc(${ABOVE_HOTBAR} + var(--ls-hint-h, 0px) + 40px)`, transform: 'translateX(-50%)', padding: '5px 12px', borderRadius: 4, background: 'rgba(8,10,16,0.6)', color: '#e9ecef', font: '13px system-ui, sans-serif', pointerEvents: 'none', zIndex: 11 }}>
      {mode === 'third' ? 'Third-person camera' : 'First-person camera'} · T to switch
    </div>
  );
}

const btn = (on: boolean): CSSProperties => ({ font: '12px system-ui, sans-serif', padding: '2px 8px', borderRadius: 3, border: '1px solid #495057', background: on ? '#2b4f7a' : '#1b1f2a', color: '#e9ecef', cursor: 'pointer' });

/** View / shoulder / distance controls (the lock hint's second line, the debug panel). */
export function CameraSettings({ compact = false }: { compact?: boolean }) {
  const mode = useViewStore((s) => s.mode);
  const shoulder = useViewStore((s) => s.shoulder);
  const distance = useViewStore((s) => s.distance);
  const set = useViewStore.getState();
  return (
    <span data-testid="camera-settings" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'center', pointerEvents: 'auto' }}>
      {!compact && <span>Camera</span>}
      <button type="button" data-testid="view-first" style={btn(mode === 'first')} onClick={() => set.setMode('first')}>
        First person
      </button>
      <button type="button" data-testid="view-third" style={btn(mode === 'third')} onClick={() => set.setMode('third')}>
        Third person
      </button>
      {mode === 'third' && (
        <>
          <button type="button" data-testid="view-shoulder" style={btn(false)} onClick={() => set.setShoulder(shoulder === 1 ? -1 : 1)} title="Which shoulder the camera looks over">
            {shoulder === 1 ? 'Right shoulder' : 'Left shoulder'}
          </button>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Distance
            <input aria-label="camera distance" type="range" min={VIEW_DISTANCE.min} max={VIEW_DISTANCE.max} step={0.1} value={distance} onChange={(e) => set.setDistance(Number(e.target.value))} style={{ width: 80 }} />
          </label>
        </>
      )}
      <span style={{ opacity: 0.6 }}>(T)</span>
    </span>
  );
}
