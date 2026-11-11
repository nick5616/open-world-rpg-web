// Playtest 2 emotes: hold H for the wheel, move the mouse toward an emote,
// release H to play it (a quick tap replays the last one). With the mouse
// captured the wheel borrows the look deltas (input/lookRouter.ts) so the
// view doesn't turn; with a free cursor the emotes are buttons too. H was
// free (the Esc menu's Controls list has every binding; menu.test.ts checks
// this row like the others).

import { useEffect, useRef, useState } from 'react';
import { isTextTarget } from '../../input/useKeyboard';
import { lookRouter } from '../../input/lookRouter';
import { hidePanel, showPanel } from '../../input/panelStack';
import { clampCursor, pickSector, sectorCenter, WHEEL } from './emotes';
import { emoteById } from './emotes';
import { ensureEmoteHook, lastEmoteId, playEmote, useEmoteToast } from './link';
import { photoActive } from '../photo/store';
import { DEBUG } from '../../config';
import { emoteByKey } from './emotes';
import { emoteOf, SELF } from './store';

export const EMOTE_KEY = 'KeyH';
const R = 150;
const TAP_MS = 220;

function panelOpen(): boolean {
  return !!document.querySelector('[data-ui-panel]:not([style*="display: none"])');
}

export function EmoteWheel() {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(-1);
  const st = useRef({ open: false, at: 0, cx: 0, cy: 0, sel: -1 });
  const toast = useEmoteToast();
  const [, tick] = useState(0);

  useEffect(() => {
    const iv = setInterval(() => ensureEmoteHook(), 500);
    ensureEmoteHook();
    const s = st.current;
    const move = (dx: number, dy: number) => {
      s.cx += dx;
      s.cy += dy;
      const c = { x: s.cx, y: s.cy };
      clampCursor(c, R);
      s.cx = c.x;
      s.cy = c.y;
      const k = pickSector(s.cx, s.cy, WHEEL.length);
      if (k !== s.sel) {
        s.sel = k;
        setSel(k);
      }
    };
    const close = (play: boolean) => {
      if (!s.open) return;
      s.open = false;
      hidePanel('emote-wheel');
      if (lookRouter.sink === move) lookRouter.sink = null;
      setOpen(false);
      if (!play) return;
      if (s.sel >= 0) playEmote(WHEEL[s.sel]);
      else if (performance.now() - s.at < TAP_MS) {
        const last = emoteById(lastEmoteId());
        if (last) playEmote(last);
      }
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== EMOTE_KEY || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTextTarget(e.target)) return;
      if (s.open || panelOpen() || photoActive()) return;
      s.open = true;
      s.at = performance.now();
      s.cx = s.cy = 0;
      s.sel = -1;
      setSel(-1);
      setOpen(true);
      showPanel('emote-wheel', () => close(false)); // Esc cancels the wheel (input/panelStack.ts)
      lookRouter.sink = move;
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === EMOTE_KEY) close(true);
    };
    const onMouse = (e: MouseEvent) => {
      if (!s.open || document.pointerLockElement) return; // captured: the look deltas arrive through the sink
      s.cx = e.clientX - window.innerWidth / 2;
      s.cy = e.clientY - window.innerHeight / 2;
      move(0, 0);
    };
    const onBlur = () => close(false);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('mousemove', onMouse);
    window.addEventListener('blur', onBlur);
    return () => {
      clearInterval(iv);
      close(false);
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('mousemove', onMouse);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useEffect(() => {
    if (!toast.text) return;
    const id = setTimeout(() => tick((n) => n + 1), 1700);
    return () => clearTimeout(id);
  }, [toast]);
  const showToast = toast.text && performance.now() - toast.at < 1600;

  return (
    <>
      {showToast && (
        <div data-testid="emote-toast" style={{ position: 'fixed', left: '50%', top: '58%', transform: 'translateX(-50%)', color: '#ffd8a8', font: '14px system-ui, sans-serif', textShadow: '0 1px 2px #000', pointerEvents: 'none', zIndex: 21 }}>
          {toast.text}
        </div>
      )}
      {open && (
        <div data-testid="emote-wheel" style={{ position: 'fixed', left: '50%', top: '50%', width: R * 2 + 120, height: R * 2 + 120, transform: 'translate(-50%, -50%)', pointerEvents: 'none', zIndex: 30 }}>
          <svg width="100%" height="100%" viewBox={`${-R - 60} ${-R - 60} ${R * 2 + 120} ${R * 2 + 120}`} style={{ position: 'absolute', inset: 0 }}>
            <circle r={R + 40} fill="rgba(10,12,18,0.55)" stroke="rgba(255,255,255,0.15)" strokeWidth={2} />
            <circle r={44} fill="rgba(10,12,18,0.7)" stroke="rgba(255,255,255,0.2)" />
            {WHEEL.map((e, i) => {
              const n = WHEEL.length;
              const a0 = ((i - 0.5) / n) * Math.PI * 2;
              const a1 = ((i + 0.5) / n) * Math.PI * 2;
              const r0 = 48;
              const r1 = R + 38;
              const p = (r: number, a: number) => `${(Math.sin(a) * r).toFixed(1)} ${(-Math.cos(a) * r).toFixed(1)}`;
              return (
                <path
                  key={e.id}
                  d={`M ${p(r0, a0)} L ${p(r1, a0)} A ${r1} ${r1} 0 0 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 0 0 ${p(r0, a0)} Z`}
                  fill={i === sel ? 'rgba(255,196,92,0.35)' : 'rgba(255,255,255,0.03)'}
                  stroke="rgba(255,255,255,0.12)"
                />
              );
            })}
          </svg>
          {WHEEL.map((e, i) => {
            const c = sectorCenter(i, WHEEL.length);
            const on = i === sel;
            return (
              <button
                type="button"
                key={e.id}
                data-testid={`emote-${e.key}`}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  st.current.sel = i;
                  setSel(i);
                  window.dispatchEvent(new KeyboardEvent('keyup', { code: EMOTE_KEY }));
                }}
                style={{
                  position: 'absolute',
                  left: `calc(50% + ${(c.x * (R - 6)).toFixed(1)}px)`,
                  top: `calc(50% + ${(c.y * (R - 6)).toFixed(1)}px)`,
                  transform: `translate(-50%, -50%) scale(${on ? 1.12 : 1})`,
                  pointerEvents: document.pointerLockElement ? 'none' : 'auto',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: on ? '#ffd27a' : '#eef1f5',
                  font: `${on ? 700 : 600} 15px system-ui, sans-serif`,
                  textShadow: '0 1px 3px #000',
                  whiteSpace: 'nowrap',
                  maxWidth: 110,
                  textAlign: 'center',
                }}
              >
                {e.name}
              </button>
            );
          })}
          <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', color: '#cfd4dc', font: '11px system-ui, sans-serif', textAlign: 'center', width: 84, lineHeight: 1.25 }}>
            {sel >= 0 ? 'release H' : 'move to pick'}
          </div>
        </div>
      )}
    </>
  );
}

if (DEBUG && typeof window !== 'undefined') {
  (window as unknown as { __lodestoneEmotes?: unknown }).__lodestoneEmotes = {
    play: (key: string) => {
      const e = emoteByKey(key);
      return e ? playEmote(e) : false;
    },
    mine: () => emoteOf(SELF) ?? null,
  };
}
