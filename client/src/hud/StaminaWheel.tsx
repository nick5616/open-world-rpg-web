// The stamina wheel (WP10, spec 8: "Stamina is one wheel"). A ring beside the
// crosshair that fills clockwise; it fades out after the wheel has been full
// for a moment (nothing to tell you then) and turns red while exhausted
// (empty until full again: no sprint, climb or glide). Like the debug HUD it
// reads the per-frame localPlayer values on its own rAF and writes the DOM
// directly, so it never re-renders React per frame.

import { useEffect, useRef } from 'react';
import { localPlayer } from '../state/live';

const R = 15;
const C = 2 * Math.PI * R;
/** Seconds the wheel stays visible after filling up. */
const LINGER_S = 0.8;

export function StaminaWheel() {
  const wrap = useRef<HTMLDivElement>(null);
  const arc = useRef<SVGCircleElement>(null);
  useEffect(() => {
    let raf = 0;
    let fullSince = 0;
    let last = '';
    const tick = (now: number) => {
      const max = localPlayer.staminaMax || 1;
      const f = Math.max(0, Math.min(1, localPlayer.stamina / max));
      if (f < 1) fullSince = now;
      const visible = now - fullSince < LINGER_S * 1000;
      const color = localPlayer.exhausted ? '#ff6b6b' : f < 0.25 ? '#ffd43b' : '#69db7c';
      const key = `${visible}|${f.toFixed(3)}|${color}`;
      if (key !== last && wrap.current && arc.current) {
        last = key;
        wrap.current.style.opacity = visible ? '1' : '0';
        wrap.current.dataset.stamina = (f * 100).toFixed(1);
        arc.current.style.strokeDashoffset = String(C * (1 - f));
        arc.current.style.stroke = color;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div ref={wrap} data-testid="stamina-wheel" style={{ position: 'fixed', left: 'calc(50% + 34px)', top: 'calc(50% - 20px)', width: 40, height: 40, pointerEvents: 'none', zIndex: 11, opacity: 0, transition: 'opacity 250ms' }}>
      <svg width="40" height="40" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r={R} fill="none" stroke="rgba(8,10,16,0.55)" strokeWidth="6" />
        <circle ref={arc} cx="20" cy="20" r={R} fill="none" stroke="#69db7c" strokeWidth="4" strokeDasharray={C} strokeDashoffset={0} strokeLinecap="round" transform="rotate(-90 20 20)" />
      </svg>
    </div>
  );
}
