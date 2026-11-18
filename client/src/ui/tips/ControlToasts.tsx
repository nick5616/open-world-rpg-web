// Playtest 5 (CR 055): the controls toast after a conversation (controlTips.ts).
// A small card in the tips' slot above the hotbar: keycaps and a line each,
// a bar that drains over its time (hover pauses it and the clock), a close box.
// Tips wait while it is up (TipsHud counts it as busy).

import { useEffect } from 'react';
import { ABOVE_HOTBAR } from '../../hud/layout';
import { ToastBar } from '../toast/ToastBar';
import { CONTROL_TOAST_S } from './controlTips';
import { controlHover, useTips, type ControlToast } from './store';

const CAP: React.CSSProperties = { display: 'inline-block', minWidth: 14, padding: '0 5px', marginRight: 4, border: '1px solid rgba(255,255,255,0.45)', borderBottomWidth: 2, borderRadius: 4, background: 'rgba(255,255,255,0.08)', font: '600 11px/17px system-ui, sans-serif', textAlign: 'center' };

export function ControlToasts() {
  const list = useTips((s) => s.controls);
  useEffect(() => {
    if (!list.length) return;
    const id = setInterval(() => useTips.getState().tickControls(performance.now(), 250), 250);
    return () => clearInterval(id);
  }, [list.length]);
  if (!list.length) return null;
  return (
    <div data-testid="control-toasts" style={{ position: 'fixed', left: '50%', bottom: `calc(${ABOVE_HOTBAR} + var(--ls-hint-h, 0px) + 10px)`, transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', zIndex: 13, pointerEvents: 'none' }}>
      {list.map((t) => (
        <ControlCard key={t.id} t={t} />
      ))}
    </div>
  );
}

function ControlCard({ t }: { t: ControlToast }) {
  return (
    <div
      data-testid="control-toast"
      data-group={t.title}
      className="ls-timed"
      onMouseEnter={() => (controlHover.id = t.id)}
      onMouseLeave={() => (controlHover.id = 0)}
      style={{ position: 'relative', overflow: 'hidden', width: 'max-content', maxWidth: 'min(460px, calc(100vw - 32px))', boxSizing: 'border-box', padding: '7px 30px 11px 12px', borderRadius: 6, background: 'rgba(10,13,20,0.84)', border: '1px solid rgba(255,209,102,0.35)', color: '#e9ecef', font: '13px/1.45 system-ui, sans-serif', pointerEvents: 'auto', animation: 'lsTipIn 220ms ease-out' }}
    >
      <style>{'@keyframes lsTipIn { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }'}</style>
      <div style={{ color: '#ffd166', font: '600 11px system-ui, sans-serif', letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 2 }}>Controls · {t.title}</div>
      {t.tips.map((c) => (
        <div key={c.id}>
          {c.keys.map((k) => (
            <span key={k} style={CAP}>
              {k}
            </span>
          ))}
          {c.text}
        </div>
      ))}
      <button
        data-testid="control-toast-close"
        aria-label="Dismiss"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => useTips.getState().dropControl(t.id)}
        style={{ position: 'absolute', top: 4, right: 6, border: 'none', background: 'none', color: '#adb5bd', cursor: 'pointer', font: '15px system-ui, sans-serif', padding: '0 4px' }}
      >
        ×
      </button>
      <ToastBar at={t.at} durationMs={CONTROL_TOAST_S * 1000} />
    </div>
  );
}
